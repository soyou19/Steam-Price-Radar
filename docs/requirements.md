# 环境依赖

本文说明运行 Steam 限免雷达需要什么、不需要什么，以及每条要求的**实测依据**。

> 想直接跑起来？看 [安装指引](installation.md)。本文只讲"为什么需要这些"。

---

## 一、硬性要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| **Node.js** | **>= 22.21.0** | 见下文「为什么必须 22.21」 |
| 操作系统 | Windows 10/11、Linux、macOS | 一键启动器仅 Windows；其它平台用 `npm start` |
| 磁盘 | 约 30 MB | 代码 < 1 MB，其余是 `.data/state.json` |
| 内存 | 空闲时 < 100 MB，满载约 130–190 MB | 6.4 万条条目时的实测 heap |
| 网络 | 能访问 `store.steampowered.com`、`www.gamerpower.com` | 国内通常需要加速器，见下 |
| 第三方运行时依赖 | **无（0 个）** | 见下文「零依赖」 |

### 不需要的东西

- ❌ 不需要 `npm install`：项目**没有任何运行时依赖**，仓库里也没有 lockfile。
- ❌ 不需要数据库：数据存在 `.data/state.json` 单个文件里。
- ❌ 不需要编译器 / Python / Visual Studio：没有原生模块。
- ❌ 不需要构建步骤：前端是原生 ESM，浏览器直接加载。
- ❌ 不需要 Docker（想用也可以，见 [安装指引](installation.md#方式三docker可选)）。

---

## 二、Node 版本要求

这是本项目最容易踩、也最容易被忽略的一条。**它不是为了用新语法，而是因为代理（加速器）支持依赖两个很新的 Node 开关。**

Steam 商店在国内通常直连不通（实测 `UND_ERR_CONNECT_TIMEOUT`），必须走 Watt Toolkit / Steam++ 之类的加速器。这类加速器在本机起一个 **MITM 代理**，于是 Node 侧需要两件事：

| 需要的能力 | 对应的 Node 开关 | 引入版本（Node 官方文档） |
| --- | --- | --- |
| 读取 `HTTPS_PROXY` 等环境变量走代理 | `--use-env-proxy` / `NODE_USE_ENV_PROXY=1` | **v22.21.0** |
| 信任系统证书 store（加速器是自签证书） | `--use-system-ca` | **v22.15.0**、v23.8.0 |

两者取较晚的：**v22.21.0**。

### Node 20.x 会怎样

Node 20.x（含最后的 20.20.2）**这两个开关一个都没有**：

- `NODE_USE_ENV_PROXY=1` 会被静默忽略 → 请求根本没走到加速器 → 稳定超时；
- `--use-system-ca` 是**未知选项** → `node --use-system-ca` 直接以 `bad option` 退出。

也就是说，"国内 + 加速器"这条路径在 20.x 上**不可能走通**，而且失败信息毫无指向性。

因此本项目做了三层防护：

1. `package.json` 里声明 `engines.node: ">=22.21.0"`；
2. 启动器 `scripts/run.js` 会先判断版本，**旧版本上不再盲目注入** `--use-system-ca`，
   并打印明确的告警（提示升级到 Node 22.21+）；
3. `启动.bat` / `start.bat` 在入口处就拒绝 `Node < 22.21`，直接告诉用户要装哪个版本。

判断逻辑在 `src/net.js` 的 `proxyFeatureSupport()`，有单元测试覆盖各版本分支。

### 版本支持矩阵

| Node | 内置 fetch | `--use-system-ca` | `NODE_USE_ENV_PROXY` | 本项目可用性 |
| --- | --- | --- | --- | --- |
| 20.x | ✅ | ❌ | ❌ | **不支持**（代理路径不可用） |
| 21.x | ✅ | ❌ | ❌ | 不支持 |
| 22.0 – 22.14 | ✅ | ❌ | ❌ | 不支持 |
| 22.15 – 22.20 | ✅ | ✅ | ❌ | 直连可用；**加速器不可用** |
| **22.21+** | ✅ | ✅ | ✅ | **支持（最低要求）** |
| 23.x | ✅ | 23.8+ | ❌ | 不支持（非 LTS 且已 EOL） |
| **24.x LTS** | ✅ | ✅ | ✅ | **推荐**（本项目开发环境 v24.19.0） |
| 25.x / 26.x | ✅ | ✅ | ✅ | 预期可用，未做 CI 覆盖 |

CI 在 `22.x` 与 `24.x` 两个版本上跑全部测试与启动冒烟（见 `.github/workflows/ci.yml`）。

---

## 三、零依赖是怎么做到的

项目**刻意**不使用任何第三方包，只用 Node 内置能力：

| 常规做法 | 本项目做法 |
| --- | --- |
| `express` / `koa` | `node:http` 手写路由（`src/webServer.js`） |
| `dotenv` | 自写 20 行解析器（`src/config.js` 的 `loadDotEnvFile`） |
| `axios` / `node-fetch` | 内置 `fetch` + 自写限流/重试客户端（`src/http.js`） |
| `cheerio` / `jsdom` | 针对性正则解析（`src/parse.js`） |
| `ws` | 内置 `WebSocket`（仅性能脚本用，走 CDP） |
| `jest` / `vitest` | `node:test` + `node:assert` |
| `undici` 的 `ProxyAgent` | Node 原生环境变量代理（`NODE_USE_ENV_PROXY`） |

**代价与收益**：

- 收益：`git clone` 完就能跑，没有供应链风险，没有 lockfile 漂移，Node 升级不会因为依赖而卡住，
  镜像体积就是源码体积。
- 代价：需要自己处理解析、限流、目录穿越防护这类"框架本来替你做的事"。
  这些都是**有测试保护**的，见 [CONTRIBUTING.md](../CONTRIBUTING.md) 的「容易被改坏的约束」。

> 之所以不用 `undici` 的 `ProxyAgent`：实测在 Node 24 上 `import 'undici'` 失败，
> 而 Node 自己的环境变量代理已经够用，没必要为此引入依赖。

---

## 四、网络要求

### 出站目标

| 域名 | 用途 | 必需 |
| --- | --- | --- |
| `store.steampowered.com` | 免费候选集、促销索引、`appdetails`、商店精选位、**评测数据** | ✅ |
| `www.gamerpower.com` | 第三方限免聚合（激活码/站外领取） | 可选，可用 `ENABLE_GAMERPOWER=false` 关闭 |

### 国内网络：加速器

直连不通是**环境问题，不是程序缺陷**。若使用 Watt Toolkit 等加速器：

```ini
# .env
PROXY_URL=http://127.0.0.1:26561     # 加速器设置里能看到这个本地地址
```

或者留空 —— `启动.bat` 会自动读 Windows 系统代理并写入 `.env.proxy`（**不会改 `.env`**）。

> ⚠️ 实测注意：加速器代理**本身可能不稳定**。同一条命令反复执行会在
> `200` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `ECONNRESET` / `UND_ERR_CONNECT_TIMEOUT`
> 之间摆动。遇到大面积失败先重载加速器，再看 `/api/status` 的失败计数。

### Steam 侧的限流

Steam 会返回 **429**。客户端默认同域最小间隔 900 ms（`STEAM_MIN_INTERVAL_MS`），
并会自适应降速（×1.25，上限 2000 ms）与恢复。**不要把间隔调得很低**，否则会被长时间限流。

---

## 五、资源占用

### 磁盘

数据全部落在 `DATA_DIR`（默认 `.data/`）：

| 条目数 | `state.json` 大小 | 字节/条 |
| --- | --- | --- |
| 1,000 | 0.73 MB | 765 |
| 10,000 | 3.80 MB | 398 |
| 20,000 | 7.22 MB | 378 |
| 40,000 | 14.05 MB | 368 |
| 64,600（整份免费候选集） | 22.5 MB | 365 |
| 80,000（含富余） | 27.7 MB | 363 |

**长期上限是可推算的**：条目来自 Steam 免费候选集，实测约 **64,600** 条，
所以稳态约 **22–24 MB**，不会无限增长。（`scripts/storage-estimate.js` 可复跑。）

### 内存

| 条目数 | 进程 `heapUsed` |
| --- | --- |
| 10,000 | 30 MB |
| 20,000 | 49 MB |
| 40,000 | 97 MB |
| 64,600 | ~130 MB |
| 80,000 | 187 MB |

### 网络流量

稳态下约每分钟几次请求（`appdetails` 校验 + 分页扫描），一天量级在几十 MB。
首次启动会预热扫描，流量会明显高一些。

### 权限

程序只写两个位置：

- `DATA_DIR`（默认 `.data/`）—— 存档；
- 项目根目录的 `.env.proxy` —— 仅由 `启动.bat` 写入的代理检测结果。

不写注册表、不写系统目录、不装服务、不开监听以外的端口（默认只监听 `127.0.0.1`）。

---

## 六、可选组件

| 组件 | 用途 | 必需 |
| --- | --- | --- |
| Watt Toolkit / Steam++ 等加速器 | 国内访问 Steam | 国内必需 |
| Chrome / Edge | `bench/` 下的真实浏览器性能脚本（走 CDP） | 仅跑性能测试时需要 |
| 反向代理（Nginx / Caddy） | 对外提供服务时加 TLS 与访问控制 | 仅部署时需要 |

> ⚠️ 服务默认只监听 `127.0.0.1`，**不要**直接暴露到公网：它没有鉴权，
> `POST /api/refresh` 任何人都能触发抓取。需要外网访问请自行加反向代理与鉴权。
