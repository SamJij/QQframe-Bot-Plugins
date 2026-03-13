const { EventBus } = require('./event-bus');
const { PluginManager } = require('./plugin-manager');
const { NetworkCore } = require('./network');
const { StoreManager } = require('./store/store-manager');
const { sendWebhookNotification } = require('./push');

/**
 * 机器人引擎 (Bot Engine)
 * 组合各种核心模块，为插件提供运行环境。
 * 每个 QQ 农场账号可以对应一个独立的 Engine 实例。
 */
class BotEngine {
    constructor(options = {}) {
        this.options = options;
        this.accountId = options.accountId || 'default';
        
        // 简易日志输出器 (抛出日志事件供 AdminServer 捕获)
        this.logger = {
            info: (tag, msg, extra = {}) => {
                console.log(`[INFO][${tag}] ${msg}`);
                this.eventBus.emit('log', { level: 'info', tag, msg, message: msg, extra, time: Date.now() });
            },
            warn: (tag, msg, extra = {}) => {
                console.warn(`[WARN][${tag}] ${msg}`);
                this.eventBus.emit('log', { level: 'warn', tag, msg, message: msg, extra, time: Date.now() });
            },
            error: (tag, msg, extra = {}) => {
                console.error(`[ERROR][${tag}] ${msg}`);
                this.eventBus.emit('log', { level: 'error', tag, msg, message: msg, extra, time: Date.now() });
            }
        };

        // 1. 初始化事件总线
        this.eventBus = new EventBus();
        
        // 2. 初始化状态与本地持久化 Store
        this.state = {
            user: { gid: 0, name: '', level: 0, gold: 0, exp: 0, coupon: 0, couponKnown: false },
            config: {} // config 会被 StoreManager 覆盖
        };
        this.store = new StoreManager(this, this.accountId);
        
        // 合并实例化时传进来的临时配置 (如有)
        if (options.config) {
            this.store.update(options.config);
        }

        // 3. 初始化插件管理器
        this.pluginManager = new PluginManager(this);

        // 4. 初始化底层网络引擎
        if (!options.mockNetwork) {
            this.network = new NetworkCore(this);
        } else {
            this.network = null;
        }
        
        this.scheduler = null;
        this.offlineNotifyState = {
            lastSentAt: 0,
            sending: false,
        };

        // 统一处理断线提醒，避免散落在多个模块重复判断。
        this.eventBus.on('network_disconnected', (detail) => {
            this.handleOfflineReminder(detail).catch((e) => {
                this.logger.warn('OfflineReminder', `离线提醒发送异常: ${e.message}`);
            });
        });
    }

    /**
     * 启动引擎
     */
    async start() {
        this.logger.info('Engine', `引擎启动中... [账号ID: ${this.accountId}]`);
        
        if (this.network && typeof this.network.connect === 'function') {
            this.network.connect();
        }

        this.pluginManager.enableAll();
        
        this.logger.info('Engine', '引擎启动完毕');
        this.eventBus.emit('engine_started');
    }

    /**
     * 停止引擎
     */
    async stop() {
        this.logger.info('Engine', '引擎停止中...');
        this.pluginManager.disableAll();
        if (this.network) {
            this.network.cleanup('引擎停止');
        }
        this.logger.info('Engine', '引擎已完全停止');
        this.eventBus.emit('engine_stopped');
    }

    async handleOfflineReminder(detail = {}) {
        const cfg = this.state && this.state.config ? this.state.config : {};
        if (!cfg.auto_offline_reminder) return;

        const endpoint = String(cfg.offline_webhook_endpoint || '').trim();
        if (!endpoint) {
            this.logger.warn('OfflineReminder', '已启用离线提醒，但未配置 webhook 地址');
            return;
        }

        const cooldownSec = Math.max(30, Number(cfg.offline_reminder_cooldown_sec || 300));
        const now = Date.now();
        if (now - Number(this.offlineNotifyState.lastSentAt || 0) < cooldownSec * 1000) {
            return;
        }
        if (this.offlineNotifyState.sending) return;

        const accountName = String(this.state.user && this.state.user.name || this.accountId || '').trim();
        const closeCode = Number(detail.code || 0);
        const closeReason = String(detail.reason || '').trim();
        const title = String(cfg.offline_reminder_title || '账号离线提醒').trim();
        const content = String(cfg.offline_reminder_msg || '检测到账号离线，请尽快检查。').trim();
        const message = `${content}\n账号: ${accountName}\n账号ID: ${this.accountId}\n断线码: ${closeCode || '未知'}${closeReason ? `\n原因: ${closeReason}` : ''}`;

        this.offlineNotifyState.sending = true;
        try {
            await sendWebhookNotification({
                endpoint,
                token: String(cfg.offline_webhook_token || '').trim(),
                title,
                content: message,
                accountId: this.accountId,
                accountName,
                timeoutMs: 10000,
            });
            this.offlineNotifyState.lastSentAt = now;
            this.logger.info('OfflineReminder', `离线提醒发送成功: ${accountName || this.accountId}`);
        } catch (e) {
            this.logger.warn('OfflineReminder', `离线提醒发送失败: ${e.message}`);
        } finally {
            this.offlineNotifyState.sending = false;
        }
    }
}

module.exports = { BotEngine };
