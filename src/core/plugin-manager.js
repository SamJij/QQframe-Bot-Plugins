/**
 * 插件管理器 (Plugin Manager)
 * 负责插件的生命周期：加载 (Load) -> 启动 (Start) -> 停止 (Stop) -> 卸载 (Unload)
 */
class PluginManager {
    constructor(engine) {
        this.engine = engine;
        this.plugins = new Map();
        this.enabledPlugins = new Set();
    }

    /**
     * 注册插件
     * @param {Object} PluginClass 插件类
     */
    register(PluginClass) {
        if (!PluginClass || !PluginClass.name) {
            this.engine.logger.warn('PluginManager', '尝试注册无效的插件');
            return;
        }

        const name = PluginClass.name;
        if (this.plugins.has(name)) {
            this.engine.logger.warn('PluginManager', `插件 ${name} 已存在，跳过注册`);
            return;
        }

        try {
            // 实例化插件，并注入当前引擎上下文
            const pluginInstance = new PluginClass(this.engine);
            this.plugins.set(name, pluginInstance);

            // 触发 onLoad 生命周期
            if (typeof pluginInstance.onLoad === 'function') {
                pluginInstance.onLoad();
            }
            this.engine.logger.info('PluginManager', `插件 [${name}] 注册成功`);
        } catch (err) {
            this.engine.logger.error('PluginManager', `插件 [${name}] 初始化失败: ${err.message}`);
        }
    }

    /**
     * 启用指定插件
     * @param {String} name 插件名称
     */
    enable(name) {
        const plugin = this.plugins.get(name);
        if (!plugin) {
            this.engine.logger.warn('PluginManager', `未找到插件: ${name}`);
            return;
        }

        if (this.enabledPlugins.has(name)) return;

        try {
            if (typeof plugin.onEnable === 'function') {
                plugin.onEnable();
            }
            this.enabledPlugins.add(name);
            this.engine.logger.info('PluginManager', `插件 [${name}] 已启用`);
        } catch (err) {
            this.engine.logger.error('PluginManager', `插件 [${name}] 启用失败: ${err.message}`);
        }
    }

    /**
     * 禁用指定插件
     * @param {String} name 插件名称
     */
    disable(name) {
        const plugin = this.plugins.get(name);
        if (!plugin || !this.enabledPlugins.has(name)) return;

        try {
            if (typeof plugin.onDisable === 'function') {
                plugin.onDisable();
            }
            // 自动清理该插件注册的所有定时任务
            if (plugin.scheduler) {
                plugin.scheduler.clearAll();
            }
            this.enabledPlugins.delete(name);
            this.engine.logger.info('PluginManager', `插件 [${name}] 已禁用`);
        } catch (err) {
            this.engine.logger.error('PluginManager', `插件 [${name}] 禁用失败: ${err.message}`);
        }
    }

    /**
     * 启用所有已注册的插件
     */
    enableAll() {
        for (const name of this.plugins.keys()) {
            this.enable(name);
        }
    }

    /**
     * 禁用所有已启用的插件
     */
    disableAll() {
        for (const name of Array.from(this.enabledPlugins)) {
            this.disable(name);
        }
    }

    /**
     * 热重载指定插件
     * 在不重启底层网络的情况下，销毁旧实例，重新加载新代码并实例化
     * @param {String} pluginPath 插件的绝对或相对路径
     */
    reload(pluginPath) {
        try {
            // 1. 解析绝对路径 (如 '../plugins/gameplay/farm-plugin')
            const absolutePath = require.resolve(pluginPath);
            
            // 2. 从 require.cache 中找到旧的模块缓存
            const cachedModule = require.cache[absolutePath];
            if (!cachedModule) {
                this.engine.logger.warn('PluginManager', `无法热重载: 未找到模块缓存 [${pluginPath}]`);
                // 如果没有缓存，我们直接当作新插件注册即可
                const newModule = require(absolutePath);
                const NewPluginClass = Object.values(newModule).find(val => typeof val === 'function' && val.prototype);
                if (NewPluginClass) {
                    this.register(NewPluginClass);
                    this.enable(NewPluginClass.name);
                }
                return true;
            }

            // 3. 找出之前由此文件导出的 PluginClass 的 name
            const OldPluginClass = Object.values(cachedModule.exports).find(val => typeof val === 'function' && val.prototype);
            if (!OldPluginClass || !OldPluginClass.name) {
                this.engine.logger.warn('PluginManager', `无法热重载: 模块未导出有效的插件类 [${pluginPath}]`);
                return false;
            }
            
            const pluginName = OldPluginClass.name;
            this.engine.logger.info('PluginManager', `正在热重载插件 [${pluginName}]...`);

            // 4. 停用旧插件
            const wasEnabled = this.enabledPlugins.has(pluginName);
            if (wasEnabled) {
                this.disable(pluginName);
            }

            // 5. 彻底删除缓存，并从实例字典中移除
            delete require.cache[absolutePath];
            this.plugins.delete(pluginName);

            // 6. 重新 require 新文件
            const newModule = require(absolutePath);
            const NewPluginClass = Object.values(newModule).find(val => typeof val === 'function' && val.prototype);
            
            if (!NewPluginClass) {
                this.engine.logger.error('PluginManager', `热重载失败: 找不到导出类`);
                return false;
            }

            // 7. 重新注册并恢复状态
            this.register(NewPluginClass);
            if (wasEnabled) {
                this.enable(NewPluginClass.name);
            }
            
            this.engine.logger.info('PluginManager', `插件 [${pluginName}] 热重载成功！`);
            return true;
        } catch (err) {
            this.engine.logger.error('PluginManager', `热重载失败: ${err.message}`);
            return false;
        }
    }
}

module.exports = { PluginManager };