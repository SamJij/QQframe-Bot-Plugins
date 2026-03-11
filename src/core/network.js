const WebSocket = require('ws');
const { types } = require('../utils/proto');
const cryptoWasm = require('../utils/crypto-wasm');
const { CONFIG } = require('../config/config');

/**
 * 真实网络引擎 (Network Core)
 * 作为底层基础设施，负责 WebSocket 连接、加解密、心跳保活、协议分发。
 */
class NetworkCore {
    /**
     * @param {import('./engine').BotEngine} engine 
     */
    constructor(engine) {
        this.engine = engine;
        this.ws = null;
        this.clientSeq = 1;
        this.serverSeq = 0;
        this.pendingCallbacks = new Map();
        
        // 绑定事件处理器上下文
        this.handleMessage = this.handleMessage.bind(this);
    }

    /**
     * 连接到游戏服务器
     */
    connect() {
        // 从配置中读取登录 Code，默认留空供测试
        const code = this.engine.state.config.code || '';
        const url = `${CONFIG.serverUrl}?platform=${CONFIG.platform}&os=${CONFIG.os}&ver=${CONFIG.clientVersion}&code=${code}&openID=`;

        this.engine.logger.info('Network', '正在连接到腾讯农场服务器...');

        this.ws = new WebSocket(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
                'Origin': 'https://gate-obt.nqf.qq.com',
            },
        });

        this.ws.binaryType = 'arraybuffer';

        this.ws.on('open', () => {
            this.engine.logger.info('Network', 'WebSocket 连接已建立，准备登录');
            this.engine.eventBus.emit('network_connected');
            this.sendLogin();
        });

        this.ws.on('message', (data) => {
            this.handleMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
        });

        this.ws.on('close', (code, reason) => {
            this.engine.logger.warn('Network', `WebSocket 连接关闭 (code=${code})`);
            this.cleanup('连接关闭');
            this.engine.eventBus.emit('network_disconnected');
            
            // 自动重连逻辑 (延迟 5 秒)
            setTimeout(() => {
                this.engine.logger.info('Network', '尝试自动重连...');
                this.connect();
            }, 5000);
        });

        this.ws.on('error', (err) => {
            this.engine.logger.error('Network', `WebSocket 错误: ${err.message}`);
        });
    }

    /**
     * 清理资源和挂起的请求
     */
    cleanup(reason = '网络清理') {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
            this.ws = null;
        }

        // 拒绝所有未决请求
        for (const [seq, cb] of this.pendingCallbacks.entries()) {
            cb.reject(new Error(`请求已中断: ${reason}`));
        }
        this.pendingCallbacks.clear();
    }

    // ==========================================
    // 发送与接收逻辑
    // ==========================================

    async encodeMsg(serviceName, methodName, bodyBytes, clientSeqValue) {
        let finalBody = bodyBytes || Buffer.alloc(0);
        try {
            // 底层调用 WASM 加密
            finalBody = await cryptoWasm.encryptBuffer(finalBody);
        } catch (e) {
            this.engine.logger.warn('Network', `WASM加密失败: ${e.message}`);
        }

        const msg = types.GateMessage.create({
            meta: {
                service_name: serviceName,
                method_name: methodName,
                message_type: 1,
                client_seq: this.toLong(clientSeqValue),
                server_seq: this.toLong(this.serverSeq),
            },
            body: finalBody,
        });
        return types.GateMessage.encode(msg).finish();
    }

    /**
     * 核心发送接口 (供各种插件调用)
     */
    async sendMsgAsync(serviceName, methodName, bodyBytes, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error(`连接未打开: ${methodName}`));
            }

            const seq = this.clientSeq++;
            
            const timeoutId = setTimeout(() => {
                this.pendingCallbacks.delete(seq);
                reject(new Error(`请求超时: ${methodName} (seq=${seq})`));
            }, timeoutMs);

            this.encodeMsg(serviceName, methodName, bodyBytes, seq).then((encoded) => {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    clearTimeout(timeoutId);
                    return reject(new Error('连接已在加密途中关闭'));
                }

                this.pendingCallbacks.set(seq, { resolve, reject, timeoutId });
                this.ws.send(encoded);
            }).catch(reject);
        });
    }

    handleMessage(buf) {
        try {
            const msg = types.GateMessage.decode(buf);
            const meta = msg.meta;
            if (!meta) return;

            if (meta.server_seq) {
                const seq = this.toNum(meta.server_seq);
                if (seq > this.serverSeq) this.serverSeq = seq;
            }

            // Type 3: Server Notify (服务器推送事件)
            if (meta.message_type === 3) {
                this.handleNotify(msg);
                return;
            }

            // Type 2: Response (请求的响应)
            if (meta.message_type === 2) {
                const errorCode = this.toNum(meta.error_code);
                const clientSeqVal = this.toNum(meta.client_seq);

                const cb = this.pendingCallbacks.get(clientSeqVal);
                if (cb) {
                    this.pendingCallbacks.delete(clientSeqVal);
                    clearTimeout(cb.timeoutId);

                    if (errorCode !== 0) {
                        cb.reject(new Error(`${meta.service_name}.${meta.method_name} 错误: code=${errorCode} ${meta.error_message || ''}`));
                    } else {
                        cb.resolve({ body: msg.body, meta });
                    }
                    return;
                }
            }
        } catch (err) {
            this.engine.logger.warn('Network', `解码回包失败: ${err.message}`);
        }
    }

    handleNotify(msg) {
        if (!msg.body || msg.body.length === 0) return;
        try {
            const event = types.EventMessage.decode(msg.body);
            const type = event.message_type || '';
            const eventBody = event.body;

            // 抛出特定的通知事件到 EventBus，由各插件订阅处理
            // 如: 'server_notify:LandsNotify'
            this.engine.eventBus.emit(`server_notify:${type}`, eventBody);
            
            // 顺便做一个全局模糊抛出，供监听所有推送
            this.engine.eventBus.emit('server_notify', { type, body: eventBody });
        } catch (e) {
            this.engine.logger.warn('Network', `推送解码失败: ${e.message}`);
        }
    }

    // ==========================================
    // 登录与心跳
    // ==========================================

    async sendLogin() {
        const body = types.LoginRequest.encode(types.LoginRequest.create({
            sharer_id: this.toLong(0),
            sharer_open_id: '',
            device_info: {
                client_version: CONFIG.clientVersion,
                sys_software: 'iOS 26.2.1',
                network: 'wifi',
                memory: '7672',
                device_id: 'iPhone X<iPhone18,3>',
            },
            share_cfg_id: this.toLong(0),
            scene_id: '1256',
        })).finish();

        try {
            const { body: replyBody } = await this.sendMsgAsync('gamepb.userpb.UserService', 'Login', body);
            const reply = types.LoginReply.decode(replyBody);
            
            if (reply.basic) {
                this.engine.state.user = {
                    gid: this.toNum(reply.basic.gid),
                    name: reply.basic.name || '未知',
                    level: this.toNum(reply.basic.level),
                    gold: this.toNum(reply.basic.gold),
                    exp: this.toNum(reply.basic.exp),
                };

                this.engine.logger.info('Network', `登录成功: ${this.engine.state.user.name} (Lv${this.engine.state.user.level})`);
                this.engine.eventBus.emit('login_success', this.engine.state.user);
                
                this.startHeartbeat();
            }
        } catch (err) {
            this.engine.logger.error('Network', `登录失败: ${err.message}`);
        }
    }

    startHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        
        // 每 10 秒发送一次心跳
        this.heartbeatTimer = setInterval(async () => {
            if (!this.engine.state.user.gid) return;

            const body = types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
                gid: this.toLong(this.engine.state.user.gid),
                client_version: CONFIG.clientVersion,
            })).finish();

            try {
                await this.sendMsgAsync('gamepb.userpb.UserService', 'Heartbeat', body, 5000);
            } catch (err) {
                this.engine.logger.warn('Network', `心跳超时: ${err.message}`);
            }
        }, CONFIG.heartbeatInterval || 10000);
    }

    // ==========================================
    // Utils (类型转换)
    // ==========================================
    
    toNum(val) {
        if (!val) return 0;
        if (typeof val === 'number') return val;
        if (typeof val.toNumber === 'function') return val.toNumber();
        return Number.parseInt(val, 10) || 0;
    }

    toLong(val) {
        const Long = require('long');
        if (val && typeof val.toNumber === 'function') return val;
        return Long.fromValue(val || 0);
    }
}

module.exports = { NetworkCore };