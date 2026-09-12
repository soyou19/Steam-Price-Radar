<div align="center">

# 🎮 Steam 限免雷达

**实时聚合 Steam 限时免费 / 免费周末 / 限免激活码，SSE 主动推送到浏览器**

零第三方依赖 · 一条命令跑起来 · 数据留在自己机器上

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.21.0-339933.svg)](docs/requirements.md)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](docs/requirements.md#三零依赖是怎么做到的)
[![Tests](https://img.shields.io/badge/tests-122%20passing-brightgreen.svg)](#测试)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[快速开始](#快速开始) · [功能](#功能) · [文档](#文档) · [已知局限](#已知局限) · [常见问题](#常见问题)

</div>

---

## 这是什么

Steam **没有提供任何"限时免费"列表接口** —— 这不是没找到，而是实测确认的：
官方促销索引里只有 10%–90% 的折扣（抽样 15,000+ 条，零个 100% 折扣），
而唯一权威的 `appdetails` 接口**一次只能查 1 个 appid** 且被限流到约 1 请求/秒。

所以这个项目做的事不是"抓"，而是**配额调度**：滚动发现候选 → 按"最可能是限免"排序 →
逐个精确校验 → 变更即时推送到网页。数据存在本地，不经过任何第三方服务。

```
限时免费 0 · 免费周末 1 · 免费激活码 25 · 永久免费 37,343 · 高折扣参考 4 · 收录总数 37,388
```

> "限时免费 0" 是一个**有效信息**：它表示此刻真的没有限免，而不是页面坏了。
> 数字为 0 的类型会弱化显示，一眼可辨。

---

## 功能

**聚合与实时推送**

- 🔍 **五个数据源互补**：免费候选集、折扣清单、`appdetails` 精确校验、商店精选位、第三方聚合
- 📡 **SSE 实时推送**：新发现 / 转为免费 / 降价 / 限免结束 / 信息更新，五类事件即时到达
- 🔔 **桌面通知**：只在"刚刚限免"与新的激活码/免费周末时提醒 —— 永久免费首次收录不打扰
- 🪝 **Webhook**：可推到 Discord / Slack / 任意 JSON 接口
- 📜 **实时动态栏**：变更事件时间倒序，点击直达商店页

**筛选与浏览**

- 🏷️ **统计条可点击筛选**，覆盖全部五种类型
- ⭐ **评测数据**：Steam 评测档位 + 好评率 + 评测数，例如 `特别好评 89% (141.2万)`，支持按档位与评测数下限筛选
- 💰 **折扣 / 价格区间筛选**：按钮上直接标**真实条数**，所以不会出现"点了没结果"的空区间
- 🔎 关键词（游戏名 / AppID / 描述）、类型、来源、五种排序
- 🚫 试玩版 / Demo / 序章默认隐藏
- 🩺 **采集状态面板**：数据源健康度、请求统计、限流器当前间隔、待校验候选数

**数据可靠**

- 💾 重启不丢：条目、游标、候选队列、事件全部原子落盘
- ♻️ 不重复抓取：候选按 appid 去重，已校验的进免检期（**永久免费只读一次**）
- 🕐 按类型分周期复核：永久免费不复核 · 折扣 6 小时 · 限免/免费周末 15 分钟
- ⚠️ 数据陈旧可见：抓不到数据时页面顶部明确提示"数据可能不是最新的"并说明是哪些源在失败

**工程质量**

- 📦 **零第三方依赖** —— 只用 Node 内置模块，克隆完就能跑，没有 lockfile 漂移
- 🧪 **122 个测试**，全部不联网（HTTP 层注入假客户端）
- ⚡ 3 万条规模下 `/api/items` 14–34 ms、页面主线程滞后 6–9 ms

---

## 预览

<!--
截图：把界面截图放到 docs/images/screenshot.png，然后取消下面这行的注释。
建议 1600×900 左右，隐去个人游戏库等隐私信息。
![界面预览](docs/images/screenshot.png)
-->

界面自上而下：

| 区域 | 内容 |
| --- | --- |
| 顶部提示条 | 仅在抓取异常时出现，说明"数据可能不是最新的"及原因 |
| 统计条 | 六张可点击的类型卡片 + 最后更新时间 |
| 筛选区 | 类型 / 来源 / 排序 / 评测档位 / 评测数下限 / 关键词 |
| 区间筛选 | 选中"高折扣参考"后展开，折扣区间 + 价格区间，按钮带真实条数 |
| 卡片列表 | 每张卡片：封面、标题、类型标签、价格与折扣、评测标签、直达商店页 |
| 侧栏 | 实时动态（事件流）与采集状态面板 |

---

## 快速开始

### 前置：Node.js >= 22.21.0

到 <https://nodejs.org/> 下载 **LTS**（当前 24.x），安装时勾选 **Add to PATH**。

> **为什么不能用 Node 20？** 国内访问 Steam 需要加速器，而加速器是 MITM 代理，
> 要求 Node 支持 `--use-system-ca`（v22.15+）与 `--use-env-proxy`（v22.21+）。
> Node 20 两者都没有，配了代理也只会一直超时。详见 [环境依赖](docs/requirements.md)。

### 方式一：Windows 一键启动

```bat
git clone https://github.com/OWNER/REPO.git
cd REPO
```

然后**双击 `启动.bat`**（或 `start.bat`，两者内容相同）。它会：

```
[1/4] 找 Node.js 并校验版本
[2/4] 自动检测加速器代理 → 写入 .env.proxy（不会修改 .env）
[3/4] 检查端口占用，被占用自动往后找
[4/4] 启动服务并打开浏览器
```

参数：

```bat
启动.bat --check     只做环境自检，不启动
启动.bat --once      只抓一轮后退出
启动.bat --no-seed   跳过首次预热
```

### 方式二：手动启动（Windows / Linux / macOS）

```bash
git clone https://github.com/OWNER/REPO.git
cd REPO
cp .env.example .env       # 不需要 npm install —— 本项目零依赖
npm start
```

打开 <http://127.0.0.1:8787/>。

> ⚠️ 请用 `npm start`，不要用 `node src/app.js`。
> 实测代理环境变量**必须在 Node 进程启动前**存在，`npm start` 会经由
> `scripts/run.js` 在 `spawn` 时注入。真不需要代理时才用 `npm run start:direct`。

### 国内网络：必须配合加速器

直连 Steam 商店在国内基本不通（实测 `UND_ERR_CONNECT_TIMEOUT`）。
启动 [Watt Toolkit](https://steampp.net/) 等加速器后，**通常什么都不用配** ——
`启动.bat` 会自动读取 Windows 系统代理。也可以手动写进 `.env`：

```ini
PROXY_URL=http://127.0.0.1:26561
```

启动日志里出现下面两行就对了：

```
[run] proxy -> http://127.0.0.1:26561  (from .env.proxy (auto-detected))
[run] injected --use-system-ca (trusts the accelerator self-signed cert).
```

配了代理却连不上？见 [故障排查](docs/troubleshooting.md#连不上-steam)。

### 首次启动会有点慢，这是正常的

Steam 不给限免列表，每个候选都必须逐个确认（1 appid/请求，约 1 请求/秒）。
首轮会产生数千候选，**所以刚启动时列表里几乎全是"永久免费"游戏**，
需要跑一段时间才会消化到"原本付费"的商品上。

想让某个游戏立刻被确认，把它的 appid 填进 `.env`：

```ini
WATCHLIST_APPIDS=3059520,730
```

---

## 常用命令

```bash
npm start              # 启动服务（推荐，自动注入代理配置）
npm run once           # 只跑一轮抓取后退出（适合配合定时任务）
npm run check          # 环境自检：Node 版本、配置、代理状态（不启动服务）
npm run smoke          # 联网连通性检查（真实请求 Steam / GamerPower）
npm run check:docs     # 文档相对链接与锚点自检
npm test               # 122 个测试，不联网
npm run dev            # 带 --watch 自动重启（开发用）
npm run start:direct   # 不经启动器，直连（不需要代理时）
```

---

## 文档

| 文档 | 内容 |
| --- | --- |
| 📥 [安装指引](docs/installation.md) | 一键启动 / 手动 / Docker / systemd / 计划任务 / 更新卸载 |
| 🧩 [环境依赖](docs/requirements.md) | Node 版本矩阵与原因、零依赖说明、网络与资源占用 |
| ⚙️ [配置参考](docs/configuration.md) | 全部环境变量、按类型复核周期、推荐配置 |
| 📖 [产品说明](docs/product.md) | 功能细节、五类内容判定依据、界面说明、**已知局限** |
| 🏗️ [架构说明](docs/architecture.md) | 数据来源实测结论、候选队列分诊、性能优化、历史事故复盘 |
| 🔌 [HTTP API](docs/api.md) | REST + SSE 接口、字段说明、枚举值、客户端示例 |
| 🔧 [故障排查](docs/troubleshooting.md) | 连不上 / 没数据 / 卡顿 / 数据变少的定位方法 |

---

## 项目结构

```
src/
  app.js              应用入口：装配模块、信号处理、--once / --no-seed
  config.js           配置（内置极简 dotenv）
  http.js             限流 + 重试 HTTP 客户端（按 host 串行、自适应降速/恢复）
  parse.js            Steam 搜索页解析：价格、免费形态、评测数据
  store.js            内存仓库、变更检测、事件总线、候选队列、原子落盘
  poller.js           调度器：多源独立定时、失败隔离
  realtime.js         SSE 推送中心 + Webhook
  webServer.js        REST API + SSE + 静态资源（含目录穿越防护）
  sources/            五个数据源（catalog / discounts / details / spotlight / gamerpower）
public/               前端：原生 ESM，零依赖
test/                 122 个测试（node:test，不联网）
bench/                性能对照页与浏览器基准脚本（非产品功能）
scripts/              run.js 启动器、smoke、diagnose、storage-estimate、check-doc-links
docs/                 文档
```

---

## 已知局限

这些是**上游数据源的客观限制**，不是缺陷：

1. **发现限免有延迟。** Steam 不给限免列表，每个候选都要逐个确认（约 1 请求/秒）。
   首轮候选数千，冷启动需要时间。
2. **永久免费的条目数以万计，它们不是限免。** 别把"永久免费 37,343"读成"有 37,343 个限免"。
3. **免费周末只能从商店精选位发现**（它完全不进免费候选集），所以覆盖度取决于 Steam 当时展示什么，
   实测通常只有个位数活动。
4. **评测数据有覆盖上限。** 实测 Steam 只在候选集前 12,000 条左右返回评测数据
   （`start=12000` → 99/100，`start=20000` → 3/100），所以尾部冷门条目可能没有评测。
5. **永久免费只读一次**（`F2P_RECHECK_MS=0`）。这是刻意的配额取舍，不是遗漏。
6. **第三方来源的覆盖度不代表 Steam 全量限免。**
7. **价格与限免状态请以 Steam 商店页面为准。** 本项目是聚合与提醒工具，不是交易依据。
8. **不要直接暴露到公网** —— 服务无鉴权，`POST /api/refresh` 谁都能触发。

完整说明见 [产品说明](docs/product.md#它不做什么已知局限)。

---

## 常见问题

<details>
<summary><b>为什么需要 Node 22.21+？20 不行吗？</b></summary>

代理（加速器）支持依赖两个较新的 Node 开关：`--use-system-ca`（v22.15+）和
`--use-env-proxy` / `NODE_USE_ENV_PROXY`（v22.21+）。Node 20 两者都没有，
所以"国内 + 加速器"这条路径**不可能走通**。启动器会检测版本并给出明确告警。
详见 [环境依赖](docs/requirements.md#二node-版本要求)。
</details>

<details>
<summary><b>为什么要有 <code>scripts/run.js</code> 这个启动器？</b></summary>

因为**代理环境变量必须在 Node 进程启动前就存在**。实测在脚本内部赋值（哪怕模块顶层、
任何 `fetch` 之前）依然无效，会稳定连接超时：

```
shell:   NODE_USE_ENV_PROXY=1 + HTTPS_PROXY=...   -> 200 / ~300ms   ✅
runtime: 同样两个变量在脚本里赋值                  -> 连接超时       ❌
```

所以由启动器读 `.env`、算出代理变量，在 `spawn` 子进程时通过 env 传入。
这条约束有测试保护。
</details>

<details>
<summary><b>为什么一个依赖都不用？</b></summary>

只用 Node 内置能力：`node:http` 代替 express、自写 20 行 dotenv、内置 `fetch` 代替 axios、
`node:test` 代替 jest、原生环境变量代理代替 undici 的 `ProxyAgent`。

好处是克隆完就能跑、没有供应链风险、没有 lockfile 漂移、Node 升级不会被依赖卡住。
代价是自己处理解析、限流与目录穿越防护 —— 这些都有测试覆盖。
</details>

<details>
<summary><b>数据存在哪？长期运行会涨到多大？</b></summary>

默认 `.data/state.json` **单个文件**（原子写入，随时可备份）。

条目来自 Steam 免费候选集，实测约 **64,600** 条，所以体积有上限：
1 万条约 3.8 MB，6.46 万条约 **22.5 MB**，稳态约 22–24 MB。
内存实测 6.46 万条约 130 MB（`scripts/storage-estimate.js` 可复跑）。
</details>

<details>
<summary><b>重启后数据还在吗？会重复抓取吗？</b></summary>

都在，也不会重复抓。条目、扫描游标、候选队列、校验时间戳、事件全部原子落盘；
候选按 appid 去重（实测连续扫同一页 3 次，新增候选依次为 `100 / 0 / 0`），
已校验的 appid 在免检期内不再请求。
</details>

<details>
<summary><b>免费周末一直是 0，是坏了吗？</b></summary>

大多数时候是真的没有 —— 免费周末只能从商店精选位发现，实测通常只有个位数活动。
可以先手动刷新那个源确认：

```bash
curl -X POST "http://127.0.0.1:8787/api/refresh?source=steam-spotlight"
```

另外确认 `.env` 里没有 `ENABLE_STEAM_SPOTLIGHT=false`（关掉它就完全没有免费周末）。
</details>

<details>
<summary><b>能部署到服务器上给别人用吗？</b></summary>

可以，但**必须自己加鉴权**（服务本身没有认证）。建议放在 Nginx / Caddy 后面，
并且注意 SSE 需要关闭响应缓冲（`proxy_buffering off`），否则推送看起来会失效。
见 [故障排查](docs/troubleshooting.md#端口与外网访问)。
</details>

---

## 测试

```bash
npm test
# ℹ tests 122
# ℹ pass 122
# ℹ fail 0
```

**全部不联网**（HTTP 层用假客户端注入），所以断网也能跑通。分六个文件：

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `test/store.test.js` | 37 | 变更 diff、幂等、候选队列优先级与去重、存档全量往返、序列化缓存、分诊与免检期 |
| `test/sources.test.js` | 25 | 免费形态判定、限免结束识别、候选消化、整轮失败上报、重试策略、恶意输入 |
| `test/net.test.js` | 20 | 代理解析、Node 版本能力判断、启动器注入约束、`--check` 不启动服务、错误诊断 |
| `test/api.test.js` | 17 | 筛选/搜索语义、分页、折扣与价格区间、评测筛选、SSE、目录穿越防护 |
| `test/parse.test.js` | 13 | 价格/货币解析、100% 折扣识别、中英文评测解析、异常输入 |
| `test/frontend.test.js` | 10 | 渲染合并与限流、请求并发上限、切回页面用合并模式 |

很多测试是针对**真实踩过的坑**写的回归测试，映射关系见
[CONTRIBUTING.md](CONTRIBUTING.md#容易被改坏的约束)。

---

## 参与贡献

欢迎 PR 与 issue！请先读：

- [CONTRIBUTING.md](CONTRIBUTING.md) —— 开发约定、**容易被改坏的约束**、如何新增数据源
- [SECURITY.md](SECURITY.md) —— 安全模型与漏洞上报方式
- [CHANGELOG.md](CHANGELOG.md) —— 版本变更记录

有 Bug 或建议请用 [issue 模板](.github/ISSUE_TEMPLATE) 提交。

---

## 免责声明

- 本项目与 Valve / Steam 无任何关联，"Steam" 及相关商标归 Valve Corporation 所有。
- 抓取的是**公开可访问**的商店数据，遵循客户端限流（同域最小间隔、429 退避），
  不绕过任何认证或付费墙。
- 数据仅供参考，**请以 Steam 商店页面为准**。因过期或错误信息造成的任何损失，本项目不承担责任。
- 请在遵守 Steam 服务条款与当地法律的前提下使用。

## 许可证

[MIT](LICENSE)
