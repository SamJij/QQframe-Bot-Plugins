const { BasePlugin } = require('../base-plugin');
const { types } = require('../../utils/proto');
const { toNum, sleep, getServerTimeSec } = require('../../utils/utils');

/**
 * 任务签到自动化插件 (Task Auto Plugin)
 * 负责每日活跃任务、成长任务和签到奖励的领取
 */
class TaskPlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        this.checking = false;
        this.lastTaskCheckAt = 0;
        this.taskClaimDoneDateKey = '';
        this.TASK_CHECK_COOLDOWN_MS = 5 * 60 * 1000; // 5分钟内不重复检查相同的数据
    }

    onLoad() {}

    onEnable() {
        this.logger.info('TaskPlugin', '任务签到模块已启动');

        // 1. 登录后延迟一会儿进行首次检查，错开并发请求高峰
        this.on('login_success', () => {
            this.scheduler.setTimeout(() => this.checkAndClaimTasks(), 8000);
        });

        // 2. 监听来自服务器的任务变更推送
        this.on('server_notify:TaskInfoNotify', (eventBody) => {
            const taskInfo = eventBody.task_info;
            if (!taskInfo || !this.engine.state.config.auto_task) return;

            // 分析是否有新完成的任务
            const claimable = [
                ...this.analyzeTaskList(taskInfo.daily_tasks || [], 'daily'),
                ...this.analyzeTaskList(taskInfo.growth_tasks || [], 'growth'),
                ...this.analyzeTaskList(taskInfo.tasks || [], 'main'),
            ];
            const actives = taskInfo.actives || [];

            if (claimable.length > 0) {
                this.logger.info('TaskPlugin', `[推送] 发现 ${claimable.length} 个任务可领取，准备自动领取...`);
            }

            // 防抖，避免连续完成多个任务触发请求风暴
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.debounceTimer = this.scheduler.setTimeout(async () => {
                if (claimable.length > 0) {
                    for (const task of claimable) {
                        await this.doClaim(task);
                    }
                }
                await this.checkAndClaimActives(actives);
                await this.checkAndClaimIllustratedRewards();
            }, 2000);
        });
    }

    onDisable() {
        this.logger.info('TaskPlugin', '任务签到模块已停止');
        this.checking = false;
    }

    // ==========================================
    // 状态判定
    // ==========================================

    getDateKey() {
        const nowSec = getServerTimeSec();
        const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
        const bjDate = new Date(nowMs + 8 * 3600 * 1000);
        return `${bjDate.getUTCFullYear()}-${String(bjDate.getUTCMonth() + 1).padStart(2, '0')}-${String(bjDate.getUTCDate()).padStart(2, '0')}`;
    }

    canCheckTasks() {
        const now = Date.now();
        const currentKey = this.getDateKey();
        if (currentKey !== this.taskClaimDoneDateKey) return true;
        if (now - this.lastTaskCheckAt >= this.TASK_CHECK_COOLDOWN_MS) return true;
        return false;
    }

    // ==========================================
    // 核心领取流程
    // ==========================================

    async checkAndClaimTasks(force = false) {
        if (this.checking) return;
        if (!this.engine.state.config.auto_task) return;
        if (!force && !this.canCheckTasks()) return;

        this.checking = true;
        try {
            // 1. 获取任务数据
            const body = types.TaskInfoRequest.encode(types.TaskInfoRequest.create({})).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.taskpb.TaskService', 'TaskInfo', body);
            const reply = types.TaskInfoReply.decode(replyBody);

            if (!reply.task_info) {
                this.checking = false;
                return;
            }

            const taskInfo = reply.task_info;

            // 提取任务列表
            const dailyAll = this.buildDailyTasksForDebug(taskInfo);
            const dailyClaimable = this.analyzeTaskList(dailyAll, 'daily');
            const growthClaimable = this.analyzeTaskList(taskInfo.growth_tasks || [], 'growth');
            const mainClaimable = this.analyzeTaskList(taskInfo.tasks || [], 'main');

            const claimable = [...dailyClaimable, ...growthClaimable, ...mainClaimable];

            // 2. 领取普通任务
            if (claimable.length > 0) {
                this.logger.info('TaskPlugin', `[轮询] 发现 ${claimable.length} 个可领取任务`);
                for (const task of claimable) {
                    await this.doClaim(task);
                }
            }

            // 3. 领取活跃度宝箱
            await this.checkAndClaimActives(taskInfo.actives || []);

            // 4. 领取图鉴收集奖励
            await this.checkAndClaimIllustratedRewards();

        } catch (e) {
            this.logger.warn('TaskPlugin', `检查任务失败: ${e.message}`);
        } finally {
            this.checking = false;
            this.lastTaskCheckAt = Date.now();
        }
    }

    async doClaim(task) {
        try {
            const useShare = task.shareMultiple > 1;
            const multipleStr = useShare ? ` (${task.shareMultiple}倍)` : '';

            const body = types.ClaimTaskRewardRequest.encode(types.ClaimTaskRewardRequest.create({
                id: this.engine.network.toLong(task.id),
                do_shared: useShare,
            })).finish();
            
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.taskpb.TaskService', 'ClaimTaskReward', body);
            const claimReply = types.ClaimTaskRewardReply.decode(replyBody);
            
            const count = (claimReply.items || []).length;
            const rewardStr = count > 0 ? `获得 ${count} 种奖励` : '无奖励内容';

            const categoryName = task.category === 'daily' ? '每日' : (task.category === 'growth' ? '成长' : '主线');
            this.logger.info('TaskPlugin', `领取 [${categoryName}任务]: ${task.desc}${multipleStr} → ${rewardStr}`);
            
            this.taskClaimDoneDateKey = this.getDateKey();
            await sleep(300);
            return true;
        } catch {
            return false;
        }
    }

    async checkAndClaimActives(actives) {
        const list = Array.isArray(actives) ? actives : [];
        for (const active of list) {
            const activeType = toNum(active.type);
            const rewards = active.rewards || [];
            // status 2 代表已达标但未领取
            const claimable = rewards.filter(r => toNum(r.status) === 2);
            if (!claimable.length) continue;
            
            const pointIds = claimable.map(r => toNum(r.point_id)).filter(n => n > 0);
            if (!pointIds.length) continue;
            
            const typeName = activeType === 1 ? '日活跃宝箱' : (activeType === 2 ? '周活跃宝箱' : `活跃${activeType}宝箱`);
            try {
                const body = types.ClaimDailyRewardRequest.encode(types.ClaimDailyRewardRequest.create({
                    type: Number(activeType) || 0,
                    point_ids: pointIds.map(id => this.engine.network.toLong(id)),
                })).finish();
                
                await this.engine.network.sendMsgAsync('gamepb.taskpb.TaskService', 'ClaimDailyReward', body);
                this.logger.info('TaskPlugin', `成功领取 ${typeName} x${pointIds.length}`);
                await sleep(300);
            } catch (e) {
                this.logger.warn('TaskPlugin', `领取 ${typeName} 失败: ${e.message}`);
            }
        }
    }

    async checkAndClaimIllustratedRewards() {
        if (!types.ClaimAllRewardsV2Request) return false;
        try {
            const body = types.ClaimAllRewardsV2Request.encode(types.ClaimAllRewardsV2Request.create({
                only_claimable: true,
            })).finish();
            
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.illustratedpb.IllustratedService', 'ClaimAllRewardsV2', body);
            const reply = types.ClaimAllRewardsV2Reply.decode(replyBody);
            
            const items = [
                ...(Array.isArray(reply && reply.items) ? reply.items : []),
                ...(Array.isArray(reply && reply.bonus_items) ? reply.bonus_items : []),
            ];
            
            if (items.length > 0) {
                this.logger.info('TaskPlugin', `图鉴收集奖励领取成功, 包含 ${items.length} 种物品`);
                this.taskClaimDoneDateKey = this.getDateKey();
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    // ==========================================
    // 格式化与分析
    // ==========================================

    buildDailyTasksForDebug(taskInfo) {
        const ti = taskInfo && typeof taskInfo === 'object' ? taskInfo : {};
        const dailyList = Array.isArray(ti.daily_tasks) ? ti.daily_tasks : [];
        if (dailyList.length > 0) return dailyList;
        const merged = [
            ...(Array.isArray(ti.tasks) ? ti.tasks : []),
            ...(Array.isArray(ti.growth_tasks) ? ti.growth_tasks : []),
        ];
        return merged.filter((t) => toNum(t && t.task_type) === 2); // 2 表示每日任务
    }

    analyzeTaskList(tasks, category = 'main') {
        const claimable = [];
        for (const task of tasks) {
            const id = toNum(task.id);
            const desc = task.desc || `任务#${id}`;
            const progress = toNum(task.progress);
            const totalProgress = toNum(task.total_progress);
            const isClaimed = task.is_claimed;
            const isUnlocked = task.is_unlocked;
            const shareMultiple = toNum(task.share_multiple);
            
            const canClaim = isUnlocked && !isClaimed && progress >= totalProgress && totalProgress > 0;
            if (canClaim) {
                claimable.push({ id, desc, category, shareMultiple });
            }
        }
        return claimable;
    }
}

module.exports = { TaskPlugin };