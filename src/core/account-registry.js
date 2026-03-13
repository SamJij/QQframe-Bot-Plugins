const fs = require('fs');
const path = require('path');

/**
 * 账号注册表：
 * - 持久化账号列表到 data/accounts.json
 * - 提供增删改查能力
 */
class AccountRegistry {
    constructor() {
        this.dataDir = path.join(process.cwd(), 'data');
        this.filePath = path.join(this.dataDir, 'accounts.json');
        this.accounts = [];
        this.ensureDir();
        this.load();
    }

    ensureDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    normalizeAccount(input) {
        const src = input && typeof input === 'object' ? input : {};
        const id = String(src.id || '').trim();
        if (!this.isValidAccountId(id)) return null;
        return {
            id,
            name: String(src.name || id),
            enabled: src.enabled !== false,
            config: (src.config && typeof src.config === 'object') ? src.config : {},
        };
    }

    isValidAccountId(id) {
        const value = String(id || '').trim();
        // 允许字母、数字、下划线、短横线，长度 3~64
        return /^[a-zA-Z0-9_-]{3,64}$/.test(value);
    }

    bootstrapFromConfigFiles() {
        const ids = new Set();
        if (fs.existsSync(this.dataDir)) {
            const files = fs.readdirSync(this.dataDir);
            for (const f of files) {
                const m = String(f).match(/^config_(.+)\.json$/);
                if (!m) continue;
                const id = String(m[1] || '').trim();
                if (!id) continue;
                ids.add(id);
            }
        }
        if (ids.size === 0) ids.add('acc_001');
        return Array.from(ids).map((id) => ({
            id,
            name: id,
            enabled: true,
            config: {},
        }));
    }

    load() {
        if (!fs.existsSync(this.filePath)) {
            this.accounts = this.bootstrapFromConfigFiles();
            this.save();
            return;
        }
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed) ? parsed : [];
            this.accounts = list
                .map((x) => this.normalizeAccount(x))
                .filter(Boolean);
            if (this.accounts.length === 0) {
                this.accounts = this.bootstrapFromConfigFiles();
                this.save();
            }
        } catch {
            this.accounts = this.bootstrapFromConfigFiles();
            this.save();
        }
    }

    save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.accounts, null, 2), 'utf-8');
    }

    list() {
        return this.accounts.map((x) => ({ ...x, config: { ...(x.config || {}) } }));
    }

    get(accountId) {
        const id = String(accountId || '').trim();
        if (!id) return null;
        const found = this.accounts.find((x) => x.id === id);
        return found ? { ...found, config: { ...(found.config || {}) } } : null;
    }

    upsert(account) {
        const next = this.normalizeAccount(account);
        if (!next) throw new Error('无效账号数据');
        const idx = this.accounts.findIndex((x) => x.id === next.id);
        if (idx >= 0) this.accounts[idx] = { ...this.accounts[idx], ...next };
        else this.accounts.push(next);
        this.save();
        return this.get(next.id);
    }

    create(account) {
        const next = this.normalizeAccount(account);
        if (!next) throw new Error('无效账号数据');
        if (this.accounts.some((x) => x.id === next.id)) {
            throw new Error('账号已存在');
        }
        this.accounts.push(next);
        this.save();
        return this.get(next.id);
    }

    update(accountId, patch = {}) {
        const id = String(accountId || '').trim();
        if (!this.isValidAccountId(id)) throw new Error('无效账号ID');
        const idx = this.accounts.findIndex((x) => x.id === id);
        if (idx < 0) throw new Error('账号不存在');
        const current = this.accounts[idx];
        const merged = {
            ...current,
            ...(patch && typeof patch === 'object' ? patch : {}),
            id,
        };
        const normalized = this.normalizeAccount(merged);
        if (!normalized) throw new Error('账号更新数据无效');
        this.accounts[idx] = normalized;
        this.save();
        return this.get(id);
    }

    remove(accountId) {
        const id = String(accountId || '').trim();
        const before = this.accounts.length;
        this.accounts = this.accounts.filter((x) => x.id !== id);
        if (this.accounts.length !== before) this.save();
        return this.accounts.length !== before;
    }
}

module.exports = { AccountRegistry };
