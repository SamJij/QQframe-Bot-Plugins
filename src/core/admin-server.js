const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { CONFIG } = require('../config/config');
const { createSecurityManager } = require('./security');
const { normalizeRuntimeLog } = require('../utils/logger');
const { sendWebhookNotification } = require('./push');
const { getPlantRankings } = require('./analytics');

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
        this.engineFactory = null;
        this.accountRegistry = null;
        this.security = createSecurityManager({
            password: CONFIG.adminPassword,
            authRequired: CONFIG.adminAuthRequired,
            tokenTtlSec: CONFIG.adminTokenTtlSec,
        });
        this.maxLogEntries = 2000;
        this.runtimeLogs = [];
        this.accountLogMap = new Map();
        this.accountStatusMap = new Map();

        this.setupRoutes();
        this.setupSockets();
    }

    /**
     * 将账号引擎注册到管理面板
     */
    registerEngine(accountId, engine) {
        const id = String(accountId || '').trim();
        this.engines.set(id, engine);
        this.accountStatusMap.set(id, this.normalizeStatusSnapshot(id).status);

        // 监听引擎的各种状态，实时推送给前端
        engine.eventBus.on('log', (logEntry) => {
            const normalized = normalizeRuntimeLog(logEntry, id);
            this.pushRuntimeLog(id, normalized);
            // 兼容当前实现
            this.io.emit('log', normalized);
            // 对齐原库事件名
            this.io.to(`account:${id}`).emit('log:new', normalized);
            this.io.to('account:all').emit('log:new', normalized);
        });

        engine.eventBus.on('status_sync', (stats) => {
            const payload = this.normalizeStatusSnapshot(id, stats);
            this.accountStatusMap.set(id, payload.status);
            // 兼容当前实现
            this.io.emit('status', payload);
            // 对齐原库事件名
            this.io.to(`account:${id}`).emit('status:update', payload);
            this.io.to('account:all').emit('status:update', payload);
        });
    }

    unregisterEngine(accountId) {
        const id = String(accountId || '').trim();
        this.engines.delete(id);
        this.accountStatusMap.delete(id);
        this.accountLogMap.delete(id);
    }

    setEngineFactory(factory) {
        this.engineFactory = factory;
    }

    setAccountRegistry(registry) {
        this.accountRegistry = registry;
    }

    async createAndStartEngine(accountId, options = {}) {
        const id = String(accountId || '').trim();
        if (!id) throw new Error('无效账号ID');
        if (this.engines.has(id)) return this.engines.get(id);
        if (typeof this.engineFactory !== 'function') {
            throw new Error('engineFactory 未设置');
        }
        const engine = await this.engineFactory(id, options);
        if (!engine) throw new Error('engineFactory 未返回有效引擎');
        this.registerEngine(id, engine);
        await engine.start();
        return engine;
    }

    async stopEngine(accountId) {
        const id = String(accountId || '').trim();
        const engine = this.engines.get(id);
        if (!engine) return false;
        await engine.stop();
        return true;
    }

    async removeEngine(accountId) {
        const id = String(accountId || '').trim();
        const existed = this.engines.has(id);
        if (!existed) return false;
        await this.stopEngine(id);
        this.unregisterEngine(id);
        return true;
    }

    pushRuntimeLog(accountId, entry) {
        const id = String(accountId || '').trim();
        const log = normalizeRuntimeLog(entry, id);
        this.runtimeLogs.push(log);
        if (this.runtimeLogs.length > this.maxLogEntries) {
            this.runtimeLogs.splice(0, this.runtimeLogs.length - this.maxLogEntries);
        }

        const list = this.accountLogMap.get(id) || [];
        list.push(log);
        if (list.length > this.maxLogEntries) {
            list.splice(0, list.length - this.maxLogEntries);
        }
        this.accountLogMap.set(id, list);
        return log;
    }

    normalizeStatusSnapshot(accountId, incoming = null) {
        const id = String(accountId || '').trim();
        const engine = this.engines.get(id);
        const base = incoming && typeof incoming === 'object' ? incoming : {};
        const user = engine && engine.state && engine.state.user ? engine.state.user : {};
        const config = engine && engine.state && engine.state.config ? engine.state.config : {};
        return {
            accountId: id,
            status: {
                time: Date.now(),
                connected: !!(engine && engine.network && engine.network.ws && engine.network.ws.readyState === 1),
                name: user.name || '',
                level: Number(user.level || 0),
                exp: Number(user.exp || 0),
                gold: Number(user.gold || 0),
                coupon: Number(user.coupon || 0),
                couponKnown: !!user.couponKnown,
                configVersion: Number(config.version || 0),
                ...base,
            },
        };
    }

    getStatusSnapshot(accountId) {
        const id = String(accountId || '').trim();
        const cached = this.accountStatusMap.get(id);
        if (cached && typeof cached === 'object') {
            return { accountId: id, status: { ...cached } };
        }
        return this.normalizeStatusSnapshot(id);
    }

    parseTime(v) {
        if (v === undefined || v === null || v === '') return 0;
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
        const t = Date.parse(String(v));
        return Number.isFinite(t) ? t : 0;
    }

    parseBool(v) {
        if (typeof v === 'boolean') return v;
        const s = String(v || '').trim().toLowerCase();
        if (!s) return null;
        if (s === '1' || s === 'true' || s === 'yes') return true;
        if (s === '0' || s === 'false' || s === 'no') return false;
        return null;
    }

    getLogs(accountId = '', query = {}) {
        const id = String(accountId || '').trim();
        let rows = id ? (this.accountLogMap.get(id) || []) : this.runtimeLogs;

        const levelWarn = this.parseBool(query.isWarn);
        const tag = String(query.tag || query.module || '').trim().toLowerCase();
        const event = String(query.event || '').trim().toLowerCase();
        const keyword = String(query.keyword || '').trim().toLowerCase();
        const timeFrom = this.parseTime(query.timeFrom);
        const timeTo = this.parseTime(query.timeTo);

        rows = rows.filter((x) => {
            if (levelWarn === true && x.level !== 'warn' && x.level !== 'error') return false;
            if (levelWarn === false && (x.level === 'warn' || x.level === 'error')) return false;
            if (tag && !String(x.tag || '').toLowerCase().includes(tag)) return false;
            if (event && !String(x.event || '').toLowerCase().includes(event)) return false;
            if (keyword) {
                const text = `${x.message || ''} ${JSON.stringify(x.extra || {})}`.toLowerCase();
                if (!text.includes(keyword)) return false;
            }
            if (timeFrom > 0 && Number(x.time || 0) < timeFrom) return false;
            if (timeTo > 0 && Number(x.time || 0) > timeTo) return false;
            return true;
        });

        const limit = Math.max(1, Math.min(2000, Number.parseInt(query.limit, 10) || 100));
        if (rows.length <= limit) return [...rows];
        return rows.slice(rows.length - limit);
    }

    clearLogs(accountId = '') {
        const id = String(accountId || '').trim();
        if (!id) {
            const removed = this.runtimeLogs.length;
            this.runtimeLogs = [];
            this.accountLogMap.clear();
            return { removed };
        }
        const removed = (this.accountLogMap.get(id) || []).length;
        this.accountLogMap.set(id, []);
        this.runtimeLogs = this.runtimeLogs.filter((x) => String(x.accountId || '') !== id);
        return { removed };
    }

    setupRoutes() {
        // 登录接口（不走 token 校验）
        this.app.post('/api/login', (req, res) => {
            const password = req && req.body ? req.body.password : '';
            const result = this.security.login(password);
            if (!result.ok) {
                return res.status(401).json({ code: 401, message: '账号或密码错误' });
            }
            res.json({
                code: 0,
                data: {
                    token: result.token,
                    expiresIn: result.expiresIn,
                    expireAt: result.expireAt,
                },
                message: '登录成功',
            });
        });

        // 管理端 API 鉴权（排除登录接口）
        this.app.use('/api', (req, res, next) => {
            if (!this.security.isEnabled()) return next();
            const path = String(req.path || '');
            if (path === '/login' || path === '/auth/validate') return next();
            const token = this.security.extractTokenFromRequest(req);
            if (!this.security.verifyToken(token)) {
                return res.status(401).json({ code: 401, message: '未授权或 token 已过期' });
            }
            return next();
        });

        // 鉴权状态校验（兼容原库前端路由守卫）
        this.app.get('/api/auth/validate', (req, res) => {
            if (!this.security.isEnabled()) {
                return res.json({ ok: true, data: { valid: true, passwordDisabled: true } });
            }
            const token = this.security.extractTokenFromRequest(req);
            const valid = this.security.verifyToken(token);
            if (!valid) {
                return res.status(401).json({ ok: false, data: { valid: false }, error: 'Unauthorized' });
            }
            return res.json({ ok: true, data: { valid: true, passwordDisabled: false } });
        });

        // 登出并主动断开该 token 的 socket
        this.app.post('/api/logout', (req, res) => {
            const token = this.security.extractTokenFromRequest(req);
            if (this.security.isEnabled() && token) {
                this.security.revokeToken(token);
                for (const socket of this.io.sockets.sockets.values()) {
                    if (String(socket.data && socket.data.adminToken || '') === String(token)) {
                        socket.disconnect(true);
                    }
                }
            }
            return res.json({ code: 0, message: '退出成功' });
        });

        // 获取运行状态快照（兼容原库接口）
        this.app.get('/api/status', (req, res) => {
            const accountId = String((req.headers['x-account-id'] || req.query.accountId || '')).trim();
            if (!accountId) {
                return res.status(400).json({ code: 400, message: '缺少账号ID（x-account-id 或 accountId）' });
            }
            const data = this.getStatusSnapshot(accountId);
            return res.json({ code: 0, data });
        });

        // 获取账号状态快照（当前项目接口）
        this.app.get('/api/accounts/:id/status', (req, res) => {
            const accountId = String(req.params.id || '').trim();
            if (!accountId) return res.status(400).json({ code: 400, message: '无效账号ID' });
            const data = this.getStatusSnapshot(accountId);
            return res.json({ code: 0, data });
        });

        // 作物分析（按账号）
        this.app.get('/api/accounts/:id/analytics', (req, res) => {
            try {
                const accountId = String(req.params.id || '').trim();
                if (!accountId) return res.status(400).json({ code: 400, message: '无效账号ID' });
                const engine = this.engines.get(accountId);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });

                const q = req.query || {};
                const sort = String(q.sort || 'exp').trim().toLowerCase();
                const minRequiredLevel = Number(q.minRequiredLevel || 0);
                const maxRequiredLevel = Number(q.maxRequiredLevel || 0);
                const limit = Number(q.limit || 100);
                const availableOnly = String(q.availableOnly || '').trim() === '1'
                    || String(q.availableOnly || '').trim().toLowerCase() === 'true';
                const userLevel = Number(engine.state && engine.state.user && engine.state.user.level || 0);

                const rows = getPlantRankings({
                    sort,
                    minRequiredLevel,
                    maxRequiredLevel,
                    availableOnly,
                    availableLevel: userLevel,
                    limit,
                });

                return res.json({
                    code: 0,
                    data: {
                        sort,
                        accountId,
                        userLevel,
                        total: rows.length,
                        rows,
                    },
                });
            } catch (e) {
                return res.status(500).json({ code: 500, message: `分析失败: ${e.message}` });
            }
        });

        // 作物分析（兼容原库：x-account-id）
        this.app.get('/api/analytics', (req, res) => {
            const accountId = String((req.headers['x-account-id'] || req.query.accountId || '')).trim();
            if (!accountId) {
                return res.status(400).json({ code: 400, message: '缺少账号ID（x-account-id 或 accountId）' });
            }
            try {
                const engine = this.engines.get(accountId);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });

                const q = req.query || {};
                const sort = String(q.sort || 'exp').trim().toLowerCase();
                const minRequiredLevel = Number(q.minRequiredLevel || 0);
                const maxRequiredLevel = Number(q.maxRequiredLevel || 0);
                const limit = Number(q.limit || 100);
                const availableOnly = String(q.availableOnly || '').trim() === '1'
                    || String(q.availableOnly || '').trim().toLowerCase() === 'true';
                const userLevel = Number(engine.state && engine.state.user && engine.state.user.level || 0);

                const rows = getPlantRankings({
                    sort,
                    minRequiredLevel,
                    maxRequiredLevel,
                    availableOnly,
                    availableLevel: userLevel,
                    limit,
                });

                return res.json({
                    code: 0,
                    data: {
                        sort,
                        accountId,
                        userLevel,
                        total: rows.length,
                        rows,
                    },
                });
            } catch (e) {
                return res.status(500).json({ code: 500, message: `分析失败: ${e.message}` });
            }
        });

        // 查询运行日志（支持按账号筛选）
        this.app.get('/api/logs', (req, res) => {
            const accountId = String((req.query.accountId || req.headers['x-account-id'] || '')).trim();
            const data = this.getLogs(accountId, req.query || {});
            return res.json({ code: 0, data });
        });

        // 查询特定账号日志
        this.app.get('/api/accounts/:id/logs', (req, res) => {
            const accountId = String(req.params.id || '').trim();
            if (!accountId) return res.status(400).json({ code: 400, message: '无效账号ID' });
            const data = this.getLogs(accountId, req.query || {});
            return res.json({ code: 0, data });
        });

        // 清空特定账号日志
        this.app.delete('/api/accounts/:id/logs', (req, res) => {
            const accountId = String(req.params.id || '').trim();
            if (!accountId) return res.status(400).json({ code: 400, message: '无效账号ID' });
            const data = this.clearLogs(accountId);
            const accountLogs = this.getLogs(accountId, { limit: 100 });
            const allLogs = this.getLogs('', { limit: 100 });
            this.io.to(`account:${accountId}`).emit('logs:snapshot', { accountId, logs: accountLogs });
            this.io.to('account:all').emit('logs:snapshot', { accountId: 'all', logs: allLogs });
            return res.json({ code: 0, data, message: '日志已清空' });
        });

        // 清空日志（按账号）
        this.app.delete('/api/logs', (req, res) => {
            const accountId = String((req.query.accountId || req.headers['x-account-id'] || '')).trim();
            if (!accountId) {
                return res.status(400).json({ code: 400, message: '缺少账号ID（x-account-id 或 accountId）' });
            }
            const data = this.clearLogs(accountId);
            const accountLogs = this.getLogs(accountId, { limit: 100 });
            const allLogs = this.getLogs('', { limit: 100 });
            this.io.to(`account:${accountId}`).emit('logs:snapshot', { accountId, logs: accountLogs });
            this.io.to('account:all').emit('logs:snapshot', { accountId: 'all', logs: allLogs });
            return res.json({ code: 0, data, message: '日志已清空' });
        });

        // 获取所有运行中的账号状态
        this.app.get('/api/accounts', (req, res) => {
            const accounts = [];
            const persisted = this.accountRegistry && typeof this.accountRegistry.list === 'function'
                ? this.accountRegistry.list()
                : [];

            if (persisted.length > 0) {
                for (const acc of persisted) {
                    const engine = this.engines.get(acc.id);
                    accounts.push({
                        id: acc.id,
                        name: (engine && engine.state.user.name) || acc.name || '未登录',
                        running: !!engine,
                        level: engine ? (engine.state.user.level || 0) : 0,
                        gold: engine ? (engine.state.user.gold || 0) : 0,
                        enabled: acc.enabled !== false,
                        config: engine ? engine.state.config : (acc.config || {}),
                    });
                }
            } else {
                for (const [id, engine] of this.engines.entries()) {
                    accounts.push({
                        id,
                        name: engine.state.user.name || '未登录',
                        running: true,
                        level: engine.state.user.level || 0,
                        gold: engine.state.user.gold || 0,
                        enabled: true,
                        config: engine.state.config,
                    });
                }
            }
            res.json({ code: 0, data: accounts });
        });

        // 新增账号
        this.app.post('/api/accounts', async (req, res) => {
            try {
                if (!this.accountRegistry) {
                    return res.status(500).json({ code: 500, message: '账号注册表未初始化' });
                }
                const body = req.body && typeof req.body === 'object' ? req.body : {};
                const created = this.accountRegistry.create({
                    id: body.id,
                    name: body.name,
                    enabled: body.enabled !== false,
                    config: body.config || {},
                });
                if (created.enabled !== false) {
                    await this.createAndStartEngine(created.id, { config: created.config || {} });
                }
                res.json({ code: 0, data: created, message: '账号创建成功' });
            } catch (e) {
                res.status(500).json({ code: 500, message: `创建账号失败: ${e.message}` });
            }
        });

        // 删除账号
        this.app.delete('/api/accounts/:id', async (req, res) => {
            try {
                const id = String(req.params.id || '').trim();
                if (!id) return res.status(400).json({ code: 400, message: '无效账号ID' });
                await this.removeEngine(id);
                if (this.accountRegistry) {
                    this.accountRegistry.remove(id);
                }
                res.json({ code: 0, message: '账号删除成功' });
            } catch (e) {
                res.status(500).json({ code: 500, message: `删除账号失败: ${e.message}` });
            }
        });

        // 启动账号
        this.app.post('/api/accounts/:id/start', async (req, res) => {
            try {
                const id = String(req.params.id || '').trim();
                if (!id) return res.status(400).json({ code: 400, message: '无效账号ID' });
                let cfg = {};
                if (this.accountRegistry) {
                    const acc = this.accountRegistry.get(id);
                    if (!acc) return res.status(404).json({ code: 404, message: '账号不存在' });
                    cfg = acc.config || {};
                    this.accountRegistry.update(id, { enabled: true });
                }
                await this.createAndStartEngine(id, { config: cfg });
                res.json({ code: 0, message: '账号启动成功' });
            } catch (e) {
                res.status(500).json({ code: 500, message: `启动账号失败: ${e.message}` });
            }
        });

        // 停止账号
        this.app.post('/api/accounts/:id/stop', async (req, res) => {
            try {
                const id = String(req.params.id || '').trim();
                if (!id) return res.status(400).json({ code: 400, message: '无效账号ID' });
                const stopped = await this.stopEngine(id);
                if (this.accountRegistry) {
                    this.accountRegistry.update(id, { enabled: false });
                }
                if (!stopped) {
                    return res.status(404).json({ code: 404, message: '账号未运行' });
                }
                this.unregisterEngine(id);
                res.json({ code: 0, message: '账号停止成功' });
            } catch (e) {
                res.status(500).json({ code: 500, message: `停止账号失败: ${e.message}` });
            }
        });

        // 重启账号
        this.app.post('/api/accounts/:id/restart', async (req, res) => {
            try {
                const id = String(req.params.id || '').trim();
                if (!id) return res.status(400).json({ code: 400, message: '无效账号ID' });
                let cfg = {};
                if (this.accountRegistry) {
                    const acc = this.accountRegistry.get(id);
                    if (!acc) return res.status(404).json({ code: 404, message: '账号不存在' });
                    cfg = acc.config || {};
                    this.accountRegistry.update(id, { enabled: true });
                }
                await this.removeEngine(id);
                await this.createAndStartEngine(id, { config: cfg });
                res.json({ code: 0, message: '账号重启成功' });
            } catch (e) {
                res.status(500).json({ code: 500, message: `重启账号失败: ${e.message}` });
            }
        });

        // 获取特定账号的配置
        this.app.get('/api/accounts/:id/config', (req, res) => {
            const engine = this.engines.get(req.params.id);
            if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
            res.json({ code: 0, data: engine.state.config });
        });

        // 获取统一设置（白名单字段）
        this.app.get('/api/accounts/:id/settings', (req, res) => {
            const engine = this.engines.get(req.params.id);
            if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
            if (!engine.store || typeof engine.store.getSettings !== 'function') {
                return res.status(500).json({ code: 500, message: '当前账号不支持设置接口' });
            }
            res.json({ code: 0, data: engine.store.getSettings() });
        });

        // 更新特定账号配置
        this.app.post('/api/accounts/:id/config', (req, res) => {
            const engine = this.engines.get(req.params.id);
            if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
            
            // 使用 store.update 会触发 config_updated 事件，插件自动应用
            engine.store.update(req.body);
            res.json({ code: 0, message: '配置已更新' });
        });

        // 保存统一设置（白名单字段）
        this.app.post('/api/accounts/:id/settings/save', (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                if (!engine.store || typeof engine.store.saveSettings !== 'function') {
                    return res.status(500).json({ code: 500, message: '当前账号不支持设置保存接口' });
                }
                const data = engine.store.saveSettings(req.body);
                res.json({ code: 0, data, message: '设置已保存' });
            } catch (e) {
                res.status(500).json({ code: 500, message: `保存设置失败: ${e.message}` });
            }
        });

        // 获取离线提醒配置（Webhook 第一阶段）
        this.app.get('/api/accounts/:id/offline-reminder', (req, res) => {
            const engine = this.engines.get(req.params.id);
            if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
            const data = this.getOfflineReminderFromConfig(engine.state.config || {});
            return res.json({ code: 0, data });
        });

        // 保存离线提醒配置（Webhook 第一阶段）
        this.app.post('/api/accounts/:id/offline-reminder/save', (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                const body = (req.body && typeof req.body === 'object') ? req.body : {};
                const next = this.getOfflineReminderFromConfig(body);
                engine.store.update(next);
                return res.json({ code: 0, data: next, message: '离线提醒配置已保存' });
            } catch (e) {
                return res.status(500).json({ code: 500, message: `保存离线提醒配置失败: ${e.message}` });
            }
        });

        // 测试发送离线提醒（用于联调 webhook）
        this.app.post('/api/accounts/:id/offline-reminder/test', async (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                const cfg = this.getOfflineReminderFromConfig(engine.state.config || {});
                if (!cfg.offline_webhook_endpoint) {
                    return res.status(400).json({ code: 400, message: '未配置 webhook 地址' });
                }
                const userName = String(engine.state.user && engine.state.user.name || req.params.id || '').trim();
                const content = `${cfg.offline_reminder_msg}\n账号: ${userName}\n账号ID: ${req.params.id}\n断线码: TEST`;
                const result = await sendWebhookNotification({
                    endpoint: cfg.offline_webhook_endpoint,
                    token: cfg.offline_webhook_token,
                    title: cfg.offline_reminder_title,
                    content,
                    accountId: String(req.params.id || ''),
                    accountName: userName,
                    timeoutMs: 10000,
                });
                return res.json({ code: 0, data: result, message: '测试消息已发送' });
            } catch (e) {
                return res.status(500).json({ code: 500, message: `测试发送失败: ${e.message}` });
            }
        });

        // 热重载特定插件
        this.app.post('/api/accounts/:id/reload', (req, res) => {
            const engine = this.engines.get(req.params.id);
            if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
            
            const { pluginPath } = req.body;
            if (!pluginPath) return res.status(400).json({ code: 400, message: '未提供 pluginPath' });

            if (!engine.pluginManager || typeof engine.pluginManager.validateReloadPath !== 'function') {
                return res.status(500).json({ code: 500, message: '插件管理器不支持路径校验' });
            }
            const check = engine.pluginManager.validateReloadPath(pluginPath);
            if (!check.ok) {
                return res.status(400).json({ code: 400, message: check.error || 'pluginPath 非法' });
            }

            const success = engine.pluginManager.reload(pluginPath) === true;
            if (success) {
                res.json({ code: 0, message: '插件热重载成功' });
            } else {
                res.status(500).json({ code: 500, message: '热重载失败，详情见后台日志' });
            }
        });

        // 获取插件运行时诊断信息（用于热重载回归验证）
        this.app.get('/api/accounts/:id/plugins/:name/diagnostics', (req, res) => {
            const engine = this.engines.get(req.params.id);
            if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
            if (!engine.pluginManager || typeof engine.pluginManager.getPluginDiagnostics !== 'function') {
                return res.status(500).json({ code: 500, message: '插件管理器不支持诊断接口' });
            }
            const pluginName = String(req.params.name || '').trim();
            if (!pluginName) return res.status(400).json({ code: 400, message: '无效插件名' });

            const data = engine.pluginManager.getPluginDiagnostics(pluginName);
            if (!data) return res.status(404).json({ code: 404, message: '插件不存在或未注册' });
            return res.json({ code: 0, data });
        });

        // 获取背包完整数据
        this.app.get('/api/accounts/:id/bag', async (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                const warehousePlugin = this.getPlugin(engine, 'WarehousePlugin');
                if (!warehousePlugin || typeof warehousePlugin.getBagSnapshot !== 'function') {
                    return res.status(404).json({ code: 404, message: 'WarehousePlugin 未启用或不支持该接口' });
                }
                const data = await warehousePlugin.getBagSnapshot();
                res.json({ code: 0, data });
            } catch (e) {
                res.status(500).json({ code: 500, message: `获取背包失败: ${e.message}` });
            }
        });

        // 获取背包种子列表
        this.app.get('/api/accounts/:id/bag/seeds', async (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                const warehousePlugin = this.getPlugin(engine, 'WarehousePlugin');
                if (!warehousePlugin || typeof warehousePlugin.getBagSeeds !== 'function') {
                    return res.status(404).json({ code: 404, message: 'WarehousePlugin 未启用或不支持该接口' });
                }
                const data = await warehousePlugin.getBagSeeds();
                res.json({ code: 0, data });
            } catch (e) {
                res.status(500).json({ code: 500, message: `获取背包种子失败: ${e.message}` });
            }
        });

        // 获取商店可用种子列表
        this.app.get('/api/accounts/:id/seeds', async (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                const farmPlugin = this.getPlugin(engine, 'FarmPlugin');
                if (!farmPlugin || typeof farmPlugin.getAvailableSeeds !== 'function') {
                    return res.status(404).json({ code: 404, message: 'FarmPlugin 未启用或不支持该接口' });
                }
                const data = await farmPlugin.getAvailableSeeds();
                res.json({ code: 0, data });
            } catch (e) {
                res.status(500).json({ code: 500, message: `获取种子列表失败: ${e.message}` });
            }
        });

        // 获取好友列表概要
        this.app.get('/api/accounts/:id/friends', async (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                const friendPlugin = this.getPlugin(engine, 'FriendPlugin');
                if (!friendPlugin || typeof friendPlugin.getFriendsSummary !== 'function') {
                    return res.status(404).json({ code: 404, message: 'FriendPlugin 未启用或不支持该接口' });
                }
                const data = await friendPlugin.getFriendsSummary();
                res.json({ code: 0, data });
            } catch (e) {
                res.status(500).json({ code: 500, message: `获取好友列表失败: ${e.message}` });
            }
        });

        // 获取指定好友地块
        this.app.get('/api/accounts/:id/friend/:gid/lands', async (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                const friendPlugin = this.getPlugin(engine, 'FriendPlugin');
                if (!friendPlugin || typeof friendPlugin.getFriendLands !== 'function') {
                    return res.status(404).json({ code: 404, message: 'FriendPlugin 未启用或不支持该接口' });
                }
                const data = await friendPlugin.getFriendLands(req.params.gid);
                res.json({ code: 0, data });
            } catch (e) {
                res.status(500).json({ code: 500, message: `获取好友地块失败: ${e.message}` });
            }
        });

        // 对指定好友执行操作
        this.app.post('/api/accounts/:id/friend/:gid/op', async (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                const friendPlugin = this.getPlugin(engine, 'FriendPlugin');
                if (!friendPlugin || typeof friendPlugin.doFriendOp !== 'function') {
                    return res.status(404).json({ code: 404, message: 'FriendPlugin 未启用或不支持该接口' });
                }
                const op = req.body && req.body.op;
                const data = await friendPlugin.doFriendOp(req.params.gid, op);
                res.json({ code: 0, data });
            } catch (e) {
                res.status(500).json({ code: 500, message: `好友操作失败: ${e.message}` });
            }
        });

        // 获取好友黑名单
        this.app.get('/api/accounts/:id/friend-blacklist', (req, res) => {
            const engine = this.engines.get(req.params.id);
            if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
            const list = this.normalizeGidList(engine.state.config && engine.state.config.friend_blacklist);
            res.json({ code: 0, data: list });
        });

        // 切换好友黑名单状态
        this.app.post('/api/accounts/:id/friend-blacklist/toggle', (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                const gid = this.toNum(req.body && req.body.gid);
                if (gid <= 0) return res.status(400).json({ code: 400, message: '无效 gid' });

                const current = this.normalizeGidList(engine.state.config && engine.state.config.friend_blacklist);
                const set = new Set(current);
                if (set.has(gid)) set.delete(gid);
                else set.add(gid);
                const next = this.normalizeGidList([...set]);
                engine.store.update({ friend_blacklist: next });
                res.json({ code: 0, data: next });
            } catch (e) {
                res.status(500).json({ code: 500, message: `更新黑名单失败: ${e.message}` });
            }
        });

        // 获取好友缓存
        this.app.get('/api/accounts/:id/friend-cache', (req, res) => {
            const engine = this.engines.get(req.params.id);
            if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
            const list = this.normalizeGidList(engine.state.config && engine.state.config.friend_cache);
            res.json({ code: 0, data: list });
        });

        // 手动导入好友缓存 GID 列表
        this.app.post('/api/accounts/:id/friend-cache/import-gids', (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                const incoming = this.normalizeGidList(req.body && req.body.gids);
                const current = this.normalizeGidList(engine.state.config && engine.state.config.friend_cache);
                const merged = this.normalizeGidList([...current, ...incoming]);
                engine.store.update({ friend_cache: merged });
                res.json({ code: 0, data: merged });
            } catch (e) {
                res.status(500).json({ code: 500, message: `导入好友缓存失败: ${e.message}` });
            }
        });

        // 从访客记录更新好友缓存
        this.app.post('/api/accounts/:id/friend-cache/update-from-visitors', async (req, res) => {
            try {
                const engine = this.engines.get(req.params.id);
                if (!engine) return res.status(404).json({ code: 404, message: '账号未找到' });
                const interactPlugin = this.getPlugin(engine, 'InteractPlugin');
                if (!interactPlugin || typeof interactPlugin.getLatestFriendGids !== 'function') {
                    return res.status(404).json({ code: 404, message: 'InteractPlugin 未启用或不支持该接口' });
                }

                const visitorGids = this.normalizeGidList(interactPlugin.getLatestFriendGids());
                const current = this.normalizeGidList(engine.state.config && engine.state.config.friend_cache);
                const merged = this.normalizeGidList([...current, ...visitorGids]);
                engine.store.update({ friend_cache: merged });
                res.json({
                    code: 0,
                    data: {
                        added: Math.max(0, merged.length - current.length),
                        total: merged.length,
                        visitors: visitorGids.length,
                        gids: merged,
                    }
                });
            } catch (e) {
                res.status(500).json({ code: 500, message: `访客更新好友缓存失败: ${e.message}` });
            }
        });
    }

    getPlugin(engine, pluginName) {
        if (!engine || !engine.pluginManager || !engine.pluginManager.plugins) return null;
        return engine.pluginManager.plugins.get(pluginName) || null;
    }

    toNum(val) {
        if (!val) return 0;
        if (typeof val === 'number') return val;
        if (typeof val.toNumber === 'function') return val.toNumber();
        return Number.parseInt(val, 10) || 0;
    }

    normalizeGidList(input) {
        const source = Array.isArray(input) ? input : [];
        const seen = new Set();
        const result = [];
        for (const x of source) {
            const gid = this.toNum(x);
            if (gid <= 0) continue;
            if (seen.has(gid)) continue;
            seen.add(gid);
            result.push(gid);
        }
        return result;
    }

    getOfflineReminderFromConfig(config = {}) {
        const cfg = (config && typeof config === 'object') ? config : {};
        return {
            auto_offline_reminder: !!cfg.auto_offline_reminder,
            offline_webhook_endpoint: String(cfg.offline_webhook_endpoint || ''),
            offline_webhook_token: String(cfg.offline_webhook_token || ''),
            offline_reminder_title: String(cfg.offline_reminder_title || '账号离线提醒'),
            offline_reminder_msg: String(cfg.offline_reminder_msg || '检测到账号离线，请尽快检查。'),
            offline_reminder_cooldown_sec: Math.max(30, Number(cfg.offline_reminder_cooldown_sec || 300)),
        };
    }

    applySocketSubscription(socket, accountRef = '') {
        const input = String(accountRef || '').trim();
        const accountId = input && input !== 'all' ? input : '';
        for (const room of socket.rooms) {
            if (String(room).startsWith('account:')) socket.leave(room);
        }
        if (accountId) {
            socket.join(`account:${accountId}`);
            socket.data.accountId = accountId;
        } else {
            socket.join('account:all');
            socket.data.accountId = '';
        }
        socket.emit('subscribed', { accountId: socket.data.accountId || 'all' });

        const targetId = socket.data.accountId || '';
        if (targetId) {
            socket.emit('status:update', this.getStatusSnapshot(targetId));
        }
        socket.emit('logs:snapshot', {
            accountId: targetId || 'all',
            logs: this.getLogs(targetId, { limit: 100 }),
        });
    }

    setupSockets() {
        if (this.security.isEnabled()) {
            this.io.use((socket, next) => {
                const token = this.security.extractTokenFromSocket(socket);
                if (!this.security.verifyToken(token)) {
                    return next(new Error('unauthorized'));
                }
                // 保存当前连接关联的管理端 token，供 logout 踢线使用
                socket.data.adminToken = token;
                return next();
            });
        }

        this.io.on('connection', (socket) => {
            console.log(`[Admin] 前端面板已连接: ${socket.id}`);
            const initialAccountRef = (socket.handshake.auth && socket.handshake.auth.accountId)
                || (socket.handshake.query && socket.handshake.query.accountId)
                || '';
            this.applySocketSubscription(socket, initialAccountRef);
            socket.emit('ready', { ok: true, ts: Date.now() });

            socket.on('subscribe', (payload) => {
                const body = (payload && typeof payload === 'object') ? payload : {};
                this.applySocketSubscription(socket, body.accountId || '');
            });

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
