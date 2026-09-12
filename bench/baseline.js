/**
 * 性能对照基准页（仅用于验证修复效果，不参与产品功能）。
 *
 * 用**旧实现**的方式渲染同一批数据：
 *   - 一次性渲染全部 1200 张卡片（无分页）
 *   - 每收到一批 SSE item 帧就 `innerHTML` 重建整个网格（无合并）
 *   - 每批并行发起最多 200 个 /api/item 请求（无限流）
 *
 * 通过 /bench/baseline.html 访问，配合 bench/browser-perf.js 对比主线程阻塞情况。
 */
const $ = (s) => document.querySelector(s);

const state = { items: new Map(), events: [], knownKeys: new Set() };
let renderCount = 0;

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderCard(item) {
  return `<article class="card" data-key="${escapeHtml(item.key)}">
    <div class="card-media">
      <span class="badge badge--f2p">永久免费</span>
      ${item.image ? `<img src="${escapeHtml(item.image)}" loading="lazy" />` : '<div class="media-fallback">暂无图片</div>'}
    </div>
    <div class="card-body">
      <h3 class="card-title">${escapeHtml(item.title)}</h3>
      <div class="card-prices"><span class="price-free">免费</span></div>
      <div class="card-meta"><span class="chip chip--source">Steam</span><span class="chip">ID ${item.appId ?? '-'}</span></div>
      <div class="card-actions"><a class="btn btn--primary" href="${escapeHtml(item.url ?? '#')}" target="_blank" rel="noopener">前往 Steam</a></div>
    </div>
  </article>`;
}

/** 旧实现：全量重建，无分页、无合并 */
function renderGridLegacy() {
  const list = [...state.items.values()];
  $('#grid').innerHTML = list.map(renderCard).join('');
  renderCount += 1;
  $('#stat-total').textContent = list.length;
  $('#render-count').textContent = String(renderCount);
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  return r.json();
}

/** 旧实现：无并发限制、无去重 */
async function refreshKeysLegacy(keys) {
  const results = await Promise.allSettled(
    keys.slice(0, 200).map((k) => fetchJson(`/api/item/${encodeURIComponent(k)}`)),
  );
  let changed = false;
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value?.item) continue;
    state.items.set(r.value.item.key, r.value.item);
    changed = true;
  }
  if (changed) renderGridLegacy();
}

async function main() {
  // 为了更贴近真实的"全量库"场景，尽量取满 2000 条
  const res = await fetchJson('/api/items?limit=2000&includeEnded=1&freeOnly=0');
  for (const item of res.items) {
    state.items.set(item.key, item);
    state.knownKeys.add(item.key);
  }
  renderGridLegacy();

  // 暴露给性能脚本：模拟"抓取持续进行"时的渲染风暴。
  // 旧实现在这种情况下会每批数据 / 每条事件都重建整个网格。
  window.__renderStorm = async (bursts = 10, perBurst = 20, gapMs = 700) => {
    const keys = [...state.items.keys()];
    if (!keys.length) return 0;
    for (let b = 0; b < bursts; b += 1) {
      // 与产品页一致的负载：每批取出一段真实存在的 key 并刷新
      const start = (b * perBurst) % keys.length;
      const slice = keys.slice(start, start + perBurst);
      await refreshKeysLegacy(slice);
      await new Promise((r) => setTimeout(r, gapMs));
    }
    return renderCount;
  };
  window.__renderCount = () => renderCount;
  window.__domNodes = () => document.getElementsByTagName('*').length;
  window.__itemCount = () => state.items.size;

  const src = new EventSource('/api/stream');
  src.addEventListener('item', (ev) => {
    try {
      refreshKeysLegacy(JSON.parse(ev.data).keys ?? []);
    } catch { /* ignore */ }
  });
  src.addEventListener('event', (ev) => {
    try {
      const e = JSON.parse(ev.data);
      state.events.unshift(e);
      $('#feed').innerHTML = state.events
        .slice(0, 60)
        .map((x) => `<li class="feed-item"><div class="feed-main"><p class="feed-title">${escapeHtml(x.title)}</p><p class="feed-sub">${escapeHtml(x.type)}</p></div></li>`)
        .join('');
    } catch { /* ignore */ }
  });
  src.addEventListener('open', () => {
    $('#conn-text').textContent = '实时推送中';
    $('#conn').className = 'conn conn--live';
  });
}

main();
