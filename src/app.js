#!/usr/bin/env node
/**
 * 应用入口：装配配置、HTTP 客户端、数据仓库、数据源调度器与 Web 服务。
 *
 * 通常**不用**直接运行它 —— 请用 `npm start`（经由 scripts/run.js 启动），
 * 因为启动器需要在 **Node 启动前** 就注入代理环境变量（加速器场景必需），
 * 详见 scripts/run.js 与 src/net.js 的说明。
 *
 * 直连可用时也可以直接运行：
 *   node --use-system-ca src/app.js
 *   node --use-system-ca src/app.js --once     只跑一轮抓取后退出
 *   node --use-system-ca src/app.js --no-seed  跳过首次大规模预热
 */
import { loadConfig } from './config.js';
import { createLogger } from './util.js';
import { HttpClient } from './http.js';
import { systemCaEnabled } from './net.js';
import { Store } from './store.js';
import { Poller } from './poller.js';
import { RealtimeHub, attachWebhook } from './realtime.js';
import { createServer } from './webServer.js';
import { SOURCE } from './model.js';

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const SEED = !args.has('--no-seed');

const config = loadConfig();
const logger = createLogger(config.logLevel);





// 代理状态汇报（环境变量应由 scripts/run.js 在 Node 启动前注入）
if (config.proxy?.enabled) {
  logger.info(`网络代理已启用：${config.proxy.proxyUrl}`);
  if (!systemCaEnabled()) {
    logger.warn('未使用系统证书 store，加速器的自签证书会验证失败；请用 `npm start` 启动');
  }
} else if (config.proxyConfigured) {
  logger.warn(
    '检测到 .env 里配置了 PROXY_URL，但环境变量未生效 —— ' +
      '代理必须在 Node 启动前注入，请用 `npm start` 启动（它经由 scripts/run.js）。',
  );
} else {
  logger.info('未使用 HTTP 代理（直连）。');
}

const http = new HttpClient({
  minIntervalMs: config.steam.minIntervalMs,
  logger: logger.child('http'),
});
// appdetails 需要更慢的节奏，单独放宽最小间隔
http.setHostInterval('store.steampowered.com', config.steam.detailsMinIntervalMs);

const store = new Store({ dataDir: config.dataDir, logger: logger.child('store') });
const restored = store.load();
logger.info(
  restored.loaded
    ? `已从磁盘恢复 ${restored.items} 条记录 / ${restored.events} 条事件`
    : `未找到历史数据（${restored.reason}），将从零开始`,
);
// 条目数明显低于历史峰值 => 说明发生过数据丢失（例如存档格式变更、写入异常）。
// 这类问题以前是完全静默的，必须显式告警。
if (restored.loaded && store.peakItems > 0) {
  const current = store.items.size;
  if (current < store.peakItems * 0.9) {
    const lost = store.peakItems - current;
    logger.warn(
      `注意：当前条目 ${current} 条，低于历史峰值 ${store.peakItems} 条（少 ${lost} 条）。` +
        `可能是上次未保存完成或被外部修改，后续扫描会逐步补充。`,
    );
  }
}

// 一次性纠正历史误分类：早期把"付费无折扣"也记成了折扣，
// 会让"高折扣"里混进 0% 的条目。修复后旧记录需要纠正一次。
const reclassified = store.fixLegacyDiscountClassification();
if (reclassified > 0) {
  logger.info(`已纠正 ${reclassified} 条历史误分类（0% 折扣不再计入"高折扣"）`);
}

// 数据治理：对候选队列做一次分诊，把"查了也几乎必然是永久免费"的冷门条目
// 排除在 appdetails 校验之外（记录保留，出现更强信号会自动重新激活）。
const skipped = store.triageCandidates();
const qstats = store.candidateStats();
logger.info(
  `候选队列分诊：共 ${qstats.total} 个，需校验 ${qstats.toVerify} 个，` +
    `本次新跳过 ${skipped} 个（省下约 ${((qstats.skipped * 0.5) / 3600).toFixed(1)} 小时配额）`,
);

const hub = new RealtimeHub({ logger: logger.child('sse') });
const webhook = attachWebhook({ store, config, logger: logger.child('webhook') });
if (webhook.enabled) logger.info('Webhook 推送已启用');

// 数据变更 -> SSE 推送（事件 + 条目刷新信号）
//
// 注意：首次全量扫描会产生上千条 discovered，逐条打日志会把控制台淹没，
// 因此只有"真正值得注意"的事件才逐条 info，其余按类型累计后汇总输出。
const QUIET_EVENTS = new Set(['discovered']);
let quietCounts = null;
let quietTimer = null;

function flushQuietCounts() {
  if (!quietCounts) return;
  const parts = Object.entries(quietCounts)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `${type}=${n}`);
  if (parts.length) logger.info(`批量变更汇总: ${parts.join(' ')}`);
  quietCounts = null;
  quietTimer = null;
}

store.on('event', (event) => {
  hub.emitEvent(event);
  hub.touch(event.key);

  const notable =
    event.type === 'became_free' ||
    event.type === 'ended' ||
    event.type === 'price_drop' ||
    event.freeType === 'keep' ||
    event.freeType === 'weekend' ||
    event.freeType === 'key';

  if (notable) {
    const icon = event.type === 'ended' ? '结束' : event.type === 'became_free' ? '刚刚限免' : '关注';
    logger.info(
      `[${icon}] ${event.type} :: ${event.title}${event.discountPercent ? ` (-${event.discountPercent}%)` : ''}`,
    );
    return;
  }

  // 普通 discovered 事件：按类型计数，2 秒汇总一次
  if (QUIET_EVENTS.has(event.type)) {
    quietCounts ??= {};
    quietCounts[event.type] = (quietCounts[event.type] ?? 0) + 1;
    if (!quietTimer) {
      quietTimer = setTimeout(flushQuietCounts, 2000);
      quietTimer.unref?.();
    }
    return;
  }
  logger.debug(`${event.type} :: ${event.title}`);
});

const poller = new Poller({ http, store, config, logger: logger.child('poller') });

if (poller.size === 0) {
  logger.warn('没有任何启用的数据源，请检查 ENABLE_* 配置');
}

/** 启动前预热：一次抓取较多页，尽快让页面有内容。 */
async function seedIfNeeded() {
  const firstRun = !restored.loaded || store.items.size === 0;
  if (!SEED || !firstRun) return false;
  if (!config.enabled.steamSpecials) return false;
  const pages = ONCE ? 60 : 40;
  logger.info(`首次运行，预热候选集（${pages} 页，约 ${pages * 100} 条）...`);
  // 首次运行，预热候选集（40 页，约 4000 条）...
  const result = await poller.runSource(SOURCE.CATALOG, { pages, specialPages: 0 });
  const summary = store.summary();
  logger.info(`预热完成：有效记录 ${summary.active} 条（其中限时/100% 免费 ${summary.keepCount} 条）`);
  if (result?.ok === false) logger.warn(`预热过程中出现错误：${result.error}`);
  await store.flush();
  return true;
}

/**
 * 评价数据回填。
 *
 * 为什么需要：Steam 只在免费候选集的**前约 1.2 万条**页面上返回评测信息，
 * 而早期版本没把评价写进存档，所以历史条目的"特别好评 / 好评如潮"是空的。
 * 主扫描游标单调推进、等它绕回开头太久，因此用独立游标在启动后补扫一遍。
 */
async function backfillReviewsIfNeeded() {
  if (!SEED || !config.enabled.steamSpecials) return;
  const catalog = poller.entries.get(SOURCE.CATALOG)?.source;
  if (!catalog?.backfillReviews) return;
  const state = store.getSourceState(SOURCE.CATALOG);
  // 刚补过就跳过（默认 12 小时一次）
  const lastDone = state.reviewDoneAt ? Date.parse(state.reviewDoneAt) : 0;
  if (Date.now() - lastDone < 12 * 3600_000) return;

  const budget = config.steam.reviewBackfillPages;
  logger.info(`开始回填评测数据（最多 ${budget} 页，只补字段不干扰主扫描）…`);
  const res = await catalog.backfillReviews(budget);
  logger.info(
    `评测回填：扫描 ${res.pages} 页，更新 ${res.updated} 条` +
      `${res.done ? '（已完成一轮）' : `（断点 ${res.cursor}，下次继续）`}` +
      `${res.errors ? ` 失败 ${res.errors} 页` : ''}`,
  );
  await store.flush();
}

/** --once：跑一轮全部数据源后落盘退出。 */
async function runOnceMode() {
  await seedIfNeeded();
  logger.info('--once 模式：执行全部数据源一轮抓取...');
  const results = await poller.runAll({
    [SOURCE.CATALOG]: { pages: Math.max(4, config.steam.sweepPagesPerCycle) },
  });
  for (const [name, result] of Object.entries(results)) {
    logger.info(`  ${name}: ${result?.ok ? 'ok' : `失败 (${result?.error})`}`);
  }
  await store.flush();
  hub.close();
  const s = store.summary();
  logger.info(`完成：有效记录 ${s.active} 条 / 限时免费 ${s.keepCount} 条 / 历史事件 ${store.events.length} 条`);
  return 0;
}

/** 常驻模式。 */
async function runServerMode() {
  const web = createServer({
    store,
    poller,
    hub,
    config,
    logger: logger.child('web'),
    httpStats: () => ({ ...http.stats, limiter: Object.fromEntries(http.intervalOverrides) }),
  });

  const address = await web.listen();
  const shown = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
  const url = `http://${shown}:${address.port}/`;
  logger.info(`服务已启动：${url}`);
  logger.info(`实时推送端点：${url}api/stream`);

  // 先启动调度器，再在后台预热。
  // 早期实现是 `await seedIfNeeded()` 之后再 start()，结果是首轮预热（受 Steam 限流
  // 影响可能持续数分钟）期间所有数据源都没跑起来，页面长时间空白。
  // 现在预热放到后台执行，预热过程中其它数据源照常工作，页面随数据到达逐步填充。
  poller.start({ initialDelayMs: 3000 });
  void seedIfNeeded().catch((error) => logger.warn(`预热失败（不影响后续运行）：${error.message}`));
  // 评价回填排在预热之后，避免与主扫描争抢 Steam 配额
  void backfillReviewsIfNeeded().catch((error) => logger.warn(`评测回填失败：${error.message}`));

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在关闭...`);
    await poller.stop();
    hub.close();
    try {
      await store.flush();
      logger.info(`数据已保存到 ${store.stateFile}`);
    } catch (error) {
      logger.error(`保存失败: ${error.message}`);
    }
    await web.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return new Promise(() => {});
}

const runner = ONCE ? runOnceMode : runServerMode;
runner()
  .then((code) => {
    if (typeof code === 'number') process.exit(code);
  })
  .catch(async (error) => {
    logger.error(`启动失败: ${error?.stack ?? error}`);
    try {
      await store.flush();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
