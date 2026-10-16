# 固定域名改动说明（分支 `feature/permanent-domain`）

本分支把手机的连接地址从「每次重启都换」的临时隧道改成**永久固定域名**，
并给桌面端补上托盘入口。`main` 分支未改动。

## 为什么要改

Cloudflare Quick Tunnel 每次启动都会分配一个随机的
`https://<随机名>.trycloudflare.com` 地址。地址一变，手机上次的配对就作废，
必须重新扫码——这正是「隔段时间就要重新连接」的根因。

命名隧道（Named Tunnel）的地址是一条 DNS 记录，指向隧道 UUID，
**只要隧道存在，地址就不变**。

## 改了什么

| 文件 | 改动 |
|---|---|
| `desktop/remote-gateway.cjs` | 新增命名隧道支持；未配置时回退到临时隧道 |
| `desktop/tray-menu.cjs` | **新增** 托盘菜单构造（纯 Node，可单测） |
| `desktop/companion.cjs` | 接入托盘；关闭窗口不再退出进程 |
| `desktop/test-tray-menu.cjs` | **新增** 托盘菜单测试 |
| `desktop/test-remote-gateway.cjs` | 新增命名隧道解析/配置用例 |
| `android/.../MainActivity.kt` | 除 `*.trycloudflare.com` 外，也接受钉住的永久域名 |
| `android/app/build.gradle.kts` | 新增 `REMOTE_PINNED_HOSTS`，可用 `-PremotePinnedHosts` 覆盖 |

### 命名隧道怎么被发现的

优先级：构造参数 → 环境变量 → cloudflared 自己的磁盘状态。

环境变量：

| 变量 | 含义 |
|---|---|
| `DSH_TUNNEL_HOSTNAME` | 永久域名，如 `dsh.xinqiaopsy.top` |
| `DSH_TUNNEL_ID` | 隧道 UUID（可省略，自动从凭据文件名推断） |
| `DSH_TUNNEL_CREDENTIALS` | 凭据 JSON 路径（可省略，自动在 `~/.cloudflared` 查找） |
| `CLOUDFLARED_HOME` | cloudflared 配置目录，默认 `~/.cloudflared` |

**必须有 hostname 才会启用命名隧道**——没有固定地址就无从谈起「永久」，
此时会静默回退到临时隧道，不会报错。

启动时**重写** `cloudflared-named.yml`，因为网关的本地端口是随机分配的，
ingress 目标必须跟着端口走。末尾保留 `http_status:404` 兜底，
避免未知域名被转发到手机网关。

### 上游端口自动发现

桌面端**不再要求手动指定 Harness 端口**。解析顺序：

1. `--upstream` 参数
2. `DSH_UPSTREAM_URL` 环境变量
3. **自动发现**
4. 兜底：仓库原本的默认值 `32145`

自动发现的步骤：

1. 先试已知端口 **`19387`**（本机 DSH 常用），命中就立即返回，连进程表都不查
2. 否则做**一次** CIM 查询，同时匹配进程名**和**可执行文件路径都含
   `DeepSeek Harness` 的进程——只匹配进程名会误抓其他 Electron 应用
3. 取出这些进程监听的回环端口
4. 每个候选都做一次 HTTP 探测确认（**401 = 未认证的 Harness，200 = 已认证**），
   避免把失效的监听端口误当成 Harness
5. 全都不通才回退到 `32145`

**显式的 `--upstream` 或环境变量永远不会被重新解析**，所以人为指定不会被
本机其他端口悄悄覆盖。

要完全关掉探测：`DSH_TUNNEL_DISABLE_DISCOVERY=1`（此时直接用默认值，不探测）。

### 判断隧道真正就绪

命名隧道不能只看进程是否活着。本实现等待 cloudflared 输出
`Registered tunnel connection` 才认为就绪；45 秒未就绪即报超时。
进程存活但隧道断开时，状态回到 `Retrying` 并自动重连。

## 构建

### Android APK

**构建前必读：Android Gradle 插件在 Windows 上拒绝非 ASCII 项目路径。**
本项目若位于含中文的目录（如 `F:\Agent yy\DSH\DSH改造\...`）会直接失败：

```
Your project path contains non-ASCII characters.
```

解决办法是把项目放到纯 ASCII 路径再构建，例如：

```powershell
robocopy "F:\Agent yy\DSH\DSH改造\dsh-harness-mobile-bridge-mi" "F:\dsh-remote-build" /E /XD node_modules .gradle build dist
cd F:\dsh-remote-build\android
"sdk.dir=C:\\Users\\<你>\\AppData\\Local\\Android\\Sdk" | Set-Content local.properties -Encoding ASCII
$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
.\gradlew.bat assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`

换域名（多个用逗号分隔）：

```powershell
.\gradlew.bat assembleDebug "-PremotePinnedHosts=dsh.example.com,other.example.com"
```

注意 PowerShell 里**必须加引号**，否则 `=a.b` 里的点会被当成任务名缩写解析。

### 签名

- `debug` 构建用调试密钥，自动签名，可直接安装试用。
- `release` 构建**仅在设置了 `DSH_ANDROID_KEYSTORE` 时才签名**，否则产出
  未签名 APK，装不上手机。
- **签名不一致的 APK 无法覆盖安装**。如果在手机上装的是别的密钥签的版本，
  需要先卸载再装。

### 桌面端

```powershell
cd desktop
npm ci
npm run prepare:cloudflared   # 下载并校验 cloudflared
npm start -- --upstream http://127.0.0.1:19387
npm run dist                  # 打包安装程序
```

## 测试

```powershell
cd desktop
node test-tray-menu.cjs        # 托盘菜单
node test-input-helper.cjs     # 输入助手
node test-remote-gateway.cjs   # 网关 + 命名隧道
```

> **Electron 测试需要先清掉 `ELECTRON_RUN_AS_NODE`**，否则
> `require('electron')` 会返回 undefined：
> ```powershell
> Remove-Item Env:ELECTRON_RUN_AS_NODE
> node_modules\.bin\electron.cmd test-mobile-layout.cjs
> ```

## 已知限制

- 桌面端默认上游是 `127.0.0.1:32145`，若你的 Harness 监听别的端口，
  用 `--upstream` 或 `DSH_UPSTREAM_URL` 指定。
- `remote.html` 里显示的二维码内容仍由网关按当前 `remoteUrl` 生成，
  因此命名隧道生效后二维码自然指向永久域名，无需另行改动。
- 本机 VPN 若劫持该域名解析，会导致本机自测失败；手机不在同一 VPN 下不受影响。
