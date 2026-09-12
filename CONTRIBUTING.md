# 贡献指南

感谢你愿意参与这个项目。为了让改动能被顺利合并，请先花两分钟读完本文。

---

## 快速开始

```bash
git clone <你的 fork 地址>
cd steam-free-radar
npm test          # 应输出 122 个测试全部通过（不需要联网、不需要安装依赖）
npm start         # 启动服务：http://127.0.0.1:8787/
```

本项目**零第三方运行时依赖**，`npm install` 不是必需的（仓库没有依赖树）。
请保持这一点：引入任何依赖都需要在 PR 里说明必要性。

> 需要 **Node.js >= 22.21.0**（原因见 [环境依赖](docs/requirements.md#二node-版本要求)）。
> 架构与实测结论请先读 [架构说明](docs/architecture.md)，能省下不少试错。

---

## 提交前必须做的事

```bash
npm test                       # 单元/集成测试，必须全绿
npm run check                  # 环境自检（Node 版本、代理、端口），不会启动服务
npm run check:docs             # 文档相对链接与锚点自检
```

涉及网络行为的改动，建议再跑一次真实连通性检查：

```bash
npm run smoke                  # 真实请求 Steam / GamerPower，打印解析摘要
```

---

## 代码风格

没有引入 ESLint/Prettier（避免增加依赖），但请遵守：

- **缩进 2 空格**，文件末尾留一个换行，UTF-8
- 提交信息用中文或英文都可以，建议 `type: 说明`，例如
  `fix: 修正评测字段未持久化`、`feat: 支持按评测档位筛选`
- **注释请写"为什么"而不是"是什么"**。本仓库里大量注释记录的是实测结论与
  踩过的坑，这是有意为之 —— 数值、阈值、绕过写法都请注明依据
- 注释与文档使用中文（与现有代码保持一致）

---

## 容易被改坏的约束

这些规则都对应真实的线上故障，改动前请先看对应测试。

| 约束 | 原因 | 相关测试 |
| --- | --- | --- |
| **存档压缩可以，但绝不能丢数据** | 曾经"只保留有价值条目"，导致游标推进而数据未持久化，重启后静默丢失一半数据。**若确需裁剪，必须同时回退游标** | `test/store.test.js` 存档全量往返 |
| **序列化缓存必须随条目变更失效** | 条目内容变了却写出缓存旧值会导致数据错乱 | `test/store.test.js` 序列化缓存 |
| **代理环境变量必须在 Node 启动前存在** | `NODE_USE_ENV_PROXY` 是启动阶段读取的，运行时赋值实测无效（一直连接超时） | `test/net.test.js` 启动器注入 |
| **`--use-system-ca` 无法被子进程反查** | 它会被 Node 启动阶段消费掉，`execArgv` 为空。必须靠显式标记环境变量 | `test/net.test.js` 系统证书标记 |
| **不得在旧 Node 上注入 `--use-system-ca`** | 该选项 v22.15.0 才引入，旧版本会以 `bad option` 直接退出。必须先判断版本 | `test/net.test.js` `proxyFeatureSupport` |
| **`summary({groupCounts:false})` 仍须带 `byType`** | 界面统计条要显示每一个类型，缺一项用户会以为没数据 | `test/store.test.js` |
| **分桶用左闭右开 `[lo, hi)`** | 闭区间会让边界值被相邻两桶重复计数 | `test/api.test.js` facets |
| **`.bat` 必须 ASCII + CRLF** | cmd 按 ANSI 代码页解析批处理，中文/UTF-8 会破坏语法 | CI 的 hygiene job |
| **渲染必须限流合并** | 抓取时每 700ms 一批 SSE，逐批重建 DOM 会把页面卡死 | `test/frontend.test.js` |
| **非权威来源永不判定"下架"** | 分页滚动的一轮没看到某条目，不代表它消失了 | `test/store.test.js` `endPass` |
| **请求目标只接受 origin-form** | `//x` 会被 `new URL` 当成协议相对 URL，把 `x` 当主机名、pathname 变成 `/`，静态资源会静默返回首页 | `test/api.test.js` 静态资源 |
| **`--check` 不得启动服务** | 曾经只是透传参数，结果"自检"命令真的起了服务，端口占用时还报 EADDRINUSE | `test/net.test.js` `npm run check` |

---

## 新增数据源

数据源统一放在 `src/sources/`，实现两个成员即可被 `src/poller.js` 调度：

```js
// 1) 先在 src/model.js 的 SOURCE 与 SOURCE_LABEL 里注册名字和展示标签
export class MySource {
  constructor({ http, store, config, logger }) {
    /* ... */
    this.name = SOURCE.MY_SOURCE;
  }
  async runOnce(options) { /* 抓取 -> store.upsert(...) */ }
  /** 本轮是否覆盖了该源的全部条目（决定能否据此判定"下架"） */
  get authoritative() { return false; }
}
```

然后在 `src/poller.js` 的 `#register()` 里加一个开关 + 一个 `add(...)`，
并在 `src/config.js` 里补上间隔与 `ENABLE_*` 开关，最后同步 `.env.example` 与
[docs/configuration.md](docs/configuration.md)。

要点：

- 不确定是否覆盖全量时，`authoritative` 必须返回 `false`，
  否则分页滚动的一轮会被误判成"其余条目全部下架"
- 抓取失败要让 `runOnce` 返回 `ok: false` 或抛错，**不要静默返回空**，
  否则网络故障会被当成"没有新内容"
- 外部数据一律视为不可信输入：剥离 HTML、限制长度、校验 URL 协议
  （参考 `src/sources/gamerpower.js`）
- 新增条目字段时，**必须同步 `src/model.js` 的 `normalizeItem()` 白名单**，
  否则会出现"写进去了但读不到"的隐蔽 bug（`lastVerifiedAt` 就这样丢过一次）；
  如果字段需要跨重启保留，还要同步 `src/store.js` 的 `compactRecord` / `expandRecord`

---

## 文档

改了行为或配置就要同步文档，别让文档变成谎言：

| 改动 | 需要同步 |
| --- | --- |
| 新增/删除环境变量 | `.env.example`、[docs/configuration.md](docs/configuration.md) |
| 新增数据源或抓取策略 | [docs/architecture.md](docs/architecture.md) |
| API 参数、字段、SSE 帧 | [docs/api.md](docs/api.md) |
| 用户可见的行为/局限变化 | [README.md](README.md)、[docs/product.md](docs/product.md) |
| Node 版本要求 | `package.json` 的 `engines`、`启动.bat`/`start.bat`、[docs/requirements.md](docs/requirements.md) |

文档与注释统一用中文，并且**写明依据**（实测数值、接口行为、事故原因）。

---

## 报告问题

- **Steam 接口失效/改版**：请附上你实测的请求 URL 与响应片段
  （可用 `node scripts/diagnose.js`、`node scripts/diagnose-signals.js`）
- **抓不到某类内容**：先说明是"没有数据"还是"解析失败"
- **性能问题**：`bench/` 下有现成的测量脚本，附上输出即可

安全相关问题请走 [SECURITY.md](SECURITY.md)，不要开公开 issue。

---

## 维护者备忘：发布前替换占位符

仓库里刻意留下了 `OWNER/REPO` 占位符，发布到你自己的仓库前请全局替换：

| 文件 | 位置 |
| --- | --- |
| `package.json` | `repository.url`、`bugs.url`、`homepage` |
| `README.md` | 顶部 CI badge、`git clone` 地址 |
| `CHANGELOG.md` | 版本链接 |
| `SECURITY.md` | 漏洞上报入口 |
| `.github/ISSUE_TEMPLATE/config.yml` | 联系链接 |
| `LICENSE` | 版权持有人（当前是 `steam-free-radar contributors`） |

另外建议：

- 在仓库 Settings 里开启 **Private vulnerability reporting**（与 SECURITY.md 的说明保持一致）
- 分支保护规则里把 CI 的 `test` / `hygiene` / `windows launcher` 设为必需检查
- 仓库 Topics 建议填：`steam`、`free-games`、`giveaway`、`sse`、`zero-dependency`、`nodejs`
- 加一张界面截图到 `docs/images/screenshot.png`，然后取消 README「预览」一节里那行注释
