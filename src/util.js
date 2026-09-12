/**
 * 无依赖的通用工具函数。
 */

/** 读取环境变量，带默认值与类型转换。 */
export function env(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  if (typeof fallback === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof fallback === 'boolean') {
    return /^(1|true|yes|on)$/i.test(raw.trim());
  }
  return raw;
}

export function envInt(key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Math.trunc(env(key, fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function envList(key, fallback = []) {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带抖动的指数退避。
 *
 * 上限设得较大（默认 30s）是有实测依据的：
 * Steam 偶发 `UND_ERR_CONNECT_TIMEOUT`（约 10s 才失败），而**保持连接复用**时
 * 请求稳定在 ~400ms（实测 keep-alive 5/5 成功，强制新建连接 5 次里 3 次失败）。
 * 因此遇到连接类失败时，多等一会儿再重试比快速重试更容易成功。
 */
export function backoffDelay(attempt, baseMs = 600, capMs = 30000) {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.6 + Math.random() * 0.6));
}

/** HTML 实体解码（仅处理商店页会出现的常见实体）。 */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#34': '"', '#38': '&', '#160': ' ',
};

export function decodeEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#?\w+);/g, (match, code) => {
    if (Object.hasOwn(ENTITIES, code)) return ENTITIES[code];
    if (/^#\d+$/.test(code)) {
      const cp = Number(code.slice(1));
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return match;
  });
}

/** 去掉 HTML 标签，压缩空白。 */
export function stripTags(input) {
  return decodeEntities(String(input ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function clampString(value, max) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function toIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function nowIso() {
  return new Date().toISOString();
}

/** 创建带前缀的日志器。 */
export function createLogger(level = 'info') {
  const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  const threshold = levels[level] ?? 20;
  const emit = (lvl, stream) => (...args) => {
    if (levels[lvl] < threshold) return;
    const stamp = new Date().toISOString().slice(11, 19);
    stream(`[${stamp}] ${lvl.toUpperCase().padEnd(5)}`, ...args);
  };
  return {
    level,
    debug: emit('debug', console.log),
    info: emit('info', console.log),
    warn: emit('warn', console.warn),
    error: emit('error', console.error),
    child(prefix) {
      const base = createLogger(level);
      const wrap = (fn) => (...args) => fn(`(${prefix})`, ...args);
      return { ...base, debug: wrap(base.debug), info: wrap(base.info), warn: wrap(base.warn), error: wrap(base.error) };
    },
  };
}

/** 仅允许 http/https 的 URL 构造。 */
export function safeUrl(input) {
  try {
    const u = new URL(String(input));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}
