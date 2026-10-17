> [!WARNING]
> **本项目已废弃（DEPRECATED），仅作归档备份保留。**
>
> 手机远程方案已放弃：依赖 Cloudflare 隧道时边缘节点不可控（中国移动常被调度到
> 洛杉矶，实测 1.4~5 秒延迟、50% 请求失败），且无法在免费方案内稳定解决。
>
> 归档内容：
> - `desktop/` `android/` — 手机远程客户端与伴侣应用（含永久命名隧道、托盘、
>   HTTP/2 传输、harness 认证、隧道看门狗与边缘自愈）
> - `mcp-tunnel/` — 配套的 DSH MCP 隧道插件
>
> 最后提交：efcf246
# DeepSeek Harness Remote

一个独立的 DeepSeek Harness 远程连接组件：电脑端把**已经在本机运行的 Harness Web 服务**通过 HTTPS 安全隧道转发，Android 端扫码配对后即可远程使用。

> 本仓库只包含远程桥接与 Android 客户端，不包含 DeepSeek Harness/DSH 本体源码、运行时或模型。

## 功能

- Android 端只安装一个 APK，不要求另外安装 Tailscale。
- Cloudflare Quick Tunnel 自动提供临时 HTTPS 公网入口。
- 五分钟一次性二维码与两端六位数字核对。
- Android Keystore 中的 P-256 设备密钥；私钥不可导出。
- 电脑端批准、设备撤销、一小时短会话和 WebSocket 代理。
- 为旧版 Android WebView 补充 `Object.hasOwn`、`crypto.randomUUID`、`structuredClone` 和 `Array.prototype.at` 兼容实现。
- 手机端显示 Harness 工作区、会话和模型选择界面；数据仍由电脑上的 Harness 管理。
- 使用 Harness 官方应用内目录浏览器，手机和平板可以直接浏览并选择电脑目录，不会在电脑上弹出原生文件夹窗口。
- 手机目录选择器会列出当前可访问的 Windows 盘符，可从 `C:\` 直接切换到 `D:\`、`F:\` 等磁盘后继续使用 Harness 原有浏览、建目录和打开流程。
- 仅在手机远程页面注入常驻“桌面”入口，可查看主屏或副屏，通过触控、双指缩放/平移、中文/英文输入和常用快捷键控制 Windows 桌面。
- 多台已配对手机可以同时查看，但同一时刻只有一台获得控制；电脑端始终显示置顶提示，并可立即停止控制。
- 针对手机竖屏优化会话顶部栏、提问卡片和计划确认卡片，操作按钮不会被挤出可点击区域。

## 仓库结构

```text
android/   Android 扫码、设备认证与远程 WebView 客户端
desktop/   独立 Electron 配对面板、认证网关与 HTTPS 隧道
```

## 直接下载安装

已签名 APK 放在仓库的 [Releases](https://github.com/227294452ct/deepseek-harness-remote/releases) 页面。Android 首次安装时，可能需要为当前浏览器临时开启“允许安装未知应用”。

## 从源码运行

### 1. 启动 Harness Web 服务

本项目不捆绑 Harness。请使用你自己的 Harness 安装，并让 Web 服务只监听本机。远程客户端应加载仓库提供的目录选择补丁，这只切换 Harness 官方的目录选择组件，不包含或修改 DSH 源码。例如固定使用端口 `32145`：

```powershell
dsh web --patch .\desktop\dsh-remote.patch.yml --no-open --port 32145
```

加载补丁后，电脑、手机和平板都使用页面内的电脑目录浏览器；工作区记录仍保存在同一个电脑端 Harness 数据目录中，因此各设备共享同一份工作区列表。路径输入框也可以直接填写电脑上的绝对路径，例如 `D:\agentyy\codex`。

### 2. 启动电脑端远程桥接

需要 Windows x64、Node.js 22+ 和 npm：

```powershell
cd desktop
npm ci
npm run prepare:cloudflared
npm start -- --upstream http://127.0.0.1:32145
```

也可通过环境变量指定本机服务：

```powershell
$env:DSH_UPSTREAM_URL = 'http://127.0.0.1:32145'
npm start
```

`prepare:cloudflared` 只下载固定版本的 Windows x64 `cloudflared`，并核对 SHA-256；二进制不会提交到仓库。

### 3. 构建 Android

需要 JDK 17、Android SDK 34：

```powershell
cd android
.\gradlew.bat assembleDebug
```

调试 APK 位于 `android/app/build/outputs/apk/debug/`。

发布版签名通过环境变量提供，仓库不会读取或保存私钥：

```powershell
$env:DSH_ANDROID_KEYSTORE = 'C:\path\release.jks'
$env:DSH_ANDROID_KEYSTORE_PASSWORD = '...'
$env:DSH_ANDROID_KEY_ALIAS = 'alias'
$env:DSH_ANDROID_KEY_PASSWORD = '...'
.\build-release.ps1
```

### 4. 构建独立电脑端

```powershell
cd desktop
npm ci
npm run dist
```

构建产物不会包含 DSH，只包含远程桥接、目录选择配置和经哈希校验下载的 `cloudflared`。运行时需要另行启动本机 Harness Web 服务。

## 配对流程

1. 电脑端确认“远程访问已启用”。
2. 点击“配对新手机”，在 Android 应用中扫描二维码。
3. 核对手机和电脑显示的六位数字完全一致。
4. 在电脑端点击“数字一致，批准设备”。
5. 以后可直接从手机连接；不再使用的设备应在电脑端撤销。

## 网络与隐私说明

- Harness 上游永远限制为本机回环地址，不能配置成局域网或公网主机。
- Quick Tunnel 的公网域名每次重启可能变化，不提供固定域名或可用性承诺。
- 配对信息保存在 Electron 的 `userData` 目录，不进入源码仓库。
- 不要公开二维码、配对链接、设备记录、日志或 API 密钥。
- 远程桌面仅传输最高 1280 px、10 FPS 的 JPEG 画面，不传声音、剪贴板或文件；查看期间电脑显示不进入采集画面的全屏隐私遮罩，检测到本机鼠标点击、滚轮或键盘按下会立即终止手机桌面会话（单纯移动鼠标不会误触发）；慢连接会主动丢弃旧帧以保持实时性，锁屏、设备撤销、连接断开或本地停止时会立即释放远程按键和鼠标按钮。
- 首版桌面控制仅支持 Windows x64，不能操作 UAC 安全桌面、锁屏登录界面或完整性级别高于桌面程序的管理员窗口。

## 测试

```powershell
cd desktop
npm ci
npm test

cd ..\android
.\gradlew.bat assembleDebug
```

## 上游与许可证

本项目为社区扩展，并非 DeepSeek 官方产品。上游归属见 [NOTICE.md](NOTICE.md)，本仓库代码按 [MIT License](LICENSE) 发布。
