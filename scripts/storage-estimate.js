/**
 * 存储体量测算：存档大小、内存占用随条目数/候选数的增长曲线，
 * 并据此推算"跑满整份免费候选集"后的上限。
 *
 *   node scripts/storage-estimate.js
 */
import { Store } from '../src/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-est-'));
const store = new Store({ dataDir: dir });

/** 造一条接近真实的免费条目 */
function makeItem(i) {
  const appId = 100000 + i;
  return {
    source: 'steam-catalog',
    sourceId: String(appId),
    appId,
    title: `Example Game ${i} - Some Longish Title`,
    url: `https://store.steampowered.com/app/${appId}/`,
    image: `https://shared.cdn.queniuqe.com/store_item_assets/steam/apps/${appId}/abcdef0123456789/capsule_231x87_schinese.jpg?t=1788998864`,
    freeType: i % 500 === 0 ? 'keep' : 'f2p',
    currency: 'CNY',
    originalPrice: i % 500 === 0 ? 6800 : null,
    originalPriceFormatted: i % 500 === 0 ? '¥ 68.00' : null,
    finalPrice: 0,
    finalPriceFormatted: '免费',
    discountPercent: i % 500 === 0 ? 100 : 0,
    reviewCount: i % 3 === 0 ? 12000 + i : null,
    // 每 10 条中 1 条已校验（贴近实际比例）
    lastVerifiedAt: i % 10 === 0 ? new Date().toISOString() : null,
    isFree: true,
    platforms: ['windows', 'linux'],
    releaseDate: 'Aug 21, 2012',
  };
}

const points = [1000, 5000, 10000, 20000, 40000, 64600, 80000];
let created = 0;
console.log('条目数      存档大小    字节/条    heapUsed');
console.log('--------------------------------------------------');
for (const target of points) {
  for (let i = created; i < target; i += 1) store.upsert(makeItem(i));
  created = target;
  // 候选队列持续消化：保留约 60% 未校验的
  for (let i = 0; i < target; i += 1) {
    if (i % 10 !== 0) store.enqueueCandidate(100000 + i, { reviews: 0, hint: 0, special: i % 7 === 0 });
  }
  await store.flush();
  const bytes = fs.statSync(path.join(dir, 'state.json')).size;
  const heap = process.memoryUsage().heapUsed / 1048576;
  console.log(
    `${String(target).padStart(6)}   ${(bytes / 1048576).toFixed(2).padStart(8)} MB  ` +
      `${String(Math.round(bytes / target)).padStart(7)}   ${heap.toFixed(0).padStart(5)} MB` +
      `   (候选 ${store.candidates.size.toLocaleString()})`,
  );
}

const finalBytes = fs.statSync(path.join(dir, 'state.json')).size;
const n = store.items.size;
console.log('');
console.log(`稳态：约 ${(finalBytes / 1048576).toFixed(1)} MB / ${n.toLocaleString()} 条`);

// 序列化耗时（同步阻塞事件循环的部分）
const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
const t0 = Date.now();
JSON.stringify(JSON.parse(raw));
console.log(`同步 stringify 耗时：约 ${Date.now() - t0} ms（每 60 秒最多一次）`);

fs.rmSync(dir, { recursive: true, force: true });
