/**
 * SSE（Server-Sent Events）实时推送中心。
 *
 * 选 SSE 而不是 WebSocket 的原因：
 *  - 只需要服务端 -> 客户端单向推送
 *  - 原生 EventSource 自动重连，前端零依赖
 *  - 走普通 HTTP，无需额外握手与协议实现
 *
 * 推送内容：
 *  - hello     : 连接建立，附带服务器时间
 *  - snapshot  : 首次连接时的轻量统计
 *  - item      : 有数据变更（批量去抖动后发送变化的 key）
 *  - event     : 具体变更事件（新发现 / 转免 / 降价 / 结束）
 *  - heartbeat : 保活注释，防止中间层断开连接
 */
export class RealtimeHub {
  /** @param {{logger?: object, heartbeatMs?: number, batchMs?: number}} [options] */
  constructor({ logger, heartbeatMs = 25_000, batchMs = 700 } = {}) {
    this.logger = logger;
    this.heartbeatMs = heartbeatMs;
    this.batchMs = batchMs;
    /** @type {Set<{id: number, res: import('node:http').ServerResponse}>} */
    this.clients = new Set();
    this.nextId = 1;
    /** @type {Set<string>} 待推送的变更 key */
    this.pendingKeys = new Set();
    this.batchTimer = null;
    this.heartbeat = setInterval(() => this.#broadcastComment('ping'), heartbeatMs);
    this.heartbeat.unref?.();
    this.stats = { totalConnections: 0, eventsSent: 0 };
  }

  get size() {
    return this.clients.size;
  }

  /**
   * 接管一个 HTTP 响应，转为 SSE 连接。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {object} [initial] 首帧附带数据
   */
  attach(req, res, initial = {}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const client = { id: this.nextId++, res };
    this.clients.add(client);
    this.stats.totalConnections += 1;

    this.#sendTo(client, 'hello', { clientId: client.id, serverTime: new Date().toISOString(), ...initial });
    this.logger?.debug?.(`sse client #${client.id} connected (total ${this.clients.size})`);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      this.clients.delete(client);
      this.logger?.debug?.(`sse client #${client.id} disconnected (total ${this.clients.size})`);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
    return client.id;
  }

  #sendTo(client, event, data) {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      this.stats.eventsSent += 1;
    } catch (error) {
      this.logger?.debug?.(`sse write failed: ${error.message}`);
      this.clients.delete(client);
    }
  }

  #broadcastComment(text) {
    for (const client of this.clients) {
      try {
        client.res.write(`: ${text}\n\n`);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  broadcast(event, data) {
    for (const client of [...this.clients]) this.#sendTo(client, event, data);
  }

  /** 广播单条变更事件。 */
  emitEvent(event) {
    this.broadcast('event', event);
  }

  /** 标记条目变更，去抖动后批量推送 key 列表。 */
  touch(key) {
    this.pendingKeys.add(key);
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      const keys = [...this.pendingKeys];
      this.pendingKeys.clear();
      if (keys.length) this.broadcast('item', { keys, at: new Date().toISOString() });
    }, this.batchMs);
    this.batchTimer.unref?.();
  }

  close() {
    clearInterval(this.heartbeat);
    if (this.batchTimer) clearTimeout(this.batchTimer);
    for (const client of [...this.clients]) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}

/**
 * Webhook 通知插件（Discord / Slack / 通用 JSON）。
 * 只在"值得打扰用户"的事件上触发。
 */
export function attachWebhook({ store, config, logger }) {
  const url = config.webhookUrl;
  if (!url) return { enabled: false };
  let target;
  try {
    target = new URL(url);
  } catch {
    logger?.warn?.(`WEBHOOK_URL 无效，已忽略: ${url}`);
    return { enabled: false };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    logger?.warn?.('WEBHOOK_URL 协议必须是 http/https，已忽略');
    return { enabled: false };
  }

  const interesting = new Set(['discovered', 'became_free', 'price_drop']);
  let sent = 0;

  store.on('event', async (event) => {
    if (!interesting.has(event.type)) return;
    if (!event.isFreebie && event.type !== 'price_drop') return;
    const text = [
      `【${event.type === 'became_free' ? '刚刚限免' : event.type === 'discovered' ? '新发现' : '降价'}】${event.title}`,
      event.originalPriceFormatted ? `原价 ${event.originalPriceFormatted}` : null,
      event.discountPercent ? `-${event.discountPercent}%` : null,
      event.url,
    ]
      .filter(Boolean)
      .join(' | ');

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text, text, event }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      sent += 1;
    } catch (error) {
      logger?.debug?.(`webhook 推送失败: ${error.message}`);
    }
  });

  return { enabled: true, get sent() { return sent; } };
}
