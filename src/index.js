const { BotEngine } = require('./core/engine');
const { AdminServer } = require('./core/admin-server');
const { FarmPlugin } = require('./plugins/gameplay/farm-plugin');
const { WarehousePlugin } = require('./plugins/gameplay/warehouse-plugin');
const { FriendPlugin } = require('./plugins/gameplay/friend-plugin');
const { TaskPlugin } = require('./plugins/gameplay/task-plugin');
const { MallPlugin } = require('./plugins/gameplay/mall-plugin');
const { WelfarePlugin } = require('./plugins/gameplay/welfare-plugin');

async function main() {
    // 1. 启动中心化管理服务器
    const admin = new AdminServer(8888);
    admin.start();

    // 2. 初始化一个账号引擎实例 (多账号的话可以 new 多个)
    const engine = new BotEngine({
        accountId: 'acc_001',
        mockNetwork: false, // 是否使用真实的腾讯服务器
        config: {
            code: '69d083538c4dbc5c423b3fcee0553f2c', // 初始 code
            auto_farm: true,
            auto_friend_steal: true,
            auto_friend_help: true,
            auto_task: true,
            auto_mall_free: true, 
            auto_mall_buy: true,
            auto_email: true,
            auto_share: true,
            auto_month_card: true,
            auto_vip: true,
            auto_open_server: true,
        }
    });

    // 注册插件
    engine.pluginManager.register(FarmPlugin);
    engine.pluginManager.register(WarehousePlugin);
    // engine.pluginManager.register(FriendPlugin);
    engine.pluginManager.register(TaskPlugin);
    engine.pluginManager.register(MallPlugin);
    engine.pluginManager.register(WelfarePlugin);

    // 将引擎交由 Admin 面板托管
    admin.registerEngine(engine.accountId, engine);

    // 启动该账号
    await engine.start();
}

main().catch(err => {
    console.error('启动崩溃:', err);
});
