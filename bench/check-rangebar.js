/**
 * 验证"高折扣参考"的折扣/价格区间筛选条（真实浏览器）。
 *   node scripts/check-rangebar.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 9228;
const URL_ = 'http://127.0.0.1:8787/';
const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!exe) { console.error('未找到浏览器'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rangebar-'));
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

const evalJs = async (cdp, expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

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

  console.log('1) 默认（全部类型）区间条应隐藏');
  console.log('  ', await evalJs(cdp, `JSON.stringify({ hidden: document.getElementById('range-bar').hidden })`));

  console.log('\n2) 点统计卡"高折扣参考"');
  await evalJs(cdp, `document.querySelector('.stat--clickable[data-type="discount"]').click(); 1`);
  await sleep(2500);
  const bar = await evalJs(cdp, `JSON.stringify({
    hidden: document.getElementById('range-bar').hidden,
    discountChips: [...document.querySelectorAll('#discount-chips .chip-btn')].map(b => b.textContent.trim()),
    priceChips: [...document.querySelectorAll('#price-chips .chip-btn')].map(b => b.textContent.trim()),
    summary: document.getElementById('range-summary')?.textContent,
    cards: document.querySelectorAll('.card').length,
  })`);
  console.log('  ', bar);

  console.log('\n3) 点一个折扣区间（80–90%）');
  await evalJs(cdp, `(() => {
    const b = [...document.querySelectorAll('#discount-chips .chip-btn')].find(x => x.dataset.min === '80');
    if (b) b.click(); return !!b;
  })()`);
  await sleep(1500);
  console.log('  ', await evalJs(cdp, `JSON.stringify({
    activeChips: [...document.querySelectorAll('.chip-btn.is-active')].map(b => b.textContent.trim()),
    summary: document.getElementById('range-summary')?.textContent,
    cards: document.querySelectorAll('.card').length,
    firstTitles: [...document.querySelectorAll('.card-title')].slice(0,3).map(e=>e.textContent.trim()),
  })`));

  console.log('\n4) 再点一个价格区间（¥0–10）叠加');
  await evalJs(cdp, `(() => {
    const b = [...document.querySelectorAll('#price-chips .chip-btn')].find(x => x.dataset.min === '0');
    if (b) b.click(); return !!b;
  })()`);
  await sleep(1500);
  console.log('  ', await evalJs(cdp, `JSON.stringify({
    activeChips: [...document.querySelectorAll('.chip-btn.is-active')].map(b => b.textContent.trim()),
    summary: document.getElementById('range-summary')?.textContent,
    cards: document.querySelectorAll('.card').length,
    firstTitles: [...document.querySelectorAll('.card-title')].slice(0,3).map(e=>e.textContent.trim()),
  })`));

  console.log('\n5) 清除区间');
  await evalJs(cdp, `document.getElementById('range-reset').click(); 1`);
  await sleep(1200);
  console.log('  ', await evalJs(cdp, `JSON.stringify({
    activeChips: document.querySelectorAll('.chip-btn.is-active').length,
    summary: document.getElementById('range-summary')?.textContent,
    cards: document.querySelectorAll('.card').length,
  })`));
  ws.close();
}

main()
  .catch((e) => { console.error('失败:', e.message); process.exitCode = 1; })
  .finally(async () => {
    child.kill();
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {}
  });
