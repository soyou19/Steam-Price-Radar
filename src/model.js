/**
 * 统一数据模型与分类规则。
 *
 * 背景（实测结论，很重要）：
 *  Steam 公开的促销索引 `/search/results/?specials=1` 只包含 10%~90% 折扣，
 *  抽样 15000+ 条目中不存在任何 100% 折扣，也不包含 `.free`（永久免费）条目。
 *  也就是说：**Steam 官方没有任何公开接口可以直接列出"限时免费"游戏**。
 *  因此本聚合器采用三种互补策略：
 *    1) 候选集扫描（steam-catalog）：滚动扫描免费候选集与深层折扣，发现新增/转免条目
 *    2) 关注清单精确校验（steam-details）：对高优先级 appid 直接查价，精确识别限免与结束
 *    3) 第三方聚合（gamerpower）：补充限时免费领取 / 激活码类信息
 */

/** 物品大类 */
export const KIND = {
  GAME: 'game',
  DLC: 'dlc',
  BUNDLE: 'bundle',
  OTHER: 'other',
};

/** 免费/促销形态 */
export const FREE_TYPE = {
  /** 限时免费（永久入库） */
  KEEP: 'keep',
  /** 免费周末（限时试玩） */
  WEEKEND: 'weekend',
  /** 永久免费（F2P） */
  F2P: 'f2p',
  /** 历史最低折扣（非免费，用于参考） */
  DISCOUNT: 'discount',
  /** 激活码 / 站外领取 */
  KEY: 'key',
  /**
   * 付费且**当前没有折扣**（或拿不到价格信息）。
   *
   * 为什么需要这个类型：appdetails 查一个付费、无折扣的游戏时会返回
   * `is_free=false` 且折扣为 0（甚至没有 price_overview）。早期实现统一记成
   * `discount`，导致"高折扣"分类里混进一堆 0% 折扣的条目，
   * 统计数字也虚高。这类条目既不是免费也不是折扣，应当排除在外。
   */
  PAID: 'paid',
};

export const FREE_TYPE_LABEL = {
  [FREE_TYPE.KEEP]: '限时免费入库',
  [FREE_TYPE.WEEKEND]: '免费周末',
  [FREE_TYPE.F2P]: '永久免费',
  [FREE_TYPE.DISCOUNT]: '高折扣',
  [FREE_TYPE.KEY]: '免费激活码',
  [FREE_TYPE.PAID]: '付费（无折扣）',
};

/** 事件类型 */
export const EVENT = {
  DISCOVERED: 'discovered',
  PRICE_DROP: 'price_drop',
  BECAME_FREE: 'became_free',
  ENDED: 'ended',
  UPDATED: 'updated',
};

/** 数据来源标识 */
export const SOURCE = {
  CATALOG: 'steam-catalog',
  DETAILS: 'steam-details',
  SPOTLIGHT: 'steam-spotlight',
  DISCOUNTS: 'steam-discounts',
  GAMERPOWER: 'gamerpower',
};

export const SOURCE_LABEL = {
  [SOURCE.CATALOG]: 'Steam 商店扫描',
  [SOURCE.DETAILS]: 'Steam 价格校验',
  [SOURCE.SPOTLIGHT]: 'Steam 精选活动',
  [SOURCE.DISCOUNTS]: 'Steam 促销索引',
  [SOURCE.GAMERPOWER]: 'GamerPower 聚合',
};

/**
 * 判断标题是否像"试玩版 / Demo / 序章"这类非完整免费游戏。
 *
 * 实测：Steam 免费候选集里这类条目占比极高（试玩版、Demo、Prologue、体验版…），
 * 它们不是用户要找的"限时免费完整游戏"，因此：
 *   - 默认不在界面上展示（前端可切换显示）
 *   - 不进入 appdetails 校验队列，避免浪费大量抓取配额
 *
 * ⚠️ 中文匹配必须精确到多字词：
 *   早期版本用了 `/试玩/` 这种宽泛模式，结果把"**激活**码"误判为 Demo
 *   （"激活" 与 "试玩" 都以"试"字开头），导致符合条件的条目被大面积隐藏。
 *   因此这里只匹配不会与其它常见词重叠的完整词。
 */
const DEMO_PATTERNS = [
  /\bdemo\b/i,
  /\bprologue\b/i,
  /\bplaytest\b/i,
  /\bbeta\b/i,
  /试玩版/,
  /试玩demo/i,
  /体验版/,
  /序章/,
  /序幕/,
];

export function looksLikeDemo(title) {
  const t = String(title ?? '');
  // "Beta 激活码"这类是发码活动，不是测试版游戏，必须先排除
  if (/激活|领取|兑换|序列号|key|key\b/i.test(t)) return false;
  return DEMO_PATTERNS.some((re) => re.test(t));
}

/**
 * 是否属于"用户真正关心的免费"（用于筛选与高亮）。
 * 高折扣不算免费，但保留展示以便参考。
 */
export function isFreebie(item) {
  return item.freeType === FREE_TYPE.KEEP || item.freeType === FREE_TYPE.WEEKEND || item.freeType === FREE_TYPE.KEY;
}

/**
 * 排序优先级：数字越小越靠前。
 */
const PRIORITY_BY_TYPE = {
  [FREE_TYPE.KEEP]: 0,
  [FREE_TYPE.KEY]: 1,
  [FREE_TYPE.WEEKEND]: 2,
  [FREE_TYPE.F2P]: 3,
  [FREE_TYPE.DISCOUNT]: 4,
  [FREE_TYPE.PAID]: 9,
};

export function priorityOf(item) {
  return PRIORITY_BY_TYPE[item.freeType] ?? 9;
}

/**
 * 关注度评分（0-100），决定是否进入高频价格校验清单。
 * 限时免费/免费周末/低折扣高价值游戏优先级最高。
 */
export function watchScore(item) {
  let score = 0;
  if (item.freeType === FREE_TYPE.KEEP) score += 100;
  else if (item.freeType === FREE_TYPE.WEEKEND) score += 90;
  else if (item.freeType === FREE_TYPE.KEY) score += 60;
  else if (item.freeType === FREE_TYPE.F2P) score += 10;
  else if (item.freeType === FREE_TYPE.DISCOUNT) {
    const pct = item.discountPercent ?? 0;
    score += pct >= 90 ? 85 : pct >= 80 ? 70 : pct >= 70 ? 45 : pct >= 50 ? 25 : 5;
  }
  // 原价越高的游戏，打折/限免越值得关注
  if (item.originalPrice != null && item.originalPrice > 0) {
    score += Math.min(20, Math.round(item.originalPrice / 5000) * 5);
  }
  if (item.isFree) score += 30;
  return Math.min(100, score);
}

/**
 * 生成稳定去重键。
 *
 * 注意：绝不能对同一个 Key 混用来源，否则同一商品在两个来源之间会互相覆盖。
 * 因此由 (source, sourceId) 共同决定。
 */
export function itemKey(item) {
  return `${item.source}:${item.sourceId}`;
}

/**
 * 规范化字段，避免 undefined 泄漏到 JSON。
 *
 * ⚠️ 这是一个**白名单**：没有列在这里的字段会被静默丢弃。
 *    新增数据源字段时，务必同步在这里登记，否则会出现
 *    "写进去了但读不到"的隐蔽 bug（例如 lastVerifiedAt）。
 */
export function normalizeItem(raw) {
  const now = new Date().toISOString();
  return {
    key: '',
    source: raw.source,
    sourceId: String(raw.sourceId),
    appId: raw.appId ?? null,
    kind: raw.kind ?? KIND.GAME,
    freeType: raw.freeType ?? FREE_TYPE.DISCOUNT,
    title: String(raw.title ?? '未知标题').trim(),
    url: raw.url ?? null,
    image: raw.image ?? null,
    description: raw.description ? String(raw.description).slice(0, 1200) : null,
    currency: raw.currency ?? null,
    originalPrice: raw.originalPrice ?? null,
    finalPrice: raw.finalPrice ?? null,
    originalPriceFormatted: raw.originalPriceFormatted ?? null,
    finalPriceFormatted: raw.finalPriceFormatted ?? null,
    discountPercent: raw.discountPercent ?? null,
    isFree: Boolean(raw.isFree),
    /** 解析阶段保留的原始标记（用于二次分类与调试），不对外暴露 */
    raw: raw.raw ?? null,
    endDate: raw.endDate ?? null,
    publishedDate: raw.publishedDate ?? null,
    platforms: Array.isArray(raw.platforms) ? raw.platforms : [],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    releaseDate: raw.releaseDate ?? null,
    reviewSummary: raw.reviewSummary ?? null,
    reviewPercent: raw.reviewPercent ?? null,
    /** 评论总数：数量大说明是有分量的正式游戏，用于候选队列优先级 */
    reviewCount: raw.reviewCount ?? null,
    requirements: raw.requirements ?? null,
    instructions: raw.instructions ?? null,
    worth: raw.worth ?? null,
    /** 是否为试玩版/Demo/序章（默认不展示，也不进入校验队列） */
    isDemo: raw.isDemo ?? looksLikeDemo(raw.title),
    /** 是否付费商品（appdetails 的 !is_free），用于区分 F2P 与临时免费 */
    wasPaid: raw.wasPaid ?? null,
    /** 精选位给出的活动名称（例如"免费周末"），用于说明这条为什么被判为限时活动 */
    spotLabel: raw.spotLabel ?? null,
    /** 最近一次精确校验时间，供校验调度计算新鲜度 */
    lastVerifiedAt: raw.lastVerifiedAt ?? null,
    /** 校验来源标记 */
    verifiedBy: raw.verifiedBy ?? null,
    active: raw.active !== false,
    firstSeenAt: raw.firstSeenAt ?? now,
    lastSeenAt: raw.lastSeenAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    lastEventType: raw.lastEventType ?? null,
    missedPasses: 0,
  };
}
