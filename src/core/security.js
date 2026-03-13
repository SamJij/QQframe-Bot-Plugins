const crypto = require('crypto');

/**
 * 管理端鉴权管理器：
 * - 登录校验密码并签发 token
 * - 校验 token 有效性和过期时间
 */
class SecurityManager {
    constructor(options = {}) {
        this.password = String(options.password || '');
        this.authRequired = options.authRequired !== false;
        this.tokenTtlSec = Math.max(60, Number(options.tokenTtlSec || 12 * 60 * 60));
        this.tokens = new Map();
    }

    isEnabled() {
        return this.authRequired;
    }

    extractTokenFromRequest(req) {
        const legacyHeaderToken = String((req && req.headers && req.headers['x-admin-token']) || '').trim();
        if (legacyHeaderToken) return legacyHeaderToken;
        const auth = String((req && req.headers && req.headers.authorization) || '').trim();
        if (auth.toLowerCase().startsWith('bearer ')) {
            return auth.slice(7).trim();
        }
        const queryToken = req && req.query ? String(req.query.token || '').trim() : '';
        if (queryToken) return queryToken;
        return '';
    }

    extractTokenFromSocket(socket) {
        const authToken = socket && socket.handshake && socket.handshake.auth
            ? String(socket.handshake.auth.token || '').trim()
            : '';
        if (authToken) return authToken;
        const legacyHeaderToken = socket && socket.handshake && socket.handshake.headers
            ? String(socket.handshake.headers['x-admin-token'] || '').trim()
            : '';
        if (legacyHeaderToken) return legacyHeaderToken;
        const header = socket && socket.handshake && socket.handshake.headers
            ? String(socket.handshake.headers.authorization || '').trim()
            : '';
        if (header.toLowerCase().startsWith('bearer ')) {
            return header.slice(7).trim();
        }
        return '';
    }

    cleanupExpiredTokens() {
        const now = Date.now();
        for (const [token, meta] of this.tokens.entries()) {
            if (!meta || Number(meta.expireAt) <= now) {
                this.tokens.delete(token);
            }
        }
    }

    issueToken(username = 'admin') {
        this.cleanupExpiredTokens();
        const token = crypto.randomBytes(24).toString('hex');
        const expireAt = Date.now() + this.tokenTtlSec * 1000;
        this.tokens.set(token, { username, expireAt });
        return {
            token,
            expireAt,
            expiresIn: this.tokenTtlSec,
        };
    }

    login(passwordInput) {
        const input = String(passwordInput || '');
        if (!this.password || input !== this.password) {
            return { ok: false };
        }
        const issued = this.issueToken('admin');
        return { ok: true, ...issued };
    }

    verifyToken(token) {
        if (!this.isEnabled()) return true;
        const key = String(token || '').trim();
        if (!key) return false;
        this.cleanupExpiredTokens();
        const meta = this.tokens.get(key);
        if (!meta) return false;
        if (Number(meta.expireAt) <= Date.now()) {
            this.tokens.delete(key);
            return false;
        }
        return true;
    }

    revokeToken(token) {
        const key = String(token || '').trim();
        if (!key) return false;
        return this.tokens.delete(key);
    }
}

function createSecurityManager(options = {}) {
    return new SecurityManager(options);
}

module.exports = { SecurityManager, createSecurityManager };
