/**
 * 调度器：按各自间隔驱动多个数据源，串行执行避免请求叠加。
 *
 * 设计要点：
 *  - 每个源独立的 setTimeout 链，上一轮结束后才排下一轮（不会重叠）
 *  - 单源失败只记录状态，不影响其它源
 *  - 支持手动触发（前端"立即刷新"）与 --once 模式
 */
import { nowIso } from './util.js';
import { SOURCE } from './model.js';
import { SteamCatalogSource } from './sources/steamCatalog.js';
import { SteamDetailsSource } from './sources/steamDetails.js';
import { SteamSpotlightSource } from './sources/steamSpotlight.js';
import { SteamDiscountsSource } from './sources/steamDiscounts.js';
import { GamerPowerSource } from './sources/gamerpower.js';

export class Poller {
  /**
   * @param {{http: object, store: object, config: object, logger: object}} deps
   */
  constructor({ http, store, config, logger }) {
    this.http = http;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.stopped = false;
    /** @type {Map<string, {source: object, intervalMs: number, enabled: boolean, nextRunAt: number|null, running: boolean, runs: number, timers: any[]}>} */
    this.entries = new Map();
    this.running = Promise.resolve();
    this.#register();
  }

  #register() {
    const { steam, enabled, gamerpower } = this.config;

    if (enabled.steamSpecials) {
      this.add(new SteamCatalogSource({ http: this.http, store: this.store, config: this.config, logger: this.logger.child?.('catalog') ?? this.logger }), {
        intervalMs: steam.sweepIntervalMs,
      });
    }
    // 促销索引：完整的折扣清单（实测约 1.57 万条），
    // 顺带建立"曾促销"集合并给出折扣/价格数据
    if (enabled.steamDiscounts) {
      this.add(new SteamDiscountsSource({ http: this.http, store: this.store, config: this.config, logger: this.logger.child?.('discounts') ?? this.logger }), {
        intervalMs: steam.discountsIntervalMs,
      });
    }
    if (enabled.steamWatchlist) {
      this.add(new SteamDetailsSource({ http: this.http, store: this.store, config: this.config, logger: this.logger.child?.('details') ?? this.logger }), {
        intervalMs: steam.watchlistIntervalMs,
      });
    }
    if (enabled.gamerpower) {
      this.add(new GamerPowerSource({ http: this.http, store: this.store, config: this.config, logger: this.logger.child?.('gamerpower') ?? this.logger }), {
        intervalMs: gamerpower.intervalMs,
      });
    }
    // 精选活动源：免费周末是"订阅制限时体验"，**不会进入免费候选集**，
    // 只能从商店精选位发现（详见 steamSpotlight.js）
    if (enabled.steamSpotlight) {
      this.add(new SteamSpotlightSource({ http: this.http, store: this.store, config: this.config, logger: this.logger.child?.('spotlight') ?? this.logger }), {
        intervalMs: steam.spotlightIntervalMs,
      });
    }
  }

  add(source, { intervalMs, enabled = true }) {
    this.entries.set(source.name, {
      source,
      intervalMs,
      enabled,
      nextRunAt: null,
      running: false,
      runs: 0,
      lastResult: null,
      lastDurationMs: null,
      timers: [],
    });
  }

  get size() {
    return this.entries.size;
  }

  /**
   * 执行一个源的一轮抓取。
   * @param {string} name
   * @param {object} [options] 透传给数据源（例如 { pages: 40 }）
   */
  async runSource(name, options = undefined) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`unknown source: ${name}`);
    if (entry.running) return { skipped: true, reason: 'already running' };

    entry.running = true;
    const started = Date.now();
    try {
      const result = await entry.source.runOnce(options);
      const durationMs = Date.now() - started;
      entry.runs += 1;
      entry.lastDurationMs = durationMs;
      // 数据源可以返回 ok:false 表示"整轮都没抓到"（例如目标站点不可达），
      // 这必须显式标记为失败，否则网络故障会被误判成"没有新内容"。
      const ok = result?.ok !== false;
      entry.lastResult = { ok, ...result, at: nowIso() };
      this.store.recordSourceResult(name, {
        ok,
        count: result?.count ?? result?.verified ?? result?.changes ?? 0,
        durationMs,
        error: ok ? null : result?.error ?? 'no data fetched',
      });
      const detail = Object.entries(result ?? {})
        .filter(([k]) => !['seenKeys', 'items', 'titles', 'errors'].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      if (ok) this.logger.info(`${name}: ok in ${durationMs}ms ${detail}`);
      else this.logger.warn(`${name}: 本轮未取得任何数据 (${result?.error ?? 'unknown'}) ${detail}`);
      return entry.lastResult;
    } catch (error) {
      const durationMs = Date.now() - started;
      entry.lastResult = { ok: false, error: String(error?.message ?? error), at: nowIso() };
      this.store.recordSourceResult(name, { ok: false, error: error?.message, durationMs });
      this.logger.error(`${name}: failed in ${durationMs}ms :: ${error?.message ?? error}`);
      return entry.lastResult;
    } finally {
      entry.running = false;
    }
  }

  /** 依次执行全部启用的源（避免并发抓取同一域名）。 */
  async runAll(options = {}) {
    const results = {};
    for (const [name, entry] of this.entries) {
      if (!entry.enabled) continue;
      results[name] = await this.runSource(name, options[name]);
    }
    return results;
  }

  #schedule(name, { immediate = false, delayMs }) {
    const entry = this.entries.get(name);
    if (!entry || this.stopped || !entry.enabled) return;
    const delay = immediate ? 0 : delayMs ?? entry.intervalMs;
    entry.nextRunAt = Date.now() + delay;
    const timer = setTimeout(async () => {
      if (this.stopped) return;
      try {
        await this.runSource(name);
      } finally {
        this.#schedule(name, { delayMs: entry.intervalMs });
      }
    }, delay);
    timer.unref?.();
    entry.timers.push(timer);
  }

  /**
   * 启动所有源。
   * @param {{initialDelayMs?: number}} [options]
   */
  start({ initialDelayMs = 0 } = {}) {
    this.stopped = false;
    let index = 0;
    for (const [name, entry] of this.entries) {
      if (!entry.enabled) continue;
      // 各源错开启动，避免同一时刻并发请求 Steam
      this.#schedule(name, { delayMs: initialDelayMs + index * 1500 });
      index += 1;
    }
    this.logger.info(`poller started with ${this.entries.size} source(s)`);
  }

  async stop() {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      for (const t of entry.timers) clearTimeout(t);
      entry.timers = [];
    }
  }

  /** 供 /api/status 使用。 */
  status() {
    const sources = [];
    for (const [name, entry] of this.entries) {
      sources.push({
        name,
        enabled: entry.enabled,
        intervalMs: entry.intervalMs,
        running: entry.running,
        runs: entry.runs,
        lastDurationMs: entry.lastDurationMs,
        nextRunAt: entry.nextRunAt ? new Date(entry.nextRunAt).toISOString() : null,
        lastResult: entry.lastResult ? { ...entry.lastResult, seenKeys: undefined, titles: entry.lastResult.titles ?? undefined } : null,
        stats: this.store.getSourceStats(name),
      });
    }
    return sources;
  }
}

export { SOURCE };
