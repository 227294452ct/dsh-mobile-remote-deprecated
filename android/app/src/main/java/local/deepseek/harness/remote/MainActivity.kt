package local.deepseek.harness.remote

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : FragmentActivity() {
    companion object {
        private const val PREFS = "dsh_remote"
        private const val KEY_ALIAS = "dsh_remote_device_key_v1"
        private const val KEY_REQUIRES_AUTH = "key_requires_auth"
        private const val API_PREFIX = "/_dsh_remote/v1"
        private const val BACKGROUND_LOCK_MS = 5 * 60_000L
        private const val CAMERA_UPLOAD_DIRECTORY = "camera_uploads"
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    private lateinit var root: FrameLayout
    private lateinit var welcome: LinearLayout
    private lateinit var webView: WebView
    private lateinit var statusText: TextView
    private lateinit var progress: ProgressBar
    private lateinit var manualInput: EditText
    private var currentHost = ""
    private var pendingPairingId = ""
    private var pendingPairingSecret = ""
    private var pendingPairingExpiry = 0L
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingFileChooser: FileChooserRequest? = null
    private var pendingCameraUri: Uri? = null
    private var pendingWebCameraRequest: PermissionRequest? = null
    private var stoppedAt = 0L
    private var biometricInFlight = false
    private var pendingDownload: DownloadSpec? = null
    private var backDecisionPending = false
    private var webViewRendererGone = false

    private val scanLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            result.data?.getStringExtra(ScanPairingActivity.EXTRA_QR_CONTENT)?.let(::handlePairingUri)
        }
    }

    private val scannerCameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchScanner()
        else showWelcome("需要相机权限才能扫描电脑端配对二维码。你也可以粘贴配对链接。")
    }

    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uris = if (result.resultCode == Activity.RESULT_OK) {
            extractChosenUris(result.data).ifEmpty { listOfNotNull(pendingCameraUri) }
        } else emptyList()
        finishFileChooser(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    private val fileCameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingFileChooser
        if (request == null || fileCallback == null) return@registerForActivityResult
        if (granted) launchFileChooser(request)
        else {
            Toast.makeText(this, "未授予相机权限，无法拍照上传。", Toast.LENGTH_LONG).show()
            if (request.captureEnabled) finishFileChooser(null)
            else launchFileChooser(request, includeCamera = false)
        }
    }

    private val webCameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingWebCameraRequest
        pendingWebCameraRequest = null
        if (request == null) return@registerForActivityResult
        if (granted && isTrustedRemoteOrigin(request.origin) && request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else request.deny()
    }

    private val storagePermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val download = pendingDownload
        pendingDownload = null
        if (granted && download != null) enqueueDownload(download)
        else Toast.makeText(this, "未授予存储权限，文件没有下载。", Toast.LENGTH_LONG).show()
    }

    private val backgroundLock = Runnable {
        closeRemoteSession()
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.WHITE
        window.navigationBarColor = Color.WHITE
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = true
        buildUi()
        configureWebView()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.visibility != View.VISIBLE) {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    return
                }
                if (backDecisionPending) return
                backDecisionPending = true
                webView.evaluateJavascript("Boolean(document.querySelector('[data-dsh-remote-desktop-viewer]'))") { result ->
                    backDecisionPending = false
                    if (result == "true") return@evaluateJavascript
                    if (webView.canGoBack()) webView.goBack()
                    else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()

        val deepLink = intent?.data?.toString()
        if (!deepLink.isNullOrBlank()) {
            handlePairingUri(deepLink)
        } else if (prefs.getBoolean("paired", false)) {
            val savedHost = prefs.getString("host", "") ?: ""
            if (validRemoteHost(savedHost)) {
                currentHost = savedHost
                authenticateThenConnect()
            } else {
                prefs.edit().remove("paired").remove("host").apply()
                showWelcome("连接方式已升级。请在电脑端重新生成二维码，手机不再需要 Tailscale。")
            }
        } else {
            showWelcome("请先在电脑端打开“手机远程”，然后扫描配对二维码。")
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.toString()?.let(::handlePairingUri)
    }

    override fun onStart() {
        super.onStart()
        mainHandler.removeCallbacks(backgroundLock)
        if (stoppedAt > 0 && System.currentTimeMillis() - stoppedAt >= BACKGROUND_LOCK_MS && prefs.getBoolean("paired", false)) {
            CookieManager.getInstance().removeAllCookies(null)
            webView.visibility = View.GONE
            welcome.visibility = View.VISIBLE
            authenticateThenConnect()
        }
        stoppedAt = 0L
    }

    override fun onStop() {
        super.onStop()
        stoppedAt = System.currentTimeMillis()
        mainHandler.postDelayed(backgroundLock, BACKGROUND_LOCK_MS)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        pendingWebCameraRequest?.deny()
        pendingWebCameraRequest = null
        finishFileChooser(null)
        if (!webViewRendererGone) webView.destroy()
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun buildUi() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.WHITE) }
        welcome = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(28), dp(52), dp(28), dp(28))
        }
        val logo = ImageView(this).apply {
            setImageResource(R.drawable.ic_launcher)
            layoutParams = LinearLayout.LayoutParams(dp(86), dp(86))
        }
        val title = TextView(this).apply {
            text = "DeepSeek Harness"
            textSize = 27f
            setTextColor(Color.rgb(20, 34, 51))
            gravity = Gravity.CENTER
            setPadding(0, dp(22), 0, dp(4))
        }
        val subtitle = TextView(this).apply {
            text = "内置安全连接，无需额外 VPN 应用"
            textSize = 14f
            setTextColor(Color.rgb(104, 126, 151))
            gravity = Gravity.CENTER
        }
        statusText = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.rgb(91, 114, 140))
            gravity = Gravity.CENTER
            setPadding(0, dp(26), 0, dp(12))
        }
        progress = ProgressBar(this).apply { visibility = View.GONE }
        val scan = actionButton("扫描电脑二维码", true).apply {
            setOnClickListener { startScanner() }
        }
        manualInput = EditText(this).apply {
            hint = "也可以粘贴 dshremote:// 配对链接"
            textSize = 13f
            setSingleLine(true)
            setPadding(dp(14), 0, dp(14), 0)
            background = rounded(Color.rgb(244, 247, 251), dp(12))
        }
        val manual = actionButton("连接粘贴的地址", false).apply {
            setOnClickListener { handlePairingUri(manualInput.text.toString()) }
        }
        welcome.addView(logo)
        welcome.addView(title)
        welcome.addView(subtitle)
        welcome.addView(statusText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        welcome.addView(progress, LinearLayout.LayoutParams(dp(32), dp(32)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(14) })
        welcome.addView(scan, fullWidthParams(dp(10)))
        welcome.addView(manualInput, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)).apply { topMargin = dp(12) })
        welcome.addView(manual, fullWidthParams(dp(10)))

        webView = WebView(this).apply { visibility = View.GONE; setBackgroundColor(Color.WHITE) }
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(welcome, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
    }

    @Suppress("SetJavaScriptEnabled")
    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
            setGeolocationEnabled(false)
            userAgentString = "$userAgentString DSHRemote/0.2.4"
        }
        webView.settings.safeBrowsingEnabled = true
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                val approved = runCatching { Uri.parse(currentHost).host }.getOrNull()
                return if (uri.scheme == "https" && uri.host.equals(approved, ignoreCase = true) && uri.port == 8443) false
                else { startActivity(Intent(Intent.ACTION_VIEW, uri)); true }
            }

            override fun onPageFinished(view: WebView, url: String) {
                progress.visibility = View.GONE
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                webViewRendererGone = true
                Log.e("DSHRemote", "WebView renderer exited; didCrash=${detail.didCrash()}")
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                Toast.makeText(this@MainActivity, "远程页面渲染异常，正在自动重新连接…", Toast.LENGTH_LONG).show()
                mainHandler.post { if (!isFinishing && !isDestroyed) recreate() }
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                finishFileChooser(null)
                fileCallback = callback
                val request = FileChooserRequest(
                    acceptTypes = normalizeAcceptTypes(params.acceptTypes),
                    allowMultiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE,
                    captureEnabled = params.isCaptureEnabled
                )
                pendingFileChooser = request
                val cameraNeeded = request.captureEnabled && request.acceptsImages
                if (cameraNeeded && ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    fileCameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                } else launchFileChooser(request)
                return true
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (!isTrustedRemoteOrigin(request.origin) || !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                        request.deny()
                        return@runOnUiThread
                    }
                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        pendingWebCameraRequest?.deny()
                        pendingWebCameraRequest = request
                        webCameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                    }
                }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingWebCameraRequest === request) pendingWebCameraRequest = null
            }
        }
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            val download = DownloadSpec(url, userAgent, contentDisposition, mimeType)
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                pendingDownload = download
                storagePermissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            } else enqueueDownload(download)
        })
    }

    private fun enqueueDownload(download: DownloadSpec) {
        try {
            val request = DownloadManager.Request(Uri.parse(download.url))
                .setMimeType(download.mimeType)
                .addRequestHeader("User-Agent", download.userAgent)
                .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(download.url) ?: "")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, android.webkit.URLUtil.guessFileName(download.url, download.contentDisposition, download.mimeType ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension("bin")))
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
        } catch (error: Exception) {
            Toast.makeText(this, "无法保存下载文件：${error.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun normalizeAcceptTypes(rawTypes: Array<String>): List<String> {
        val types = rawTypes
            .flatMap { it.split(',') }
            .map { it.substringBefore(';').trim().lowercase() }
            .filter { it.isNotBlank() }
            .map { type ->
                if (type.startsWith('.')) {
                    MimeTypeMap.getSingleton().getMimeTypeFromExtension(type.removePrefix(".")) ?: "*/*"
                } else type
            }
            .distinct()
        return types.ifEmpty { listOf("*/*") }
    }

    private fun launchFileChooser(request: FileChooserRequest, includeCamera: Boolean = true) {
        try {
            val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = if (request.acceptTypes.size == 1) request.acceptTypes.first() else "*/*"
                if (request.acceptTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, request.acceptTypes.toTypedArray())
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, request.allowMultiple)
            }
            val camera = if (includeCamera && request.acceptsImages && hasCameraPermission()) createCameraIntent() else null
            if (request.captureEnabled && request.acceptsImages) {
                if (camera == null) throw IllegalStateException("相机不可用")
                fileChooserLauncher.launch(camera)
                return
            }
            val chooser = Intent.createChooser(picker, "选择要发送的文件")
            if (camera != null && !request.allowMultiple) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera))
            fileChooserLauncher.launch(chooser)
        } catch (error: Exception) {
            Toast.makeText(this, "无法打开文件选择器：${friendlyError(error)}", Toast.LENGTH_LONG).show()
            finishFileChooser(null)
        }
    }

    private fun createCameraIntent(): Intent? {
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        if (intent.resolveActivity(packageManager) == null) return null
        val directory = File(cacheDir, CAMERA_UPLOAD_DIRECTORY).apply { mkdirs() }
        val output = File.createTempFile("dsh-upload-", ".jpg", directory)
        val uri = FileProvider.getUriForFile(this, "${BuildConfig.APPLICATION_ID}.fileprovider", output)
        pendingCameraUri = uri
        return intent.apply {
            putExtra(MediaStore.EXTRA_OUTPUT, uri)
            clipData = android.content.ClipData.newRawUri("DeepSeek Harness camera upload", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
    }

    private fun extractChosenUris(intent: Intent?): List<Uri> {
        if (intent == null) return emptyList()
        val output = LinkedHashSet<Uri>()
        intent.data?.let(output::add)
        intent.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(output::add)
        }
        return output.toList()
    }

    private fun finishFileChooser(value: Array<Uri>?) {
        fileCallback?.onReceiveValue(value)
        fileCallback = null
        pendingFileChooser = null
        pendingCameraUri = null
    }

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun isTrustedRemoteOrigin(origin: Uri): Boolean = runCatching {
        val expected = Uri.parse(currentHost)
        val originPort = if (origin.port == -1) 443 else origin.port
        val expectedPort = if (expected.port == -1) 443 else expected.port
        origin.scheme.equals("https", ignoreCase = true) &&
            origin.host.equals(expected.host, ignoreCase = true) &&
            originPort == expectedPort
    }.getOrDefault(false)

    private fun handlePairingUri(raw: String) {
        try {
            val uri = Uri.parse(raw.trim())
            val host = uri.getQueryParameter("host") ?: ""
            val pairingId = uri.getQueryParameter("pairingId") ?: ""
            val secret = uri.fragment?.split('&')?.mapNotNull {
                val parts = it.split('=', limit = 2)
                if (parts.size == 2 && parts[0] == "secret") Uri.decode(parts[1]) else null
            }?.firstOrNull() ?: ""
            if (uri.scheme != "dshremote" || uri.host != "pair" || !validRemoteHost(host) || pairingId.isBlank() || secret.length < 32) {
                showWelcome("配对链接无效。请重新在电脑端生成二维码。")
                return
            }
            currentHost = host.trimEnd('/')
            pendingPairingId = pairingId
            pendingPairingSecret = secret
            submitPairingClaim()
        } catch (error: Exception) {
            showWelcome("无法读取配对二维码：${friendlyError(error)}")
        }
    }

    /**
     * Hostnames the app will pair with.
     *
     * Quick tunnels always land on `*.trycloudflare.com`, but that hostname changes
     * on every desktop restart, which forces a re-pair. A named tunnel keeps one
     * hostname for as long as the tunnel exists, so operators pin theirs here to
     * get a stable address. Anything beyond these suffixes is refused, because the
     * pairing link carries both a pairing id and a secret and must not be handed
     * to an arbitrary host.
     */
    private val pinnedRemoteHosts: List<String> = BuildConfig.REMOTE_PINNED_HOSTS
        .split(',')
        .map { it.trim().lowercase() }
        .filter { it.isNotEmpty() }

    private fun validRemoteHost(value: String): Boolean {
        return runCatching {
            val uri = Uri.parse(value)
            val host = uri.host?.lowercase() ?: return@runCatching false
            val allowed = host.endsWith(".trycloudflare.com") || pinnedRemoteHosts.any { host == it }
            uri.scheme == "https" && (uri.port == -1 || uri.port == 443) && allowed && uri.path.isNullOrEmpty()
        }.getOrDefault(false)
    }

    private fun submitPairingClaim() {
        showBusy("正在准备安全密钥并连接电脑…")
        executor.execute {
            try {
                val keyRequiresAuthentication = ensureDeviceKey()
                val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                val publicKey = keyStore.getCertificate(KEY_ALIAS)?.publicKey?.encoded
                    ?: throw IllegalStateException("无法读取手机安全密钥")
                val deviceId = prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("deviceId", it).apply() }
                val body = JSONObject()
                    .put("pairingId", pendingPairingId)
                    .put("secret", pendingPairingSecret)
                    .put("deviceId", deviceId)
                    .put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                    .put("publicKey", Base64.encodeToString(publicKey, Base64.NO_WRAP))
                val response = postJson("/pair/claim", body)
                runOnUiThread {
                    if (response.status == 202) {
                        val json = JSONObject(response.body)
                        pendingPairingExpiry = json.optLong("expiresAt")
                        val securityNotice = if (keyRequiresAuthentication) "" else "\n\n此手机未设置安全锁屏，将使用设备密钥连接；建议只在本人保管的手机上使用。"
                        showBusy("请核对电脑与手机数字一致：\n\n${json.optString("verificationCode")}\n\n然后在电脑端点击批准。$securityNotice")
                        pollPairingStatus()
                    } else showWelcome("配对请求失败：${errorText(response)}")
                }
            } catch (error: Exception) {
                runOnUiThread { showWelcome("配对连接失败：${friendlyError(error)}") }
            }
        }
    }

    private fun startScanner() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchScanner()
        } else {
            scannerCameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun launchScanner() {
        try {
            scanLauncher.launch(Intent(this, ScanPairingActivity::class.java))
        } catch (error: Exception) {
            showWelcome("无法启动扫码相机：${friendlyError(error)}。你也可以粘贴配对链接。")
        }
    }

    private fun pollPairingStatus() {
        if (System.currentTimeMillis() >= pendingPairingExpiry) {
            showWelcome("配对二维码已过期，请在电脑端重新生成。")
            return
        }
        mainHandler.postDelayed({
            executor.execute {
                try {
                    val response = postJson("/pair/status", JSONObject().put("pairingId", pendingPairingId).put("secret", pendingPairingSecret))
                    runOnUiThread {
                        if (response.status == 200 && JSONObject(response.body).optString("status") == "approved") {
                            prefs.edit().putBoolean("paired", true).putString("host", currentHost).apply()
                            pendingPairingSecret = ""
                            authenticateThenConnect()
                        } else pollPairingStatus()
                    }
                } catch (error: Exception) {
                    runOnUiThread { showWelcome("等待电脑批准时连接中断：${friendlyError(error)}。请重新生成二维码后再试。") }
                }
            }
        }, 2000)
    }

    private fun authenticateThenConnect() {
        if (biometricInFlight) return
        if (!prefs.getBoolean(KEY_REQUIRES_AUTH, true)) {
            showBusy("此手机未设置安全锁屏，正在使用设备密钥连接…")
            openRemoteSession()
            return
        }
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val capability = BiometricManager.from(this).canAuthenticate(authenticators)
        if (capability != BiometricManager.BIOMETRIC_SUCCESS) {
            showWelcome("请先在系统设置中启用指纹、面容或屏幕锁，才能使用完整远程权限。")
            return
        }
        biometricInFlight = true
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                biometricInFlight = false
                openRemoteSession()
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                biometricInFlight = false
                showWelcome("身份验证未完成：$errString")
            }
            override fun onAuthenticationFailed() { statusText.text = "未识别，请重试。" }
        })
        prompt.authenticate(BiometricPrompt.PromptInfo.Builder()
            .setTitle("解锁 DeepSeek Harness")
            .setSubtitle("验证后连接拥有完整权限的桌面工作台")
            .setAllowedAuthenticators(authenticators)
            .build())
    }

    private fun openRemoteSession() {
        showBusy("正在建立安全会话…")
        executor.execute {
            try {
                val deviceId = prefs.getString("deviceId", "") ?: ""
                val challengeResponse = postJson("/session/challenge", JSONObject().put("deviceId", deviceId))
                if (challengeResponse.status != 200) throw IllegalStateException(errorText(challengeResponse))
                val challenge = JSONObject(challengeResponse.body)
                val challengeId = challenge.getString("challengeId")
                val nonce = challenge.getString("nonce")
                val payload = "dsh-remote-v1|$deviceId|$challengeId|$nonce".toByteArray(Charsets.UTF_8)
                val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                val privateKey = keyStore.getKey(KEY_ALIAS, null) as java.security.PrivateKey
                val signature = Signature.getInstance("SHA256withECDSA").apply { initSign(privateKey); update(payload) }.sign()
                val openResponse = postJson("/session/open", JSONObject()
                    .put("deviceId", deviceId)
                    .put("challengeId", challengeId)
                    .put("signature", Base64.encodeToString(signature, Base64.NO_WRAP)))
                if (openResponse.status != 200 || openResponse.setCookie.isNullOrBlank()) throw IllegalStateException(errorText(openResponse))
                val cookie = openResponse.setCookie.substringBefore(';') + "; Path=/; Secure; HttpOnly; SameSite=Strict"
                runOnUiThread {
                    CookieManager.getInstance().removeAllCookies {
                        CookieManager.getInstance().setCookie(currentHost, cookie) {
                            CookieManager.getInstance().flush()
                            welcome.visibility = View.GONE
                            webView.visibility = View.VISIBLE
                            progress.visibility = View.VISIBLE
                            webView.loadUrl(currentHost)
                        }
                    }
                }
            } catch (error: Exception) {
                runOnUiThread { showWelcome("安全连接失败：${error.message}") }
            }
        }
    }

    private fun closeRemoteSession() {
        if (currentHost.isBlank()) return
        val cookie = CookieManager.getInstance().getCookie(currentHost)
        executor.execute { runCatching { postJson("/session/close", JSONObject(), cookie) } }
    }

    private fun ensureDeviceKey(): Boolean {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keyStore.containsAlias(KEY_ALIAS)) return prefs.getBoolean(KEY_REQUIRES_AUTH, true)
        val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val requiresAuthentication = keyguardManager.isDeviceSecure
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        val builder = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(requiresAuthentication)
        if (requiresAuthentication) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setUserAuthenticationParameters(300, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            } else {
                @Suppress("DEPRECATION")
                builder.setUserAuthenticationValidityDurationSeconds(300)
            }
        }
        generator.initialize(builder.build())
        generator.generateKeyPair()
        prefs.edit().putBoolean(KEY_REQUIRES_AUTH, requiresAuthentication).apply()
        return requiresAuthentication
    }

    private fun postJson(path: String, body: JSONObject, cookie: String? = null): HttpResult {
        val connection = URL("$currentHost$API_PREFIX$path").openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.connectTimeout = 15_000
        connection.readTimeout = 20_000
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        connection.setRequestProperty("Accept", "application/json")
        if (!cookie.isNullOrBlank()) connection.setRequestProperty("Cookie", cookie)
        connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        val status = connection.responseCode
        val stream = if (status in 200..399) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        val setCookie = connection.getHeaderField("Set-Cookie")
        connection.disconnect()
        return HttpResult(status, text, setCookie)
    }

    private fun errorText(result: HttpResult): String = runCatching { JSONObject(result.body).optString("error") }.getOrDefault(result.body).ifBlank { "HTTP ${result.status}" }
    private fun friendlyError(error: Exception): String = error.message?.takeIf { it.isNotBlank() } ?: error.javaClass.simpleName

    private fun showWelcome(message: String) {
        welcome.visibility = View.VISIBLE
        webView.visibility = View.GONE
        progress.visibility = View.GONE
        statusText.text = message
    }

    private fun showBusy(message: String) {
        welcome.visibility = View.VISIBLE
        webView.visibility = View.GONE
        progress.visibility = View.VISIBLE
        statusText.text = message
    }

    private fun actionButton(textValue: String, primary: Boolean): Button = Button(this).apply {
        text = textValue
        textSize = 14f
        isAllCaps = false
        setTextColor(if (primary) Color.WHITE else Color.rgb(37, 80, 132))
        background = rounded(if (primary) Color.rgb(40, 125, 255) else Color.rgb(237, 244, 252), dp(13))
    }

    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = radius.toFloat() }
    private fun fullWidthParams(top: Int) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)).apply { topMargin = top }
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    data class HttpResult(val status: Int, val body: String, val setCookie: String?)
    data class DownloadSpec(val url: String, val userAgent: String, val contentDisposition: String?, val mimeType: String?)
    data class FileChooserRequest(val acceptTypes: List<String>, val allowMultiple: Boolean, val captureEnabled: Boolean) {
        val acceptsImages: Boolean
            get() = acceptTypes.any { it == "*/*" || it == "image/*" || it.startsWith("image/") }
    }
}
