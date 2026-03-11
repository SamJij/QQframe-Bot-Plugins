const { EventBus } = require('./event-bus');
const { PluginManager } = require('./plugin-manager');
const { NetworkCore } = require('./network');
const { StoreManager } = require('./store/store-manager');

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
                this.eventBus.emit('log', { level: 'info', tag, msg, extra, time: Date.now() });
            },
            warn: (tag, msg, extra = {}) => {
                console.warn(`[WARN][${tag}] ${msg}`);
                this.eventBus.emit('log', { level: 'warn', tag, msg, extra, time: Date.now() });
            },
            error: (tag, msg, extra = {}) => {
                console.error(`[ERROR][${tag}] ${msg}`);
                this.eventBus.emit('log', { level: 'error', tag, msg, extra, time: Date.now() });
            }
        };

        // 1. 初始化事件总线
        this.eventBus = new EventBus();
        
        // 2. 初始化状态与本地持久化 Store
        this.state = {
            user: { gid: 0, name: '', level: 0, gold: 0, exp: 0, coupon: 0 },
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
}

module.exports = { BotEngine };