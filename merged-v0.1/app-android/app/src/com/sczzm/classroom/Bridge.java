package com.sczzm.classroom;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * WebView JS 桥：window.ClassroomNative.start/stop/mark/status。
 * 所有方法返回 JSON 字符串；状态变化额外通过 CustomEvent('classroom-native') 推给页面。
 */
public class Bridge {

    public static final int REQ_RECORD = 7101;
    private static final String TAG = "ClassroomBridge";

    private final Activity activity;
    private final WebView web;
    private String pendingCourse;

    public Bridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        RecordingService.setStatusListener(new ListenerImpl(this));
    }

    /** d8(34.0.0) 对「非静态内部类实现接口」有解析 bug，这里用静态嵌套类 + 显式引用替代。 */
    static final class ListenerImpl implements RecordingService.StatusListener {
        private final Bridge bridge;

        ListenerImpl(Bridge bridge) {
            this.bridge = bridge;
        }

        @Override
        public void onState(String json, boolean ok) {
            bridge.push(json);
        }
    }

    @JavascriptInterface
    public String start(String course) {
        JSONObject out = new JSONObject();
        try {
            JSONObject st = new JSONObject(RecordingService.statusJson(activity));
            if (st.optBoolean("recording", false)) {
                out.put("ok", false);
                out.put("error", "已在录音中");
                out.put("sessionId", st.optString("sessionId", ""));
                return out.toString();
            }
            if (!hasRecordPermission()) {
                pendingCourse = course == null ? "" : course;
                requestPermissions();
                out.put("ok", false);
                out.put("needPermission", true);
                out.put("error", "需要录音权限");
                return out.toString();
            }
            return doStart(course == null ? "" : course);
        } catch (Throwable t) {
            return err(out, t);
        }
    }

    @JavascriptInterface
    public String stop() {
        JSONObject out = new JSONObject();
        try {
            String sid = RecordingService.currentSessionId(activity);
            RecordingService.stopSession(activity.getApplicationContext());
            out.put("ok", true);
            out.put("stopping", true);
            out.put("sessionId", sid);
        } catch (Throwable t) {
            return err(out, t);
        }
        return out.toString();
    }

    @JavascriptInterface
    public String mark(String note) {
        JSONObject out = new JSONObject();
        try {
            String text = note == null ? "" : note.trim();
            if (text.length() > 500) {
                text = text.substring(0, 500);
            }
            SharedPreferences p = activity.getSharedPreferences(RecordingService.PREFS, Context.MODE_PRIVATE);
            String raw = p.getString(RecordingService.K_MARKERS, "[]");
            JSONArray arr;
            try {
                arr = new JSONArray(raw);
            } catch (Throwable t) {
                arr = new JSONArray();
            }
            long startedAt = p.getLong(RecordingService.K_STARTED_AT, 0);
            JSONObject item = new JSONObject();
            item.put("note", text);
            item.put("at", System.currentTimeMillis());
            item.put("t", startedAt > 0 ? Math.max(0, System.currentTimeMillis() - startedAt) : 0);
            arr.put(item);
            p.edit().putString(RecordingService.K_MARKERS, arr.toString()).apply();
            out.put("ok", true);
            out.put("markers", arr.length());
            out.put("sessionId", p.getString(RecordingService.K_SESSION, ""));
        } catch (Throwable t) {
            return err(out, t);
        }
        return out.toString();
    }

    @JavascriptInterface
    public String status() {
        return RecordingService.statusJson(activity);
    }

    /** 页面保存接口令牌时同步到原生层（原生录音上传需要 x-app-token）。 */
    @JavascriptInterface
    public void setToken(String token) {
        String v = token == null ? "" : token.trim();
        activity.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
                .edit().putString(MainActivity.KEY_TOKEN, v).apply();
    }

    /** 页面可同步服务器地址（原生录音上传用；默认用长按对话框保存的地址）。 */
    @JavascriptInterface
    public void setServer(String server) {
        String v = server == null ? "" : server.trim();
        while (v.endsWith("/")) {
            v = v.substring(0, v.length() - 1);
        }
        activity.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
                .edit().putString(MainActivity.KEY_SERVER, v).apply();
    }

    /** MainActivity.onRequestPermissionsResult 转发。 */
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQ_RECORD) {
            return;
        }
        if (hasRecordPermission()) {
            if (pendingCourse != null) {
                String c = pendingCourse;
                pendingCourse = null;
                try {
                    doStart(c);
                } catch (Throwable t) {
                    push("{\"ok\":false,\"recording\":false,\"segments\":0,\"bytes\":0,"
                            + "\"error\":\"启动录音失败\"}");
                }
            }
        } else {
            push("{\"ok\":false,\"recording\":false,\"segments\":0,\"bytes\":0,\"error\":\"录音权限被拒绝\"}");
        }
    }

    private String doStart(String course) throws Exception {
        String server = serverUrl();
        String token = appToken();
        String sid = RecordingService.newSessionId();
        RecordingService.startSession(activity.getApplicationContext(), course, server, token, sid);
        uploadMeta(server, token, sid, course);
        JSONObject out = new JSONObject();
        out.put("ok", true);
        out.put("recording", true);
        out.put("sessionId", sid);
        out.put("course", course);
        out.put("server", server);
        return out.toString();
    }

    static final class MetaTask implements Runnable {
        private final Activity activity;
        private final String server;
        private final String token;
        private final String sid;
        private final String course;

        MetaTask(Activity activity, String server, String token, String sid, String course) {
            this.activity = activity;
            this.server = server;
            this.token = token;
            this.sid = sid;
            this.course = course;
        }

        @Override
        public void run() {
            if (server == null || server.length() == 0) {
                return;
            }
            JSONObject meta = new JSONObject();
            try {
                meta.put("id", sid);
                meta.put("course", course);
                meta.put("startedAt", System.currentTimeMillis());
                meta.put("device", Build.MODEL == null ? "android" : Build.MODEL);
                meta.put("app", "classroom-android");
                meta.put("recorder", "native-service");
            } catch (Throwable ignored) {
            }
            Uploader.Result r = Uploader.postMeta(server, token, meta);
            SharedPreferences p = activity.getSharedPreferences(
                    RecordingService.PREFS, Context.MODE_PRIVATE);
            if (r.ok) {
                p.edit().putString(RecordingService.K_UPLOAD_ERROR, "").apply();
                Log.i(TAG, "meta ok: " + sid);
            } else {
                p.edit().putString(RecordingService.K_UPLOAD_ERROR,
                        "meta 登记失败：HTTP " + r.code + " " + shorten(r.body)).apply();
                Log.w(TAG, "meta fail: " + r);
            }
        }
    }

    /** 后台登记会话元数据；失败只记录，不阻塞录音。 */
    private void uploadMeta(String server, String token, String sid, String course) {
        Thread t = new Thread(new MetaTask(activity, server, token, sid, course), "classroom-meta");
        t.setDaemon(true);
        t.start();
    }

    private boolean hasRecordPermission() {
        if (Build.VERSION.SDK_INT < 23) {
            return true;
        }
        return activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void requestPermissions() {
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                activity.requestPermissions(new String[]{
                        Manifest.permission.RECORD_AUDIO,
                        Manifest.permission.POST_NOTIFICATIONS}, REQ_RECORD);
            } else {
                activity.requestPermissions(new String[]{
                        Manifest.permission.RECORD_AUDIO}, REQ_RECORD);
            }
        } catch (Throwable t) {
            Log.w(TAG, "requestPermissions: " + t);
        }
    }

    public String serverUrl() {
        if (activity instanceof MainActivity) {
            return ((MainActivity) activity).serverUrl();
        }
        SharedPreferences p = activity.getSharedPreferences("classroom_demo", Context.MODE_PRIVATE);
        return p.getString("server_url", MainActivity.DEFAULT_SERVER);
    }

    public String appToken() {
        if (activity instanceof MainActivity) {
            return ((MainActivity) activity).appToken();
        }
        SharedPreferences p = activity.getSharedPreferences("classroom_demo", Context.MODE_PRIVATE);
        return p.getString("app_token", "");
    }

    static final class PushTask implements Runnable {
        private final WebView web;
        private final String json;

        PushTask(WebView web, String json) {
            this.web = web;
            this.json = json;
        }

        @Override
        public void run() {
            try {
                String js = "try{window.dispatchEvent(new CustomEvent('classroom-native',"
                        + "{detail:" + json + "}));}catch(e){}";
                web.evaluateJavascript(js, null);
            } catch (Throwable t) {
                Log.w(TAG, "push: " + t);
            }
        }
    }

    /** 把状态 JSON 推给页面（主线程）。 */
    void push(String json) {
        if (web == null || json == null) {
            return;
        }
        web.post(new PushTask(web, json));
    }

    private static String shorten(String s) {
        if (s == null) {
            return "";
        }
        String t = s.replace('\n', ' ').replace('\r', ' ');
        return t.length() <= 120 ? t : t.substring(0, 120);
    }

    private static String err(JSONObject out, Throwable t) {
        try {
            out.put("ok", false);
            out.put("error", String.valueOf(t));
        } catch (Throwable ignored) {
        }
        return out.toString();
    }
}
