const { BasePlugin } = require('../base-plugin');
const { types } = require('../../utils/proto');
const { toNum, sleep } = require('../../utils/utils');
const { getPlantByFruitId, getFruitName, getItemById, getPlantBySeedId, getPlantNameBySeedId } = require('../../config/gameConfig');

/**
 * 仓库自动化插件 (Warehouse Auto Plugin)
 * 负责自动卖出果实、自动开启化肥礼包等
 */
class WarehousePlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        // 单次卖出的最大数量
        this.SELL_BATCH_SIZE = 15;
        
        // 化肥类道具相关ID
        this.FERTILIZER_RELATED_IDS = new Set([
            100003, // 化肥礼包
            100004, // 有机化肥礼包
            80001, 80002, 80003, 80004, // 普通化肥道具
            80011, 80012, 80013, 80014, // 有机化肥道具
        ]);
        this.FERTILIZER_CONTAINER_LIMIT_HOURS = 990;
        this.NORMAL_CONTAINER_ID = 1011;
        this.ORGANIC_CONTAINER_ID = 1012;

        this.isSelling = false;
    }

    onEnable() {
        this.logger.info('WarehousePlugin', '仓库自动化模块已启动');

        // 1. 监听来自农场插件的收获事件 (farm_harvested)
        this.on('farm_harvested', async (data) => {
            this.logger.info('WarehousePlugin', `监听到农场收获了 ${data.count} 块土地，准备出售果实...`);
            
            // 延迟一点点，等待服务器先结算好背包
            this.scheduler.setTimeout(() => this.sellAllFruits(), 1000);
        });

        // 2. 监听登录事件，登录后定期检查背包并自动使用化肥包
        this.on('login_success', () => {
            this.startFertilizerLoop();
        });
    }

    onDisable() {
        this.logger.info('WarehousePlugin', '仓库自动化模块已停止');
        super.onDisable();
    }

    // ==========================================
    // 自动卖出核心逻辑
    // ==========================================

    async fetchBagItems() {
        const body = types.BagRequest.encode(types.BagRequest.create({})).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.itempb.ItemService', 'Bag', body);
        const bagReply = types.BagReply.decode(replyBody);
        return (bagReply.item_bag && bagReply.item_bag.items) ? bagReply.item_bag.items : (bagReply.items || []);
    }

    async getBagSnapshot() {
        const items = await this.fetchBagItems();
        return items.map((item) => {
            const id = toNum(item.id);
            const count = toNum(item.count);
            const plantByFruit = getPlantByFruitId(id);
            const seedPlant = getPlantBySeedId(id);
            const info = getItemById(id);
            const name = plantByFruit
                ? getFruitName(id)
                : (seedPlant ? getPlantNameBySeedId(id) : (info && info.name ? String(info.name) : `物品${id}`));
            return {
                id,
                count,
                name,
                itemType: toNum(info && info.type),
                isFruit: !!plantByFruit,
                isSeed: !!seedPlant,
            };
        });
    }

    async getBagSeeds() {
        const all = await this.getBagSnapshot();
        return all.filter((x) => x.isSeed && x.count > 0);
    }

    async sellAllFruits() {
        if (this.isSelling) {
            this.logger.info('WarehousePlugin', '自动出售跳过：上一次出售仍在进行');
            return;
        }
        this.isSelling = true;

        try {
            // 1. 获取背包物品
            const items = await this.fetchBagItems();
            
            // 2. 筛选出属于果实的物品且数量大于0
            const toSell = [];
            const names = [];
            for (const item of items) {
                const id = toNum(item.id);
                const count = toNum(item.count);
                if (count > 0 && !!getPlantByFruitId(id)) {
                    toSell.push(item);
                    names.push(`${getFruitName(id)}x${count}`);
                }
            }

            if (toSell.length === 0) {
                this.logger.info('WarehousePlugin', '背包中没有可出售的果实');
                return;
            }

            // 3. 批量发送出售请求
            let serverGoldEarned = 0;
            const preGold = this.engine.state.user.gold || 0;

            for (let i = 0; i < toSell.length; i += this.SELL_BATCH_SIZE) {
                const batch = toSell.slice(i, i + this.SELL_BATCH_SIZE);
                const payload = batch.map(item => ({
                    id: this.engine.network.toLong(item.id),
                    count: this.engine.network.toLong(item.count)
                }));

                const sellBody = types.SellRequest.encode(types.SellRequest.create({ items: payload })).finish();
                const { body: sellReplyBody } = await this.engine.network.sendMsgAsync('gamepb.itempb.ItemService', 'Sell', sellBody);
                const sellReply = types.SellReply.decode(sellReplyBody);

                // 解析获得的金币 (id 1 或 1001 通常表示金币)
                for (const getIt of (sellReply.get_items || [])) {
                    const id = toNum(getIt.id);
                    if (id === 1 || id === 1001) {
                        serverGoldEarned += toNum(getIt.count);
                    }
                }
                await sleep(300);
            }

            // 同步本地状态
            this.engine.state.user.gold += serverGoldEarned;

            this.logger.info('WarehousePlugin', `成功出售: ${names.join(', ')}，获得 ${serverGoldEarned} 金币`);

        } catch (e) {
            this.logger.warn('WarehousePlugin', `自动出售失败: ${e.message}`);
        } finally {
            this.isSelling = false;
        }
    }

    // ==========================================
    // 自动使用化肥逻辑
    // ==========================================

    startFertilizerLoop() {
        // 每 30 分钟检查一次是否需要开化肥包
        this.scheduler.setInterval(async () => {
            await this.autoOpenFertilizerPacks();
        }, 30 * 60 * 1000);
        
        // 启动时立刻执行一次
        this.scheduler.setTimeout(() => this.autoOpenFertilizerPacks(), 5000);
    }

    async autoOpenFertilizerPacks() {
        try {
            const items = await this.fetchBagItems();

            const payloads = [];
            let normalHours = 0;
            let organicHours = 0;

            // 提取容器当前时间
            for (const it of items) {
                const id = toNum(it.id);
                const count = toNum(it.count);
                if (id === this.NORMAL_CONTAINER_ID) normalHours = count / 3600;
                if (id === this.ORGANIC_CONTAINER_ID) organicHours = count / 3600;
            }

            // 寻找要使用的道具
            for (const it of items) {
                const id = toNum(it.id);
                const count = toNum(it.count);
                if (id <= 0 || count <= 0) continue;
                
                // 排除容器本身
                if (id === this.NORMAL_CONTAINER_ID || id === this.ORGANIC_CONTAINER_ID) continue;
                
                let isFertilizer = this.FERTILIZER_RELATED_IDS.has(id);
                if (!isFertilizer) {
                    const info = getItemById(id);
                    if (info) {
                        const type = String(info.interaction_type || '').toLowerCase();
                        if (type === 'fertilizer' || type === 'fertilizerpro') {
                            isFertilizer = true;
                        }
                    }
                }

                if (isFertilizer) {
                    payloads.push({ itemId: id, count });
                }
            }

            if (payloads.length === 0) {
                this.logger.info('WarehousePlugin', '自动补充化肥跳过：背包中无可使用化肥道具');
                return;
            }

            // 为了安全起见，一次不要用太多，如果接近 990h 就不再自动使用
            if (normalHours >= this.FERTILIZER_CONTAINER_LIMIT_HOURS && organicHours >= this.FERTILIZER_CONTAINER_LIMIT_HOURS) {
                this.logger.info('WarehousePlugin', `自动补充化肥跳过：容器接近上限(普通=${normalHours.toFixed(1)}h, 有机=${organicHours.toFixed(1)}h)`);
                return;
            }

            let opened = 0;
            for (const p of payloads) {
                // 每种道具默认先全用（这里简化了根据时长精准扣减的逻辑，因为如果超出服务器通常会报错）
                const useBody = types.BatchUseRequest.encode(types.BatchUseRequest.create({
                    items: [{
                        id: this.engine.network.toLong(p.itemId),
                        count: this.engine.network.toLong(p.count),
                        uid: this.engine.network.toLong(0)
                    }]
                })).finish();

                try {
                    await this.engine.network.sendMsgAsync('gamepb.itempb.ItemService', 'BatchUse', useBody);
                    opened += p.count;
                    await sleep(200);
                } catch (e) {
                    const msg = String(e.message || '');
                    if (msg.includes('容器已满') || msg.includes('达到上限')) {
                        break; // 满了就不再继续
                    }
                }
            }

            if (opened > 0) {
                this.logger.info('WarehousePlugin', `自动补充化肥包成功，共使用道具 x${opened}`);
            }

        } catch (e) {
            this.logger.warn('WarehousePlugin', `自动补充化肥包失败: ${e.message}`);
        }
    }
}

module.exports = { WarehousePlugin };
