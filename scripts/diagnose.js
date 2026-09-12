/**
 * 诊断脚本（联网）：确认免费候选集中"曾经收费"条目的判定信号是否可靠。
 *   node scripts/diagnose.js [pages]
 */
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/util.js';
import { HttpClient } from '../src/http.js';
import { parseSearchRows } from '../src/parse.js';

const config = loadConfig();
const logger = createLogger('warn');
const http = new HttpClient({ minIntervalMs: 700, logger });
const cc = config.steam.cc;
const lang = config.steam.lang;

// ---- 1) count 上限测试
console.log('=== count 上限测试 ===');
for (const count of [100, 300, 1000]) {
  const url = `https://store.steampowered.com/search/results/?query=&start=0&count=${count}&sort_by=Price_ASC&maxprice=free&infinite=1&cc=${cc}&l=${lang}`;
  try {
    const t0 = Date.now();
    const j = await http.json(url);
    const rows = (j.results_html ?? '').split('<a href=').length - 1;
    console.log(`  count=${String(count).padStart(4)} -> total=${j.total_count} rows=${rows} (${Date.now() - t0}ms)`);
  } catch (e) {
    console.log(`  count=${count} 失败: ${e.message}`);
  }
}

// ---- 2) 逐页统计免费条目的价格信号
const pages = Number.parseInt(process.argv[2] ?? '12', 10);
console.log(`\n=== 扫描 ${pages} 页，统计免费条目的原始标记 ===`);
const samples = [];
let stats = { rows: 0, freeClass: 0, withOriginal: 0, withPct: 0, attrNonZero: 0, pct100: 0 };

for (let p = 0; p < pages; p += 1) {
  const url = `https://store.steampowered.com/search/results/?query=&start=${p * 100}&count=100&sort_by=Price_ASC&maxprice=free&infinite=1&cc=${cc}&l=${lang}`;
  let j;
  try {
    j = await http.json(url);
  } catch (e) {
    console.log(`  page ${p} 失败: ${e.message}`);
    continue;
  }
  const rows = (j.results_html ?? '').split('<a href=').slice(1);
  for (const row of rows) {
    const parsed = parseSearchRows(row);
    if (!parsed) continue;
    stats.rows += 1;
    if (parsed.raw.isFreeClass) stats.freeClass += 1;
    if ((parsed.originalPrice ?? 0) > 0) stats.withOriginal += 1;
    if (parsed.discountPercent) stats.withPct += 1;
    if ((parsed.raw.finalPriceAttr ?? 0) > 0) stats.attrNonZero += 1;
    if (parsed.discountPercent === 100) stats.pct100 += 1;
    if ((parsed.originalPrice ?? 0) > 0 || parsed.discountPercent || (parsed.raw.finalPriceAttr ?? 0) > 0) {
      if (samples.length < 20) samples.push(parsed);
    }
  }
}
console.log('  统计:', JSON.stringify(stats));
console.log('\n=== 带"曾经收费"信号的样本 ===');
for (const s of samples) {
  console.log(
    `  [${s.appId}] ${s.title}\n      freeClass=${s.raw.isFreeClass} pct=${s.discountPercent} ` +
      `orig=${s.originalPriceFormatted} (${s.originalPrice}) attr=${s.raw.finalPriceAttr} final=${s.finalPriceFormatted}`,
  );
}
