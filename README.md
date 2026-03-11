# QQFrame Bot (插件化 QQ 农场自动挂机引擎)

QQFrame Bot 是一个为 QQ 农场（微信同玩版）量身打造的全自动挂机机器人。
通过采用现代化的 **事件驱动 (Event-Driven)** 和 **插件化 (Plugin-based)** 架构，项目拥有极高的稳定性、扩展性和极低的耦合度。它支持多账号并发，支持在不掉线的情况下进行核心代码的 **热重载 (Hot Reloading)**。

---

## 🌟 核心特性

- 🧩 **全插件化架构**：所有业务逻辑（种菜、偷菜、签到、卖出）全部解耦为独立插件，互相隔离。
- 🔥 **无感热重载**：修改业务插件代码后，一键重载生效，**底层 WebSocket 不断开，账号不掉线**。
- 🚀 **事件驱动总线**：基于 `EventBus`，插件间通过事件广播进行通信，彻底告别“意大利面条式”的 `require` 嵌套。
- 🛡️ **安全的沙箱机制**：由 `BasePlugin` 接管生命周期。停用或重载插件时，自动销毁所有 `setTimeout/setInterval` 定时器和事件监听，杜绝内存泄漏与幽灵循环。
- 📂 **本地持久化配置**：自带 `StoreManager`，各账号独立生成 JSON 配置文件，配置修改实时广播并生效。
- 📡 **自带管理面板 API**：内置 `AdminServer`，基于 Express & Socket.io 提供前端 Web 面板对接接口。

---

## 🏗️ 目录结构

```text
qqframe-bot/
├── src/
│   ├── index.js                  # 入口文件：组装引擎、注册插件并启动
│   ├── core/                     # 核心引擎层
│   │   ├── engine.js             # BotEngine: 容器引擎，管理一个账号实例
│   │   ├── event-bus.js          # EventBus: 全局事件总线
│   │   ├── network.js            # NetworkCore: WebSocket 维持、发包、心跳
│   │   ├── plugin-manager.js     # PluginManager: 插件注册、启停、热重载魔法
│   │   ├── admin-server.js       # 管理面板接口与 WS 推送
│   │   └── store/                # 本地 JSON 配置持久化
│   ├── plugins/                  # 插件层
│   │   ├── base-plugin.js        # 所有业务插件的基类 (提供定时器和事件的自动清理)
│   │   ├── system/               # 系统级插件 (如 Mock 网络测试)
│   │   └── gameplay/             # 具体的游戏业务逻辑插件 
│   │       ├── farm-plugin.js      # 自动打理自己农场、种菜、除草
│   │       ├── friend-plugin.js    # 自动巡查好友农场、偷菜、帮忙
│   │       ├── warehouse-plugin.js # 自动卖出果实、自动补充化肥
│   │       ├── task-plugin.js      # 自动签到、领取每日/成长任务
│   │       ├── mall-plugin.js      # 自动领取免费礼包、用点券买化肥
│   │       └── welfare-plugin.js   # 月卡、VIP、邮件附件等边缘福利
│   ├── utils/                    # 工具与协议层
│   │   ├── proto.js              # Protobuf 序列化
│   │   └── crypto-wasm.js        # 腾讯风控 WASM 加解密
│   └── config/                   # 游戏静态数据表
└── data/                         # 自动生成的本地配置与日志目录
```

---

## 🚀 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置账号并启动
打开 `src/index.js`，修改你的真实抓包 `code`：

```javascript
const engine = new BotEngine({
    accountId: 'acc_001',
    mockNetwork: false, // 是否使用真实的腾讯服务器
    config: {
        code: '你的抓包真实_code_填写在这里', 
        auto_farm: true,
        auto_friend_steal: true,
        auto_task: true,
        // ...其他开关
    }
});
```

然后运行：
```bash
node src/index.js
```
启动成功后，管理面板 API 默认监听在 `http://localhost:8888`。

---

## 🪄 插件热重载 (Hot Reloading) 的“黑魔法”

本项目的核心亮点之一是支持在 **不中断底层长连接、不重新执行登录握手** 的情况下，替换业务逻辑代码。

### 为什么能做到？
当修改代码后再次 `require`，Node.js 默认会返回内存中缓存的旧代码。因此，要实现无感热重载，必须打破这层缓存，并在宿主引擎的生命周期中进行“外科手术”般的替换。

### 原理与核心代码解析

核心实现在 `src/core/plugin-manager.js` 的 `reload()` 方法中：

**1. 优雅卸载旧实例 (Graceful Teardown)**
```javascript
// 触发旧实例的 onDisable 生命周期
if (wasEnabled) this.disable(pluginName);
```
得益于 `BasePlugin` 设计的沙箱机制，这行代码不仅调用了业务的卸载逻辑，还会自动触发 **清空通过该插件创建的所有 `setInterval`** 和 **解绑其在 `EventBus` 上挂载的所有监听器**。这彻底杜绝了旧代码在后台变成“幽灵线程”导致双倍发包或内存泄漏的风险。

**2. 暴力抹除内存缓存 (Cache Busting)**
```javascript
const absolutePath = require.resolve(pluginPath);
delete require.cache[absolutePath]; // 从 Node 缓存中抹除文件
this.plugins.delete(pluginName);    // 从插件字典中移除旧实例
```
这就是 Node.js 热重载的核心。删除 `require.cache` 里的 Key，强制下次读取时去硬盘加载最新的文件。

**3. 重新装载与无缝衔接 (Reload & Resume)**
```javascript
const newModule = require(absolutePath); // 重新读取最新保存的代码
const NewPluginClass = Object.values(newModule).find(val => typeof val === 'function' && val.prototype);

this.register(NewPluginClass);      // 注册新类
if (wasEnabled) {
    this.enable(NewPluginClass.name); // 重新实例化并触发 onEnable
}
```
当新的插件实例调用 `onEnable()` 时，它会重新订阅 `EventBus` 的事件。
由于底层的 `NetworkCore` (`src/core/network.js`) 是独立挂载在 `BotEngine` 上的，它并没有被重载，所以 **WebSocket 依然存活，Token 依然有效**。新插件起来后，立刻无缝接管下一个从服务器推过来的 `LandsNotify` 或者是下一个自己发起的轮询定时器。

### 如何使用？
在保持 Bot 运行的情况下，修改并保存了插件代码。直接向管理服务器发送 POST 请求：

```bash
curl -X POST http://localhost:8888/api/accounts/acc_001/reload \
-H "Content-Type: application/json" \
-d '{"pluginPath": "../plugins/gameplay/farm-plugin"}'
```
即可享受丝滑的热重载体验！

---

## 🔌 插件开发指南

想添加一个自动购买狗粮的新功能？非常简单！
新建一个插件文件 `src/plugins/gameplay/dog-plugin.js`，继承 `BasePlugin`：

```javascript
const { BasePlugin } = require('../base-plugin');

class DogPlugin extends BasePlugin {
    onEnable() {
        this.logger.info('DogPlugin', '狗狗自动化已启动');

        // 监听账号登录成功事件
        this.on('login_success', () => {
            // 使用 this.scheduler 创建定时器，插件重载时会自动销毁，非常安全
            this.scheduler.setInterval(() => {
                this.buyDogFood();
            }, 3600000); // 每小时买一次狗粮
        });
    }

    async buyDogFood() {
        // 使用引擎挂载的网络核心发包
        // await this.engine.network.sendMsgAsync('...', '...', body);
        this.logger.info('DogPlugin', '成功买了一包狗粮！');
    }
}
module.exports = { DogPlugin };
```
然后在 `index.js` 中 `engine.pluginManager.register(DogPlugin)` 即可完美融合进系统！