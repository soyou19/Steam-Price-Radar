/**
 * 对产品页做 V8 CPU 采样，找出真正占用主线程的函数。
 *   node scripts/cpu-profile.js [观察秒数] [url]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SECONDS = Number.parseInt(process.argv[2] ?? '25', 10);
const URL_ = process.argv[3] ?? 'http://127.0.0.1:8787/';
const PORT = 9225;

const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!exe) { console.error('未找到浏览器'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpuprof-'));
const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });

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
  await cdp.send('Profiler.enable');

  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(4000);

  console.log(`开始 CPU 采样 ${SECONDS}s，期间触发抓取…`);
  await cdp.send('Profiler.start');
  fetch('http://127.0.0.1:8787/api/refresh?pages=20', { method: 'POST' }).catch(() => {});
  await sleep(SECONDS * 1000);
  const { profile } = await cdp.send('Profiler.stop');

  // 把采样点按函数聚合
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfTime = new Map();
  const total = profile.samples.length;
  for (const id of profile.samples) {
    const n = byId.get(id);
    if (!n) continue;
    const cf = n.callFrame;
    const key = `${cf.functionName || '(anonymous)'} @ ${String(cf.url).split('/').pop()}:${cf.lineNumber}`;
    selfTime.set(key, (selfTime.get(key) ?? 0) + 1);
  }
  const sorted = [...selfTime.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n=== 自身耗时 Top 20（共 ${total} 个采样，每个约 ${((SECONDS * 1000) / total).toFixed(2)}ms）===`);
  for (const [k, v] of sorted.slice(0, 20)) {
    const ms = ((v / total) * SECONDS * 1000).toFixed(0);
    console.log(`  ${String(ms).padStart(6)}ms  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
  console.log(`\n累计 Top10 占比: ${((sorted.slice(0, 10).reduce((s, x) => s + x[1], 0) / total) * 100).toFixed(1)}%`);
  ws.close();
}

main()
  .catch((e) => { console.error('失败:', e.message); process.exitCode = 1; })
  .finally(async () => {
    child.kill();
    await sleep(700);
    try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {}
  });
