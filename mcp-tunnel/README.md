# dsh-tunnel-mcp

把 **DeepSeek Harness Desktop** 的手机网关，从「每次重连就换地址的临时隧道」换成
**永久固定的公网地址**，并以 **MCP 插件**形式接入你现在用的 DeepSeek Harness。

---

## 1. 为什么要做这个

原来 Desktop 端用的是 Cloudflare **Quick Tunnel**（`cloudflared tunnel --url`）：

```js
// 旧代码 remote-gateway.cjs
spawn(this.cloudflaredPath, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', origin])
```

Quick Tunnel 每次启动、每次边缘连接断开，都会重新分配一个
`https://<随机词>.trycloudflare.com` 域名。断线重连后地址就变了，
手机端保存的链接、扫码配对全部失效 —— 这就是「隔段时间就要重新连接」的根因。

**实测证据（本机真实结果）：**

| 检查项 | 结果 |
|---|---|
| `cloudflared` 能否连上 Cloudflare 边缘 | ✅ `Registered tunnel connection ... location=nrt10` |
| 从本机访问生成的隧道地址 | ❌ `ECONNRESET` / HTTP `530`（error 1033） |
| 直接访问 `cloudflare.com/cdn-cgi/trace` | ✅ 200 |
| 隧道域名的 DNS 解析结果 | `198.18.0.79` + `2001:2::61` → **VPN fake-IP / NAT64 拦截** |

两条结论：
1. **随机地址是设计缺陷**，换域名（Named Tunnel）才能固定。
2. **本机开着 VPN 会破坏 Cloudflare 边缘的数据通路**。Cloudflare 能连上，
   但流量被 VPN 改写后连接被重置。要长期稳定，**必须关闭这类 VPN/代理**
   （或者两条网线：一条走 VPN，隧道走直连）。

---

## 2. 现在的架构

```
手机浏览器
   │  https://dsh.你的域名.com   ← 永久固定，永不变
   ▼
Cloudflare 边缘
   │  Named Tunnel（命名隧道）
   ▼
cloudflared.exe  ──►  http://127.0.0.1:<桌面端网关端口>
                            │
                            ▼
                   DeepSeek Harness Desktop
                   （配对认证 + 远程桌面 WebSocket + 反代 DSH 页面）
```

- 隧道由 **`dsh-tunnel-mcp`**（独立 MCP 服务器）管理，也可以由 Desktop 自己托管。
- 桌面端网关端口是**随机**的，以前没有任何文件记录它。现在网关会写
  `gateway-status.json`，MCP 也能通过系统套接字扫描自动发现端口。

---

## 3. 配置状态：✅ 已完成并验证

> ### `xinqiaopsy.top` 已配置完成
>
> | 项目 | 值 |
> |---|---|
> | 域名 | `xinqiaopsy.top`（Cloudflare zone 状态 **active**） |
> | NS | `coen.ns.cloudflare.com` / `sarah.ns.cloudflare.com` |
> | 隧道名 | `dsh-desktop` |
> | 隧道 ID | `08d19f8f-19ec-401b-aecd-225ca7ae2ac0` |
> | **永久地址** | **`https://dsh.xinqiaopsy.top`** |
> | DNS | `dsh` → CNAME → `08d19f8f-....cfargotunnel.com`（已代理） |
>
> **端到端已验证**（`npm run verify:permanent`）：
> 公网 DNS 解析到真实 Cloudflare 边缘 `172.67.220.210` / `104.21.38.87`，
> 公网抓取返回 **HTTP 200**（`cf-ray: ...-NRT`）且响应体确实来自本机，
> **重启隧道后地址完全不变**。

### 一次性配置步骤（已为你执行完，保留备查）

1. 阿里云购买域名 `xinqiaopsy.top` ✅
2. 阿里云 → **DNS修改** → 换成 Cloudflare 的两个 nameserver ✅
3. Cloudflare **Add a site** → 状态 active ✅
4. `cloudflared tunnel login`（浏览器授权，生成 `~/.cloudflared/cert.pem`）✅
5. `cloudflared tunnel create dsh-desktop` ✅
6. `cloudflared tunnel route dns dsh-desktop dsh.xinqiaopsy.top` ✅

> ⚠️ 注意：**阿里云「DNS修改」和「云解析DNS」是两件不同的事**。
> 只有改 nameserver（前者）才能让 Cloudflare 代理生效；只在云解析里加记录，
> 命名隧道**不会**工作。

### 日常使用

```
tunnel_configure  hostname=dsh.xinqiaopsy.top   tunnelName=dsh-desktop
tunnel_start
tunnel_verify  attempts=5
```

固定用 **`https://dsh.xinqiaopsy.top`** 访问，重启、休眠、断线都不会变。

---

## 4. MCP 工具清单

接入后工具名形如 `mcp__dsh_tunnel__<工具>`。

| 工具 | 作用 |
|---|---|
| `tunnel_status` | 当前隧道状态、地址、是否永久、cloudflared 路径 |
| `tunnel_start` | 启动隧道；默认命名隧道，可选 `quick` 临时隧道 |
| `tunnel_stop` | 停止隧道（域名仍然保留，地址不变） |
| `tunnel_restart` | 重启隧道；命名隧道重启后**地址不变** |
| `tunnel_url` | 返回唯一的固定手机地址 + 终端二维码 |
| `tunnel_verify` | **验证手机是否真能访问**：DNS + 真实请求 + 抖动率 |
| `domain_check` | 检查域名 NS 是否已切到 Cloudflare（命名隧道的前置条件） |
| `tunnel_setup` | 显示上面的一次性配置步骤，并报告哪些已完成 |
| `tunnel_configure` | 保存隧道名 / 域名 / 凭据路径 / 网关端口 |
| `tunnel_diagnostics` | 完整诊断：为什么还不是永久的、缺哪一步 |
| `cloudflare_verify` | 用 Cloudflare API 确认隧道存在、CNAME 已代理指向它（需令牌） |
| `gateway_health` | 桌面端网关是否可达、隧道的 `checkPublic` 公网自检 |
| `gateway_devices` | 已配对的手机列表（不回显公钥） |
| `tunnel_apply_to_desktop` | 把固定域名写进 Desktop 的 `remote-settings.json` |
| **`gateway_start`** | 启动**本 MCP 自带**的手机网关（配对 + 反代到 harness），可选顺便起隧道 |
| **`gateway_pair`** | 生成一次性配对码 + 终端二维码 |
| **`gateway_status`** | 网关端口、harness 是否已认证、已配对设备、常驻进程与自启状态 |
| **`gateway_revoke`** | 吊销一台已配对设备 |
| **`gateway_detach`** | 把网关搬进**独立常驻进程**（DSH 重启也不影响），可选装开机自启 |
| **`gateway_autostart`** | 安装/移除 Startup 启动器 |
| **`harness_locate`** | 定位运行中的 harness 端口并从内存取回 token（token 只回显前 6 位） |

---

## 5. 接入到 DSH 的方式

MCP 服务器是一个标准 **stdio MCP server**，用 DSH 已有的
`@deepseek-ai/dsh-mcp-client` 接入。

**自动注册（推荐）：**

```powershell
cd 'F:\Agent yy\DSH\DSH改造\tunnel-mcp'
npm run install:dsh              # 写入当前 profile 的 cordis.patch.yml
node scripts/install-dsh.mjs --print       # 只预览，不改文件
node scripts/install-dsh.mjs --uninstall   # 卸载
```

脚本会自动用当前 `node.exe` 的绝对路径、把原来的条目替换掉（**不会重复**），
并在首次修改前备份为 `cordis.patch.yml.bak-tunnel-mcp`。实测三种路径：
`added` / `refreshed` / `removed` / 再卸 `noop`，都只动这一个 entry。

**手动注册：** 在 `C:\Users\Administrator\.dsh\cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-tunnel-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: dsh_tunnel
        transport: stdio
        command: C:\Program Files\nodejs\node.exe
        args:
          - F:\Agent yy\DSH\DSH改造\tunnel-mcp\bin\dsh-tunnel-mcp.mjs
        failOnStartupError: false
        toolCallTimeoutMs: 120000
        reconnect:
          enabled: true
          maxAttempts: 20
```

同一份配置也留了一份在本目录的
[`dsh-tunnel-mcp.patch.yml`](./dsh-tunnel-mcp.patch.yml)，
删掉 `cordis.patch.yml` 里对应的 `- insert:` 块即可卸载。

### 可选：Cloudflare API 令牌

命名隧道的本地配置「看起来对」不等于 Cloudflare 那边真的对
（隧道可能已被删、DNS 记录可能缺失）。设置令牌后即可用
`cloudflare_verify` 直接从 Cloudflare 侧确认：

```
权限：Zone:Read、Cloudflare Tunnel:Read、Zone:DNS:Read
```

把 `CLOUDFLARE_API_TOKEN` 加到该 entry 的 `env` 里即可。**没有令牌也能用**，
只是只能做本地检查——这一点工具会明确说明，不会假装验证过。

---

## 6. Desktop 应用端改动

改了 `E:\Deepseek harness\zhuomianjiangou-0.1.5-rc.3`：

| 文件 | 改动 |
|---|---|
| `remote-gateway.cjs` | 新增 `readNamedTunnelConfig()` / `startNamedTunnel()`；`startPublicTunnel()` 优先用命名隧道，没有配置就**回退**到原来的 quick 隧道；状态里增加 `stable` 和 `hostname`；新增 `writeGatewayStatusFile()` 记录网关端口 |
| `test-named-tunnel.cjs` | 新增 9 项测试 |

原始文件已备份为 `remote-gateway.cjs.pre-tunnel-mcp-20261016`，
`main.cjs.pre-tunnel-mcp-20261016`。

**兼容性**：`readNamedTunnelConfig()` 在没有配置文件时返回 `null`，
Desktop 行为与改动前完全一致（继续用 quick 隧道）。已实测确认。

> 注意：`remote-gateway.cjs` 在打包后的 `app.asar` 里。要让**已安装的**
> Desktop 生效，需要在项目里执行 `npm run dist` 重新打包并重装。

---

## 7. 目录结构

```
tunnel-mcp/
├── bin/
│   ├── dsh-tunnel-mcp.mjs     stdio 入口（MCP 服务器）
│   └── gateway.mjs            独立常驻网关进程（start/status/stop）
├── src/
│   ├── server.mjs             MCP 服务器 + 19 个工具
│   ├── gateway-server.mjs     手机网关：配对认证 + 反代 + 兼容脚本注入
│   ├── pairing.mjs            跨进程共享的一次性配对码
│   ├── mobile-compat.mjs      移植自 Desktop 的手机版布局脚本
│   ├── harness.mjs            拉起/定位 DSH 并捕获 token
│   ├── tunnel.mjs             cloudflared 生命周期（命名/临时）
│   ├── config.mjs             解析/生成 cloudflared 配置
│   ├── cloudflare.mjs         Cloudflare API 校验（可选）
│   ├── autostart.mjs          Startup 启动器
│   ├── gateway.mjs            读取桌面端网关状态、OS 端口发现
│   ├── probe.mjs              DNS/连通性/抖动诊断
│   ├── desktop-settings.mjs   写 Desktop 的 remote-settings.json
│   └── paths.mjs              各平台路径
├── scripts/
│   ├── smoke.mjs              12 项 MCP 协议测试
│   ├── find-harness-token.mjs 从运行中的 harness 内存取回 token
│   ├── verify-permanent-url.mjs 永久地址公网端到端验证
│   ├── named-tunnel-runtime.mjs 命名隧道运行时验证
│   ├── install-dsh.mjs        注册/卸载 MCP 条目
│   ├── patch-installed-desktop.mjs 给已安装 Desktop 打/回退补丁
│   └── e2e-tunnel.mjs         真实临时隧道 + 公网回访
├── test/                      32 项单元测试
└── dsh-tunnel-mcp.patch.yml   DSH 注册配置
```

---

## 8. 测试与验证

```powershell
cd 'F:\Agent yy\DSH\DSH改造\tunnel-mcp'

npm test                          # 32 项单元测试
npm run smoke                     # 12 项 MCP 协议测试（不起隧道）
npm run verify:named              # 命名隧道运行时（合成凭据，验证配置/参数/失败上报）
npm run verify:permanent          # 永久地址公网端到端（起真实隧道 + 绕开 VPN 的 DNS 拦截回访）
npm run inspect:cloudflare        # 读 cert.pem 检查 Cloudflare 侧 zone/隧道/DNS 状态
npm run verify:e2e                # 真实临时隧道 + 公网回访（需要外网）
```

Desktop 端：

```powershell
cd 'E:\Deepseek harness\zhuomianjiangou-0.1.5-rc.3'
node test-remote-gateway.cjs      # 原有用例，必须继续通过
node test-named-tunnel.cjs        # 新增命名隧道用例
```

---

## 9. 排障

**地址能生成但手机连不上**
先跑 `tunnel_verify attempts=10`。如果成功率为 0：
- 关掉 VPN / 代理再试（这是本机实测到的头号原因）
- 确认 Cloudflare 里域名为 Active、DNS 记录存在
- 确认 `tunnel_status` 的 `state` 是 `running`

**`tunnel_diagnostics` 报 `cloudflared is not logged in`**
执行 `cloudflared tunnel login`。凭据在 `~/.cloudflared/cert.pem`。

**报 `no named tunnel UUID found`**
`cloudflared tunnel create <名字>` 没跑，或跑在了另一个 Windows 用户下。

**DNS 解析出 `198.18.x.x`**
这是 VPN 的 fake-IP。说明有代理在本地伪造 DNS 应答，
必须关闭它，否则隧道数据通路会被重置。

**`domain_check` 报 NS 为空 / node 的 DNS 查询报 `ECONNREFUSED`**
本机 VPN 把 DNS 指向了 `127.0.0.1`，Node 的 `dns.resolve*` 直连
53 端口会被拒绝。工具会自动改用 **DNS-over-HTTPS**
（`cloudflare-dns.com/dns-query`）拿到真实公网解析结果，并同时列出
「本机看到的地址」和「公网真实地址」供对比。

**端口找不到**
桌面端网关端口是随机的。`gateway.mjs` 用一次 CIM 查询挑出
**可执行文件路径包含 `DeepSeek Harness`** 的进程，再取其监听端口，
并发探测（最多 6 个并发、每个 1.5 秒超时）。只匹配 `electron`
会误扫到 VS Code / Cursor 等无关应用，实测会让发现过程慢到 80 秒以上。
也可以手动指定：`tunnel_configure origin=http://127.0.0.1:<端口>`。

---

## 10. 已知限制

- **VPN 会破坏隧道的本机验证**。本机 VPN 把 `dsh.xinqiaopsy.top` 和公共 DNS
  都解析成 `198.18.0.0/15` 的伪造地址，所以在本机直接请求那个地址会**间歇性
  超时**（实测：同一秒内未配对请求超时、配对请求却成功）。
  **手机如果在同一个 VPN 网络下也会遇到同样问题**；换手机流量或关掉 VPN 即可。
- **`stable` 的含义**：仅当命名隧道**正在运行**时为 true。已配置但未启动、
  或启动失败时都是 false（另有 `addressPermanent` 表示域名永久性）。
- **网关不可用时会拒绝启动隧道**：如果目标端口没有监听，`tunnel_start` 会报错
  而不是发布一个指向空地址的 URL。
- **harness cookie 以明文存在** `<state>/gateway.json`，因为脱离进程启动时需要它。
  该文件带有你的会话凭据，请勿分享。吊销方式是重启 harness（cookie 随之失效）。
- **远程控制整台电脑还没做**（截屏 + 鼠标键盘）。当前手机拿到的是 DSH 界面。
- MCP 工具只读取 Desktop 状态；写操作只有 `tunnel_apply_to_desktop`、
  `gateway_*` 与 `scripts/install-dsh.mjs`，且都会留 `.bak-tunnel-mcp` 备份。
- 当前 Desktop 自带的 cloudflared 是 `2026.8.2`，Cloudflare 提示可升到
  `2026.10.1`；不影响功能。
- **已安装的 DeepSeek Harness Desktop 保持原版**（我打过的补丁已按哈希回退）。
  本方案不依赖它。

## 11. 脱离 Desktop 的方案（已实现）

手机通过永久地址访问**当前这个 DSH**，完全不依赖 DeepSeek Harness Desktop。

```
手机 ──https://dsh.xinqiaopsy.top──► Cloudflare ──► cloudflared
                                                        │
                                                        ▼
                                       本 MCP 服务器的手机网关（自实现）
                                       配对码 → 设备令牌 cookie
                                                        │  自动带 dsh-auth cookie
                                                        ▼
                                       http://127.0.0.1:<DSH web 端口>
```

### 为什么需要 token

DSH 0.1.5+ **对 loopback 请求也要求认证**（实测 `GET /` → 401，
`GET /?token=错` → 401）。Desktop 的做法是拿启动 token 换 cookie：

```js
// 参考 remote-gateway.cjs:2418
const entry = new URL(`/?token=${token}`, harnessUrl)
const upstream = await fetch(entry, { redirect: 'manual' })
this.harnessCookie = String(upstream.headers.get('set-cookie')).split(';')[0]
```

token 由 harness 生成，只通过 IPC 交给启动它的父进程，**不落盘**。

### token 是怎么拿到的

`scripts/find-harness-token.mjs`：用 koffi FFI 调
`OpenProcess` + `VirtualQueryEx` + `ReadProcessMemory`，从**正在运行的
DSH 进程内存**里扫出 `token=` 候选，然后**逐个用 HTTP 验证**，只有返回
303（换到 cookie）才采用。所以：

- 不需要重启 DSH、不打断当前会话
- 只读，不写入目标进程
- 找不到就如实报错，不会拿假 token 硬撑

### 四条增强（均已实现）

| # | 能力 | 实现 |
|---|---|---|
| 1 | **网关独立常驻** | `gateway_detach` 用 detached 子进程跑 `bin/gateway.mjs`，DSH 重启不影响它。实测：MCP 子进程重启后网关(27220)与隧道(7000)存活 |
| 2 | **开机自启** | `gateway_autostart install=true` 写 Startup 启动器 `dsh-mobile-gateway.cmd` |
| 3 | **token 自愈** | 网关收到 401 时自动重新扫内存取新 token 并重试原请求一次 |
| 4 | **手机版布局** | `src/mobile-compat.mjs`，移植 Desktop 的 `installRemoteMobileLayout` / `markRemoteMobileLayout` / `setMobileNavOpen` / `ensureMobileTopbar` 等 + 完整移动端 CSS |

**网关还自己持有隧道**：因为网关端口每次重启都会变，必须由持有隧道的一方
重写 ingress 目标。cloudflared 退出后每 5 秒自动重启，**域名不变**。

### 手机端怎么「下载」

**不需要下载 App。** 手机端是网页，用浏览器打开
`https://dsh.xinqiaopsy.top` 即可。要更接近原生体验就**添加到主屏幕**：

- **iPhone（Safari）**：分享 → 添加到主屏幕
- **Android（Chrome）**：⋮ → 添加到主屏幕 / 安装应用

网关已经为这一步准备好了一切（`src/pwa.mjs`）：

| 资源 | 路径 | 说明 |
|---|---|---|
| Web App Manifest | `/_dsh_mobile/manifest.webmanifest` | `display: standalone`，全屏无地址栏 |
| 应用图标 | `/_dsh_mobile/icon.png` | 192×192 RGBA PNG，**代码程序化生成**，仓库里不放二进制 |
| iOS meta 标签 | 注入每个 HTML 页 | `apple-mobile-web-app-capable` 等 |
| 安卓适配 | manifest + `theme-color` | 含 `maskable` 图标 |

**关键点**：manifest 与图标**不需要配对就能访问**——否则浏览器在第一次访问时
无法提供「安装」入口。其余路径仍然要求配对。

`100dvh` 已补上 `100vh` 降级，这样 iOS 15.4 以下（不支持 `dvh`）也不会塌陷。

**什么时候才值得真的封装成 App**：需要离线可用、推送通知、后台定位、
或上架应用商店时。否则封装只会带来「每次改代码都要重新打包分发」的负担。


### 配对码跨进程共享

配对码由 MCP 工具创建、由网关进程消费，所以放在共享文件
`<state>/pairings.json`（`src/pairing.mjs`），而不是内存里。

### 实测证据

| 验证项 | 结果 |
|---|---|
| 从运行中的 DSH 内存取 token | 768 候选中验证出 1 个 |
| token 换 cookie | HTTP 303（错 token 则 401） |
| 公网配对 | 200，`Secure` cookie |
| 配对码一次性 | 重放返回 403 |
| **带 cookie 访问 `/`** | **200，`<title>DeepSeek Harness</title>`，37235 字节** |
| 未配对深路径 | 401 |
| 移动端 CSS 下发 | 200，30610 字节，含 `dsh-mobile-layout` |
| DSH 重启后网关存活 | ✅ 网关与隧道都在 |


目标：手机通过永久地址访问**当前这个 DSH**，不再依赖 DeepSeek Harness Desktop。

```
手机 ──https://dsh.xinqiaopsy.top──► Cloudflare ──► cloudflared
                                                        │
                                                        ▼
                                       本 MCP 服务器的手机网关（自实现）
                                       配对码 → 设备令牌 cookie
                                                        │
                                                        ▼  带上 dsh-auth cookie
                                       http://127.0.0.1:<DSH web 端口>
```

