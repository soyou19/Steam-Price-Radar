/**
 * 公平的性能对照：用**自然负载**（真实 SSE 推送 + 真实抓取）分别测量产品页与旧实现页。
 *
 * 与 compare-perf.js 的区别：这里不强行注入额外的 renderGrid() 调用，
 * 完全依赖页面自身的实时推送路径，因此两边承受的是同一种负载。
 *
 * 用法：node scripts/ab-perf.js [每页观察秒数]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SECONDS = Number.parseInt(process.argv[2] ?? '30', 10);
const PORT = 9224;

const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!exe) {
  console.error('未找到浏览器');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profiles = [];

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const PROBE = `
  window.__lag = []; window.__longtasks = []; window.__ltDetail = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__longtasks.push(Math.round(e.duration));
        window.__ltDetail.push({
          start: Math.round(e.startTime),
          dur: Math.round(e.duration),
          attr: (e.attribution ?? []).map(a => a.name + ':' + (a.containerType ?? '')).join(','),
        });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.duration > 50) window.__ltDetail.push({ type: e.entryType, dur: Math.round(e.duration), name: e.name });
      }
    }).observe({ entryTypes: ['event', 'long-animation-frame'] });
  } catch (e) {}
  (function tick(){ const t = performance.now(); setTimeout(()=>{ window.__lag.push(performance.now()-t); tick(); }, 0); })();
  'ok'
`;

const STATS = `(() => {
  const a = [...window.__lag].sort((x,y)=>x-y);
  const p = (q) => Math.round(a[Math.floor(a.length*q)] ?? 0);
  return JSON.stringify({
    nodes: document.getElementsByTagName('*').length,
    cards: document.querySelectorAll('.card').length,
    renders: document.getElementById('render-count')?.textContent ?? null,
    lag_p50: p(0.5), lag_p95: p(0.95), lag_p99: p(0.99), lag_max: Math.round(a.at(-1) ?? 0),
    longtasks: window.__longtasks.length,
    longtaskMax: Math.round(Math.max(0, ...window.__longtasks)),
    longtaskTotal: window.__longtasks.reduce((s,x)=>s+x,0),
  });
})()`;

async function measurePage(cdp, url, label) {
  await cdp.send('Page.navigate', { url });
  await sleep(4000); // 首屏
  await cdp.send('Runtime.evaluate', { expression: 'window.__lag=[];window.__longtasks=[]' });
  await cdp.send('Runtime.evaluate', { expression: PROBE });

  // 自然负载：触发一次真实抓取。两个页面都通过各自的 SSE item 处理器
  // 接收同一批 key 并各自渲染 —— 负载完全一致，差别只在渲染实现。
  fetch('http://127.0.0.1:8787/api/refresh?pages=20', { method: 'POST' }).catch(() => {});
  await sleep(SECONDS * 1000);

  const { result } = await cdp.send('Runtime.evaluate', { expression: STATS, returnByValue: true });
  const data = JSON.parse(result.value);
  console.log(`\n### ${label}`);
  console.log(`  ${JSON.stringify(data)}`);

  // 长任务归因：区分"浏览器渲染"与"服务端响应等待"
  const { result: detail } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify(window.__ltDetail.slice(-25))`,
    returnByValue: true,
  });
  console.log(`  长任务样本: ${detail.value}`);
  return data;
}

async function main() {
  const deadline0 = Date.now() + 20000;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'abperf-'));
  profiles.push(profile);
  const child = spawn(
    exe,
    ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
     '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'],
    { stdio: 'ignore' },
  );
  try {
    while (Date.now() < deadline0) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* retry */ }
      await sleep(300);
    }
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log(`自然负载对照：每页观察 ${SECONDS}s，期间各触发一次真实抓取`);
    const legacy = await measurePage(cdp, 'http://127.0.0.1:8787/bench/baseline.html', '旧实现（全量渲染 + 每次重建）');
    await sleep(1500);
    const fixed = await measurePage(cdp, 'http://127.0.0.1:8787/', '修复后（分页 + 渲染合并 + 限流队列）');

    console.log('\n=== 对比结论（自然负载） ===');
    const rows = [
      ['DOM 节点', legacy.nodes, fixed.nodes],
      ['渲染卡片数', legacy.cards, fixed.cards],
      ['长任务数量', legacy.longtasks, fixed.longtasks],
      ['长任务总耗时ms', legacy.longtaskTotal, fixed.longtaskTotal],
      ['单次最长阻塞ms', legacy.longtaskMax, fixed.longtaskMax],
      ['主线程滞后p95ms', legacy.lag_p95, fixed.lag_p95],
      ['主线程滞后p99ms', legacy.lag_p99, fixed.lag_p99],
    ];
    console.log(`  ${''.padEnd(18)}${String('旧实现').padStart(10)}${String('修复后').padStart(12)}`);
    for (const [k, a, b] of rows) console.log(`  ${k.padEnd(16)}${String(a).padStart(10)}${String(b).padStart(12)}`);
    ws.close();
  } finally {
    child.kill();
    await sleep(800);
  }
}

main()
  .catch((e) => { console.error('失败:', e.message); process.exitCode = 1; })
  .finally(async () => {
    for (const p of profiles) {
      try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* 忽略清理失败 */ }
    }
  });
