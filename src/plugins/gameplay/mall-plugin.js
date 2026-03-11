const { BasePlugin } = require('../base-plugin');
const { types } = require('../../utils/proto');
const { toNum, sleep, getServerTimeSec } = require('../../utils/utils');
const { Buffer } = require('buffer');

/**
 * 商城自动化插件 (Mall Auto Plugin)
 * 负责每日免费礼包领取，以及使用点券自动购买有机化肥等。
 */
class MallPlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        // 商城有机化肥的 goods_id
        this.ORGANIC_FERTILIZER_GOODS_ID = 1002;
        
        // 每日任务检查状态
        this.lastFreeGiftCheckAt = 0;
        this.freeGiftDoneDateKey = '';

        this.lastBuyFertilizerAt = 0;
        this.buyFertilizerDoneDateKey = '';
        this.pausedNoGoldDateKey = ''; // 当点券不足时，当天暂停购买
    }

    onLoad() {}

    onEnable() {
        this.logger.info('MallPlugin', '商城自动化模块已启动');

        // 登录成功后启动商城检查循环
        this.on('login_success', () => {
            // 延迟10秒，错开初始化高峰
            this.scheduler.setTimeout(() => this.startCheckLoop(), 10000);
        });
    }

    onDisable() {
        this.logger.info('MallPlugin', '商城自动化模块已停止');
    }

    // ==========================================
    // 调度循环
    // ==========================================

    startCheckLoop() {
        this.checkMall();
        // 每 30 分钟检查一次
        this.scheduler.setInterval(() => {
            this.checkMall();
        }, 30 * 60 * 1000);
    }

    async checkMall() {
        const config = this.engine.state.config;
        if (!config.auto_mall_free && !config.auto_mall_buy) return;

        try {
            // 首先拉取商城列表
            const mallList = await this.getMallList();
            
            // 1. 领取免费礼包
            if (config.auto_mall_free && this.canCheckFreeGift()) {
                await this.claimFreeGifts(mallList);
            }

            // 2. 自动购买有机化肥
            if (config.auto_mall_buy && this.canBuyFertilizer()) {
                await this.buyOrganicFertilizer(mallList);
            }
        } catch (e) {
            this.logger.warn('MallPlugin', `商城交互失败: ${e.message}`);
        }
    }

    getDateKey() {
        const nowSec = getServerTimeSec();
        const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
        const bjDate = new Date(nowMs + 8 * 3600 * 1000);
        return `${bjDate.getUTCFullYear()}-${String(bjDate.getUTCMonth() + 1).padStart(2, '0')}-${String(bjDate.getUTCDate()).padStart(2, '0')}`;
    }

    canCheckFreeGift() {
        return this.freeGiftDoneDateKey !== this.getDateKey() && (Date.now() - this.lastFreeGiftCheckAt > 5 * 60 * 1000);
    }

    canBuyFertilizer() {
        const today = this.getDateKey();
        if (this.pausedNoGoldDateKey === today) return false;
        if (this.buyFertilizerDoneDateKey === today) return false;
        if (Date.now() - this.lastBuyFertilizerAt < 10 * 60 * 1000) return false;
        return true;
    }

    // ==========================================
    // 协议请求与执行
    // ==========================================

    async getMallList(slotType = 1) {
        const body = types.GetMallListBySlotTypeRequest.encode(types.GetMallListBySlotTypeRequest.create({
            slot_type: Number(slotType) || 1,
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.mallpb.MallService', 'GetMallListBySlotType', body);
        const reply = types.GetMallListBySlotTypeResponse.decode(replyBody);

        const goodsList = [];
        if (Array.isArray(reply.goods_list)) {
            for (const b of reply.goods_list) {
                try {
                    goodsList.push(types.MallGoods.decode(b));
                } catch { /* ignore */ }
            }
        }
        return goodsList;
    }

    async purchaseMallGoods(goodsId, count = 1) {
        const body = types.PurchaseRequest.encode(types.PurchaseRequest.create({
            goods_id: Number(goodsId) || 0,
            count: Number(count) || 1,
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.mallpb.MallService', 'Purchase', body);
        return types.PurchaseResponse.decode(replyBody);
    }

    // ==========================================
    // 核心业务
    // ==========================================

    async claimFreeGifts(goodsList) {
        this.lastFreeGiftCheckAt = Date.now();
        const freeGoods = goodsList.filter(g => g.is_free === true && Number(g.goods_id) > 0);
        
        if (freeGoods.length === 0) {
            this.freeGiftDoneDateKey = this.getDateKey();
            return;
        }

        let bought = 0;
        for (const g of freeGoods) {
            try {
                await this.purchaseMallGoods(Number(g.goods_id), 1);
                bought++;
                await sleep(200);
            } catch (e) {
                // 单个失败忽略
            }
        }

        if (bought > 0) {
            this.freeGiftDoneDateKey = this.getDateKey();
            this.logger.info('MallPlugin', `成功领取今日免费礼包 x${bought}`);
        }
    }

    async buyOrganicFertilizer(goodsList) {
        this.lastBuyFertilizerAt = Date.now();
        
        const goods = goodsList.find(g => toNum(g.goods_id) === this.ORGANIC_FERTILIZER_GOODS_ID);
        if (!goods) return;

        const goodsId = toNum(goods.goods_id);
        const singlePrice = this.parseMallPriceValue(goods.price);
        let ticket = Math.max(0, toNum(this.engine.state.user.coupon)); // coupon/ticket 代表点券

        if (singlePrice > 0 && ticket < singlePrice) {
            this.pausedNoGoldDateKey = this.getDateKey();
            this.logger.info('MallPlugin', '点券不足以购买有机化肥，今日暂停购买。');
            return;
        }

        const BUY_PER_ROUND = 10;
        const MAX_ROUNDS = 100;
        let perRound = Math.max(1, Math.min(BUY_PER_ROUND, Math.floor(ticket / singlePrice)));
        let totalBought = 0;

        for (let i = 0; i < MAX_ROUNDS; i++) {
            if (singlePrice > 0 && ticket < singlePrice) {
                this.pausedNoGoldDateKey = this.getDateKey();
                break;
            }

            try {
                await this.purchaseMallGoods(goodsId, perRound);
                totalBought += perRound;
                
                if (singlePrice > 0) {
                    ticket = Math.max(0, ticket - (singlePrice * perRound));
                    if (ticket < singlePrice) break;
                }
                await sleep(150);
            } catch (e) {
                const msg = String(e.message || '');
                if (msg.includes('余额不足') || msg.includes('点券不足')) {
                    if (perRound > 1) {
                        perRound = 1;
                        continue;
                    }
                    this.pausedNoGoldDateKey = this.getDateKey();
                }
                break;
            }
        }

        if (totalBought > 0) {
            this.buyFertilizerDoneDateKey = this.getDateKey();
            // 同步一下状态
            this.engine.state.user.coupon = ticket;
            this.logger.info('MallPlugin', `自动购买有机化肥成功，共购买 x${totalBought} (剩余点券: ${ticket})`);
        }
    }

    // ==========================================
    // 辅助解析
    // ==========================================
    
    parseMallPriceValue(priceField) {
        if (priceField == null) return 0;
        if (typeof priceField === 'number') return Math.max(0, Math.floor(priceField));
        const bytes = Buffer.isBuffer(priceField) ? priceField : Buffer.from(priceField || []);
        if (!bytes.length) return 0;
        let idx = 0;
        let parsed = 0;
        while (idx < bytes.length) {
            const key = bytes[idx++];
            const field = key >> 3;
            const wire = key & 0x07;
            if (wire !== 0) break;
            let val = 0;
            let shift = 0;
            while (idx < bytes.length) {
                const b = bytes[idx++];
                val |= (b & 0x7F) << shift;
                if ((b & 0x80) === 0) break;
                shift += 7;
            }
            if (field === 2) parsed = val;
        }
        return Math.max(0, Math.floor(parsed || 0));
    }
}

module.exports = { MallPlugin };