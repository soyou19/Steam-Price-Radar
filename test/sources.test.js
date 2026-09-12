/**
 * 数据源测试（使用假 HTTP 客户端，不联网）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { GamerPowerSource } from '../src/sources/gamerpower.js';
import { SteamSpotlightSource } from '../src/sources/steamSpotlight.js';
import { SteamDiscountsSource } from '../src/sources/steamDiscounts.js';
import { SteamDetailsSource, classifyFree, hasFreeLicense } from '../src/sources/steamDetails.js';
import { SteamCatalogSource } from '../src/sources/steamCatalog.js';
import { FREE_TYPE, SOURCE } from '../src/model.js';
import { HttpClient } from '../src/http.js';

function tempStore() {
  return new Store({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'steam-src-')) });
}

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

const baseConfig = () => ({
  steam: {
    cc: 'cn', lang: 'schinese',
    sweepIntervalMs: 60000, sweepPagesPerCycle: 2,
    watchlistIntervalMs: 60000, watchlistBatch: 2, f2pRecheckMs: 0, discountRecheckMs: 3600000,
    discountsPagesPerCycle: 2, discountsIntervalMs: 60000, discountsSweepMs: 3600000, spotlightIntervalMs: 300000,
    searchRetries: 2, searchTimeoutMs: 5000,
  },
  enabled: { steamDiscounts: false, steamSpotlight: false },
  gamerpower: { url: 'http://fake/gp' },
  watchlistAppIds: [],
});

/** 构造一条 GamerPower 风格的条目。 */
const gpItem = (over = {}) => ({
  id: 1,
  title: 'Free Game Key Giveaway',
  worth: '$19.99',
  thumbnail: 'https://cdn.example.com/t.jpg',
  image: 'https://cdn.example.com/i.jpg',
  description: 'Claim a free Steam key!',
  instructions: 'Redeem on Steam',
  open_giveaway_url: 'https://www.gamerpower.com/open/x',
  published_date: '2026-09-01 10:00:00',
  type: 'Game',
  platforms: 'PC, Steam',
  end_date: '2026-09-30 10:00:00',
  users: 100,
  status: 'Active',
  gamerpower_url: 'https://www.gamerpower.com/x',
  ...over,
});

test('GamerPower: 规范化字段并写入 store', async () => {
  const store = tempStore();
  const http = { json: async () => [gpItem()] };
  const src = new GamerPowerSource({ http, store, config: baseConfig(), logger: silent });

  const res = await src.runOnce();
  assert.equal(res.count, 1);
  assert.equal(res.changes, 1);

  const item = store.get(`${SOURCE.GAMERPOWER}:1`);
  assert.equal(item.title, 'Free Game Key Giveaway');
  assert.equal(item.freeType, FREE_TYPE.KEY);
  assert.equal(item.worth, '$19.99');
  assert.deepEqual(item.platforms, ['PC', 'Steam']);
  assert.equal(item.endDate, new Date('2026-09-30T10:00:00').toISOString());
  assert.equal(item.active, true);
});

test('GamerPower: 完整列表来源，未出现条目在容忍轮后结束', async () => {
  const store = tempStore();
  const items = [gpItem({ id: 1 }), gpItem({ id: 2 })];
  const http = { json: async () => items };
  const src = new GamerPowerSource({ http, store, config: baseConfig(), logger: silent });

  await src.runOnce();
  assert.equal(store.summary().active, 2);

  // 第二次只剩 id=1：容忍轮数内先保留
  http.json = async () => [gpItem({ id: 1 })];
  await src.runOnce();
  assert.equal(store.get(`${SOURCE.GAMERPOWER}:2`).active, true, '容忍 2 轮，第一次缺失仍保留');
  assert.equal(store.get(`${SOURCE.GAMERPOWER}:2`).missedPasses, 1);

  // 第三次仍然缺失 => 达到容忍上限，判定结束
  await src.runOnce();
  assert.equal(store.get(`${SOURCE.GAMERPOWER}:2`).active, false, '连续两轮缺失应判定结束');
  assert.equal(store.get(`${SOURCE.GAMERPOWER}:2`).lastEventType, 'ended');
  assert.equal(store.get(`${SOURCE.GAMERPOWER}:1`).active, true, '仍在列表中的条目不受影响');
});

test('GamerPower: 恶意/异常外部数据被安全处理', async () => {
  const store = tempStore();
  const http = {
    json: async () => [
      gpItem({
        id: 5,
        title: '<script>alert(1)</script>危险标题',
        // 所有 URL 都是危险协议，必须全部被拒绝
        gamerpower_url: 'javascript:alert(1)',
        open_giveaway_url: 'javascript:alert(2)',
        image: 'javascript:alert(3)',
        thumbnail: 'data:text/html,<script>alert(4)</script>',
      }),
      { id: null, title: 'no id' },
      null,
      gpItem({ id: 6, status: 'Expired' }),
    ],
  };
  const src = new GamerPowerSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.runOnce();

  assert.equal(res.count, 2, '无 id 与 null 条目应被跳过');
  const evil = store.get(`${SOURCE.GAMERPOWER}:5`);
  assert.ok(!evil.title.includes('<script>'), 'HTML 标签应被剥离');
  assert.equal(evil.url, null, 'javascript: 协议 URL 必须被拒绝');
  assert.equal(evil.image, null, 'javascript:/data: 协议图片必须被拒绝');

  assert.equal(store.get(`${SOURCE.GAMERPOWER}:6`).active, false, 'Expired 状态应标记为非活跃');
});

test('GamerPower: 某个 URL 非法时回退到合法 URL', async () => {
  const store = tempStore();
  const http = {
    json: async () => [
      gpItem({ id: 7, gamerpower_url: 'javascript:alert(1)', open_giveaway_url: 'https://legit.example.com/open' }),
    ],
  };
  const src = new GamerPowerSource({ http, store, config: baseConfig(), logger: silent });
  await src.runOnce();
  assert.equal(store.get(`${SOURCE.GAMERPOWER}:7`).url, 'https://legit.example.com/open');
});

test('GamerPower: 非数组响应视为失败', async () => {
  const store = tempStore();
  const http = { json: async () => ({ error: 'rate limited' }) };
  const src = new GamerPowerSource({ http, store, config: baseConfig(), logger: silent });
  await assert.rejects(() => src.runOnce(), /unexpected payload shape/);
});

test('classifyFree 依据 appdetails 字段判定免费形态', () => {
  // 永久免费：is_free=true 且无价格信息
  assert.equal(classifyFree({ isFreeFlag: true, price: null }), FREE_TYPE.F2P);
  // 100% 折扣：限时免费入库
  assert.equal(
    classifyFree({ isFreeFlag: true, price: { final: 0, discount_percent: 100, initial_formatted: '¥ 68.00' } }),
    FREE_TYPE.KEEP,
  );
  // 带免费周末说明文案
  assert.equal(
    classifyFree({ isFreeFlag: true, price: { final: 0, discount_percent: 100, price_overview_notice: 'Free Weekend' } }),
    FREE_TYPE.WEEKEND,
  );
  assert.equal(
    classifyFree({ isFreeFlag: true, price: { final: 0, discount_percent: 100, discount_notice: '免费周末试玩' } }),
    FREE_TYPE.WEEKEND,
  );
  // 有折扣的付费游戏
  assert.equal(classifyFree({ isFreeFlag: false, price: { final: 2399, discount_percent: 60 } }), FREE_TYPE.DISCOUNT);
  // 付费且**没有**折扣 -> PAID，绝不能记成 DISCOUNT
  // （回归：早期实现把所有 is_free=false 都当成折扣，导致"高折扣"里混入一堆 0% 条目）
  assert.equal(classifyFree({ isFreeFlag: false, price: { final: 4800, discount_percent: 0 } }), FREE_TYPE.PAID);
  assert.equal(classifyFree({ isFreeFlag: false, price: null }), FREE_TYPE.PAID);
  assert.equal(classifyFree({ isFreeFlag: false, price: { final: 26800 } }), FREE_TYPE.PAID);
});

test('SteamDetails: 按候选队列挑选并精确判定限时免费', async () => {
  const store = tempStore();
  // 注意：候选必须带"信号"（special/hint/reviews）才会进入校验队列，
  // 无信号的冷门条目会被分诊跳过（见 store.shouldVerifyCandidate）
  store.enqueueCandidate(111, { special: true, hint: 0 });
  store.enqueueCandidate(222, { special: false, hint: 0, reviews: 1500 });

  const responses = {
    111: { 111: { success: true, data: {
      type: 'game', name: '限时免费游戏', is_free: true, header_image: 'https://i/x.jpg',
      short_description: '限免中',
      price_overview: { currency: 'CNY', initial: 6800, final: 0, discount_percent: 100, initial_formatted: '¥ 68.00', final_formatted: '免费' },
      release_date: { date: '2020-01-01' }, platforms: { windows: true },
    } } },
    222: { 222: { success: true, data: {
      type: 'game', name: '永久免费游戏', is_free: true,
      price_overview: null, release_date: { date: '2021-01-01' }, platforms: { windows: true },
    } } },
  };
  const http = { json: async (url) => {
    const id = new URL(url).searchParams.get('appids');
    return responses[id] ?? { [id]: { success: false } };
  } };

  const src = new SteamDetailsSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.runOnce({ batch: 2 });

  assert.equal(res.verified, 2);
  assert.equal(res.keepFound, 1);
  assert.equal(store.candidates.size, 0, '校验完成的候选应从队列移除');

  const keep = store.get(`${SOURCE.DETAILS}:111`);
  assert.equal(keep.freeType, FREE_TYPE.KEEP);
  assert.equal(keep.title, '限时免费游戏');
  assert.equal(keep.originalPriceFormatted, '¥ 68.00');
  assert.equal(keep.wasPaid, true);
  assert.ok(Number.isFinite(Date.parse(keep.lastVerifiedAt)), '应记录校验时间');
});

test('SteamDetails: 付费商品不会被误判为免费', async () => {
  const store = tempStore();
  store.enqueueCandidate(333, { special: true });
  const http = { json: async () => ({ 333: { success: true, data: {
    type: 'game', name: '付费游戏', is_free: false,
    price_overview: { currency: 'CNY', initial: 9800, final: 4900, discount_percent: 50, initial_formatted: '¥ 98.00', final_formatted: '¥ 49.00' },
  } } }) };
  const src = new SteamDetailsSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.runOnce({ batch: 1 });

  assert.equal(res.freeFound, 0);
  const item = store.get(`${SOURCE.DETAILS}:333`);
  assert.equal(item.freeType, FREE_TYPE.DISCOUNT);
  assert.equal(item.isFree, false);
  assert.equal(item.finalPrice, 4900);
});

test('SteamDetails: 限免结束后恢复付费 => 原限免条目被判定已结束', async () => {
  const store = tempStore();
  // 先有一条扫描来源的限时免费记录
  store.upsert({
    source: SOURCE.CATALOG, sourceId: '444', appId: 444, title: '曾经的限免',
    freeType: FREE_TYPE.KEEP, finalPrice: 0, isFree: true, active: true,
  });
  store.enqueueCandidate(444, { special: true });

  const http = { json: async () => ({ 444: { success: true, data: {
    type: 'game', name: '曾经的限免', is_free: false,
    price_overview: { currency: 'CNY', initial: 6800, final: 6800, discount_percent: 0, initial_formatted: '¥ 68.00', final_formatted: '¥ 68.00' },
  } } }) };
  const src = new SteamDetailsSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.runOnce({ batch: 1 });

  assert.equal(res.ended, 1, '应报告一条限免结束');
  assert.equal(store.get(`${SOURCE.CATALOG}:444`).active, false, '扫描来源的限免条目应被标记结束');
  assert.equal(store.get(`${SOURCE.CATALOG}:444`).lastEventType, 'ended');
  assert.equal(store.candidates.size, 0);
});

test('SteamDetails: 无数据的 appid 从队列移除且不抛错', async () => {
  const store = tempStore();
  store.enqueueCandidate(555, { special: false, reviews: 900 });
  const http = { json: async () => ({ 555: { success: false } }) };
  const src = new SteamDetailsSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.runOnce({ batch: 1 });

  assert.equal(res.notFound, 1);
  assert.equal(res.errors, 0);
  assert.equal(store.candidates.size, 0, '连续失败的候选不应无限重试');
});

test('classifyFree 识别"免费周末"：is_free=false 但购买选项里有免费许可', () => {
  // F1® 25 免费周末时的真实结构：is_free=false，price_overview 显示 -30% 折扣，
  // 但 package_groups.subs 里有一个 is_free_license:true 的"免费"选项。
  // 早期实现只看 price_overview，会误判成"折扣"，于是免费周末永远发现不了。
  const realWorld = {
    isFreeFlag: false,
    price: { currency: 'CNY', initial: 24800, final: 17360, discount_percent: 30 },
    packageGroups: [
      {
        name: 'default',
        subs: [
          { packageid: 1673188, option_text: 'F1® 25 - EA Play - 免费', is_free_license: true, price_in_cents_with_discount: 0 },
          { packageid: 1453566, option_text: '《F1® 25》：2026赛季版 - ¥248.00 ¥173.60', is_free_license: false, price_in_cents_with_discount: 17360 },
        ],
      },
    ],
  };
  assert.equal(classifyFree(realWorld), FREE_TYPE.WEEKEND, '有免费购买选项 => 免费周末而非折扣');

  // 没有免费选项时仍是普通折扣
  assert.equal(
    classifyFree({ isFreeFlag: false, price: { final: 17360, discount_percent: 30 }, packageGroups: [] }),
    FREE_TYPE.DISCOUNT,
  );

  // 永久免费游戏也有 is_free_license=true，但 is_free=true => 仍是 F2P
  assert.equal(
    classifyFree({ isFreeFlag: true, price: null, packageGroups: [{ subs: [{ is_free_license: true }] }] }),
    FREE_TYPE.F2P,
    'is_free=true 时不应因为免费 sub 就判成免费周末',
  );

  // is_free=false 且无价格信息，但有免费选项 => 限时体验
  assert.equal(
    classifyFree({ isFreeFlag: false, price: null, packageGroups: [{ subs: [{ is_free_license: true }] }] }),
    FREE_TYPE.WEEKEND,
  );
});

test('hasFreeLicense 正确遍历 package_groups', () => {
  assert.equal(hasFreeLicense(undefined), false);
  assert.equal(hasFreeLicense([]), false);
  assert.equal(hasFreeLicense([{ subs: [{ is_free_license: false }] }]), false);
  assert.equal(hasFreeLicense([{ subs: [{ is_free_license: true }] }]), true);
  assert.equal(hasFreeLicense([{}, { subs: [{}, { is_free_license: true }] }]), true);
});

test('extractFreeSpotlights 从精选位提取免费活动并去重', () => {
  const feed = {
    0: { name: 'Spotlights', items: [{ name: '免费周末', url: 'https://store.steampowered.com/app/3059520', header_image: 'x.jpg' }] },
    1: { name: 'Spotlights', items: [{ name: '周末特惠', url: 'https://store.steampowered.com/app/2852190' }] },
    2: { name: 'Spotlights', items: [{ name: '发行商特卖', url: 'https://store.steampowered.com/sale/BlizzardPublisherSale26' }] },
    3: { name: 'Spotlights', items: [{ name: '限时免费', url: 'https://store.steampowered.com/app/999' }] },
    4: { name: 'Spotlights', items: [{ name: '免费周末', url: 'https://store.steampowered.com/app/3059520' }] },
  };
  const out = SteamSpotlightSource.extractFreeSpotlights(feed);
  assert.equal(out.length, 2, '应提取 2 个（去重后）：免费周末 + 限时免费');
  assert.equal(out.find((x) => x.appId === 3059520).freeType, FREE_TYPE.WEEKEND);
  assert.equal(out.find((x) => x.appId === 999).freeType, FREE_TYPE.KEEP);
  assert.equal(out.some((x) => x.appId === 2852190), false, '"周末特惠"只是折扣活动，不是免费');
});

test('extractFreeSpotlights 容忍异常输入', () => {
  assert.deepEqual(SteamSpotlightSource.extractFreeSpotlights(null), []);
  assert.deepEqual(SteamSpotlightSource.extractFreeSpotlights({}), []);
  assert.deepEqual(SteamSpotlightSource.extractFreeSpotlights({ 0: { items: [] } }), []);
  assert.deepEqual(SteamSpotlightSource.extractFreeSpotlights({ 0: { items: [null, {}] } }), []);
});

test('SteamSpotlight 源：识别免费周末写入 store，活动消失后判定结束', async () => {
  const store = tempStore();
  const feed = { 0: { items: [{ name: '免费周末', url: 'https://store.steampowered.com/app/3059520' }] } };
  const details = {
    3059520: {
      success: true,
      data: {
        type: 'game', name: 'F1® 25', steam_appid: 3059520, is_free: false,
        header_image: 'h.jpg', short_description: '赛车',
        price_overview: { currency: 'CNY', initial: 24800, final: 17360, discount_percent: 30, initial_formatted: '¥ 248.00' },
        release_date: { date: '2025 年 5 月 30 日' },
      },
    },
  };
  const http = {
    json: async (url) => (url.includes('featuredcategories') ? feed : { 3059520: details[3059520] }),
  };
  const src = new SteamSpotlightSource({ http, store, config: baseConfig(), logger: silent });

  const res = await src.runOnce();
  assert.equal(res.found, 1);
  assert.equal(res.verified, 1);

  const item = store.get(`${SOURCE.SPOTLIGHT}:3059520`);
  assert.ok(item, '应写入精选活动条目');
  assert.equal(item.freeType, FREE_TYPE.WEEKEND, '应标记为免费周末');
  assert.equal(item.isFree, true);
  assert.equal(item.title, 'F1® 25');
  assert.equal(item.originalPriceFormatted, '¥ 248.00', '免费周末应保留原价供参考');
  assert.equal(item.finalPriceFormatted, '免费周末');
  assert.equal(item.spotLabel, '免费周末');

  // 活动结束（精选位不再返回）=> 连续两轮后判定结束
  http.json = async () => ({ 0: { items: [] } });
  await src.runOnce();
  await src.runOnce();
  assert.equal(store.get(`${SOURCE.SPOTLIGHT}:3059520`).active, false, '活动结束后应标记非活跃');
});

test('SteamDetails: 免费周末游戏不应被误判为折扣（端到端）', async () => {
  const store = tempStore();
  store.enqueueCandidate(3059520, { reviews: 5000 });
  const http = {
    json: async () => ({
      3059520: {
        success: true,
        data: {
          type: 'game', name: 'F1® 25', is_free: false,
          price_overview: { currency: 'CNY', initial: 24800, final: 17360, discount_percent: 30, initial_formatted: '¥ 248.00', final_formatted: '¥ 173.60' },
          package_groups: [
            { subs: [
              { is_free_license: true, price_in_cents_with_discount: 0, option_text: 'F1® 25 - EA Play - 免费' },
              { is_free_license: false, price_in_cents_with_discount: 17360 },
            ] },
          ],
        },
      },
    }),
  };
  const src = new SteamDetailsSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.runOnce({ batch: 1 });
  assert.equal(res.verified, 1);
  const item = store.get(`${SOURCE.DETAILS}:3059520`);
  assert.equal(item.freeType, FREE_TYPE.WEEKEND, '应识别为免费周末而不是折扣');
  assert.equal(item.finalPrice, 0, '免费周末期间实际可免费游玩');
  assert.equal(item.originalPriceFormatted, '¥ 248.00');
});

test('SteamDiscounts：从促销索引采集折扣与价格（回归：曾把价格数据丢掉）', async () => {
  const store = tempStore();
  const row = (appId, title, pct, orig, fin, finalAttr) =>
    `<a href="https://store.steampowered.com/app/${appId}/x/" data-ds-appid="${appId}" class="search_result_row ">
      <span class="title">${title}</span>
      <div class="search_price_discount_combined" data-price-final="${finalAttr}">
        <div class="discount_block search_discount_block">
          <div class="discount_pct">-${pct}%</div>
          <div class="discount_original_price">${orig}</div>
          <div class="discount_final_price">${fin}</div>
        </div>
      </div></a>`;
  const html = row(1091500, 'Cyberpunk 2077', 75, '¥348.00', '¥87.00', 8700)
    + row(275850, "No Man's Sky", 60, '¥175.00', '¥70.00', 7000);

  let calls = 0;
  const http = { json: async (url) => {
    calls += 1;
    const start = Number(new URL(url).searchParams.get('start'));
    return { total_count: 200, results_html: start === 0 ? html : '' };
  } };
  const src = new SteamDiscountsSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.runOnce({ pages: 2 });

  assert.equal(res.ok, true);
  assert.equal(res.discounts, 2, '应采集到 2 条折扣');
  assert.equal(res.rows, 2);
  assert.ok(calls >= 1);

  const cp = store.get(`${SOURCE.DISCOUNTS}:1091500`);
  assert.ok(cp, '折扣条目应写入 store');
  assert.equal(cp.freeType, FREE_TYPE.DISCOUNT);
  assert.equal(cp.discountPercent, 75);
  assert.equal(cp.originalPrice, 34800);
  assert.equal(cp.finalPrice, 8700, '必须保留价格，供价格区间筛选');
  assert.equal(cp.originalPriceFormatted, '¥348.00');
  assert.equal(cp.isFree, false);

  // 顺带产出"曾促销"集合（用于候选优先级）
  assert.equal(store.seenSpecials.has(1091500), true);
  assert.equal(store.seenSpecials.has(275850), true);
});

test('SteamDiscounts：跳过没有折扣的条目', async () => {
  const store = tempStore();
  const html = `<a href="https://store.steampowered.com/app/555/x/" data-ds-appid="555" class="search_result_row ">
      <span class="title">全价游戏</span>
      <div class="search_price_discount_combined" data-price-final="4800">
        <div class="discount_block no_discount search_discount_block"><div class="discount_final_price">¥48.00</div></div>
      </div></a>`;
  const http = { json: async (url) => {
    const start = Number(new URL(url).searchParams.get('start'));
    return { total_count: 100, results_html: start === 0 ? html : '' };
  } };
  const src = new SteamDiscountsSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.runOnce({ pages: 1 });
  assert.equal(res.discounts, 0, '没有折扣百分比的不算折扣');
  assert.equal(store.get(`${SOURCE.DISCOUNTS}:555`), null);
});

test('SteamDiscounts：整轮失败时上报 ok=false', async () => {
  const store = tempStore();
  const http = { json: async () => { throw new Error('connect timeout'); } };
  const src = new SteamDiscountsSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.runOnce({ pages: 2 });
  assert.equal(res.ok, false, '一页都没成功应标记失败');
  assert.match(res.error, /connect timeout/, '应带上具体错误，便于定位 Steam 不可达');
});

test('SteamCatalog.backfillReviews：只补评价字段、不回退主游标', async () => {
  const store = tempStore();
  const row = (appId, title, summary, pct, count) =>
    `<a href="https://store.steampowered.com/app/${appId}/x/" data-ds-appid="${appId}" class="search_result_row ">
      <span class="title">${title}</span>
      <div class="search_reviewscore"><span class="search_review_summary positive"
        data-tooltip-html="${summary}&lt;br&gt;此游戏的 ${count} 篇用户评测中有 ${pct}% 为好评。"></span></div>
      <div class="search_price_discount_combined" data-price-final="0">
        <div class="discount_block no_discount search_discount_block"><div class="discount_final_price free">Free</div></div>
      </div></a>`;

  // 模拟"持久化修复前留下的、没有评价字段的旧条目"
  for (const id of [1000, 1001]) {
    store.upsert({
      source: SOURCE.CATALOG, sourceId: String(id), appId: id, title: `Old ${id}`,
      freeType: FREE_TYPE.F2P, finalPrice: 0, isFree: true,
    });
  }
  assert.equal(store.get(`${SOURCE.CATALOG}:1000`).reviewSummary, null);

  const http = { json: async (url) => {
    const start = Number(new URL(url).searchParams.get('start'));
    if (start === 0) {
      return {
        total_count: 64640,
        results_html: row(1000, 'Old 1000', '特别好评', 89, 1412376) + row(1001, 'Old 1001', '好评如潮', 96, 500000),
      };
    }
    return { total_count: 64640, results_html: '' }; // 后续为空 => 结束
  } };
  const src = new SteamCatalogSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.backfillReviews(5);

  assert.equal(res.updated, 2, '应补上 2 条的评价字段');
  assert.equal(res.done, true);
  // 回填不得推进主扫描游标
  assert.equal(store.getSourceState(SOURCE.CATALOG).cursor, undefined, '回填不得影响主游标');

  const it = store.get(`${SOURCE.CATALOG}:1000`);
  assert.equal(it.reviewSummary, '特别好评', '评价结果应被补齐');
  assert.equal(it.reviewPercent, 89);
  assert.equal(it.reviewCount, 1412376);
  assert.equal(store.get(`${SOURCE.CATALOG}:1001`).reviewSummary, '好评如潮');
});

test('SteamCatalog.backfillReviews：持续失败时退避重试并保留断点', async () => {
  const store = tempStore();
  let calls = 0;
  const http = { json: async () => { calls += 1; throw new Error('HTTP 429'); } };
  const src = new SteamCatalogSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.backfillReviews(5);
  assert.equal(res.pages, 0, '一页都没成功');
  assert.ok(res.errors >= 3, `应记录失败次数，实际 ${res.errors}`);
  assert.ok(calls >= 3, '应重试若干次后才放弃');
  assert.equal(res.done, false, '未完成，保留断点供下次继续');
});

test('SteamCatalog: 单页全部失败时报告整轮失败（网络故障不会被当成无新内容）', async () => {
  const store = tempStore();
  const http = { json: async () => { throw new Error('connect timeout'); } };
  const src = new SteamCatalogSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.runOnce({ pages: 2 });

  assert.equal(res.ok, false, '一页都没成功必须标记为失败');
  assert.equal(res.pages, 0);
  assert.match(res.error, /connect timeout/);
});

test('SteamCatalog: 解析结果写入 store 并登记候选队列', async () => {
  const store = tempStore();
  const row = `<a href="https://store.steampowered.com/app/730/CS2/" data-ds-appid="730" class="search_result_row ">
     <span class="title">Counter-Strike 2</span>
     <div class="search_price_discount_combined" data-price-final="10300">
       <div class="discount_block no_discount search_discount_block"><div class="discount_final_price free">Free</div></div>
     </div></a>`;
  let calls = 0;
  const http = { json: async (url) => {
    calls += 1;
    const start = Number(new URL(url).searchParams.get('start'));
    return start === 0
      ? { total_count: 150, results_html: row }
      : { total_count: 150, results_html: '' };
  } };
  const src = new SteamCatalogSource({ http, store, config: baseConfig(), logger: silent });
  const res = await src.runOnce({ pages: 2 });

  assert.equal(res.ok, true);
  assert.equal(res.rows >= 1, true);
  assert.ok(store.get(`${SOURCE.CATALOG}:730`));
  assert.equal(store.candidates.has(730), true, '发现的 appid 应进入候选队列等待精判');
  assert.ok(calls >= 1);
});

test('HttpClient: 网络错误会重试，并统计失败', async () => {
  const attempts = { n: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts.n += 1;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  };
  try {
    const client = new HttpClient({ minIntervalMs: 1, retries: 2, timeoutMs: 500 });
    await assert.rejects(() => client.text('https://example.invalid/x'), /network failure/);
    assert.equal(attempts.n, 3, '首次 + 2 次重试');
    assert.equal(client.stats.failed, 1);
    assert.ok(client.stats.retries >= 2);
    assert.ok(client.stats.lastError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HttpClient: 4xx 不重试，5xx 重试', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let n = 0;
    globalThis.fetch = async () => {
      n += 1;
      return new Response('nope', { status: 404 });
    };
    const c1 = new HttpClient({ minIntervalMs: 1, retries: 3, timeoutMs: 500 });
    await assert.rejects(() => c1.text('https://example.invalid/x'), /HTTP 404/);
    assert.equal(n, 1, '404 不应重试');

    let m = 0;
    globalThis.fetch = async () => {
      m += 1;
      return new Response('boom', { status: 503 });
    };
    const c2 = new HttpClient({ minIntervalMs: 1, retries: 2, timeoutMs: 500 });
    await assert.rejects(() => c2.text('https://example.invalid/y'), /HTTP 503/);
    assert.equal(m, 3, '503 应重试到上限');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
