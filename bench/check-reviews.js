/**
 * 验证评价显示与筛选（真实浏览器）。
 *   node scripts/check-reviews.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 9229;
const URL_ = 'http://127.0.0.1:8787/';
const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!exe) { console.error('未找到浏览器'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'));
const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1500,950', 'about:blank'],
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
const js = async (cdp, expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

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
  await sleep(7000);

  console.log('1) 卡片是否显示评测信息');
  console.log('  ', await js(cdp, `JSON.stringify({
    reviewChips: document.querySelectorAll('.chip--review').length,
    totalCards: document.querySelectorAll('.card').length,
    samples: [...document.querySelectorAll('.chip--review')].slice(0,6).map(e => e.textContent.trim()),
    colored: [...document.querySelectorAll('.chip--review')].slice(0,4).map(e => e.className),
  })`));

  console.log('\n2) 筛选项是否存在');
  console.log('  ', await js(cdp, `JSON.stringify({
    rating: !!document.getElementById('filter-rating'),
    count: !!document.getElementById('filter-review-count'),
    ratingOptions: [...document.querySelectorAll('#filter-rating option')].map(o => o.value),
  })`));

  console.log('\n3) 选"好评如潮"');
  await js(cdp, `(() => {
    const s = document.getElementById('filter-rating');
    s.value = 'overwhelming';
    s.dispatchEvent(new Event('change'));
    return 1;
  })()`);
  await sleep(1200);
  console.log('  ', await js(cdp, `JSON.stringify({
    cards: document.querySelectorAll('.card').length,
    summaries: [...new Set([...document.querySelectorAll('.chip--review')].map(e => e.textContent.trim().split(' ')[0]))],
    titles: [...document.querySelectorAll('.card-title')].slice(0,4).map(e => e.textContent.trim()),
  })`));

  console.log('\n4) 叠加"评测数 ≥ 1000"');
  await js(cdp, `(() => {
    const s = document.getElementById('filter-review-count');
    s.value = '1000';
    s.dispatchEvent(new Event('change'));
    return 1;
  })()`);
  await sleep(1200);
  console.log('  ', await js(cdp, `JSON.stringify({
    cards: document.querySelectorAll('.card').length,
    samples: [...document.querySelectorAll('.chip--review')].slice(0,4).map(e => e.textContent.trim()),
  })`));

  console.log('\n5) 清除评价筛选');
  await js(cdp, `(() => {
    const a = document.getElementById('filter-rating'); a.value='all'; a.dispatchEvent(new Event('change'));
    const b = document.getElementById('filter-review-count'); b.value='0'; b.dispatchEvent(new Event('change'));
    return 1;
  })()`);
  await sleep(1200);
  console.log('  ', await js(cdp, `JSON.stringify({ cards: document.querySelectorAll('.card').length, reviewChips: document.querySelectorAll('.chip--review').length })`));
  ws.close();
}

main()
  .catch((e) => { console.error('失败:', e.message); process.exitCode = 1; })
  .finally(async () => {
    child.kill();
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {}
  });
