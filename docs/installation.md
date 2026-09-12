# 安装指引

本项目**没有依赖、没有构建步骤**。装好 Node.js 之后，克隆下来就能跑。

> 先确认版本要求：[环境依赖](requirements.md) —— **Node.js >= 22.21.0**（国内用加速器必须满足）。

---

## 目录

- [方式一：Windows 一键启动（推荐）](#方式一windows-一键启动推荐)
- [方式二：手动启动（全平台）](#方式二手动启动全平台)
- [方式三：Docker（可选）](#方式三docker可选)
- [安装后验证](#安装后验证)
- [配置加速器（国内必看）](#配置加速器国内必看)
- [常驻运行](#常驻运行)
- [更新与卸载](#更新与卸载)

---

## 方式一：Windows 一键启动（推荐）

### 1. 装 Node.js

到 <https://nodejs.org/> 下载 **LTS** 版本（当前为 24.x），安装时务必勾选 **Add to PATH**。

装完在 cmd 里确认：

```bat
node -v
```

必须 >= `v22.21.0`。低于这个版本启动器会直接拒绝并提示。

### 2. 拿到代码

```bat
git clone https://github.com/OWNER/REPO.git
cd REPO
```

没有 git 就直接下载 ZIP 解压。**不需要 `npm install`**。

### 3. 双击 `启动.bat`

也可以叫 `start.bat`，两个文件内容完全一样（中文名方便双击，英文名方便命令行/CI）。

启动器依次做四件事：

| 步骤 | 做什么 |
| --- | --- |
| `[1/4]` | 找 Node.js（PATH → `Program Files` → `Program Files (x86)` → `%LOCALAPPDATA%\Programs\nodejs` → `%APPDATA%\nvm`），并校验版本 >= 22.21 |
| `[2/4]` | 检测加速器代理（读 Windows 系统代理设置），写入独立的 `.env.proxy`（**绝不修改 `.env`**） |
| `[3/4]` | 检查端口占用，`8787` 被占用就自动往后找（最多试 20 个） |
| `[4/4]` | 启动服务并自动打开浏览器 |

首次运行会自动把 `.env.example` 复制成 `.env`。

正常输出大致是：

```
 ==========================================================
   Steam Free Radar - launcher
 ==========================================================
   dir: C:\steam-free-radar

 [1/4] Node.js .................. v24.19.0  (C:\Program Files\nodejs\node.exe)
 [2/4] proxy ................... detected 127.0.0.1:26561
        written to .env.proxy
 [3/4] port .................... 8787
 [4/4] starting service ...

 ----------------------------------------------------------
   URL:   http://127.0.0.1:8787/
   stop:  Ctrl+C in this window, or just close it
 ----------------------------------------------------------
```

### 启动器参数

```bat
启动.bat               双击即可，或用 cmd 运行
启动.bat --check       只做环境自检，不启动服务（排查问题用）
启动.bat --once        只抓一轮后退出（配合计划任务用）
启动.bat --no-seed     跳过首次预热扫描
```

### 关掉它

在那个 cmd 窗口按 `Ctrl+C`，或直接关窗口。

> 界面顶部若出现"数据可能不是最新的"提示条，说明抓取失败了 ——
> 先看 [配置加速器](#配置加速器国内必看)，再看 [故障排查](troubleshooting.md)。

---

## 方式二：手动启动（全平台）

适合 Linux / macOS，或者你想自己控制进程。

### 1. 装 Node.js >= 22.21.0

```bash
# 用官方安装包（推荐，见 https://nodejs.org/）
node -v

# 或者用 nvm
nvm install 24 && nvm use 24
```

### 2. 克隆并准备配置

```bash
git clone https://github.com/OWNER/REPO.git
cd REPO

# 不需要 npm install —— 本项目零依赖
cp .env.example .env
```

### 3. 启动

```bash
npm start
# 打开 http://127.0.0.1:8787/
```

其他命令：

```bash
npm run dev        # 带 --watch，改代码自动重启（开发用）
npm run once       # 只跑一轮抓取后退出
npm run check      # 打印当前配置与代理状态，不启动服务
npm test           # 跑 122 个单元/集成测试（不联网）
npm run smoke      # 联网连通性检查（真实请求 Steam / GamerPower）
```

> **`npm start` 不是多余的一层。** 它会经由 `scripts/run.js` 启动器，
> 在 **Node 进程启动前**注入代理环境变量并带上 `--use-system-ca`。
> 实测在脚本内部赋值是无效的（详情见 [架构说明](architecture.md#为什么需要一个启动器)），
> 所以不要用 `node src/app.js` 直接启动 —— 那样加速器会失效。
> 真的想直连，用 `npm run start:direct`。

---

## 方式三：Docker（可选）

仓库没有附带 Dockerfile。用一个最小镜像即可（注意 **Node 版本必须是 22.21+**）：

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "src/app.js"]
```

```bash
docker build -t steam-free-radar .
docker run -d --name steam-radar -p 8787:8787 -v steam-radar-data:/data steam-free-radar
```

注意：

- 容器里**不要**用 `scripts/run.js`（它的作用是注入代理变量，容器里通常直连或走宿主代理）；
- 必须挂卷，否则重启容器数据就没了；
- 代理请通过 `-e HTTPS_PROXY=...` 传入，并让 Node 带上 `--use-env-proxy`
  （即 `CMD ["node", "--use-env-proxy", "--use-system-ca", "src/app.js"]`）。

> ⚠️ 对外暴露前请务必加鉴权：服务本身没有认证，`POST /api/refresh` 谁都能调。

---

## 安装后验证

### 1. 服务活着

```bash
curl http://127.0.0.1:8787/api/health
# {"ok":true,"uptimeMs":...,"clients":0}
```

### 2. 抓取正常

```bash
curl http://127.0.0.1:8787/api/status
```

重点看两处：

- `freshness.stale` 为 `false`、`freshness.failingSources` 为空 → 抓取正常；
- `sources[].stats.ok` / `failed` → 各数据源的请求成败计数。

### 3. 页面上有数据

打开 <http://127.0.0.1:8787/>，顶部统计条应有数字。

> **首次启动列表里几乎全是"永久免费"是对的。** Steam 不提供限免列表，
> 每个候选都必须用 `appdetails` 逐个确认（该接口一次只能查 1 个 appid，且被限流到约 1 请求/秒）。
> 首轮会产生数千个候选，需要跑一段时间才能消化到"原本付费"的商品上。
> 进度可在页面"采集状态"面板看。

### 4. 跑一遍测试（可选）

```bash
npm test
# ℹ tests 122
# ℹ pass 122
# ℹ fail 0
```

测试**完全不联网**，HTTP 层用假客户端注入，所以断网也能跑通。

---

## 配置加速器（国内必看）

直连 Steam 商店在国内基本不通（实测 `UND_ERR_CONNECT_TIMEOUT`）。步骤：

1. 启动 Watt Toolkit / Steam++ 等加速器，并**开启 Steam 商店加速**；
2. 在加速器设置里找到本地代理地址（形如 `127.0.0.1:26561`）；
3. 二选一：
   - **什么都不做**：`启动.bat` 会自动从 Windows 系统代理读出来写进 `.env.proxy`；
   - **手动写进 `.env`**：`PROXY_URL=http://127.0.0.1:26561`。

配置优先级：**真实环境变量 > `.env` > `.env.proxy`**。填 `PROXY_URL=none` 可强制直连。

验证：启动日志里应该有

```
[run] proxy -> http://127.0.0.1:26561  (from .env.proxy (auto-detected))
[run] injected --use-system-ca (trusts the accelerator self-signed cert).
```

若出现这两行，说明加速器路径没走通：

```
[run] no proxy configured, connecting directly. ...
[run] WARNING: Node v20.x is too old for this project's proxy support.
```

细节与实测数据见 [故障排查](troubleshooting.md#连不上-steam)。

---

## 常驻运行

### Linux (systemd)

```ini
# /etc/systemd/system/steam-radar.service
[Unit]
Description=Steam Free Radar
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=steam
WorkingDirectory=/srv/steam-free-radar
EnvironmentFile=/srv/steam-free-radar/.env
ExecStart=/usr/bin/node /srv/steam-free-radar/src/app.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now steam-radar
sudo journalctl -u steam-radar -f
```

> systemd 场景**不用** `scripts/run.js`：代理变量直接写在 `EnvironmentFile` 里即可，
> 但必须让 Node 带上 `--use-env-proxy --use-system-ca`：
> `ExecStart=/usr/bin/node --use-env-proxy --use-system-ca /srv/steam-free-radar/src/app.js`

### Windows 计划任务

只想定时抓取并推 Webhook，不需要常驻网页：

```bat
schtasks /create /tn "SteamRadar" /sc minute /mo 10 ^
  /tr "\"C:\Program Files\nodejs\node.exe\" C:\steam-free-radar\scripts\run.js --once"
```

### pm2 / 其它进程管理器

```bash
pm2 start npm --name steam-radar -- start
pm2 logs steam-radar
```

### 只想定时抓取 + Webhook 推送

```bash
# 每 10 分钟一轮，新发现推送到 WEBHOOK_URL
*/10 * * * * cd /srv/steam-free-radar && WEBHOOK_URL=https://... node scripts/run.js --once
```

---

## 更新与卸载

### 更新

```bash
git pull
# 没有依赖，所以不需要 npm install
npm test      # 确认没问题
```

然后重启服务即可。`.data/` 与 `.env` 不受影响，存档格式向后兼容（`load()` 对缺失/损坏字段有降级处理）。

### 卸载

```bash
rm -rf /path/to/steam-free-radar     # 代码
rm -f  /etc/systemd/system/steam-radar.service   # 若装了服务
sudo systemctl daemon-reload
```

数据全在项目目录的 `.data/` 里，删目录即彻底清除；想留个备份就单独拷走 `.data/state.json`。

---

## 下一步

- [环境依赖](requirements.md) —— 版本矩阵、资源占用、网络要求
- [配置参考](configuration.md) —— 全部环境变量
- [产品说明](product.md) —— 它到底能做什么、不能做什么
- [架构说明](architecture.md) —— 数据从哪来、为什么这么设计
- [故障排查](troubleshooting.md) —— 连不上、没数据、卡顿
- [HTTP API](api.md) —— 自己写脚本消费数据
