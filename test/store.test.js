/**
 * Store 变更检测 / 事件 / 持久化 测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { EVENT, FREE_TYPE, SOURCE } from '../src/model.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-store-'));
  return { store: new Store({ dataDir: dir }), dir };
}

const base = (over = {}) => ({
  source: SOURCE.CATALOG,
  sourceId: '100',
  appId: 100,
  title: '测试游戏',
  freeType: FREE_TYPE.F2P,
  finalPrice: 0,
  isFree: true,
  ...over,
});

test('精简存档：体积显著更小且关键字段可完整还原', async () => {
  const { store, dir } = tempStore();
  const full = {
    source: SOURCE.CATALOG,
    sourceId: '777',
    appId: 777,
    title: '带大量冗余字段的游戏',
    freeType: FREE_TYPE.KEEP,
    finalPrice: 0,
    isFree: true,
    originalPrice: 6800,
    originalPriceFormatted: '¥ 68.00',
    discountPercent: 100,
    reviewCount: 123456,
    wasPaid: true,
    lastVerifiedAt: '2026-09-01T00:00:00.000Z',
    // 这些是应该被丢弃的冗余字段
    description: 'x'.repeat(1000),
    tags: Array.from({ length: 20 }, (_, i) => i),
    platforms: ['windows', 'linux', 'mac'],
    instructions: 'y'.repeat(500),
    raw: { isFreeClass: true, finalPriceAttr: 10300 },
  };
  store.upsert(full);
  await store.flush();

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(onDisk.archive, true, '应使用精简存档格式');
  assert.equal(onDisk.items.length, 1);

  const compactSize = JSON.stringify(onDisk.items[0]).length;
  const fullSize = JSON.stringify({
    ...full,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).length;
  assert.ok(
    compactSize * 3 < fullSize,
    `精简存档应显著小于完整条目（精简 ${compactSize} 字节 vs 完整 ${fullSize} 字节）`,
  );

  const restored = new Store({ dataDir: dir });
  assert.equal(restored.load().loaded, true);
  const item = restored.get(`${SOURCE.CATALOG}:777`);
  assert.ok(item, '应能还原条目');
  // 关键字段必须保住
  assert.equal(item.title, '带大量冗余字段的游戏');
  assert.equal(item.freeType, FREE_TYPE.KEEP);
  assert.equal(item.originalPrice, 6800);
  assert.equal(item.originalPriceFormatted, '¥ 68.00');
  assert.equal(item.discountPercent, 100);
  assert.equal(item.reviewCount, 123456);
  assert.equal(item.wasPaid, true);
  assert.equal(item.lastVerifiedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(item.isFree, true);
  assert.equal(item.active, true);
  // 冗余字段应被丢弃（重启后由数据源重新补充）
  assert.equal(item.description, null);
  assert.deepEqual(item.tags, []);
});

test('精简存档：appid 条目的 url/image 由推导得到，不占用存档体积', async () => {
  const { store, dir } = tempStore();
  store.upsert({
    source: SOURCE.CATALOG,
    sourceId: '730',
    appId: 730,
    title: 'Counter-Strike 2',
    url: 'https://store.steampowered.com/app/730/CounterStrike_2/',
    image: 'https://shared.cdn.queniuqe.com/store_item_assets/steam/apps/730/abc123/capsule_231x87_schinese.jpg?t=1788998864',
    freeType: FREE_TYPE.F2P,
    finalPrice: 0,
    isFree: true,
    // 已校验 => 会被持久化
    lastVerifiedAt: '2026-09-01T00:00:00.000Z',
  });
  await store.flush();

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const rec = onDisk.items[0];
  assert.ok(rec, '已校验条目应被持久化');
  assert.equal(rec.u, undefined, 'url 应可推导，不应写入存档');
  assert.equal(rec.g, undefined, 'image 应可推导，不应写入存档');

  const restored = new Store({ dataDir: dir });
  restored.load();
  const item = restored.get(`${SOURCE.CATALOG}:730`);
  assert.equal(item.url, 'https://store.steampowered.com/app/730/');
  assert.match(item.image, /steamstatic\.com\/steam\/apps\/730\/capsule_231x87\.jpg/);
});

test('精简存档：非 appid 条目（激活码）保留原始 url/image', async () => {
  const { store, dir } = tempStore();
  store.upsert({
    source: SOURCE.GAMERPOWER,
    sourceId: 'gp1',
    appId: null,
    title: '某游戏激活码',
    url: 'https://www.gamerpower.com/x',
    image: 'https://www.gamerpower.com/img/x.jpg',
    freeType: FREE_TYPE.KEY,
    finalPrice: 0,
    isFree: true,
  });
  await store.flush();

  const restored = new Store({ dataDir: dir });
  restored.load();
  const item = restored.get(`${SOURCE.GAMERPOWER}:gp1`);
  assert.equal(item.url, 'https://www.gamerpower.com/x');
  assert.equal(item.image, 'https://www.gamerpower.com/img/x.jpg');
});

test('精简存档可正确还原“已结束”状态', async () => {
  const { store, dir } = tempStore();
  store.upsert({
    source: SOURCE.CATALOG, sourceId: '888', appId: 888, title: 'X',
    freeType: FREE_TYPE.KEEP, finalPrice: 0, isFree: true, discountPercent: 100,
  });
  store.markEnded(`${SOURCE.CATALOG}:888`);
  await store.flush();

  const restored = new Store({ dataDir: dir });
  restored.load();
  assert.equal(restored.get(`${SOURCE.CATALOG}:888`).active, false);
});

test('存档保证：所有条目都会被持久化，重启后不丢数据（回归）', async () => {
  const { store, dir } = tempStore();
  // 曾经"冷门 F2P"会被丢弃，导致重启后静默丢失；现在必须全部保留
  const fixtures = [
    { id: '1', title: '冷门F2P', freeType: FREE_TYPE.F2P },
    { id: '2', title: '已校验', freeType: FREE_TYPE.F2P, lastVerifiedAt: '2026-01-01T00:00:00Z' },
    { id: '3', title: '限时免费', freeType: FREE_TYPE.KEEP, discountPercent: 100 },
    { id: '4', title: '激活码', freeType: FREE_TYPE.KEY },
    { id: '5', title: '高折扣', freeType: FREE_TYPE.DISCOUNT, finalPrice: 1000, isFree: false },
  ];
  for (const f of fixtures) {
    store.upsert(base({ sourceId: f.id, appId: Number(f.id), ...f }));
  }
  await store.flush();

  assert.equal(Store.worthPersisting(), true, '所有条目都应持久化');

  const restored = new Store({ dataDir: dir });
  const result = restored.load();
  assert.equal(result.loaded, true);
  assert.equal(restored.items.size, fixtures.length, '重启后条目数必须完全一致');
  for (const f of fixtures) {
    assert.ok(restored.get(`${SOURCE.CATALOG}:${f.id}`), `不应丢失条目 ${f.title}`);
  }
});

test('存档保证：200 条冷门 F2P 全量往返不丢（数量级验证）', async () => {
  const { store, dir } = tempStore();
  for (let i = 1; i <= 200; i += 1) {
    store.upsert(base({ sourceId: String(i), appId: i, title: `Game ${i}`, freeType: FREE_TYPE.F2P }));
  }
  await store.flush();

  const restored = new Store({ dataDir: dir });
  restored.load();
  assert.equal(restored.items.size, 200, '200 条应全部恢复');
});

test('候选队列使用紧凑存档格式且可还原', async () => {
  const { store, dir } = tempStore();
  store.enqueueCandidate(111, { special: true, hint: 500, reviews: 9000 });
  store.enqueueCandidate(222, { special: false, hint: 0, reviews: 0 });
  await store.flush();

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(onDisk.candidates['111'].length, 5, '候选应序列化为紧凑数组（含分诊标记）');
  assert.equal(onDisk.candidates['111'][2], 1, 'special 应编码为 1');

  const restored = new Store({ dataDir: dir });
  restored.load();
  const c = restored.candidates.get(111);
  assert.equal(c.special, true);
  assert.equal(c.hint, 500);
  assert.equal(c.reviews, 9000);
  assert.ok(Number.isFinite(c.firstSeen));
  // 优先级排序仍应生效
  assert.equal(restored.peekCandidates(2)[0], 111);
});

test('load 兼容旧的候选对象格式', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-store-cand-'));
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      version: 1,
      archive: true,
      items: [],
      events: [],
      watchlist: [],
      seenSpecials: [],
      candidates: { 333: { firstSeen: 1, lastSeen: 2, hint: 7, special: true, reviews: 42 } },
      sourceState: {},
    }),
    'utf8',
  );
  const s = new Store({ dataDir: dir });
  assert.equal(s.load().loaded, true);
  const c = s.candidates.get(333);
  assert.equal(c.special, true);
  assert.equal(c.hint, 7);
  assert.equal(c.reviews, 42);
});

test('peakItems 记录历史峰值，用于暴露数据变少', async () => {
  const { store, dir } = tempStore();
  for (let i = 1; i <= 10; i += 1) {
    store.upsert(base({ sourceId: String(i), appId: i, title: `G${i}`, freeType: FREE_TYPE.F2P }));
  }
  await store.flush();

  const restored = new Store({ dataDir: dir });
  restored.load();
  assert.equal(restored.summary().peakItems, 10, '峰值应被持久化');
  assert.equal(restored.items.size, 10);

  // 模拟"外部导致条目变少"（例如手工删掉存档里的记录）
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  onDisk.items = onDisk.items.slice(0, 4);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(onDisk), 'utf8');

  const after = new Store({ dataDir: dir });
  after.load();
  assert.equal(after.items.size, 4);
  assert.equal(after.summary().peakItems, 10, '峰值应保留 10，从而能发现少了 6 条');
  assert.ok(after.items.size < after.summary().peakItems * 0.9, '应能据此判断出现数据丢失');
});

test('候选去重：最近校验过的 appid 不再重复入队（避免重复抓取）', () => {
  const { store } = tempStore();
  store.enqueueCandidate(1000, { reviews: 500 });
  assert.equal(store.candidates.size, 1, '未校验过应入队');

  // 已精确校验过的新条目 -> 不应再入队
  store.upsert(base({
    source: SOURCE.DETAILS, sourceId: '2000', appId: 2000, title: '已校验F2P',
    freeType: FREE_TYPE.F2P, lastVerifiedAt: new Date().toISOString(),
  }));
  store.enqueueCandidate(2000, { reviews: 900 });
  assert.equal(store.candidates.size, 1, '最近校验过的 appid 不应重复入队');
});

test('候选去重：限时免费超过免检期后重新入队（状态易变）', () => {
  const { store } = tempStore();
  // 限免 1 小时前校验过 -> 超过 timeBound 免检期，应重新确认
  store.upsert(base({
    source: SOURCE.DETAILS, sourceId: '3000', appId: 3000, title: '旧限免',
    freeType: FREE_TYPE.KEEP, lastVerifiedAt: new Date(Date.now() - 3600_000).toISOString(),
  }));
  store.enqueueCandidate(3000, {});
  assert.equal(store.candidates.has(3000), true, '限免过期后应重新入队');

  // 永久免费 1 小时前校验过 -> 仍在 12h 免检期内
  store.upsert(base({
    source: SOURCE.DETAILS, sourceId: '4000', appId: 4000, title: 'F2P',
    freeType: FREE_TYPE.F2P, lastVerifiedAt: new Date(Date.now() - 3600_000).toISOString(),
  }));
  store.enqueueCandidate(4000, {});
  assert.equal(store.candidates.has(4000), false, 'F2P 在免检期内不应重复入队');
});

test('isRecentlyVerified 对未校验/无记录返回 false', () => {
  const { store } = tempStore();
  assert.equal(store.isRecentlyVerified(999), false, '库里没有该 appid');
  store.upsert(base({ sourceId: '5', appId: 5, freeType: FREE_TYPE.F2P }));
  assert.equal(store.isRecentlyVerified(5), false, '没有 lastVerifiedAt 时不算已校验');
});

test('周期性自动落盘：长时间运行后进度不会只停留在内存里', async () => {
  const { store, dir } = tempStore();
  const saved = [];
  const origSave = store.save.bind(store);
  store.save = async () => { saved.push(Date.now()); return origSave(); };

  store.upsert(base({ sourceId: '7000', appId: 7000, title: 'X', freeType: FREE_TYPE.F2P }));
  // markDirty 已排了去抖动与周期定时器；直接触发周期回调以验证其存在
  assert.ok(store.autoSaveTimer, '应建立周期自动落盘定时器');

  await store.flush();
  assert.equal(store.autoSaveTimer, null, 'flush 后应清理周期定时器');
  assert.ok(fs.existsSync(path.join(dir, 'state.json')), 'flush 应落盘');
});

test('序列化缓存：条目变更后落盘必须写出新值（回归：不得返回缓存旧值）', async () => {
  const { store, dir } = tempStore();
  const baseItem = {
    source: SOURCE.CATALOG, sourceId: '555', appId: 555, title: 'T',
    freeType: FREE_TYPE.F2P, finalPrice: 0, isFree: true,
  };
  store.upsert(baseItem);
  await store.flush();
  let onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(onDisk.items[0].f, 0, '首次落盘应为免费');

  // 变成付费折扣
  store.upsert({ ...baseItem, freeType: FREE_TYPE.DISCOUNT, finalPrice: 4900, isFree: false, discountPercent: 50 });
  await store.flush();
  onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(onDisk.items[0].f, 4900, '变更后必须写出新的 finalPrice，不能是缓存旧值');
  assert.equal(onDisk.items[0].y, FREE_TYPE.DISCOUNT);

  // 标记结束
  store.markEnded(`${SOURCE.CATALOG}:555`);
  await store.flush();
  onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(onDisk.items[0].n, 0, 'markEnded 后 active 应写为 0');

  // 往返一致
  const restored = new Store({ dataDir: dir });
  restored.load();
  const it = restored.get(`${SOURCE.CATALOG}:555`);
  assert.equal(it.finalPrice, 4900);
  assert.equal(it.freeType, FREE_TYPE.DISCOUNT);
  assert.equal(it.active, false);
});

test('手工拼接的存档 JSON 字段齐全且可解析（性能优化后必须保持格式兼容）', async () => {
  const { store, dir } = tempStore();
  store.upsert(base({ sourceId: '1', appId: 1, freeType: FREE_TYPE.KEEP, discountPercent: 100 }));
  store.enqueueCandidate(1234, { special: true, hint: 5, reviews: 99 });
  store.ingestSpecials([1, 2]);
  store.setSourceState(SOURCE.CATALOG, { cursor: 100 });
  await store.flush();

  const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  const j = JSON.parse(raw); // 手工拼接若有语法错误，这里会抛
  for (const key of ['version', 'savedAt', 'archive', 'peakItems', 'items', 'events', 'watchlist', 'seenSpecials', 'candidates', 'sourceState']) {
    assert.ok(key in j, `存档缺少字段 ${key}`);
  }
  assert.equal(j.items.length, 1);
  assert.equal(j.candidates['1234'].length, 5, '候选应为紧凑数组');
  assert.equal(j.peakItems, 1);
});

test('纠正历史误分类：0% 折扣不再计入 DISCOUNT（回归）', () => {
  const { store } = tempStore();
  const mk = (id, title, freeType, finalPrice, discountPercent) => ({
    source: SOURCE.DETAILS, sourceId: String(id), appId: id, title,
    freeType, finalPrice, isFree: finalPrice === 0, discountPercent,
  });
  store.upsert(mk(1, '全价游戏(误分类)', FREE_TYPE.DISCOUNT, 26800, 0));
  store.upsert(mk(2, '无价格(误分类)', FREE_TYPE.DISCOUNT, 19900, null));
  store.upsert(mk(3, '真折扣', FREE_TYPE.DISCOUNT, 2310, 70));
  store.upsert(mk(4, '免费游戏', FREE_TYPE.F2P, 0, 0));

  const fixed = store.fixLegacyDiscountClassification();
  assert.equal(fixed, 2, '应纠正两条 0% 折扣的误分类');
  assert.equal(store.get(`${SOURCE.DETAILS}:1`).freeType, FREE_TYPE.PAID);
  assert.equal(store.get(`${SOURCE.DETAILS}:2`).freeType, FREE_TYPE.PAID);
  assert.equal(store.get(`${SOURCE.DETAILS}:3`).freeType, FREE_TYPE.DISCOUNT, '真折扣不能被改');
  assert.equal(store.get(`${SOURCE.DETAILS}:4`).freeType, FREE_TYPE.F2P, '免费条目不能被改');

  // 幂等
  assert.equal(store.fixLegacyDiscountClassification(), 0, '重复调用不应再改动');
});

test('数据治理：无信号的冷门候选被分诊跳过，不浪费 appdetails 配额', () => {
  const { store } = tempStore();
  // 无信号：不查
  store.enqueueCandidate(1, { special: false, hint: 0, reviews: 0 });
  // 有信号：值得查
  store.enqueueCandidate(2, { special: true });
  store.enqueueCandidate(3, { hint: 500 });
  store.enqueueCandidate(4, { reviews: 1200 });

  const stats = store.candidateStats();
  assert.equal(stats.total, 4, '全部候选仍会被记录');
  assert.equal(stats.skipped, 1, '只有无信号的那条被跳过');
  assert.equal(stats.toVerify, 3);

  const picked = store.peekCandidates(10);
  assert.equal(picked.includes(1), false, '被跳过的候选不应被取出校验');
  assert.equal(picked.length, 3);
  assert.equal(store.summary({ groupCounts: false }).pendingToVerify, 3, 'summary 应区分"需校验"');
});

test('数据治理：被跳过的候选出现更强信号后会被重新激活', () => {
  const { store } = tempStore();
  store.enqueueCandidate(9, { special: false, hint: 0, reviews: 0 });
  assert.equal(store.candidates.get(9).skip, true);

  // 之后扫描到它出现在促销索引里 => 重新激活
  store.enqueueCandidate(9, { special: true });
  assert.equal(store.candidates.get(9).skip, false, '出现 signal 后应重新排队校验');
  assert.equal(store.peekCandidates(5).includes(9), true);
});

test('数据治理：triageCandidates 可对历史队列做一次性分诊', () => {
  const { store } = tempStore();
  // 模拟旧版本留下的、没有 skip 标记的候选
  store.candidates.set(1, { firstSeen: Date.now(), lastSeen: Date.now(), hint: 0, special: false, reviews: 0 });
  store.candidates.set(2, { firstSeen: Date.now(), lastSeen: Date.now(), hint: 0, special: true, reviews: 0 });
  store.candidates.set(3, { firstSeen: Date.now(), lastSeen: Date.now(), hint: 0, special: false, reviews: 800 });

  const skipped = store.triageCandidates();
  assert.equal(skipped, 1, '只应跳过无信号的那条');
  assert.equal(store.candidates.get(1).skip, true);
  assert.equal(store.candidates.get(2).skip, false);
  assert.equal(store.candidates.get(3).skip, false);
  assert.equal(store.triageCandidates(), 0, '重复分诊不应再有变化');
});

test('数据治理：永久免费条目读一次后不再重复排队（F2P 不复核）', () => {
  const { store } = tempStore();
  // 一个已确认的永久免费条目
  store.upsert(base({
    source: SOURCE.DETAILS, sourceId: '500', appId: 500, title: '永久免费',
    freeType: FREE_TYPE.F2P, lastVerifiedAt: new Date().toISOString(),
  }));
  // 扫描再次遇到它
  store.enqueueCandidate(500, { special: false, reviews: 5000 });
  assert.equal(store.candidates.has(500), false, 'F2P 读一次后不应再排队');

  // 但限时免费会过期，必须重新确认
  store.upsert(base({
    source: SOURCE.DETAILS, sourceId: '501', appId: 501, title: '限免',
    freeType: FREE_TYPE.KEEP, lastVerifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  }));
  store.enqueueCandidate(501, { reviews: 100 });
  assert.equal(store.candidates.has(501), true, '限免超过免检期应重新确认');

  // 折扣也要按周期复核
  store.upsert(base({
    source: SOURCE.DETAILS, sourceId: '502', appId: 502, title: '折扣',
    freeType: FREE_TYPE.DISCOUNT, finalPrice: 2310, isFree: false,
    lastVerifiedAt: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
  }));
  store.enqueueCandidate(502, { reviews: 100 });
  assert.equal(store.candidates.has(502), true, '折扣超过复核周期应重新确认');
});

test('评价字段必须持久化（回归：曾被精简存档漏掉，重启后只剩 16%）', async () => {
  const { store, dir } = tempStore();
  store.upsert(base({
    sourceId: '600', appId: 600, title: 'Reviewed Game',
    freeType: FREE_TYPE.F2P,
    reviewSummary: '特别好评', reviewPercent: 89, reviewCount: 1412376,
  }));
  await store.flush();

  // 精简存档里必须带上这三个字段
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const rec = onDisk.items[0];
  assert.equal(rec.rs, '特别好评', '评价结果必须写入存档');
  assert.equal(rec.rp, 89, '好评率必须写入存档');
  assert.equal(rec.r, 1412376, '评论数必须写入存档');

  const restored = new Store({ dataDir: dir });
  restored.load();
  const it = restored.get(`${SOURCE.CATALOG}:600`);
  assert.equal(it.reviewSummary, '特别好评', '重启后评价结果不能丢');
  assert.equal(it.reviewPercent, 89);
  assert.equal(it.reviewCount, 1412376);
});

test('summary({groupCounts:false}) 仍给出各类型计数，但省略 bySource', () => {
  const { store } = tempStore();
  store.upsert(base({ sourceId: 'a', appId: 1, freeType: FREE_TYPE.KEEP }));
  store.upsert(base({ sourceId: 'b', appId: 2, freeType: FREE_TYPE.KEY }));
  store.upsert(base({ sourceId: 'c', appId: 3, freeType: FREE_TYPE.WEEKEND }));
  const full = store.summary();
  const light = store.summary({ groupCounts: false });

  assert.equal(light.total, full.total);
  assert.equal(light.active, full.active);

  // byType 必须始终存在：界面统计条要显示**每一个**类型，
  // 缺任何一项都会让用户以为那个类型没数据（"免费周末"就这样被漏显示过一次）
  assert.ok(light.byType, '精简模式也必须带 byType');
  assert.equal(light.keepCount, 1);
  assert.equal(light.keyCount, 1);
  assert.equal(light.weekendCount, 1, '免费周末计数必须可用');
  assert.equal(light.discountCount, 0);
  assert.equal(light.f2pCount, 0);

  // bySource 更贵且只用于状态面板，精简模式下省略
  assert.equal(light.bySource, undefined);
  assert.ok(full.bySource, '完整模式应带 bySource');
  assert.equal(full.byType[FREE_TYPE.KEEP], 1);
});

test('首次 upsert 产生 discovered 事件', () => {
  const { store } = tempStore();
  const events = [];
  store.on('event', (e) => events.push(e));

  const { item } = store.upsert(base());
  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENT.DISCOVERED);
  assert.equal(item.key, 'steam-catalog:100');
  assert.equal(item.firstSeenAt, item.lastSeenAt);
});

test('重复 upsert 相同数据不产生事件，且保留首次发现时间', () => {
  const { store } = tempStore();
  const events = [];
  store.on('event', (e) => events.push(e));

  const first = store.upsert(base()).item;
  store.upsert(base());
  store.upsert(base());

  assert.equal(events.length, 1, '无变化时不应重复产生事件');
  assert.equal(store.get('steam-catalog:100').firstSeenAt, first.firstSeenAt);
  assert.equal(store.get('steam-catalog:100').missedPasses, 0);
});

test('从收费变为免费产生 became_free 事件', () => {
  const { store } = tempStore();
  store.upsert(base({ finalPrice: 2399, isFree: false, freeType: FREE_TYPE.DISCOUNT, discountPercent: 60 }));
  const events = [];
  store.on('event', (e) => events.push(e));

  store.upsert(base({ finalPrice: 0, isFree: true, freeType: FREE_TYPE.KEEP, discountPercent: 100, originalPrice: 5999 }));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENT.BECAME_FREE);
  assert.equal(store.get('steam-catalog:100').freeType, FREE_TYPE.KEEP);
});

test('折扣加深产生 price_drop，变浅产生 updated', () => {
  const { store } = tempStore();
  store.upsert(base({ finalPrice: 3000, isFree: false, freeType: FREE_TYPE.DISCOUNT, discountPercent: 50 }));

  const events = [];
  store.on('event', (e) => events.push(e));
  store.upsert(base({ finalPrice: 1000, isFree: false, freeType: FREE_TYPE.DISCOUNT, discountPercent: 80 }));
  assert.equal(events.at(-1).type, EVENT.PRICE_DROP);

  store.upsert(base({ finalPrice: 2000, isFree: false, freeType: FREE_TYPE.DISCOUNT, discountPercent: 60 }));
  assert.equal(events.at(-1).type, EVENT.UPDATED);
});

test('权威来源的 pass 会在容忍轮数后判定下架', () => {
  const { store } = tempStore();
  store.upsert(base({ source: SOURCE.GAMERPOWER, sourceId: 'gp1', appId: null }));
  const events = [];
  store.on('event', (e) => events.push(e));

  // 连续两轮（tolerance=2）都没看到 -> 判定结束
  for (let i = 0; i < 2; i += 1) {
    const pass = store.beginPass(SOURCE.GAMERPOWER);
    store.endPass(pass, { tolerance: 2, authoritative: true });
  }
  assert.equal(store.get('gamerpower:gp1').active, false);
  assert.equal(events.at(-1).type, EVENT.ENDED);
});

test('非权威来源的 pass 永不判定下架（分页滚动场景）', () => {
  const { store } = tempStore();
  store.upsert(base());

  for (let i = 0; i < 20; i += 1) {
    const pass = store.beginPass(SOURCE.CATALOG);
    store.endPass(pass, { tolerance: 2, authoritative: false });
  }
  const item = store.get('steam-catalog:100');
  assert.equal(item.active, true, '扫描未覆盖到不等于下架');
  assert.ok(item.missedPasses > 0);
});

test('markEnded 幂等：重复调用只产生一次事件', () => {
  const { store } = tempStore();
  store.upsert(base());
  const events = [];
  store.on('event', (e) => events.push(e));

  assert.ok(store.markEnded('steam-catalog:100'));
  assert.equal(store.markEnded('steam-catalog:100'), null);
  assert.equal(events.length, 1);
});

test('候选队列：special 优先于普通候选，且 resolve 后移除', () => {
  const { store } = tempStore();
  store.enqueueCandidate(1, { special: false, hint: 0 });
  store.enqueueCandidate(2, { special: true, hint: 0 });
  store.enqueueCandidate(3, { special: false, hint: 99999 });

  const picked = store.peekCandidates(3);
  assert.equal(picked[0], 2, '曾出现在促销索引的候选优先级最高');

  store.resolveCandidate(2);
  assert.ok(!store.peekCandidates(10).includes(2));
  assert.equal(store.candidates.size, 2);
});

test('候选队列：评论数多的知名游戏优先于无人问津的条目', () => {
  const { store } = tempStore();
  store.enqueueCandidate(1, { reviews: 5 });
  store.enqueueCandidate(2, { reviews: 2_600_000 });
  store.enqueueCandidate(3, { reviews: 1200 });

  const picked = store.peekCandidates(3);
  assert.deepEqual(picked, [2, 3, 1], '应按评论数（游戏分量）降序');
});

test('候选队列：重复登记取更强的信号', () => {
  const { store } = tempStore();
  store.enqueueCandidate(7, { special: false, hint: 100, reviews: 10 });
  store.enqueueCandidate(7, { special: true, hint: 50, reviews: 9000 });

  const entry = store.candidates.get(7);
  assert.equal(entry.special, true, 'special 一旦为真应保持');
  assert.equal(entry.hint, 100, 'hint 取较大值');
  assert.equal(entry.reviews, 9000, 'reviews 取较大值');
  assert.equal(store.candidates.size, 1, '不应产生重复候选');
});

test('ingestSpecials 去重', () => {
  const { store } = tempStore();
  assert.equal(store.ingestSpecials([1, 2, 3]), 3);
  assert.equal(store.ingestSpecials([2, 3, 4]), 1);
  assert.equal(store.seenSpecials.size, 4);
});

test('save/load 往返恢复条目、事件与游标', async () => {
  const { store, dir } = tempStore();
  store.upsert(base({ freeType: FREE_TYPE.KEEP, discountPercent: 100 }));
  store.upsert(base({ source: SOURCE.GAMERPOWER, sourceId: 'gp9', appId: null, freeType: FREE_TYPE.KEY }));
  store.setSourceState(SOURCE.CATALOG, { cursor: 800, totalCount: 64625 });
  store.enqueueCandidate(555, { special: true, hint: 100 });
  store.ingestSpecials([7, 8, 9]);
  await store.flush();

  const restored = new Store({ dataDir: dir });
  const result = restored.load();
  assert.equal(result.loaded, true);
  assert.equal(restored.items.size, 2);
  assert.equal(restored.events.length, 2);
  assert.equal(restored.getSourceState(SOURCE.CATALOG).cursor, 800);
  assert.equal(restored.candidates.size, 1);
  assert.equal(restored.seenSpecials.size, 3);
});

test('load 对缺失/损坏文件保持健壮', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-store-bad-'));
  const s1 = new Store({ dataDir: dir });
  assert.equal(s1.load().loaded, false, '文件不存在时应返回 loaded:false');

  fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json', 'utf8');
  const s2 = new Store({ dataDir: dir });
  assert.equal(s2.load().loaded, false, '损坏文件不应抛异常');

  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 999 }), 'utf8');
  const s3 = new Store({ dataDir: dir });
  assert.equal(s3.load().loaded, false, '版本不匹配应拒绝加载');
});

test('summary 统计各类型与来源', () => {
  const { store } = tempStore();
  store.upsert(base({ sourceId: 'a', appId: 1, freeType: FREE_TYPE.KEEP }));
  store.upsert(base({ sourceId: 'b', appId: 2, freeType: FREE_TYPE.F2P }));
  store.upsert(base({ sourceId: 'c', appId: 3, freeType: FREE_TYPE.DISCOUNT, finalPrice: 100, isFree: false }));
  store.upsert(base({ source: SOURCE.GAMERPOWER, sourceId: 'd', appId: null, freeType: FREE_TYPE.KEY }));

  const s = store.summary();
  assert.equal(s.active, 4);
  assert.equal(s.keepCount, 1);
  assert.equal(s.keyCount, 1);
  assert.equal(s.byType[FREE_TYPE.DISCOUNT], 1);
  assert.equal(s.bySource[SOURCE.GAMERPOWER], 1);
});

test('active() 按类型优先级排序（限时免费在前）', () => {
  const { store } = tempStore();
  store.upsert(base({ sourceId: '1', appId: 1, freeType: FREE_TYPE.DISCOUNT, finalPrice: 500, isFree: false }));
  store.upsert(base({ sourceId: '2', appId: 2, freeType: FREE_TYPE.KEEP }));
  store.upsert(base({ sourceId: '3', appId: 3, freeType: FREE_TYPE.F2P }));
  const order = store.active().map((i) => i.freeType);
  assert.deepEqual(order, [FREE_TYPE.KEEP, FREE_TYPE.F2P, FREE_TYPE.DISCOUNT]);
});
