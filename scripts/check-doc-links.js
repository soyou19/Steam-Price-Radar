/**
 * 文档链接自检（人工运行）：
 *   node scripts/check-doc-links.js
 *
 * 为什么需要它：README 与 docs/ 里有大量相对链接，GitHub 上点开才发现 404 很尴尬，
 * 而这类问题没有测试会抓到（不联网、也不该为此引入链接检查依赖）。
 * 零依赖实现：扫所有 md 文件里的相对链接与锚点，检查目标文件/标题是否存在。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 收集所有需要检查的 markdown 文件。 */
function collectMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdown(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * GitHub 的标题 slug 规则（对齐 github-slugger）：小写、去掉标点、空白逐个换成 `-`。
 *
 * ⚠️ 注意空白是**逐个替换**而不是折叠成一个：`## 代理 / 加速器` 去掉 `/` 后有
 *    两个空格，所以锚点是 `#代理--加速器`（两个连字符）。折叠会得到错的锚点。
 */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** 去掉 HTML 注释：里面的链接不会被 GitHub 渲染，检查它们只会产生假报警。 */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** 取出文件里所有标题的 slug（含重复标题的编号后缀）。 */
function headingSlugs(text) {
  const slugs = new Set();
  let inFence = false;
  for (const line of stripComments(text).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    let slug = slugify(m[1]);
    let n = 0;
    while (slugs.has(n === 0 ? slug : `${slug}-${n}`)) n += 1;
    slugs.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return slugs;
}

const files = collectMarkdown(ROOT);
const cache = new Map();
const read = (file) => {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(file, 'utf8'));
  return cache.get(file);
};

const problems = [];
let checked = 0;

for (const file of files) {
  const text = stripComments(read(file));
  // [文字](目标) —— 只关心相对链接，跳过 http(s) / mailto / 纯锚点单独处理
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    checked += 1;
    const [rel, anchor] = target.split('#');
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(rel));
    const where = `${path.relative(ROOT, file)} -> ${target}`;
    // 指向仓库之外的相对路径是 GitHub 站点相对地址（例如 ../../security/advisories/new），
    // 不是文件系统路径，跳过
    if (path.relative(ROOT, resolved).startsWith('..')) continue;
    if (!fs.existsSync(resolved)) {
      problems.push(`缺少目标文件: ${where}`);
      continue;
    }
    if (anchor && resolved.endsWith('.md')) {
      const slugs = headingSlugs(read(resolved));
      if (!slugs.has(decodeURIComponent(anchor))) {
        problems.push(`锚点不存在: ${where}`);
      }
    }
  }
  // 纯锚点链接 [文字](#anchor)。
  // ⚠️ 这里用更宽松的匹配（只要求前面是 `](`）而不是完整的 `[文字](...)`：
  //    badge 写法是 `[![alt](图片URL)](锚点)`，嵌套的 `]` 会让"完整链接"正则
  //    在图片 URL 处就结束，从而**完全看不到外层锚点** —— 曾经因此漏掉一个 404 锚点。
  const seenAnchors = new Set();
  for (const m of text.matchAll(/\]\((#[^)\s]+)\)/g)) {
    const anchor = decodeURIComponent(m[1].slice(1));
    if (seenAnchors.has(anchor)) continue;
    seenAnchors.add(anchor);
    checked += 1;
    if (!headingSlugs(text).has(anchor)) {
      problems.push(`本页锚点不存在: ${path.relative(ROOT, file)} -> #${anchor}`);
    }
  }
}

process.stdout.write(`检查了 ${files.length} 个 markdown 文件、${checked} 个相对链接\n`);
if (problems.length) {
  for (const p of problems) process.stdout.write(`  ✗ ${p}\n`);
  process.exit(1);
}
process.stdout.write('  ✓ 所有相对链接与锚点均有效\n');
