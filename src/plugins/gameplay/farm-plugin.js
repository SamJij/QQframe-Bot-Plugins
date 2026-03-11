const { BasePlugin } = require('../base-plugin');
const { types } = require('../../utils/proto');
const { toNum, toLong, getServerTimeSec, sleep } = require('../../utils/utils');
const { getPlantNameBySeedId, getPlantGrowTime, formatGrowTime, getPlantBySeedId } = require('../../config/gameConfig');
const protobuf = require('protobufjs');

/**
 * 自己农场自动化插件 (Farm Auto Plugin)
 * 负责自动收获、清理死地、除草/虫、浇水、自动播种
 */
class FarmPlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        this.isChecking = false;
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
        this.isChecking = true;
        try {
            // 1. 获取所有土地信息
            const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
            const landsReply = types.AllLandsReply.decode(replyBody);

            if (!landsReply.lands || landsReply.lands.length === 0) {
                this.isChecking = false;
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
            statusParts.push(`长1:${status.growing.length}`);

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
            if (status.harvestable.length > 0) {
                await this.harvest(status.harvestable);
                actions.push(`收获${status.harvestable.length}`);
                harvestedLandIds = [...status.harvestable];
                this.emit('farm_harvested', { count: status.harvestable.length, landIds: harvestedLandIds });
            }

            // 5. 执行清理枯死与种植
            const allDeadLands = [...new Set([...status.dead])];
            const allEmptyLands = [...new Set([...status.empty])];
            
            if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
                const plantCount = allDeadLands.length + allEmptyLands.length;
                await this.autoPlantEmptyLands(allDeadLands, allEmptyLands);
                actions.push(`种植${plantCount}`);
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

    // ==========================================
    // 自动种植逻辑
    // ==========================================

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

        if (landsToPlant.length === 0) return;

        // 2. 去商店寻找当前等级能买到的最高级种子
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
                    if (meetsConditions) {
                        available.push({
                            goodsId: toNum(goods.id),
                            seedId: toNum(goods.item_id),
                            price: toNum(goods.price),
                            requiredLevel,
                        });
                    }
                }
                
                if (available.length > 0) {
                    available.sort((a, b) => b.requiredLevel - a.requiredLevel);
                    bestSeed = available[0];
                }
            }
        } catch (e) {
            this.logger.warn('农场', `查询商店失败: ${e.message}`);
            return;
        }

        if (!bestSeed) return;

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
            } catch (e) {
                
            }
            await sleep(50);
        }

        if (successCount > 0) {
            this.logger.info('农场', `成功在 ${successCount} 块地上种植了 ${seedName}`);
        }
    }

    // ==========================================
    // 辅助分析逻辑
    // ==========================================

    analyzeLands(lands) {
        const result = {
            harvestable: [], needWater: [], needWeed: [], needBug: [],
            growing: [], empty: [], dead: []
        };

        const nowSec = getServerTimeSec();

        for (const land of lands) {
            const id = toNum(land.id);
            if (!land.unlocked) continue;

            const plant = land.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) {
                result.empty.push(id);
                continue;
            }

            let currentPhase = plant.phases[0];
            for (let i = plant.phases.length - 1; i >= 0; i--) {
                const bt = toNum(plant.phases[i].begin_time);
                if (bt > 0 && bt <= nowSec) {
                    currentPhase = plant.phases[i];
                    break;
                }
            }

            const phaseVal = currentPhase.phase;

            if (phaseVal === 5) {
                result.dead.push(id);
                continue;
            }
            if (phaseVal === 4) {
                result.harvestable.push(id);
                continue;
            }

            const dryNum = toNum(plant.dry_num);
            if (dryNum > 0) result.needWater.push(id);

            if (plant.weed_owners && plant.weed_owners.length > 0) result.needWeed.push(id);
            if (plant.insect_owners && plant.insect_owners.length > 0) result.needBug.push(id);

            result.growing.push(id);
        }
        return result;
    }
}

module.exports = { FarmPlugin };