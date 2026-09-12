/**
 * 限流 + 重试的 HTTP 客户端。
 *
 * 实测 Steam 商店从本机访问存在间歇性连接超时，因此这里必须做到：
 *  - 按 host 串行化并强制最小请求间隔（礼貌抓取，避免被封）
 *  - 失败自动重试，指数退避 + 抖动
 *  - 每次请求独立超时
 *  - 复用连接（keep-alive）
 */
import { backoffDelay, sleep } from './util.js';
import { explainNetworkError } from './net.js';

/** 简易串行队列：保证同一 host 上的请求不会并发，并遵守最小间隔。 */
class HostQueue {
  /**
   * @param {() => number} getInterval 动态读取当前间隔（便于限流降速后自我恢复）
   */
  constructor(getInterval) {
    this.getInterval = getInterval;
    this.chain = Promise.resolve();
    this.lastStart = 0;
  }

  run(task) {
    const result = this.chain.then(async () => {
      const wait = this.getInterval() - (Date.now() - this.lastStart);
      if (wait > 0) await sleep(wait);
      this.lastStart = Date.now();
      return task();
    });
    // 队列本身不因单个任务失败而中断
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = String(body ?? '').slice(0, 300);
    /** 网络层错误（可重试）还是 HTTP 状态错误 */
    this.retryable = status === 0 || status === 408 || status === 429 || status >= 500;
  }
}

export class HttpClient {
  /**
   * @param {object} options
   * @param {number} [options.minIntervalMs] 同 host 请求最小间隔
   * @param {number} [options.timeoutMs]
   * @param {number} [options.retries] 额外重试次数
   * @param {object} [options.headers]
   * @param {object} [options.logger]
   */
  constructor({ minIntervalMs = 800, timeoutMs = 20000, retries = 3, headers = {}, logger } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.timeoutMs = timeoutMs;
    this.retries = Math.max(0, retries);
    this.headers = headers;
    this.logger = logger;
    /** @type {Map<string, HostQueue>} */
    this.queues = new Map();
    /** 统计信息，供 /api/status 展示 */
    this.stats = { requests: 0, ok: 0, failed: 0, retries: 0, rateLimited: 0, lastError: null, lastSuccessAt: null };
    /** 独立间隔覆盖（例如 appdetails 需要更慢的节奏） */
    this.intervalOverrides = new Map();
    /** 基础间隔（自适应恢复的下界） */
    this.baseIntervals = new Map();
    /** 每 host 的连续成功计数，用于逐步恢复速度 */
    this.successStreak = new Map();
  }

  /** 覆盖某个 host 的最小间隔。 */
  setHostInterval(host, ms) {
    this.intervalOverrides.set(host, ms);
    this.baseIntervals.set(host, ms);
    this.queues.delete(host);
  }

  queueFor(url) {
    const host = new URL(url).host;
    let q = this.queues.get(host);
    if (!q) {
      q = new HostQueue(() => this.intervalFor(host));
      this.queues.set(host, q);
    }
    return q;
  }

  /** 当前某 host 的实际请求间隔。 */
  intervalFor(host) {
    return this.intervalOverrides.get(host) ?? this.minIntervalMs;
  }

  /**
   * 被限流后适度降速。
   *
   * 关键点：必须"温和升、逐步降"。
   * 早期实现每次 429 都 ×1.6 且永不恢复，实测在 Steam 上会一路飙升到 7.5s/请求，
   * 导致候选队列几乎无法推进。这里改为：
   *   - 每次限流只小幅上调（×1.25），上限 RATE_LIMIT_CAP_MS
   *   - 连续成功若干次后按比例回落，最低回到基础间隔
   */
  slowDown(url, { factor = 1.25, capMs = 2000 } = {}) {
    const host = new URL(url).host;
    const base = this.baseIntervals.get(host) ?? this.minIntervalMs;
    const current = this.intervalFor(host);
    const next = Math.min(capMs, Math.max(base, Math.round(current * factor)));
    this.intervalOverrides.set(host, next);
    this.successStreak.set(host, 0);
    if (next !== current) this.logger?.warn?.(`limiter slowed for ${host}: ${current}ms -> ${next}ms`);
  }

  /** 请求成功后尝试逐步恢复速度（每 15 次成功回落 10%）。 */
  #recover(url) {
    const host = new URL(url).host;
    const base = this.baseIntervals.get(host) ?? this.minIntervalMs;
    const current = this.intervalFor(host);
    if (current <= base) return;
    const streak = (this.successStreak.get(host) ?? 0) + 1;
    this.successStreak.set(host, streak);
    if (streak % 15 !== 0) return;
    const next = Math.max(base, Math.round(current * 0.9));
    if (next !== current) {
      this.intervalOverrides.set(host, next);
      this.logger?.debug?.(`limiter recovered for ${host}: ${current}ms -> ${next}ms`);
    }
  }

  /**
   * 发起请求。
   * @param {string} url
   * @param {object} [options]
   * @param {'json'|'text'|'buffer'} [options.as]
   * @param {number} [options.retries]
   * @param {object} [options.headers]
   * @param {string} [options.method]
   * @param {string} [options.body]
   * @returns {Promise<any>}
   */
  async request(url, options = {}) {
    const {
      as = 'text',
      retries = this.retries,
      headers = {},
      method = 'GET',
      body,
      timeoutMs = this.timeoutMs,
      acceptStatus = null,
    } = options;

    const queue = this.queueFor(url);
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        this.stats.retries += 1;
        await sleep(backoffDelay(attempt));
      }
      try {
        const value = await queue.run(() => this.#once(url, { as, headers, method, body, timeoutMs, acceptStatus }));
        this.stats.ok += 1;
        this.stats.lastSuccessAt = new Date().toISOString();
        this.#recover(url);
        return value;
      } catch (error) {
        lastError = error;
        if (!(error instanceof HttpError) || !error.retryable || attempt === retries) break;
        if (error.status === 429) {
          this.stats.rateLimited += 1;
          this.slowDown(url);
        }
        this.logger?.debug?.(`retry ${attempt + 1}/${retries} ${url} :: ${error.message}`);
      }
    }

    this.stats.failed += 1;
    const explained = explainNetworkError(lastError?.message ?? lastError);
    this.stats.lastError = { url, message: explained, at: new Date().toISOString() };
    throw lastError;
  }

  async #once(url, { as, headers, method, body, timeoutMs, acceptStatus }) {
    this.stats.requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          accept: as === 'json' ? 'application/json, text/plain, */*' : 'text/html,application/json,*/*',
          'accept-encoding': 'gzip, deflate, br',
          ...this.headers,
          ...headers,
        },
      });
    } catch (cause) {
      clearTimeout(timer);
      const reason = cause?.cause?.code ?? cause?.name ?? 'unknown';
      throw new HttpError(`network failure (${reason})`, { status: 0, url });
    }
    clearTimeout(timer);

    if (!response.ok) {
      const extra = acceptStatus?.includes(response.status);
      if (!extra) {
        const text = await response.text().catch(() => '');
        throw new HttpError(`HTTP ${response.status}`, { status: response.status, url, body: text });
      }
    }

    if (as === 'buffer') return Buffer.from(await response.arrayBuffer());
    const text = await response.text();
    if (as === 'json') {
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError('invalid JSON response', { status: response.status, url, body: text });
      }
    }
    return text;
  }

  async json(url, options) {
    return this.request(url, { ...options, as: 'json' });
  }

  async text(url, options) {
    return this.request(url, { ...options, as: 'text' });
  }
}
