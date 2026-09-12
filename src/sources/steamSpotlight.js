/**
 * 数据源：Steam 商店精选位（featuredcategories spotlights）。
 *
 * **为什么必须有这个源**：
 *   免费周末的游戏是**订阅制限时体验**（例如 F1® 25 通过 EA Play 免费玩），
 *   它不会进入 `search?maxprice=free` 免费候选集（实测确认：F1® 25 完全不在
 *   那个 6.4 万条的列表里）。因此无论候选扫描跑多久，都**永远发现不了免费周末**。
 *
 * 而 `featuredcategories` 的 spotlight 位里，Steam 自己会给出当前的活动条目：
 *
 *   {
 *     "name": "免费周末",
 *     "body": "优惠截止时间：%1$s",
 *     "url": "https://store.steampowered.com/app/3059520"   <- 直接就是 appid
 *   }
 *
 * 所以这里把 spotlight 里指向 app 的条目按名称映射成活动类型：
 *   - 免费周末        -> FREE_TYPE.WEEKEND
 *   - 限时免费 / 免费入库 -> FREE_TYPE.KEEP
 *   - 周末特惠 / 特卖等 -> 忽略（只是折扣活动，不是免费）
 *
 * 拿到 appid 后再用 appdetails 补齐名称、图片、价格等信息。
 */
import { FREE_TYPE, KIND, SOURCE } from '../model.js';
import { nowIso } from '../util.js';

/** spotlight 名称 -> 免费形态。只有"免费"类的才处理。 */
const SPOTLIGHT_KINDS = [
  { re: /免费周末|free\s*weekend/i, freeType: FREE_TYPE.WEEKEND },
  { re: /限时免费|免费入库|free\s*to\s*keep/i, freeType: FREE_TYPE.KEEP },
  { re: /免费试玩|试玩|free\s*trial|play\s*for\s*free/i, freeType: FREE_TYPE.WEEKEND },
];

export class SteamSpotlightSource {
  constructor({ http, store, config, logger }) {
    this.http = http;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.name = SOURCE.SPOTLIGHT;
  }

  #feedUrl() {
    const { cc, lang } = this.config.steam;
    return `https://store.steampowered.com/api/featuredcategories/?cc=${cc}&l=${lang}`;
  }

  #appDetailsUrl(appId) {
    const { cc, lang } = this.config.steam;
    return `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&l=${lang}`;
  }

  /** 从 featuredcategories 的 spotlight 区块提取"免费类"活动。 */
  static extractFreeSpotlights(feed) {
    const out = [];
    if (!feed || typeof feed !== 'object') return out;
    for (const value of Object.values(feed)) {
      if (!value || typeof value !== 'object') continue;
      for (const item of value.items ?? []) {
        const label = String(item?.name ?? '');
        const url = String(item?.url ?? '');
        const m = url.match(/store\.steampowered\.com\/app\/(\d+)/);
        if (!m) continue; // 指向特卖页的忽略
        const kind = SPOTLIGHT_KINDS.find((k) => k.re.test(label));
        if (!kind) continue;
        out.push({ appId: Number.parseInt(m[1], 10), label, freeType: kind.freeType, image: item.header_image ?? null });
      }
    }
    // 同一个 app 可能出现在多个 spotlight 位，按 appId 去重（优先保留 keep）
    const byId = new Map();
    for (const s of out) {
      const prev = byId.get(s.appId);
      if (!prev || (prev.freeType !== FREE_TYPE.KEEP && s.freeType === FREE_TYPE.KEEP)) byId.set(s.appId, s);
    }
    return [...byId.values()];
  }

  /**
   * 执行一轮：读精选位 -> 对每个免费活动 app 查一次 appdetails -> 写入 store。
   */
  async runOnce() {
    const feed = await this.http.json(this.#feedUrl(), { retries: this.config.steam.searchRetries });
    const spotlights = SteamSpotlightSource.extractFreeSpotlights(feed);

    const pass = this.store.beginPass(this.name);
    const results = { found: spotlights.length, verified: 0, errors: 0, items: [], labels: [] };

    for (const spot of spotlights) {
      try {
        const payload = await this.http.json(this.#appDetailsUrl(spot.appId), { retries: 2, timeoutMs: 20000 });
        const data = payload?.[String(spot.appId)]?.data;
        if (!data) {
          results.errors += 1;
          continue;
        }
        const price = data.price_overview ?? null;
        const isFree = spot.freeType === FREE_TYPE.WEEKEND || spot.freeType === FREE_TYPE.KEEP
          || (price ? price.final === 0 : Boolean(data.is_free));

        const item = {
          source: this.name,
          sourceId: String(spot.appId),
          appId: spot.appId,
          kind: data.type === 'dlc' ? KIND.DLC : KIND.GAME,
          freeType: spot.freeType,
          title: data.name ?? `App ${spot.appId}`,
          url: `https://store.steampowered.com/app/${spot.appId}/`,
          image: data.header_image ?? spot.image ?? null,
          description: data.short_description ?? null,
          currency: price?.currency ?? null,
          originalPrice: price?.initial ?? null,
          finalPrice: 0,
          originalPriceFormatted: price?.initial_formatted || null,
          finalPriceFormatted: spot.freeType === FREE_TYPE.WEEKEND ? '免费周末' : '限时免费',
          discountPercent: 100,
          isFree,
          // 精选位自带活动名称（"免费周末"），作为来源标记
          spotLabel: spot.label,
          startsAt: nowIso(),
          releaseDate: data.release_date?.date ?? null,
          lastVerifiedAt: nowIso(),
          verifiedBy: this.name,
        };

        this.store.upsert(item);
        pass.seen.add(`${this.name}:${spot.appId}`);
        results.verified += 1;
        if (results.labels.length < 8) results.labels.push(`${spot.label}: ${item.title}`);
      } catch (error) {
        results.errors += 1;
        this.logger?.debug?.(`spotlight ${spot.appId} failed: ${error.message}`);
      }
    }

    // 精选位是完整列表：本轮消失的活动说明已经结束
    const { ended } = this.store.endPass(pass, { tolerance: 2, authoritative: true });
    this.store.setSourceState(this.name, { lastRunAt: nowIso(), lastFound: spotlights.length });
    return { ...results, ended };
  }

  /** 精选位是完整列表，未出现即表示活动结束。 */
  get authoritative() {
    return true;
  }
}
