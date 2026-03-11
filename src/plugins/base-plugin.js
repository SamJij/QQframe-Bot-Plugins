/**
 * 插件基类 (Base Plugin)
 * 所有的业务插件都应该继承此类，获取统一的开发体验。
 */
class BasePlugin {
    /**
     * @param {import('../core/engine').BotEngine} engine 
     */
    constructor(engine) {
        this.engine = engine;
        // 提供便捷访问
        this.logger = engine.logger;
        this.eventBus = engine.eventBus;
        this.state = engine.state;
        
        // 插件私有资源管理器
        this._listeners = []; // 存放绑定的事件，以便禁用时自动解绑
        this.scheduler = {
            timers: new Set(),
            intervals: new Set(),
            setTimeout: (fn, delay) => {
                const id = setTimeout(fn, delay);
                this.scheduler.timers.add(id);
                return id;
            },
            setInterval: (fn, delay) => {
                const id = setInterval(fn, delay);
                this.scheduler.intervals.add(id);
                return id;
            },
            clearAll: () => {
                for (const id of this.scheduler.timers) clearTimeout(id);
                for (const id of this.scheduler.intervals) clearInterval(id);
                this.scheduler.timers.clear();
                this.scheduler.intervals.clear();
            }
        };
    }

    // ==========================================
    // 生命周期钩子 (Life Cycle Hooks)
    // ==========================================

    /**
     * 插件被注册时调用 (只需执行一次的初始化)
     */
    onLoad() {}

    /**
     * 插件被启用时调用 (绑定事件、开启定时任务)
     */
    onEnable() {}

    /**
     * 插件被禁用时调用 (解绑事件、清理资源，定时任务会被父类自动清理)
     */
    onDisable() {
        // 自动清理通过 this.on() 绑定的事件
        for (const { event, listener } of this._listeners) {
            this.eventBus.off(event, listener);
        }
        this._listeners = [];
    }

    // ==========================================
    // 工具方法 (Utilities)
    // ==========================================

    /**
     * 监听全局事件 (会在 onDisable 时自动移除)
     * @param {String} event 事件名
     * @param {Function} listener 处理函数
     */
    on(event, listener) {
        // 绑定 this 上下文
        const boundListener = listener.bind(this);
        this.eventBus.on(event, boundListener);
        this._listeners.push({ event, listener: boundListener });
    }

    /**
     * 抛出全局事件
     * @param {String} event 事件名
     * @param  {...any} args 参数
     */
    emit(event, ...args) {
        this.eventBus.emit(event, ...args);
    }
}

module.exports = { BasePlugin };