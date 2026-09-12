#!/usr/bin/env node
/**
 * 启动器（launcher）。
 *
 * 为什么需要它（这是实测得到的硬约束，不是设计洁癖）：
 *   代理环境变量必须在 **Node 进程启动前** 就存在于环境中。
 *   在脚本内部（哪怕模块顶层、任何 fetch 之前）再赋值
 *   `process.env.NODE_USE_ENV_PROXY = '1'` **依然无效**：
 *
 *     shell 环境变量     -> HTTP 200 / 约 300ms   ✅
 *     运行时赋值         -> UND_ERR_CONNECT_TIMEOUT ❌
 *
 *   所以这里读 .env，算出需要的代理变量，然后 **spawn** 子进程时带上它们。
 *   子进程 stdio 设为 inherit，日志直接透传到当前终端与调用方。
 *
 * 用法：
 *   node scripts/run.js                  # 启动服务
 *   node scripts/run.js --once           # 跑一轮后退出
 *   node scripts/run.js --no-seed        # 跳过预热
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyEnvForChild, systemCaEnabled, proxyFeatureSupport, MIN_NODE_FOR_PROXY, MIN_NODE_FOR_SYSTEM_CA } from '../src/net.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 解析 .env（不覆盖已存在的真实环境变量），返回解析到的键值。 */
function readDotEnv(file = path.join(ROOT, '.env')) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去掉 BOM
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const dotenv = readDotEnv();
/**
 * 加速器代理的自动检测结果。
 *
 * 由「启动.bat」写入独立的 .env.proxy，**不碰 .env**。
 * 早期版本让批处理直接改写 .env，结果它按 `=` 切分时把含 `=` 的注释行
 * 也当成配置写回，把配置文件写坏了。写独立文件既安全也便于查看/删除。
 */
const detectedProxy = readDotEnv(path.join(ROOT, '.env.proxy'));

// 优先级：真实环境变量 > .env 的显式设置 > 启动器检测到的 .env.proxy
//
// 注意：这里必须把**空字符串**也当成"未设置"。
// 因为 .env 里通常会有 `PROXY_URL=` 这样的空占位（表示"自动检测"），
// 若只用 `??` 判断，空串会遮蔽掉 .env.proxy 里检测到的值。
const pick = (key) => {
  const candidates = [process.env[key], dotenv[key], detectedProxy[key]];
  for (const v of candidates) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
};

const explicit = (pick('PROXY_URL') ?? '').trim();
const disabled = explicit.toLowerCase() === 'none';
const proxyVars = proxyEnvForChild({
  explicit: disabled ? undefined : explicit || undefined,
  disabled,
});

// 让子进程也能读到 .env 里的其它配置（如 STEAM_CC / LOG_LEVEL）
const childEnv = { ...process.env };
for (const [k, v] of Object.entries(dotenv)) {
  if (childEnv[k] === undefined) childEnv[k] = v;
}
for (const [k, v] of Object.entries(detectedProxy)) {
  if (childEnv[k] === undefined) childEnv[k] = v;
}
Object.assign(childEnv, proxyVars);

// 组装子进程参数：默认带 --use-system-ca（加速器 MITM 证书需要系统证书 store）
const passThrough = process.argv.slice(2);
const dev = passThrough.includes('--dev');
const checkOnly = passThrough.includes('--check');
// 允许显式关闭（例如系统证书 store 本身有问题时）
const noSystemCa = passThrough.includes('--no-system-ca');
const appArgs = passThrough.filter((a) => a !== '--dev' && a !== '--no-system-ca' && a !== '--check');
const nodeArgs = [];
// 父进程自己是否已经启用了系统证书 store（例如用户写了 node --use-system-ca scripts/run.js）
const parentHasCa = systemCaEnabled();
// 当前 Node 到底支不支持这两个开关。
// ⚠️ 实测查证：--use-system-ca 是 v22.15.0 才引入、--use-env-proxy 是 v22.21.0 才引入。
//    Node 20.x 上强行注入 --use-system-ca 只会让子进程以 "bad option" 立刻退出，
//    用户看到的是莫名其妙的启动失败。所以这里先判断版本，再决定注不注入。
const support = proxyFeatureSupport();
const injectSystemCa = !noSystemCa && !parentHasCa && support.systemCa;
if (injectSystemCa) nodeArgs.push('--use-system-ca');
if (dev) nodeArgs.push('--watch');
nodeArgs.push(path.join(ROOT, 'src', 'app.js'), ...appArgs);

// --use-system-ca 会被 Node 在启动阶段消费掉：子进程里 execArgv 为空、
// argv 里也看不到它（实测）。所以无论这个选项是父进程自带的还是我们注入的，
// 都要给子进程留一个显式标记，供 systemCaEnabled() 判断。
// 只有在「确实能启用」时才打标记，否则子进程会误以为证书问题已解决。
if (!noSystemCa && support.systemCa) childEnv.STEAM_RADAR_SYSTEM_CA = '1';

if (proxyVars.HTTPS_PROXY) {
  const from = process.env.HTTPS_PROXY ? 'environment' : dotenv.PROXY_URL ? '.env' : '.env.proxy (auto-detected)';
  process.stderr.write(`[run] proxy -> ${proxyVars.HTTPS_PROXY}  (from ${from})\n`);
  if (noSystemCa) {
    process.stderr.write('[run] note: --no-system-ca given, system CA store disabled (accelerator certs will fail).\n');
  } else if (injectSystemCa) {
    process.stderr.write('[run] injected --use-system-ca (trusts the accelerator self-signed cert).\n');
  } else if (parentHasCa) {
    process.stderr.write('[run] using --use-system-ca from the current process.\n');
  }
  // 配了代理但当前 Node 根本不支持所需的开关 —— 这种情况必须说清楚，
  // 否则用户只会反复看到连接超时/证书错误，完全猜不到是版本问题。
  if (!support.ok) {
    process.stderr.write(
      `[run] WARNING: Node ${process.versions.node} is too old for this project's proxy support.\n`
      + `[run]   --use-system-ca needs Node >= ${MIN_NODE_FOR_SYSTEM_CA}, `
      + `--use-env-proxy / NODE_USE_ENV_PROXY needs Node >= ${MIN_NODE_FOR_PROXY}\n`
      + '[run]   The accelerator (MITM) proxy will fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE or time out.\n'
      + `[run]   Please upgrade to Node ${MIN_NODE_FOR_PROXY} LTS or newer (24.x recommended).\n`,
    );
  }
} else {
  process.stderr.write('[run] no proxy configured, connecting directly. Set PROXY_URL in .env if needed.\n');
}

/**
 * `--check`：只做环境自检并退出，**不启动服务**。
 *
 * 为什么需要它：早期 `npm run check` 只是把 `--check` 透传给 src/app.js，
 * 而 app 不认识这个参数，结果是"自检"命令真的把服务起来了 ——
 * 端口占用时还会报 EADDRINUSE，看起来像环境有问题，其实只是自检语义没实现。
 */
async function runCheck() {
  const { loadConfig } = await import('../src/config.js');
  const net = await import('node:net');

  // 让 loadConfig 看到 .env / .env.proxy 的值（真实环境变量优先），
  // 这样打印出来的就是服务真正会用的配置。
  for (const [k, v] of Object.entries({ ...dotenv, ...detectedProxy })) {
    if (process.env[k] === undefined || String(process.env[k]).trim() === '') process.env[k] = v;
  }
  const config = loadConfig({ cwd: ROOT });

  const out = [];
  out.push(`[check] Node.js ${process.versions.node}  (${process.execPath})`);
  out.push(
    `[check]   proxy feature support: ${support.ok ? 'OK' : 'MISSING'}`
    + `  (system-ca ${support.systemCa ? 'yes' : 'no'} / env-proxy ${support.envProxy ? 'yes' : 'no'})`,
  );
  if (!support.ok) {
    out.push(`[check]   WARNING: requires Node >= ${MIN_NODE_FOR_PROXY} for the accelerator proxy path.`);
  }
  if (proxyVars.HTTPS_PROXY) {
    const from = process.env.HTTPS_PROXY ? 'environment' : dotenv.PROXY_URL ? '.env' : '.env.proxy (auto-detected)';
    out.push(`[check] proxy: ${proxyVars.HTTPS_PROXY}  (from ${from})`);
    out.push(`[check]   --use-system-ca: ${noSystemCa ? 'DISABLED by flag' : support.systemCa ? 'enabled' : 'unsupported'}`);
  } else {
    out.push('[check] proxy: none (direct connection)');
  }
  out.push(`[check] .env: ${Object.keys(dotenv).length ? 'loaded' : 'not found (defaults will be used)'}`);
  out.push(`[check] .env.proxy: ${Object.keys(detectedProxy).length ? 'present' : 'absent'}`);
  out.push(`[check] config: HOST=${config.host} PORT=${config.port} DATA_DIR=${config.dataDir}`);
  out.push(`[check]   Steam: cc=${config.steam.cc} lang=${config.steam.lang} minInterval=${config.steam.minIntervalMs}ms`);
  out.push(`[check]   enabled: ${Object.entries(config.enabled).filter(([, v]) => v).map(([k]) => k).join(', ') || '(none)'}`);

  // 端口占用是启动失败最常见的原因之一，这里直接探一次
  const portFree = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(config.port, config.host);
  });
  out.push(`[check] port ${config.port}: ${portFree ? 'free' : 'IN USE — 关掉占用者，或在 .env 里改 PORT'}`);

  process.stdout.write(out.join('\n') + '\n');
  process.exit(portFree ? 0 : 1);
}

if (checkOnly) {
  await runCheck();
}

const child = spawn(process.execPath, nodeArgs, {
  cwd: ROOT,
  env: childEnv,
  // inherit 让日志直接透传（也避免沙箱对 piped stdio 的限制）
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
