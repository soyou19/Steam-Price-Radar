/**
 * 验证统计条在真实浏览器里渲染出**所有**类型（含免费周末）。
 *   node scripts/check-stats.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 9227;
const URL_ = 'http://127.0.0.1:8787/';
const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!exe) { console.error('未找到浏览器'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1400,900', 'about:blank'],
  { stdio: 'ignore' });

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
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(6000);

  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const out = [];
      for (const el of document.querySelectorAll('#stats .stat')) {
        out.push({
          label: el.querySelector('.stat-label')?.textContent ?? '?',
          num: el.querySelector('.stat-num')?.textContent ?? '?',
          clickable: el.classList.contains('stat--clickable'),
          type: el.dataset.type ?? null,
          zero: el.classList.contains('stat--zero'),
        });
      }
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  });
  const stats = JSON.parse(result.value);
  console.log('统计条渲染结果（真实浏览器）:');
  for (const s of stats) {
    console.log(`  ${s.label.padEnd(14)} ${String(s.num).padStart(7)}  ${s.clickable ? `[可点击 → ${s.type}]` : '[只读]'}${s.zero ? ' (0)' : ''}`);
  }

  const required = ['限时免费', '免费周末', '免费激活码', '永久免费', '高折扣参考', '收录总数', '最近更新'];
  const missing = required.filter((r) => !stats.some((s) => s.label.includes(r.replace('参考', '')) || s.label === r));
  console.log('');
  console.log(missing.length ? `缺少: ${missing.join(', ')}` : 'OK 所有类型都已显示');

  // 点一下"免费周末"卡片，验证筛选生效
  const click = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.querySelector('.stat--clickable[data-type="weekend"]');
      if (!btn) return 'no-button';
      btn.click();
      const sel = document.getElementById('filter-type');
      return JSON.stringify({ filterValue: sel?.value, activeStat: document.querySelector('.stat--clickable[data-type="weekend"]') !== null });
    })()`,
    returnByValue: true,
  });
  await sleep(1200);
  const after = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({ cards: document.querySelectorAll('.card').length, titles: [...document.querySelectorAll('.card-title')].slice(0,3).map(e=>e.textContent.trim()) })`,
    returnByValue: true,
  });
  console.log('');
  console.log('点击"免费周末"卡片:', click.result.value);
  console.log('筛选后:', after.result.value);
  ws.close();
}

main()
  .catch((e) => { console.error('失败:', e.message); process.exitCode = 1; })
  .finally(async () => {
    child.kill();
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {}
  });
