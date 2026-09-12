/**
 * HTTP API 与 SSE 集成测试（使用真实 http 服务器 + 假数据源，不联网）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Poller } from '../src/poller.js';
import { RealtimeHub } from '../src/realtime.js';
import { createServer } from '../src/webServer.js';
import { FREE_TYPE, SOURCE } from '../src/model.js';

/** 一个可控的假数据源，用于验证调度器与 API，不产生真实网络请求。 */
class FakeSource {
  constructor(name, result) {
    this.name = name;
    this.result = result;
    this.calls = 0;
  }
  async runOnce() {
    this.calls += 1;
    return this.result;
  }
  get authoritative() {
    return false;
  }
}

const cfg = (over = {}) => ({
  host: '127.0.0.1',
  port: 0,
  publicDir: path.resolve(import.meta.dirname, '..', 'public'),
  benchDir: path.resolve(import.meta.dirname, '..', 'bench'),
  webhookUrl: '',
  steam: { cc: 'cn', lang: 'schinese', sweepIntervalMs: 60000, sweepPagesPerCycle: 1, watchlistIntervalMs: 60000, watchlistBatch: 1 },
  gamerpower: { intervalMs: 60000, url: 'http://example.invalid' },
  enabled: { steamSpecials: true, steamWatchlist: true, gamerpower: true, steamSpotlight: true, steamDiscounts: true },
  watchlistAppIds: [],
  ...over,
});

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-api-'));
  const store = new Store({ dataDir: dir });
  const poller = new Poller({
    http: {},
    store,
    config: cfg(),
    logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
  });
  // 替换为假数据源，避免真实请求
  poller.entries.clear();
  const fake = new FakeSource('fake-source', { count: 0, ok: true });
  poller.add(fake, { intervalMs: 60_000 });

  const hub = new RealtimeHub({ logger: null, heartbeatMs: 60_000 });
  // 生产环境由 server.js 负责接线，测试里也要接上，否则事件不会推到 SSE
  store.on('event', (event) => {
    hub.emitEvent(event);
    hub.touch(event.key);
  });
  const web = createServer({
    store,
    poller,
    hub,
    config: cfg(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const address = await web.listen();
  const base = `http://127.0.0.1:${address.port}`;
  return {
    store,
    poller,
    fake,
    hub,
    web,
    base,
    async cleanup() {
      hub.close();
      await web.close();
    },
  };
}

test('GET /api/health 返回 ok', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const res = await fetch(`${h.base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('GET /api/items 支持筛选、搜索与 includeEnded', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  h.store.upsert({
    source: SOURCE.CATALOG, sourceId: '1', appId: 1, title: 'Alpha 限时免费',
    freeType: FREE_TYPE.KEEP, finalPrice: 0, isFree: true,
  });
  h.store.upsert({
    source: SOURCE.GAMERPOWER, sourceId: '2', appId: null, title: 'Beta 激活码',
    freeType: FREE_TYPE.KEY, finalPrice: 0, isFree: true,
  });
  h.store.upsert({
    source: SOURCE.CATALOG, sourceId: '3', appId: 3, title: 'Gamma 折扣',
    freeType: FREE_TYPE.DISCOUNT, finalPrice: 1000, isFree: false, discountPercent: 80,
  });
  // 试玩版默认应被隐藏
  h.store.upsert({
    source: SOURCE.CATALOG, sourceId: '4', appId: 4, title: 'Delta 试玩版 Demo',
    freeType: FREE_TYPE.F2P, finalPrice: 0, isFree: true,
  });

  const all = await (await fetch(`${h.base}/api/items?limit=50&freeOnly=0`)).json();
  assert.equal(all.total, 3, '试玩版默认不返回（含折扣条目）');
  assert.equal(all.demosHidden, 1);

  const withDemos = await (await fetch(`${h.base}/api/items?limit=50&includeDemos=1&freeOnly=0`)).json();
  assert.equal(withDemos.total, 4, 'includeDemos=1 时应包含试玩版');

  // 高折扣是"参考信息"，有自己的类型筛选与统计卡片，
  // 因此**不应**被"只看免费"这个开关连带隐藏（否则界面上"高折扣"永远是 0）
  const freeOnly = await (await fetch(`${h.base}/api/items?freeOnly=1`)).json();
  assert.equal(freeOnly.total, 3, '只看免费：应保留免费条目与高折扣条目，排除付费无折扣');
  assert.equal(
    freeOnly.items.some((i) => i.freeType === FREE_TYPE.DISCOUNT),
    true,
    '高折扣条目应可见',
  );

  const byType = await (await fetch(`${h.base}/api/items?type=key`)).json();
  assert.equal(byType.total, 1);
  assert.equal(byType.items[0].title, 'Beta 激活码');

  const bySource = await (await fetch(`${h.base}/api/items?source=gamerpower`)).json();
  assert.equal(bySource.total, 1);

  const search = await (await fetch(`${h.base}/api/items?q=alpha`)).json();
  assert.equal(search.total, 1, '搜索应忽略大小写');

  const byAppId = await (await fetch(`${h.base}/api/items?q=3&freeOnly=0`)).json();
  assert.equal(byAppId.total, 1, '应能按 appid 搜索');
});

test('付费且无折扣的条目（PAID）不会出现在列表中', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  h.store.upsert({
    source: SOURCE.DETAILS, sourceId: '900', appId: 900, title: '全价游戏',
    freeType: FREE_TYPE.PAID, finalPrice: 26800, isFree: false, discountPercent: 0,
  });
  h.store.upsert({
    source: SOURCE.DETAILS, sourceId: '901', appId: 901, title: '打折游戏',
    freeType: FREE_TYPE.DISCOUNT, finalPrice: 2310, isFree: false, discountPercent: 70,
  });

  const all = await (await fetch(`${h.base}/api/items?freeOnly=0`)).json();
  assert.equal(all.items.some((i) => i.title === '全价游戏'), false, 'PAID 类型不应返回');
  assert.equal(all.items.some((i) => i.title === '打折游戏'), true, '真实折扣应返回');
});

test('GET /api/items 支持 offset 分页（前端"从未读到的继续读"依赖它）', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  for (let i = 1; i <= 10; i += 1) {
    h.store.upsert({
      source: SOURCE.CATALOG, sourceId: String(i), appId: i, title: `Game ${String(i).padStart(2, '0')}`,
      freeType: FREE_TYPE.F2P, finalPrice: 0, isFree: true,
    });
  }

  const first = await (await fetch(`${h.base}/api/items?limit=4&offset=0&freeOnly=0`)).json();
  assert.equal(first.total, 10);
  assert.equal(first.returned, 4);
  assert.equal(first.offset, 0);
  assert.equal(first.hasMore, true, '还有数据时 hasMore 应为 true');

  const second = await (await fetch(`${h.base}/api/items?limit=4&offset=4&freeOnly=0`)).json();
  assert.equal(second.returned, 4);
  assert.equal(second.offset, 4);

  const last = await (await fetch(`${h.base}/api/items?limit=4&offset=8&freeOnly=0`)).json();
  assert.equal(last.returned, 2);
  assert.equal(last.hasMore, false, '读完后 hasMore 应为 false');

  // 各页之间不应重复
  const a = first.items.map((i) => i.key);
  const b = second.items.map((i) => i.key);
  assert.equal(a.some((k) => b.includes(k)), false, '相邻页不应有重复条目');

  // 超出范围时安全返回空
  const beyond = await (await fetch(`${h.base}/api/items?limit=4&offset=999&freeOnly=0`)).json();
  assert.equal(beyond.returned, 0);
  assert.equal(beyond.items.length, 0);
});

test('GET /api/items 支持折扣区间与价格区间筛选', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const mk = (id, title, discountPercent, finalPrice) => ({
    source: SOURCE.DISCOUNTS, sourceId: String(id), appId: id, title,
    freeType: FREE_TYPE.DISCOUNT, finalPrice, isFree: false, discountPercent,
    originalPrice: finalPrice * 2,
  });
  h.store.upsert(mk(1, '小折扣便宜', 10, 900));      // 10% ¥9
  h.store.upsert(mk(2, '中折扣中等', 50, 5000));     // 50% ¥50
  h.store.upsert(mk(3, '大折扣便宜', 90, 1000));     // 90% ¥10
  h.store.upsert(mk(4, '大折扣昂贵', 80, 20000));    // 80% ¥200

  const all = await (await fetch(`${h.base}/api/items?type=discount&freeOnly=0&limit=50`)).json();
  assert.equal(all.total, 4);

  // 折扣区间
  const deep = await (await fetch(`${h.base}/api/items?type=discount&freeOnly=0&minDiscount=80&limit=50`)).json();
  assert.equal(deep.total, 2, '>=80% 应有 2 条');

  const mid = await (await fetch(
    `${h.base}/api/items?type=discount&freeOnly=0&minDiscount=40&maxDiscount=60&limit=50`,
  )).json();
  assert.equal(mid.total, 1);
  assert.equal(mid.items[0].title, '中折扣中等');

  // 价格区间（单位：分，左闭右开）
  const cheap = await (await fetch(`${h.base}/api/items?type=discount&freeOnly=0&maxPrice=1000&limit=50`)).json();
  assert.equal(cheap.total, 1, '¥10 以下（<1000 分）应有 1 条');

  // 组合：高折扣 + 低价格
  const combo = await (await fetch(
    `${h.base}/api/items?type=discount&freeOnly=0&minDiscount=80&maxPrice=1500&limit=50`,
  )).json();
  assert.equal(combo.total, 1);
  assert.equal(combo.items[0].title, '大折扣便宜');
});

test('GET /api/facets 返回折扣与价格分桶（界面区间按钮的数字来源）', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const mk = (id, discountPercent, finalPrice) => ({
    source: SOURCE.DISCOUNTS, sourceId: String(id), appId: id, title: `G${id}`,
    freeType: FREE_TYPE.DISCOUNT, finalPrice, isFree: false, discountPercent,
  });
  h.store.upsert(mk(1, 15, 900));
  h.store.upsert(mk(2, 55, 5000));
  h.store.upsert(mk(3, 85, 1000));

  const f = await (await fetch(`${h.base}/api/facets?type=discount`)).json();
  assert.equal(f.total, 3);
  assert.equal(f.discountBuckets.length, 10, '折扣按 10% 分 10 桶');
  assert.equal(f.discountBuckets.find((b) => b.min === 10).count, 1, '15% 落在 10–20 桶');
  assert.equal(f.discountBuckets.find((b) => b.min === 50).count, 1, '55% 落在 50–60 桶');
  assert.equal(f.discountBuckets.find((b) => b.min === 80).count, 1, '85% 落在 80–90 桶');
  assert.equal(f.discountBuckets.filter((b) => b.count === 0).length, 7, '其余桶应为 0');

  assert.ok(f.priceBuckets.length > 0);
  assert.equal(f.priceBuckets.reduce((n, b) => n + b.count, 0), 3, '价格分桶计数之和应等于总数');
  assert.equal(f.priceMin, 900);
  assert.equal(f.priceMax, 5000);
});

test('GET /api/items 支持评价结果与评测数筛选', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const mk = (id, title, reviewSummary, reviewPercent, reviewCount) => ({
    source: SOURCE.CATALOG, sourceId: String(id), appId: id, title,
    freeType: FREE_TYPE.F2P, finalPrice: 0, isFree: true,
    reviewSummary, reviewPercent, reviewCount,
  });
  h.store.upsert(mk(1, '好评如潮的大作', '好评如潮', 96, 500000));
  h.store.upsert(mk(2, '特别好评的小品', '特别好评', 89, 3000));
  h.store.upsert(mk(3, '褒贬不一', '褒贬不一', 55, 20000));
  h.store.upsert(mk(4, '多半差评', '多半差评', 30, 800));
  h.store.upsert(mk(5, '无评价的游戏', null, null, null));

  const all = await (await fetch(`${h.base}/api/items?limit=50`)).json();
  assert.equal(all.total, 5);
  // 评价字段必须出现在输出里
  const one = all.items.find((i) => i.title === '好评如潮的大作');
  assert.equal(one.reviewSummary, '好评如潮');
  assert.equal(one.reviewPercent, 96);
  assert.equal(one.reviewCount, 500000);

  const byRating = async (rating) =>
    (await (await fetch(`${h.base}/api/items?limit=50&rating=${rating}`)).json()).total;
  assert.equal(await byRating('overwhelming'), 1, '好评如潮应 1 条');
  assert.equal(await byRating('veryPositive'), 1, '特别好评应 1 条');
  assert.equal(await byRating('mixed'), 1, '褒贬不一应 1 条');
  assert.equal(await byRating('negative'), 1, '差评类应 1 条');

  // 好评率下限
  const highPct = await (await fetch(`${h.base}/api/items?limit=50&minReviewPercent=80`)).json();
  assert.equal(highPct.total, 2, '好评率 >=80% 应有 2 条');
  assert.equal(highPct.items.some((i) => i.title === '褒贬不一'), false, '无好评率的不应混入');

  // 评测数下限
  const many = await (await fetch(`${h.base}/api/items?limit=50&minReviewCount=10000`)).json();
  assert.equal(many.total, 2, '评测数 >= 1 万应有 2 条');

  // 组合
  const combo = await (await fetch(
    `${h.base}/api/items?limit=50&minReviewPercent=85&minReviewCount=100000`,
  )).json();
  assert.equal(combo.total, 1);
  assert.equal(combo.items[0].title, '好评如潮的大作');
});

test('GET /api/facets 返回评价档位计数', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const mk = (id, reviewSummary, reviewCount) => ({
    source: SOURCE.CATALOG, sourceId: String(id), appId: id, title: `G${id}`,
    freeType: FREE_TYPE.F2P, finalPrice: 0, isFree: true, reviewSummary, reviewCount,
  });
  h.store.upsert(mk(1, '好评如潮', 100));
  h.store.upsert(mk(2, '特别好评', 200));
  h.store.upsert(mk(3, '特别好评', 300));
  h.store.upsert(mk(4, null, null));

  const f = await (await fetch(`${h.base}/api/facets?type=f2p`)).json();
  assert.equal(f.total, 4);
  const tier = (k) => f.ratingTiers.find((t) => t.key === k)?.count;
  assert.equal(tier('overwhelming'), 1);
  assert.equal(tier('veryPositive'), 2);
  assert.equal(tier('mixed'), 0);
  assert.equal(f.withReviewCount, 3, '有评测数的应 3 条');
  assert.equal(f.withoutReviewCount, 1);
});

test('条目输出包含展示标签且不泄漏内部字段', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  h.store.upsert({
    source: SOURCE.CATALOG, sourceId: '1', appId: 1, title: 'X',
    freeType: FREE_TYPE.KEEP, finalPrice: 0, isFree: true, raw: { isFreeClass: true },
  });

  const body = await (await fetch(`${h.base}/api/items`)).json();
  const item = body.items[0];
  assert.equal(item.freeTypeLabel, '限时免费入库');
  assert.equal(item.sourceLabel, 'Steam 商店扫描');
  assert.equal(item.isFreebie, true);
  assert.equal(item.raw, undefined, '内部解析标记不应暴露给前端');
});

test('GET /api/item/:key 命中与 404', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  h.store.upsert({ source: SOURCE.CATALOG, sourceId: '42', appId: 42, title: 'Answer', freeType: FREE_TYPE.F2P, finalPrice: 0, isFree: true });

  const ok = await fetch(`${h.base}/api/item/${encodeURIComponent('steam-catalog:42')}`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).item.title, 'Answer');

  const missing = await fetch(`${h.base}/api/item/${encodeURIComponent('steam-catalog:999')}`);
  assert.equal(missing.status, 404);
});

test('GET /api/events 返回事件并可过滤', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  h.store.upsert({ source: SOURCE.CATALOG, sourceId: '1', appId: 1, title: 'A', freeType: FREE_TYPE.F2P, finalPrice: 0, isFree: true });
  h.store.upsert({ source: SOURCE.CATALOG, sourceId: '2', appId: 2, title: 'B', freeType: FREE_TYPE.F2P, finalPrice: 0, isFree: true });

  const res = await (await fetch(`${h.base}/api/events?limit=10`)).json();
  assert.equal(res.events.length, 2);

  const filtered = await (await fetch(`${h.base}/api/events?type=ended`)).json();
  assert.equal(filtered.events.length, 0);
});

test('POST /api/refresh 触发数据源执行', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const res = await fetch(`${h.base}/api/refresh?source=fake-source`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(h.fake.calls, 1);
});

test('GET /api/status 汇总数据源与调度信息', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const body = await (await fetch(`${h.base}/api/status`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.sources.length, 1);
  assert.equal(body.sources[0].name, 'fake-source');
  assert.ok(body.summary);
  assert.equal(typeof body.realtime.clients, 'number');
});

test('GET /api/status 提供数据新鲜度，抓取失败时标记为陈旧', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  // 从未成功抓取 => 应判定为陈旧
  let body = await (await fetch(`${h.base}/api/status`)).json();
  assert.ok(body.freshness, '应包含 freshness');
  assert.equal(body.freshness.stale, true, '无成功记录时应标记陈旧');
  assert.equal(body.freshness.lastSuccessAt, null);

  // 记录一次成功 => 不应再判定为陈旧
  h.store.recordSourceResult('fake-source', { ok: true, count: 1, durationMs: 5 });
  // poller.status() 从 store 读取统计，需让 poller 记录一次运行
  await h.poller.runSource('fake-source');
  body = await (await fetch(`${h.base}/api/status`)).json();
  assert.ok(body.freshness.lastSuccessAt, '成功抓取后应有 lastSuccessAt');
  assert.equal(body.freshness.stale, false, '刚刚成功过不应标记陈旧');
  assert.deepEqual(body.freshness.failingSources, []);
});

test('GET /api/status 会列出连续失败的数据源', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  h.store.recordSourceResult('fake-source', { ok: false, error: 'network failure', durationMs: 10 });
  const body = await (await fetch(`${h.base}/api/status`)).json();
  assert.ok(body.freshness.failingSources.includes('fake-source'), '失败的源应被列出');
});

test('SSE: 订阅后能收到 hello 与后续事件', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(`${h.base}/api/stream`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // 等 hello 帧
  const readUntil = async (needle, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (buffer.includes(needle)) return true;
      const { value, done } = await reader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer.includes(needle);
  };

  assert.ok(await readUntil('event: hello'), '应收到 hello 帧');

  // 触发一次真实数据变更 -> 应推送 event + item 帧
  h.store.upsert({
    source: SOURCE.CATALOG, sourceId: '9', appId: 9, title: 'SSE 测试',
    freeType: FREE_TYPE.KEEP, finalPrice: 0, isFree: true,
  });
  assert.ok(await readUntil('event: event'), '应收到业务事件帧');

  controller.abort();
});

test('静态资源服务与目录穿越防护', async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  const index = await fetch(`${h.base}/`);
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /Steam 限免雷达/);

  const css = await fetch(`${h.base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const missing = await fetch(`${h.base}/nope.txt`);
  assert.equal(missing.status, 404);

  // 目录穿越必须被拒绝或找不到（不能读到 src/ 里的内容）
  for (const evil of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json']) {
    const res = await fetch(`${h.base}${evil}`);
    assert.ok(res.status === 403 || res.status === 404, `${evil} 应被拒绝，实际 ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('steam-free-radar'), `${evil} 不应泄漏工作区文件`);
  }

  // bench 目录挂在 /bench/ 下，同样要防穿越
  const benchIndex = await fetch(`${h.base}/bench/baseline.html`);
  assert.equal(benchIndex.status, 200, '性能对照页应可通过 /bench/ 访问');
  for (const evil of ['/bench/../package.json', '/bench/..%2fpackage.json']) {
    const res = await fetch(`${h.base}${evil}`);
    assert.ok(res.status === 403 || res.status === 404, `${evil} 应被拒绝，实际 ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('steam-free-radar'), `${evil} 不应泄漏工作区文件`);
  }

  /**
   * 非 origin-form 的请求目标必须被拒绝。
   *
   * 回归背景（实测）：`new URL('//package.json', base)` 会把 `//x` 当成"协议相对 URL"，
   * 于是 host 变成 package.json、pathname 变成 `/` —— 静态资源会静默返回首页，
   * 既不报错也不泄露文件，但语义完全错乱。
   * fetch 会规范化 URL，所以这里用 http.request 原样发送路径。
   */
  const { default: http } = await import('node:http');
  const rawStatus = (rawPath, headers = {}) =>
    new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: Number(new URL(h.base).port), path: rawPath, method: 'GET', headers },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', () => resolve(0));
      req.end();
    });

  assert.equal(await rawStatus('//package.json'), 400, '协议相对路径应被拒绝（曾被当成首页返回 200）');
  assert.equal(await rawStatus('http://evil.com/package.json'), 400, 'absolute-form 应被拒绝');
  // 固定 base：伪造 Host 头不应改变路由结果
  assert.equal(await rawStatus('/api/health', { host: 'evil.com' }), 200, 'Host 头不应影响路由');
});
