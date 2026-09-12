# 配置参考

配置全部通过**环境变量**或 `.env` 文件提供。项目内置了一个极简 `.env` 解析器
（`src/config.js` 的 `loadDotEnvFile`），不依赖 `dotenv`。

**优先级：真实环境变量 > `.env` > `.env.proxy`**（`.env.proxy` 只由 `启动.bat` 写入）。

```bash
cp .env.example .env
```

> `.env` 已被 `.gitignore` 忽略，**不要**把它提交上去。

---

## 目录

- [服务](#服务)
- [代理 / 加速器](#代理--加速器)
- [商店区域与语言](#商店区域与语言)
- [请求节奏与限流](#请求节奏与限流)
- [轮询间隔](#轮询间隔)
- [数据治理（复核周期）](#数据治理复核周期)
- [行为开关](#行为开关)
- [关注清单](#关注清单)
- [推送](#推送)
- [存储与日志](#存储与日志)
- [推荐配置](#推荐配置)

---

## 服务

| 变量 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `HOST` | `127.0.0.1` | — | 监听地址。**默认只监听本机**，公网暴露前请加反向代理与鉴权 |
| `PORT` | `8787` | 0–65535 | 监听端口。被占用时 `启动.bat` 会自动往后找（最多 20 个） |
| `DATA_DIR` | `.data` | — | 数据落盘目录，相对路径按工作目录解析 |

## 代理 / 加速器

国内必看。直连 Steam 商店通常不通，需要加速器；而 Node 原生 `fetch`
**既不读系统代理，也不信任系统证书 store**，必须显式配置。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PROXY_URL` | 空 | 留空 = 自动读取 `HTTPS_PROXY` / `HTTP_PROXY`；填 `none` = **强制直连** |
| `HTTPS_PROXY` / `HTTP_PROXY` | 空 | 标准代理环境变量。`PROXY_URL` 留空时生效 |
| `NO_PROXY` | 空 | 命中 `*` / `steampowered.com` / `steamcommunity.com` 时跳过代理 |
| `STEAM_RADAR_SYSTEM_CA` | 空 | **内部标记**，由 `scripts/run.js` 设置；不要手动配 |

```ini
# 例：Watt Toolkit 的本地代理
PROXY_URL=http://127.0.0.1:26561
```

⚠️ 走代理必须用 `npm start`（它带 `--use-system-ca`）启动，且要求 **Node >= 22.21.0**。
详见 [环境依赖](requirements.md#二node-版本要求) 与 [故障排查](troubleshooting.md#连不上-steam)。

## 商店区域与语言

影响**币种**与**标题/评测文案语言**。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `STEAM_CC` | `cn` | 商店区域（country code）。`cn` = 人民币价格 |
| `STEAM_LANG` | `schinese` | 商店语言。解析器同时支持中英文评测文案 |

> 改语言不会丢数据，但已存的标题不会自动重新抓取；想让旧条目换语言，
> 删掉 `.data/state.json` 后重启（会重新建立索引）。

## 请求节奏与限流

Steam 会限流（实测触发 429 后需降到约 1000 ms/请求才恢复）。**不要把间隔调得很低。**

| 变量 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `STEAM_MIN_INTERVAL_MS` | `900` | ≥200 | 同一 Steam 域名的**最小请求间隔** |
| `DETAILS_MIN_INTERVAL_MS` | `450` | ≥200 | `appdetails` 校验的最小间隔（该接口一次只能查 1 个 appid） |
| `STEAM_SEARCH_RETRIES` | `5` | 0–12 | 搜索页重试次数。实测 Steam 偶发连接超时约 10 s 才失败，多试几次比丢页划算 |
| `STEAM_SEARCH_TIMEOUT_MS` | `15000` | ≥3000 | 单次搜索请求超时 |

客户端会在遇到 429 时**温和降速**（×1.25，上限 2000 ms），并在连续成功后**逐步恢复**，
而不是一路飙升到 7.5 s。当前限流间隔可在页面"采集状态"面板看到。

## 轮询间隔

| 变量 | 默认 | 范围 | 数据源 | 说明 |
| --- | --- | --- | --- | --- |
| `SWEEP_INTERVAL_MS` | `120000` | ≥15000 | `steam-catalog` | 免费候选集两轮扫描之间的等待 |
| `SWEEP_PAGES_PER_CYCLE` | `8` | 1–60 | `steam-catalog` | 每轮抓几页（每页 100 条） |
| `DISCOUNTS_INTERVAL_MS` | `120000` | ≥30000 | `steam-discounts` | 折扣清单两轮之间的等待 |
| `DISCOUNTS_PAGES_PER_CYCLE` | `8` | 1–60 | `steam-discounts` | 每轮抓几页（全量约 1.57 万条） |
| `DISCOUNTS_SWEEP_MS` | `21600000` | ≥600000 | `steam-discounts` | 整轮扫完后多久重扫（发现新促销）。默认 6 小时 |
| `WATCHLIST_INTERVAL_MS` | `60000` | ≥30000 | `steam-details` | 校验轮询间隔。**这是发现限免/确认结束的响应速度上限** |
| `WATCHLIST_BATCH` | `80` | 1–400 | `steam-details` | 每轮校验多少个 appid（450 ms/次，80 条约 36 秒） |
| `SPOTLIGHT_INTERVAL_MS` | `300000` | ≥60000 | `steam-spotlight` | 商店精选位轮询。**免费周末只能从这里发现**，所以跑得比较勤 |
| `GAMERPOWER_INTERVAL_MS` | `600000` | ≥60000 | `gamerpower` | 第三方聚合源轮询 |

### 想更快发现限免怎么办

按性价比排序：

1. **`WATCHLIST_APPIDS` 填你关心的 appid** —— 最有效。它会被高频精确校验，
   一变免费立刻推送，不必等候选队列排到它。
2. 调大 `WATCHLIST_BATCH`（比如 200）—— 候选队列消化更快，但每分钟请求量成比例上升。
3. 调小 `WATCHLIST_INTERVAL_MS`（最低 30000）—— 响应更快，风险是被限流。

## 数据治理（复核周期）

不同类型的内容变化速度差几个数量级，用同一个周期复核要么浪费配额、要么漏变化。
所以按类型分周期：

| 变量 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `F2P_RECHECK_MS` | `0`（**不复核**） | ≥0 | 永久免费读一次就够，基本不会再变。设成正数会开启周期复核，请求量显著上升 |
| `DISCOUNT_RECHECK_MS` | `21600000`（6 小时） | ≥60000 | 折扣会到期，需要定期确认是否还在打折 |
| `REVIEW_BACKFILL_PAGES` | `140` | 0–400 | 启动时回填评测数据的页数上限。**实测 Steam 只在候选集前段返回评测**（`start=12000` 有 99/100，`start=20000` 只剩 3/100），所以只扫前 14,000 条 |
| `WATCHLIST_MAX` | `400` | 0–5000 | 疑似限免的 appid 自动加入高频关注清单的数量上限（0 = 关闭） |

限免 / 免费周末的复核周期固定为 **15 分钟**（写在 `src/store.js` 的 `isRecentlyVerified()` 里，
因为它们的时效性最强，不适合做成可调项）。

## 行为开关

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ENABLE_STEAM_SPECIALS` | `true` | 免费候选集扫描 |
| `ENABLE_STEAM_WATCHLIST` | `true` | `appdetails` 精确校验 |
| `ENABLE_STEAM_SPOTLIGHT` | `true` | 商店精选位。**关掉就完全没有免费周末** |
| `ENABLE_STEAM_DISCOUNTS` | `true` | 折扣清单（"高折扣参考"） |
| `ENABLE_GAMERPOWER` | `true` | 第三方聚合源 |

> 关掉某个源后，已有数据仍会展示，只是不再更新。页面"采集状态"面板会显示各源的启用情况。

## 关注清单

```ini
# 逗号分隔的 appid
WATCHLIST_APPIDS=730,570,413150
```

这些 appid 会以**最高优先级**被 `appdetails` 精确校验，一旦变为免费立刻推送，
不必等候选队列排到它们。这是应对"已知某游戏即将限免"最直接的手段。

也可以在页面上直接搜 AppID 确认它是否已被收录。

## 推送

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WEBHOOK_URL` | 空 | 新发现事件 POST 到这里。留空 = 关闭 |

收到的是标准 JSON POST，可直接对接 Discord / Slack 的 webhook，
或自己的接收端。可用 `/api/events` 查看本地事件历史来对照。

## 存储与日志

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATA_DIR` | `.data` | 存档目录。只有 `state.json` 一个文件，随时可整体备份 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`。`debug` 会打印每个数据源的详细抓取日志 |

---

## 推荐配置

### 国内 + 加速器（最常见）

```ini
PROXY_URL=http://127.0.0.1:26561
STEAM_CC=cn
STEAM_LANG=schinese
WATCHLIST_APPIDS=730,570            # 换成你真正关心的游戏
```

启动用 `启动.bat` 或 `npm start`（**不要** `node src/app.js`）。

### 只想定时抓取 + Webhook

```ini
ENABLE_STEAM_SPECIALS=false
ENABLE_STEAM_SPOTLIGHT=false
ENABLE_STEAM_DISCOUNTS=false
WEBHOOK_URL=https://discord.com/api/webhooks/...
```

```bash
*/10 * * * * cd /srv/steam-free-radar && node scripts/run.js --once
```

### 降低资源占用

```ini
SWEEP_PAGES_PER_CYCLE=2
DISCOUNTS_PAGES_PER_CYCLE=2
WATCHLIST_BATCH=40
REVIEW_BACKFILL_PAGES=0      # 不要评测数据
ENABLE_GAMERPOWER=false
```

### 排查问题

```ini
LOG_LEVEL=debug
STEAM_SEARCH_RETRIES=8
STEAM_SEARCH_TIMEOUT_MS=30000
```

配合 `npm run smoke`（联网连通性检查）与 `npm run check`（环境自检）使用。
