/**
 * 实时数据源连通性检查（联网，不属于 npm test）。
 *   node scripts/smoke.js
 *
 * 会真实请求 Steam 与 GamerPower，打印解析摘要与关键判定结果。
 */
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/util.js';
import { HttpClient } from '../src/http.js';
import { Store } from '../src/store.js';
import { SteamCatalogSource } from '../src/sources/steamCatalog.js';
import { SteamDetailsSource } from '../src/sources/steamDetails.js';
import { GamerPowerSource } from '../src/sources/gamerpower.js';
import { FREE_TYPE } from '../src/model.js';

const config = loadConfig();
const logger = createLogger('info');
const http = new HttpClient({ minIntervalMs: 700, logger: logger.child('http') });
const store = new Store({ dataDir: '.data-smoke', logger: logger.child('store') });

const events = [];
store.on('event', (e) => events.push(e));

console.log('=== 1) 免费候选集 + 促销索引扫描 ===');
const catalog = new SteamCatalogSource({ http, store, config, logger: logger.child('catalog') });
const cRes = await catalog.runOnce({ pages: 3, specialPages: 3 });
console.log('  ', JSON.stringify(cRes));
console.log('   已知促销 appid:', store.seenSpecials.size, '| 候选队列:', store.candidates.size);
const specialCandidates = [...store.candidates.keys()].filter((id) => store.seenSpecials.has(id));
console.log('   既是促销商品又在免费列表中的 appid:', specialCandidates.length, specialCandidates.slice(0, 10));

console.log('\n=== 2) GamerPower 限免聚合 ===');
const gp = new GamerPowerSource({ http, store, config, logger: logger.child('gp') });
try {
  const gRes = await gp.runOnce();
  console.log('  count=%d changes=%d ended=%d', gRes.count, gRes.changes, gRes.ended);
} catch (e) {
  console.log('  失败:', e.message);
}

console.log('\n=== 3) appdetails 精确校验（首批 12 个高优先级候选）===');
const details = new SteamDetailsSource({ http, store, config, logger: logger.child('details') });
const picked = details.pickWatchlist(12);
console.log('   选中:', picked.join(', '));
for (const appId of picked) {
  try {
    const r = await details.verify(appId);
    if (!r.ok) {
      console.log(`   ${appId}: 无数据`);
      continue;
    }
    const item = store.get(`steam-details:${appId}`);
    const flag = r.freeType === FREE_TYPE.KEEP ? ' ★限时免费' : r.isFree ? ' 免费' : ' 付费';
    console.log(
      `   ${String(appId).padStart(8)} ${flag.padEnd(12)} ${r.title}` +
        ` | 原价=${item?.originalPriceFormatted ?? '-'} 现价=${item?.finalPriceFormatted ?? (r.isFree ? '免费' : '-')}` +
        ` | wasPaid=${item?.wasPaid}`,
    );
  } catch (e) {
    console.log(`   ${appId}: 校验失败 ${e.message}`);
  }
}

console.log('\n=== 4) 分类分布 ===');
const byType = {};
for (const i of store.active()) byType[i.freeType] = (byType[i.freeType] ?? 0) + 1;
console.log('  ', byType);

const keeps = store.active().filter((i) => i.freeType === FREE_TYPE.KEEP);
console.log(`\n=== 5) 判定为限时免费(KEEP)的条目：${keeps.length} 条 ===`);
for (const k of keeps.slice(0, 20)) {
  console.log(`   [${k.appId}] ${k.title} | 原价 ${k.originalPriceFormatted ?? '-'} | -${k.discountPercent}%`);
}

console.log('\n=== 6) 事件流 ===');
const counts = {};
for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
console.log('  ', counts);
console.log('\n=== 7) 落盘 ===');
await store.flush();
const { statSync } = await import('node:fs');
console.log(`   state.json ${statSync(store.stateFile).size} bytes`);
console.log('   汇总:', JSON.stringify(store.summary()));
