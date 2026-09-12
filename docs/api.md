# HTTP API

服务默认监听 `http://127.0.0.1:8787`。所有接口无需鉴权（**因此不要直接暴露到公网**），
响应统一为 JSON（`content-type: application/json; charset=utf-8`，`cache-control: no-store`）。

```bash
BASE=http://127.0.0.1:8787
```

---

## 目录

- [接口总览](#接口总览)
- [GET /api/items](#get-apiitems)
- [GET /api/item/:key](#get-apiitemkey)
- [GET /api/facets](#get-apifacets)
- [GET /api/events](#get-apievents)
- [GET /api/status](#get-apistatus)
- [GET /api/health](#get-apihealth)
- [GET /api/stream（SSE）](#get-apistreamsse)
- [POST /api/refresh](#post-apirefresh)
- [静态资源](#静态资源)
- [条目对象](#条目对象)
- [枚举值](#枚举值)
- [客户端示例](#客户端示例)

---

## 接口总览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/items` | 条目列表（筛选 / 排序 / 分页） |
| `GET` | `/api/item/:key` | 单条详情 |
| `GET` | `/api/facets` | 分桶统计（给区间筛选按钮标真实条数） |
| `GET` | `/api/events` | 变更事件历史 |
| `GET` | `/api/status` | 采集状态、数据源健康度、HTTP 统计 |
| `GET` | `/api/health` | 健康检查（最轻量） |
| `GET` | `/api/stream` | **SSE 实时推送** |
| `POST` | `/api/refresh` | 手动触发抓取 |
| `GET` | `/` | 前端页面 |
| `GET` | `/bench/*` | 性能对照页（通过浏览器访问，不是 API） |

---

## GET /api/items

条目列表。**默认只返回免费内容**，付费无折扣的条目永远不会出现。

### 查询参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `q` | 空 | 关键词，匹配**标题** / **AppID** / **描述**（不区分大小写） |
| `type` | `all` | 类型筛选，见[枚举值](#枚举值) |
| `source` | `all` | 来源筛选 |
| `freeOnly` | `1` | 传 `0` 关闭"只看免费"。注意 `discount` 类型**不受此开关影响** |
| `includeEnded` | `0` | 传 `1` 包含已结束（下架/限免到期）的条目 |
| `includeDemos` | `0` | 传 `1` 包含试玩版 / Demo / 序章 |
| `since` | 空 | ISO 时间，只返回 `firstSeenAt >= since` 的条目 |
| `limit` | `600` | 1–2000 |
| `offset` | `0` | 分页偏移。响应里的 `hasMore` 告诉你要不要继续拉 |
| `minDiscount` / `maxDiscount` | 空 | 折扣百分比区间。`maxDiscount=100` 表示"到顶"（闭区间），其余为**左闭右开** |
| `minPrice` / `maxPrice` | 空 | 价格区间，单位是**最小货币单位（分）**，左闭右开 |
| `rating` | `all` | 评测档位，见[枚举值](#枚举值) |
| `minReviewPercent` | 空 | 好评率下限（0–100） |
| `minReviewCount` | 空 | 评测数下限 |

### 响应

```jsonc
{
  "total": 37388,          // 过滤后总数（不是本次返回条数）
  "offset": 0,
  "returned": 20,
  "hasMore": true,
  "generatedAt": "2026-09-12T12:00:00.000Z",
  "summary": { "total": 37388, "byType": { "f2p": 37343, "weekend": 1, ... } },
  "demosHidden": 812,      // 被"试玩版默认隐藏"挡掉的条数
  "items": [ /* 见「条目对象」 */ ]
}
```

### 示例

```bash
# 只看免费周末
curl "$BASE/api/items?type=weekend"

# 折扣 80% 以上且价格低于 ¥10（价格单位是分）
curl "$BASE/api/items?type=discount&minDiscount=80&maxDiscount=100&maxPrice=1000"

# 好评如潮、评测数 ≥ 1000
curl "$BASE/api/items?rating=overwhelming&minReviewCount=1000"

# 按 AppID 精确找
curl "$BASE/api/items?q=730"

# 拉全部数据（配合 offset 循环）
curl "$BASE/api/items?limit=2000&offset=0"
curl "$BASE/api/items?limit=2000&offset=2000"
```

---

## GET /api/item/:key

单条详情。`:key` 是 `source:sourceId`，需要 URL 编码。

```bash
curl "$BASE/api/item/steam-details:3059520"
```

```jsonc
{ "ok": true, "item": { /* 条目对象 */ } }
```

找不到时返回 `404`：

```jsonc
{ "ok": false, "error": "not found" }
```

---

## GET /api/facets

分桶统计。**用途是让界面上的区间筛选按钮显示真实条数**，从而避免"点了没结果"的空区间。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `type` | `discount` | 对哪个类型做分桶（通常是 `discount`） |

```jsonc
{
  "type": "discount",
  "total": 785,
  "discountBuckets": [ { "min": 0, "max": 10, "count": 0 }, { "min": 10, "max": 20, "count": 56 }, ... ],
  "priceBuckets":    [ { "min": 0, "max": 1000, "count": 62 }, { "min": 1000, "max": 2500, "count": 233 }, ... ],
  "ratingTiers":     [ { "key": "overwhelming", "names": ["好评如潮", "Overwhelmingly Positive"], "count": 321 }, ... ],
  "withReviewCount": 64800,
  "withoutReviewCount": 10800,
  "priceMin": 0,
  "priceMax": 49800,
  "currency": "CNY"
}
```

> 分桶用**左闭右开** `[lo, hi)`（最后一桶闭区间），否则边界值会被相邻两桶重复计数。
> 这个 bug 是测试抓出来的：价格桶计数之和曾经大于总数。

---

## GET /api/events

变更事件历史，时间倒序。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `type` | 空 | 事件类型筛选：`discovered` / `became_free` / `price_drop` / `ended` / `updated` |
| `limit` | `80` | 1–400 |

```jsonc
{
  "total": 800,
  "events": [
    { "type": "became_free", "key": "steam-details:3059520", "title": "F1® 25", "at": "2026-09-12T11:59:00.000Z", ... }
  ]
}
```

> 服务端只保留最近 **800** 条事件。需要长期留档请自己消费 SSE 或 Webhook。

---

## GET /api/status

最完整的自检接口。排查问题时先看它。

```jsonc
{
  "ok": true,
  "startedAt": "2026-09-12T10:00:00.000Z",
  "uptimeMs": 7200000,
  "summary": { "total": 37388, "byType": { ... }, "bySource": { ... } },
  "freshness": {
    "lastSuccessAt": "2026-09-12T11:59:30.000Z",
    "dataAgeMs": 30000,
    "stale": false,                 // ← 数据是否已经陈旧
    "staleThresholdMs": 360000,
    "failingSources": []            // ← 正在连续失败的数据源
  },
  "sources": [
    {
      "name": "steam-catalog",
      "intervalMs": 120000,
      "runs": 42,
      "lastDurationMs": 3100,
      "stats": { "ok": 336, "failed": 2, "lastSuccessAt": "...", "consecutiveFailures": 0 },
      "lastResult": { "pages": 8, "rows": 800, "candidates": 40979, ... }
    }
  ],
  "realtime": { "clients": 1, "sent": 1234 },
  "http": { "ok": 338, "failed": 2, "throttled": 0, "currentIntervalMs": 900 },
  "config": { "cc": "cn", "lang": "schinese", "webhookEnabled": false, "enabled": { ... } }
}
```

**判断抓取是否正常**：`freshness.stale === false` 且 `freshness.failingSources` 为空。

---

## GET /api/health

最轻量的存活检查，适合给进程管理器 / 负载均衡用。

```jsonc
{ "ok": true, "uptimeMs": 7200000, "clients": 1 }
```

---

## GET /api/stream（SSE）

实时推送。用浏览器原生 `EventSource` 或 `curl -N` 都能消费。

```
event: hello     首次连接（含服务端时间与统计快照）
event: event     单条变更：discovered / became_free / price_drop / ended / updated
event: item      发生变更的条目 key 列表（前端据此增量重拉，而不是整页重载）
: ping           心跳保活注释
```

```bash
curl -N "$BASE/api/stream"
```

```
event: hello
data: {"summary":{...},"sourceCount":5,"at":"2026-09-12T12:00:00.000Z"}

event: event
data: {"type":"became_free","key":"steam-details:3059520","title":"F1® 25","at":"..."}

event: item
data: {"keys":["steam-details:3059520","steam-catalog:730"]}

: ping
```

**去抖动**：条目变更按 **700 ms** 批量合并推送；事件帧即时推送。

> 前端不需要自己重连 —— 浏览器 `EventSource` 会自动重连。
> 但重连后会收到一次 `hello`，此时应该用**合并**而不是重置的方式更新本地状态
> （见 [架构说明](architecture.md#持久化与不重复抓取)）。

---

## POST /api/refresh

手动触发抓取。**这是一个可能阻塞数秒到数十秒的同步接口**（它 `await` 完整一轮抓取）。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `source` | `all` | 只刷新指定源；`all` 或省略 = 全部 |
| `pages` | 配置值 | 仅对 `steam-catalog` 生效，1–120 |

```bash
# 只刷新一次精选位（最快能看到免费周末变化）
curl -X POST "$BASE/api/refresh?source=steam-spotlight"

# 加大候选集扫描页数
curl -X POST "$BASE/api/refresh?source=steam-catalog&pages=20"

# 全部源各跑一轮
curl -X POST "$BASE/api/refresh"
```

```jsonc
{ "ok": true, "source": "steam-spotlight", "result": { "pages": 1, "rows": 12, ... } }
```

> ⚠️ 没有任何鉴权。**不要**把服务直接暴露到公网，否则任何人都能拿它刷你的 Steam 配额、
> 并可能触发限流。

---

## 静态资源

| 路径 | 内容 |
| --- | --- |
| `/` | 前端页面（`public/index.html`） |
| `/app.js`、`/styles.css` | 前端资源 |
| `/bench/baseline.html` | 性能对照用旧实现（不属于产品功能） |

静态资源有**目录穿越防护**：解析后的路径必须落在对应根目录内，否则返回 `403`。

HTML 用 `cache-control: no-cache`，其它资源 `public, max-age=300`。

---

## 条目对象

```jsonc
{
  "key": "steam-details:3059520",
  "source": "steam-details",
  "sourceLabel": "Steam 价格校验",
  "sourceId": "3059520",
  "appId": 3059520,
  "kind": "game",
  "freeType": "weekend",
  "freeTypeLabel": "免费周末",
  "isFreebie": true,

  "title": "F1® 25",
  "url": "https://store.steampowered.com/app/3059520",
  "image": "https://cdn.cloudflare.steamstatic.com/steam/apps/3059520/header.jpg",
  "description": "…",

  "currency": "CNY",
  "originalPrice": 24800,            // 最小货币单位（分）
  "finalPrice": 17360,
  "originalPriceFormatted": "¥ 248.00",
  "finalPriceFormatted": "¥ 173.60",
  "discountPercent": 30,
  "isFree": false,

  "reviewSummary": "特别好评",        // Steam 的评测档位文案（随语言变化）
  "reviewPercent": 89,
  "reviewCount": 1412376,

  "isDemo": false,
  "wasPaid": true,                   // appdetails 的 !is_free
  "spotLabel": "免费周末",            // 精选位给出的活动名（解释为什么判为限时活动）
  "lastVerifiedAt": "2026-09-12T11:55:00.000Z",
  "verifiedBy": "steam-details",

  "platforms": ["windows", "mac", "linux"],
  "tags": ["Racing", "Sports"],
  "releaseDate": "2025-05-30",
  "endDate": null,
  "requirements": null,
  "instructions": null,

  "active": true,
  "firstSeenAt": "2026-09-12T09:00:00.000Z",
  "lastSeenAt": "2026-09-12T11:55:00.000Z",
  "updatedAt": "2026-09-12T11:55:00.000Z",
  "lastEventType": "discovered",
  "missedPasses": 0
}
```

### 需要留意的字段

| 字段 | 说明 |
| --- | --- |
| `key` | 唯一标识，规则是 `source:sourceId`。**不要**只用 `appId` 做键：同一商品可能来自不同源 |
| `freeType` | 类型枚举，见下。`paid` **永远不会**出现在 API 响应里 |
| `finalPrice` | 单位是**分**（CS2 之类可能给占位值，别当真实价格用） |
| `reviewSummary` | Steam 的原文案（中文/英文取决于 `STEAM_LANG`），**不是**归一化枚举，所以客户端要做映射 |
| `isFreebie` | 服务端算好的"是否算免费内容"（`keep`/`weekend`/`key`/`f2p`） |
| `active` | `false` 表示已结束。默认不返回，除非 `includeEnded=1` |

---

## 枚举值

| 枚举 | 值 |
| --- | --- |
| `type` | `all` · `keep`（限时免费入库） · `weekend`（免费周末） · `key`（免费激活码） · `f2p`（永久免费） · `discount`（高折扣参考） |
| `source` | `all` · `steam-catalog` · `steam-discounts` · `steam-details` · `steam-spotlight` · `gamerpower` |
| `rating` | `all` · `overwhelming` · `veryPositive` · `positive` · `mixed` · `negative` |
| 事件 `type` | `discovered` · `became_free` · `price_drop` · `ended` · `updated` |
| `kind` | `game` · `dlc` · `bundle` · `other` |

`rating` 的映射（服务端 `RATING_TIERS`）同时接受中英文档位文案，换 `STEAM_LANG` 后筛选不会失效：

| `rating` | 匹配的 `reviewSummary` |
| --- | --- |
| `overwhelming` | 好评如潮 / Overwhelmingly Positive |
| `veryPositive` | 特别好评 / Very Positive |
| `positive` | 多半好评 / 好评 / Positive / Mostly Positive |
| `mixed` | 褒贬不一 / Mixed |
| `negative` | 多半差评 / 差评 / 特别差评 / 差评如潮 / Mostly Negative / Negative / Very Negative / Overwhelmingly Negative |

---

## 客户端示例

### 拉全部条目并落地成 JSON

```bash
offset=0
: > all-items.json
while :; do
  page=$(curl -s "$BASE/api/items?limit=2000&offset=$offset&freeOnly=0&includeEnded=1")
  echo "$page" >> all-items.json
  has=$(printf '%s' "$page" | grep -o '"hasMore":true')
  [ -z "$has" ] && break
  offset=$((offset + 2000))
done
```

### 监听新限免（Node，零依赖）

```js
// 只在"刚刚限免"时打印，永久免费首次收录不打扰
const res = await fetch('http://127.0.0.1:8787/api/stream');
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
let buf = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += value;
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    if (!frame.startsWith('event: event')) continue;
    const data = JSON.parse(frame.split('\ndata: ')[1]);
    if (data.type === 'became_free' || data.type === 'discovered') {
      if (data.freeType === 'f2p') continue; // 永久免费不打扰
      console.log(`[${data.type}] ${data.title ?? data.key}  ${data.url ?? ''}`);
    }
  }
}
```

### 按"值得关注"程度排序挑前 20 条

```bash
curl -s "$BASE/api/items?minReviewCount=1000&rating=veryPositive&limit=20" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const i of JSON.parse(s).items)console.log(i.freeTypeLabel,i.reviewSummary,i.title)})"
```
