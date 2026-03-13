const fs = require('node:fs');
const path = require('node:path');

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

    getPluginsRoot() {
        return path.resolve(process.cwd(), 'src', 'plugins');
    }

    isPathInsidePluginsRoot(targetPath) {
        const root = this.getPluginsRoot();
        const relative = path.relative(root, targetPath);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    }

    resolveReloadPluginPath(pluginPath) {
        const raw = String(pluginPath || '').trim();
        if (!raw) {
            throw new Error('pluginPath 不能为空');
        }
        if (raw.includes('\0')) {
            throw new Error('pluginPath 非法');
        }

        const normalized = raw.replace(/[\\/]+/g, path.sep);
        const attempts = [];
        if (path.isAbsolute(normalized)) {
            attempts.push(path.normalize(normalized));
        } else {
            attempts.push(path.resolve(process.cwd(), normalized));
            if (!normalized.endsWith('.js')) {
                attempts.push(path.resolve(process.cwd(), `${normalized}.js`));
            }
        }

        for (const abs of attempts) {
            if (!abs.endsWith('.js')) continue;
            if (!fs.existsSync(abs)) continue;
            const stat = fs.statSync(abs);
            if (!stat.isFile()) continue;
            if (!this.isPathInsidePluginsRoot(abs)) continue;
            return abs;
        }
        throw new Error('仅允许重载 src/plugins 目录下的 .js 插件文件');
    }

    validateReloadPath(pluginPath) {
        try {
            const absolutePath = this.resolveReloadPluginPath(pluginPath);
            return { ok: true, absolutePath };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    buildReloadMeta(base = {}, extra = {}) {
        return {
            phase: String(base.phase || ''),
            pluginName: String(base.pluginName || ''),
            pluginPath: String(base.pluginPath || ''),
            absolutePath: String(base.absolutePath || ''),
            wasEnabled: !!base.wasEnabled,
            hasCache: !!base.hasCache,
            rolledBack: !!base.rolledBack,
            newClassName: String(base.newClassName || ''),
            enableResult: base.enableResult === null || base.enableResult === undefined ? null : !!base.enableResult,
            rollbackEnableResult: base.rollbackEnableResult === null || base.rollbackEnableResult === undefined ? null : !!base.rollbackEnableResult,
            durationMs: Number(base.durationMs || 0),
            ...extra,
        };
    }

    runReloadHealthCheck(pluginInstance, context = {}) {
        if (!pluginInstance || typeof pluginInstance !== 'object') {
            return { ok: false, reason: '插件实例不存在' };
        }
        // 可选健康检查：插件自行提供 healthCheck() 时参与热重载验收。
        if (typeof pluginInstance.healthCheck === 'function') {
            const result = pluginInstance.healthCheck();
            if (result === false) {
                return { ok: false, reason: 'healthCheck 返回 false' };
            }
        }
        return { ok: true, reason: 'ok', context };
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
            return false;
        }

        // 已启用视为成功，保持幂等。
        if (this.enabledPlugins.has(name)) return true;

        try {
            if (typeof plugin.onEnable === 'function') {
                plugin.onEnable();
            }
            this.enabledPlugins.add(name);
            this.engine.logger.info('PluginManager', `插件 [${name}] 已启用`);
            return true;
        } catch (err) {
            this.engine.logger.error('PluginManager', `插件 [${name}] 启用失败: ${err.message}`);
            return false;
        }
    }

    /**
     * 禁用指定插件
     * @param {String} name 插件名称
     */
    disable(name) {
        const plugin = this.plugins.get(name);
        if (!plugin) {
            this.engine.logger.warn('PluginManager', `未找到插件: ${name}`);
            return false;
        }
        // 已禁用视为成功，保持幂等。
        if (!this.enabledPlugins.has(name)) return true;

        let hadError = false;
        try {
            if (typeof plugin.onDisable === 'function') {
                plugin.onDisable();
            }
        } catch (err) {
            hadError = true;
            this.engine.logger.error('PluginManager', `插件 [${name}] 禁用回调失败: ${err.message}`);
        }

        // 无论 onDisable 是否报错，都继续清理定时器和启用状态，避免脏状态残留。
        try {
            if (plugin.scheduler) {
                plugin.scheduler.clearAll();
            }
        } catch (err) {
            hadError = true;
            this.engine.logger.error('PluginManager', `插件 [${name}] 定时器清理失败: ${err.message}`);
        }

        this.enabledPlugins.delete(name);
        if (!hadError) {
            this.engine.logger.info('PluginManager', `插件 [${name}] 已禁用`);
            return true;
        }
        this.engine.logger.warn('PluginManager', `插件 [${name}] 已禁用，但过程中存在错误`);
        return false;
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
     * 获取插件运行时诊断信息（用于热重载回归验证）
     * @param {String} name 插件名称
     */
    getPluginDiagnostics(name) {
        const plugin = this.plugins.get(name);
        if (!plugin) return null;
        const timers = plugin.scheduler && plugin.scheduler.timers;
        const intervals = plugin.scheduler && plugin.scheduler.intervals;
        return {
            name,
            enabled: this.enabledPlugins.has(name),
            listenerCount: Array.isArray(plugin._listeners) ? plugin._listeners.length : 0,
            timeoutCount: timers && typeof timers.size === 'number' ? timers.size : 0,
            intervalCount: intervals && typeof intervals.size === 'number' ? intervals.size : 0,
            hasHealthCheck: typeof plugin.healthCheck === 'function',
        };
    }

    /**
     * 热重载指定插件
     * 在不重启底层网络的情况下，销毁旧实例，重新加载新代码并实例化
     * @param {String} pluginPath 插件的绝对或相对路径
     */
    reload(pluginPath) {
        const startedAt = Date.now();
        const trace = {
            phase: 'start',
            pluginName: '',
            pluginPath: String(pluginPath || ''),
            absolutePath: '',
            wasEnabled: false,
            hasCache: false,
            rolledBack: false,
            newClassName: '',
            enableResult: null,
            rollbackEnableResult: null,
            durationMs: 0,
        };

        try {
            // 1. 解析绝对路径 (如 '../plugins/gameplay/farm-plugin')
            const absolutePath = this.resolveReloadPluginPath(pluginPath);
            trace.absolutePath = absolutePath;
            trace.phase = 'resolve';
            
            // 2. 从 require.cache 中找到旧的模块缓存
            const cachedModule = require.cache[absolutePath];
            trace.hasCache = !!cachedModule;
            if (!cachedModule) {
                trace.phase = 'cache_miss';
                this.engine.logger.warn(
                    'PluginManager',
                    `无法热重载: 未找到模块缓存 [${pluginPath}]`,
                    this.buildReloadMeta(trace)
                );
                // 如果没有缓存，我们直接当作新插件注册即可
                const newModule = require(absolutePath);
                const NewPluginClass = Object.values(newModule).find(val => typeof val === 'function' && val.prototype);
                if (NewPluginClass) {
                    trace.phase = 'register_without_cache';
                    trace.newClassName = String(NewPluginClass.name || '');
                    this.register(NewPluginClass);
                    if (!this.plugins.has(NewPluginClass.name)) {
                        this.engine.logger.warn(
                            'PluginManager',
                            `无法热重载: 新插件注册失败 [${pluginPath}]`,
                            this.buildReloadMeta(trace)
                        );
                        return false;
                    }
                    trace.phase = 'enable_without_cache';
                    trace.enableResult = this.enable(NewPluginClass.name);
                    if (!trace.enableResult) {
                        this.engine.logger.warn(
                            'PluginManager',
                            `无法热重载: 新插件启用失败 [${pluginPath}]`,
                            this.buildReloadMeta(trace)
                        );
                        return false;
                    }
                    trace.phase = 'success_without_cache';
                    trace.durationMs = Date.now() - startedAt;
                    this.engine.logger.info(
                        'PluginManager',
                        `插件 [${NewPluginClass.name}] 热重载成功（无缓存路径）`,
                        this.buildReloadMeta(trace)
                    );
                    return true;
                }
                this.engine.logger.warn(
                    'PluginManager',
                    `无法热重载: 未找到可用插件导出 [${pluginPath}]`,
                    this.buildReloadMeta(trace)
                );
                return false;
            }

            // 3. 找出之前由此文件导出的 PluginClass 的 name
            const OldPluginClass = Object.values(cachedModule.exports).find(val => typeof val === 'function' && val.prototype);
            if (!OldPluginClass || !OldPluginClass.name) {
                trace.phase = 'invalid_old_export';
                this.engine.logger.warn(
                    'PluginManager',
                    `无法热重载: 模块未导出有效的插件类 [${pluginPath}]`,
                    this.buildReloadMeta(trace)
                );
                return false;
            }
            
            const pluginName = OldPluginClass.name;
            trace.pluginName = pluginName;
            const oldPluginInstance = this.plugins.get(pluginName);
            const wasEnabled = this.enabledPlugins.has(pluginName);
            trace.wasEnabled = wasEnabled;
            trace.phase = 'begin_reload';
            this.engine.logger.info(
                'PluginManager',
                `正在热重载插件 [${pluginName}]...`,
                this.buildReloadMeta(trace)
            );

            try {
                // 4. 停用旧插件
                if (wasEnabled) {
                    trace.phase = 'disable_old';
                    const disableResult = this.disable(pluginName);
                    if (!disableResult) {
                        throw new Error('旧插件停用失败');
                    }
                }

                // 5. 删除缓存，并从实例字典中移除旧实例
                trace.phase = 'drop_cache';
                delete require.cache[absolutePath];
                this.plugins.delete(pluginName);

                // 6. 重新加载新代码
                trace.phase = 'load_new_module';
                const newModule = require(absolutePath);
                const NewPluginClass = Object.values(newModule).find(val => typeof val === 'function' && val.prototype);
                if (!NewPluginClass) {
                    throw new Error('找不到导出类');
                }
                trace.newClassName = String(NewPluginClass.name || '');

                // 7. 注册并恢复启用状态
                trace.phase = 'register_new';
                this.register(NewPluginClass);
                if (!this.plugins.has(NewPluginClass.name)) {
                    throw new Error('新插件注册失败');
                }

                trace.phase = 'health_check';
                const newPluginInstance = this.plugins.get(NewPluginClass.name);
                const health = this.runReloadHealthCheck(newPluginInstance, { pluginName: NewPluginClass.name });
                if (!health.ok) {
                    throw new Error(`新插件健康检查失败: ${health.reason}`);
                }

                if (wasEnabled) {
                    trace.phase = 'enable_new';
                    trace.enableResult = this.enable(NewPluginClass.name);
                    if (!trace.enableResult || !this.enabledPlugins.has(NewPluginClass.name)) {
                        throw new Error('新插件启用失败');
                    }
                }

                trace.phase = 'success';
                trace.durationMs = Date.now() - startedAt;
                this.engine.logger.info(
                    'PluginManager',
                    `插件 [${pluginName}] 热重载成功！`,
                    this.buildReloadMeta(trace)
                );
                return true;
            } catch (innerErr) {
                // 新版本失败时回滚旧实例，确保功能可用
                trace.phase = 'rollback';
                this.engine.logger.error(
                    'PluginManager',
                    `插件 [${pluginName}] 热重载失败，开始回滚: ${innerErr.message}`,
                    this.buildReloadMeta(trace, { error: innerErr.message })
                );
                if (oldPluginInstance) {
                    this.plugins.set(pluginName, oldPluginInstance);
                    if (wasEnabled) {
                        const rollbackEnableOk = this.enable(pluginName);
                        trace.rollbackEnableResult = rollbackEnableOk;
                        if (!rollbackEnableOk) {
                            this.engine.logger.error(
                                'PluginManager',
                                `插件 [${pluginName}] 回滚启用失败`,
                                this.buildReloadMeta(trace)
                            );
                        }
                    }
                    trace.rolledBack = true;
                    trace.durationMs = Date.now() - startedAt;
                    this.engine.logger.warn(
                        'PluginManager',
                        `插件 [${pluginName}] 已回滚到旧版本`,
                        this.buildReloadMeta(trace)
                    );
                }
                return false;
            }
        } catch (err) {
            trace.phase = 'fatal';
            trace.durationMs = Date.now() - startedAt;
            this.engine.logger.error(
                'PluginManager',
                `热重载失败: ${err.message}`,
                this.buildReloadMeta(trace, { error: err.message })
            );
            return false;
        }
    }
}

module.exports = { PluginManager };
