const { BotEngine } = require('./core/engine');
const { AdminServer } = require('./core/admin-server');
const { AccountRegistry } = require('./core/account-registry');
const { FarmPlugin } = require('./plugins/gameplay/farm-plugin');
const { WarehousePlugin } = require('./plugins/gameplay/warehouse-plugin');
const { FriendPlugin } = require('./plugins/gameplay/friend-plugin');
const { TaskPlugin } = require('./plugins/gameplay/task-plugin');
const { MallPlugin } = require('./plugins/gameplay/mall-plugin');
const { WelfarePlugin } = require('./plugins/gameplay/welfare-plugin');
const { InteractPlugin } = require('./plugins/gameplay/interact-plugin');
const { CONFIG } = require('./config/config');

function registerDefaultPlugins(engine) {
    engine.pluginManager.register(FarmPlugin);
    engine.pluginManager.register(WarehousePlugin);
    // engine.pluginManager.register(FriendPlugin);
    engine.pluginManager.register(TaskPlugin);
    engine.pluginManager.register(MallPlugin);
    engine.pluginManager.register(WelfarePlugin);
    engine.pluginManager.register(InteractPlugin);
}

function createEngine(accountId, config = {}) {
    const safeConfig = (config && typeof config === 'object') ? config : {};
    const engine = new BotEngine({
        accountId,
        mockNetwork: false,
        config: safeConfig,
    });
    registerDefaultPlugins(engine);
    return engine;
}

async function main() {
    const admin = new AdminServer(CONFIG.adminPort);
    const registry = new AccountRegistry();

    // 注入引擎工厂，供后续账号管理接口复用。
    admin.setEngineFactory((accountId, options = {}) => {
        const cfg = options && options.config ? options.config : {};
        return createEngine(accountId, cfg);
    });
    admin.setAccountRegistry(registry);
    admin.start();

    const accounts = registry.list().filter((x) => x && x.enabled !== false);
    if (accounts.length === 0) {
        console.warn('[Bootstrap] 没有可启动账号，请检查 data/accounts.json');
        return;
    }

    for (const account of accounts) {
        try {
            await admin.createAndStartEngine(account.id, { config: account.config || {} });
            console.log(`[Bootstrap] 账号已启动: ${account.id}`);
        } catch (e) {
            console.error(`[Bootstrap] 启动账号失败(${account.id}): ${e.message}`);
        }
    }
}

main().catch(err => {
    console.error('启动崩溃:', err);
});
