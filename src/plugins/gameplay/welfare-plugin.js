const { BasePlugin } = require('../base-plugin');
const { types } = require('../../utils/proto');
const { sleep, getServerTimeSec } = require('../../utils/utils');

/**
 * 其他福利领取插件 (Welfare Plugin)
 * 整合月卡福利、QQ会员(VIP)福利、每日分享奖励、开服红包等边缘日常任务
 * 使用定时循环进行检查与领取
 */
class WelfarePlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        // 各个功能最后一次执行成功的日期 Key，避免重复调用
        this.records = {
            share: '',
            monthCard: '',
            vip: '',
            openServer: '',
            email: ''
        };
    }

    onLoad() {}

    onEnable() {
        this.logger.info('WelfarePlugin', '日常福利领取模块已启动');

        // 登录成功后启动福利领取循环
        this.on('login_success', () => {
            this.scheduler.setTimeout(() => this.startCheckLoop(), 12000);
        });
    }

    onDisable() {
        this.logger.info('WelfarePlugin', '日常福利领取模块已停止');
    }

    getDateKey() {
        const nowSec = getServerTimeSec();
        const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
        const bjDate = new Date(nowMs + 8 * 3600 * 1000);
        return `${bjDate.getUTCFullYear()}-${String(bjDate.getUTCMonth() + 1).padStart(2, '0')}-${String(bjDate.getUTCDate()).padStart(2, '0')}`;
    }

    startCheckLoop() {
        this.checkAllWelfare();
        // 每小时检查一次即可 (福利大多是一天领一次的)
        this.scheduler.setInterval(() => {
            this.checkAllWelfare();
        }, 60 * 60 * 1000);
    }

    async checkAllWelfare() {
        const config = this.engine.state.config;
        const today = this.getDateKey();

        // 1. 自动读取并领取邮箱附件 (无明显次数限制，但需要防抖，这里设为每天收一次或者每次登录收一次)
        if (config.auto_email && this.records.email !== today) {
            await this.checkAndClaimEmails();
            this.records.email = today;
            await sleep(500);
        }

        // 2. 每日分享奖励
        if (config.auto_share && this.records.share !== today) {
            const success = await this.performDailyShare();
            if (success) this.records.share = today;
            await sleep(500);
        }

        // 3. 每日月卡奖励
        if (config.auto_month_card && this.records.monthCard !== today) {
            const success = await this.performMonthCardGift();
            if (success) this.records.monthCard = today;
            await sleep(500);
        }

        // 4. QQ/微信会员(Vip)礼包
        if (config.auto_vip && this.records.vip !== today) {
            const success = await this.performVipGift();
            if (success) this.records.vip = today;
            await sleep(500);
        }

        // 5. 开服红包 (仅限活动期间)
        if (config.auto_open_server && this.records.openServer !== today) {
            const success = await this.performOpenServerGift();
            if (success) this.records.openServer = today;
            await sleep(500);
        }
    }

    // ==========================================
    // 具体业务方法
    // ==========================================

    async checkAndClaimEmails() {
        try {
            // 获取邮件列表
            const listBody = types.GetEmailListRequest.encode(types.GetEmailListRequest.create({})).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.emailpb.EmailService', 'GetEmailList', listBody);
            const reply = types.GetEmailListReply.decode(replyBody);

            const emails = reply.emails || [];
            if (emails.length === 0) return;

            // 过滤出未读且有附件的邮件
            // (在 protobuf 中 is_read 为 boolean, attachment 为数组)
            const unreadWithItems = emails.filter(e => !e.is_read && e.attachment && e.attachment.length > 0);
            if (unreadWithItems.length === 0) return;

            const uids = unreadWithItems.map(e => this.engine.network.toLong(e.uid));
            
            // 发送领取请求
            const readBody = types.ReadEmailRequest.encode(types.ReadEmailRequest.create({ uids })).finish();
            const { body: readReplyBody } = await this.engine.network.sendMsgAsync('gamepb.emailpb.EmailService', 'ReadEmail', readBody);
            const readReply = types.ReadEmailReply.decode(readReplyBody);

            const gainedCount = (readReply.attachment || []).length;
            if (gainedCount > 0) {
                this.logger.info('福利(Email)', `成功领取 ${unreadWithItems.length} 封邮件的附件奖励`);
            }
        } catch (e) {
            this.logger.warn('福利(Email)', `领取邮件附件失败: ${e.message}`);
        }
    }

    async performDailyShare() {
        if (!types.ShareReportRequest || !types.ShareReportReply) return false;
        try {
            const body = types.ShareReportRequest.encode(types.ShareReportRequest.create({
                target: 1,  // 任意目标
                scene: 1    // 任意场景
            })).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.sharepb.ShareService', 'ShareReport', body);
            const reply = types.ShareReportReply.decode(replyBody);
            
            if (reply.items && reply.items.length > 0) {
                this.logger.info('福利(Share)', `每日分享奖励领取成功，获得 ${reply.items.length} 件物品`);
                return true;
            }
            return false; // 没拿到物品可能今天已经领过
        } catch {
            return false;
        }
    }

    async performMonthCardGift() {
        try {
            const body = types.ClaimMonthCardDailyGiftRequest.encode(types.ClaimMonthCardDailyGiftRequest.create({})).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.shoppb.ShopService', 'ClaimMonthCardDailyGift', body);
            const reply = types.ClaimMonthCardDailyGiftReply.decode(replyBody);

            if (reply.items && reply.items.length > 0) {
                this.logger.info('福利(MonthCard)', `月卡每日福利领取成功，获得 ${reply.items.length} 件物品`);
                return true;
            }
            return false;
        } catch (e) {
            const msg = String(e.message || '');
            if (msg.includes('没有月卡') || msg.includes('月卡已过期')) {
                // 如果没有月卡，今天就不再尝试
                return true; 
            }
            return false;
        }
    }

    async performVipGift() {
        if (!types.ClaimDailyGiftRequest || !types.ClaimDailyGiftReply) return false;
        try {
            const body = types.ClaimDailyGiftRequest.encode(types.ClaimDailyGiftRequest.create({})).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.qqvippb.QQVipService', 'ClaimDailyGift', body);
            const reply = types.ClaimDailyGiftReply.decode(replyBody);
            
            if (reply.items && reply.items.length > 0) {
                this.logger.info('福利(Vip)', `VIP/黄钻每日礼包领取成功`);
                return true;
            }
            return false;
        } catch (e) {
            const msg = String(e.message || '');
            if (msg.includes('未开通') || msg.includes('已领取')) {
                return true;
            }
            return false;
        }
    }

    async performOpenServerGift() {
        if (!types.ClaimDailyRedpacketRequest || !types.ClaimDailyRedpacketReply) return false;
        try {
            const body = types.ClaimDailyRedpacketRequest.encode(types.ClaimDailyRedpacketRequest.create({})).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.redpacketpb.RedpacketService', 'ClaimDailyRedpacket', body);
            const reply = types.ClaimDailyRedpacketReply.decode(replyBody);

            if (reply.items && reply.items.length > 0) {
                this.logger.info('福利(OpenServer)', `开服红包领取成功`);
                return true;
            }
            return false;
        } catch (e) {
            const msg = String(e.message || '');
            if (msg.includes('活动已结束') || msg.includes('已领取')) {
                return true;
            }
            return false;
        }
    }
}

module.exports = { WelfarePlugin };