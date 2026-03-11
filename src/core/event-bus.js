const EventEmitter = require('events');

/**
 * 全局事件总线 (Global Event Bus)
 * 核心层、插件层之间通信的桥梁。
 */
class EventBus extends EventEmitter {
    constructor() {
        super();
        // 设置最大监听器数量，避免多账号并发时出现警告
        this.setMaxListeners(100);
    }
}

module.exports = { EventBus };