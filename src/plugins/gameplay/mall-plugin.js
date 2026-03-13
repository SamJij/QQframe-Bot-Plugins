const { BasePlugin } = require('../base-plugin');
const { types } = require('../../utils/proto');
const { toNum, sleep, getServerTimeSec } = require('../../utils/utils');
const { Buffer } = require('buffer');

/**
 * 商城自动化插件：
 * - 每日领取免费礼包
 * - 使用点券自动购买化肥（有机/普通）
 */
class MallPlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        this.ORGANIC_FERTILIZER_GOODS_ID = 1002;
        this.NORMAL_FERTILIZER_GOODS_ID = 1003;
        this.NORMAL_CONTAINER_ID = 1011;
        this.ORGANIC_CONTAINER_ID = 1012;
        this.BUY_PER_ROUND = 10;
        this.MAX_ROUNDS = 100;

        this.lastFreeGiftCheckAt = 0;
        this.freeGiftDoneDateKey = '';

        this.lastBuyFertilizerAt = 0;
        this.buyFertilizerDoneDateKey = '';
        this.pausedNoGoldDateKey = '';
    }

    onLoad() {}

    onEnable() {
        this.logger.info('MallPlugin', '商城自动化模块已启动');
        this.on('login_success', () => {
            this.scheduler.setTimeout(() => this.startCheckLoop(), 10000);
        });
    }

    onDisable() {
        this.logger.info('MallPlugin', '商城自动化模块已停止');
        super.onDisable();
    }

    startCheckLoop() {
        this.checkMall();
        this.scheduler.setInterval(() => {
            this.checkMall();
        }, 30 * 60 * 1000);
    }

    async checkMall() {
        const config = this.engine.state.config;
        if (!config.auto_mall_free && !config.auto_mall_buy) {
            this.logger.info('MallPlugin', '商城检查跳过：免费礼包与自动购买均未开启');
            return;
        }

        try {
            const mallList = await this.getMallList();
            if (config.auto_mall_free && this.canCheckFreeGift()) {
                await this.claimFreeGifts(mallList);
            } else if (config.auto_mall_free) {
                this.logger.info('MallPlugin', '免费礼包检查跳过：今日已完成或仍在冷却');
            }
            if (config.auto_mall_buy && this.canBuyFertilizer()) {
                await this.buyFertilizerByConfig(mallList);
            } else if (config.auto_mall_buy) {
                this.logger.info('MallPlugin', '自动购买化肥跳过：今日点券不足暂停或仍在冷却');
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
        if (Date.now() - this.lastBuyFertilizerAt < 10 * 60 * 1000) return false;
        return true;
    }

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
                } catch {
                    // 忽略异常商品项，继续处理其他商品。
                }
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

    async claimFreeGifts(goodsList) {
        this.lastFreeGiftCheckAt = Date.now();
        const freeGoods = goodsList.filter(g => g.is_free === true && Number(g.goods_id) > 0);

        if (freeGoods.length === 0) {
            this.freeGiftDoneDateKey = this.getDateKey();
            this.logger.info('MallPlugin', '今日暂无可领取免费礼包');
            return;
        }

        let bought = 0;
        for (const g of freeGoods) {
            try {
                await this.purchaseMallGoods(Number(g.goods_id), 1);
                bought++;
                await sleep(200);
            } catch {
                // 单个失败时继续处理剩余免费礼包。
            }
        }

        if (bought > 0) {
            this.freeGiftDoneDateKey = this.getDateKey();
            this.logger.info('MallPlugin', `成功领取今日免费礼包 x${bought}`);
        }
    }

    async getCurrentContainerHours() {
        const body = types.BagRequest.encode(types.BagRequest.create({})).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.itempb.ItemService', 'Bag', body);
        const reply = types.BagReply.decode(replyBody);
        const items = (reply.item_bag && reply.item_bag.items) ? reply.item_bag.items : (reply.items || []);

        let normalSec = 0;
        let organicSec = 0;
        for (const it of items) {
            const id = toNum(it.id);
            const count = toNum(it.count);
            if (id === this.NORMAL_CONTAINER_ID) normalSec = count;
            if (id === this.ORGANIC_CONTAINER_ID) organicSec = count;
        }
        return {
            normal: normalSec / 3600,
            organic: organicSec / 3600,
        };
    }

    async buyFertilizerViaMall(goodsList, targetGoodsId, maxTotal = 10) {
        const goods = goodsList.find(g => toNum(g.goods_id) === targetGoodsId);
        if (!goods) {
            this.logger.info('MallPlugin', `自动购买跳过：商城无目标商品(goods_id=${targetGoodsId})`);
            return 0;
        }

        this.lastBuyFertilizerAt = Date.now();
        const today = this.getDateKey();

        const goodsId = targetGoodsId;
        const singlePrice = this.parseMallPriceValue(goods.price);
        const couponKnown = !!this.engine.state.user.couponKnown;
        let ticket = Math.max(0, toNum(this.engine.state.user.coupon));
        let totalBought = 0;
        let perRound = Math.max(1, Math.min(this.BUY_PER_ROUND, Math.floor(Number(maxTotal) || this.BUY_PER_ROUND)));

        // 点券已知且不足时，直接暂停到次日。
        if (singlePrice > 0 && couponKnown && ticket < singlePrice) {
            this.pausedNoGoldDateKey = today;
            this.logger.info('MallPlugin', `点券不足，暂停今日自动购买(goods_id=${goodsId}, 价格=${singlePrice}, 点券=${ticket})`);
            return 0;
        }

        if (!couponKnown) {
            this.logger.info('MallPlugin', '点券未初始化，按服务端返回结果尝试购买。');
        }

        if (singlePrice > 0 && couponKnown && ticket > 0) {
            perRound = Math.max(1, Math.min(perRound, Math.floor(ticket / singlePrice) || 1));
        }

        for (let i = 0; i < this.MAX_ROUNDS; i++) {
            const remaining = maxTotal - totalBought;
            if (remaining <= 0) break;
            const thisBuy = Math.min(perRound, remaining);

            if (singlePrice > 0 && couponKnown && ticket < singlePrice) {
                this.pausedNoGoldDateKey = today;
                break;
            }

            try {
                await this.purchaseMallGoods(goodsId, thisBuy);
                totalBought += thisBuy;

                if (singlePrice > 0 && couponKnown) {
                    ticket = Math.max(0, ticket - (singlePrice * thisBuy));
                    if (ticket < singlePrice) break;
                }
                await sleep(150);
            } catch (e) {
                const msg = String(e.message || '');
                if (msg.includes('余额不足') || msg.includes('点券不足') || msg.includes('code=1000019')) {
                    if (thisBuy > 1) {
                        perRound = 1;
                        continue;
                    }
                    this.pausedNoGoldDateKey = today;
                }
                break;
            }
        }

        if (totalBought > 0) {
            if (couponKnown) {
                this.engine.state.user.coupon = ticket;
            }
        }
        return totalBought;
    }

    async buyFertilizerByConfig(goodsList) {
        const config = this.engine.state.config || {};
        const buyTypeRaw = String(config.auto_mall_buy_type || 'organic').trim().toLowerCase();
        const buyModeRaw = String(config.auto_mall_buy_mode || 'threshold').trim().toLowerCase();
        const buyType = ['organic', 'normal', 'both'].includes(buyTypeRaw) ? buyTypeRaw : 'organic';
        const buyMode = buyModeRaw === 'unlimited' ? 'unlimited' : 'threshold';
        const maxTotal = Math.max(1, Math.min(10, Math.floor(Number(config.auto_mall_buy_max) || 10)));
        const threshold = Math.max(0, Number(config.auto_mall_buy_threshold ?? 100));

        // 无限购买模式下，和原项目保持一致：不允许 both，自动收敛为 organic。
        const effectiveType = (buyMode === 'unlimited' && buyType === 'both') ? 'organic' : buyType;
        let buyOrganic = effectiveType === 'organic' || effectiveType === 'both';
        let buyNormal = effectiveType === 'normal' || effectiveType === 'both';
        let normalHours = 0;
        let organicHours = 0;

        if (buyMode === 'threshold') {
            ({ normal: normalHours, organic: organicHours } = await this.getCurrentContainerHours());
            if (threshold <= 0) {
                if (buyOrganic && organicHours > 0) buyOrganic = false;
                if (buyNormal && normalHours > 0) buyNormal = false;
            } else {
                if (buyOrganic && organicHours >= threshold) buyOrganic = false;
                if (buyNormal && normalHours >= threshold) buyNormal = false;
            }
        }

        if (!buyOrganic && !buyNormal) {
            this.lastBuyFertilizerAt = Date.now();
            this.logger.info(
                'MallPlugin',
                `自动购买跳过：阈值已满足(mode=${buyMode}, threshold=${threshold}, normal=${normalHours.toFixed(1)}h, organic=${organicHours.toFixed(1)}h)`
            );
            return;
        }

        const plans = [];
        if (buyOrganic) {
            plans.push({ goodsId: this.ORGANIC_FERTILIZER_GOODS_ID, currentHours: organicHours });
        }
        if (buyNormal) {
            plans.push({ goodsId: this.NORMAL_FERTILIZER_GOODS_ID, currentHours: normalHours });
        }
        if (plans.length > 1 && buyMode === 'threshold') {
            // 阈值模式下优先补足时长更低的容器。
            plans.sort((a, b) => a.currentHours - b.currentHours);
        }

        let totalBought = 0;
        let remaining = maxTotal;
        for (const plan of plans) {
            if (remaining <= 0) break;
            const bought = await this.buyFertilizerViaMall(goodsList, plan.goodsId, remaining);
            totalBought += bought;
            remaining -= bought;
        }

        if (totalBought > 0) {
            const couponKnown = !!this.engine.state.user.couponKnown;
            const ticket = Math.max(0, toNum(this.engine.state.user.coupon));
            this.buyFertilizerDoneDateKey = this.getDateKey();
            this.logger.info(
                'MallPlugin',
                `自动购买化肥成功，共购买 x${totalBought}${couponKnown ? ` (剩余点券: ${ticket})` : ''}`
            );
        } else {
            this.logger.info('MallPlugin', '自动购买执行完成：本轮未成功购买');
        }
    }

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
