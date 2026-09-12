/**
 * 内存数据仓库 + 变更检测 + 原子落盘。
 *
 * 这是"实时推送"的核心：每次数据源返回条目后交给 upsert()，
 * 由它比对历史状态，产生 discovered / price_drop / became_free / ended 事件。
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { EVENT, FREE_TYPE, KIND, SOURCE, itemKey, normalizeItem, priorityOf, watchScore } from './model.js';
import { nowIso } from './util.js';

const MAX_EVENTS = 800;
const STATE_VERSION = 1;
/** 落盘去抖动：状态是缓存性质，把同步序列化的开销摊薄 */
const SAVE_DEBOUNCE_MS = 45000;
/** 周期性自动落盘间隔：保证长时间运行后重启不丢进度 */
const AUTO_SAVE_INTERVAL_MS = 60000;
/**
 * 已校验条目的"免检期"（按类型区分）。
 *
 * 这是"数据治理"的核心：不同类型的内容变化速度差了几个数量级，
 * 用同一个周期复核要么浪费配额、要么漏掉变化。
 *
 *   - 永久免费（F2P）：一旦确认是永久免费，**基本不会再变**
 *     => 只读一次（用超长周期表达"不再复核"）
 *   - 限时免费 / 免费周末：随时可能结束 => 短周期
 *   - 折扣：会到期 => 中等周期
 */
const VERIFY_TTL_F2P_MS = 180 * 24 * 60 * 60 * 1000; // 180 天 ≈ 不再复核
const VERIFY_TTL_DISCOUNT_MS = 6 * 60 * 60 * 1000; // 6 小时（折扣会过期）
const VERIFY_TTL_TIMEBOUND_MS = 15 * 60 * 1000; // 15 分钟（限免会结束）

/**
 * 是否值得为该候选花费一次 appdetails 请求（"分诊"）。
 *
 * 背景（实测）：队列里 40869 个候选中，31089 个是"完全没有信号"的冷门条目
 * ——它们没有评论数、没有价格提示、也从未出现在促销索引里。
 * 这类条目几乎必然是永久免费小游戏，逐个校验约要花 3.9 小时配额，
 * 收益近乎为零。
 *
 * 值得校验的是：
 *   - special：曾出现在促销索引 => 基本可确定是付费商品（限免候选）
 *   - hint   ：列表页给出了非零价格 => 可能原本收费
 *   - reviews：有评测说明是正式游戏，变化值得关注
 *
 * 被跳过的候选会记在队列里（skip 标记），若之后出现更强信号可以重新激活。
 */
function shouldVerifyCandidate({ special, hint, reviews }) {
  if (special) return true;
  if ((hint ?? 0) > 0) return true;
  if ((reviews ?? 0) > 0) return true;
  return false;
}

/** 判定是否为限时免费的"更重要"形态（用于识别升级/降级）。 */
const TYPE_RANK = {
  [FREE_TYPE.KEY]: 1,
  [FREE_TYPE.DISCOUNT]: 2,
  [FREE_TYPE.F2P]: 3,
  [FREE_TYPE.WEEKEND]: 4,
  [FREE_TYPE.KEEP]: 5,
};

/** 活跃度：连续多少轮未命中才判定下架 */
const MISS_TOLERANCE = 3;

export class Store extends EventEmitter {
  /** @param {{dataDir: string, logger?: object}} options */
  constructor({ dataDir, logger } = {}) {
    super();
    this.setMaxListeners(0);
    this.dataDir = dataDir;
    this.logger = logger;
    /** @type {Map<string, object>} */
    this.items = new Map();
    /** @type {Map<number, Set<string>>} appid -> keys */
    this.byAppId = new Map();
    /** @type {object[]} 时间倒序事件 */
    this.events = [];
    /** @type {Map<string, any>} 各数据源的游标/状态 */
    this.sourceState = new Map();
    /** 高频关注清单 */
    this.watchlist = new Set();
    /**
     * 待精确校验的候选 appid 队列。
     * 免费候选集扫描发现的每一个 appid 都会进入这里，直到被 appdetails 校验过一次。
     * @type {Map<number, {firstSeen: number, lastSeen: number, hint: number, special: boolean}>}
     */
    this.candidates = new Map();
    /** 曾出现在促销索引中的 appid（判断"曾经收费"的有力旁证，只增不减） */
    this.seenSpecials = new Set();
    /** 各来源最近一次成功抓取信息 */
    this.sourceStats = new Map();
    this.startedAt = nowIso();
    this.dirty = false;
    this.saveTimer = null;
    this.autoSaveTimer = null;
    /** 是否正在写盘（避免并发写同一文件） */
    this.saving = false;
    this.lastSavedAt = null;
    /** active() 的排序结果缓存（见 active 方法说明） */
    this.activeCache = null;
    /**
     * 历史最高条目数。
     *
     * 用来暴露"数据变少"这类静默问题：曾经因为存档只保留部分条目，
     * 重启后条目数从 3 万掉到 1.6 万，界面上却看不出异常。
     * 现在把峰值一并展示，一旦当前值明显低于峰值就说明有数据丢失。
     */
    this.peakItems = 0;
    /**
     * 每个条目序列化后的 JSON 片段缓存（见 #buildPayload）。
     * 键为 item.key，值形如 `{"k":"steam-catalog:730",...}`。
     */
    this.itemJson = new Map();
  }

  /** 数据发生变化时让 active() 缓存失效。 */
  invalidateActiveCache() {
    this.activeCache = null;
  }

  /**
   * 修正历史误分类：把"折扣为 0"的条目从 DISCOUNT 改成 PAID。
   *
   * 背景：早期实现把所有 `is_free=false` 的详情都记成 DISCOUNT，
   * 于是"高折扣"分类里混进一堆 0% 折扣的付费游戏（界面显示 `-0%`）。
   * 判定逻辑已修，这里把库里已有的旧记录一次性纠正。
   *
   * @returns {number} 修正的条目数
   */
  fixLegacyDiscountClassification() {
    let fixed = 0;
    for (const [key, item] of this.items) {
      if (item.freeType !== FREE_TYPE.DISCOUNT) continue;
      if (item.finalPrice === 0) continue; // 真的免费，不动
      if ((item.discountPercent ?? 0) > 0) continue; // 真的在打折，不动
      item.freeType = FREE_TYPE.PAID;
      this.#invalidateItemJson(key);
      fixed += 1;
    }
    if (fixed) {
      this.activeCache = null;
      this.markDirty();
    }
    return fixed;
  }

  // ---------------------------------------------------------------- 持久化

  get stateFile() {
    return path.join(this.dataDir, 'state.json');
  }

  /** 从磁盘恢复（文件缺失/损坏时静默忽略）。 */
  load() {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.version !== STATE_VERSION) return { loaded: false, reason: 'version mismatch' };
      const records = Array.isArray(parsed.items) ? parsed.items : [];
      // 新格式是精简存档（archive:true，字段名被缩短）；也兼容旧的全量格式
      const isArchive = parsed.archive === true;
      for (const record of records) {
        let item;
        if (isArchive) {
          item = normalizeItem(Store.expandRecord(record));
        } else {
          // 旧格式：条目本身就是规范化的，但仍要保证 key 存在
          item = normalizeItem(record);
        }
        // key 决定去重身份，缺失会导致所有记录塌缩成同一条，必须显式兜底
        if (!item.key) item.key = itemKey(item);
        if (!item.key || item.key === ':undefined') {
          this.logger?.warn?.('跳过缺少来源标识的存档记录');
          continue;
        }
        this.items.set(item.key, item);
        this.#indexAppId(item);
      }
      this.events = Array.isArray(parsed.events) ? parsed.events.slice(0, MAX_EVENTS) : [];
      if (Array.isArray(parsed.watchlist)) {
        for (const id of parsed.watchlist) this.watchlist.add(Number(id));
      }
      if (Array.isArray(parsed.seenSpecials)) {
        for (const id of parsed.seenSpecials) this.seenSpecials.add(Number(id));
      }
      if (parsed.candidates && typeof parsed.candidates === 'object') {
        for (const [id, entry] of Object.entries(parsed.candidates)) {
          const n = Number(id);
          if (!Number.isInteger(n)) continue;
          // 新格式是紧凑数组 [firstSeen, hint, special, reviews]，兼容旧的完整对象
          this.candidates.set(n, Array.isArray(entry) ? Store.expandCandidate(entry) : entry);
        }
      }
      if (parsed.sourceState && typeof parsed.sourceState === 'object') {
        for (const [k, v] of Object.entries(parsed.sourceState)) this.sourceState.set(k, v);
      }
      // 峰值取"本次恢复数量"与"历史记录"的较大者
      this.peakItems = Math.max(this.items.size, Number(parsed.peakItems) || 0);
      return {
        loaded: true,
        items: this.items.size,
        events: this.events.length,
        archive: isArchive,
        persisted: records.length,
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { loaded: false, reason: 'no state file' };
      this.logger?.warn?.(`failed to load state: ${error.message}`);
      return { loaded: false, reason: error.message };
    }
  }

  /**
   * 由 appid 推导 Steam 商店链接与胶囊图地址。
   *
   * 为什么不直接存：实测存档里 `image` 平均 113 字节、`url` 59 字节，
   * 合计占整个存档的 35%。而这两者完全可以由 appid 推导出来。
   * 注意 `url` 是权威的（Steam 链接带 slug，这里省略 slug 仍可正常跳转），
   * 但 `image` 只在没有原始地址时才使用推导值（推导地址未必一定存在）。
   */
  static deriveStoreUrl(appId) {
    return appId ? `https://store.steampowered.com/app/${appId}/` : null;
  }

  static deriveCapsuleImage(appId) {
    return appId
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_231x87.jpg`
      : null;
  }

  /** 把条目压缩为精简存档记录。 */
  static compactRecord(item) {
    return {
      k: item.key, s: item.source, i: item.sourceId, a: item.appId,
      t: item.title,
      // 能推导的字段不存：appid 存在时 url/image 一律推导，仅非 app 条目（如激活码）才存原始值
      u: item.appId ? undefined : item.url,
      g: item.appId ? undefined : item.image,
      y: item.freeType,
      c: item.currency, o: item.originalPrice, f: item.finalPrice,
      of: item.originalPriceFormatted, ff: item.finalPriceFormatted,
      d: item.discountPercent, r: item.reviewCount,
      // 评价结果与好评率：界面要显示"特别好评/好评如潮"并支持筛选，必须持久化
      rs: item.reviewSummary ?? undefined, rp: item.reviewPercent ?? undefined,
      e: item.endDate, p: item.publishedDate, w: item.wasPaid,
      v: item.lastVerifiedAt, n: item.active === false ? 0 : 1,
      b: item.firstSeenAt, l: item.lastSeenAt, m: item.updatedAt,
      // 精选位给出的活动名称（"免费周末"等），用于说明判定依据
      sl: item.spotLabel ?? undefined,
    };
  }

  /** 还原精简存档记录。 */
  static expandRecord(r) {
    return {
      key: r.k, source: r.s, sourceId: String(r.i), appId: r.a,
      title: r.t,
      url: r.u ?? Store.deriveStoreUrl(r.a),
      // 有 appid 时优先用推导地址（已验证返回 200），避免存档里存带哈希的长 URL
      image: Store.deriveCapsuleImage(r.a) ?? r.g ?? null,
      freeType: r.y,
      currency: r.c ?? null, originalPrice: r.o ?? null, finalPrice: r.f ?? null,
      originalPriceFormatted: r.of ?? null, finalPriceFormatted: r.ff ?? null,
      discountPercent: r.d ?? null, reviewCount: r.r ?? null,
      reviewSummary: r.rs ?? null, reviewPercent: r.rp ?? null,
      endDate: r.e ?? null, publishedDate: r.p ?? null, wasPaid: r.w ?? null,
      lastVerifiedAt: r.v ?? null, active: r.n !== 0,
      spotLabel: r.sl ?? null,
      firstSeenAt: r.b, lastSeenAt: r.l, updatedAt: r.m,
      isFree: (r.f ?? null) === 0,
    };
  }

  /**
   * 标记需要落盘。
   *
   * 性能背景（实测）：
   *   早期实现用 1.5s 去抖动 + 同步全量序列化，每 1.5 秒阻塞事件循环约 300ms。
   * 现在改为：
   *   - 去抖动 45 秒，并配合精简存档
   *   - 写入使用 fs.promises（异步），不阻塞事件循环
   *   - 保存进行中若又有变更，只置一个标记，避免并发写同一文件
   *   - 另外有周期性自动落盘（见 autoSaveIntervalMs），保证长时间运行后
   *     "重启不丢进度"不依赖于恰好停止在去抖动窗口之外
   */
  markDirty() {
    this.dirty = true;
    this.activeCache = null;
    if (this.autoSaveTimer) return;
    this.autoSaveTimer = setInterval(() => {
      if (this.dirty) this.save().catch((e) => this.logger?.warn?.(`auto-save failed: ${e.message}`));
    }, AUTO_SAVE_INTERVAL_MS);
    this.autoSaveTimer.unref?.();
    if (this.saveTimer || this.saving) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((e) => this.logger?.warn?.(`save failed: ${e.message}`));
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /**
   * 候选队列的存档编解码。
   *
   * 实测：几万个候选用原字段名序列化要占 2.59MB（整个存档的 33.6%）。
   * 这里改为短数组格式 `[firstSeen, hint, special, reviews, skip]`，
   * 并省略可从 firstSeen 推导的 lastSeen（只用于运行期诊断）。
   *
   * `skip` 是"分诊"结果：该候选不值得花 appdetails 配额。
   * 必须持久化，否则重启后又要重新分诊、重新排一遍。
   */
  static compactCandidate(c) {
    return [c.firstSeen ?? 0, c.hint ?? 0, c.special ? 1 : 0, c.reviews ?? 0, c.skip ? 1 : 0];
  }

  static expandCandidate(a) {
    const firstSeen = a[0] ?? Date.now();
    return {
      firstSeen,
      lastSeen: firstSeen,
      hint: a[1] ?? 0,
      special: a[2] === 1,
      reviews: a[3] ?? 0,
      // 旧格式只有 4 个元素，缺少 skip 时按"需要校验"处理
      skip: a[4] === 1,
    };
  }

  /**
   * 是否持久化该条目。
   *
   * ⚠️ 这里曾经用"只保留有价值的条目、丢弃冷门 F2P"的策略来压缩存档，
   *    结果造成**静默数据丢失**：
   *      扫描游标会落盘，但被丢弃的条目不会；重启后这些条目消失，
   *      而游标已经越过它们、不会再回头重扫（游标会环绕，但需要整整一圈）。
   *    免费候选集的返回顺序并不保证稳定，因此无法可靠地"回头补扫"。
   *
   * 结论：**全部持久化**。体积改用编码方式压缩（compactRecord / compactCandidate），
   * 而不是靠丢数据。若将来确需裁剪，必须同时回退游标，否则一定丢数据。
   */
  static worthPersisting() {
    return true;
  }

  async save() {
    if (!this.dirty || this.saving) return;
    this.dirty = false;
    this.saving = true;
    try {
      const payload = this.#buildPayload();
      await fs.promises.mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, payload, 'utf8');
      await fs.promises.rename(tmp, this.stateFile);
      this.lastSavedAt = nowIso();
    } finally {
      this.saving = false;
      // 保存期间又产生了变更 -> 排下一次
      if (this.dirty) this.markDirty();
    }
  }

  /**
   * 组装存档 JSON 文本。
   *
   * 性能背景（实测，本文件最关键的一处优化）：
   *   存档 10.45MB / 约 3 万条时，整体 `JSON.stringify` 需要 **446ms**，
   *   而且它是同步的 —— 每 60 秒的自动落盘都会卡住事件循环半秒，
   *   期间所有 HTTP 请求与 SSE 推送一起被阻塞（推算到 8 万条约 1.1 秒）。
   *
   * 优化思路：**条目写入后基本不再变化**（只有价格/状态变化时才更新），
   * 因此为每条缓存其序列化片段，落盘时只重新序列化"变动过的"条目。
   * 成本从 O(全部条目) 降到 O(变更条目)。
   *
   * 代价：额外约 9MB 字符串内存（3 万条），换来事件循环不再被卡住。
   */
  #buildPayload() {
    const parts = [
      `{"version":${STATE_VERSION},"savedAt":${JSON.stringify(nowIso())},"archive":true,`,
      `"peakItems":${Math.max(this.peakItems, this.items.size)},"items":[`,
    ];

    let first = true;
    for (const [key, item] of this.items) {
      if (!Store.worthPersisting(item)) continue;
      let json = this.itemJson.get(key);
      if (json === undefined) {
        json = JSON.stringify(Store.compactRecord(item));
        this.itemJson.set(key, json);
      }
      if (!first) parts.push(',');
      parts.push(json);
      first = false;
    }
    parts.push('],');

    parts.push(`"events":${JSON.stringify(this.events.slice(0, MAX_EVENTS))},`);
    parts.push(`"watchlist":${JSON.stringify([...this.watchlist])},`);
    parts.push(`"seenSpecials":${JSON.stringify([...this.seenSpecials])},`);

    // 候选队列单条很小（约 32 字节）但数量多，逐条拼接同样避免整体 stringify
    const cand = [];
    for (const [id, c] of this.candidates) {
      cand.push(`"${id}":${JSON.stringify(Store.compactCandidate(c))}`);
    }
    parts.push(`"candidates":{${cand.join(',')}},`);

    parts.push(`"sourceState":${JSON.stringify(Object.fromEntries(this.sourceState))}}`);
    return parts.join('');
  }

  /** 条目发生变更时让其序列化缓存失效。 */
  #invalidateItemJson(key) {
    if (this.itemJson.size) this.itemJson.delete(key);
  }

  /** 立即落盘（进程退出前调用）。 */
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    this.dirty = true;
    await this.save();
  }

  // ---------------------------------------------------------------- 索引

  #indexAppId(item) {
    if (item.appId == null) return;
    let set = this.byAppId.get(item.appId);
    if (!set) {
      set = new Set();
      this.byAppId.set(item.appId, set);
    }
    set.add(item.key);
  }

  /** 某来源在本轮抓取到的 key 集合，用于"下架"检测。 */
  beginPass(source) {
    return { source, seen: new Set(), startedAt: Date.now() };
  }

  // ---------------------------------------------------------------- 写入

  /**
   * 插入/更新条目并产生事件。
   * @param {object} raw 规范化前的条目
   * @returns {{item: object, event: object|null}}
   */
  upsert(raw) {
    const incoming = normalizeItem(raw);
    const key = itemKey(incoming);
    incoming.key = key;
    const existing = this.items.get(key);
    const at = nowIso();
    let event = null;

    if (!existing) {
      incoming.firstSeenAt = at;
      incoming.lastSeenAt = at;
      incoming.updatedAt = at;
      incoming.missedPasses = 0;
      incoming.lastEventType = EVENT.DISCOVERED;
      this.items.set(key, incoming);
      this.#indexAppId(incoming);
      event = this.#record(EVENT.DISCOVERED, incoming, { at });
    } else {
      const changes = {};
      const prevFreeType = existing.freeType;
      const prevFinal = existing.finalPrice;
      const prevDiscount = existing.discountPercent;

      // 只在值确实变化时记录
      if (prevFinal !== incoming.finalPrice) changes.finalPrice = [prevFinal, incoming.finalPrice];
      if (prevDiscount !== incoming.discountPercent) changes.discountPercent = [prevDiscount, incoming.discountPercent];
      if (prevFreeType !== incoming.freeType) changes.freeType = [prevFreeType, incoming.freeType];

      // 保留更早的首次发现时间；补齐可能缺失的元数据
      Object.assign(existing, incoming, {
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: at,
        updatedAt: at,
        missedPasses: 0,
        // 缺失字段不要用 null 覆盖已有值
        image: incoming.image ?? existing.image,
        description: incoming.description ?? existing.description,
        reviewSummary: incoming.reviewSummary ?? existing.reviewSummary,
        reviewPercent: incoming.reviewPercent ?? existing.reviewPercent,
        releaseDate: incoming.releaseDate ?? existing.releaseDate,
        originalPrice: incoming.originalPrice ?? existing.originalPrice,
        originalPriceFormatted: incoming.originalPriceFormatted ?? existing.originalPriceFormatted,
        title: incoming.title || existing.title,
      });

      const rankUp = (TYPE_RANK[incoming.freeType] ?? 0) > (TYPE_RANK[prevFreeType] ?? 0);
      const becameFree = incoming.finalPrice === 0 && (prevFinal ?? 1) > 0;

      if (becameFree) {
        existing.lastEventType = EVENT.BECAME_FREE;
        event = this.#record(EVENT.BECAME_FREE, existing, { at, changes });
      } else if (rankUp) {
        existing.lastEventType = EVENT.UPDATED;
        event = this.#record(EVENT.UPDATED, existing, { at, changes });
      } else if (changes.finalPrice || changes.discountPercent || changes.freeType) {
        const dropped = (incoming.discountPercent ?? 0) > (prevDiscount ?? 0);
        existing.lastEventType = dropped ? EVENT.PRICE_DROP : EVENT.UPDATED;
        event = this.#record(existing.lastEventType, existing, { at, changes });
      }

      // 条目内容变了：序列化缓存必须失效，否则落盘会写出旧值。
      // lastSeenAt/updatedAt 也在存档字段里，所以每次更新都要失效。
      this.#invalidateItemJson(key);
    }

    if (event) this.markDirty();
    return { item: existing ?? incoming, event };
  }

  /** 记录事件并广播。 */
  #record(type, item, extra = {}) {
    const event = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      at: extra.at ?? nowIso(),
      key: item.key,
      source: item.source,
      appId: item.appId,
      title: item.title,
      image: item.image,
      url: item.url,
      freeType: item.freeType,
      discountPercent: item.discountPercent,
      originalPriceFormatted: item.originalPriceFormatted,
      finalPriceFormatted: item.finalPriceFormatted,
      changes: extra.changes ?? null,
      isFreebie: item.finalPrice === 0,
    };
    this.events.unshift(event);
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
    this.emit('event', event);
    return event;
  }

  /**
   * 结束一轮抓取：本来源本轮未见到的条目累计 miss，达到阈值则标记下架。
   *
   * @param {{source: string, seen: Set<string>}} pass
   * @param {object} [options]
   * @param {number} [options.tolerance] 未命中容忍轮数
   * @param {boolean} [options.authoritative]
   *   该来源本轮是否覆盖了"全部"其名下条目。
   *   扫描类来源是分页滚动的，一轮只看一部分，绝不能据此判下架（tolerance 视为无限）。
   *   调用方应传入数据源自身的 authoritative 属性：
   *     `store.endPass(pass, { authoritative: source.authoritative, tolerance: 2 })`
   *   否则 tolerance 会被忽略，条目永远不会被判结束。
   */
  endPass(pass, { tolerance = MISS_TOLERANCE, recordEnded = true, authoritative = false } = {}) {
    const effTolerance = authoritative ? tolerance : Number.POSITIVE_INFINITY;
    let ended = 0;
    for (const [key, item] of this.items) {
      if (item.source !== pass.source) continue;
      if (pass.seen.has(key)) continue;
      if (!item.active) continue;
      item.missedPasses += 1;
      if (item.missedPasses >= effTolerance) {
        item.active = false;
        item.updatedAt = nowIso();
        this.#invalidateItemJson(key);
        if (recordEnded) {
          item.lastEventType = EVENT.ENDED;
          this.#record(EVENT.ENDED, item, {});
        }
        ended += 1;
      }
      this.markDirty();
    }
    return { ended, checked: pass.seen.size };
  }

  /** 直接标记下架（精确校验确认不再免费时使用）。 */
  markEnded(key, note = '') {
    const item = this.items.get(key);
    if (!item || !item.active) return null;
    item.active = false;
    item.updatedAt = nowIso();
    item.lastEventType = EVENT.ENDED;
    if (note) item.note = note;
    this.#invalidateItemJson(key);
    this.markDirty();
    return this.#record(EVENT.ENDED, item, {});
  }

  /** 移除条目（例如来源误报）。 */
  remove(key) {
    const item = this.items.get(key);
    if (!item) return false;
    this.items.delete(key);
    this.byAppId.get(item.appId)?.delete(key);
    this.itemJson.delete(key);
    this.markDirty();
    return true;
  }

  // ---------------------------------------------------------------- 候选队列

  /**
   * 记录一个待精确校验的候选 appid。
   *
   * 免费候选集里绝大多数是永久免费游戏，逐个调用 appdetails 成本很高，
   * 因此这里只做"登记 + 提示"，真正决定优先级的是 special/hint/reviews：
   *   - special=true  : 该 appid 曾在促销索引里出现过 => 它原本是付费商品（最强信号）
   *   - hint          : 列表页 data-price-final 给出的非零价格（可能不准确，仅供参考）
   *   - reviews       : 评论总数，数量大说明是有分量的正式游戏，比大量 F2P 小游戏更值得先查
   *
   * **去重（避免重复抓取）**：如果库里已经有该 appid 且是**最近校验过**的，
   * 就直接不再入队。否则每次扫描滚动到同一段，都会把已经确认过的 appid 重新
   * 排队、重新请求 appdetails —— 既浪费配额，也拖慢真正的新条目。
   *
   * @param {number} appId
   * @param {{special?: boolean, hint?: number, reviews?: number}} [info]
   */
  enqueueCandidate(appId, { special = false, hint = 0, reviews = 0 } = {}) {
    const id = Number(appId);
    if (!Number.isInteger(id) || id <= 0) return;

    // 已校验且在免检期内 => 不重复排队（永久免费尤其：读一次就不再读）
    if (this.isRecentlyVerified(id)) return;

    const now = Date.now();
    const skip = !shouldVerifyCandidate({ special, hint, reviews });
    const existing = this.candidates.get(id);
    if (existing) {
      existing.lastSeen = now;
      existing.special = existing.special || special;
      existing.hint = Math.max(existing.hint ?? 0, hint ?? 0);
      existing.reviews = Math.max(existing.reviews ?? 0, reviews ?? 0);
      // 出现了更强信号 => 重新激活（之前可能是被跳过的冷门条目）
      if (existing.skip && shouldVerifyCandidate({ special, hint, reviews })) existing.skip = false;
      return;
    }
    this.candidates.set(id, {
      firstSeen: now,
      lastSeen: now,
      hint: hint ?? 0,
      special,
      reviews: reviews ?? 0,
      skip,
    });
    this.markDirty();
  }

  /**
   * 该 appid 是否在免检期内（因此无需重复请求 appdetails）。
   *
   * 免检期按类型区分（见文件顶部常量说明）：
   *   永久免费 ≈ 不再复核；折扣 6 小时；限免/免费周末 15 分钟。
   * @param {number} appId
   */
  isRecentlyVerified(appId) {
    const keys = this.byAppId.get(Number(appId));
    if (!keys || keys.size === 0) return false;
    const now = Date.now();
    for (const key of keys) {
      const item = this.items.get(key);
      if (!item?.lastVerifiedAt) continue;
      const age = now - Date.parse(item.lastVerifiedAt);
      if (!Number.isFinite(age)) continue;
      let ttl;
      if (item.freeType === FREE_TYPE.KEEP || item.freeType === FREE_TYPE.WEEKEND) {
        ttl = VERIFY_TTL_TIMEBOUND_MS;
      } else if (item.freeType === FREE_TYPE.DISCOUNT) {
        ttl = VERIFY_TTL_DISCOUNT_MS;
      } else {
        ttl = VERIFY_TTL_F2P_MS;
      }
      if (age < ttl) return true;
    }
    return false;
  }

  /** 队列构成统计（用于界面展示"还有多少真正需要校验的"）。 */
  candidateStats() {
    let verify = 0;
    let skipped = 0;
    for (const c of this.candidates.values()) {
      if (c.skip) skipped += 1;
      else verify += 1;
    }
    return { total: this.candidates.size, toVerify: verify, skipped };
  }

  /**
   * 对队列里已有的候选做一次"分诊"。
   *
   * 背景：分诊逻辑是后加的，此前入队的候选都没有 skip 标记。
   * 启动时按当前规则重新评估一遍，可以把大量"查了也白查"的冷门条目
   * 一次性排除，立刻省下可观的 appdetails 配额。
   *
   * @returns {number} 新标记为 skip 的数量
   */
  triageCandidates() {
    let skipped = 0;
    for (const c of this.candidates.values()) {
      const worth = shouldVerifyCandidate(c);
      const next = !worth;
      if (next && !c.skip) skipped += 1;
      c.skip = next;
    }
    if (skipped) this.markDirty();
    return skipped;
  }

  /** 标记候选已完成校验，从队列移除。 */
  resolveCandidate(appId) {
    if (this.candidates.delete(Number(appId))) this.markDirty();
  }

  /** 记录一批"曾出现在促销索引"的 appid。 */
  ingestSpecials(appIds) {
    let added = 0;
    for (const raw of appIds) {
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) continue;
      if (!this.seenSpecials.has(id)) {
        this.seenSpecials.add(id);
        added += 1;
      }
    }
    if (added) this.markDirty();
    return added;
  }

  /**
   * 按优先级取出待校验候选。
   *
   * 只返回"值得花 appdetails 配额"的候选：被分诊标记 `skip` 的冷门条目会被跳过
   * （记录仍保留，一旦出现更强信号会被重新激活）。
   *
   * 排序依据：曾促销 > 评论数（游戏分量）> 非零价格提示 > 等待时间更久。
   * @param {number} limit
   * @param {number} [now]
   */
  peekCandidates(limit, now = Date.now()) {
    const scored = [];
    for (const [appId, c] of this.candidates) {
      if (c.skip) continue; // 分诊：不值得花配额
      let score = 0;
      if (c.special) score += 10_000_000;
      if ((c.hint ?? 0) > 0) score += 2_000_000;
      // 评论数是"这个游戏有多重要"的最便宜代理指标：
      // 数量大说明是有分量的正式游戏，最值得优先确认是否限免
      if ((c.reviews ?? 0) > 0) score += Math.min(1_000_000, Math.log10(c.reviews) * 160_000);
      // 等待越久越优先，保证队列不会饿死
      score += Math.min(100_000, (now - (c.firstSeen ?? now)) / 1000);
      scored.push([appId, score]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, Math.max(0, limit)).map(([appId]) => appId);
  }

  // ---------------------------------------------------------------- 读取

  get(key) {
    return this.items.get(key) ?? null;
  }

  getByAppId(appId) {
    const keys = this.byAppId.get(Number(appId));
    if (!keys) return [];
    return [...keys].map((k) => this.items.get(k)).filter(Boolean);
  }

  /** 全部条目（含已下架）。 */
  all() {
    return [...this.items.values()];
  }

  /**
   * 当前有效条目，按关注度排序。
   *
   * 性能注意：`watchScore()` 与 `priorityOf()` 如果在比较函数里计算，
   * 3 万条数据的排序会调用约 60 万次评分函数（实测 45ms）。
   * 因此改为先为每条计算一次排序键（Schwartzian transform），再排序。
   * 结果按条目集合的变更代理值缓存，避免同一秒内多个请求重复排序。
   */
  active({ includeEnded = false } = {}) {
    const now = Date.now();
    const cacheKey = includeEnded ? 'withEnded' : 'activeOnly';
    if (this.activeCache && this.activeCache.key === cacheKey && now - this.activeCache.at < 2000) {
      return this.activeCache.list;
    }

    const decorated = [];
    for (const item of this.items.values()) {
      if (!includeEnded && !item.active) continue;
      decorated.push({
        item,
        p: priorityOf(item),
        s: watchScore(item),
        // 评测数参与排序：永久免费条目数以万计，只按发现时间排的话
        // 前面全是没评测过的冷门小游戏，用户看不到"特别好评/好评如潮"的内容
        r: item.reviewCount ?? 0,
        t: item.firstSeenAt ?? '',
      });
    }
    decorated.sort((a, b) => (a.p - b.p) || (b.s - a.s) || (b.r - a.r) || (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
    const list = decorated.map((d) => d.item);

    this.activeCache = { key: cacheKey, at: now, list };
    return list;
  }

  /**
   * 统计概览。
   *
   * 性能注意：`groupCounts` 需要遍历全部条目（3 万条约 24ms）。
   * `/api/items` 会被前端频繁调用，因此那里应传 `{ groupCounts: false }`，
   * 只在 `/api/status` 这类低频接口上计算完整分组。
   *
   * @param {{groupCounts?: boolean}} [options]
   */
  summary({ groupCounts = true } = {}) {
    const all = [...this.items.values()];
    const active = all.filter((i) => i.active);
    // 按类型统计本身不贵（一次遍历），而界面统计条必须**每个类型都有数字**，
    // 否则"免费周末"这类少见的类型会显示成 0/空，看起来像没数据。
    // 因此这里始终计算 byType，只有 bySource 跟随 groupCounts（它确实更贵且只用于状态面板）。
    const byType = {};
    let pendingToVerify = 0;
    let freebieCount = 0;
    for (const i of active) {
      byType[i.freeType] = (byType[i.freeType] ?? 0) + 1;
      if (i.finalPrice === 0) freebieCount += 1;
    }
    for (const c of this.candidates.values()) if (!c.skip) pendingToVerify += 1;

    const base = {
      total: this.items.size,
      active: active.length,
      ended: this.items.size - active.length,
      byType,
      freebieCount,
      keepCount: byType[FREE_TYPE.KEEP] ?? 0,
      weekendCount: byType[FREE_TYPE.WEEKEND] ?? 0,
      keyCount: byType[FREE_TYPE.KEY] ?? 0,
      discountCount: byType[FREE_TYPE.DISCOUNT] ?? 0,
      f2pCount: byType[FREE_TYPE.F2P] ?? 0,
      pendingVerification: this.candidates.size,
      /** 其中真正需要花 appdetails 配额的（其余是被分诊跳过的冷门条目） */
      pendingToVerify: pendingToVerify,
      specialsKnown: this.seenSpecials.size,
      watchlistSize: this.watchlist.size,
      lastEventAt: this.events[0]?.at ?? null,
      startedAt: this.startedAt,
      /** 历史最高条目数：当前值明显低于它就意味着发生过数据丢失 */
      peakItems: Math.max(this.peakItems, this.items.size),
    };
    if (!groupCounts) return base;

    const bySource = {};
    for (const i of active) bySource[i.source] = (bySource[i.source] ?? 0) + 1;
    return { ...base, bySource };
  }

  // ---------------------------------------------------------------- 关注清单

  setSourceState(name, patch) {
    const prev = this.sourceState.get(name) ?? {};
    this.sourceState.set(name, { ...prev, ...patch });
    this.markDirty();
  }

  getSourceState(name) {
    return this.sourceState.get(name) ?? {};
  }

  recordSourceResult(name, { ok, count = 0, error = null, durationMs = 0 }) {
    const prev = this.sourceStats.get(name) ?? {};
    this.sourceStats.set(name, {
      ok,
      count,
      error: error ? String(error).slice(0, 300) : null,
      durationMs,
      lastRunAt: nowIso(),
      lastSuccessAt: ok ? nowIso() : prev.lastSuccessAt ?? null,
      consecutiveFailures: ok ? 0 : (prev.consecutiveFailures ?? 0) + 1,
      /** 本轮是否有部分页面失败（例如限流/超时） */
      partial: ok && Boolean(error),
    });
  }

  getSourceStats(name) {
    return this.sourceStats.get(name) ?? null;
  }

  /** 动态维护高频关注清单。 */
  updateWatchlist(candidates, max = 400) {
    const scored = candidates
      .filter((i) => i.appId)
      .map((i) => ({ appId: i.appId, score: watchScore(i) }))
      .sort((a, b) => b.score - a.score);

    // 已有清单不要被踢出（除非明确移除）
    const next = new Set(this.watchlist);
    for (const c of scored) {
      if (next.size >= max) break;
      next.add(c.appId);
    }
    // 超出上限时，先移除低分且非限免的
    if (next.size > max) {
      const keep = [...next].filter((id) => {
        const items = this.getByAppId(id);
        return items.some((i) => i.freeType === FREE_TYPE.KEEP || i.freeType === FREE_TYPE.WEEKEND);
      });
      const rest = [...next].filter((id) => !keep.includes(id));
      this.watchlist = new Set([...keep, ...rest.slice(0, Math.max(0, max - keep.length))]);
    } else {
      this.watchlist = next;
    }
    this.markDirty();
    return this.watchlist.size;
  }

  clearWatchlist() {
    this.watchlist.clear();
    this.markDirty();
  }
}

export { EVENT, FREE_TYPE, SOURCE, KIND, itemKey, watchScore };
