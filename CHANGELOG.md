# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（暂无）

## [1.0.0] - 2025-09-12

首个可用版本。整个项目是在对 Steam 公开接口做实测的基础上长出来的，
下面记录的主要是**实测结论**与**踩过的坑**，因为它们是理解这份代码的前提。

### 核心结论（决定了整体架构）

- 实测确认 Steam **没有任何公开接口能列出"限时免费"**：
  - `search/results?specials=1` 抽样 15000+ 条，折扣只到 90%，**零个 100% 折扣**
  - `search/results?maxprice=free&specials=1` 恒返回 `total_count=0`
  - `maxprice=free`（6.4 万条）无法区分永久免费与限时免费
  - `data-price-final` 不可信（永久免费的 CS2 返回 `10300`，Apex 返回 `0`）
- `api/appdetails` 的 `appids` 参数**一次只能查 1 个**，传多个返回 HTTP 400
- **免费周末不会进入免费候选集**（订阅制限时体验，如 F1® 25 走 EA Play），
  只能从商店精选位发现
- 商店页的购买区已是 JS 动态渲染，**无法再靠抓 HTML 判定价格**

### 新增

- **四类数据源**
  - `steam-catalog`：免费候选集滚动扫描（游标持久化）
  - `steam-details`：`appdetails` 精确校验，权威判定限免/结束
  - `steam-spotlight`：商店精选位，发现**免费周末**
  - `steam-discounts`：促销索引（约 1.57 万条折扣，含价格与折扣）
  - 另有 `gamerpower` 作为第三方补充
- **SSE 实时推送**（`/api/stream`），新限免即时弹桌面通知
- **数据治理**：永久免费只读一次、折扣按 6 小时复核、限免按 15 分钟复核；
  候选队列分诊，跳过"查了也几乎必然是永久免费"的冷门条目
- **前端**：统计条覆盖全部类型且可点击筛选、折扣/价格区间筛选、评测档位与评测数筛选、
  分页加载全部已存数据、SSE 合并限流渲染
- **Windows 一键启动器** `启动.bat` / `start.bat`：环境自检、加速器代理自动检测、端口避让
- **完整的文档体系**（`docs/`）：[安装指引](docs/installation.md)、[环境依赖](docs/requirements.md)、
  [配置参考](docs/configuration.md)、[产品说明](docs/product.md)、
  [架构说明](docs/architecture.md)、[HTTP API](docs/api.md)、[故障排查](docs/troubleshooting.md)
- **仓库规范文件**：`LICENSE`(MIT)、`CONTRIBUTING.md`、`SECURITY.md`、本 CHANGELOG、
  `.editorconfig`、`.gitattributes`、`.github/workflows/ci.yml`（多 Node 版本 + 仓库规范 + Windows 启动器三组检查）、
  issue / PR 模板
- **122 个测试**（不联网）与 `bench/` 下的性能测量脚本

### 变更

- **Node 版本要求从 20.10 提升到 22.21.0。** 查证 Node 官方文档后确认：
  `--use-system-ca` 是 v22.15.0 / v23.8.0 才引入，`--use-env-proxy`（等价 `NODE_USE_ENV_PROXY=1`）
  是 v22.21.0 才引入。**Node 20.x 两者都没有**，所以"国内 + 加速器"这条路径在 20.x 上
  不可能走通。`package.json` 的 `engines`、启动器检查、文档已同步
- 清理了三项未被任何代码引用的配置（`SPECIALS_PAGES_PER_CYCLE`、`SPECIALS_SWEEP_MS`、
  `WATCHLIST_FULL_SWEEP_MS`、`ENABLE_STEAM_SPECIALS_INDEX`），并修正 `steamCatalog.js`
  里已经过时的头注释（促销索引职责早已拆给 `steam-discounts`）
- 性能脚本与对照页从 `scripts/`、`public/` 移到 `bench/`（挂载在 `/bench/` 下），
  避免把"非产品功能"混在产品目录里；`public/` 现在只有前端三件套

### 修复（均为实际发生过的故障）

- **静默数据丢失**：存档压缩策略丢弃了"冷门条目"，但游标照常推进，
  重启后一半数据永久消失。改为**全量持久化**，并新增 `peakItems` 峰值告警
- **评测数据丢失**：`reviewSummary` / `reviewPercent` 未写入存档，
  重启后评价结果覆盖率从 ~90% 掉到 16%
- **免费周末完全漏抓**：`is_free=false` 的限时体验被判成"折扣"，
  且它根本不在候选集里
- **折扣数量虚低**：促销索引里的价格/折扣数据被丢弃，导致"高折扣"只能靠采样顺带得到
- **所有付费无折扣条目被记成"折扣"**：界面上出现一批 `-0%` 条目
- **折扣被"只看免费"隐藏**：统计卡片有数字、列表却空着
- **页面卡死**：抓取时每 700ms 重建 1200 张卡片，主线程 72% 时间耗在渲染
- **切走再切回"从头开始"**：`bootstrap()` 无条件清空数据并重置分页
- **落盘阻塞事件循环**：10MB 存档 `JSON.stringify` 同步耗时 446ms，
  每 60 秒卡半秒；改为按条目缓存序列化片段
- **`store.active()` 慢**：3 万条时 45ms（比较函数里反复评分），改为先算排序键
- **限流器只升不降**：每次 429 都 ×1.6 且不恢复，飙到 7.5s/请求
- **评测数正则只匹配英文**：中文环境下恒为 0，候选优先级全部失效
- **演示版正则误伤"激**活**码"**（字符重叠），导致正常条目被隐藏
- **`endPass` 的 `authoritative` 默认值**把 `tolerance` 静默覆盖为 `Infinity`，
  条目永远不会被判结束
- **`normalizeItem` 白名单**静默丢弃 `lastVerifiedAt` 等字段，使校验调度失效
- **`npm run check` 会把服务真的起起来**：`--check` 只是被透传给 `src/app.js`，
  而 app 不认识这个参数，于是"自检"命令启动了服务，端口被占用时还会报 `EADDRINUSE`，
  看起来像环境故障。现在 `scripts/run.js` 自己实现自检：打印 Node 版本与代理能力、
  `.env` / `.env.proxy` 状态、生效配置、端口是否空闲，然后**直接退出、不启动服务**
- **静态资源对非 origin-form 请求目标返回首页**：`new URL('//package.json', base)` 会把
  `//x` 当成协议相对 URL，host 变成 `x`、pathname 变成 `/`，于是 `GET //package.json`
  静默返回 200 + 首页（不泄露文件，但语义错乱）。现在只接受以单个 `/` 开头的请求目标，
  其余返回 400，并改用固定 base（不再信任 `Host` 头）
- **代理相关**：`NODE_USE_ENV_PROXY` 运行时赋值无效；
  `--use-system-ca` 会被 Node 消费掉导致子进程无法反查；
  批处理改写 `.env` 时按 `=` 切分把注释行写回、损坏配置文件（改为写独立 `.env.proxy`）
- **旧 Node 上盲目注入 `--use-system-ca`**：该选项在不支持的版本上会让子进程以
  `bad option` 直接退出，用户看到的是莫名其妙的启动失败。现在启动器先做版本能力判断
  （`src/net.js` 的 `proxyFeatureSupport()`），不支持时改为打印明确的升级提示

### 已知限制

- Steam 当前可能没有任何在跑的「限时免费入库」活动，此时该分类为 0 属正常
- 免费周末依赖 Steam 精选位数据；折扣数据来自促销索引扫描，需扫完一轮才完整
- 「高折扣参考」不是全量折扣榜，只覆盖促销索引中的条目

[Unreleased]: https://github.com/OWNER/REPO/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OWNER/REPO/releases/tag/v1.0.0
