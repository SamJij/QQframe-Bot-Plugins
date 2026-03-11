const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

/**
 * 状态存储管理器 (Config Store)
 * 负责本地 JSON 文件的读写、账号配置的持久化，以及运行时状态的派发。
 */
class StoreManager extends EventEmitter {
    constructor(engine, accountId) {
        super();
        this.engine = engine;
        this.accountId = accountId;
        
        // 存储目录 (通常放在项目根目录下的 data 文件夹中)
        this.dataDir = path.join(process.cwd(), 'data');
        this.configPath = path.join(this.dataDir, `config_${this.accountId}.json`);

        // 初始化默认配置
        this.config = {
            code: '',
            auto_farm: true,
            auto_friend_steal: true,
            auto_friend_help: true,
            auto_friend_bad: false,
            auto_task: true,
            auto_mall_free: true,
            auto_mall_buy: true,
            auto_email: true,
            auto_share: true,
            auto_month_card: true,
            auto_vip: true,
            auto_open_server: true,
            friend_quiet_hours: { enabled: true, start: "00:00", end: "07:00" },
            friend_blacklist: [], // 防止风控自动拉黑的名单
            seed_strategy: "max_profit", // 选种策略: max_profit | max_level | preferred
            preferred_seed_id: 0,
        };

        this.ensureDir();
        this.load();
    }

    ensureDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * 从本地 JSON 文件加载配置
     */
    load() {
        if (fs.existsSync(this.configPath)) {
            try {
                const data = fs.readFileSync(this.configPath, 'utf-8');
                const parsed = JSON.parse(data);
                // 合并默认配置
                this.config = { ...this.config, ...parsed };
                this.engine.logger.info('Store', `已加载本地配置: config_${this.accountId}.json`);
            } catch (e) {
                this.engine.logger.warn('Store', `加载配置文件失败: ${e.message}`);
            }
        }
        
        // 将配置同步到 Engine 的 state 中，供各插件读取
        this.engine.state.config = this.config;
    }

    /**
     * 保存配置到本地 JSON 文件
     */
    save() {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
            // 同步给 Engine
            this.engine.state.config = this.config;
            
            // 抛出配置更新事件，允许某些插件热重载 (例如调整了安静时间，好友插件可以立刻生效)
            this.engine.eventBus.emit('config_updated', this.config);
            // this.engine.logger.info('Store', '配置已保存');
        } catch (e) {
            this.engine.logger.warn('Store', `保存配置文件失败: ${e.message}`);
        }
    }

    /**
     * 更新单个或多个配置项
     */
    update(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.save();
    }

    /**
     * 运行时配置辅助方法
     */
    get(key) {
        return this.config[key];
    }
}

module.exports = { StoreManager };