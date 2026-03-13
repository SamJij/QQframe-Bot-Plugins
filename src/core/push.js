const axios = require('axios');

function toText(v) {
    return String(v === undefined || v === null ? '' : v).trim();
}

/**
 * 发送 Webhook 通知（第一阶段仅实现该通道）。
 */
async function sendWebhookNotification(options = {}) {
    const endpoint = toText(options.endpoint);
    if (!endpoint) throw new Error('webhook endpoint 不能为空');

    const title = toText(options.title) || '账号离线提醒';
    const content = toText(options.content) || '检测到账号离线';
    const token = toText(options.token);
    const accountId = toText(options.accountId);
    const accountName = toText(options.accountName);

    const headers = {
        'Content-Type': 'application/json',
    };
    if (token) {
        // 兼容常见接收端：默认放到 Authorization 中。
        headers.Authorization = `Bearer ${token}`;
        headers['X-Token'] = token;
    }

    const body = {
        title,
        content,
        accountId,
        accountName,
        time: new Date().toISOString(),
    };

    const timeout = Math.max(1000, Number(options.timeoutMs || 10000));
    const resp = await axios.post(endpoint, body, { headers, timeout });
    return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        data: resp.data,
    };
}

module.exports = {
    sendWebhookNotification,
};
