/**
 * HTTP 服务：REST API + SSE 实时推送 + 静态资源托管。
 * 仅使用 Node 内置模块，零第三方依赖。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { FREE_TYPE, FREE_TYPE_LABEL, SOURCE_LABEL, isFreebie } from './model.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 对外输出的条目结构：去掉内部字段，补上展示用标签。 */
export function serializeItem(item) {
  const {
    raw,        // 内部解析标记
    note,       // 内部备注
    key,
    ...rest
  } = item;
  return {
    ...rest,
    key,
    isFreebie: isFreebie(item),
    freeTypeLabel: FREE_TYPE_LABEL[item.freeType] ?? item.freeType,
    sourceLabel: SOURCE_LABEL[item.source] ?? item.source,
  };
}

export function serializeEvent(event) {
  return { ...event };
}

/**
 * 评价档位 -> Steam 的评价文案。
 *
 * Steam 的文案随语言变化（简中：好评如潮/特别好评/多半好评/褒贬不一/多半差评…），
 * 因此这里把常见中英文写法都收进来，避免换语言后筛选失效。
 */
const RATING_TIERS = {
  // 好评如潮 / 极度好评
  overwhelming: ['好评如潮', 'Overwhelmingly Positive'],
  // 特别好评
  veryPositive: ['特别好评', 'Very Positive'],
  // 多半好评 / 好评
  positive: ['多半好评', '好评', 'Positive', 'Mostly Positive'],
  // 褒贬不一
  mixed: ['褒贬不一', 'Mixed'],
  // 差评类
  negative: ['多半差评', '差评', '特别差评', '差评如潮', 'Mostly Negative', 'Negative', 'Very Negative', 'Overwhelmingly Negative'],
};

export function createServer({ store, poller, hub, config, logger, httpStats = () => null, startedAt = Date.now() }) {
  const clients = [];

  /**
   * 静态资源根目录。
   *
   * 默认只托管 `public/`（产品页面）。额外把 `bench/` 挂到 `/bench/` 下，
   * 用于性能对照页（旧渲染实现），这样浏览器脚本能直接访问它做 A/B 对比。
   * 注意两个根目录都要做目录穿越校验。
   */
  const staticRoots = [
    { prefix: '/bench/', dir: config.benchDir },
    { prefix: '/', dir: config.publicDir },
  ].filter((r) => r.dir);

  async function serveStatic(req, res, urlPath) {
    const root = staticRoots.find((r) => r.prefix === '/' || urlPath.startsWith(r.prefix));
    if (!root) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const rel = urlPath.slice(root.prefix.length).replace(/^\/+/, '');
    const target = path.resolve(root.dir, rel === '' ? 'index.html' : rel);
    // 目录穿越防护：解析后必须仍在对应根目录内
    if (target !== root.dir && !target.startsWith(root.dir + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }
    try {
      const stat = await fsp.stat(target);
      if (stat.isDirectory()) throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
      const ext = path.extname(target).toLowerCase();
      const cache = ext === '.html' ? 'no-cache' : 'public, max-age=300';
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': cache,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(target).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    }
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  /**
   * 取当前有效条目（只排序/过滤一次）。
   *
   * 性能注意：`store.active()` 在 3 万条规模下需要约 45ms，因此这里共享同一个
   * 快照，避免在同一请求里重复计算（早期 /api/items 会调用两次，白花一倍时间）。
   */
  function queryItems(url, baseList) {
    const p = url.searchParams;
    const q = (p.get('q') ?? '').trim().toLowerCase();
    const type = p.get('type') ?? 'all';
    const source = p.get('source') ?? 'all';
    const includeEnded = p.get('includeEnded') === '1';
    // freeOnly 默认为 true（只看免费），传 freeOnly=0/any 可关闭
    const freeOnly = p.get('freeOnly') !== '0';
    // 试玩版/Demo/序章默认不返回，避免把真正的限免淹没
    const includeDemos = p.get('includeDemos') === '1';
    const since = p.get('since') ? Date.parse(p.get('since')) : null;

    let list = baseList;
    let demosHidden = 0;
    // 付费且无折扣的条目既不是免费也不是折扣，永远不返回
    // （它们只是 appdetails 校验过程的副产品，对用户没有价值）
    list = list.filter((i) => i.freeType !== FREE_TYPE.PAID);
    if (!includeDemos) {
      const kept = [];
      for (const i of list) {
        if (i.isDemo) demosHidden += 1;
        else kept.push(i);
      }
      list = kept;
    }
    if (type !== 'all') list = list.filter((i) => i.freeType === type);
    if (source !== 'all') list = list.filter((i) => i.source === source);
    if (freeOnly) {
      // 高折扣是**参考信息**，不是免费内容：
      // 它有自己的类型筛选和统计卡片，所以不该被"只看免费"这个开关连带隐藏
      // —— 否则界面上"高折扣"永远显示 0，看起来像没数据（实际是取不到）。
      list = list.filter(
        (i) => i.finalPrice === 0 || i.freeType === 'key' || i.freeType === 'discount',
      );
    }
    if (Number.isFinite(since)) list = list.filter((i) => Date.parse(i.firstSeenAt) >= since);

    // 折扣区间 / 价格区间筛选（用于"高折扣参考"页签）
    // 与分桶保持一致：左闭右开，避免边界值归属歧义
    const minDiscount = p.get('minDiscount') ? Number.parseFloat(p.get('minDiscount')) : null;
    const maxDiscount = p.get('maxDiscount') ? Number.parseFloat(p.get('maxDiscount')) : null;
    if (Number.isFinite(minDiscount)) list = list.filter((i) => (i.discountPercent ?? 0) >= minDiscount);
    if (Number.isFinite(maxDiscount)) {
      // maxDiscount=100 时表示"到顶"，用闭区间；其余用开区间与分桶对齐
      list = maxDiscount >= 100
        ? list.filter((i) => (i.discountPercent ?? 0) <= maxDiscount)
        : list.filter((i) => (i.discountPercent ?? 0) < maxDiscount);
    }

    // 价格用最小货币单位（分），前端按"元"换算后传入
    const minPrice = p.get('minPrice') ? Number.parseFloat(p.get('minPrice')) : null;
    const maxPrice = p.get('maxPrice') ? Number.parseFloat(p.get('maxPrice')) : null;
    if (Number.isFinite(minPrice)) list = list.filter((i) => (i.finalPrice ?? 0) >= minPrice);
    if (Number.isFinite(maxPrice)) list = list.filter((i) => (i.finalPrice ?? 0) < maxPrice);

    // 评价筛选：好评率下限 / 评论数下限 / 评价档位
    const minReviewPercent = p.get('minReviewPercent') ? Number.parseFloat(p.get('minReviewPercent')) : null;
    if (Number.isFinite(minReviewPercent)) {
      list = list.filter((i) => (i.reviewPercent ?? -1) >= minReviewPercent);
    }
    const minReviewCount = p.get('minReviewCount') ? Number.parseFloat(p.get('minReviewCount')) : null;
    if (Number.isFinite(minReviewCount)) {
      list = list.filter((i) => (i.reviewCount ?? 0) >= minReviewCount);
    }
    const rating = p.get('rating');
    if (rating && rating !== 'all') {
      const tiers = RATING_TIERS[rating];
      if (tiers) list = list.filter((i) => tiers.includes(i.reviewSummary));
    }

    if (q) {
      list = list.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          String(i.appId ?? '').includes(q) ||
          (i.description ?? '').toLowerCase().includes(q),
      );
    }
    return { list, demosHidden };
  }

  const server = http.createServer(async (req, res) => {
    /**
     * 解析请求目标。
     *
     * ⚠️ 只接受 **origin-form**（以单个 `/` 开头）。原因（实测）：
     *   `new URL('//package.json', 'http://127.0.0.1:8899')`
     *     -> host=package.json, pathname='/'
     * 即 `//x` 会被当成"协议相对 URL"，把 x 当主机名，pathname 直接变成 `/` ——
     * 结果是静态资源静默返回首页（不泄露文件，但语义完全错乱、也让人以为路径正常）。
     * 同理 `http://evil.com/x` 这种 absolute-form 也会被解析成 `/x`。
     * 我们不需要 Host，所以用固定 base，非 origin-form 一律 400。
     */
    const rawTarget = req.url ?? '/';
    if (!rawTarget.startsWith('/') || rawTarget.startsWith('//')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('400 Bad Request');
      return;
    }
    const url = new URL(rawTarget, 'http://localhost');

    try {
      // ---------------------------------------------------------- SSE
      if (url.pathname === '/api/stream') {
        hub.attach(req, res, {
          summary: store.summary(),
          sourceCount: poller?.size ?? 0,
        });
        return;
      }

      if (url.pathname === '/api/health') {
        json(res, 200, { ok: true, uptimeMs: Date.now() - startedAt, clients: hub.size });
        return;
      }

      // ---------------------------------------------------------- 状态
      if (url.pathname === '/api/status') {
        const sources = poller?.status() ?? [];
        // 数据新鲜度：只要有任一数据源长时间没有成功抓取，页面就应该明确提示，
        // 否则用户看到的是陈旧数据却以为一切正常（Steam 不可达时正是如此）。
        const successes = sources
          .map((s) => s.stats?.lastSuccessAt)
          .filter(Boolean)
          .map((t) => Date.parse(t))
          .filter(Number.isFinite);
        const lastSuccessAt = successes.length ? new Date(Math.max(...successes)).toISOString() : null;
        const staleAfterMs = Math.max(180_000, config.steam.sweepIntervalMs * 3);
        const dataAgeMs = lastSuccessAt ? Date.now() - Date.parse(lastSuccessAt) : null;
        json(res, 200, {
          ok: true,
          startedAt: new Date(startedAt).toISOString(),
          uptimeMs: Date.now() - startedAt,
          summary: store.summary(),
          freshness: {
            lastSuccessAt,
            dataAgeMs,
            stale: dataAgeMs == null || dataAgeMs > staleAfterMs,
            staleThresholdMs: staleAfterMs,
            failingSources: sources.filter((s) => (s.stats?.consecutiveFailures ?? 0) > 0).map((s) => s.name),
          },
          sources,
          realtime: { clients: hub.size, ...hub.stats },
          http: httpStats(),
          config: {
            cc: config.steam.cc,
            lang: config.steam.lang,
            sweepIntervalMs: config.steam.sweepIntervalMs,
            sweepPagesPerCycle: config.steam.sweepPagesPerCycle,
            watchlistIntervalMs: config.steam.watchlistIntervalMs,
            watchlistBatch: config.steam.watchlistBatch,
            gamerpowerIntervalMs: config.gamerpower.intervalMs,
            webhookEnabled: Boolean(config.webhookUrl),
            enabled: config.enabled,
          },
        });
        return;
      }

      // ---------------------------------------------------------- 区间分布
      // 供"高折扣参考"的价格/折扣区间筛选使用：
      // 让界面知道每个区间**实际有多少条**，避免给出空区间（用户点了没结果很困惑）
      if (url.pathname === '/api/facets') {
        const type = url.searchParams.get('type') ?? 'discount';
        const base = store.active().filter((i) => !i.isDemo && i.freeType === type);
        // 分桶用左闭右开 [lo, hi)，否则落在边界上的值会被相邻两个桶重复计数
        const discountBuckets = [];
        for (let lo = 0; lo < 100; lo += 10) {
          const hi = lo + 10;
          const isLast = hi >= 100;
          discountBuckets.push({
            min: lo,
            max: hi,
            count: base.filter((i) => {
              const d = i.discountPercent ?? 0;
              return d >= lo && (isLast ? d <= hi : d < hi);
            }).length,
          });
        }
        const priceRanges = [
          [0, 1000], [1000, 2500], [2500, 5000], [5000, 10000], [10000, 20000], [20000, 50000], [50000, Infinity],
        ];
        const priceBuckets = priceRanges.map(([lo, hi]) => ({
          min: lo,
          max: Number.isFinite(hi) ? hi : null,
          count: base.filter((i) => {
            const v = i.finalPrice ?? 0;
            return v >= lo && (Number.isFinite(hi) ? v < hi : true);
          }).length,
        }));
        const prices = base.map((i) => i.finalPrice ?? 0).filter(Number.isFinite);
        // 评价档位计数：让界面能显示每档实际有多少条（含"未收录评价"）
        const ratingTiers = Object.entries(RATING_TIERS).map(([key, names]) => ({
          key,
          names,
          count: base.filter((i) => names.includes(i.reviewSummary)).length,
        }));
        const withReview = base.filter((i) => (i.reviewCount ?? 0) > 0).length;
        json(res, 200, {
          type,
          total: base.length,
          discountBuckets,
          priceBuckets,
          ratingTiers,
          withReviewCount: withReview,
          withoutReviewCount: base.length - withReview,
          priceMin: prices.length ? Math.min(...prices) : 0,
          priceMax: prices.length ? Math.max(...prices) : 0,
          currency: base.find((i) => i.currency)?.currency ?? null,
        });
        return;
      }

      // ---------------------------------------------------------- 条目列表
      if (url.pathname === '/api/items') {
        const includeEnded = url.searchParams.get('includeEnded') === '1';
        // store.active() 是这里最贵的操作（3 万条约 45ms），只算一次并复用
        const base = store.active({ includeEnded });
        const { list, demosHidden } = queryItems(url, base);
        const limit = Math.min(2000, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '600', 10) || 600));
        // 分页：offset 让前端可以"从没读到的继续读"，而不是只拿前 N 条
        const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
        json(res, 200, {
          total: list.length,
          offset,
          returned: Math.max(0, Math.min(limit, list.length - offset)),
          hasMore: offset + limit < list.length,
          generatedAt: new Date().toISOString(),
          // 高频接口：跳过昂贵的分组统计
          summary: store.summary({ groupCounts: false }),
          demosHidden,
          items: list.slice(offset, offset + limit).map(serializeItem),
        });
        return;
      }

      // ---------------------------------------------------------- 事件流
      if (url.pathname === '/api/events') {
        const limit = Math.min(400, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '80', 10) || 80));
        const type = url.searchParams.get('type');
        let events = store.events;
        if (type) events = events.filter((e) => e.type === type);
        json(res, 200, { total: events.length, events: events.slice(0, limit).map(serializeEvent) });
        return;
      }

      // ---------------------------------------------------------- 单个条目
      if (url.pathname.startsWith('/api/item/')) {
        const key = decodeURIComponent(url.pathname.slice('/api/item/'.length));
        const item = store.get(key);
        if (!item) {
          json(res, 404, { ok: false, error: 'not found' });
          return;
        }
        json(res, 200, { ok: true, item: serializeItem(item) });
        return;
      }

      // ---------------------------------------------------------- 手动刷新
      if (url.pathname === '/api/refresh' && req.method === 'POST') {
        const which = url.searchParams.get('source');
        // 前端可以指定只刷新某个源；catalog 允许临时加大页数
        const pagesParam = Number.parseInt(url.searchParams.get('pages') ?? '', 10);
        const options = Number.isFinite(pagesParam) && pagesParam > 0
          ? { 'steam-catalog': { pages: Math.min(120, pagesParam) } }
          : undefined;
        if (which && which !== 'all') {
          const result = await poller.runSource(which, options?.[which]);
          json(res, 200, { ok: true, source: which, result });
        } else {
          const results = await poller.runAll(options ?? {});
          json(res, 200, { ok: true, results });
        }
        return;
      }

      // ---------------------------------------------------------- 静态资源
      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, url.pathname);
        return;
      }

      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('405 Method Not Allowed');
    } catch (error) {
      logger.error(`request ${req.method} ${url.pathname} failed: ${error.stack ?? error}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
      else res.end();
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  return {
    server,
    clients,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      for (const c of clients) c.destroy?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
