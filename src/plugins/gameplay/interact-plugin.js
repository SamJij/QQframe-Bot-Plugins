const { BasePlugin } = require('../base-plugin');
const { types } = require('../../utils/proto');
const { toNum } = require('../../utils/utils');

/**
 * 互动记录插件：
 * - 拉取访客/互动记录
 * - 提取好友 GID 列表
 * - 通过事件输出给后续好友缓存逻辑复用
 */
class InteractPlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        this.INTERVAL_MS = 10 * 60 * 1000;
        this.RPC_CANDIDATES = [
            ['gamepb.interactpb.InteractService', 'InteractRecords'],
            ['gamepb.interactpb.InteractService', 'GetInteractRecords'],
            ['gamepb.interactpb.VisitorService', 'InteractRecords'],
            ['gamepb.interactpb.VisitorService', 'GetInteractRecords'],
        ];
        this.lastRecords = [];
        this.lastFriendGids = [];
    }

    onLoad() {}

    onEnable() {
        this.logger.info('InteractPlugin', '互动记录模块已启动');
        this.on('login_success', () => {
            this.scheduler.setTimeout(() => this.startLoop(), 9000);
        });
    }

    onDisable() {
        this.logger.info('InteractPlugin', '互动记录模块已停止');
        super.onDisable();
    }

    startLoop() {
        this.refreshInteractRecords();
        this.scheduler.setInterval(() => {
            this.refreshInteractRecords();
        }, this.INTERVAL_MS);
    }

    async refreshInteractRecords() {
        try {
            const records = await this.getInteractRecords();
            const friendGids = this.extractFriendGids(records);
            this.lastRecords = records;
            this.lastFriendGids = friendGids;

            this.engine.eventBus.emit('interact_records_updated', {
                records,
                friendGids,
                time: Date.now(),
            });

            this.logger.info('InteractPlugin', `互动记录更新成功：records=${records.length}, gids=${friendGids.length}`);
        } catch (e) {
            this.logger.warn('InteractPlugin', `互动记录更新失败: ${e.message}`);
        }
    }

    async getInteractRecords() {
        if (!types.InteractRecordsRequest || !types.InteractRecordsReply) {
            throw new Error('InteractRecords proto 未注册');
        }

        const body = types.InteractRecordsRequest.encode(types.InteractRecordsRequest.create({})).finish();
        const errors = [];
        for (const [serviceName, methodName] of this.RPC_CANDIDATES) {
            try {
                const { body: replyBody } = await this.engine.network.sendMsgAsync(serviceName, methodName, body, 3000);
                const reply = types.InteractRecordsReply.decode(replyBody);
                return Array.isArray(reply && reply.records) ? reply.records : [];
            } catch (e) {
                const msg = String(e && e.message ? e.message : e || 'unknown');
                errors.push(`${serviceName}.${methodName}: ${msg}`);
            }
        }
        throw new Error(`所有互动接口均调用失败: ${errors.join(' | ')}`);
    }

    extractFriendGids(records) {
        const list = Array.isArray(records) ? records : [];
        const seen = new Set();
        const gids = [];
        for (const r of list) {
            const gid = toNum(r && r.visitor_gid);
            if (gid <= 0) continue;
            if (seen.has(gid)) continue;
            seen.add(gid);
            gids.push(gid);
        }
        return gids;
    }

    getLatestFriendGids() {
        return Array.isArray(this.lastFriendGids) ? [...this.lastFriendGids] : [];
    }

    getLatestRecords() {
        return Array.isArray(this.lastRecords) ? [...this.lastRecords] : [];
    }
}

module.exports = { InteractPlugin };
