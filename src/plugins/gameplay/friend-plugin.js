const { BasePlugin } = require('../base-plugin');
const { types } = require('../../utils/proto');
const { toNum, sleep, getServerTimeSec } = require('../../utils/utils');
const { getPlantName } = require('../../config/gameConfig');

/**
 * 好友自动化插件 (Friend Auto Plugin)
 * 负责自动轮询好友列表、偷菜、帮忙(除草/虫/水)和捣乱
 */
class FriendPlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        this.isChecking = false;
        // 定时轮询间隔 (默认15秒检查一次)
        this.checkIntervalMs = 15000;
        
        // 每日限制缓存
        this.operationLimits = new Map();
        this.canGetHelpExp = true;
        this.helpAutoDisabledByLimit = false;
        this.limitStateDateKey = '';

        // 本地黑名单 (原项目放在 store 里，这里简单作为内部状态)
        this.blacklist = new Set();
        this.lastQuietHoursWarnAt = 0;
    }

    onLoad() {}

    onEnable() {
        this.logger.info('FriendPlugin', '好友自动化模块已启动');
        this.reloadBlacklistFromConfig(this.engine.state.config, true);

        this.on('login_success', () => {
            this.scheduler.setTimeout(() => this.startCheckLoop(), 5000);
        });

        // 配置更新后实时刷新黑名单
        this.on('config_updated', (cfg) => {
            this.reloadBlacklistFromConfig(cfg, false);
        });

        // 监听服务器下发的每日操作限制更新
        this.on('server_notify:BasicNotify', (notify) => {
            // (如果需要在这里截获某些限制信息)
        });
    }

    onDisable() {
        this.logger.info('FriendPlugin', '好友自动化模块已停止');
        this.isChecking = false;
        super.onDisable();
    }

    // ==========================================
    // 核心循环
    // ==========================================

    startCheckLoop() {
        this.checkFriends();
        this.scheduler.setInterval(async () => {
            if (this.isChecking) return;
            await this.checkFriends();
        }, this.checkIntervalMs);
    }

    async checkFriends() {
        this.ensureDailyLimitState();

        // 先检查配置开关
        const config = this.engine.state.config;
        if (!config.auto_friend_steal && !config.auto_friend_help && !config.auto_friend_bad) {
            this.logger.info('FriendPlugin', '好友巡查跳过：相关功能均未开启');
            return;
        }

        // 安静时段内不执行好友相关操作
        if (this.isInQuietHours(config.friend_quiet_hours)) {
            this.logger.info('FriendPlugin', '好友巡查跳过：当前处于安静时段');
            return;
        }

        if (this.isChecking) return;
        this.isChecking = true;

        try {
            // 1. 获取好友列表
            const friendsReply = await this.getAllFriends();
            this.updateOperationLimits(friendsReply && friendsReply.operation_limits);
            const friends = friendsReply.game_friends || [];
            
            if (friends.length === 0) return;

            const myGid = this.engine.state.user.gid;
            const priorityFriends = [];

            // 2. 筛选可以拜访的好友
            for (const f of friends) {
                const gid = toNum(f.gid);
                if (gid === myGid || gid === 0) continue;
                if (this.blacklist.has(gid)) continue;
                
                const name = f.remark || f.name || `GID:${gid}`;
                if (name === '小小农夫') continue; // 过滤官方 NPC

                const p = f.plant;
                if (!p) continue;

                const stealNum = toNum(p.steal_plant_num);
                const dryNum = toNum(p.dry_num);
                const weedNum = toNum(p.weed_num);
                const insectNum = toNum(p.insect_num);

                const hasSteal = config.auto_friend_steal && stealNum > 0;
                const hasHelp = config.auto_friend_help && this.canGetHelpExp && (dryNum > 0 || weedNum > 0 || insectNum > 0);
                const hasBad = config.auto_friend_bad && (dryNum > 0 || weedNum > 0 || insectNum > 0 || stealNum > 0);
                
                if (hasSteal || hasHelp || hasBad) {
                    priorityFriends.push({
                        gid, name, stealNum, dryNum, weedNum, insectNum
                    });
                }
            }

            if (priorityFriends.length === 0) return;

            // 3. 排序：优先偷菜多的，其次需要帮助多的
            priorityFriends.sort((a, b) => {
                if (b.stealNum !== a.stealNum) return b.stealNum - a.stealNum;
                const helpA = a.dryNum + a.weedNum + a.insectNum;
                const helpB = b.dryNum + b.weedNum + b.insectNum;
                return helpB - helpA;
            });

            // 4. 逐个拜访
            let visitedCount = 0;
            const totalActions = { steal: 0, helpWeed: 0, helpBug: 0, helpWater: 0 };

            // 每次循环最多访问 10 个人，防止过度发包
            const targets = priorityFriends.slice(0, 10);
            
            for (const friend of targets) {
                const acted = await this.visitFriend(friend, totalActions, config);
                visitedCount++;
                if (acted) {
                    // 每次拜访后等待，避免被风控踢出
                    await sleep(300);
                }
            }

            // 5. 汇总日志
            const summary = [];
            if (totalActions.steal > 0) summary.push(`偷${totalActions.steal}`);
            if (totalActions.helpWeed > 0) summary.push(`除草${totalActions.helpWeed}`);
            if (totalActions.helpBug > 0) summary.push(`除虫${totalActions.helpBug}`);
            if (totalActions.helpWater > 0) summary.push(`浇水${totalActions.helpWater}`);

            if (summary.length > 0) {
                this.logger.info('好友', `巡查 ${visitedCount} 人 → ${summary.join('/')}`);
                
                // 偷菜后触发仓库出售
                if (totalActions.steal > 0) {
                    this.emit('farm_harvested', { count: totalActions.steal }); // 复用这个事件让 Warehouse 去卖
                }
            }

        } catch (err) {
            this.logger.warn('FriendPlugin', `巡查好友失败: ${err.message}`);
        } finally {
            this.isChecking = false;
        }
    }

    parseHHmmToMinute(text) {
        const raw = String(text || '').trim();
        const m = raw.match(/^(\d{1,2}):(\d{1,2})$/);
        if (!m) return -1;
        const hh = Number.parseInt(m[1], 10);
        const mm = Number.parseInt(m[2], 10);
        if (!Number.isFinite(hh) || !Number.isFinite(mm)) return -1;
        if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return -1;
        return hh * 60 + mm;
    }

    getDateKey() {
        const nowSec = getServerTimeSec();
        const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
        const bjDate = new Date(nowMs + 8 * 3600 * 1000);
        return `${bjDate.getUTCFullYear()}-${String(bjDate.getUTCMonth() + 1).padStart(2, '0')}-${String(bjDate.getUTCDate()).padStart(2, '0')}`;
    }

    ensureDailyLimitState() {
        const today = this.getDateKey();
        if (this.limitStateDateKey === today) return;
        this.limitStateDateKey = today;
        this.operationLimits.clear();
        this.canGetHelpExp = true;
        this.helpAutoDisabledByLimit = false;
    }

    getServerMinuteOfDay() {
        const nowSec = getServerTimeSec();
        const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
        const bjDate = new Date(nowMs + 8 * 3600 * 1000);
        return bjDate.getUTCHours() * 60 + bjDate.getUTCMinutes();
    }

    isInQuietHours(quietCfg) {
        const cfg = quietCfg && typeof quietCfg === 'object' ? quietCfg : {};
        if (!cfg.enabled) return false;

        const start = this.parseHHmmToMinute(cfg.start);
        const end = this.parseHHmmToMinute(cfg.end);
        if (start < 0 || end < 0) {
            const now = Date.now();
            // 配置异常时每 10 分钟最多告警一次，避免刷屏。
            if (now - this.lastQuietHoursWarnAt > 10 * 60 * 1000) {
                this.lastQuietHoursWarnAt = now;
                this.logger.warn('FriendPlugin', `friend_quiet_hours 配置无效，已忽略: start=${cfg.start}, end=${cfg.end}`);
            }
            return false;
        }

        const nowMinute = this.getServerMinuteOfDay();
        if (start === end) {
            // start=end 视为全天安静。
            return true;
        }

        if (start < end) {
            // 同日时段，如 01:00-07:00
            return nowMinute >= start && nowMinute < end;
        }
        // 跨天时段，如 23:00-07:00
        return nowMinute >= start || nowMinute < end;
    }

    async visitFriend(friend, totalActions, config) {
        const { gid, name } = friend;
        let actions = [];

        try {
            // 进入农场
            const enterReply = await this.enterFriendFarm(gid);
            const lands = enterReply.lands || [];
            
            if (lands.length === 0) {
                await this.leaveFriendFarm(gid);
                return false;
            }

            // 分析土地
            const status = this.analyzeFriendLands(lands, this.engine.state.user.gid);

            // 1. 偷菜
            if (config.auto_friend_steal && status.stealable.length > 0) {
                try {
                    const canSteal = await this.precheckCanOperate(gid, 10004);
                    if (canSteal) {
                        await this.stealHarvest(gid, status.stealable);
                        actions.push(`偷${status.stealable.length}`);
                        totalActions.steal += status.stealable.length;
                    } else {
                        this.logger.info('好友', `${name}: 偷菜跳过（今日次数不足或服务端限制）`);
                    }
                } catch (e) {
                    this.logger.warn('好友', `${name}: 偷菜失败: ${e.message}`);
                }
            }

            // 2. 帮忙
            if (config.auto_friend_help && this.canGetHelpExp) {
                if (status.needWeed.length > 0) {
                    try {
                        const canHelpWeed = await this.precheckCanOperate(gid, 10003);
                        if (canHelpWeed) {
                            await this.helpWeed(gid, status.needWeed);
                            actions.push(`草${status.needWeed.length}`);
                            totalActions.helpWeed += status.needWeed.length;
                        }
                    } catch (e) {
                        this.logger.warn('好友', `${name}: 帮忙除草失败: ${e.message}`);
                    }
                }
                if (status.needBug.length > 0) {
                    try {
                        const canHelpBug = await this.precheckCanOperate(gid, 10002);
                        if (canHelpBug) {
                            await this.helpInsecticide(gid, status.needBug);
                            actions.push(`虫${status.needBug.length}`);
                            totalActions.helpBug += status.needBug.length;
                        }
                    } catch (e) {
                        this.logger.warn('好友', `${name}: 帮忙除虫失败: ${e.message}`);
                    }
                }
                if (status.needWater.length > 0) {
                    try {
                        const canHelpWater = await this.precheckCanOperate(gid, 10001);
                        if (canHelpWater) {
                            await this.helpWater(gid, status.needWater);
                            actions.push(`水${status.needWater.length}`);
                            totalActions.helpWater += status.needWater.length;
                        }
                    } catch (e) {
                        this.logger.warn('好友', `${name}: 帮忙浇水失败: ${e.message}`);
                    }
                }
            }
            if (config.auto_friend_help && !this.canGetHelpExp) {
                this.logger.info('好友', `${name}: 帮忙跳过（今日帮忙经验已达上限）`);
            }

            // 3. 捣乱（放虫/放草）
            if (config.auto_friend_bad && status.badTarget.length > 0) {
                const targetLand = status.badTarget[0];
                try {
                    const canPutInsects = await this.precheckCanOperate(gid, 10005);
                    if (canPutInsects) {
                        await this.putInsects(gid, [targetLand]);
                        actions.push('放虫1');
                    }
                } catch (e) {
                    this.logger.warn('好友', `${name}: 放虫失败: ${e.message}`);
                }
                try {
                    const canPutWeeds = await this.precheckCanOperate(gid, 10006);
                    if (canPutWeeds) {
                        await this.putWeeds(gid, [targetLand]);
                        actions.push('放草1');
                    }
                } catch (e) {
                    this.logger.warn('好友', `${name}: 放草失败: ${e.message}`);
                }
            }

            if (actions.length > 0) {
                this.logger.info('好友', `${name}: ${actions.join('/')}`);
            }

            // 离开农场
            await this.leaveFriendFarm(gid);
            return actions.length > 0;

        } catch (e) {
            // 处理风控(被禁止进入农场等)
            const msg = String(e.message || '');
            if (msg.includes('1002003')) {
                this.logger.warn('好友', `被拦截，已将 ${name}(${gid}) 加入防风控黑名单`);
                this.addToBlacklistAndPersist(gid);
            }
            return false;
        }
    }

    normalizeBlacklist(input) {
        const source = Array.isArray(input) ? input : [];
        const result = [];
        const seen = new Set();
        for (const x of source) {
            const gid = toNum(x);
            if (gid <= 0) continue;
            if (seen.has(gid)) continue;
            seen.add(gid);
            result.push(gid);
        }
        return result;
    }

    reloadBlacklistFromConfig(cfg, fromInit = false) {
        const nextList = this.normalizeBlacklist(cfg && cfg.friend_blacklist);
        this.blacklist = new Set(nextList);
        const src = fromInit ? '初始化' : '配置更新';
        this.logger.info('FriendPlugin', `${src}黑名单完成，当前 ${nextList.length} 人`);
    }

    addToBlacklistAndPersist(gid) {
        const target = toNum(gid);
        if (target <= 0) return;
        if (this.blacklist.has(target)) return;
        this.blacklist.add(target);

        const merged = this.normalizeBlacklist([...this.blacklist]);
        this.engine.store.update({ friend_blacklist: merged });
        this.logger.info('FriendPlugin', `黑名单已持久化，新增 GID=${target}，当前 ${merged.length} 人`);
    }

    // ==========================================
    // 协议与接口
    // ==========================================

    async getAllFriends() {
        const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
        return types.GetAllFriendsReply.decode(replyBody);
    }

    async getFriendsSummary() {
        const reply = await this.getAllFriends();
        const list = Array.isArray(reply && reply.game_friends) ? reply.game_friends : [];
        return list.map((f) => {
            const gid = toNum(f.gid);
            const plant = f.plant || {};
            return {
                gid,
                name: f.remark || f.name || `GID:${gid}`,
                level: toNum(f.level),
                stealPlantNum: toNum(plant.steal_plant_num),
                dryNum: toNum(plant.dry_num),
                weedNum: toNum(plant.weed_num),
                insectNum: toNum(plant.insect_num),
                inBlacklist: this.blacklist.has(gid),
            };
        });
    }

    summarizeLands(lands) {
        const list = Array.isArray(lands) ? lands : [];
        return list.map((land) => {
            const id = toNum(land && land.id);
            const unlocked = !!(land && land.unlocked);
            const plant = land && land.plant ? land.plant : null;
            const hasPlant = !!(plant && Array.isArray(plant.phases) && plant.phases.length > 0);
            const stealable = !!(plant && plant.stealable);
            const dryNum = toNum(plant && plant.dry_num);
            const weedNum = Array.isArray(plant && plant.weed_owners) ? plant.weed_owners.length : 0;
            const insectNum = Array.isArray(plant && plant.insect_owners) ? plant.insect_owners.length : 0;
            return {
                id,
                unlocked,
                hasPlant,
                stealable,
                dryNum,
                weedNum,
                insectNum,
            };
        });
    }

    async getFriendLands(friendGid) {
        const gid = toNum(friendGid);
        if (gid <= 0) throw new Error('无效好友GID');
        const enterReply = await this.enterFriendFarm(gid);
        const lands = Array.isArray(enterReply && enterReply.lands) ? enterReply.lands : [];
        await this.leaveFriendFarm(gid);
        return {
            gid,
            lands: this.summarizeLands(lands),
        };
    }

    async doFriendOp(friendGid, op) {
        const gid = toNum(friendGid);
        const opType = String(op || '').trim().toLowerCase();
        if (gid <= 0) throw new Error('无效好友GID');
        if (!['steal', 'help', 'bad'].includes(opType)) {
            throw new Error('不支持的好友操作类型');
        }

        const enterReply = await this.enterFriendFarm(gid);
        const lands = Array.isArray(enterReply && enterReply.lands) ? enterReply.lands : [];
        const status = this.analyzeFriendLands(lands, this.engine.state.user.gid);

        const result = {
            gid,
            op: opType,
            steal: 0,
            helpWeed: 0,
            helpBug: 0,
            helpWater: 0,
            badInsects: 0,
            badWeeds: 0,
        };

        try {
            if (opType === 'steal') {
                if (status.stealable.length > 0) {
                    const canSteal = await this.precheckCanOperate(gid, 10004);
                    if (canSteal) {
                        await this.stealHarvest(gid, status.stealable);
                        result.steal = status.stealable.length;
                    }
                }
            } else if (opType === 'help') {
                if (status.needWeed.length > 0) {
                    const canHelpWeed = await this.precheckCanOperate(gid, 10003);
                    if (canHelpWeed) {
                        await this.helpWeed(gid, status.needWeed);
                        result.helpWeed = status.needWeed.length;
                    }
                }
                if (status.needBug.length > 0) {
                    const canHelpBug = await this.precheckCanOperate(gid, 10002);
                    if (canHelpBug) {
                        await this.helpInsecticide(gid, status.needBug);
                        result.helpBug = status.needBug.length;
                    }
                }
                if (status.needWater.length > 0) {
                    const canHelpWater = await this.precheckCanOperate(gid, 10001);
                    if (canHelpWater) {
                        await this.helpWater(gid, status.needWater);
                        result.helpWater = status.needWater.length;
                    }
                }
            } else if (opType === 'bad') {
                if (status.badTarget.length > 0) {
                    const targetLand = status.badTarget[0];
                    const canPutInsects = await this.precheckCanOperate(gid, 10005);
                    if (canPutInsects) {
                        await this.putInsects(gid, [targetLand]);
                        result.badInsects = 1;
                    }
                    const canPutWeeds = await this.precheckCanOperate(gid, 10006);
                    if (canPutWeeds) {
                        await this.putWeeds(gid, [targetLand]);
                        result.badWeeds = 1;
                    }
                }
            }
        } finally {
            await this.leaveFriendFarm(gid);
        }

        return result;
    }

    async precheckCanOperate(friendGid, operationId) {
        try {
            if (!types.CheckCanOperateRequest || !types.CheckCanOperateReply) return true;
            const body = types.CheckCanOperateRequest.encode(types.CheckCanOperateRequest.create({
                host_gid: this.engine.network.toLong(friendGid),
                operation_id: this.engine.network.toLong(operationId),
            })).finish();
            const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'CheckCanOperate', body);
            const reply = types.CheckCanOperateReply.decode(replyBody);
            return !!(reply && reply.can_operate);
        } catch {
            // 预检查失败不阻断主流程，回退到直接请求。
            return true;
        }
    }

    async enterFriendFarm(friendGid) {
        const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
            host_gid: this.engine.network.toLong(friendGid),
            reason: 2,
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body);
        return types.VisitEnterReply.decode(replyBody);
    }

    async leaveFriendFarm(friendGid) {
        const body = types.VisitLeaveRequest.encode(types.VisitLeaveRequest.create({
            host_gid: this.engine.network.toLong(friendGid),
        })).finish();
        try {
            await this.engine.network.sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', body);
        } catch { /* 离开失败不影响主流程 */ }
    }

    async stealHarvest(friendGid, landIds) {
        const body = types.HarvestRequest.encode(types.HarvestRequest.create({
            land_ids: landIds.map(id => this.engine.network.toLong(id)),
            host_gid: this.engine.network.toLong(friendGid),
            is_all: true,
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
        const reply = types.HarvestReply.decode(replyBody);
        this.updateOperationLimits(reply && reply.operation_limits);
        return reply;
    }

    async helpWater(friendGid, landIds) {
        const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
            land_ids: landIds.map(id => this.engine.network.toLong(id)),
            host_gid: this.engine.network.toLong(friendGid),
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
        const reply = types.WaterLandReply.decode(replyBody);
        this.updateOperationLimits(reply && reply.operation_limits);
    }

    async helpWeed(friendGid, landIds) {
        const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({
            land_ids: landIds.map(id => this.engine.network.toLong(id)),
            host_gid: this.engine.network.toLong(friendGid),
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
        const reply = types.WeedOutReply.decode(replyBody);
        this.updateOperationLimits(reply && reply.operation_limits);
    }

    async helpInsecticide(friendGid, landIds) {
        const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({
            land_ids: landIds.map(id => this.engine.network.toLong(id)),
            host_gid: this.engine.network.toLong(friendGid),
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
        const reply = types.InsecticideReply.decode(replyBody);
        this.updateOperationLimits(reply && reply.operation_limits);
    }

    async putInsects(friendGid, landIds) {
        const body = types.PutInsectsRequest.encode(types.PutInsectsRequest.create({
            host_gid: this.engine.network.toLong(friendGid),
            land_ids: landIds.map(id => this.engine.network.toLong(id)),
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'PutInsects', body);
        const reply = types.PutInsectsReply.decode(replyBody);
        this.updateOperationLimits(reply && reply.operation_limits);
    }

    async putWeeds(friendGid, landIds) {
        const body = types.PutWeedsRequest.encode(types.PutWeedsRequest.create({
            host_gid: this.engine.network.toLong(friendGid),
            land_ids: landIds.map(id => this.engine.network.toLong(id)),
        })).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'PutWeeds', body);
        const reply = types.PutWeedsReply.decode(replyBody);
        this.updateOperationLimits(reply && reply.operation_limits);
    }

    updateOperationLimits(limits) {
        const list = Array.isArray(limits) ? limits : [];
        for (const row of list) {
            const id = toNum(row && row.id);
            if (id <= 0) continue;
            this.operationLimits.set(id, {
                dayTimes: toNum(row && row.day_times),
                dayTimesLt: toNum(row && row.day_times_lt),
                dayExpTimes: toNum(row && row.day_exp_times),
                dayExTimesLt: toNum(row && row.day_ex_times_lt),
            });
        }
        this.refreshHelpExpLimit();
    }

    refreshHelpExpLimit() {
        const helpIds = [10001, 10002, 10003];
        let hasKnown = false;
        let allLimited = true;

        for (const id of helpIds) {
            const row = this.operationLimits.get(id);
            if (!row) {
                allLimited = false;
                continue;
            }
            const lt = toNum(row.dayExTimesLt);
            const used = toNum(row.dayExpTimes);
            if (lt <= 0) {
                allLimited = false;
                continue;
            }
            hasKnown = true;
            if (used < lt) {
                allLimited = false;
            }
        }

        const nextCanHelp = !(hasKnown && allLimited);
        if (this.canGetHelpExp !== nextCanHelp) {
            this.canGetHelpExp = nextCanHelp;
            if (!nextCanHelp && !this.helpAutoDisabledByLimit) {
                this.helpAutoDisabledByLimit = true;
                this.logger.info('好友', '检测到帮忙经验已达每日上限，今日自动帮忙将暂停');
            }
            if (nextCanHelp) {
                this.helpAutoDisabledByLimit = false;
                this.logger.info('好友', '帮忙经验上限状态已恢复，自动帮忙重新启用');
            }
        }
    }

    // ==========================================
    // 辅助分析逻辑
    // ==========================================

    analyzeFriendLands(lands, myGid) {
        const result = {
            stealable: [], needWater: [], needWeed: [], needBug: [],
            badTarget: [],
        };
        const nowSec = getServerTimeSec();

        for (const land of lands) {
            const id = toNum(land.id);
            const plant = land.plant;

            if (!plant || !plant.phases || plant.phases.length === 0) continue;

            let currentPhase = plant.phases[0];
            for (let i = plant.phases.length - 1; i >= 0; i--) {
                const bt = toNum(plant.phases[i].begin_time);
                if (bt > 0 && bt <= nowSec) {
                    currentPhase = plant.phases[i];
                    break;
                }
            }

            const phaseVal = currentPhase.phase;

            // 如果是成熟期且可偷
            if (phaseVal === 4) { // MATURE
                if (plant.stealable) {
                    result.stealable.push(id);
                }
                continue;
            }

            if (phaseVal === 5) continue; // DEAD

            // 非成熟/非枯萎阶段可作为捣乱目标。
            result.badTarget.push(id);

            // 帮忙操作
            if (toNum(plant.dry_num) > 0) result.needWater.push(id);
            if (plant.weed_owners && plant.weed_owners.length > 0) result.needWeed.push(id);
            if (plant.insect_owners && plant.insect_owners.length > 0) result.needBug.push(id);
        }

        return result;
    }
}

module.exports = { FriendPlugin };
