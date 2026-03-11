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

        // 本地黑名单 (原项目放在 store 里，这里简单作为内部状态)
        this.blacklist = new Set();
    }

    onLoad() {}

    onEnable() {
        this.logger.info('FriendPlugin', '好友自动化模块已启动');

        this.on('login_success', () => {
            this.scheduler.setTimeout(() => this.startCheckLoop(), 5000);
        });

        // 监听服务器下发的每日操作限制更新
        this.on('server_notify:BasicNotify', (notify) => {
            // (如果需要在这里截获某些限制信息)
        });
    }

    onDisable() {
        this.logger.info('FriendPlugin', '好友自动化模块已停止');
        this.isChecking = false;
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
        // 先检查配置开关
        const config = this.engine.state.config;
        if (!config.auto_friend_steal && !config.auto_friend_help && !config.auto_friend_bad) {
            return;
        }

        if (this.isChecking) return;
        this.isChecking = true;

        try {
            // 1. 获取好友列表
            const friendsReply = await this.getAllFriends();
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
                const hasHelp = config.auto_friend_help && (dryNum > 0 || weedNum > 0 || insectNum > 0);
                
                if (hasSteal || hasHelp) {
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
                    await this.stealHarvest(gid, status.stealable);
                    actions.push(`偷${status.stealable.length}`);
                    totalActions.steal += status.stealable.length;
                } catch (e) {
                    // 单次偷菜失败可忽略
                }
            }

            // 2. 帮忙
            if (config.auto_friend_help) {
                if (status.needWeed.length > 0) {
                    try {
                        await this.helpWeed(gid, status.needWeed);
                        actions.push(`草${status.needWeed.length}`);
                        totalActions.helpWeed += status.needWeed.length;
                    } catch(e) {}
                }
                if (status.needBug.length > 0) {
                    try {
                        await this.helpInsecticide(gid, status.needBug);
                        actions.push(`虫${status.needBug.length}`);
                        totalActions.helpBug += status.needBug.length;
                    } catch(e) {}
                }
                if (status.needWater.length > 0) {
                    try {
                        await this.helpWater(gid, status.needWater);
                        actions.push(`水${status.needWater.length}`);
                        totalActions.helpWater += status.needWater.length;
                    } catch(e) {}
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
                this.blacklist.add(gid);
            }
            return false;
        }
    }

    // ==========================================
    // 协议与接口
    // ==========================================

    async getAllFriends() {
        const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
        const { body: replyBody } = await this.engine.network.sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
        return types.GetAllFriendsReply.decode(replyBody);
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
        return types.HarvestReply.decode(replyBody);
    }

    async helpWater(friendGid, landIds) {
        const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
            land_ids: landIds.map(id => this.engine.network.toLong(id)),
            host_gid: this.engine.network.toLong(friendGid),
        })).finish();
        await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
    }

    async helpWeed(friendGid, landIds) {
        const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({
            land_ids: landIds.map(id => this.engine.network.toLong(id)),
            host_gid: this.engine.network.toLong(friendGid),
        })).finish();
        await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
    }

    async helpInsecticide(friendGid, landIds) {
        const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({
            land_ids: landIds.map(id => this.engine.network.toLong(id)),
            host_gid: this.engine.network.toLong(friendGid),
        })).finish();
        await this.engine.network.sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
    }

    // ==========================================
    // 辅助分析逻辑
    // ==========================================

    analyzeFriendLands(lands, myGid) {
        const result = {
            stealable: [], needWater: [], needWeed: [], needBug: [],
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

            // 帮忙操作
            if (toNum(plant.dry_num) > 0) result.needWater.push(id);
            if (plant.weed_owners && plant.weed_owners.length > 0) result.needWeed.push(id);
            if (plant.insect_owners && plant.insect_owners.length > 0) result.needBug.push(id);
        }

        return result;
    }
}

module.exports = { FriendPlugin };