/**
 * 配置：默认值 + 可选 .env 文件覆盖（内置极简 dotenv，避免引入依赖）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { env, envInt, envList } from './util.js';
import { resolveProxyUrl, systemCaEnabled } from './net.js';

/**
 * 解析 .env（不覆盖已存在的真实环境变量）。
 *
 * @param {string} [file='.env'] .env 路径；相对路径按当前工作目录解析。
 *   必须给默认值：boot 入口（src/server.js）会无参调用它，
 *   早期版本没有默认值导致 `readFileSync(undefined)` 抛错被吞掉、
 *   静默返回 false —— 表现为"配置了 .env 却完全不生效"。
 * @returns {boolean} 是否成功读取
 */
export function loadDotEnvFile(file = '.env') {
  let text;
  try {
    text = readFileSync(path.resolve(file), 'utf8');
  } catch (error) {
    if (process.env.LOG_LEVEL === 'debug') {
      process.stderr.write(`[config] 读取 ${file} 失败：${error.code ?? error.message}\n`);
    }
    return false;
  }
  // 兼容带 BOM 的 .env（Windows 上用 PowerShell 写文件很常见），否则第一行键名会带 \uFEFF
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

export function loadConfig({ cwd = process.cwd(), envFile = '.env' } = {}) {
  const envPath = path.resolve(cwd, envFile);
  const dotenvLoaded = loadDotEnvFile(envPath);

  const proxyRaw = env('PROXY_URL', '').trim();
  const proxyDisabled = proxyRaw.toLowerCase() === 'none';
  const proxyUrl = proxyDisabled ? null : proxyRaw || null;

  // 代理环境变量由 scripts/run.js 启动器在 spawn 子进程时注入
  // （实测：NODE_USE_ENV_PROXY 必须在 Node 启动前生效，运行时赋值无效）。
  // 这里只做状态汇报，便于日志与 /api/status 展示。
  const resolvedProxy = resolveProxyUrl({ explicit: proxyUrl ?? undefined, disabled: proxyDisabled });
  const proxy = {
    enabled: Boolean(resolvedProxy),
    proxyUrl: resolvedProxy,
    systemCa: systemCaEnabled(),
  };

  return {
    cwd,
    envPath,
    dotenvLoaded,
    proxy,
    host: env('HOST', '127.0.0.1'),
    port: envInt('PORT', 8787, { min: 0, max: 65535 }),
    dataDir: path.resolve(cwd, env('DATA_DIR', '.data')),
    publicDir: path.resolve(cwd, 'public'),
    /** 性能对照页（旧渲染实现）目录，挂在 /bench/ 下供浏览器基准脚本访问 */
    benchDir: path.resolve(cwd, 'bench'),

    steam: {
      cc: env('STEAM_CC', 'cn'),
      lang: env('STEAM_LANG', 'schinese'),
      minIntervalMs: envInt('STEAM_MIN_INTERVAL_MS', 900, { min: 200 }),
      detailsMinIntervalMs: envInt('DETAILS_MIN_INTERVAL_MS', 450, { min: 200 }),
      searchRetries: envInt('STEAM_SEARCH_RETRIES', 5, { min: 0, max: 12 }),
      searchTimeoutMs: envInt('STEAM_SEARCH_TIMEOUT_MS', 15000, { min: 3000 }),
      sweepIntervalMs: envInt('SWEEP_INTERVAL_MS', 120_000, { min: 15_000 }),
      sweepPagesPerCycle: envInt('SWEEP_PAGES_PER_CYCLE', 8, { min: 1, max: 60 }),
      watchlistIntervalMs: envInt('WATCHLIST_INTERVAL_MS', 60_000, { min: 30_000 }),
      watchlistBatch: envInt('WATCHLIST_BATCH', 80, { min: 1, max: 400 }),
      /**
       * 永久免费的复核周期。默认 **0 = 不复核**：
       * 一旦确认某个条目是永久免费，它基本不会再变，读一次就够。
       * 设成正数会开启周期性复核，显著增加 appdetails 请求量。
       */
      f2pRecheckMs: envInt('F2P_RECHECK_MS', 0, { min: 0 }),
      /** 折扣的复核周期：折扣会到期，需要按周期确认是否还在打折 */
      discountRecheckMs: envInt('DISCOUNT_RECHECK_MS', 6 * 3600_000, { min: 60_000 }),
      /** 启动时回填评测数据的页数上限（Steam 只在候选集前段返回评测） */
      reviewBackfillPages: envInt('REVIEW_BACKFILL_PAGES', 140, { min: 0, max: 400 }),
      /** 商店精选位（免费周末等限时活动）的轮询间隔：活动变化快，5 分钟一次 */
      spotlightIntervalMs: envInt('SPOTLIGHT_INTERVAL_MS', 300_000, { min: 60_000 }),
      /** 促销索引（折扣清单，约 1.57 万条）每轮扫描页数 */
      discountsPagesPerCycle: envInt('DISCOUNTS_PAGES_PER_CYCLE', 8, { min: 1, max: 60 }),
      /** 促销索引扫描间隔 */
      discountsIntervalMs: envInt('DISCOUNTS_INTERVAL_MS', 120_000, { min: 30_000 }),
      /** 整轮扫完后多久重新扫（发现新上架的促销） */
      discountsSweepMs: envInt('DISCOUNTS_SWEEP_MS', 21_600_000, { min: 600_000 }),
      watchlistMax: envInt('WATCHLIST_MAX', 400, { min: 0, max: 5000 }),
    },

    enabled: {
      steamSpecials: env('ENABLE_STEAM_SPECIALS', true),
      steamWatchlist: env('ENABLE_STEAM_WATCHLIST', true),
      steamSpotlight: env('ENABLE_STEAM_SPOTLIGHT', true),
      steamDiscounts: env('ENABLE_STEAM_DISCOUNTS', true),
      gamerpower: env('ENABLE_GAMERPOWER', true),
    },

    gamerpower: {
      intervalMs: envInt('GAMERPOWER_INTERVAL_MS', 600_000, { min: 60_000 }),
      url: 'https://www.gamerpower.com/api/giveaways?platform=steam',
    },

    watchlistAppIds: envList('WATCHLIST_APPIDS', [])
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n > 0),

    webhookUrl: env('WEBHOOK_URL', ''),
    logLevel: env('LOG_LEVEL', 'info'),
    /**
     * HTTP 代理（加速器）配置。
     *   PROXY_URL 留空   -> 自动读取 HTTPS_PROXY / HTTP_PROXY 环境变量
     *   PROXY_URL=<url>  -> 使用指定代理
     *   PROXY_URL=none   -> 强制直连（忽略系统代理）
     */
    proxyUrl,
    proxyDisabled,
    /** .env 或环境里是否配置了代理（用于提示"配了但没生效"） */
    proxyConfigured: Boolean(proxyUrl) || Boolean(process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY),
  };
}
