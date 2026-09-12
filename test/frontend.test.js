/**
 * 前端渲染调度与请求队列的行为测试。
 *
 * 目的：把"页面卡死"这类性能回归固化成可自动运行的断言。
 * 做法：加载 public/app.js（在 Node 中提供最小 DOM 桩），
 *       断言在大量事件/增量到达时：
 *         1) DOM 重建次数被合并到接近帧数，而不是每次事件一次
 *         2) /api/item 请求并发数有上限，不会一次性打出几百个并发
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP_SOURCE = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');

/** 统计一次运行中的渲染与请求行为。 */
async function runApp({ eventCount = 200, itemBatchSize = 200, batches = 5, burstCalls = 0, skipStorm = false } = {}) {
  const counters = { gridRenders: 0, feedRenders: 0, statsRenders: 0, itemRequests: 0, maxConcurrent: 0 };
  let activeRequests = 0;
  const frameQueue = [];
  const timers = [];
  const pendingResolvers = [];

  // ---- 最小 DOM 桩 -------------------------------------------------------
  const makeEl = (id) => ({
    id,
    _html: '',
    textContent: '',
    dataset: {},
    disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    setAttribute() {},
    querySelector: () => null,
    appendChild() {},
    remove() {},
    replaceWith() {},
    get firstElementChild() {
      return null;
    },
    get children() {
      return [];
    },
    set innerHTML(v) {
      this._html = v;
      if (id === 'grid') counters.gridRenders += 1;
      if (id === 'feed') counters.feedRenders += 1;
    },
    get innerHTML() {
      return this._html;
    },
  });

  const elements = new Map();
  const getEl = (sel) => {
    const id = String(sel).replace(/^#/, '');
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  const documentStub = {
    hidden: false,
    visibilityState: 'visible',
    querySelector: getEl,
    querySelectorAll: () => [],
    createElement: () => makeEl('created'),
    addEventListener() {},
    body: { offsetHeight: 1000 },
  };

  const state = {
    statTexts: {},
  };
  // 让 updateStats 里的 textContent 赋值可计数
  for (const id of ['stat-keep', 'stat-key', 'stat-f2p', 'stat-discount', 'stat-total', 'stat-updated', 'feed-count', 'status-body', 'conn-text']) {
    const el = getEl(`#${id}`);
    let v = '';
    Object.defineProperty(el, 'textContent', {
      get: () => v,
      set: (nv) => {
        v = nv;
        if (id.startsWith('stat-') || id === 'feed-count') counters.statsRenders += 1;
      },
    });
  }

  // ---- fetch 桩 ---------------------------------------------------------
  const itemOf = (key) => ({
    key,
    title: `Game ${key}`,
    source: 'steam-catalog',
    sourceLabel: 'Steam 商店扫描',
    freeType: 'f2p',
    freeTypeLabel: '永久免费',
    active: true,
    finalPrice: 0,
    isFree: true,
    isFreebie: true,
    url: `https://store.steampowered.com/app/${key.split(':')[1]}/`,
    image: null,
    firstSeenAt: new Date().toISOString(),
  });

  const itemsResponse = () => ({
    total: 1,
    summary: { active: 1, lastEventAt: new Date().toISOString() },
    demosHidden: 0,
    items: [itemOf('steam-catalog:1')],
  });

  const fetchStub = async (url) => {
    const u = String(url);
    let body;
    if (u.startsWith('/api/item/')) {
      counters.itemRequests += 1;
      activeRequests += 1;
      counters.maxConcurrent = Math.max(counters.maxConcurrent, activeRequests);
      // 让请求"挂起"一小段时间，以便观察并发上限
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          activeRequests -= 1;
          resolve();
        }, 5);
        timers.push(t);
      });
      const key = decodeURIComponent(u.slice('/api/item/'.length));
      body = { ok: true, item: itemOf(key) };
    } else if (u.startsWith('/api/status')) {
      body = { ok: true, sources: [], summary: { active: 1 }, realtime: { clients: 1 }, http: {}, uptimeMs: 1 };
    } else if (u.startsWith('/api/events')) {
      body = { total: 0, events: [] };
    } else {
      body = itemsResponse();
    }
    return { ok: true, status: 200, json: async () => body };
  };

  // ---- 执行 app.js ------------------------------------------------------
  const module = new Function(
    'document',
    'window',
    'fetch',
    'EventSource',
    'Notification',
    'location',
    'requestAnimationFrame',
    'setInterval',
    'setTimeout',
    'CSS',
    'console',
    `
    ${APP_SOURCE}
    return { state, scheduleRender, refreshKeys, pushEvent, renderGrid, connect, bootstrap, resetPaging, visibleItems };
    `,
  );

  const raf = (fn) => {
    frameQueue.push(fn);
    return frameQueue.length;
  };

  /** 记录被 delay>0 调度的定时器（限流分支），不实际执行以免递归 */
  const delayedTimers = [];
  const setTimeoutStub = (fn, ms) => {
    if (typeof ms === 'number' && ms > 0) {
      delayedTimers.push(fn);
      return -delayedTimers.length;
    }
    const t = setTimeout(fn, 0);
    timers.push(t);
    return t;
  };

  const captured = module(
    documentStub,
    { addEventListener() {}, innerHeight: 800, scrollY: 0, open() {}, focus() {} },
    fetchStub,
    class FakeEventSource {
      constructor() {
        this.listeners = new Map();
      }
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      }
      emit(type, data) {
        for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
      }
      close() {}
    },
    undefined, // Notification 不存在 -> 通知功能自动降级
    { origin: 'http://127.0.0.1:8787' },
    raf,
    () => 0, // setInterval：测试里不跑定时器
    setTimeoutStub,
    { escape: (s) => s },
    { log() {}, warn() {}, error() {} },
  );

  // 等待 bootstrap（会 await fetch）
  await new Promise((r) => setTimeout(r, 20));
  captured.counters = counters;
  captured.elements = elements;

  // 只搭环境、不施加渲染压力（供状态类测试使用）
  if (skipStorm) return { captured, counters, frameQueue, delayedTimers };
  // 清掉 bootstrap 期间的渲染计数，只看随后的风暴
  counters.gridRenders = 0;
  counters.feedRenders = 0;
  counters.windowStart = Date.now();

  // ---- 模拟抓取风暴 ------------------------------------------------------
  captured.connect();

  // 场景一：同一事件循环内的突发变更（真实抓取时一批 SSE 帧同时到达）
  // 旧实现会对每一次变更都立刻重建 DOM，这里应被合并为 0 次（还没到下一帧）
  for (let i = 0; i < eventCount; i += 1) {
    captured.pushEvent({
      id: `e${i}`,
      type: 'discovered',
      at: new Date().toISOString(),
      key: `steam-catalog:${i}`,
      title: `Game ${i}`,
      freeType: 'f2p',
      isFreebie: true,
    });
  }
  const rendersAfterBurst = counters.feedRenders;

  // 场景二：多批增量条目（走限流队列，异步到达）
  for (let b = 0; b < batches; b += 1) {
    const keys = [];
    for (let i = 0; i < itemBatchSize; i += 1) keys.push(`steam-catalog:${b * itemBatchSize + i}`);
    captured.refreshKeys(keys);
  }

  // 让请求与帧完成
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && (frameQueue.length || activeRequests)) {
    while (frameQueue.length) frameQueue.shift()(Date.now());
    if (!frameQueue.length && !activeRequests) break;
    await new Promise((r) => setTimeout(r, 5));
  }

  // 限流契约测试：同步连续请求大量渲染，统计实际"排队"的渲染回调数。
  // 注意：未到时间窗时 scheduleRender 会走 setTimeout(throttle) 分支，
  // 因此这里同时统计 rAF 队列与延迟定时器。
  if (burstCalls > 0) {
    const rafBefore = frameQueue.length;
    const timerBefore = delayedTimers.length;
    for (let i = 0; i < burstCalls; i += 1) captured.scheduleRender('grid');
    counters.callbacksQueued = frameQueue.length - rafBefore + (delayedTimers.length - timerBefore);
  }

  while (frameQueue.length) frameQueue.shift()(Date.now());
  // 触发被限流延迟的渲染（throttle 分支），并排空它产生的 rAF
  while (delayedTimers.length) {
    const fn = delayedTimers.shift();
    fn();
    while (frameQueue.length) frameQueue.shift()(Date.now());
  }

  return { ...counters, rendersAfterBurst, totalChanges: eventCount + batches * itemBatchSize };
}

/**
 * 只做环境搭建（DOM 桩 + 加载 app.js + 跑完首次 bootstrap），
 * 不做渲染风暴模拟。供"合并模式"这类状态测试使用。
 */
async function setupApp() {
  const { captured } = await runApp({ eventCount: 0, itemBatchSize: 0, batches: 0, skipStorm: true });
  return { captured };
}

test('同步突发的大量变更只触发一次渲染（关键：避免每次变更都重建 DOM）', async () => {
  const c = await runApp({ eventCount: 300, itemBatchSize: 200, batches: 5 });
  // 旧实现：300 个事件 → 300 次动态栏重建；这里应为 0（尚未到下一帧）
  assert.equal(
    c.rendersAfterBurst,
    0,
    `同步突发期间不应发生渲染，实际 ${c.rendersAfterBurst}（旧实现会达到 ${300} 次）`,
  );
  assert.ok(c.gridRenders >= 1, '突发结束后仍必须渲染');
});

test('整场风暴的渲染次数远小于变更次数，且请求并发受控', async () => {
  const c = await runApp({ eventCount: 300, itemBatchSize: 200, batches: 5 });
  assert.ok(
    c.gridRenders < c.totalChanges / 4,
    `网格重建 ${c.gridRenders} 次应远小于变更 ${c.totalChanges} 次`,
  );
  assert.ok(c.maxConcurrent <= 6, `并发请求应不超过 6，实际 ${c.maxConcurrent}`);
});

test('增量请求并发受控，不会一次性打出数百个并发', async () => {
  const c = await runApp({ eventCount: 10, itemBatchSize: 300, batches: 4 });
  assert.ok(
    c.maxConcurrent <= 6,
    `并发请求应不超过 6，实际 ${c.maxConcurrent}`,
  );
  // 去重 + 队列化后，每个 key 只请求一次
  assert.equal(c.itemRequests, 1200, '4 批 × 300 个不同的 key 应各请求一次');
});

test('重复的 key 会被去重，不重复请求', async () => {
  const c = await runApp({ eventCount: 5, itemBatchSize: 50, batches: 3 });
  // 3 批 × 50 = 150 个唯一 key
  assert.equal(c.itemRequests, 150);
});

test('渲染被时间限流：同步连续请求只会排队一次渲染', async () => {
  // app.js 中 RENDER_MIN_INTERVAL_MS=500（每个目标每秒最多 2 次）。
  // 这里直接验证限流的核心契约：同一时间窗内连续请求会被合并，只排队一次。
  const c = await runApp({ eventCount: 0, itemBatchSize: 0, batches: 0, burstCalls: 200 });
  assert.ok(
    c.callbacksQueued <= 2,
    `连续 200 次渲染请求应被合并（最多各目标一次），实际排队 ${c.callbacksQueued} 次`,
  );
  assert.ok(c.callbacksQueued >= 1, '至少要排队一次渲染');
});

test('统计条覆盖所有类型（回归：曾漏掉"免费周末"）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..');

  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

  // 每种免费形态都必须有自己的统计元素，否则用户会以为该类型没数据
  const required = [
    ['keep', '限时免费'],
    ['weekend', '免费周末'],
    ['key', '免费激活码'],
    ['f2p', '永久免费'],
    ['discount', '高折扣'],
  ];
  for (const [type, label] of required) {
    assert.match(html, new RegExp(`id="stat-${type}"`), `统计条缺少 ${type} 的显示位（${label}）`);
    assert.match(app, new RegExp(`setNum\\('#stat-${type}'`), `app.js 没有给 stat-${type} 赋值`);
  }
  // 后端也必须提供对应计数
  assert.match(app, /count\('weekend'\)/, 'app.js 应统计免费周末数量');
  assert.match(html, /id="stat-total"/, '应有收录总数');
});

test('统计卡片可点击筛选，且带 data-type', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

  for (const type of ['keep', 'weekend', 'key', 'f2p', 'discount', 'all']) {
    assert.match(html, new RegExp(`data-type="${type}"`), `缺少可点击统计卡 data-type=${type}`);
  }
  assert.match(app, /closest\('\.stat--clickable'\)/, '应处理统计卡点击');
});

test('限流配置存在且有合理上限（防止误改成无限渲染）', () => {
  const m = APP_SOURCE.match(/const RENDER_MIN_INTERVAL_MS = (\d+)/);
  assert.ok(m, '应定义 RENDER_MIN_INTERVAL_MS');
  const ms = Number(m[1]);
  assert.ok(ms >= 100, `渲染间隔不应过小（${ms}ms 会导致频繁重建 DOM）`);
  assert.ok(ms <= 2000, `渲染间隔不应过大（${ms}ms 会让界面显得不实时）`);
});

test('切回页面/重连时用合并模式：不清空已加载数据、不重置分页（回归：曾导致"从头开始"）', async () => {
  const { captured } = await setupApp();
  const { state, bootstrap, resetPaging } = captured;

  // 模拟用户已经浏览到第 3 页
  state.items.set('steam-catalog:99999', {
    key: 'steam-catalog:99999',
    title: '用户已加载但服务端快照里没有的条目',
    freeType: 'f2p',
    finalPrice: 0,
    isFree: true,
    active: true,
    source: 'steam-catalog',
    firstSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const before = state.items.size;
  assert.ok(before >= 1);

  // 合并模式（切回标签页 / SSE 重连走的就是这条路径）
  await bootstrap({ reset: false });

  assert.ok(
    state.items.has('steam-catalog:99999'),
    '合并模式下不应清空本地已有数据 —— 这正是"切走再切回就从头开始"的根因',
  );
  assert.ok(state.items.size >= before, `条目数不应减少（${before} -> ${state.items.size}）`);
  assert.equal(state.bootstrapped, true);
});

test('首次加载（reset:true）才清空并重置分页', async () => {
  const { captured } = await setupApp();
  const { state, bootstrap } = captured;

  state.items.set('steam-catalog:88888', {
    key: 'steam-catalog:88888', title: '旧数据', freeType: 'f2p', finalPrice: 0,
    isFree: true, active: true, source: 'steam-catalog',
    firstSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  await bootstrap({ reset: true });
  assert.equal(state.items.has('steam-catalog:88888'), false, 'reset 模式应清空本地数据');
  assert.ok(state.items.size >= 1, 'reset 后应载入服务端快照');
});
