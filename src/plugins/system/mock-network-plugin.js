const { BasePlugin } = require('../base-plugin');

/**
 * 模拟网络层插件 (Mock Network Plugin)
 * 供开发、测试时模拟游戏服务器的回包。
 */
class MockNetworkPlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        // 初始化序列号
        this.clientSeq = 1;
        this.serverSeq = 0;
        // 挂载网络接口到引擎
        this.engine.network = this;
    }

    onEnable() {
        this.logger.info('MockNetwork', '模拟网络插件已启动');
        
        // 模拟连接成功，2秒后触发登录
        this.scheduler.setTimeout(() => {
            this.logger.info('MockNetwork', 'WebSocket (Mock) 连接成功');
            this.emit('network_connected');
            this._mockLogin();
        }, 2000);
    }

    onDisable() {
        this.logger.info('MockNetwork', '模拟网络插件已停止');
        this.engine.network = null;
        super.onDisable();
    }

    // ==========================================
    // 供其他插件调用的核心通信接口
    // ==========================================

    /**
     * 发送 Protobuf 请求 (异步)
     * @param {String} serviceName 服务名 (如 gamepb.plantpb.PlantService)
     * @param {String} methodName 方法名 (如 AllLands)
     * @param {Buffer} bodyBytes 编码后的字节流
     * @returns {Promise<{body: Buffer, meta: Object}>}
     */
    async sendMsgAsync(serviceName, methodName, bodyBytes, timeoutMs = 10000) {
        this.logger.info('MockNetwork', `[-> 发送] ${serviceName}.${methodName} (seq: ${this.clientSeq})`);
        const seq = this.clientSeq++;

        // 模拟网络延迟 (50ms - 200ms)
        const delay = Math.floor(Math.random() * 150) + 50;
        
        return new Promise((resolve, reject) => {
            this.scheduler.setTimeout(() => {
                // 根据请求路由到对应的 mock 处理函数
                const handlerName = `_mock_${methodName}`;
                if (typeof this[handlerName] === 'function') {
                    try {
                        const replyBody = this[handlerName](bodyBytes);
                        this.logger.info('MockNetwork', `[<- 接收] ${serviceName}.${methodName} 成功`);
                        resolve({
                            body: replyBody,
                            meta: { client_seq: seq, server_seq: ++this.serverSeq }
                        });
                    } catch (e) {
                        this.logger.error('MockNetwork', `[<- 错误] ${methodName} 序列化失败: ${e.message}`);
                        reject(new Error(`[Mock] ${methodName} 失败`));
                    }
                } else {
                    this.logger.warn('MockNetwork', `[<- 未实现] 尚未实现 ${methodName} 的 Mock 数据`);
                    // 未实现的接口返回空 Buffer，防止业务逻辑报错阻塞
                    resolve({ body: Buffer.alloc(0), meta: { client_seq: seq } });
                }
            }, delay);
        });
    }

    // ==========================================
    // MOCK 数据生成器 (路由映射)
    // ==========================================

    _mockLogin() {
        // 模拟登录成功后的状态更新
        this.engine.state.user = {
            gid: 10001,
            name: '测试农夫(Mock)',
            level: 15,
            gold: 50000,
            exp: 12000,
            coupon: 100
        };
        this.logger.info('MockNetwork', `登录成功: ${this.engine.state.user.name}`);
        this.emit('login_success', this.engine.state.user);

        // 模拟服务器推送 (LandsNotify - 土地状态变化)
        this.scheduler.setInterval(() => {
            this.logger.info('MockNetwork', '[-> 推送] 模拟服务器下发 LandsNotify');
            this.emit('server_notify:LandsNotify', {
                host_gid: 10001,
                lands: [
                    { id: 1, status: 'harvestable' } // 假装一块地成熟了
                ]
            });
        }, 30000); // 每 30 秒推送一次
    }

    _mock_AllLands(reqBody) {
        // 从 src/utils/proto.js 中加载类型
        const { types } = require('../../utils/proto');
        
        // 构造一个模拟的土地列表
        const mockLands = [];
        for (let i = 1; i <= 18; i++) {
            const isUnlocked = i <= 12; // 前 12 块地解锁
            mockLands.push({
                id: i,
                level: 1,
                unlocked: isUnlocked,
                plant: isUnlocked ? {
                    id: 20001, // 草莓
                    name: '草莓',
                    phases: [
                        { phase: 4, begin_time: Math.floor(Date.now() / 1000) - 3600 } // 成熟期
                    ]
                } : null
            });
        }

        return types.AllLandsReply.encode(types.AllLandsReply.create({
            lands: mockLands,
            operation_limits: []
        })).finish();
    }

    _mock_Harvest(reqBody) {
        const { types } = require('../../utils/proto');
        return types.HarvestReply.encode(types.HarvestReply.create({
            land: [] // 返回空数组代表收获成功（或者你可以加上收获掉落）
        })).finish();
    }
}

module.exports = { MockNetworkPlugin };
