package com.sczzm.classroom;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 课堂助手 · 演示壳
 * 用系统 WebView 承载云端「课堂助手」网页版（含 AI 助教 Tab）。
 * - 默认直接打开 助教 页（#assist）
 * - 长按页面可修改服务器地址（隧道地址变更时用）
 * - 断网/加载失败有原生错误页 + 重试
 */
public class MainActivity extends Activity {

    public static final String PREFS = "classroom_demo";
    public static final String KEY_SERVER = "server_url";
    public static final String KEY_TOKEN = "app_token";
    public static final String DEFAULT_SERVER = "https://your-server.example.com";
    private static final String START_PATH = "/#assist";
    private static final String KEY_PERM_ASKED = "perm_asked_v1";
    private static final int REQ_LAUNCH_PERMS = 7002;

    private WebView web;
    private ProgressBar bar;
    private FrameLayout root;
    private LinearLayout errorBox;
    private TextView errorDetail;
    private SharedPreferences prefs;
    private Bridge bridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        configureWeb(web.getSettings());
        web.setWebViewClient(new DemoClient());
        web.setWebChromeClient(new DemoChrome());
        // 原生录音桥：window.ClassroomNative.start/stop/mark/status
        bridge = new Bridge(this, web);
        web.addJavascriptInterface(bridge, "ClassroomNative");
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                showServerDialog();
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgress(0);
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        bp.gravity = Gravity.TOP;
        bar.setLayoutParams(bp);
        root.addView(bar);

        errorBox = buildErrorView();
        errorBox.setVisibility(View.GONE);
        root.addView(errorBox, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);

        Window win = getWindow();
        win.setStatusBarColor(Color.WHITE);
        win.setNavigationBarColor(Color.WHITE);

        Toast.makeText(this, "长按页面可修改服务器地址", Toast.LENGTH_LONG).show();
        requestLaunchPermissions();
        loadStart();
    }

    private void configureWeb(WebSettings s) {
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setDefaultTextEncodingName("UTF-8");
    }

    /** 供 Bridge 读取当前服务器地址。 */
    public String serverUrl() {
        return currentServer();
    }

    /** 供 Bridge 读取上传令牌（x-app-token；未配置则为空字符串）。 */
    public String appToken() {
        String t = prefs.getString(KEY_TOKEN, "");
        return t == null ? "" : t.trim();
    }

    /** 首次启动申请录音与通知权限；后续由 Bridge.start() 按需再申请。 */
    private void requestLaunchPermissions() {
        if (Build.VERSION.SDK_INT < 23) {
            return;
        }
        boolean needRecord = checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED;
        boolean needNotify = Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED;
        if (!needRecord && !needNotify) {
            return;
        }
        if (prefs.getBoolean(KEY_PERM_ASKED, false)) {
            return;
        }
        prefs.edit().putBoolean(KEY_PERM_ASKED, true).apply();
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{
                    Manifest.permission.RECORD_AUDIO,
                    Manifest.permission.POST_NOTIFICATIONS}, REQ_LAUNCH_PERMS);
        } else {
            requestPermissions(new String[]{
                    Manifest.permission.RECORD_AUDIO}, REQ_LAUNCH_PERMS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (bridge != null) {
            bridge.onRequestPermissionsResult(requestCode, permissions, grantResults);
        }
    }

    private String currentServer() {
        String v = prefs.getString(KEY_SERVER, DEFAULT_SERVER);
        if (v == null) {
            v = DEFAULT_SERVER;
        }
        v = v.trim();
        while (v.endsWith("/")) {
            v = v.substring(0, v.length() - 1);
        }
        if (v.length() == 0) {
            v = DEFAULT_SERVER;
        }
        return v;
    }

    private void loadStart() {
        hideError();
        bar.setVisibility(View.VISIBLE);
        bar.setProgress(3);
        web.loadUrl(currentServer() + START_PATH);
    }

    private void showServerDialog() {
        final EditText et = new EditText(this);
        et.setSingleLine(true);
        et.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        et.setText(currentServer());
        et.setSelection(et.getText().length());

        LinearLayout wrap = new LinearLayout(this);
        wrap.setPadding(dp(20), dp(6), dp(20), 0);
        wrap.addView(et, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        new AlertDialog.Builder(this)
                .setTitle("服务器地址")
                .setMessage("云端演示地址；隧道地址变更时在这里改。")
                .setView(wrap)
                .setPositiveButton("保存并加载", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int which) {
                        String v = et.getText().toString().trim();
                        if (v.length() == 0) {
                            v = DEFAULT_SERVER;
                        }
                        if (v.indexOf("://") < 0) {
                            v = "https://" + v;
                        }
                        while (v.endsWith("/")) {
                            v = v.substring(0, v.length() - 1);
                        }
                        prefs.edit().putString(KEY_SERVER, v).commit();
                        loadStart();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private LinearLayout buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.WHITE);
        box.setPadding(dp(28), dp(28), dp(28), dp(28));

        TextView title = new TextView(this);
        title.setText("连不上云端服务");
        title.setTextSize(22);
        title.setTextColor(Color.parseColor("#111827"));
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        errorDetail = new TextView(this);
        errorDetail.setText("");
        errorDetail.setTextSize(13);
        errorDetail.setTextColor(Color.parseColor("#6B7280"));
        errorDetail.setGravity(Gravity.CENTER);
        errorDetail.setPadding(0, dp(10), 0, dp(20));
        box.addView(errorDetail);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loadStart();
            }
        });
        LinearLayout.LayoutParams lp1 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp1.topMargin = dp(8);
        box.addView(retry, lp1);

        Button change = new Button(this);
        change.setText("修改服务器地址");
        change.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showServerDialog();
            }
        });
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp2.topMargin = dp(4);
        box.addView(change, lp2);

        TextView hint = new TextView(this);
        hint.setText("检查手机网络后重试。演示前请确认云端服务在线。");
        hint.setTextSize(12);
        hint.setTextColor(Color.parseColor("#9CA3AF"));
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(16), 0, 0);
        box.addView(hint);

        return box;
    }

    private void showError(String detail) {
        bar.setVisibility(View.GONE);
        String d = detail == null ? "" : detail;
        if (d.length() > 160) {
            d = d.substring(0, 160) + "...";
        }
        errorDetail.setText("错误：" + d + "\n地址：" + currentServer());
        errorBox.setVisibility(View.VISIBLE);
        web.setVisibility(View.GONE);
    }

    private void hideError() {
        if (errorBox != null) {
            errorBox.setVisibility(View.GONE);
        }
        if (web != null) {
            web.setVisibility(View.VISIBLE);
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private class DemoClient extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            hideError();
            bar.setVisibility(View.VISIBLE);
            bar.setProgress(5);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            bar.setVisibility(View.GONE);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (u == null) {
                return false;
            }
            String scheme = u.getScheme() == null ? "" : u.getScheme();
            if (!"http".equals(scheme) && !"https".equals(scheme)) {
                return true;
            }
            String host = u.getHost() == null ? "" : u.getHost();
            String srvHost = "";
            try {
                srvHost = Uri.parse(currentServer()).getHost();
            } catch (Exception e) {
                srvHost = "";
            }
            if (srvHost != null && srvHost.length() > 0 && host.equals(srvHost)) {
                return false;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception e) {
                // 忽略
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                showError(error == null ? "" : String.valueOf(error.getDescription()));
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request != null && request.isForMainFrame()
                    && response != null && response.getStatusCode() >= 400) {
                showError("HTTP " + response.getStatusCode());
            }
        }
    }

    private class DemoChrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            if (bar != null) {
                bar.setProgress(newProgress);
                if (newProgress >= 100) {
                    bar.setVisibility(View.GONE);
                } else {
                    bar.setVisibility(View.VISIBLE);
                }
            }
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("好", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int w) {
                            result.confirm();
                        }
                    })
                    .setCancelable(false)
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int w) {
                            result.confirm();
                        }
                    })
                    .setNegativeButton("取消", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int w) {
                            result.cancel();
                        }
                    })
                    .setCancelable(false)
                    .show();
            return true;
        }

        @Override
        public boolean onJsPrompt(WebView view, String url, String message,
                                  String defaultValue, final JsPromptResult result) {
            final EditText et = new EditText(MainActivity.this);
            et.setSingleLine(true);
            if (defaultValue != null) {
                et.setText(defaultValue);
                et.setSelection(defaultValue.length());
            }
            LinearLayout wrap = new LinearLayout(MainActivity.this);
            wrap.setPadding(dp(20), dp(6), dp(20), 0);
            wrap.addView(et, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setView(wrap)
                    .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int w) {
                            result.confirm(et.getText().toString());
                        }
                    })
                    .setNegativeButton("取消", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int w) {
                            result.cancel();
                        }
                    })
                    .setCancelable(false)
                    .show();
            return true;
        }
    }
}
