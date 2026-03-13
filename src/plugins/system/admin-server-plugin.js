const { BasePlugin } = require('../base-plugin');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

/**
 * 管理面板插件 (Admin Server Plugin)
 * 启动一个本地 Express & Socket.io 服务，用于和 Vue 3 前端通信
 */
class AdminServerPlugin extends BasePlugin {
    constructor(engine) {
        super(engine);
        this.port = 3000;
        this.app = null;
        this.server = null;
        this.io = null;
    }

    onLoad() {}

    onEnable() {
        this.logger.info('AdminServerPlugin', '准备启动本地管理面板服务...');
        this.startServer();
    }

    onDisable() {
        if (this.io) {
            this.io.close();
            this.io = null;
        }
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        this.logger.info('AdminServerPlugin', '本地管理面板服务已停止');
        super.onDisable();
    }

    startServer() {
        this.app = express();
        this.app.use(cors());
        this.app.use(express.json());

        this.server = http.createServer(this.app);
        
        // 初始化 Socket.io
        this.io = new Server(this.server, {
            cors: { origin: '*' }
        });

        this.setupRoutes();
        this.setupSockets();
        this.setupEventForwarding();

        this.server.listen(this.port, () => {
            this.logger.info('AdminServerPlugin', `API 服务已启动在 http://localhost:${this.port}`);
        });
    }

    setupRoutes() {
        // 1. 获取基础状态
        this.app.get('/api/status', (req, res) => {
            res.json({
                success: true,
                data: {
                    user: this.engine.state.user,
                    config: this.engine.state.config,
                    plugins: Array.from(this.engine.pluginManager.plugins.keys()).map(name => ({
                        name,
                        enabled: this.engine.pluginManager.enabledPlugins.has(name)
                    }))
                }
            });
        });

        // 2. 获取或更新配置
        this.app.post('/api/config', (req, res) => {
            const newConfig = req.body;
            if (newConfig && typeof newConfig === 'object') {
                this.engine.store.update(newConfig);
                this.logger.info('AdminServerPlugin', '收到前端配置更新');
                res.json({ success: true, message: '配置已更新' });
            } else {
                res.status(400).json({ success: false, message: '无效的配置数据' });
            }
        });

        // 3. 控制插件启停 (热操作)
        this.app.post('/api/plugins/toggle', (req, res) => {
            const { name, enable } = req.body;
            if (!name) {
                return res.status(400).json({ success: false, message: '未提供插件名称' });
            }

            let ok = false;
            if (enable) {
                ok = this.engine.pluginManager.enable(name) === true;
            } else {
                ok = this.engine.pluginManager.disable(name) === true;
            }

            if (!ok) {
                return res.status(500).json({ success: false, message: `插件 ${enable ? '启用' : '禁用'}失败` });
            }
            return res.json({ success: true, message: `插件已${enable ? '启用' : '禁用'}` });
        });
    }

    setupSockets() {
        this.io.on('connection', (socket) => {
            this.logger.info('AdminServerPlugin', `前端面板已连接: ${socket.id}`);

            // 前端断开连接
            socket.on('disconnect', () => {
                // ...
            });
            
            // 收到前端的主动呼叫请求
            socket.on('call_plugin_method', async (payload, ack) => {
                const { pluginName, method, args } = payload;
                try {
                    const plugin = this.engine.pluginManager.plugins.get(pluginName);
                    if (!plugin || typeof plugin[method] !== 'function') {
                        return ack({ success: false, error: '插件或方法不存在' });
                    }
                    // 调用插件暴露的方法
                    const result = await plugin[method](...(args || []));
                    ack({ success: true, data: result });
                } catch (e) {
                    ack({ success: false, error: e.message });
                }
            });
        });
    }

    // 将 Bot 的核心事件转发给前端
    setupEventForwarding() {
        // 覆写系统的 log 方法以支持实时日志推送到前端
        const originalInfo = this.logger.info;
        const originalWarn = this.logger.warn;

        this.logger.info = (tag, msg, extra = {}) => {
            originalInfo.call(this.logger, tag, msg, extra);
            if (this.io) {
                this.io.emit('log', { level: 'info', tag, msg, extra, time: new Date().toISOString() });
            }
        };

        this.logger.warn = (tag, msg, extra = {}) => {
            originalWarn.call(this.logger, tag, msg, extra);
            if (this.io) {
                this.io.emit('log', { level: 'warn', tag, msg, extra, time: new Date().toISOString() });
            }
        };

        // 监听一些关键事件抛给前端
        this.on('login_success', (user) => {
            if (this.io) this.io.emit('status_update', { user });
        });
        
        // 监听配置更新
        this.on('config_updated', (config) => {
            if (this.io) this.io.emit('config_update', config);
        });
    }
}

module.exports = { AdminServerPlugin };
