const { BasePlugin } = require('../base-plugin');
const { types } = require('../../utils/proto');
const { sleep, getServerTimeSec } = require('../../utils/utils');

/**
 * 日常福利领取插件：
 * - 邮箱奖励
 * - 每日分享奖励
 * - 月卡每日奖励
 * - 会员每日礼包
 * - 开服红包
 */
class WelfarePlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        this.CHECK_COOLDOWN_MS = 10 * 60 * 1000;
        this.EMAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

        // 每个子任务的执行状态（按功能独立冷却，跨日重置）
        this.records = {
            share: { doneDateKey: '', lastCheckAt: 0, lastCheckDateKey: '' },
            monthCard: { doneDateKey: '', lastCheckAt: 0, lastCheckDateKey: '' },
            vip: { doneDateKey: '', lastCheckAt: 0, lastCheckDateKey: '' },
            openServer: { doneDateKey: '', lastCheckAt: 0, lastCheckDateKey: '' },
            email: { doneDateKey: '', lastCheckAt: 0, lastCheckDateKey: '' },
        };
        this.checking = false;
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
        super.onDisable();
    }

    getDateKey() {
        const nowSec = getServerTimeSec();
        const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
        const bjDate = new Date(nowMs + 8 * 3600 * 1000);
        return `${bjDate.getUTCFullYear()}-${String(bjDate.getUTCMonth() + 1).padStart(2, '0')}-${String(bjDate.getUTCDate()).padStart(2, '0')}`;
    }

    startCheckLoop() {
        this.checkAllWelfare();

        // 高频轮询配合子任务冷却，失败时可快速重试且不会请求风暴。
        this.scheduler.setInterval(() => {
            this.checkAllWelfare();
        }, 30 * 1000);
    }

    canRunTask(taskKey, cooldownMs, force = false) {
        const now = Date.now();
        const today = this.getDateKey();
        const record = this.records[taskKey];
        if (!record) return true;
        if (force) return true;
        if (record.doneDateKey === today) return false;
        if (record.lastCheckDateKey !== today) return true;
        return (now - record.lastCheckAt) >= cooldownMs;
    }

    markTaskChecked(taskKey, doneToday = false) {
        const record = this.records[taskKey];
        if (!record) return;
        record.lastCheckAt = Date.now();
        record.lastCheckDateKey = this.getDateKey();
        if (doneToday) {
            record.doneDateKey = this.getDateKey();
        }
    }

    isAlreadyClaimedError(error) {
        const msg = String(error && error.message ? error.message : error || '');
        return msg.includes('code=1009001') ||
            msg.includes('code=1018005') ||
            msg.includes('已经领取') ||
            msg.includes('已领取') ||
            msg.includes('活动未解锁') ||
            msg.includes('次数已达上限') ||
            msg.includes('已达上限');
    }

    async checkAllWelfare() {
        if (this.checking) {
            this.logger.info('WelfarePlugin', '福利检查跳过：上一次检查尚未结束');
            return;
        }
        this.checking = true;
        const config = this.engine.state.config;

        try {
            // 邮箱每天检查一次，避免高频刷取。
            if (config.auto_email && this.canRunTask('email', this.EMAIL_COOLDOWN_MS)) {
                await this.checkAndClaimEmails(false);
                await sleep(500);
            }

            if (config.auto_share && this.canRunTask('share', this.CHECK_COOLDOWN_MS)) {
                await this.performDailyShare(false);
                await sleep(500);
            }

            if (config.auto_month_card && this.canRunTask('monthCard', this.CHECK_COOLDOWN_MS)) {
                await this.performMonthCardGift(false);
                await sleep(500);
            }

            if (config.auto_vip && this.canRunTask('vip', this.CHECK_COOLDOWN_MS)) {
                await this.performVipGift(false);
                await sleep(500);
            }

            if (config.auto_open_server && this.canRunTask('openServer', this.CHECK_COOLDOWN_MS)) {
                await this.performOpenServerGift(false);
                await sleep(500);
            }
        } finally {
            this.checking = false;
        }
    }

    async checkAndClaimEmails(force = false) {
        if (!this.canRunTask('email', this.EMAIL_COOLDOWN_MS, force)) return false;
        try {
            const [box1, box2] = await Promise.all([
                this.getEmailList(1).catch(() => ({ emails: [] })),
                this.getEmailList(2).catch(() => ({ emails: [] })),
            ]);

            const merged = new Map();
            const fromBox1 = (box1.emails || []).map((x) => ({ ...x, __boxType: 1 }));
            const fromBox2 = (box2.emails || []).map((x) => ({ ...x, __boxType: 2 }));
            for (const email of [...fromBox1, ...fromBox2]) {
                if (!email || !email.id) continue;
                if (!merged.has(email.id)) {
                    merged.set(email.id, email);
                    continue;
                }
                const old = merged.get(email.id);
                const oldClaimable = !!(old && old.has_reward === true && old.claimed !== true);
                const nowClaimable = !!(email && email.has_reward === true && email.claimed !== true);
                if (!oldClaimable && nowClaimable) merged.set(email.id, email);
            }

            const claimable = [...merged.values()].filter((x) => x && x.id && x.has_reward === true && x.claimed !== true);
            if (claimable.length === 0) {
                this.markTaskChecked('email', true);
                this.logger.info('福利(Email)', '今日暂无可领取邮箱奖励');
                return false;
            }

            let claimed = 0;
            const byBox = new Map();
            for (const m of claimable) {
                const boxType = this.normalizeBoxType(m && m.__boxType);
                if (!byBox.has(boxType)) byBox.set(boxType, []);
                byBox.get(boxType).push(m);
            }

            // 先尝试每个邮箱类型批量领取，失败后再走单封领取兜底。
            for (const [boxType, list] of byBox.entries()) {
                try {
                    const firstId = String((list[0] && list[0].id) || '');
                    if (!firstId) continue;
                    await this.batchClaimEmail(boxType, firstId);
                    claimed += 1;
                } catch {
                    // 批量失败时继续尝试单封领取。
                }
            }

            for (const m of claimable) {
                try {
                    const boxType = this.normalizeBoxType(m && m.__boxType);
                    await this.claimEmail(boxType, String(m.id || ''));
                    claimed += 1;
                } catch {
                    // 单封失败时忽略，继续处理后续邮件。
                }
            }

            this.markTaskChecked('email', true);
            if (claimed > 0) {
                this.logger.info('福利(Email)', `成功领取邮箱奖励，共处理 ${claimed} 次`);
                return true;
            }
            return false;
        } catch (e) {
            this.markTaskChecked('email', false);
            this.logger.warn('福利(Email)', `领取邮件附件失败: ${e.message}`);
            return false;
        }
    }

    async performDailyShare(force = false) {
        if (!this.canRunTask('share', this.CHECK_COOLDOWN_MS, force)) return false;
        if (!types.CheckCanShareRequest || !types.ReportShareRequest || !types.ClaimShareRewardRequest) {
            this.markTaskChecked('share', false);
            this.logger.warn('福利(Share)', '分享奖励检查失败：协议缺失');
            return false;
        }
        try {
            const canBody = types.CheckCanShareRequest.encode(types.CheckCanShareRequest.create({})).finish();
            const { body: canReplyBody } = await this.engine.network.sendMsgAsync('gamepb.sharepb.ShareService', 'CheckCanShare', canBody);
            const canReply = types.CheckCanShareReply.decode(canReplyBody);
            if (!canReply || !canReply.can_share) {
                this.markTaskChecked('share', true);
                this.logger.info('福利(Share)', '今日暂无可领取分享奖励');
                return false;
            }

            const reportBody = types.ReportShareRequest.encode(types.ReportShareRequest.create({ shared: true })).finish();
            const { body: reportReplyBody } = await this.engine.network.sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', reportBody);
            const reportReply = types.ReportShareReply.decode(reportReplyBody);
            if (!reportReply || !reportReply.success) {
                this.markTaskChecked('share', false);
                this.logger.warn('福利(Share)', '分享上报失败，本轮跳过领取');
                return false;
            }

            const claimBody = types.ClaimShareRewardRequest.encode(types.ClaimShareRewardRequest.create({ claimed: true })).finish();
            const { body: claimReplyBody } = await this.engine.network.sendMsgAsync('gamepb.sharepb.ShareService', 'ClaimShareReward', claimBody);
            const claimReply = types.ClaimShareRewardReply.decode(claimReplyBody);
            this.markTaskChecked('share', true);
            if (claimReply && claimReply.success) {
                const count = Array.isArray(claimReply.items) ? claimReply.items.length : 0;
                this.logger.info('福利(Share)', `每日分享奖励领取成功，获得 ${count} 件物品`);
                return true;
            }
            return false;
        } catch (e) {
            if (this.isAlreadyClaimedError(e)) {
                this.markTaskChecked('share', true);
                this.logger.info('福利(Share)', '今日分享奖励已领取');
                return false;
            }
            this.markTaskChecked('share', false);
            this.logger.warn('福利(Share)', `领取失败: ${e.message}`);
            return false;
        }
    }

    async performMonthCardGift(force = false) {
        if (!this.canRunTask('monthCard', this.CHECK_COOLDOWN_MS, force)) return false;
        if (!types.GetMonthCardInfosRequest || !types.ClaimMonthCardRewardRequest) {
            this.markTaskChecked('monthCard', false);
            this.logger.warn('福利(MonthCard)', '月卡奖励检查失败：协议缺失');
            return false;
        }
        try {
            const infosBody = types.GetMonthCardInfosRequest.encode(types.GetMonthCardInfosRequest.create({})).finish();
            const { body: infosReplyBody } = await this.engine.network.sendMsgAsync('gamepb.mallpb.MallService', 'GetMonthCardInfos', infosBody);
            const infosReply = types.GetMonthCardInfosReply.decode(infosReplyBody);
            const infos = Array.isArray(infosReply && infosReply.infos) ? infosReply.infos : [];
            if (!infos.length) {
                this.markTaskChecked('monthCard', true);
                this.logger.info('福利(MonthCard)', '当前没有月卡或月卡已过期');
                return false;
            }

            const claimable = infos.filter((x) => x && x.can_claim && Number(x.goods_id || 0) > 0);
            if (!claimable.length) {
                this.markTaskChecked('monthCard', true);
                this.logger.info('福利(MonthCard)', '今日暂无可领取月卡奖励');
                return false;
            }

            let claimed = 0;
            for (const info of claimable) {
                try {
                    const body = types.ClaimMonthCardRewardRequest.encode(types.ClaimMonthCardRewardRequest.create({
                        goods_id: Number(info.goods_id) || 0,
                    })).finish();
                    const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.mallpb.MallService', 'ClaimMonthCardReward', body);
                    const reply = types.ClaimMonthCardRewardReply.decode(replyBody);
                    const count = Array.isArray(reply && reply.items) ? reply.items.length : 0;
                    this.logger.info('福利(MonthCard)', `月卡每日福利领取成功(gid=${Number(info.goods_id)}), 获得 ${count} 件物品`);
                    claimed += 1;
                } catch (e) {
                    this.logger.warn('福利(MonthCard)', `月卡奖励领取失败(gid=${Number(info.goods_id)}): ${e.message}`);
                }
            }
            this.markTaskChecked('monthCard', true);
            if (claimed > 0) {
                return true;
            }
            return false;
        } catch (e) {
            if (this.isAlreadyClaimedError(e)) {
                this.markTaskChecked('monthCard', true);
                this.logger.info('福利(MonthCard)', '今日月卡奖励已领取');
                return false;
            }
            this.markTaskChecked('monthCard', false);
            this.logger.warn('福利(MonthCard)', `月卡奖励检查失败: ${e.message}`);
            return false;
        }
    }

    async performVipGift(force = false) {
        if (!this.canRunTask('vip', this.CHECK_COOLDOWN_MS, force)) return false;
        if (!types.GetDailyGiftStatusRequest || !types.ClaimDailyGiftRequest) {
            this.markTaskChecked('vip', false);
            this.logger.warn('福利(VIP)', '会员礼包检查失败：协议缺失');
            return false;
        }
        try {
            const statusBody = types.GetDailyGiftStatusRequest.encode(types.GetDailyGiftStatusRequest.create({})).finish();
            const { body: statusReplyBody } = await this.engine.network.sendMsgAsync('gamepb.qqvippb.QQVipService', 'GetDailyGiftStatus', statusBody);
            const statusReply = types.GetDailyGiftStatusReply.decode(statusReplyBody);
            if (!statusReply || !statusReply.can_claim) {
                this.markTaskChecked('vip', true);
                this.logger.info('福利(VIP)', '今日暂无可领取会员礼包');
                return false;
            }

            const body = types.ClaimDailyGiftRequest.encode(types.ClaimDailyGiftRequest.create({})).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.qqvippb.QQVipService', 'ClaimDailyGift', body);
            const reply = types.ClaimDailyGiftReply.decode(replyBody);
            this.markTaskChecked('vip', true);

            const count = Array.isArray(reply && reply.items) ? reply.items.length : 0;
            if (count > 0) {
                this.logger.info('福利(VIP)', `VIP/黄钻每日礼包领取成功，获得 ${count} 件物品`);
                return true;
            }
            return false;
        } catch (e) {
            if (this.isAlreadyClaimedError(e)) {
                this.markTaskChecked('vip', true);
                this.logger.info('福利(VIP)', '今日会员礼包已领取');
                return false;
            }
            this.markTaskChecked('vip', false);
            this.logger.warn('福利(VIP)', `会员礼包领取失败: ${e.message}`);
            return false;
        }
    }

    async performOpenServerGift(force = false) {
        if (!this.canRunTask('openServer', this.CHECK_COOLDOWN_MS, force)) return false;
        if (!types.GetTodayClaimStatusRequest || !types.ClaimRedPacketRequest) {
            this.markTaskChecked('openServer', false);
            this.logger.warn('福利(OpenServer)', '开服红包检查失败：协议缺失');
            return false;
        }
        try {
            const statusBody = types.GetTodayClaimStatusRequest.encode(types.GetTodayClaimStatusRequest.create({})).finish();
            const { body: statusReplyBody } = await this.engine.network.sendMsgAsync('gamepb.redpacketpb.RedPacketService', 'GetTodayClaimStatus', statusBody);
            const statusReply = types.GetTodayClaimStatusReply.decode(statusReplyBody);
            const infos = Array.isArray(statusReply && statusReply.infos) ? statusReply.infos : [];
            const claimable = infos.filter((x) => x && x.can_claim && Number(x.id || 0) > 0);
            if (!claimable.length) {
                this.markTaskChecked('openServer', true);
                this.logger.info('福利(OpenServer)', '今日暂无可领取开服红包');
                return false;
            }

            let claimed = 0;
            for (const info of claimable) {
                const packetId = Number(info.id || 0);
                try {
                    const claimBody = types.ClaimRedPacketRequest.encode(types.ClaimRedPacketRequest.create({
                        id: packetId,
                    })).finish();
                    await this.engine.network.sendMsgAsync('gamepb.redpacketpb.RedPacketService', 'ClaimRedPacket', claimBody);
                    claimed += 1;
                } catch (e) {
                    if (this.isAlreadyClaimedError(e)) {
                        this.markTaskChecked('openServer', true);
                        this.logger.info('福利(OpenServer)', '今日开服红包已领取');
                        return false;
                    }
                    this.logger.warn('福利(OpenServer)', `领取失败(id=${packetId}): ${e.message}`);
                }
            }

            this.markTaskChecked('openServer', true);
            if (claimed > 0) {
                this.logger.info('福利(OpenServer)', `开服红包领取成功，共领取 ${claimed} 次`);
                return true;
            }
            return false;
        } catch (e) {
            if (this.isAlreadyClaimedError(e)) {
                this.markTaskChecked('openServer', true);
                this.logger.info('福利(OpenServer)', '今日开服红包已领取');
                return false;
            }
            this.markTaskChecked('openServer', false);
            this.logger.warn('福利(OpenServer)', `开服红包领取失败: ${e.message}`);
            return false;
        }
    }

    async getEmailList(boxType = 1) {
        const body = types.GetEmailListRequest.encode(types.GetEmailListRequest.create({
            box_type: Number(boxType) || 1,
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.emailpb.EmailService', 'GetEmailList', body);
        return types.GetEmailListReply.decode(replyBody);
    }

    async claimEmail(boxType = 1, emailId = '') {
        const body = types.ClaimEmailRequest.encode(types.ClaimEmailRequest.create({
            box_type: Number(boxType) || 1,
            email_id: String(emailId || ''),
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.emailpb.EmailService', 'ClaimEmail', body);
        return types.ClaimEmailReply.decode(replyBody);
    }

    async batchClaimEmail(boxType = 1, emailId = '') {
        const body = types.BatchClaimEmailRequest.encode(types.BatchClaimEmailRequest.create({
            box_type: Number(boxType) || 1,
            email_id: String(emailId || ''),
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.emailpb.EmailService', 'BatchClaimEmail', body);
        return types.BatchClaimEmailReply.decode(replyBody);
    }

    normalizeBoxType(v) {
        const n = Number(v);
        return (n === 1 || n === 2) ? n : 1;
    }
}

module.exports = { WelfarePlugin };
