/**
 * 数据源 2：Steam appdetails 精确价格校验（权威判定）。
 *
 * 为什么必须单独做这一步：
 *   商店列表页无法区分"永久免费"与"限时免费"。只有 `/api/appdetails` 的
 *   `price_overview` 能给出确定答案：
 *     - is_free=true  + price_overview=null            => 永久免费 (F2P)
 *     - is_free=true  + price_overview.final=0 (100%)  => 限时免费入库 / 免费周末
 *     - is_free=false                                  => 付费（若此前是免费，则说明限免已结束）
 *
 * ⚠️ `appids` 参数只接受 **1 个** appid，传多个会返回 HTTP 400 `null`，
 *    因此只能逐个请求，并保持较低频率（默认 450ms）。
 *
 * 由于免费候选集有 6 万+ 条，采用"候选队列 + 逐步消化"策略：
 * 每轮取一批优先级最高的候选校验，直到队列排空；已校验的 appid 不再重复请求。
 */
import { FREE_TYPE, KIND, SOURCE } from '../model.js';
import { nowIso } from '../util.js';

/**
 * 根据 appdetails 的字段判定免费形态（导出以便单元测试）。
 *
 * 判定依据（全部实测确认）：
 *   - is_free=true 且无 price_overview            => 永久免费 (F2P)
 *   - is_free=true 且有 price_overview.final=0    => 限时活动（按文案区分周末/入库）
 *   - **is_free=false 但 subs 里有 is_free_license => 免费周末 / 限时体验**
 *   - is_free=false 且 discount_percent > 0       => 折扣
 *   - is_free=false 且无折扣 / 拿不到价格          => 付费（**不是**折扣）
 *
 * ⚠️ 关于"免费周末"（这是之前完全漏掉的一类）：
 *   实测 F1® 25 正在免费周末，appdetails 返回的是
 *     is_free=false, price_overview={final:17360, discount_percent:30}
 *   如果只看 price_overview，它会被误判成"30% 折扣"。
 *   真正的免费信号在购买选项里：
 *     package_groups[0].subs = [
 *       { option_text: "F1® 25 - EA Play - 免费",
 *         is_free_license: true, price_in_cents_with_discount: 0 },
 *       { option_text: "《F1® 25》：2026赛季版 - ¥248.00 ¥173.60", is_free_license: false },
 *     ]
 *
 *   为什么不能只看 is_free_license：CS2/Dota2 这类永久免费游戏的 subs 里
 *   也有 is_free_license=true。区分点是 **is_free=false + 存在免费 sub**。
 *
 * @param {{isFreeFlag: boolean, price: object|null, packageGroups?: object[]}} input
 */
export function classifyFree({ isFreeFlag, price, packageGroups }) {
  if (!price) {
    if (isFreeFlag) return FREE_TYPE.F2P;
    // is_free=false 但没有价格信息：可能是"限时体验"，检查购买选项
    if (hasFreeLicense(packageGroups)) return FREE_TYPE.WEEKEND;
    return FREE_TYPE.PAID;
  }
  if (price.final !== 0) {
    if ((price.discount_percent ?? 0) > 0) {
      // 打折的同时若存在"免费"购买选项 => 免费周末（体验期），而不是普通折扣
      if (hasFreeLicense(packageGroups)) return FREE_TYPE.WEEKEND;
      return FREE_TYPE.DISCOUNT;
    }
    return hasFreeLicense(packageGroups) ? FREE_TYPE.WEEKEND : FREE_TYPE.PAID;
  }
  const notice = String(price.price_overview_notice ?? price.discount_notice ?? '');
  if (/weekend|周末|试玩|free\s*trial|play\s*for\s*free/i.test(notice)) return FREE_TYPE.WEEKEND;
  return FREE_TYPE.KEEP;
}

/**
 * 购买选项里是否包含"免费"许可（如免费周末 / 限时体验）。
 * @param {object[]|undefined} packageGroups appdetails 的 package_groups
 */
export function hasFreeLicense(packageGroups) {
  if (!Array.isArray(packageGroups)) return false;
  for (const group of packageGroups) {
    for (const sub of group?.subs ?? []) {
      if (sub?.is_free_license === true) return true;
    }
  }
  return false;
}

export class SteamDetailsSource {
  constructor({ http, store, config, logger }) {
    this.http = http;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.name = SOURCE.DETAILS;
    this.rotation = 0;
  }

  #url(appId) {
    const { cc, lang } = this.config.steam;
    const params = new URLSearchParams({ appids: String(appId), cc, l: lang });
    return `https://store.steampowered.com/api/appdetails?${params}`;
  }

  /**
   * 挑选本轮要校验的 appid。
   *
   * 优先级设计（有意的取舍）：
   *   候选队列非空时**只消化队列**，不再顺带复核存量条目。
   *   因为 appdetails 每个请求只能查 1 个 appid，而 Steam 对同域请求限流较严，
   *   队列与复核混在一起会让候选队列几乎推不动。
   *   队列排空后（正常运转一两天内）会自动转为存量复核模式。
   */
  pickWatchlist(limit) {
    const picked = [];
    const seen = new Set();

    // 1) 候选队列：尚未判定过的免费游戏（含"原本付费"的强信号候选）
    for (const appId of this.store.peekCandidates(limit)) {
      picked.push(appId);
      seen.add(appId);
    }

    // 2) 用户显式指定的 appid 永远优先（可用于盯守已知即将限免的游戏）
    for (const id of this.config.watchlistAppIds) {
      if (picked.length >= limit) break;
      const n = Number(id);
      if (seen.has(n)) continue;
      picked.push(n);
      seen.add(n);
    }

    // 3) 队列排空时，按**类型分周期**复核：
    //    - 限时免费 / 免费周末：随时可能结束 => 短周期（watchlistIntervalMs 的一半）
    //    - 折扣：会到期 => 中等周期
    //    永久免费（F2P）**不参与复核**：一旦确认是永久免费就基本不会再变，
    //    读一次即可 —— 这是"数据治理"的核心，避免把配额浪费在不会变化的内容上。
    if (picked.length < limit) {
      const timeBound = [];
      const discounts = [];
      const recheckAfter = Math.max(60_000, this.config.steam.watchlistIntervalMs / 2);
      const discountRecheckAfter = this.config.steam.discountRecheckMs;
      if (this.config.steam.f2pRecheckMs > 0) {
        // 显式配置了 F2P 复核周期才复核（默认关闭）
        this.logger?.warn?.('已启用 F2P 周期性复核，会显著增加 appdetails 请求量');
      }
      for (const item of this.store.all()) {
        if (item.appId == null || !item.active || seen.has(item.appId)) continue;
        const ageMs = Date.now() - (item.lastVerifiedAt ? Date.parse(item.lastVerifiedAt) : 0);
        if (item.freeType === FREE_TYPE.KEEP || item.freeType === FREE_TYPE.WEEKEND) {
          if (ageMs > recheckAfter) timeBound.push({ appId: item.appId, ageMs });
        } else if (item.freeType === FREE_TYPE.DISCOUNT) {
          if (ageMs > discountRecheckAfter) discounts.push({ appId: item.appId, ageMs });
        } else if (item.freeType === FREE_TYPE.F2P && this.config.steam.f2pRecheckMs > 0
          && ageMs > this.config.steam.f2pRecheckMs) {
          discounts.push({ appId: item.appId, ageMs });
        }
      }
      timeBound.sort((a, b) => b.ageMs - a.ageMs);
      discounts.sort((a, b) => b.ageMs - a.ageMs);
      // 限免结束的确认优先级最高
      for (const c of [...timeBound, ...discounts]) {
        if (picked.length >= limit) break;
        if (seen.has(c.appId)) continue;
        picked.push(c.appId);
        seen.add(c.appId);
      }
    }

    return picked.slice(0, limit);
  }

  /** 查询单个 appid，写入 store，并返回判定结果。 */
  async verify(appId) {
    const payload = await this.http.json(this.#url(appId));
    const entry = payload?.[String(appId)];
    if (!entry || entry.success !== true || !entry.data) {
      // 数据不存在（下架/地区不可见）：从候选队列移除，避免反复请求
      this.store.resolveCandidate(appId);
      return { appId, ok: false, reason: 'no data' };
    }

    const data = entry.data;
    const price = data.price_overview ?? null;
    // 统一走 classifyFree：它同时考虑 price_overview 与 package_groups.subs，
    // 因此能识别出"免费周末"（is_free=false + 存在免费购买选项）
    const freeType = classifyFree({
      isFreeFlag: Boolean(data.is_free),
      price,
      packageGroups: data.package_groups,
    });
    const isTimeBound = freeType === FREE_TYPE.WEEKEND || freeType === FREE_TYPE.KEEP;
    const isFree = isTimeBound || (price ? price.final === 0 : Boolean(data.is_free));

    const canonical = {
      source: SOURCE.DETAILS,
      sourceId: String(appId),
      appId,
      kind: data.type === 'dlc' ? KIND.DLC : data.type === 'bundle' ? KIND.BUNDLE : KIND.GAME,
      freeType,
      title: data.name ?? `App ${appId}`,
      url: `https://store.steampowered.com/app/${appId}/`,
      image: data.header_image ?? data.capsule_image ?? null,
      description: data.short_description ?? null,
      currency: price?.currency ?? null,
      // 免费周末期间原价仍然展示（让用户看到"原价 ¥248，限时免费体验"）
      originalPrice: price?.initial ?? null,
      finalPrice: isFree ? 0 : (price?.final ?? null),
      originalPriceFormatted: price?.initial_formatted || null,
      finalPriceFormatted: isFree ? '限时免费' : (price?.final_formatted ?? null),
      discountPercent: isTimeBound ? 100 : (price?.discount_percent ?? null),
      isFree,
      /**
       * 该商品是否"原本需要付费"。
       *  - is_free=false                        => 付费商品
       *  - is_free=true 但存在 price_overview   => 原付费商品正在做限时免费活动
       *  - is_free=true 且无 price_overview     => 真正的永久免费 (F2P)
       */
      wasPaid: !data.is_free || Boolean(price && price.final === 0),
      releaseDate: data.release_date?.date ?? null,
      platforms: Object.entries(data.platforms ?? {})
        .filter(([, v]) => v)
        .map(([k]) => k),
      lastVerifiedAt: nowIso(),
      verifiedBy: SOURCE.DETAILS,
    };

    // ---------------- 结束判定 -------------------------------------------
    // 只有"确认已恢复收费"且库里此前把它当作限时免费时，才判定限免结束。
    if (!isFree && canonical.wasPaid) {
      const priors = this.store
        .getByAppId(appId)
        .filter((i) => i.source !== SOURCE.DETAILS && i.active);
      const endedOnes = priors.filter(
        (i) => i.freeType === FREE_TYPE.KEEP || i.freeType === FREE_TYPE.WEEKEND,
      );
      for (const prior of endedOnes) {
        this.store.markEnded(prior.key, `价格校验：已恢复付费（${canonical.finalPriceFormatted ?? ''}）`);
      }
      // 记录一条"已结束"的详情条目，便于前端展示历史（active=false）
      this.store.upsert({ ...canonical, active: false });
      this.store.resolveCandidate(appId);
      return { appId, ok: true, ended: endedOnes.length > 0, title: canonical.title, freeType: canonical.freeType };
    }

    const { event } = this.store.upsert(canonical);
    this.store.resolveCandidate(appId);
    return {
      appId,
      ok: true,
      ended: false,
      title: canonical.title,
      freeType,
      isFree,
      wasPaid: canonical.wasPaid,
      event: event?.type ?? null,
    };
  }

  /** 执行一轮校验。 */
  async runOnce(options = {}) {
    const limit = Math.max(1, options.batch ?? this.config.steam.watchlistBatch);
    const appIds = this.pickWatchlist(limit);
    const pass = this.store.beginPass(this.name);

    const results = {
      checked: appIds.length,
      verified: 0,
      ended: 0,
      notFound: 0,
      errors: 0,
      freeFound: 0,
      keepFound: 0,
      queueRemaining: this.store.candidates.size,
      titles: [],
    };

    for (const appId of appIds) {
      try {
        const res = await this.verify(appId);
        if (res.ok) {
          results.verified += 1;
          pass.seen.add(`${SOURCE.DETAILS}:${appId}`);
          if (res.ended) results.ended += 1;
          if (res.freeType === FREE_TYPE.KEEP) results.keepFound += 1;
          if (res.isFree) results.freeFound += 1;
          if (res.title && results.titles.length < 6) {
            results.titles.push(`${res.title}${res.freeType === FREE_TYPE.KEEP ? ' [限免]' : ''}`);
          }
        } else {
          results.notFound += 1;
        }
      } catch (error) {
        results.errors += 1;
        this.logger?.debug?.(`verify ${appId} failed: ${error.message}`);
      }
    }

    // 校验是分批轮转的，一轮只覆盖一小部分，因此不能据此判"下架"（authoritative=false，
    // tolerance 会被视为无限）。条目真正结束由 verify() 里的"恢复付费"判定显式处理。
    this.store.endPass(pass, { tolerance: 12, recordEnded: false });
    results.queueRemaining = this.store.candidates.size;
    this.store.setSourceState(this.name, {
      lastRunAt: new Date().toISOString(),
      queueRemaining: this.store.candidates.size,
    });
    return results;
  }

  /** 分批轮转，不能据此判定全部条目下架。 */
  get authoritative() {
    return false;
  }
}
