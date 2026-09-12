/**
 * 代理（加速器）配置与 TLS 信任处理。
 *
 * 背景：国内直连 Steam 商店基本不通（实测 `UND_ERR_CONNECT_TIMEOUT`，
 * 直连真实 IP:443 被阻断）。Watt Toolkit / Steam++ 这类加速器会在本机起一个
 * MITM 代理（本机实测 127.0.0.1:26561）并写入系统代理设置。
 *
 * Node 原生 fetch 的两个坑（均已实测确认）：
 *   1) 默认不读取系统代理 => 必须设置 HTTPS_PROXY **并**开启 NODE_USE_ENV_PROXY
 *   2) 默认不信任系统证书 store => 加速器是 MITM 自签证书，会报
 *      UNABLE_TO_VERIFY_LEAF_SIGNATURE，需要用 `--use-system-ca` 启动
 *
 * ⚠️ 最重要的实测结论：**代理环境变量必须在 Node 启动前就存在。**
 *    在脚本内部（哪怕是模块顶层、任何 fetch 之前）再赋值
 *    `process.env.NODE_USE_ENV_PROXY = '1'` 依然无效，会稳定连接超时：
 *
 *      shell: NODE_USE_ENV_PROXY=1 + HTTPS_PROXY=...  -> 200 / 298~507ms  ✅
 *      runtime: 同样的两个变量在脚本里赋值              -> UND_ERR_CONNECT_TIMEOUT ❌
 *
 *    因此不能用"boot 入口先设变量再动态 import"这种方案，
 *    而是由 scripts/run.js 这个启动器**在 spawn 子进程时就带上环境变量**。
 *    相关约束有测试保护（test/net.test.js）。
 */

/** 读取 .env 中的代理相关配置（不依赖 dotenv）。 */
export function resolveProxyUrl({ logger, explicit, disabled } = {}) {
  if (disabled) return null;
  if (explicit) return explicit;
  const env = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!env) return null;
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  if (noProxy && /(\*|steampowered\.com|steamcommunity\.com)/i.test(noProxy)) {
    logger?.info?.('NO_PROXY 命中 Steam，跳过代理');
    return null;
  }
  return env;
}

/**
 * 计算子进程需要的代理环境变量。
 * 供启动器（scripts/run.js）使用：它把这些变量塞进 spawn 的 env，
 * 确保子进程 Node **启动时**就能读到。
 *
 * @param {{explicit?: string|null, disabled?: boolean}} [options]
 * @returns {Record<string,string>} 需要额外设置的键值对（可能为空）
 */
export function proxyEnvForChild({ explicit, disabled } = {}) {
  const url = resolveProxyUrl({ explicit: explicit ?? undefined, disabled });
  if (!url) return {};
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    // 开启 Node 内置的环境变量代理支持（等价于 --use-env-proxy，v22.21.0 引入）
    NODE_USE_ENV_PROXY: '1',
  };
}

/** 代理路径需要的最低 Node 版本（`--use-env-proxy` / `NODE_USE_ENV_PROXY` 的引入版本）。 */
export const MIN_NODE_FOR_PROXY = '22.21.0';
/** 信任系统证书 store 需要的最低 Node 版本（`--use-system-ca` 于 v22.15.0 引入）。 */
export const MIN_NODE_FOR_SYSTEM_CA = '22.15.0';

/**
 * 当前 Node 是否支持本项目的代理（加速器）方案。
 *
 * ⚠️ 这两个开关都是**较新**才加入 Node 的，且旧版本遇到 `--use-system-ca`
 *    会直接以 "bad option" 退出 —— 用户看到的是莫名其妙的启动失败。
 *    实测查证（Node 官方文档）：
 *      --use-system-ca    added: v23.8.0, v22.15.0
 *      --use-env-proxy    added: v22.21.0
 *    Node 20.x 两者都没有，所以「国内 + 加速器」这条路径在 20.x 上不可能走通。
 *
 * @param {string} [version] 版本号，默认取当前进程；测试可注入
 * @returns {{envProxy: boolean, systemCa: boolean, ok: boolean}}
 */
export function proxyFeatureSupport(version = process.versions.node) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(version));
  if (!m) return { envProxy: false, systemCa: false, ok: false };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  // 版本依据（Node 官方文档）：
  //   --use-system-ca   added: v23.8.0, v22.15.0
  //   --use-env-proxy   added: v22.21.0（23.x 当时已 EOL，未回移）
  // 24.x 及以后两者齐全。
  const envProxy = major >= 24 || (major === 22 && minor >= 21);
  const systemCa = major >= 24 || (major === 23 && minor >= 8) || (major === 22 && minor >= 15);
  return { envProxy, systemCa, ok: envProxy && systemCa };
}

/**
 * 当前 Node 是否启用了系统证书 store。
 *
 * ⚠️ 实测结论：**不能靠 `--use-system-ca` 反查**。
 *    这个选项会被 Node 在启动阶段消费掉，之后
 *    `process.execArgv` 是空的、`process.argv` 里也看不到它：
 *
 *      node --use-system-ca app.js
 *        -> execArgv = []                       ← 已被消费
 *        -> argv     = [node, app.js, ...]      ← 不含该选项
 *
 *    因此改为依赖显式的标记环境变量（由启动器 / scripts/run.js 在
 *    spawn 子进程时设置）。标记存在即认为已启用 —— 这是我们自己设的，
 *    与真实命令行一致，不会误判。
 *
 * @returns {boolean}
 */
export function systemCaEnabled() {
  if (process.env.STEAM_RADAR_SYSTEM_CA === '1') return true;
  // 兜底：手动带 NODE_OPTIONS=--use-system-ca 启动的情况
  if (process.env.NODE_OPTIONS?.includes('use-system-ca')) return true;
  // 再兜底：直接以 `node --use-system-ca app.js` 启动时，部分 Node 版本
  // 仍会把选项留在 execArgv / argv 中
  const has = (list) => list.some((a) => String(a).includes('use-system-ca'));
  return has(process.execArgv) || has(process.argv);
}

/** 把网络错误翻译成可操作的中文提示。 */
export function explainNetworkError(code) {
  const s = String(code ?? '');
  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_/i.test(s)) {
    return `${s}（加速器自签证书未被信任：请用 npm start 启动，它带 --use-system-ca）`;
  }
  if (/CONNECT_TIMEOUT|ETIMEDOUT|ECONNREFUSED/i.test(s)) {
    return `${s}（连不上目标；若使用加速器，请确认经 npm start 启动，代理变量需在 Node 启动前生效）`;
  }
  return s;
}
