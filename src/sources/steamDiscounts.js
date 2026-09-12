/**
 * 数据源：Steam 促销索引（折扣列表）。
 *
 * **为什么需要它**：
 *   早期只用 `specials=1` 建立"哪些 appid 曾是付费促销商品"的集合，
 *   把里面的**价格和折扣数据白白丢掉了**，导致"高折扣参考"只能靠 appdetails
 *   采样顺带得到（实测只有 4 条），用户看到的折扣数量严重偏少。
 *
 *   而这个索引本身就是一份完整的折扣清单：实测 `specials=1` 共约 **15,714** 条，
 *   每条都直接带折扣百分比、原价、现价 —— 不需要任何额外请求。
 *
 * 顺带产出（两个用途一次请求搞定）：
 *   1. 折扣条目本身（写入 store，供"高折扣参考"展示与价格/折扣区间筛选）
 *   2. `seenSpecials` 集合：这些 appid 原本是付费商品，
 *      一旦出现在免费列表里就极可能是限免候选（用于候选队列优先级）
 */
import { parseSearchResults } from '../parse.js';
import { FREE_TYPE, SOURCE } from '../model.js';

const PAGE_SIZE = 100;

export class SteamDiscountsSource {
  constructor({ http, store, config, logger }) {
    this.http = http;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.name = SOURCE.DISCOUNTS;
  }

  #url(start) {
    const { cc, lang } = this.config.steam;
    const params = new URLSearchParams({
      query: '',
      start: String(start),
      count: String(PAGE_SIZE),
      specials: '1',
      infinite: '1',
      cc,
      l: lang,
    });
    return `https://store.steampowered.com/search/results/?${params}`;
  }

  /**
   * 执行一轮：从落盘游标继续扫描促销索引。
   *
   * 扫完一整轮后等 `discountsSweepMs` 再重新开始（期间会有新的促销上架）。
   * 每轮页数由 `discountsPagesPerCycle` 控制，避免长时间占用请求配额。
   */
  async runOnce(options = {}) {
    const pages = Math.max(1, options.pages ?? this.config.steam.discountsPagesPerCycle);
    const state = this.store.getSourceState(this.name);
    const lastFull = state.completedAt ? Date.parse(state.completedAt) : 0;
    const due = Date.now() - lastFull >= this.config.steam.discountsSweepMs;

    let cursor = Number.isInteger(state.cursor) ? state.cursor : 0;
    let total = Number.isInteger(state.totalCount) ? state.totalCount : null;

    if (!due && total != null && cursor >= total) {
      return { pages: 0, skipped: 'not due', known: total, ok: true };
    }
    if (due && total != null && cursor >= total) cursor = 0; // 开始新一轮

    let pagesDone = 0;
    let rows = 0;
    let discounts = 0;
    let changes = 0;
    const errors = [];
    const specialIds = [];

    for (let i = 0; i < pages; i += 1) {
      let payload;
      try {
        payload = await this.http.json(this.#url(cursor), {
          retries: this.config.steam.searchRetries,
          timeoutMs: this.config.steam.searchTimeoutMs,
        });
      } catch (error) {
        errors.push(`start=${cursor}: ${error.message}`);
        this.logger?.debug?.(`discounts page ${cursor} failed: ${error.message}`);
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
        specialIds.push(item.appId);
        // 只收录真正在打折的条目
        if (!(item.discountPercent > 0)) continue;
        discounts += 1;
        const { event } = this.store.upsert({
          ...item,
          freeType: FREE_TYPE.DISCOUNT,
          isFree: false,
        });
        if (event) changes += 1;
      }
      cursor += PAGE_SIZE;
    }

    // 记录"曾促销"的 appid：用于候选优先级（这些原本是付费商品）
    const newSpecials = this.store.ingestSpecials(specialIds);

    const finished = total != null && cursor >= total;
    this.store.setSourceState(this.name, {
      cursor,
      totalCount: total,
      completedAt: finished ? new Date().toISOString() : state.completedAt ?? null,
      lastRunAt: new Date().toISOString(),
    });

    return {
      pages: pagesDone,
      rows,
      discounts,
      changes,
      newSpecials,
      cursor,
      total,
      finished,
      pageErrors: errors.length,
      error: errors.length ? errors[0] : null,
      ok: pagesDone > 0,
    };
  }

  /** 分页滚动来源：一轮只覆盖一部分，不能据此判定下架。 */
  get authoritative() {
    return false;
  }
}
