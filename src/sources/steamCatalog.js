/**
 * 数据源 1：Steam 商店免费候选集滚动扫描。
 *
 * 只做一件事：滚动扫描免费候选集 `maxprice=free`（实测约 6.4 万条），
 * 把每个出现在免费列表里的 appid 登记进候选队列，等待 steam-details 用
 * appdetails 精确校验。列表页本身无法区分"永久免费"与"限时免费"，
 * 所以这里只负责**发现**，不做任何判定。
 *
 * 注：早期版本还在这里顺手扫 `specials=1` 促销索引，用来建立"曾作为付费商品
 * 打折过"的 appid 集合。那个职责已经拆给独立的 steam-discounts 源
 * （见 sources/steamDiscounts.js）—— 它同时承担折扣清单，不再重复请求同一批页面。
 *
 * 扫描游标会落盘，因此可以跨重启持续推进，不会每次从头开始。
 * 候选队列排空前会持续消化；这也是本项目"越跑越准"的关键机制。
 */
import { parseSearchResults } from '../parse.js';
import { sleep } from '../util.js';
import { SOURCE } from '../model.js';

const PAGE_SIZE = 100;
/**
 * 评测数据在免费候选集里的可用范围（实测）：前约 1.2 万条页面有评测
 * （start=12000 有 99/100，start=20000 只剩 3/100）。
 * 回填只扫这一段，避免把配额浪费在没有评测的尾部。
 */
const REVIEW_SCAN_LIMIT = 14000;
/** 回填时每页之间的额外间隔：主动让出配额，避免把主扫描挤到限流 */
const BACKFILL_PAGE_GAP_MS = 800;
/** 回填遇到错误时的退避时间 */
const BACKFILL_BACKOFF_MS = 5000;

export class SteamCatalogSource {
  constructor({ http, store, config, logger }) {
    this.http = http;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.name = SOURCE.CATALOG;
    /** 搜索页容忍度更高：Steam 偶发连接超时，多试几次比丢页更划算 */
    this.retries = config.steam.searchRetries;
  }

  /** 带重试的搜索请求。 */
  #search(url) {
    return this.http.json(url, { retries: this.retries, timeoutMs: this.config.steam.searchTimeoutMs });
  }

  #searchUrl({ start, maxprice, specials, sortBy }) {
    const { cc, lang } = this.config.steam;
    const params = new URLSearchParams({
      query: '',
      start: String(start),
      count: String(PAGE_SIZE),
      sort_by: sortBy,
      infinite: '1',
      cc,
      l: lang,
    });
    if (maxprice) params.set('maxprice', maxprice);
    if (specials) params.set('specials', '1');
    return `https://store.steampowered.com/search/results/?${params}`;
  }

  /** A) 抓取免费候选集的若干页，登记候选并写入 store。 */
  async #sweepFree(pages) {
    const state = this.store.getSourceState(this.name);
    let cursor = Number.isInteger(state.cursor) ? state.cursor : 0;
    let total = Number.isInteger(state.totalCount) ? state.totalCount : null;

    let pagesDone = 0;
    let rows = 0;
    let changes = 0;
    let demosSkipped = 0;
    const errors = [];

    for (let i = 0; i < pages; i += 1) {
      if (total != null && cursor >= total) cursor = 0; // 到底后回到开头
      let payload;
      try {
        payload = await this.#search(
          this.#searchUrl({ start: cursor, maxprice: 'free', sortBy: 'Price_ASC' }),
        );
      } catch (error) {
        errors.push(`start=${cursor}: ${error.message}`);
        this.logger?.debug?.(`free page ${cursor} failed: ${error.message}`);
        break;
      }
      pagesDone += 1;
      if (Number.isInteger(payload?.total_count)) total = payload.total_count;

      const items = parseSearchResults(payload?.results_html, { source: this.name });
      if (!items.length) {
        cursor = total ?? cursor + PAGE_SIZE;
        break;
      }

      for (const item of items) {
        rows += 1;
        // 试玩版/Demo/序章不是用户要找的"限时免费完整游戏"：
        // 既不登记候选（省下大量 appdetails 配额），也不计入条目统计噪声。
        if (item.isDemo) {
          demosSkipped += 1;
          continue;
        }
        // 登记候选：data-price-final 在此列表里并不可靠（仅作提示），
        // 评论数则能反映游戏分量，用于把知名游戏的校验排在前面。
        // store 内部会对"最近已校验过"的 appid 去重，避免重复抓取。
        this.store.enqueueCandidate(item.appId, {
          special: this.store.seenSpecials.has(item.appId),
          hint: item.raw?.finalPriceAttr ?? 0,
          reviews: item.reviewCount ?? 0,
        });
        const { event } = this.store.upsert(item);
        if (event) changes += 1;
      }
      cursor += PAGE_SIZE;
    }

    this.store.setSourceState(this.name, {
      cursor,
      totalCount: total,
      freeLastRunAt: new Date().toISOString(),
    });
    return { pages: pagesDone, rows, changes, cursor, total, demosSkipped, errors };
  }

  async runOnce(options = {}) {
    const pages = Math.max(1, options.pages ?? this.config.steam.sweepPagesPerCycle);
    const free = await this.#sweepFree(pages);

    return {
      pages: free.pages,
      rows: free.rows,
      changes: free.changes,
      demosSkipped: free.demosSkipped ?? 0,
      cursor: free.cursor,
      total: free.total,
      knownSpecials: this.store.seenSpecials.size,
      candidates: this.store.candidates.size,
      pageErrors: (free.errors ?? []).length,
      error: free.errors?.length ? free.errors[0] : null,
      /** 一页都没成功 => 整轮失败，交由调度器标记异常并重试 */
      ok: free.pages > 0,
    };
  }

  /**
   * 评价字段回填。
   *
   * 背景（实测）：Steam 只在免费候选集的**前约 1.2 万条**页面上返回评测信息
   * （start=12000 时 100 条里 99 条有评测；start=20000 时只剩 3 条）。
   * 主扫描游标是单调推进的，等它绕回开头要很久；而早期版本又没把评价写进存档，
   * 所以历史条目的评价是空的。
   *
   * 因此这里用**独立游标**从头扫一遍，只补评价字段：
   * 不推进主游标、不登记候选，避免干扰正常采集节奏。
   *
   * @param {number} maxPages 本轮最多扫多少页
   */
  async backfillReviews(maxPages) {
    const state = this.store.getSourceState(this.name);
    let cursor = Number.isInteger(state.reviewCursor) ? state.reviewCursor : 0;
    let total = Number.isInteger(state.totalCount) ? state.totalCount : null;
    const scanLimit = Math.min(REVIEW_SCAN_LIMIT, total ?? REVIEW_SCAN_LIMIT);

    let pages = 0;
    let updated = 0;
    let done = false;
    let emptyStreak = 0;
    let consecutiveErrors = 0;
    const errors = [];

    while (pages < maxPages && cursor < scanLimit) {
      let payload;
      try {
        payload = await this.http.json(
          this.#searchUrl({ start: cursor, maxprice: 'free', sortBy: 'Price_ASC' }),
          { retries: this.config.steam.searchRetries, timeoutMs: this.config.steam.searchTimeoutMs },
        );
        consecutiveErrors = 0;
      } catch (error) {
        // 回填是后台任务，遇到限流/网络抖动不该整体中断：
        // 1) 先让出配额（下面的 sleep）
        // 2) 连续多次失败才放弃，等下一轮（12 小时后）继续
        consecutiveErrors += 1;
        errors.push(`start=${cursor}: ${error.message}`);
        this.logger?.debug?.(`review backfill page ${cursor} failed: ${error.message}`);
        if (consecutiveErrors >= 3) break;
        await sleep(BACKFILL_BACKOFF_MS);
        continue;
      }
      pages += 1;
      if (Number.isInteger(payload?.total_count)) total = payload.total_count;

      const items = parseSearchResults(payload?.results_html, { source: this.name });
      if (!items.length) { done = true; break; }

      let hit = 0;
      for (const item of items) {
        if (!item.reviewSummary && !item.reviewCount) continue;
        this.store.upsert(item); // upsert 用 ?? 语义补齐缺失的评价字段，不会覆盖已有值
        hit += 1;
      }
      updated += hit;
      cursor += PAGE_SIZE;

      // 连续几页都没有评测数据 => 已越过可用区间
      emptyStreak = hit === 0 ? emptyStreak + 1 : 0;
      if (emptyStreak >= 3) { done = true; break; }

      // 主动让出配额：回填不是紧急任务，避免把主扫描挤到限流
      await sleep(BACKFILL_PAGE_GAP_MS);
    }

    if (cursor >= scanLimit) done = true;
    this.store.setSourceState(this.name, {
      // 只有真正扫完才重置游标；否则下次从断点继续
      reviewCursor: done ? 0 : cursor,
      reviewDoneAt: done ? new Date().toISOString() : state.reviewDoneAt ?? null,
      reviewLastRunAt: new Date().toISOString(),
    });

    return { pages, updated, cursor, done, errors: errors.length, error: errors[0] ?? null };
  }

  /** 分页滚动来源，一轮只覆盖一部分，永不据此判定下架。 */
  get authoritative() {
    return false;
  }
}
