/**
 * 验证前端"每次打开加载全部已存数据"的行为（真实浏览器 + CDP）。
 *   node scripts/check-frontend-load.js [等待秒数]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SECONDS = Number.parseInt(process.argv[2] ?? '25', 10);
const PORT = 9226;
const URL_ = 'http://127.0.0.1:8787/';

const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!exe) { console.error('未找到浏览器'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fecheck-'));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
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

const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1400,900', 'about:blank'],
  { stdio: 'ignore' });

async function main() {
  const d = Date.now() + 20000;
  while (Date.now() < d) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(300); }
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 主线程滞后探针
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(2500);
  await cdp.send('Runtime.evaluate', { expression: `
    window.__lag = [];
    (function tick(){ const t=performance.now(); setTimeout(()=>{window.__lag.push(performance.now()-t); tick();},0); })();
    'ok'` });

  console.log(`观察 ${SECONDS}s …`);
  for (let i = 0; i < SECONDS; i += 5) {
    await sleep(5000);
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        loaded: window.__perfHooks?.state.items.size ?? -1,
        serverTotal: window.__perfHooks?.state.total ?? -1,
        cards: document.querySelectorAll('.card').length,
        statTotal: document.getElementById('stat-total')?.textContent,
        lagMax: Math.round(Math.max(0, ...window.__lag.slice(-300))),
        statusExtra: document.getElementById('status-body')?.textContent?.includes('需花配额校验') ?? false,
      })`, returnByValue: true,
    });
    console.log(`  [${i + 5}s] ${result.value}`);
  }
  ws.close();
}

main()
  .catch((e) => { console.error('失败:', e.message); process.exitCode = 1; })
  .finally(async () => {
    child.kill();
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {}
  });
