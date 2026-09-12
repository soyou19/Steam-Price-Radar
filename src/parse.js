/**
 * Steam 商店搜索结果解析。
 *
 * 数据来源：`/search/results/?...&infinite=1` 返回的 JSON 中 `results_html` 字段。
 * 每个条目是一个 `<a ... class="search_result_row">` 块，包含：
 *   - data-ds-appid / data-ds-tagids
 *   - <span class="title">
 *   - discount_block 的 class （`no_discount` 或空）与 discount_pct / discount_original_price / discount_final_price
 *   - data-price-final 属性（最小货币单位的最终价，例如 1499 = $14.99）
 *
 * 判定规则（实测）：
 *   - `discount_final_price free` 或 `data-price-final="0"` 且无折扣  => 免费（无法进一步区分形态）
 *   - 存在 `discount_pct=-100%` 且最终价为 0                        => 明确是限时免费
 *   - 存在 `discount_pct` 且最终价 > 0                              => 普通折扣
 *
 * ⚠️ `data-price-final` 不可信：永久免费的 CS2 会返回 10300（占位原价），
 *    而 Apex 返回 0。因此它只能作为排序提示，绝不能用来判定"是否曾经收费"。
 */
import { decodeEntities, stripTags } from './util.js';
import { FREE_TYPE, KIND, SOURCE } from './model.js';

/** 从价格文本解析最小货币单位整数（"¥ 48.00" -> 4800）。无法解析返回 null。 */
export function parsePriceToMinor(text) {
  if (text == null) return null;
  const cleaned = decodeEntities(String(text)).replace(/[\s\u00a0]/g, '');
  if (!cleaned) return null;
  if (/^(免费|free|gratis|grátis|бесплатно|無料|무료)$/i.test(cleaned)) return 0;
  // 取最后一个数字串（避免 "1,234" 与小数混淆）
  const matches = [...cleaned.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]);
  if (!matches.length) return null;
  const digits = matches[matches.length - 1];
  // 形如 1,234.56 / 1.234,56 / 48.00
  const lastSep = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','));
  let intPart = digits;
  let fracPart = '';
  if (lastSep >= 0) {
    const frac = digits.slice(lastSep + 1);
    if (frac.length === 3 && !digits.slice(0, lastSep).includes('.') && !digits.slice(0, lastSep).includes(',')) {
      // 1,234 视为千分位
      intPart = digits.replace(/[.,]/g, '');
    } else {
      intPart = digits.slice(0, lastSep).replace(/[.,]/g, '');
      fracPart = frac.padEnd(2, '0').slice(0, 2);
    }
  }
  const value = Number(`${intPart || '0'}.${fracPart || '00'}`);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** 从价格文本提取货币符号。 */
const CURRENCY_HINTS = [
  [/¥|￥|CNY|RMB|元/, 'CNY'],
  [/\$|USD/, 'USD'],
  [/€|EUR/, 'EUR'],
  [/£|GBP/, 'GBP'],
  [/₩|KRW|원/, 'KRW'],
  [/₽|RUB|руб/i, 'RUB'],
  [/₺|TRY/, 'TRY'],
  [/₹|INR/, 'INR'],
  [/R\$|BRL/, 'BRL'],
];

export function parseCurrency(text, fallback = null) {
  const s = decodeEntities(String(text ?? ''));
  for (const [re, code] of CURRENCY_HINTS) if (re.test(s)) return code;
  return fallback;
}

const RE = {
  appId: /data-ds-appid="(\d+)"/,
  itemKey: /data-ds-itemkey="([^"]+)"/,
  tagIds: /data-ds-tagids="(\[[^\]]*\])"/,
  href: /^"([^"]+)"/,
  title: /<span class="title">([\s\S]*?)<\/span>/,
  release: /<div class="search_released[^"]*">([\s\S]*?)<\/div>/,
  reviewClass: /search_review_summary\s+([a-z ]+?)"/,
  reviewTooltip: /data-tooltip-html="([\s\S]*?)"/,
  capsule: /<div class="search_capsule">\s*<img\s+src="([^"]+)"/,
  discountBlockClass: /<div class="discount_block([^"]*?)"/,
  discountPct: /discount_pct">-(\d+)%/,
  originalPrice: /discount_original_price[^>]*>([\s\S]*?)<\/div>/,
  finalPrice: /discount_final_price([^>]*)>([\s\S]*?)<\/div>/,
  priceFinalAttr: /data-price-final="(\d*)"/,
  platforms: /search_platforms">([\s\S]*?)<\/div>/,
};

/**
 * 分类器：把解析出的原始标记映射为 FREE_TYPE。
 *
 * ⚠️ 实测得到的重要结论（决定了整个采集策略）：
 *   Steam 的 `maxprice=free` 列表**无法区分**"永久免费"和"限时免费"：
 *     - `discount_original_price` 对永久免费（CS2/Apex）与限时免费都不渲染
 *     - `data-price-final` 不可靠：CS2 返回 10300、Apex 返回 0，同一类商品表现不一致
 *   因此只有在**极少数**明确渲染 `-100%` 的情况下才能直接判定为限时免费。
 *
 *   真正的权威判定必须依赖 `/api/appdetails`：
 *     - is_free=true 且 price_overview=null            => 永久免费
 *     - is_free=true 且 price_overview.final=0 (100%)  => 限时免费 / 免费周末
 *     - is_free=false                                  => 已恢复收费（即限免结束）
 *
 *   本函数只做"低成本初判"，把所有免费条目暂记为 F2P，随后交由
 *   steam-details 源逐个精确校验并纠正。
 *
 * @param {object} item parseSearchRow 的返回值
 */
export function classify(item) {
  const { finalPrice, discountPercent, raw } = item;
  const free = finalPrice === 0 || raw?.isFreeClass;
  if (!free) return FREE_TYPE.DISCOUNT;
  if (discountPercent != null && discountPercent >= 100) return FREE_TYPE.KEEP;
  return FREE_TYPE.F2P;
}

/**
 * 从评测提示文本中提取好评率与评测总数。
 *
 * ⚠️ 必须同时支持中英文：商店语言由 `l` 参数决定，中文本地化文案形如
 *   "特别好评<br>此游戏的 1,412,341 篇用户评测中有 89% 为好评。"
 * 英文形如 "Very Positive<br>86% of the 2,613,842 user reviews …"。
 * 早期只写了英文正则，导致中文环境下评测数恒为 0，候选队列优先级全部失效。
 */
export function parseReviewStats(text) {
  const s = String(text ?? '');
  let count = null;
  let percent = null;

  const countRaw =
    s.match(/of the\s+([\d,]+)\s+user reviews/i)?.[1] ?? s.match(/([\d,]+)\s*篇用户评测/)?.[1];
  if (countRaw) {
    const n = Number.parseInt(countRaw.replace(/[,\s]/g, ''), 10);
    if (Number.isFinite(n)) count = n;
  }

  const percentRaw =
    s.match(/(\d+)%\s*of\s*the/i)?.[1] ?? s.match(/中有\s*(\d+)%/)?.[1] ?? s.match(/(\d+)%/)?.[1];
  if (percentRaw) {
    const n = Number.parseInt(percentRaw, 10);
    if (Number.isFinite(n)) percent = n;
  }

  return { count, percent };
}

/**
 * 解析单个搜索结果条目。返回 null 表示不是有效条目。
 */
export function parseSearchRow(row, { source = SOURCE.CATALOG } = {}) {
  const idMatch = row.match(RE.appId);
  if (!idMatch) return null;
  const appId = Number.parseInt(idMatch[1], 10);
  if (!Number.isInteger(appId) || appId <= 0) return null;

  const rawTitle = row.match(RE.title)?.[1];
  const title = stripTags(rawTitle) || `App ${appId}`;

  const blockClass = (row.match(RE.discountBlockClass)?.[1] ?? '').trim();
  const noDiscount = /\bno_discount\b/.test(blockClass);
  const discountPercent = row.match(RE.discountPct) ? Number.parseInt(row.match(RE.discountPct)[1], 10) : null;

  const finalMatch = row.match(RE.finalPrice);
  const finalAttrs = finalMatch?.[1] ?? '';
  const finalText = finalMatch ? stripTags(finalMatch[2]) : null;
  const isFreeClass = /\bfree\b/.test(finalAttrs);

  const originalText = row.match(RE.originalPrice) ? stripTags(row.match(RE.originalPrice)[1]) : null;

  let finalPrice = finalMatch ? parsePriceToMinor(finalText) : null;
  const attrRaw = row.match(RE.priceFinalAttr)?.[1];
  if ((finalPrice == null || isFreeClass) && attrRaw !== undefined && attrRaw !== '') {
    const attrValue = Number.parseInt(attrRaw, 10);
    if (Number.isFinite(attrValue)) {
      // 免费类目下 Steam 会保留一个占位原价，必须让显式 "free" 标记优先
      finalPrice = isFreeClass ? 0 : attrValue;
    }
  }
  if (isFreeClass) finalPrice = 0;

  const originalPrice = originalText ? parsePriceToMinor(originalText) : null;
  const currency = parseCurrency(originalText) ?? parseCurrency(finalText);

  const platformsBlock = row.match(RE.platforms)?.[1] ?? '';
  const platforms = ['win', 'linux', 'mac']
    .filter((p) => new RegExp(`platform_img\\s+${p}\\b`).test(platformsBlock));

  const reviewClass = (row.match(RE.reviewClass)?.[1] ?? '').trim();
  const reviewTooltipRaw = row.match(RE.reviewTooltip)?.[1] ?? '';
  // 属性里是 HTML 实体（&lt;br&gt;），必须先解码再按 <br> 切分第一行
  const reviewTooltip = decodeEntities(reviewTooltipRaw);
  const reviewSummary = reviewTooltip
    ? stripTags(reviewTooltip.split(/<br\s*\/?>/i)[0])
    : (reviewClass || null);
  const { count: reviewCount, percent: reviewPercent } = parseReviewStats(reviewTooltip);

  const isFree = finalPrice === 0 || isFreeClass;
  const raw = {
    isFreeClass,
    hasDiscountMarkup: Boolean(discountPercent) || !noDiscount,
    originalPriceAttr: originalPrice,
    finalPriceAttr: attrRaw ? Number.parseInt(attrRaw, 10) : null,
  };

  const href = row.match(RE.href)?.[1] ?? `https://store.steampowered.com/app/${appId}/`;

  return {
    source,
    sourceId: String(appId),
    appId,
    kind: KIND.GAME,
    title,
    url: decodeEntities(href).split('?')[0],
    image: row.match(RE.capsule)?.[1] ?? null,
    currency,
    originalPrice,
    finalPrice,
    originalPriceFormatted: originalText || null,
    finalPriceFormatted: finalText ?? (finalPrice === 0 ? '免费' : null),
    discountPercent: isFree && finalPrice === 0 && noDiscount ? 0 : discountPercent,
    isFree,
    raw,
    platforms,
    releaseDate: row.match(RE.release) ? stripTags(row.match(RE.release)[1]) || null : null,
    reviewSummary,
    reviewPercent,
    reviewCount,
    tags: (() => {
      const raw = row.match(RE.tagIds)?.[1];
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.map((n) => Number.parseInt(n, 10)).filter(Number.isInteger) : [];
      } catch {
        return [];
      }
    })(),
  };
}

/** 解析单行（不做分类），供需要原始信号的调用方使用。 */
export function parseSearchRows(row, options = {}) {
  return parseSearchRow(row, options);
}

/** 解析 results_html 中的全部条目（已应用分类器）。 */
export function parseSearchResults(html, options = {}) {
  if (!html) return [];
  const rows = String(html).split('<a href=').slice(1);
  const out = [];
  for (const row of rows) {
    const parsed = parseSearchRow(row, options);
    if (parsed) {
      parsed.freeType = classify(parsed, options);
      out.push(parsed);
    }
  }
  return out;
}
