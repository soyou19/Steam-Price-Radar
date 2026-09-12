/**
 * 真实浏览器主线程响应性测试（CDP，无第三方依赖）。
 *
 * 复现用户报告的问题场景：服务正在抓取时打开页面，观察
 *   - 主线程阻塞（事件循环滞后）
 *   - DOM 节点数、JS 堆大小
 *   - 长任务（long task）数量
 *
 * 用法：node scripts/browser-perf.js [观察秒数]
 * 前置：服务已在 http://127.0.0.1:8787 运行；本机有 Chrome/Edge。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SECONDS = Number.parseInt(process.argv[2] ?? '35', 10);
const PORT = 9222;
// 第二个参数可指定被测 URL（默认产品页；传 /bench/baseline.html 可对比旧实现）
const URL_ = process.argv[3] ?? 'http://127.0.0.1:8787/';

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('未找到 Chrome/Edge，跳过浏览器测试');
  process.exit(2);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-prof-'));
console.log(`浏览器: ${path.basename(exe)}`);
const child = spawn(
  exe,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1400,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error('DevTools 未就绪');
}

/** 极简 CDP 客户端（WebSocket + JSON 消息） */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function main() {
  await waitForDevTools();

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log(`打开 ${URL_} …`);
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(4000); // 等首屏加载 + 建连

  // 注入主线程阻塞探针：每 100ms 排一个 0ms 定时器，测量实际延迟
  await cdp.send('Runtime.evaluate', {
    expression: `
      window.__lag = [];
      window.__longtasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__longtasks.push(Math.round(e.duration));
        }).observe({ entryTypes: ['longtask'] });
      } catch (e) {}
      (function tick() {
        const t = performance.now();
        setTimeout(() => { window.__lag.push(performance.now() - t); tick(); }, 0);
      })();
      'probe-installed'
    `,
  });

  console.log(`观察 ${SECONDS}s（期间触发一次抓取，复现"运行中"的状态）…`);
  // 触发服务端抓取，让页面处于持续接收 SSE 的状态
  fetch('http://127.0.0.1:8787/api/refresh?pages=10', { method: 'POST' }).catch(() => {});

  for (let i = 0; i < SECONDS; i += 5) {
    await sleep(5000);
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        lagN: window.__lag.length,
        lagMax: Math.round(Math.max(0, ...window.__lag.slice(-200))),
        lagP95: (() => { const a=[...window.__lag.slice(-200)].sort((x,y)=>x-y); return Math.round(a[Math.floor(a.length*0.95)] ?? 0); })(),
        longtasks: window.__longtasks.length,
        ltMax: Math.round(Math.max(0, ...window.__longtasks)),
        cards: document.querySelectorAll('.card').length,
        feedItems: document.querySelectorAll('.feed-item').length,
        loadMore: !!document.getElementById('load-more'),
        renders: document.getElementById('render-count')?.textContent ?? null,
        conn: document.getElementById('conn-text')?.textContent,
        statTotal: document.getElementById('stat-total')?.textContent,
      })`,
      returnByValue: true,
    });
    console.log(`  [${i + 5}s] ${result.value}`);
  }

  // 最终统计
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const a = [...window.__lag].sort((x,y)=>x-y);
      const p = (q) => Math.round(a[Math.floor(a.length*q)] ?? 0);
      return JSON.stringify({
        samples: a.length,
        lag_p50: p(0.5), lag_p95: p(0.95), lag_p99: p(0.99), lag_max: Math.round(a.at(-1) ?? 0),
        longtaskCount: window.__longtasks.length,
        longtaskMax: Math.round(Math.max(0, ...window.__longtasks)),
        longtaskTotalMs: window.__longtasks.reduce((s,x)=>s+x,0),
        cards: document.querySelectorAll('.card').length,
        domNodes: document.getElementsByTagName('*').length,
      });
    })()`,
    returnByValue: true,
  });
  console.log('\n=== 主线程阻塞统计（真实浏览器） ===');
  console.log(' ', result.value);

  await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify(performance.memory ? {jsHeapMB: Math.round(performance.memory.usedJSHeapSize/1048576)} : {})`,
    returnByValue: true,
  }).then((r) => console.log(' ', r.result.value));

  ws.close();
}

main()
  .catch((e) => {
    console.error('测试失败:', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    child.kill();
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true });
  });
