# 故障排查

先跑这两条，多数问题一眼就能定位：

```bash
npm run check      # 环境自检：Node 版本、配置、代理状态（不启动服务）
npm run smoke      # 联网连通性：真实请求 Steam / GamerPower 并打印解析摘要
```

服务起来之后，最有用的是：

```bash
curl http://127.0.0.1:8787/api/status
```

看 `freshness.stale`、`freshness.failingSources`、`sources[].stats`、`http.ok/failed`。

---

## 目录

- [启动就失败](#启动就失败)
- [连不上 Steam](#连不上-steam)
- [页面没有数据 / 几乎全是永久免费](#页面没有数据--几乎全是永久免费)
- [免费周末一直是 0](#免费周末一直是-0)
- ["高折扣参考"数字很少或一直是 0](#高折扣参考数字很少或一直是-0)
- [评测数据缺失](#评测数据缺失)
- [页面卡顿 / 无响应](#页面卡顿--无响应)
- [数据变少了 / 重启后条目数下降](#数据变少了--重启后条目数下降)
- [切走再切回页面会重新加载](#切走再切回页面会重新加载)
- [端口与外网访问](#端口与外网访问)
- [怎么收集诊断信息](#怎么收集诊断信息)

---

## 启动就失败

### `'Node.js not found'`

启动器按这个顺序找 Node：`PATH` → `%ProgramFiles%\nodejs` → `C:\Program Files (x86)\nodejs`
→ `%LOCALAPPDATA%\Programs\nodejs` → `%APPDATA%\nvm`。

- 确认装的是 **官方安装包** 且勾选了 **Add to PATH**；
- 新装的 Node 需要**重开一个 cmd 窗口**（PATH 变更不会进已有窗口）。

### `'Node.js too old'` / `WARNING: Node ... is too old for this project's proxy support`

项目要求 **Node >= 22.21.0**。这不是"用新语法"的洁癖：

- `--use-system-ca` 是 v22.15.0 / v23.8.0 才引入的；
- `--use-env-proxy`（等价于 `NODE_USE_ENV_PROXY=1`）是 v22.21.0 才引入的。

Node 20.x 两者都没有，**加速器路径不可能走通**。升级到 Node 24 LTS 即可。

详见 [环境依赖](requirements.md#二node-版本要求)。

### `bad option: --use-system-ca`

同上：Node 版本太旧。

> 现在启动器会先判断版本、不再盲目注入这个开关，所以你看到的应该是
> `WARNING: ... too old` 而不是 `bad option`。如果仍然看到 `bad option`，
> 说明你在别处（例如 `NODE_OPTIONS`）显式带了它 —— 清掉环境变量再试。

### `service exited with code ...` / 端口被占用

启动器会自动往后找 20 个端口。若 20 个都被占用：

```ini
# .env
PORT=9100
```

或者关掉占用端口的程序：

```bat
netstat -ano -p tcp | findstr :8787
tasklist /FI "PID eq <上面看到的PID>"
```

### `npm start` 报 `EBADENGINE`

`npm` 在 Node 版本低于 `engines.node` 时会警告甚至拒装。升级 Node。

---

## 连不上 Steam

这是**最常见**的问题，而且几乎总是环境问题，不是程序缺陷。

### 症状对照表

| 报错 / 现象 | 原因 | 处理 |
| --- | --- | --- |
| `UND_ERR_CONNECT_TIMEOUT`（约 10 s 才失败） | 没走代理，直连被阻断 | 配 `PROXY_URL`，用 `npm start` 启动 |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | 走了代理但没信任加速器的自签证书 | 用 `npm start`（带 `--use-system-ca`）；确认 Node >= 22.21 |
| `ECONNRESET` / 间歇性大量失败 | 代理本身不稳定 | 重载加速器；看 `http.failed` 计数 |
| HTTP `429` | 抓太快被限流 | 调大 `STEAM_MIN_INTERVAL_MS`（别低于 900）；客户端会自动降速恢复 |

### 一步一步来

**1. 确认代理被识别到了。** 启动日志里应该有：

```
[run] proxy -> http://127.0.0.1:26561  (from .env.proxy (auto-detected))
[run] injected --use-system-ca (trusts the accelerator self-signed cert).
```

如果是 `[run] no proxy configured, connecting directly.`，说明没读到配置。三种填法任选：

- 什么都不做，让 `启动.bat` 自动读 Windows 系统代理写入 `.env.proxy`；
- 手动写进 `.env`：`PROXY_URL=http://127.0.0.1:26561`；
- 设置真实环境变量 `HTTPS_PROXY`。

优先级：**真实环境变量 > `.env` > `.env.proxy`**。

**2. 确认加速器真的在跑。** 加速器的本地端口一般在它的设置里能看到。
用 `curl` 直接验证（排除 Node 的因素）：

```bash
curl -x http://127.0.0.1:26561 -sS -o /dev/null -w '%{http_code} %{time_total}s\n' \
  https://store.steampowered.com/api/appdetails?appids=730
```

`200` 说明代理本身没问题；那就回到 Node 侧看是不是 `--use-system-ca` 没生效。

**3. 确认 Node 版本够。** `node -v` 必须 >= `22.21.0`。

**4. 确认不是用 `node src/app.js` 直接启的。**
实测代理环境变量必须在 **Node 进程启动前**存在，脚本内赋值无效：

```
shell:   NODE_USE_ENV_PROXY=1 + HTTPS_PROXY=...   -> 200 / ~300ms   ✅
runtime: 同样两个变量在脚本里赋值                  -> 连接超时       ❌
```

所以必须走 `npm start`（内部 `spawn` 时注入）。

### 关于"加速器本身不稳定"

实测 Watt Toolkit 的本地代理会在
`200` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `ECONNRESET` / `UND_ERR_CONNECT_TIMEOUT`
之间摆动 —— 甚至出现过**服务端 0/33 成功、而同时手动请求 8/8 成功**的情况。

遇到大面积失败：

1. 重载 / 重启加速器；
2. 看 `/api/status` 的 `sources[].stats.consecutiveFailures` 是否在恢复；
3. 页面顶部会出现"数据可能不是最新的"提示条，它会告诉你哪些源在失败。

### 完全不需要代理的情况

如果你的网络能直连 Steam（例如系统级 VPN），可以强制直连：

```ini
PROXY_URL=none
```

或直接 `npm run start:direct`。

---

## 页面没有数据 / 几乎全是永久免费

**这不一定是 bug。** Steam 不提供限免列表，每个候选都必须用 `appdetails` 逐个确认，
而该接口**一次只能查 1 个 appid**，且被限流到约 1 请求/秒。

所以：

- 首轮扫描会产生数千个候选；
- **刚启动时列表里几乎全是永久免费游戏**（6.4 万条免费候选里绝大多数是 F2P 和试玩版）；
- 需要跑一段时间，候选队列才会消化到"原本付费"的商品上。

### 想立刻确认某个游戏

把它的 appid 填进 `.env`：

```ini
WATCHLIST_APPIDS=3059520,730
```

它会以**最高优先级**被精确校验，一变免费立刻推送，不必排队。

### 看进度

页面"采集状态"面板，或：

```bash
curl -s http://127.0.0.1:8787/api/status | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('candidates:',JSON.stringify(j.sources.find(x=>x.name==='steam-catalog')?.lastResult))})"
```

会看到类似：

```
候选队列分诊：共 40979 个，需校验 9890 个，本次新跳过 31089 个（省下约 4.3 小时配额）
```

### 加速消化

```ini
WATCHLIST_BATCH=200          # 每轮多校验一些（默认 80）
WATCHLIST_INTERVAL_MS=30000  # 校验更频繁（默认 60000）
```

代价是每分钟请求量成比例上升，注意别触发限流。

---

## 免费周末一直是 0

**先确认这不是真的没有。** 免费周末只能从商店精选位发现，实测通常只有个位数活动，
很多时候确实就是 0。

确认方法：

```bash
# 手动刷新一次精选位源
curl -X POST "http://127.0.0.1:8787/api/refresh?source=steam-spotlight"
```

然后看 `/api/status` 里 `steam-spotlight` 的 `stats.ok` 是否在增长。

如果 `ENABLE_STEAM_SPOTLIGHT=false`，把它改回 `true` —— 关掉这个源就**完全没有免费周末**。

> 顺便解释一个反直觉的点：免费周末**不会**出现在 `maxprice=free` 候选集里
> （实测 F1® 25 完全不在那 6.4 万条里），所以它必须单独走一条路。
> 详见 [架构说明](architecture.md#免费周末的判定)。

---

## "高折扣参考"数字很少或一直是 0

`discount` 只统计 `discount_percent > 0` 的条目。两个可能：

1. **折扣清单还没扫完。** 全量约 1.57 万条，按每轮 8 页（每页 100）计算需要若干轮。
   看 `/api/status` 里 `steam-discounts` 的 `lastResult.cursor`。
2. **`ENABLE_STEAM_DISCOUNTS=false`。** 改回 `true`。

> 早期版本把"付费且无折扣"也归到 `discount`，导致列表里一堆 `-0%`、数字虚高。
> 现在这类条目是 `paid`，**永远不会返回给前端**。如果你看到 `-0%`，那是历史数据，
> 启动时会由 `fixLegacyDiscountClassification()` 自动纠正。

---

## 评测数据缺失

**这是上游限制，不是 bug。** 实测 Steam 只在免费候选集**前段**返回评测 tooltip：

| 起始位置 | 有评测的比例 |
| --- | --- |
| `start=12000` | 99/100 |
| `start=20000` | 3/100 |

所以项目用独立游标回填前 **14,000** 条（`REVIEW_BACKFILL_PAGES=140`），
**越靠后的冷门条目越可能没有评测数据**。

想多补一些：

```ini
REVIEW_BACKFILL_PAGES=200    # 最多 400
```

注意回填是后台任务，每页间隔 800 ms 主动让出配额；调太大会拖慢主扫描。

另一个历史原因：`reviewSummary` / `reviewPercent` 曾经没写进精简存档，
导致重启后覆盖率从 ~90% 掉到 16%。已修复并有往返测试 —— 
如果你的存档是很早以前生成的，重启几次让它重新回填即可。

---

## 页面卡顿 / 无响应

已经在 3 万条规模下做过优化，正常情况下不应该卡。如果你确实遇到：

1. **确认浏览器不是开了大量标签页** —— 这不是借口，但确实影响很大。
2. **确认服务端响应正常**：

   ```bash
   curl -s -o /dev/null -w '%{time_total}s\n' "http://127.0.0.1:8787/api/items?limit=600"
   ```

   应该在 **14–34 ms** 量级。如果是几百毫秒，说明是服务端问题，请附上
   `/api/status` 的 `summary.total` 与 `http` 段。
3. **用真实浏览器量化**（需要 Chrome/Edge）：

   ```bash
   node bench/browser-perf.js 25     # 主线程阻塞测量
   node bench/cpu-profile.js 25      # V8 CPU 采样，定位热点
   node bench/ab-perf.js 35          # 与旧实现对照
   ```

历史优化记录（作为对照基线）：

| 指标 | 旧实现 | 现在 |
| --- | --- | --- |
| DOM 节点数 | 42,289 | 2,474 |
| 渲染卡片数 | 3,232 | 120 |
| 主线程滞后 p99 | 28 ms | 9 ms |
| 最差单次阻塞 | 203 ms | 94 ms |

---

## 数据变少了 / 重启后条目数下降

**这曾经是一个真实的数据丢失事故。** 现在应该不会发生了，但如果你遇到：

1. 看启动日志与"采集状态"里有没有 **`peakItems` 告警**（"较峰值少 N 条"）。
   有的话说明启动时确实丢了数据，请带上日志开 issue。
2. 正常波动是可能的：条目被判定 `ended` 后不再计入活跃统计。用
   `includeEnded=1` 看总数：

   ```bash
   curl -s "http://127.0.0.1:8787/api/items?limit=1&includeEnded=1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).total))"
   ```
3. 确认真的是"重启导致"而不是"跑着跑着变少"—— 后者可能是某个源在批量误判结束。
   非权威来源（`steam-catalog` / `steam-discounts`）**不应该**判定结束，这是有测试保护的。

事故根因与修复见 [架构说明](architecture.md#一次真实的数据丢失事故)。

---

## 切走再切回页面会重新加载

不应该发生了。`bootstrap()` 区分两种模式：

- `reset: true` —— **仅首次加载**：清空并重置分页/滚动；
- `reset: false` —— 切回标签页 / SSE 重连：**合并**服务端快照，
  只更新有变化的条目，保留分页深度与滚动位置；数据无变化时不触发任何重渲染。

如果仍然复现，请记录：切换前后滚动位置、`/api/status` 的 `realtime.clients` 变化、
浏览器控制台是否有报错。有 `test/frontend.test.js` 的回归测试保护这条行为。

---

## 端口与外网访问

**默认只监听 `127.0.0.1`，不要直接暴露到公网。** 服务没有鉴权，
`POST /api/refresh` 任何人都能调（会消耗你的 Steam 配额并可能触发限流）。

需要外网访问时，放在反向代理后面并加上认证：

```nginx
location / {
    auth_basic "restricted";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://127.0.0.1:8787;
    proxy_buffering off;          # SSE 必须关闭缓冲
    proxy_read_timeout 3600s;
}
```

> SSE 经反向代理时最容易踩的坑就是**响应缓冲** —— 不关掉的话事件会被攒着一起发，
> 看起来像"推送不工作"。

---

## 怎么收集诊断信息

开 issue 前请附上：

```bash
node -v                    # 版本（必须 >= 22.21.0）
npm run check              # 环境与代理自检
npm run smoke              # 联网连通性 + 解析摘要
curl -s http://127.0.0.1:8787/api/status    # 采集状态、数据源健康度
```

如果是抓取判定问题（例如"某游戏其实是限免但被判成折扣"），请附上该 appid 的
`appdetails` 关键片段（尤其是 `is_free`、`price_overview`、`package_groups[].subs[]`），
这样能直接对照 [分类规则](architecture.md#免费周末的判定) 定位。

提交前请先确认 `npm test` 全绿（122 个测试，**不联网**，所以断网也能跑）：

```bash
npm test
```
