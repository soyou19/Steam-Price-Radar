/**
 * 代理（加速器）配置与错误诊断的测试。
 *
 * 背景：本机实测 Watt Toolkit 通过 127.0.0.1:26561 做 MITM 代理，
 * Node 原生 fetch 既不读系统代理也不信任系统证书 store，因此需要
 * NODE_USE_ENV_PROXY + HTTPS_PROXY + --use-system-ca 三者配合。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainNetworkError, resolveProxyUrl, systemCaEnabled, proxyFeatureSupport } from '../src/net.js';

/** 在临时环境变量下运行，结束后恢复。 */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('resolveProxyUrl 优先使用显式配置', () => {
  withEnv({ HTTPS_PROXY: undefined, HTTP_PROXY: undefined, https_proxy: undefined, http_proxy: undefined }, () => {
    assert.equal(resolveProxyUrl({ explicit: 'http://127.0.0.1:26561' }), 'http://127.0.0.1:26561');
  });
});

test('resolveProxyUrl 读取 HTTPS_PROXY 环境变量', () => {
  withEnv({ HTTPS_PROXY: 'http://127.0.0.1:9999', HTTP_PROXY: undefined }, () => {
    assert.equal(resolveProxyUrl({}), 'http://127.0.0.1:9999');
  });
});

test('resolveProxyUrl disabled 时强制直连（即使有环境变量）', () => {
  withEnv({ HTTPS_PROXY: 'http://127.0.0.1:9999' }, () => {
    assert.equal(resolveProxyUrl({ disabled: true }), null);
    assert.equal(resolveProxyUrl({ disabled: true, explicit: 'http://127.0.0.1:1' }), null);
  });
});

test('resolveProxyUrl 无任何代理配置时返回 null', () => {
  withEnv(
    { HTTPS_PROXY: undefined, HTTP_PROXY: undefined, https_proxy: undefined, http_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined },
    () => assert.equal(resolveProxyUrl({}), null),
  );
});

test('resolveProxyUrl 尊重 NO_PROXY 中的 Steam 域名', () => {
  withEnv({ HTTPS_PROXY: 'http://127.0.0.1:9999', NO_PROXY: 'steampowered.com,steamcommunity.com' }, () => {
    assert.equal(resolveProxyUrl({}), null, 'NO_PROXY 命中 Steam 时应跳过代理');
  });
  withEnv({ HTTPS_PROXY: 'http://127.0.0.1:9999', NO_PROXY: 'example.com' }, () => {
    assert.equal(resolveProxyUrl({}), 'http://127.0.0.1:9999', 'NO_PROXY 不相关时仍应使用代理');
  });
});

test('explainNetworkError 把证书错误翻译成可操作提示', () => {
  const msg = explainNetworkError('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  assert.match(msg, /use-system-ca/, '应提示使用系统证书 store');
  assert.match(msg, /加速器/);
});

test('explainNetworkError 把连接超时翻译成可操作提示', () => {
  const msg = explainNetworkError('network failure (UND_ERR_CONNECT_TIMEOUT)');
  assert.match(msg, /npm start/, '应提示用启动器启动（代理需在 Node 启动前生效）');
  assert.match(msg, /加速器/);
});

test('explainNetworkError 透传未知错误', () => {
  assert.equal(explainNetworkError('HTTP 500'), 'HTTP 500');
  assert.equal(explainNetworkError(undefined), '');
});

test('systemCaEnabled 反映系统证书 store 的启用状态', () => {
  // 回归：--use-system-ca 会被 Node 在启动阶段消费掉，
  // 子进程里 execArgv 为空、argv 也看不到它，所以不能靠它反查。
  // 现在依赖显式标记环境变量。
  const saved = process.env.STEAM_RADAR_SYSTEM_CA;
  const savedNodeOptions = process.env.NODE_OPTIONS;
  try {
    delete process.env.STEAM_RADAR_SYSTEM_CA;
    delete process.env.NODE_OPTIONS;
    assert.equal(systemCaEnabled(), false, '没有标记时不应认为已启用');

    process.env.STEAM_RADAR_SYSTEM_CA = '1';
    assert.equal(systemCaEnabled(), true, '有标记时应认为已启用');

    delete process.env.STEAM_RADAR_SYSTEM_CA;
    process.env.NODE_OPTIONS = '--use-system-ca';
    assert.equal(systemCaEnabled(), true, 'NODE_OPTIONS 里带该选项时也算启用');
  } finally {
    if (saved === undefined) delete process.env.STEAM_RADAR_SYSTEM_CA;
    else process.env.STEAM_RADAR_SYSTEM_CA = saved;
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
  }
});

test('run.js 必须给子进程传系统证书标记（回归：--use-system-ca 无法被子进程反查）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'run.js'), 'utf8');

  assert.match(src, /STEAM_RADAR_SYSTEM_CA/, 'run.js 应设置显式标记');
  // 只要真正启用了系统证书 store，就必须设置标记。
  // 注意还要带上 support.systemCa：旧 Node 上注入 --use-system-ca 会直接启动失败，
  // 此时不能打标记，否则子进程会误以为证书问题已经解决。
  assert.match(
    src,
    /if \(!noSystemCa && support\.systemCa\) childEnv\.STEAM_RADAR_SYSTEM_CA = '1'/,
    '能启用时才设置标记（无论该选项来自父进程还是自己注入）',
  );
});

test('proxyFeatureSupport：只有 Node >= 22.21 才同时支持两个代理开关', () => {
  // 版本依据（Node 官方文档）：
  //   --use-system-ca  added: v23.8.0, v22.15.0
  //   --use-env-proxy  added: v22.21.0
  const cases = [
    ['20.20.2', false, false],
    ['21.7.3', false, false],
    ['22.14.0', false, false],   // 有 system-ca 之前的版本：两个都没有
    ['22.15.0', false, true],    // 刚拿到 system-ca，还没有 env-proxy
    ['22.20.0', false, true],
    ['22.21.0', true, true],     // 从这一版开始代理方案才完整可用
    ['22.23.2', true, true],
    ['23.7.0', false, false],    // 23.x 非 LTS 且已 EOL；23.8 之前连 system-ca 都没有
    ['23.8.0', false, true],     // 23.x 拿到了 system-ca，但 env-proxy 未回移到 23.x
    ['24.0.0', true, true],
    ['24.19.0', true, true],
  ];
  for (const [version, envProxy, systemCa] of cases) {
    const got = proxyFeatureSupport(version);
    assert.equal(got.envProxy, envProxy, `Node ${version} 的 env-proxy 支持判断错误`);
    assert.equal(got.systemCa, systemCa, `Node ${version} 的 system-ca 支持判断错误`);
    assert.equal(got.ok, envProxy && systemCa, `Node ${version} 的 ok 汇总错误`);
  }
  // 版本号带 v 前缀 / 无法解析时都必须安全降级，不能抛错
  assert.equal(proxyFeatureSupport('v24.19.0').ok, true);
  assert.equal(proxyFeatureSupport('').ok, false);
  assert.equal(proxyFeatureSupport(undefined).ok, proxyFeatureSupport(process.versions.node).ok);
});

test('run.js 不得在旧 Node 上盲目注入 --use-system-ca（否则子进程 bad option 直接退出）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'run.js'), 'utf8');

  assert.match(src, /proxyFeatureSupport\(\)/, '启动器应先判断当前 Node 是否支持这些开关');
  assert.match(
    src,
    /const injectSystemCa = !noSystemCa && !parentHasCa && support\.systemCa/,
    '注入系统证书开关前必须检查版本支持',
  );
  assert.match(src, /if \(!support\.ok\)/, '版本不支持且配了代理时应给出明确告警');
});

test('package.json 的 engines 必须覆盖代理所需的 Node 版本（回归：曾写 20.10，代理根本不可用）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
  const m = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines.node);
  assert.ok(m, 'engines.node 应为 >=x.y.z 形式');
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const ok = major >= 24 || (major === 22 && minor >= 21);
  assert.ok(ok, `engines.node = ${pkg.engines.node} 不足以支持 --use-env-proxy（需 >= 22.21.0）`);
});

test('npm run check 只做自检，绝不启动服务（回归：曾把服务真的起起来）', async () => {
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const root = path.resolve(import.meta.dirname, '..');

  // PORT=0 让端口探测落在任意空闲端口上，结果与运行环境无关；
  // 真实环境变量优先于 .env，所以仓库里有没有 .env 都不影响。
  const run = spawnSync(process.execPath, ['scripts/run.js', '--check'], {
    cwd: root,
    env: { ...process.env, PORT: '0' },
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(run.status, 0, `自检应成功退出，实际 status=${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /\[check\] Node\.js /, '应打印 Node 版本');
  assert.match(run.stdout, /proxy feature support/, '应打印代理能力判断');
  assert.match(run.stdout, /port 0: free/, '端口空闲时应报告 free');

  // 关键回归点：不能真的把服务起起来
  assert.doesNotMatch(run.stdout, /已从磁盘恢复|采集状态|listening/i, '自检不得启动服务');
  assert.doesNotMatch(run.stderr, /EADDRINUSE/, '自检不得尝试监听端口');
});

test('src/app.js 是应用入口且提示经由启动器', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..');
  assert.ok(fs.existsSync(path.join(root, 'src', 'app.js')), '应用入口应为 src/app.js');
  // 已经不再需要 boot 入口：代理由启动器在进程外注入
  assert.ok(!fs.existsSync(path.join(root, 'src', 'server.js')), '不应再保留 src/server.js（避免两套入口）');
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  assert.match(app, /proxyConfigured/, '应提示"配了代理但未生效"的情况');
});

test('启动器必须在 spawn 子进程时注入代理变量（回归：运行时赋值实测无效）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'run.js'), 'utf8');

  // 实测硬约束：代理变量必须在 Node 启动前存在，脚本内赋值会稳定超时，
  // 因此必须由启动器在 spawn 的 env 里带上。
  assert.match(src, /proxyEnvForChild/, '启动器应通过 proxyEnvForChild 计算代理变量');
  assert.match(src, /env:\s*childEnv/, 'spawn 时应传入带代理变量的 env');
  assert.match(src, /spawn\(/, '应使用 spawn 启动子进程');

  // 顺序：先算代理变量，再 spawn
  const calcIdx = src.indexOf('proxyEnvForChild(');
  const spawnIdx = src.indexOf('spawn(process.execPath');
  assert.ok(calcIdx >= 0 && spawnIdx >= 0 && calcIdx < spawnIdx, '必须先计算代理变量再 spawn');
});

test('proxyEnvForChild 生成的变量齐全（缺一不可）', async () => {
  const { proxyEnvForChild } = await import('../src/net.js');
  const vars = proxyEnvForChild({ explicit: 'http://127.0.0.1:26561' });
  assert.equal(vars.HTTPS_PROXY, 'http://127.0.0.1:26561');
  assert.equal(vars.HTTP_PROXY, 'http://127.0.0.1:26561');
  // NODE_USE_ENV_PROXY 缺少时 Node 不会读取代理（实测）
  assert.equal(vars.NODE_USE_ENV_PROXY, '1', '必须开启 NODE_USE_ENV_PROXY');
  assert.deepEqual(proxyEnvForChild({ disabled: true }), {}, '禁用时应返回空');
  assert.deepEqual(proxyEnvForChild({}), {}, '无配置时应返回空');
});

test('package.json 的 start/dev/once 都经由启动器', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
  for (const script of ['start', 'dev', 'once']) {
    assert.match(pkg.scripts[script], /scripts\/run\.js/, `${script} 应经由 scripts/run.js`);
  }
  // 直连模式仍应带 --use-system-ca（有代理时也需要）
  assert.match(pkg.scripts['start:direct'], /--use-system-ca/);
});

test('loadDotEnvFile 无参调用必须可用（回归：曾静默失效导致 .env 不生效）', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { loadDotEnvFile } = await import('../src/config.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
  // 带 BOM，模拟 PowerShell 写出的文件（Windows 上很常见）
  fs.writeFileSync(path.join(dir, '.env'), `\uFEFFPROXY_URL=http://127.0.0.1:12345\nSTEAM_CC=us\n`, 'utf8');

  const savedCwd = process.cwd();
  const savedProxy = process.env.PROXY_URL;
  const savedCc = process.env.STEAM_CC;
  delete process.env.PROXY_URL;
  delete process.env.STEAM_CC;
  try {
    process.chdir(dir);
    // 关键：不传参数 —— boot 入口就是这么调用的
    assert.equal(loadDotEnvFile(), true, '无参调用应默认为 ./.env 并成功读取');
    assert.equal(process.env.PROXY_URL, 'http://127.0.0.1:12345', '应能读到 PROXY_URL（且正确处理 BOM）');
    assert.equal(process.env.STEAM_CC, 'us');
  } finally {
    process.chdir(savedCwd);
    if (savedProxy === undefined) delete process.env.PROXY_URL;
    else process.env.PROXY_URL = savedProxy;
    if (savedCc === undefined) delete process.env.STEAM_CC;
    else process.env.STEAM_CC = savedCc;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('启动器顺序：必须先读 .env 再算代理变量（回归：反了会让 .env 里的 PROXY_URL 失效）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'run.js'), 'utf8');
  const readIdx = src.indexOf('readDotEnv()');
  const calcIdx = src.indexOf('proxyEnvForChild(');
  assert.ok(readIdx >= 0, '启动器应先读取 .env');
  assert.ok(calcIdx >= 0, '启动器应计算代理变量');
  assert.ok(
    readIdx < calcIdx,
    '必须先读 .env 再算代理，否则 .env 里的 PROXY_URL 不会被用上',
  );
});
