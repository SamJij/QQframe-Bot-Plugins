const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

/**
 * 集中管理和控制后台面板通信的服务器
 * 负责提供 REST API 和 WebSocket 双向推送
 */
class AdminServer {
    constructor(port = 8888) {
        this.port = port;
        this.app = express();
        this.server = http.createServer(this.app);
        
        // 允许跨域，方便前端 Vue 项目在 dev 模式下连接
        this.app.use(cors());
        this.app.use(express.json());

        this.io = new Server(this.server, {
            cors: {
                origin: '*',
                methods: ['GET', 'POST']
            }
        });

        // 存储多账号引擎实例
        this.engines = new Map();

        this.setupRoutes();
        this.setupSockets();
    }

    /**
     * 将账号引擎注册到管理面板
     */
    registerEngine(accountId, engine) {
        this.engines.set(accountId, engine);

        // 监听引擎的各种状态，实时推送给前端
        engine.eventBus.on('log', (logEntry) => {
            this.io.emit('log', { accountId, ...logEntry });
        });

        engine.eventBus.on('status_sync', (stats) => {
            this.io.emit('status', { accountId, ...stats });
        });
    }

    setupRoutes() {
        // 获取所有运行中的账号状态
        this.app.get('/api/accounts', (req, res) => {
            const accounts = [];
            for (const [id, engine] of this.engines.entries()) {
                accounts.push({
                    id,
                    name: engine.state.user.name || '未登录',
                    level: engine.state.user.level || 0,
                    gold: engine.state.user.gold || 0,
                    config: engine.state.config
                });
            }
            res.json({ code: 0, data: accounts });
        });

        // 获取特定账号的配置
        this.app.get('/api/accounts/:id/config', (req, res) => {
            const engine = this.engines.get(req.params.id);
            if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
            res.json({ code: 0, data: engine.state.config });
        });

        // 更新特定账号配置
        this.app.post('/api/accounts/:id/config', (req, res) => {
            const engine = this.engines.get(req.params.id);
            if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
            
            // 使用 store.update 会触发 config_updated 事件，插件自动应用
            engine.store.update(req.body);
            res.json({ code: 0, message: '配置已更新' });
        });

        // 热重载特定插件
        this.app.post('/api/accounts/:id/reload', (req, res) => {
            const engine = this.engines.get(req.params.id);
            if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
            
            const { pluginPath } = req.body;
            if (!pluginPath) return res.status(400).json({ code: 400, message: '未提供 pluginPath' });

            const success = engine.pluginManager.reload(pluginPath);
            if (success) {
                res.json({ code: 0, message: '插件热重载成功' });
            } else {
                res.status(500).json({ code: 500, message: '热重载失败，详情见后台日志' });
            }
        });
    }

    setupSockets() {
        this.io.on('connection', (socket) => {
            console.log(`[Admin] 前端面板已连接: ${socket.id}`);
            
            socket.on('disconnect', () => {
                console.log(`[Admin] 前端面板断开连接: ${socket.id}`);
            });
        });
    }

    start() {
        this.server.listen(this.port, () => {
            console.log(`\n================================`);
            console.log(`[AdminServer] 后台管理面板已启动，监听端口: ${this.port}`);
            console.log(`================================\n`);
        });
    }
}

module.exports = { AdminServer };