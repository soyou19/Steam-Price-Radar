/**
 * Steam 限免雷达 — 前端逻辑（零依赖，原生 ES 模块）
 *
 * 数据流：GET /api/items 拉首屏快照 -> EventSource /api/stream 接收实时增量
 *   - event 帧：具体变更（新发现 / 转免 / 降价 / 结束）-> 更新动态栏 + 桌面通知 + toast
 *   - item  帧：发生变更的 key 列表 -> 仅重新拉取这些条目的最新数据
 */

const $ = (sel) => document.querySelector(sel);

/** 运行状态 */
const state = {
  items: new Map(),     // key -> item
  events: [],           // 最新事件在前
  eventIds: new Set(),  // 事件去重（避免每次 unshift 前做 O(n) 扫描）
  filters: {
    q: '', type: 'all', source: 'all', sort: 'priority',
    freeOnly: true, showEnded: false, showDemos: false,
    /** 折扣 / 价格区间（用于"高折扣参考"）：null 表示不限 */
    minDiscount: null, maxDiscount: null, minPrice: null, maxPrice: null,
    /** 评价筛选 */
    rating: 'all', minReviewCount: 0,
  },
  notifyEnabled: false,
  knownKeys: new Set(), // 用于判断哪些 key 是"本次新增"，以便高亮
  newKeys: new Map(),   // key -> 时间戳，短时高亮
  connected: false,
  summary: null,
  bootstrapped: false,
  total: 0,
  demosHidden: 0,
};

const FREE_TYPE_TEXT = {
  keep: '限时免费',
  weekend: '免费周末',
  key: '免费激活码',
  f2p: '永久免费',
  discount: '高折扣',
  paid: '付费',
};

const EVENT_TEXT = {
  discovered: '新发现',
  became_free: '刚刚限免',
  price_drop: '降价',
  ended: '已结束',
  updated: '信息更新',
};

// ---------------------------------------------------------------- 工具函数

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 大数字简写：1412376 -> 141.2万 */
function formatCount(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return String(n);
}

/**
 * 评价档位 -> 配色 class。
 * Steam 的评价文案：好评如潮 / 特别好评 / 多半好评 / 褒贬不一 / 多半差评 …
 */
function reviewClass(summary) {
  const s = String(summary ?? '');
  if (/好评如潮|Overwhelmingly Positive/i.test(s)) return 'review--great';
  if (/特别好评|Very Positive/i.test(s)) return 'review--good';
  if (/多半好评|^好评$|Mostly Positive/i.test(s)) return 'review--ok';
  if (/褒贬不一|Mixed/i.test(s)) return 'review--mixed';
  if (/差评|Negative/i.test(s)) return 'review--bad';
  return '';
}

/** 相对时间（中文） */
function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return '';
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

/** 剩余时间 / 已过期 */
function countdown(iso) {
  if (!iso) return null;
  const diff = Date.parse(iso) - Date.now();
  if (!Number.isFinite(diff)) return null;
  const expired = diff <= 0;
  const abs = Math.abs(diff);
  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const text = d > 0 ? `${d} 天${h > 0 ? ` ${h} 小时` : ''}` : h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
  return { expired, text };
}

/** 安全 URL：只允许 http/https，防止 javascript: 注入 */
function safeHref(url) {
  try {
    const u = new URL(String(url), location.origin);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Toast

function toast({ title, text, url, variant = '' }) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast${variant ? ` toast--${variant}` : ''}`;
  const link = safeHref(url);
  el.innerHTML = `
    <div class="toast-body">
      <p class="toast-title">${escapeHtml(title)}</p>
      <p class="toast-text">${escapeHtml(text ?? '')}${link ? ` <a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">查看</a>` : ''}</p>
    </div>
    <button class="toast-close" type="button" aria-label="关闭">×</button>`;
  el.querySelector('.toast-close').addEventListener('click', () => el.remove());
  box.appendChild(el);
  setTimeout(() => el.remove(), 12_000);
  // 最多同时显示 4 条
  while (box.children.length > 4) box.firstElementChild.remove();
}

// ---------------------------------------------------------------- 桌面通知

async function initNotifyButton() {
  const btn = $('#notify-btn');
  const supported = 'Notification' in window;
  if (!supported) {
    btn.disabled = true;
    btn.textContent = '🔕 不支持通知';
    return;
  }
  state.notifyEnabled = Notification.permission === 'granted';
  renderNotifyButton();

  btn.addEventListener('click', async () => {
    if (Notification.permission === 'granted') {
      // 已授权则当作开关：关闭页面内提示
      state.notifyEnabled = !state.notifyEnabled;
      renderNotifyButton();
      return;
    }
    const perm = await Notification.requestPermission();
    state.notifyEnabled = perm === 'granted';
    renderNotifyButton();
    if (state.notifyEnabled) {
      toast({ title: '桌面通知已开启', text: '发现新的限免时会弹出系统通知' });
    }
  });
}

function renderNotifyButton() {
  const btn = $('#notify-btn');
  if (!('Notification' in window)) return;
  if (Notification.permission === 'denied') {
    btn.disabled = true;
    btn.textContent = '🔕 通知被拒绝';
    btn.classList.remove('is-on');
    return;
  }
  btn.classList.toggle('is-on', state.notifyEnabled);
  btn.textContent = state.notifyEnabled ? '🔔 通知已开启' : '🔔 开启通知';
}

function desktopNotify(item, eventType) {
  if (!state.notifyEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && eventType !== 'became_free') return; // 页面可见时不打扰
  const title = eventType === 'became_free' ? '🎁 刚刚限免' : EVENT_TEXT[eventType] ?? '限免雷达';
  try {
    const n = new Notification(`${title}：${item.title}`, {
      body: [item.freeTypeLabel, item.originalPriceFormatted ? `原价 ${item.originalPriceFormatted}` : null]
        .filter(Boolean)
        .join(' · '),
      icon: item.image ?? undefined,
      tag: item.key,
    });
    n.onclick = () => {
      window.focus();
      const href = safeHref(item.url);
      if (href) window.open(href, '_blank', 'noopener');
      n.close();
    };
  } catch {
    /* 忽略通知异常 */
  }
}

// ---------------------------------------------------------------- 渲染：卡片

function sortItems(list) {
  const { sort } = state.filters;
  const arr = [...list];
  const prio = { keep: 0, key: 1, weekend: 2, f2p: 3, discount: 4, paid: 9 };
  if (sort === 'recent') {
    arr.sort((a, b) => String(b.firstSeenAt).localeCompare(String(a.firstSeenAt)));
  } else if (sort === 'discount') {
    arr.sort((a, b) => (b.discountPercent ?? 0) - (a.discountPercent ?? 0));
  } else if (sort === 'price') {
    // 价格从低到高（免费在前）
    arr.sort((a, b) => (a.finalPrice ?? 0) - (b.finalPrice ?? 0));
  } else if (sort === 'title') {
    arr.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  } else {
    // 默认"按价值"：类型优先级 -> 折扣深度 -> 评测数 -> 最近发现
    //
    // 把**评测数**纳入排序是有意的：永久免费条目多达数万，
    // 若只按发现时间排，前面全是没被评测过的冷门小游戏，
    // 用户根本看不到"特别好评 / 好评如潮"的内容，也没法据此判断质量。
    arr.sort((a, b) => {
      const p = (prio[a.freeType] ?? 9) - (prio[b.freeType] ?? 9);
      if (p !== 0) return p;
      const d = (b.discountPercent ?? 0) - (a.discountPercent ?? 0);
      if (d !== 0) return d;
      const r = (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
      if (r !== 0) return r;
      return String(b.firstSeenAt).localeCompare(String(a.firstSeenAt));
    });
  }
  return arr;
}

function visibleItems() {
  const f = state.filters;
  const { q, type, source, freeOnly, showEnded, showDemos } = f;
  const needle = q.trim().toLowerCase();
  const out = [];
  for (const item of state.items.values()) {
    if (!showEnded && item.active === false) continue;
    if (!showDemos && item.isDemo) continue;
    if (type !== 'all' && item.freeType !== type) continue;
    if (source !== 'all' && item.source !== source) continue;
    // 高折扣是参考信息（有独立的类型筛选与统计卡片），不该被"只看免费"连带隐藏，
    // 否则界面上"高折扣"永远是 0，看起来像没数据。付费且无折扣的条目不展示。
    if (freeOnly && item.finalPrice !== 0 && item.freeType !== 'key' && item.freeType !== 'discount') continue;
    if (item.freeType === 'paid') continue;
    // 折扣 / 价格区间
    if (f.minDiscount != null && (item.discountPercent ?? 0) < f.minDiscount) continue;
    if (f.maxDiscount != null && (item.discountPercent ?? 0) > f.maxDiscount) continue;
    if (f.minPrice != null && (item.finalPrice ?? 0) < f.minPrice) continue;
    if (f.maxPrice != null && (item.finalPrice ?? 0) > f.maxPrice) continue;
    // 评价筛选
    if (f.minReviewCount > 0 && (item.reviewCount ?? 0) < f.minReviewCount) continue;
    if (f.rating !== 'all' && !RATING_MATCH[f.rating]?.test(String(item.reviewSummary ?? ''))) continue;
    if (needle) {
      const hay = `${item.title} ${item.appId ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    out.push(item);
  }
  return sortItems(out);
}

/**
 * 折扣 / 价格区间筛选条。
 *
 * 只在"高折扣参考"类型下显示（区间对手游/永久免费没有意义）。
 * 区间按钮上的数字来自服务端 /api/facets 的真实分桶统计，
 * 因此**不会出现点了没结果的空区间**。
 */
let facetsCache = null;

async function ensureFacets() {
  if (facetsCache) return facetsCache;
  try {
    facetsCache = await fetchJson('/api/facets?type=discount');
  } catch {
    facetsCache = null;
  }
  return facetsCache;
}

function renderRangeBar() {
  const bar = $('#range-bar');
  if (!bar) return;
  const isDiscount = state.filters.type === 'discount';
  bar.hidden = !isDiscount;
  if (!isDiscount) return;

  const facets = facetsCache;
  const f = state.filters;
  const dChips = $('#discount-chips');
  const pChips = $('#price-chips');

  // 折扣区间
  if (dChips) {
    const buckets = (facets?.discountBuckets ?? []).filter((b) => b.count > 0);
    dChips.innerHTML = buckets
      .map((b) => {
        const active = f.minDiscount === b.min && f.maxDiscount === b.max;
        return `<button type="button" class="chip-btn${active ? ' is-active' : ''}"
          data-range="discount" data-min="${b.min}" data-max="${b.max}">${b.min}–${b.max}% <em>${b.count}</em></button>`;
      })
      .join('') || '<span class="range-empty">暂无折扣数据</span>';
  }

  // 价格区间（服务端单位是分）
  if (pChips) {
    const buckets = (facets?.priceBuckets ?? []).filter((b) => b.count > 0);
    pChips.innerHTML = buckets
      .map((b) => {
        const label = b.max == null ? `¥${b.min / 100}+` : `¥${b.min / 100}–${b.max / 100}`;
        const active = f.minPrice === b.min && f.maxPrice === b.max;
        return `<button type="button" class="chip-btn${active ? ' is-active' : ''}"
          data-range="price" data-min="${b.min}" data-max="${b.max ?? ''}">${label} <em>${b.count}</em></button>`;
      })
      .join('') || '<span class="range-empty">暂无价格数据</span>';
  }

  const total = facets?.total ?? 0;
  const shown = visibleItems().length;
  const summary = $('#range-summary');
  if (summary) {
    summary.textContent = facets ? `当前筛选 ${shown} / ${total} 条折扣` : '';
  }
}

/** 清除区间筛选 */
function clearRanges() {
  Object.assign(state.filters, { minDiscount: null, maxDiscount: null, minPrice: null, maxPrice: null });
}

/**
 * 评价档位匹配（与后端 RATING_TIERS 保持一致，含中英文写法）。
 * 前端做即时筛选，避免每次改筛选都打一次请求。
 */
const RATING_MATCH = {
  overwhelming: /好评如潮|Overwhelmingly Positive/i,
  veryPositive: /特别好评|Very Positive/i,
  positive: /多半好评|^好评$|^Positive$|Mostly Positive/i,
  mixed: /褒贬不一|Mixed/i,
  negative: /差评|Negative/i,
};

function renderCard(item, isNew = false) {
  const href = safeHref(item.url);
  const img = safeHref(item.image);
  const ended = item.active === false;
  const badgeClass = ended ? 'badge--ended' : `badge--${item.freeType}`;
  const badgeText = ended ? '已结束' : item.freeType === 'keep' && item.discountPercent === 100
    ? '100% OFF'
    : FREE_TYPE_TEXT[item.freeType] ?? item.freeType;

  const priceBits = [];
  if (item.originalPriceFormatted && item.finalPrice === 0) {
    priceBits.push(`<span class="price-orig">${escapeHtml(item.originalPriceFormatted)}</span>`);
    priceBits.push('<span class="price-free">免费</span>');
  } else if (item.finalPrice === 0) {
    priceBits.push('<span class="price-free">免费</span>');
  } else if (item.finalPriceFormatted) {
    priceBits.push(`<span class="price-final">${escapeHtml(item.finalPriceFormatted)}</span>`);
    if (item.originalPriceFormatted) {
      priceBits.push(`<span class="price-orig">${escapeHtml(item.originalPriceFormatted)}</span>`);
    }
  }

  const cd = countdown(item.endDate);
  // 评价：显示"特别好评 89% (141万条)"
  const reviewBits = [];
  if (item.reviewSummary) {
    const cls = reviewClass(item.reviewSummary);
    const pct = item.reviewPercent != null ? ` ${item.reviewPercent}%` : '';
    const cnt = item.reviewCount ? ` (${formatCount(item.reviewCount)})` : '';
    reviewBits.push(`<span class="chip chip--review ${cls}">${escapeHtml(item.reviewSummary)}${pct}${cnt}</span>`);
  } else if (item.reviewCount) {
    reviewBits.push(`<span class="chip chip--review">${formatCount(item.reviewCount)} 条评测</span>`);
  }

  const chips = [
    `<span class="chip chip--source">${escapeHtml(item.sourceLabel ?? item.source)}</span>`,
    ...reviewBits,
    item.discountPercent ? `<span class="chip">-${item.discountPercent}%</span>` : '',
    item.appId ? `<span class="chip">ID ${item.appId}</span>` : '',
    item.publishedDate ? `<span class="chip chip--time">${timeAgo(item.publishedDate)}发布</span>` : '',
    item.firstSeenAt ? `<span class="chip chip--time">${timeAgo(item.firstSeenAt)}发现</span>` : '',
    cd ? `<span class="chip ${cd.expired ? 'chip--ended' : 'chip--end'}">${cd.expired ? '已过期' : `剩 ${cd.text}`}</span>` : '',
    ended ? '<span class="chip chip--ended">已结束</span>' : '',
  ].filter(Boolean).join('');

  const desc = item.description ? `<p class="card-desc">${escapeHtml(item.description)}</p>` : '';

  return `
    <article class="card${ended ? ' card--ended' : ''}${isNew ? ' card--new' : ''}" data-key="${escapeHtml(item.key)}">
      <div class="card-media">
        <span class="${badgeClass} badge">${escapeHtml(badgeText)}</span>
        ${isNew ? '<span class="ribbon-new">NEW</span>' : ''}
        ${img
          ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'media-fallback',textContent:'暂无图片'}))" />`
          : '<div class="media-fallback">暂无图片</div>'}
      </div>
      <div class="card-body">
        <h3 class="card-title">${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</h3>
        ${priceBits.length ? `<div class="card-prices">${priceBits.join('')}</div>` : ''}
        ${desc}
        <div class="card-meta">${chips}</div>
        <div class="card-actions">
          ${href ? `<a class="btn btn--primary" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">前往 Steam</a>` : ''}
        </div>
      </div>
    </article>`;
}

/**
 * 单页渲染上限与"从服务端继续拉取"的批量。
 *
 * 设计目标（用户明确要求）：**每次打开都加载之前的数据，从没读到的继续读**。
 * 因此不再只拉固定 1200 条，而是：
 *   1. 首屏先拿到 PAGE_SIZE×4 条，立刻可交互
 *   2. 后台继续按 offset 分页把所有已存数据拉进来（受服务端 total 约束）
 *   3. 滚动到底时渲染更多卡片（渲染分页与数据分页解耦）
 */
const PAGE_SIZE = 120;
const FETCH_BATCH = PAGE_SIZE * 4;
let renderLimit = PAGE_SIZE;
/** 数据分页游标：下一次要从服务端 offset 取多少 */
let fetchOffset = 0;
let serverTotal = 0;
let fetchingMore = false;

function resetPaging() {
  renderLimit = PAGE_SIZE;
  fetchOffset = 0;
}

function renderGrid() {
  const grid = $('#grid');
  const list = visibleItems();

  if (!list.length) {
    grid.innerHTML = state.items.size
      ? `<div class="empty"><strong>没有符合筛选条件的条目</strong>试试放宽筛选条件，或清空搜索关键词。</div>`
      : `<div class="empty"><strong>正在采集数据…</strong>首次启动需要扫描 Steam 免费游戏候选集（约 6 万条），页面会自动刷新。若长时间为空，请查看下方"采集状态"。</div>`;
    grid.setAttribute('aria-busy', 'false');
    updateStats();
    return;
  }

  const shown = list.slice(0, renderLimit);
  // 只给最近新增的少量条目加高亮动画（大量元素同时做 box-shadow 动画非常耗性能）
  const recentNew = [...state.newKeys.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([k]) => k);
  const newSet = new Set(recentNew);

  let html = '';
  for (const item of shown) {
    html += renderCard(item, newSet.has(item.key));
  }
  if (list.length > shown.length) {
    html += `<div class="grid-more">
      <button id="load-more" class="btn btn--primary" type="button">
        加载更多（还有 ${list.length - shown.length} 条）
      </button>
    </div>`;
  }

  grid.innerHTML = html;
  grid.setAttribute('aria-busy', 'false');
  renderRangeBar();
  updateStats();
}

/** 提前加载：滚动接近底部时自动追加一批（走同一套限流渲染调度） */
function maybeLoadMore() {
  const list = visibleItems();
  if (list.length <= renderLimit) return;
  // 注意：offsetHeight 会触发布局，这里只在确实接近底部时才读取
  const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 600;
  if (!nearBottom) return;
  renderLimit += PAGE_SIZE;
  scheduleRender('grid', { immediate: true });
}

// ---------------------------------------------------------------- 渲染：统计

/**
 * 统计数字条。
 *
 * 覆盖**全部类型**（限时免费 / 免费周末 / 免费激活码 / 永久免费 / 高折扣），
 * 少显示的后果很直接：用户会以为那个类型没有数据（"免费周末"就这样被漏过一次）。
 *
 * 计数取自本地已加载数据；若服务端 summary 带 byType（首屏就有），
 * 则优先用服务端的权威值，避免"只加载了一部分"导致数字偏小。
 */
function updateStats() {
  const items = [...state.items.values()];
  const active = items.filter((i) => i.active !== false);
  const local = (type) => active.filter((i) => i.freeType === type).length;
  const serverByType = state.summary?.byType ?? null;
  const count = (type) => {
    const localCount = local(type);
    const serverCount = serverByType?.[type];
    // 服务端全量统计通常更大（本地可能只加载了一部分），取较大值
    return Number.isFinite(serverCount) ? Math.max(localCount, serverCount) : localCount;
  };

  setNum('#stat-keep', count('keep'));
  setNum('#stat-weekend', count('weekend'));
  setNum('#stat-key', count('key'));
  setNum('#stat-f2p', count('f2p'));
  setNum('#stat-discount', count('discount'));
  setNum('#stat-total', state.summary?.active ?? active.length);
  const last = state.summary?.lastEventAt;
  $('#stat-updated').textContent = last ? timeAgo(last) : '—';
}

function setNum(sel, value) {
  const el = $(sel);
  if (!el) return;
  el.textContent = String(value);
  // 数字为 0 时弱化显示，让人一眼看出"这个类型现在真的没有"
  const stat = typeof el.closest === 'function' ? el.closest('.stat') : null;
  stat?.classList.toggle('stat--zero', Number(value) === 0);
}

// ---------------------------------------------------------------- 渲染：动态

function renderFeed() {
  const ul = $('#feed');
  if (!state.events.length) {
    ul.innerHTML = '<li class="feed-empty">暂无事件，等待实时推送…</li>';
    $('#feed-count').textContent = '0 条';
    return;
  }
  ul.innerHTML = state.events
    .slice(0, 60)
    .map((e) => {
      const img = safeHref(e.image);
      const href = safeHref(e.url);
      const title = href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.title)}</a>`
        : escapeHtml(e.title);
      const detail = [
        EVENT_TEXT[e.type] ?? e.type,
        e.discountPercent ? `-${e.discountPercent}%` : null,
        e.originalPriceFormatted && e.isFreebie ? `原价 ${e.originalPriceFormatted}` : null,
      ].filter(Boolean).join(' · ');
      return `<li class="feed-item feed-item--${escapeHtml(e.type)}">
        ${img ? `<img class="feed-thumb" src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="feed-thumb"></span>'}
        <div class="feed-main">
          <p class="feed-title">${title}</p>
          <p class="feed-sub">${escapeHtml(detail)} · ${timeAgo(e.at)}</p>
        </div>
      </li>`;
    })
    .join('');
  $('#feed-count').textContent = `${state.events.length} 条`;
}

function pushEvent(event) {
  if (state.eventIds.has(event.id)) return;
  state.eventIds.add(event.id);
  state.events.unshift(event);
  if (state.events.length > 120) {
    for (const dropped of state.events.splice(120)) state.eventIds.delete(dropped.id);
  }
  scheduleRender('feed');
}

// ---------------------------------------------------------------- 数据加载

async function fetchJson(url, options) {
  const res = await fetch(url, { cache: 'no-store', ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 拉取快照并同步到本地。
 *
 * @param {{reset?: boolean}} [options]
 *   `reset: true` 用于**首次加载**：清空本地数据、分页与滚动位置。
 *   其余情况（从后台切回、SSE 重连、手动刷新）使用**合并**模式：
 *     - 只更新/补充服务端返回的条目，**不清空**本地已有的数据
 *     - 保留当前分页深度与滚动位置
 *   这是修复"切走再切回就从头开始"的关键：
 *   早期实现无条件 `state.items.clear()` + `resetPaging()`，
 *   于是每次切回标签页都丢掉已加载的内容、跳回第一屏、重新加载图片。
 */
async function bootstrap({ reset = false } = {}) {
  try {
    // 首次：从第 0 条开始按批拉取；之后：只拉一小批用于同步变化
    const offset = reset ? 0 : 0;
    const limit = reset ? FETCH_BATCH : FETCH_BATCH;
    const [itemsRes, eventsRes] = await Promise.all([
      fetchJson(`/api/items?limit=${limit}&offset=${offset}&includeEnded=1`),
      fetchJson('/api/events?limit=80'),
    ]);

    const incoming = itemsRes.items ?? [];
    if (reset) state.items.clear();

    let changed = false;
    for (const item of incoming) {
      const prev = state.items.get(item.key);
      // 无变化则不触发渲染（避免切回标签页时的整屏重建）
      if (!prev || prev.updatedAt !== item.updatedAt || prev.active !== item.active) changed = true;
      state.items.set(item.key, item);
      state.knownKeys.add(item.key);
    }

    serverTotal = itemsRes.total ?? incoming.length;
    fetchOffset = offset + incoming.length;
    state.summary = itemsRes.summary ?? null;
    state.total = serverTotal;
    state.demosHidden = itemsRes.demosHidden ?? 0;
    state.events = eventsRes.events ?? [];
    state.eventIds = new Set(state.events.map((e) => e.id));
    state.bootstrapped = true;

    if (reset) {
      resetPaging();
      renderGrid();
    } else if (changed) {
      // 合并模式下不 resetPaging()，也不动滚动位置
      scheduleRender('all');
    }
    renderFeed();
    updateStats();
    // 暴露给性能对照脚本（scripts/compare-perf.js）使用，便于量化渲染成本
    window.__perfHooks = { state, renderGrid, scheduleRender, refreshKeys, visibleItems };
    refreshStatus();

    // 首屏之后，后台继续把"之前已经存下来、但这次还没读到的"数据拉进来，
    // 做到"每次打开都能加载之前的全部数据，从未读取的继续读"。
    if (reset) void loadRemainingData();
  } catch (error) {
    if (reset) {
      $('#grid').innerHTML = `<div class="empty"><strong>加载失败</strong>${escapeHtml(error.message)}。请确认服务已启动，然后刷新页面。</div>`;
    }
  }
}

/**
 * 继续分页拉取剩余数据，直到服务端返回的条目全部读完。
 * 每批之间让出主线程，保证页面始终可交互。
 */
async function loadRemainingData() {
  if (fetchingMore) return;
  fetchingMore = true;
  try {
    let guard = 0;
    while (fetchOffset < serverTotal && guard < 200) {
      guard += 1;
      const res = await fetchJson(
        `/api/items?limit=${FETCH_BATCH}&offset=${fetchOffset}&includeEnded=1`,
      );
      const batch = res.items ?? [];
      if (!batch.length) break;
      for (const item of batch) {
        state.items.set(item.key, item);
        state.knownKeys.add(item.key);
      }
      fetchOffset += batch.length;
      serverTotal = res.total ?? serverTotal;
      // 数据变多了就刷新统计（渲染仍由滚动控制，避免一次性铺满 DOM）
      scheduleRender('stats');
      await new Promise((r) => setTimeout(r, 0));
    }
  } catch {
    /* 后台补数据失败不影响已有内容 */
  } finally {
    fetchingMore = false;
    scheduleRender('stats');
  }
}

/**
 * 渲染调度器：把同一时间窗内的多次渲染请求合并成一次（每帧最多一次）。
 *
 * 性能背景（实测）：
 *   抓取进行时，SSE 的 item 帧约每 700ms 到达一批，每批可达数百个 key；
 *   event 帧可能每秒数条。早期实现每批/每条都直接重建 DOM，而 renderGrid()
 *   会 `innerHTML =` 重建全部卡片（最多 1200 张，每张还含远程图片）。
 *   结果是浏览器主线程持续被数千个 DOM 节点 + 图片重载淹没，页面卡死"无法响应"。
 */
const dirty = { grid: false, stats: false, feed: false };
let renderScheduled = false;
let lastRenderAt = 0;
let throttleTimer = null;

/**
 * 数据驱动渲染的最小间隔（毫秒）。
 *
 * 实测（Chrome CPU 采样）：抓取期间主线程 72% 的时间耗在浏览器内部渲染
 * （layout/paint，由 `innerHTML` 重建卡片触发），renderGrid 自身占 12.3%。
 * 而数据到达速率只有约 8 条/秒 —— 以 60fps 去重建 DOM 完全是浪费。
 * 限流到 2 次/秒后，卡顿显著下降，视觉上依然是"实时"的。
 */
const RENDER_MIN_INTERVAL_MS = 500;

/** requestAnimationFrame 的兜底（便于在无 DOM 环境下测试调度逻辑）。 */
const nextFrame =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(() => fn(Date.now()), 16);

function runPendingRender() {
  renderScheduled = false;
  const work = { ...dirty };
  dirty.grid = false;
  dirty.stats = false;
  dirty.feed = false;
  lastRenderAt = Date.now();
  // renderGrid() 内部已包含 updateStats()
  if (work.grid) renderGrid();
  else if (work.stats) updateStats();
  if (work.feed) renderFeed();
}

/**
 * 请求渲染。数据驱动的更新会被限流（每 RENDER_MIN_INTERVAL_MS 最多一次），
 * 用户操作可用 immediate=true 立即渲染。
 *
 * @param {'all'|'grid'|'stats'|'feed'} part
 * @param {{immediate?: boolean}} [options]
 */
function scheduleRender(part = 'all', { immediate = false } = {}) {
  if (part === 'all') {
    dirty.grid = true;
    dirty.stats = true;
    dirty.feed = true;
  } else {
    dirty[part] = true;
  }
  if (renderScheduled || throttleTimer) return;

  if (immediate) {
    renderScheduled = true;
    nextFrame(runPendingRender);
    return;
  }

  const wait = RENDER_MIN_INTERVAL_MS - (Date.now() - lastRenderAt);
  if (wait <= 0) {
    renderScheduled = true;
    nextFrame(runPendingRender);
    return;
  }
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    nextFrame(runPendingRender);
  }, wait);
  throttleTimer.unref?.();
}

/**
 * 增量拉取队列：去重 + 限制并发。
 *
 * 早期实现直接 `Promise.allSettled(keys.slice(0,200).map(fetch))`，
 * 一批就是 200 个并发请求打向单线程 Node 服务，既拖慢服务端也让页面更卡。
 */
const pendingFetchKeys = new Set();
const fetchQueue = [];
let activeFetches = 0;
const MAX_CONCURRENT_FETCH = 6;

function enqueueKeys(keys) {
  for (const key of keys ?? []) {
    // 已经排队或正在请求的 key 不重复入队
    if (pendingFetchKeys.has(key)) continue;
    pendingFetchKeys.add(key);
    fetchQueue.push(key);
  }
  pumpFetchQueue();
}

function pumpFetchQueue() {
  while (activeFetches < MAX_CONCURRENT_FETCH && fetchQueue.length) {
    const key = fetchQueue.shift();
    activeFetches += 1;
    fetchJson(`/api/item/${encodeURIComponent(key)}`)
      .then((res) => {
        const item = res?.item;
        if (!item) return;
        if (!state.knownKeys.has(item.key)) {
          state.knownKeys.add(item.key);
          state.newKeys.set(item.key, Date.now());
        }
        state.items.set(item.key, item);
        scheduleRender();
      })
      .catch(() => {
        /* 单条失败不影响其它条目 */
      })
      .finally(() => {
        pendingFetchKeys.delete(key);
        activeFetches -= 1;
        pumpFetchQueue();
      });
  }
}

/** 只重新拉取指定 key 的条目（增量更新，走限流队列） */
function refreshKeys(keys) {
  if (!keys?.length) return;
  enqueueKeys(keys);
}

/**
 * 渲染数据新鲜度提示。
 *
 * 动机：Steam 偶发不可达时，数据源会连续失败，但页面照旧显示缓存数据，
 * 用户完全看不出"这些数据已经不再更新了"。这里把它显性化。
 */
function renderFreshness(freshness) {
  const el = $('#banner');
  if (!el) return;
  if (!freshness || !freshness.stale) {
    el.hidden = true;
    return;
  }
  const age = freshness.dataAgeMs;
  const ageText =
    age == null ? '尚无成功抓取记录' : age < 60_000 ? `${Math.round(age / 1000)} 秒前` : `${Math.round(age / 60_000)} 分钟前`;
  const failing = (freshness.failingSources ?? []).join('、') || '部分数据源';
  el.hidden = false;
  el.innerHTML = `
    <span class="banner-icon" aria-hidden="true">⚠️</span>
    <div class="banner-body">
      <p class="banner-title">数据可能不是最新的</p>
      <p>${escapeHtml(failing)} 抓取失败（最近一次成功抓取：${escapeHtml(ageText)}）。
         页面展示的是已缓存的内容，服务会持续自动重试，通常是 Steam 侧网络或限流导致。</p>
    </div>`;
}

async function refreshStatus() {
  try {
    const s = await fetchJson('/api/status');
    state.summary = s.summary ?? state.summary;
    renderFreshness(s.freshness);
    const rows = (s.sources ?? [])
      .map((src) => {
        const st = src.stats ?? {};
        const ok = st.ok !== false;
        const detail = src.lastResult?.ok === false
          ? `<span class="status-err">${escapeHtml(src.lastResult.error ?? '失败')}</span>`
          : `${st.count ?? 0} 条 / ${src.lastDurationMs ?? '—'}ms`;
        return `<tr>
          <td>${escapeHtml(src.name)}</td>
          <td class="${ok ? 'status-ok' : 'status-err'}">${ok ? '正常' : '异常'}</td>
          <td>${detail}</td>
          <td>${src.nextRunAt ? timeAgo(src.nextRunAt).replace('前', '后') || '即将' : '—'}</td>
        </tr>`;
      })
      .join('');
    $('#status-body').innerHTML = `
      <div class="status-grid">
        <div>运行时长：<strong>${Math.floor((s.uptimeMs ?? 0) / 60000)} 分钟</strong></div>
        <div>SSE 在线客户端：<strong>${s.realtime?.clients ?? 0}</strong></div>
        <div>HTTP 请求：<strong>${s.http?.requests ?? 0}</strong>（失败 ${s.http?.failed ?? 0}）</div>
        <div>重试次数：<strong>${s.http?.retries ?? 0}</strong></div>
        <div>待校验候选：<strong>${s.summary?.pendingVerification ?? 0}</strong> 个${
          s.summary?.pendingToVerify != null
            ? `（其中需花配额校验 ${s.summary.pendingToVerify} 个）`
            : ''
        }</div>
        <div>已知促销商品：<strong>${s.summary?.specialsKnown ?? 0}</strong></div>
        <div>已加载数据：<strong>${state.items.size}</strong> / 服务端 ${state.total ?? '?'} 条${
          state.items.size < (state.total ?? 0) ? '（后台继续加载中…）' : ''
        }</div>
        <div>已隐藏试玩版：<strong>${state.demosHidden ?? 0}</strong></div>
        <div>数据落盘：<strong>${s.summary?.total ?? 0}</strong> 条</div>
        <div>最近成功抓取：<strong>${s.freshness?.lastSuccessAt ? timeAgo(s.freshness.lastSuccessAt) : '—'}</strong></div>
        <div>历史峰值：<strong>${s.summary?.peakItems ?? 0}</strong> 条${
          s.summary?.peakItems && s.summary.total < s.summary.peakItems * 0.9
            ? ` <span class="status-err">（较峰值少 ${s.summary.peakItems - s.summary.total} 条）</span>`
            : ''
        }</div>
      </div>
      <table>
        <thead><tr><th>数据源</th><th>状态</th><th>最近结果</th><th>下次运行</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">没有启用的数据源</td></tr>'}</tbody>
      </table>`;
    scheduleRender('stats');
  } catch {
    $('#status-body').textContent = '无法获取采集状态';
  }
}

// ---------------------------------------------------------------- SSE

let source = null;
let reconnectTimer = null;

function setConn(status, text) {
  const el = $('#conn');
  el.className = `conn conn--${status}`;
  $('#conn-text').textContent = text;
  $('#feed-live').classList.toggle('is-idle', status !== 'live');
  state.connected = status === 'live';
}

function connect() {
  if (source) source.close();
  setConn('connecting', '连接中…');
  source = new EventSource('/api/stream');

  source.addEventListener('open', () => setConn('live', '实时推送中'));

  source.addEventListener('hello', (ev) => {
    setConn('live', '实时推送中');
    try {
      const data = JSON.parse(ev.data);
      if (data.summary) state.summary = { ...state.summary, ...data.summary };
      scheduleRender('stats');
    } catch { /* ignore */ }
  });

  source.addEventListener('event', (ev) => {
    let event;
    try {
      event = JSON.parse(ev.data);
    } catch {
      return;
    }
    pushEvent(event);

    const item = state.items.get(event.key) ?? {
      key: event.key,
      title: event.title,
      url: event.url,
      image: event.image,
      freeType: event.freeType,
      freeTypeLabel: FREE_TYPE_TEXT[event.freeType],
      originalPriceFormatted: event.originalPriceFormatted,
      active: true,
    };

    // 只对真正值得打扰的事件做系统通知：
    //   became_free            —— 原本收费的商品刚刚变成免费（最有价值）
    //   discovered + key/weekend —— 新的限免激活码 / 免费周末
    // 永久免费(F2P)游戏数量巨大，首次收录时不弹通知，避免刷屏。
    const worthNotifying =
      event.type === 'became_free' ||
      (event.type === 'discovered' && (event.freeType === 'key' || event.freeType === 'weekend'));
    if (worthNotifying) {
      desktopNotify(item, event.type);
      toast({
        title: `${EVENT_TEXT[event.type] ?? event.type}：${event.title}`,
        text: [item.freeTypeLabel, event.originalPriceFormatted ? `原价 ${event.originalPriceFormatted}` : null, '现在免费']
          .filter(Boolean)
          .join(' · '),
        url: event.url,
        variant: 'free',
      });
    }

    // 让新条目在网格中高亮
    if (event.type === 'discovered' || event.type === 'became_free') {
      state.newKeys.set(event.key, Date.now());
    }
    refreshKeys([event.key]);
  });

  source.addEventListener('item', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      refreshKeys(data.keys);
    } catch { /* ignore */ }
  });

  source.addEventListener('error', () => {
    setConn('down', '连接断开，重试中…');
    // 浏览器会自动重连；这里只更新 UI，并在重连后补一次快照（合并模式，不清空已有数据）
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!state.connected) bootstrap();
    }, 5000);
  });
}

// ---------------------------------------------------------------- 交互绑定

function bindFilters() {
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  /** 筛选条件变化：重置分页后立即渲染（用户操作不该被限流延迟） */
  const applyFilters = () => {
    resetPaging();
    scheduleRender('all', { immediate: true });
  };

  // 选中"高折扣参考"时展开区间筛选条，并拉取真实的区间分布
  const onTypeChange = async (type) => {
    state.filters.type = type;
    if (type === 'discount') {
      clearRanges();
      await ensureFacets();
    }
    applyFilters();
  };

  $('#q').addEventListener('input', debounce((e) => {
    state.filters.q = e.target.value;
    applyFilters();
  }, 220));
  $('#filter-type').addEventListener('change', (e) => {
    void onTypeChange(e.target.value);
  });
  $('#filter-source').addEventListener('change', (e) => {
    state.filters.source = e.target.value;
    applyFilters();
  });
  $('#sort').addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    applyFilters();
  });
  $('#free-only').addEventListener('change', (e) => {
    state.filters.freeOnly = e.target.checked;
    applyFilters();
  });
  $('#show-demos').addEventListener('change', (e) => {
    state.filters.showDemos = e.target.checked;
    applyFilters();
  });
  $('#show-ended').addEventListener('change', (e) => {
    state.filters.showEnded = e.target.checked;
    applyFilters();
  });

  // 评价筛选：评价档位 + 评测数下限（前端即时筛选，不发请求）
  $('#filter-rating').addEventListener('change', (e) => {
    state.filters.rating = e.target.value;
    applyFilters();
  });
  $('#filter-review-count').addEventListener('change', (e) => {
    state.filters.minReviewCount = Number.parseInt(e.target.value, 10) || 0;
    applyFilters();
  });

  // 「加载更多」用事件委托（按钮是每次渲染重建的）
  $('#grid').addEventListener('click', (e) => {
    if (e.target?.id !== 'load-more') return;
    renderLimit += PAGE_SIZE;
    scheduleRender('grid', { immediate: true });
  });
  window.addEventListener('scroll', maybeLoadMore, { passive: true });

  // 统计卡片可点击筛选：点"免费周末"就只看免费周末，点"收录总数"回到全部
  $('#stats').addEventListener('click', (e) => {
    const btn = e.target.closest('.stat--clickable');
    if (!btn) return;
    const type = btn.dataset.type ?? 'all';
    const select = $('#filter-type');
    if (select) select.value = type;
    void onTypeChange(type);
  });

  // 折扣 / 价格区间：点选切换（再点一次取消该区间）
  $('#range-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-btn');
    if (!btn) return;
    const kind = btn.dataset.range; // 'discount' | 'price'
    const min = Number.parseFloat(btn.dataset.min);
    const maxRaw = btn.dataset.max;
    const max = maxRaw === '' || maxRaw == null ? null : Number.parseFloat(maxRaw);
    const f = state.filters;
    const isActive = kind === 'discount'
      ? f.minDiscount === min && f.maxDiscount === max
      : f.minPrice === min && f.maxPrice === max;

    if (isActive) {
      clearRanges();
    } else if (kind === 'discount') {
      f.minDiscount = min;
      f.maxDiscount = max;
    } else {
      f.minPrice = min;
      f.maxPrice = max;
    }
    applyFilters();
  });

  $('#range-reset').addEventListener('click', () => {
    clearRanges();
    applyFilters();
  });

  $('#feed-clear').addEventListener('click', () => {
    state.events = [];
    state.eventIds = new Set();
    renderFeed();
  });

  $('#refresh-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '⟳ 抓取中…';
    try {
      await fetchJson('/api/refresh?pages=12', { method: 'POST' });
      await bootstrap();
      toast({ title: '刷新完成', text: '已重新扫描数据源' });
    } catch (err) {
      toast({ title: '刷新失败', text: err.message, variant: 'ended' });
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

/** 每分钟刷新一次相对时间显示；过期的"NEW"高亮直接靠下次渲染自然消失 */
function startClock() {
  setInterval(() => {
    if (document.hidden) return;
    const cutoff = Date.now() - 90_000;
    let pruned = false;
    for (const [key, at] of state.newKeys) {
      if (at < cutoff) {
        state.newKeys.delete(key);
        pruned = true;
      }
    }
    // 只有确实有高亮过期时才重渲染，避免每分钟无谓重建 DOM
    if (pruned) renderGrid();
    else updateStats();
  }, 60_000);
}

// ---------------------------------------------------------------- 启动

async function main() {
  bindFilters();
  await initNotifyButton();
  // 首次加载：清空并重置分页/滚动
  await bootstrap({ reset: true });
  connect();
  startClock();
  // 采集状态定期刷新（SSE 只推送数据变更，不推送调度状态）
  setInterval(() => {
    if (!document.hidden) refreshStatus();
  }, 30_000);
  // 页面重新可见时补一次快照（合并模式）：
  // 只同步变化的数据，保留已加载的分页与滚动位置。
  // 关键：长时间挂起后应该"刷新"而不是"重来"。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.bootstrapped) {
      bootstrap({ reset: false });
      // SSE 在后台可能被浏览器断开，回来后主动确认一下连接
      if (!state.connected) connect();
    }
  });
}

main();
