package com.sczzm.classroom;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生录音前台服务：MediaRecorder 录 AAC 16kHz 单声道，每 30 秒切一段 m4a。
 * 段落写入 getFilesDir()/rec/<会话ID>/seg-XXX.m4a，落盘后交给 Uploader 上传。
 * 运行态存 SharedPreferences（classroom_rec），供 Bridge.status() 读取。
 */
public class RecordingService extends Service {

    public static final String PREFS = "classroom_rec";
    public static final String K_RECORDING = "recording";
    public static final String K_SESSION = "sessionId";
    public static final String K_COURSE = "course";
    public static final String K_SERVER = "serverUrl";
    public static final String K_TOKEN = "token";
    public static final String K_STARTED_AT = "startedAt";
    public static final String K_SEGMENTS = "segments";
    public static final String K_BYTES = "bytes";
    public static final String K_ERROR = "lastError";
    public static final String K_UPLOAD_ERROR = "lastUploadError";
    public static final String K_MARKERS = "markers";

    public static final String ACTION_START = "com.sczzm.classroom.REC_START";
    public static final String ACTION_STOP = "com.sczzm.classroom.REC_STOP";
    public static final String EXTRA_SESSION = "sessionId";
    public static final String EXTRA_COURSE = "course";
    public static final String EXTRA_SERVER = "serverUrl";
    public static final String EXTRA_TOKEN = "token";

    public static final int SEGMENT_MS = 30000;
    private static final String CHANNEL_ID = "classroom_recording";
    private static final int NOTIF_ID = 4101;
    private static final String TAG = "ClassroomRec";

    /** 状态回调（Bridge 注册后转发到 WebView）。 */
    public interface StatusListener {
        void onState(String json, boolean ok);
    }

    private static volatile StatusListener listener;
    private static volatile RecordingService instance;

    public static void setStatusListener(StatusListener l) {
        listener = l;
    }

    private final Object lock = new Object();
    private MediaRecorder rec;
    private HandlerThread looper;
    Handler handler;
    private ExecutorService uploadPool;
    private boolean running;
    private int segIndex;
    private long segmentStartedAt;
    private String sessionId = "";
    private String course = "";
    private String serverUrl = "";
    private String token = "";
    private File sessionDir;

    public static RecordingService get() {
        return instance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        uploadPool = Executors.newSingleThreadExecutor();
        looper = new HandlerThread("classroom-rec-rotate");
        looper.start();
        handler = new Handler(looper.getLooper());
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSessionInternal();
            return START_NOT_STICKY;
        }
        if (intent != null) {
            String sid = intent.getStringExtra(EXTRA_SESSION);
            course = safe(intent.getStringExtra(EXTRA_COURSE));
            serverUrl = safe(intent.getStringExtra(EXTRA_SERVER));
            token = safe(intent.getStringExtra(EXTRA_TOKEN));
            if (sid != null && sid.length() > 0) {
                sessionId = sid;
            }
        }
        if (sessionId.length() == 0) {
            sessionId = newSessionId();
        }
        sessionDir = new File(new File(getFilesDir(), "rec"), sessionId);
        if (!sessionDir.exists() && !sessionDir.mkdirs()) {
            onError("无法创建录音目录：" + sessionDir.getAbsolutePath());
            return START_NOT_STICKY;
        }
        startForegroundCompat();
        try {
            startCapture();
        } catch (Throwable t) {
            onError("启动录音失败：" + t);
            return START_NOT_STICKY;
        }
        return START_NOT_STICKY;
    }

    private void startForegroundCompat() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = "正在录音";
        String text = course.length() > 0 ? course + " · 每 30 秒切一段" : "课堂录音 · 每 30 秒切一段";
        Notification.Builder b = new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentIntent(pi)
                .setOngoing(true)
                .setOnlyAlertOnce(true);
        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private void createChannel() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "课堂录音", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("课堂助手后台录音前台服务");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private void startCapture() {
        synchronized (lock) {
            running = true;
            segIndex = 0;
            openSegmentLocked();
        }
        if (handler != null) {
            handler.postDelayed(rotateTask, SEGMENT_MS);
        }
    }

    /** d8(34.0.0) 对「非静态内部类实现接口」有解析 bug，这里用静态嵌套类 + 显式引用替代。 */
    static final class RotateTask implements Runnable {
        private final RecordingService svc;

        RotateTask(RecordingService svc) {
            this.svc = svc;
        }

        @Override
        public void run() {
            svc.rotate();
            if (svc.handler != null) {
                svc.handler.postDelayed(this, SEGMENT_MS);
            }
        }
    }

    private final RotateTask rotateTask = new RotateTask(this);

    private void openSegmentLocked() {
        File f = segmentFile(segIndex);
        MediaRecorder r = new MediaRecorder();
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC);
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            r.setAudioSamplingRate(16000);
            r.setAudioChannels(1);
            r.setAudioEncodingBitRate(64000);
            r.setOutputFile(f.getAbsolutePath());
            r.prepare();
            r.start();
        } catch (Throwable t) {
            try {
                r.release();
            } catch (Throwable ignored) {
            }
            throw new RuntimeException(t);
        }
        rec = r;
        segmentStartedAt = SystemClock.elapsedRealtime();
        Log.i(TAG, "segment start: " + f.getName());
    }

    void rotate() {
        File closed;
        long durationMs;
        synchronized (lock) {
            if (!running) {
                return;
            }
            MediaRecorder old = rec;
            rec = null;
            closed = segmentFile(segIndex);
            durationMs = SystemClock.elapsedRealtime() - segmentStartedAt;
            stopQuietly(old);
            segIndex++;
            if (running) {
                try {
                    openSegmentLocked();
                } catch (Throwable t) {
                    onError("切段失败：" + t);
                    return;
                }
            }
        }
        finishClosedSegment(closed, durationMs);
    }

    private void finishClosedSegment(File closed, long durationMs) {
        if (closed == null) {
            return;
        }
        long size = closed.length();
        if (size <= 0) {
            Log.w(TAG, "empty segment dropped: " + closed.getName());
            closed.delete();
            return;
        }
        bumpStats(size);
        emitState();
        uploadSegmentAsync(sessionId, serverUrl, token, closed, durationMs);
    }

    static final class UploadTask implements Runnable {
        private final RecordingService svc;
        private final String sid;
        private final String srv;
        private final String tk;
        private final File file;

        UploadTask(RecordingService svc, String sid, String srv, String tk, File file) {
            this.svc = svc;
            this.sid = sid;
            this.srv = srv;
            this.tk = tk;
            this.file = file;
        }

        @Override
        public void run() {
            if (srv == null || srv.length() == 0) {
                svc.setUploadError("未配置服务器地址，段落只存本地：" + file.getName());
                return;
            }
            Uploader.Result r = Uploader.uploadSegment(srv, tk, sid, file);
            if (r.ok) {
                svc.clearUploadError();
            } else {
                svc.setUploadError("上传 " + file.getName() + " 失败：HTTP " + r.code
                        + " " + trim(r.body, 120));
            }
        }
    }

    private void uploadSegmentAsync(final String sid, final String srv, final String tk,
                                    final File file, final long durationMs) {
        if (uploadPool == null || file == null) {
            return;
        }
        uploadPool.execute(new UploadTask(this, sid, srv, tk, file));
    }

    void setUploadError(String msg) {
        Log.w(TAG, msg);
        prefs().edit().putString(K_UPLOAD_ERROR, msg).apply();
        emitState();
    }

    void clearUploadError() {
        prefs().edit().putString(K_UPLOAD_ERROR, "").apply();
    }

    private void stopQuietly(MediaRecorder r) {
        if (r == null) {
            return;
        }
        try {
            r.stop();
        } catch (Throwable t) {
            Log.w(TAG, "stop recorder: " + t);
        }
        try {
            r.release();
        } catch (Throwable ignored) {
        }
    }

    private void stopSessionInternal() {
        File last;
        long durationMs;
        synchronized (lock) {
            if (!running) {
                last = null;
                durationMs = 0;
            } else {
                running = false;
                if (handler != null) {
                    handler.removeCallbacks(rotateTask);
                }
                MediaRecorder old = rec;
                rec = null;
                last = segmentFile(segIndex);
                durationMs = SystemClock.elapsedRealtime() - segmentStartedAt;
                stopQuietly(old);
            }
        }
        if (last != null) {
            finishClosedSegment(last, durationMs);
        }
        prefs().edit().putBoolean(K_RECORDING, false).apply();
        emitState();
        if (uploadPool != null) {
            uploadPool.shutdown();
        }
        if (looper != null) {
            looper.quitSafely();
        }
        stopForeground(true);
        instance = null;
        stopSelf();
    }

    private void onError(String msg) {
        Log.e(TAG, msg);
        synchronized (lock) {
            running = false;
            if (handler != null) {
                handler.removeCallbacks(rotateTask);
            }
            MediaRecorder old = rec;
            rec = null;
            stopQuietly(old);
        }
        prefs().edit()
                .putBoolean(K_RECORDING, false)
                .putString(K_ERROR, msg == null ? "未知错误" : msg)
                .apply();
        emitState();
        if (uploadPool != null) {
            uploadPool.shutdown();
        }
        if (looper != null) {
            looper.quitSafely();
        }
        stopForeground(true);
        instance = null;
        stopSelf();
    }

    @Override
    public void onDestroy() {
        boolean wasRunning = running;
        running = false;
        if (handler != null) {
            handler.removeCallbacks(rotateTask);
        }
        synchronized (lock) {
            stopQuietly(rec);
            rec = null;
        }
        if (wasRunning) {
            prefs().edit().putBoolean(K_RECORDING, false).apply();
        }
        if (uploadPool != null) {
            uploadPool.shutdown();
        }
        if (looper != null) {
            looper.quitSafely();
        }
        instance = null;
        super.onDestroy();
    }

    private File segmentFile(int idx) {
        return new File(sessionDir, String.format(Locale.US, "seg-%03d.m4a", idx));
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void bumpStats(long addBytes) {
        SharedPreferences p = prefs();
        int s = p.getInt(K_SEGMENTS, 0) + 1;
        long b = p.getLong(K_BYTES, 0) + addBytes;
        p.edit().putInt(K_SEGMENTS, s).putLong(K_BYTES, b).apply();
    }

    private void emitState() {
        StatusListener l = listener;
        if (l == null) {
            return;
        }
        try {
            l.onState(statusJson(this), true);
        } catch (Throwable ignored) {
        }
    }

    // ---------------- 静态接口（Bridge / MainActivity 调用） ----------------

    public static void startSession(Context context, String course, String serverUrl, String token) {
        startSession(context, course, serverUrl, token, null);
    }

    public static void startSession(Context context, String course, String serverUrl, String token,
                                    String sessionId) {
        if (context == null) {
            return;
        }
        String sid = (sessionId == null || sessionId.length() == 0) ? newSessionId() : sessionId;
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        p.edit()
                .putBoolean(K_RECORDING, true)
                .putString(K_SESSION, sid)
                .putString(K_COURSE, safe(course))
                .putString(K_SERVER, safe(serverUrl))
                .putString(K_TOKEN, safe(token))
                .putLong(K_STARTED_AT, System.currentTimeMillis())
                .putInt(K_SEGMENTS, 0)
                .putLong(K_BYTES, 0)
                .putString(K_ERROR, "")
                .putString(K_UPLOAD_ERROR, "")
                .putString(K_MARKERS, "[]")
                .apply();

        Intent i = new Intent(context, RecordingService.class);
        i.setAction(ACTION_START);
        i.putExtra(EXTRA_SESSION, sid);
        i.putExtra(EXTRA_COURSE, safe(course));
        i.putExtra(EXTRA_SERVER, safe(serverUrl));
        i.putExtra(EXTRA_TOKEN, safe(token));
        if (Build.VERSION.SDK_INT >= 26) {
            context.startForegroundService(i);
        } else {
            context.startService(i);
        }
    }

    public static void stopSession(Context context) {
        if (context == null) {
            return;
        }
        Intent i = new Intent(context, RecordingService.class);
        i.setAction(ACTION_STOP);
        try {
            context.startService(i);
        } catch (Throwable t) {
            SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            p.edit().putBoolean(K_RECORDING, false).putString(K_ERROR, "停止失败：" + t).apply();
        }
    }

    public static String statusJson(Context context) {
        JSONObject o = new JSONObject();
        if (context == null) {
            try {
                o.put("ok", false);
                o.put("recording", false);
                o.put("segments", 0);
                o.put("bytes", 0);
                o.put("sessionId", "");
            } catch (Throwable ignored) {
            }
            return o.toString();
        }
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            o.put("ok", true);
            o.put("recording", p.getBoolean(K_RECORDING, false));
            o.put("segments", p.getInt(K_SEGMENTS, 0));
            o.put("bytes", p.getLong(K_BYTES, 0));
            o.put("sessionId", p.getString(K_SESSION, ""));
            o.put("course", p.getString(K_COURSE, ""));
            o.put("startedAt", p.getLong(K_STARTED_AT, 0));
            o.put("markers", countMarkers(p.getString(K_MARKERS, "[]")));
            String err = p.getString(K_ERROR, "");
            if (err != null && err.length() > 0) {
                o.put("error", err);
            }
            String uerr = p.getString(K_UPLOAD_ERROR, "");
            if (uerr != null && uerr.length() > 0) {
                o.put("uploadError", uerr);
            }
        } catch (Throwable t) {
            try {
                o.put("ok", false);
                o.put("error", String.valueOf(t));
            } catch (Throwable ignored) {
            }
        }
        return o.toString();
    }

    public static String currentSessionId(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return p.getString(K_SESSION, "");
    }

    /** 会话 ID：cYYYYMMDD-HHMMSS-xxxx */
    public static String newSessionId() {
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        int r = (int) (Math.random() * 0xFFFF);
        return "c" + stamp + "-" + String.format(Locale.US, "%04x", r);
    }

    private static int countMarkers(String raw) {
        if (raw == null || raw.length() == 0) {
            return 0;
        }
        try {
            return new org.json.JSONArray(raw).length();
        } catch (Throwable t) {
            return 0;
        }
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }

    private static String trim(String s, int n) {
        if (s == null) {
            return "";
        }
        String t = s.replace('\n', ' ').replace('\r', ' ');
        return t.length() <= n ? t : t.substring(0, n);
    }
}
