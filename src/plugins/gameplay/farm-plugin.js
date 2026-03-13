const { BasePlugin } = require('../base-plugin');
const { types } = require('../../utils/proto');
const { toNum, toLong, getServerTimeSec, sleep } = require('../../utils/utils');
const { getPlantNameBySeedId, getPlantGrowTime, formatGrowTime, getPlantBySeedId, getFruitPrice } = require('../../config/gameConfig');
const { PlantPhase } = require('../../config/config');
const protobuf = require('protobufjs');

/**
 * 自己农场自动化插件 (Farm Auto Plugin)
 * 负责自动收获、清理死地、除草/虫、浇水、自动播种
 */
class FarmPlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        this.isChecking = false;
        this.NORMAL_FERTILIZER_ID = 1011;
        this.ORGANIC_FERTILIZER_ID = 1012;
        // 定时轮询间隔
        this.checkIntervalMs = 5000;
        this.PHASE_NAMES = { 1: '种子期', 2: '发芽期', 3: '生长期', 4: '成熟期', 5: '枯萎' };
    }

    onLoad() {
        require('../../utils/proto').loadProto();
    }

    onEnable() {
        this.logger.info('FarmPlugin', '农场自动化模块已启动');

        // 热重载后，如果引擎已经登录成功，则直接启动检查循环；否则等待登录成功事件
        if (this.engine.state.user && this.engine.state.user.gid > 0) {
            this.startCheckLoop();
        } else {
            this.on('login_success', () => {
                // 登录成功后，延迟2秒开始首次检查
                this.scheduler.setTimeout(() => this.startCheckLoop(), 2000);
            });
        }

        this.on('server_notify:LandsNotify', (lands) => {
            this.logger.info('FarmPlugin', `收到推送，${lands.length} 块土地状态变化，立即触发检查...`);
            if (!this.isChecking) {
                this.scheduler.setTimeout(() => this.checkFarm(), 500);
            }
        });
    }

    onDisable() {
        this.logger.info('FarmPlugin', '农场自动化模块已停止');
        this.isChecking = false;
        super.onDisable();
    }

    startCheckLoop() {
        // 立即执行一次
        this.checkFarm();
        // 之后定时执行
        this.scheduler.setInterval(async () => {
            if (this.isChecking) return;
            await this.checkFarm();
        }, this.checkIntervalMs);
    }

    async checkFarm() {
        const config = this.engine.state.config || {};
        if (!config.auto_farm) {
            return;
        }

        this.isChecking = true;
        try {
            // 1. 获取所有土地信息
            const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
            const landsReply = types.AllLandsReply.decode(replyBody);

            if (!landsReply.lands || landsReply.lands.length === 0) {
                this.logger.info('FarmPlugin', '巡田跳过：未获取到土地数据');
                return;
            }

            // 2. 分析土地状态
            const status = this.analyzeLands(landsReply.lands);

            const statusParts = [];
            if (status.harvestable.length) statusParts.push(`收:${status.harvestable.length}`);
            if (status.needWeed.length) statusParts.push(`草:${status.needWeed.length}`);
            if (status.needBug.length) statusParts.push(`虫:${status.needBug.length}`);
            if (status.needWater.length) statusParts.push(`水:${status.needWater.length}`);
            if (status.dead.length) statusParts.push(`枯:${status.dead.length}`);
            if (status.empty.length) statusParts.push(`空:${status.empty.length}`);
            if (status.unlockable.length) statusParts.push(`解:${status.unlockable.length}`);
            if (status.upgradable.length) statusParts.push(`升:${status.upgradable.length}`);
            statusParts.push(`长:${status.growing.length}`);

            const actions = [];

            // 3. 执行日常打理 (除草/除虫/浇水)
            if (status.needWeed.length > 0) {
                await this.weedOut(status.needWeed);
                actions.push(`除草${status.needWeed.length}`);
            }
            if (status.needBug.length > 0) {
                await this.insecticide(status.needBug);
                actions.push(`除虫${status.needBug.length}`);
            }
            if (status.needWater.length > 0) {
                await this.waterLand(status.needWater);
                actions.push(`浇水${status.needWater.length}`);
            }

            // 4. 执行收获
            let harvestedLandIds = [];
            let harvestReply = null;
            if (status.harvestable.length > 0) {
                harvestReply = await this.harvest(status.harvestable);
                actions.push(`收获${status.harvestable.length}`);
                harvestedLandIds = [...status.harvestable];
                this.emit('farm_harvested', { count: status.harvestable.length, landIds: harvestedLandIds });
            }

            // 5. 执行清理枯死与种植
            let allDeadLands = [...new Set([...status.dead])];
            const allEmptyLands = [...new Set([...status.empty])];
            if (harvestedLandIds.length > 0) {
                const postHarvest = await this.resolveRemovableHarvestedLands(harvestedLandIds, harvestReply);
                allDeadLands = [...new Set([...allDeadLands, ...postHarvest.removable])];
            }
            
            if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
                const plantCount = allDeadLands.length + allEmptyLands.length;
                await this.autoPlantEmptyLands(allDeadLands, allEmptyLands);
                actions.push(`种植${plantCount}`);
            }

            // 6. 执行土地解锁/升级（受 auto_land_upgrade 控制）
            if (config.auto_land_upgrade) {
                if (status.unlockable.length > 0) {
                    let unlocked = 0;
                    for (const landId of status.unlockable) {
                        try {
                            await this.unlockLand(landId, false);
                            unlocked++;
                        } catch (e) {
                            this.logger.warn('农场', `土地解锁失败(land=${landId}): ${e.message}`);
                        }
                        await sleep(200);
                    }
                    if (unlocked > 0) actions.push(`解锁${unlocked}`);
                }

                if (status.upgradable.length > 0) {
                    let upgraded = 0;
                    for (const landId of status.upgradable) {
                        try {
                            await this.upgradeLand(landId);
                            upgraded++;
                        } catch (e) {
                            this.logger.warn('农场', `土地升级失败(land=${landId}): ${e.message}`);
                        }
                        await sleep(200);
                    }
                    if (upgraded > 0) actions.push(`升级${upgraded}`);
                }
            }

            // 打印本次循环日志
            const actionStr = actions.length > 0 ? ` → ${actions.join('/')}` : '';
            if (actions.length > 0 || statusParts.length > 0) {
                 this.logger.info('农场', `[${statusParts.join(' ')}]${actionStr}`);
            }

        } catch (err) {
            this.logger.warn('FarmPlugin', `巡田失败: ${err.message}`);
        } finally {
            this.isChecking = false;
        }
    }

    // ==========================================
    // 农场操作 API
    // ==========================================

    async harvest(landIds) {
        const body = types.HarvestRequest.encode(types.HarvestRequest.create({
            land_ids: landIds,
            host_gid: this.engine.state.user.gid,
            is_all: true,
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
        return types.HarvestReply.decode(replyBody);
    }

    async waterLand(landIds) {
        const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
            land_ids: landIds, host_gid: this.engine.state.user.gid,
        })).finish();
        await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
    }

    async weedOut(landIds) {
        const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({
            land_ids: landIds, host_gid: this.engine.state.user.gid,
        })).finish();
        await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
    }

    async insecticide(landIds) {
        const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({
            land_ids: landIds, host_gid: this.engine.state.user.gid,
        })).finish();
        await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
    }

    async removePlant(landIds) {
        const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
            land_ids: landIds.map(id => this.engine.network.toLong(id)),
        })).finish();
        await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
    }

    async unlockLand(landId, doShared = false) {
        const body = types.UnlockLandRequest.encode(types.UnlockLandRequest.create({
            land_id: toLong(landId),
            do_shared: !!doShared,
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'UnlockLand', body);
        return types.UnlockLandReply.decode(replyBody);
    }

    async upgradeLand(landId) {
        const body = types.UpgradeLandRequest.encode(types.UpgradeLandRequest.create({
            land_id: toLong(landId),
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'UpgradeLand', body);
        return types.UpgradeLandReply.decode(replyBody);
    }

    async fertilize(landIds, fertilizerId) {
        const ids = Array.isArray(landIds) ? landIds.map(v => toNum(v)).filter(Boolean) : [];
        if (ids.length === 0) return 0;

        let success = 0;
        for (const landId of ids) {
            try {
                const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                    land_ids: [toLong(landId)],
                    fertilizer_id: toLong(fertilizerId),
                })).finish();
                await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
                success++;
            } catch (e) {
                this.logger.warn('农场', `施肥失败(land=${landId}, fertilizer=${fertilizerId}): ${e.message}`);
            }
            await sleep(50);
        }
        return success;
    }

    async runFertilizerForNewPlanted(landIds) {
        const config = this.engine.state.config || {};
        if (!config.auto_fertilize) return;

        const targets = [...new Set((Array.isArray(landIds) ? landIds : []).map(v => toNum(v)).filter(Boolean))];
        if (targets.length === 0) return;

        const typeRaw = String(config.auto_fertilize_type || 'normal').trim().toLowerCase();
        const type = ['normal', 'organic', 'both'].includes(typeRaw) ? typeRaw : 'normal';

        let normalCount = 0;
        let organicCount = 0;
        if (type === 'normal' || type === 'both') {
            normalCount = await this.fertilize(targets, this.NORMAL_FERTILIZER_ID);
        }
        if (type === 'organic' || type === 'both') {
            organicCount = await this.fertilize(targets, this.ORGANIC_FERTILIZER_ID);
        }

        if (normalCount > 0 || organicCount > 0) {
            this.logger.info('农场', `补种施肥完成：普通=${normalCount}，有机=${organicCount}`);
        }
    }

    // ==========================================
    // 自动种植逻辑
    // ==========================================

    async getAvailableSeeds() {
        const shopBody = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
            shop_id: 2,
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', shopBody);
        const shopReply = types.ShopInfoReply.decode(replyBody);
        const goodsList = Array.isArray(shopReply && shopReply.goods_list) ? shopReply.goods_list : [];
        const myLevel = toNum(this.engine.state.user.level);

        const result = [];
        for (const goods of goodsList) {
            const seedId = toNum(goods.item_id);
            if (seedId <= 0) continue;
            const plant = getPlantBySeedId(seedId);
            const plantId = toNum(plant && plant.id);
            const seedName = getPlantNameBySeedId(seedId);

            let requiredLevel = 0;
            for (const cond of (goods.conds || [])) {
                if (toNum(cond.type) === 1) {
                    requiredLevel = toNum(cond.param);
                }
            }

            const limitCount = toNum(goods.limit_count);
            const boughtNum = toNum(goods.bought_num);
            const soldOut = limitCount > 0 && boughtNum >= limitCount;
            const unlocked = !!goods.unlocked && myLevel >= requiredLevel;
            const growSec = getPlantGrowTime(plantId);
            const fruitId = toNum(plant && plant.fruit && plant.fruit.id);
            const fruitPrice = fruitId > 0 ? toNum(getFruitPrice(fruitId)) : 0;
            const price = toNum(goods.price);
            const profitPerSec = growSec > 0 ? ((fruitPrice - price) / growSec) : 0;

            result.push({
                goodsId: toNum(goods.id),
                seedId,
                plantId,
                name: seedName,
                price,
                requiredLevel,
                unlocked,
                soldOut,
                growSec,
                fruitPrice,
                profitPerSec,
            });
        }
        return result;
    }

    async autoPlantEmptyLands(deadLandIds, emptyLandIds) {
        const landsToPlant = [...emptyLandIds];

        // 1. 铲除枯死植物
        if (deadLandIds.length > 0) {
            try {
                await this.removePlant(deadLandIds);
                this.logger.info('农场', `已铲除 ${deadLandIds.length} 块死地`);
                landsToPlant.push(...deadLandIds);
            } catch (e) {
                this.logger.warn('农场', `铲除死地失败: ${e.message}`);
                landsToPlant.push(...deadLandIds); 
            }
        }

        if (landsToPlant.length === 0) {
            this.logger.info('农场', '自动种植跳过：没有可种植地块');
            return;
        }

        // 2. 去商店寻找可用种子，并按配置策略选种
        let bestSeed = null;
        try {
            const shopBody = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
                shop_id: 2, 
            })).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', shopBody);
            const shopReply = types.ShopInfoReply.decode(replyBody);

            if (shopReply.goods_list && shopReply.goods_list.length > 0) {
                const available = [];
                for (const goods of shopReply.goods_list) {
                    if (!goods.unlocked) continue;
                    let meetsConditions = true;
                    let requiredLevel = 0;
                    for (const cond of (goods.conds || [])) {
                        if (toNum(cond.type) === 1) {
                            requiredLevel = toNum(cond.param);
                            if (this.engine.state.user.level < requiredLevel) {
                                meetsConditions = false; break;
                            }
                        }
                    }
                    const limitCount = toNum(goods.limit_count);
                    const boughtNum = toNum(goods.bought_num);
                    if (limitCount > 0 && boughtNum >= limitCount) continue;

                    if (meetsConditions) {
                        const seedId = toNum(goods.item_id);
                        const plant = getPlantBySeedId(seedId);
                        const growSec = getPlantGrowTime(toNum(plant && plant.id));
                        const fruitId = toNum(plant && plant.fruit && plant.fruit.id);
                        const fruitPrice = fruitId > 0 ? toNum(getFruitPrice(fruitId)) : 0;
                        const profitPerSec = growSec > 0 ? ((fruitPrice - toNum(goods.price)) / growSec) : Number.NEGATIVE_INFINITY;
                        available.push({
                            goodsId: toNum(goods.id),
                            seedId,
                            price: toNum(goods.price),
                            requiredLevel,
                            growSec,
                            fruitPrice,
                            profitPerSec,
                        });
                    }
                }
                
                if (available.length > 0) {
                    const config = this.engine.state.config || {};
                    const strategyRaw = String(config.seed_strategy || 'max_profit').trim().toLowerCase();
                    const strategy = ['max_profit', 'max_level', 'preferred'].includes(strategyRaw) ? strategyRaw : 'max_level';
                    const preferredSeedId = toNum(config.preferred_seed_id);

                    if (strategy === 'preferred' && preferredSeedId > 0) {
                        const preferred = available.find(x => x.seedId === preferredSeedId);
                        if (preferred) {
                            bestSeed = preferred;
                            this.logger.info('农场', `选种策略命中：preferred(seed=${preferredSeedId})`);
                        } else {
                            this.logger.warn('农场', `优先种子不可用(seed=${preferredSeedId})，回退策略 max_level`);
                        }
                    }

                    if (!bestSeed && strategy === 'max_profit') {
                        available.sort((a, b) => {
                            if (b.profitPerSec !== a.profitPerSec) return b.profitPerSec - a.profitPerSec;
                            if (b.requiredLevel !== a.requiredLevel) return b.requiredLevel - a.requiredLevel;
                            return b.fruitPrice - a.fruitPrice;
                        });
                        bestSeed = available[0];
                        this.logger.info('农场', `选种策略命中：max_profit(seed=${bestSeed.seedId}, 收益速率=${bestSeed.profitPerSec.toFixed(6)}/秒)`);
                    }

                    if (!bestSeed) {
                        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
                        bestSeed = available[0];
                        const fallbackReason = strategy === 'preferred' ? 'preferred 未命中，已回退 max_level' : 'max_level';
                        this.logger.info('农场', `选种策略命中：${fallbackReason}(seed=${bestSeed.seedId})`);
                    }
                }
            }
        } catch (e) {
            this.logger.warn('农场', `查询商店失败: ${e.message}`);
            return;
        }

        if (!bestSeed) {
            this.logger.info('农场', `自动种植跳过：商店无可用种子（当前等级 ${this.engine.state.user.level}）`);
            return;
        }

        const seedName = getPlantNameBySeedId(bestSeed.seedId);
        let needCount = landsToPlant.length;
        const totalCost = bestSeed.price * needCount;

        // 3. 购买种子
        if (totalCost > this.engine.state.user.gold) {
            needCount = Math.floor(this.engine.state.user.gold / bestSeed.price);
            if (needCount <= 0) {
                this.logger.warn('农场', `金币不足，无法购买种子 ${seedName}`);
                return;
            }
        }

        let actualSeedId = bestSeed.seedId;
        try {
            const buyBody = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
                goods_id: bestSeed.goodsId,
                num: needCount,
                price: bestSeed.price,
            })).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', buyBody);
            const buyReply = types.BuyGoodsReply.decode(replyBody);
            
            if (buyReply.get_items && buyReply.get_items.length > 0) {
                actualSeedId = toNum(buyReply.get_items[0].id);
            }
            this.logger.info('农场', `花费 ${bestSeed.price * needCount} 金币购买了 ${seedName}种子 x${needCount}`);
        } catch (e) {
            this.logger.warn('农场', `购买种子失败: ${e.message}`);
            return;
        }

        // 4. 种植 
        let successCount = 0;
        let failCount = 0;
        const plantedLandIds = [];
        for (let i = 0; i < needCount; i++) {
            const landId = landsToPlant[i];
            try {
                const writer = protobuf.Writer.create();
                const itemWriter = writer.uint32(18).fork();
                itemWriter.uint32(8).int64(actualSeedId);
                const idsWriter = itemWriter.uint32(18).fork();
                idsWriter.int64(landId);
                idsWriter.ldelim();
                itemWriter.ldelim();
                const plantBody = writer.finish();

                await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', plantBody);
                successCount++;
                plantedLandIds.push(landId);
            } catch (e) {
                failCount++;
                this.logger.warn('农场', `种植失败(land=${landId}, seed=${actualSeedId}): ${e.message}`);
            }
            await sleep(50);
        }

        if (successCount > 0) {
            this.logger.info('农场', `成功在 ${successCount} 块地上种植了 ${seedName}`);
        }
        if (successCount === 0) {
            this.logger.warn('农场', `自动种植失败：目标 ${needCount} 块地均未成功种植 ${seedName}`);
        } else if (failCount > 0) {
            this.logger.warn('农场', `自动种植部分失败：成功 ${successCount}，失败 ${failCount}`);
        }

        // 第一阶段：仅对本轮新种植地块施肥。
        await this.runFertilizerForNewPlanted(plantedLandIds);
    }

    // ==========================================
    // 辅助分析逻辑
    // ==========================================

    buildLandMap(lands) {
        const map = new Map();
        const list = Array.isArray(lands) ? lands : [];
        for (const land of list) {
            const id = toNum(land && land.id);
            if (id > 0) map.set(id, land);
        }
        return map;
    }

    getCurrentPhase(phases) {
        if (!Array.isArray(phases) || phases.length === 0) return null;
        const nowSec = getServerTimeSec();
        for (let i = phases.length - 1; i >= 0; i--) {
            const bt = toNum(phases[i] && phases[i].begin_time);
            if (bt > 0 && bt <= nowSec) return phases[i];
        }
        return phases[0] || null;
    }

    getLandLifecycleState(land) {
        if (!land) return 'unknown';
        const plant = land.plant;
        if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) {
            return 'empty';
        }
        const currentPhase = this.getCurrentPhase(plant.phases);
        if (!currentPhase) return 'empty';
        const phaseVal = toNum(currentPhase.phase);
        if (phaseVal === PlantPhase.DEAD) return 'dead';
        if (phaseVal === PlantPhase.MATURE) return 'growing';
        if (phaseVal >= PlantPhase.SEED && phaseVal <= PlantPhase.BLOOMING) return 'growing';
        return 'unknown';
    }

    classifyHarvestedLandsByMap(landIds, landsMap) {
        const removable = [];
        const growing = [];
        const unknown = [];
        for (const id of landIds) {
            const land = landsMap.get(id);
            if (!land) {
                unknown.push(id);
                continue;
            }
            const state = this.getLandLifecycleState(land);
            if (state === 'dead' || state === 'empty') {
                removable.push(id);
                continue;
            }
            if (state === 'growing') {
                growing.push(id);
                continue;
            }
            unknown.push(id);
        }
        return { removable, growing, unknown };
    }

    async resolveRemovableHarvestedLands(harvestedLandIds, harvestReply) {
        const ids = Array.isArray(harvestedLandIds) ? harvestedLandIds.filter(Boolean) : [];
        if (ids.length === 0) {
            return { removable: [], growing: [] };
        }

        const replyMap = this.buildLandMap(harvestReply && harvestReply.land);
        const firstPass = this.classifyHarvestedLandsByMap(ids, replyMap);
        const removable = [...firstPass.removable];
        const growing = [...firstPass.growing];
        let unknown = [...firstPass.unknown];

        if (unknown.length > 0) {
            try {
                const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
                const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
                const latestReply = types.AllLandsReply.decode(replyBody);
                const latestMap = this.buildLandMap(latestReply && latestReply.lands);
                const secondPass = this.classifyHarvestedLandsByMap(unknown, latestMap);
                removable.push(...secondPass.removable);
                growing.push(...secondPass.growing);
                unknown = secondPass.unknown;
            } catch (e) {
                this.logger.warn('农场', `收后状态补拉失败: ${e.message}`);
            }
        }

        // 与原库兼容：不可判定时按可铲除处理，避免阻塞后续补种。
        if (unknown.length > 0) {
            removable.push(...unknown);
        }

        return {
            removable: [...new Set(removable)],
            growing: [...new Set(growing)],
        };
    }

    analyzeLands(lands) {
        const result = {
            harvestable: [], needWater: [], needWeed: [], needBug: [],
            growing: [], empty: [], dead: [], unlockable: [], upgradable: []
        };

        const nowSec = getServerTimeSec();

        for (const land of lands) {
            const id = toNum(land.id);
            if (!land.unlocked) {
                if (land.could_unlock) result.unlockable.push(id);
                continue;
            }

            if (land.could_upgrade) result.upgradable.push(id);

            const plant = land.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) {
                result.empty.push(id);
                continue;
            }

            const currentPhase = this.getCurrentPhase(plant.phases);
            if (!currentPhase) {
                result.empty.push(id);
                continue;
            }

            const phaseVal = currentPhase.phase;

            if (phaseVal === PlantPhase.DEAD) {
                result.dead.push(id);
                continue;
            }
            if (phaseVal === PlantPhase.MATURE) {
                result.harvestable.push(id);
                continue;
            }

            const dryNum = toNum(plant.dry_num);
            const dryTime = toNum(currentPhase.dry_time);
            if (dryNum > 0 || (dryTime > 0 && dryTime <= nowSec)) result.needWater.push(id);

            const weedsTime = toNum(currentPhase.weeds_time);
            const hasWeed = (plant.weed_owners && plant.weed_owners.length > 0) || (weedsTime > 0 && weedsTime <= nowSec);
            if (hasWeed) result.needWeed.push(id);

            const insectTime = toNum(currentPhase.insect_time);
            const hasBug = (plant.insect_owners && plant.insect_owners.length > 0) || (insectTime > 0 && insectTime <= nowSec);
            if (hasBug) result.needBug.push(id);

            result.growing.push(id);
        }
        return result;
    }
}

module.exports = { FarmPlugin };
