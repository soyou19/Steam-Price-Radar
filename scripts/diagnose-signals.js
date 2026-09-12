/**
 * 诊断：确认列表页是否真的能解析出评论数与价格信号（联网）。
 *   node scripts/diagnose-signals.js [pages]
 */
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/util.js';
import { HttpClient } from '../src/http.js';
import { parseSearchResults, parseSearchRow } from '../src/parse.js';

const config = loadConfig();
const http = new HttpClient({ minIntervalMs: 700, logger: createLogger('warn') });
const pages = Number.parseInt(process.argv[2] ?? '3', 10);

let rows = 0;
let withReviewTooltip = 0;
let withReviewCount = 0;
let withPercent = 0;
const samples = [];

for (let p = 0; p < pages; p += 1) {
  const url = `https://store.steampowered.com/search/results/?query=&start=${p * 100}&count=100&sort_by=Price_ASC&maxprice=free&infinite=1&cc=${config.steam.cc}&l=${config.steam.lang}`;
  let j;
  try {
    j = await http.json(url, { retries: 5, timeoutMs: 15000 });
  } catch (error) {
    console.log(`  第 ${p} 页抓取失败（Steam 偶发连接超时）：${error.message}`);
    continue;
  }
  const rawRows = (j.results_html ?? '').split('<a href=').slice(1);
  for (const raw of rawRows) {
    const parsed = parseSearchRow(raw);
    if (!parsed) continue;
    rows += 1;
    if (/data-tooltip-html/.test(raw)) withReviewTooltip += 1;
    if (parsed.reviewCount) withReviewCount += 1;
    if (parsed.reviewPercent) withPercent += 1;
    if (samples.length < 8 && (parsed.reviewCount || parsed.reviewPercent)) {
      samples.push({ title: parsed.title, percent: parsed.reviewPercent, count: parsed.reviewCount, summary: parsed.reviewSummary });
    }
  }
}

console.log(`扫描 ${pages} 页 / ${rows} 条`);
console.log(`  含 data-tooltip-html 属性 : ${withReviewTooltip}`);
console.log(`  解析出 reviewCount        : ${withReviewCount}`);
console.log(`  解析出 reviewPercent      : ${withPercent}`);
console.log('\n样本:');
for (const s of samples) console.log(`  ${JSON.stringify(s)}`);

// 如果解析失败，把第一条原始 tooltip 属性打出来看真实结构
if (!withReviewCount) {
  const url = `https://store.steampowered.com/search/results/?query=&start=0&count=5&sort_by=Price_ASC&maxprice=free&infinite=1&cc=${config.steam.cc}&l=${config.steam.lang}`;
  const j = await http.json(url, { retries: 4, timeoutMs: 15000 });
  const raw = (j.results_html ?? '').split('<a href=')[1] ?? '';
  const m = raw.match(/<div class="search_reviewscore[\s\S]{0,600}?<\/div>/);
  console.log('\n原始 review 区块:\n', m ? m[0] : '(未找到)');
}
