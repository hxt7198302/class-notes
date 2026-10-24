package com.sczzm.classroom;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.security.MessageDigest;

/**
 * 上传器：HttpURLConnection 实现 P1 上传契约。
 * POST &lt;server&gt;/api/session/meta  （JSON）
 * POST &lt;server&gt;/api/chunk?id=&amp;name=&amp;offset=&amp;md5= （原始字节，头 x-app-token）
 * 409 = 偏移不符，按响应里的 size 重新对齐后续传；失败重试 2 次。
 */
public final class Uploader {

    private static final int TIMEOUT_MS = 15000;
    private static final int RETRY = 2;
    private static final int MAX_ALIGN = 12;
    private static final int CHUNK_SIZE = 1024 * 1024;

    private Uploader() {
    }

    /** 单次请求结果。 */
    public static final class Result {
        public final boolean ok;
        public final int code;
        public final String body;

        public Result(boolean ok, int code, String body) {
            this.ok = ok;
            this.code = code;
            this.body = body == null ? "" : body;
        }

        @Override
        public String toString() {
            return "Result{ok=" + ok + ", code=" + code + ", body=" + body + "}";
        }
    }

    public static Result postMeta(String serverUrl, String token, JSONObject meta) {
        String url = join(serverUrl, "/api/session/meta");
        byte[] body;
        try {
            body = meta.toString().getBytes("UTF-8");
        } catch (Throwable t) {
            return new Result(false, 0, "encode: " + t);
        }
        Result last = null;
        for (int attempt = 0; attempt <= RETRY; attempt++) {
            last = request(url, token, body, "application/json; charset=utf-8");
            if (last.ok || !retryable(last.code)) {
                return last;
            }
            sleep(700L * (attempt + 1));
        }
        return last == null ? new Result(false, 0, "no attempt") : last;
    }

    /**
     * 上传一个段落文件。offset 从 0 开始，服务端已收字节数通过 409 的 size 对齐。
     */
    public static Result uploadSegment(String serverUrl, String token, String sessionId, File file) {
        if (file == null || !file.exists()) {
            return new Result(false, 0, "文件不存在");
        }
        long total = file.length();
        if (total <= 0) {
            return new Result(true, 200, "empty");
        }
        if (serverUrl == null || serverUrl.length() == 0) {
            return new Result(false, 0, "未配置服务器地址");
        }
        long offset = 0;
        int failures = 0;
        int aligns = 0;
        Result last = null;
        while (offset < total) {
            byte[] chunk = readChunk(file, offset, CHUNK_SIZE);
            if (chunk.length == 0) {
                return new Result(false, 0, "读取文件失败 @" + offset);
            }
            String md5 = md5Hex(chunk);
            if (md5 == null) {
                return new Result(false, 0, "md5 计算失败");
            }
            String url = join(serverUrl, "/api/chunk")
                    + "?id=" + enc(sessionId)
                    + "&name=" + enc(file.getName())
                    + "&offset=" + offset
                    + "&md5=" + enc(md5);
            last = request(url, token, chunk, "application/octet-stream");
            if (last.ok) {
                offset += chunk.length;
                failures = 0;
                continue;
            }
            if (last.code == 409) {
                long size = parseSize(last.body);
                if (size < 0) {
                    size = 0;
                }
                if (size >= total) {
                    return new Result(true, 409, "服务端已收全 " + total + " 字节");
                }
                if (++aligns > MAX_ALIGN) {
                    return new Result(false, 409, "409 对齐次数超限：" + size);
                }
                offset = size;
                continue;
            }
            if (!retryable(last.code) || ++failures > RETRY) {
                return last;
            }
            sleep(800L * failures);
        }
        return new Result(true, 200, "uploaded " + total);
    }

    /** 收尾：POST /api/session/complete?id= */
    public static Result completeSession(String serverUrl, String token, String sessionId) {
        if (serverUrl == null || serverUrl.length() == 0) {
            return new Result(false, 0, "未配置服务器地址");
        }
        String url = join(serverUrl, "/api/session/complete?id=" + enc(sessionId));
        return request(url, token, new byte[0], "application/json");
    }

    private static boolean retryable(int code) {
        if (code == 0) {
            return true; // 网络异常
        }
        if (code == 408 || code == 429) {
            return true;
        }
        return code >= 500;
    }

    private static Result request(String url, String token, byte[] body, String contentType) {
        HttpURLConnection c = null;
        try {
            URL u = new URL(url);
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setUseCaches(false);
            c.setRequestProperty("Content-Type", contentType);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "ClassroomAndroid/1.0");
            if (token != null && token.length() > 0) {
                c.setRequestProperty("x-app-token", token);
            }
            long len = body == null ? 0 : body.length;
            c.setFixedLengthStreamingMode(len);
            c.connect();
            if (len > 0) {
                OutputStream os = c.getOutputStream();
                try {
                    os.write(body);
                    os.flush();
                } finally {
                    os.close();
                }
            }
            int code = c.getResponseCode();
            String resp = readBody(c, code);
            boolean ok = code >= 200 && code < 300;
            return new Result(ok, code, resp);
        } catch (Throwable t) {
            return new Result(false, 0, String.valueOf(t));
        } finally {
            if (c != null) {
                c.disconnect();
            }
        }
    }

    private static String readBody(HttpURLConnection c, int code) {
        InputStream in = null;
        try {
            in = (code >= 200 && code < 300) ? c.getInputStream() : c.getErrorStream();
            if (in == null) {
                return "";
            }
            byte[] buf = new byte[4096];
            StringBuilder sb = new StringBuilder();
            int n;
            while ((n = in.read(buf)) > 0) {
                sb.append(new String(buf, 0, n, "UTF-8"));
                if (sb.length() > 8192) {
                    break;
                }
            }
            return sb.toString();
        } catch (Throwable t) {
            return "";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private static long parseSize(String body) {
        if (body == null || body.length() == 0) {
            return -1;
        }
        try {
            JSONObject o = new JSONObject(body);
            if (o.has("size")) {
                return o.optLong("size", -1);
            }
            if (o.has("received")) {
                return o.optLong("received", -1);
            }
            if (o.has("bytes")) {
                return o.optLong("bytes", -1);
            }
        } catch (Throwable ignored) {
        }
        return -1;
    }

    private static byte[] readChunk(File file, long offset, int chunkSize) {
        FileInputStream in = null;
        try {
            long total = file.length();
            if (offset < 0) {
                offset = 0;
            }
            long remain = total - offset;
            if (remain <= 0) {
                return new byte[0];
            }
            int len = (int) Math.min(chunkSize, remain);
            byte[] out = new byte[len];
            in = new FileInputStream(file);
            long skipped = 0;
            while (skipped < offset) {
                long s = in.skip(offset - skipped);
                if (s <= 0) {
                    if (in.read() < 0) {
                        break;
                    }
                    s = 1;
                }
                skipped += s;
            }
            int read = 0;
            while (read < len) {
                int n = in.read(out, read, len - read);
                if (n <= 0) {
                    break;
                }
                read += n;
            }
            if (read < len) {
                byte[] cut = new byte[read];
                System.arraycopy(out, 0, cut, 0, read);
                return cut;
            }
            return out;
        } catch (Throwable t) {
            return new byte[0];
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    public static String md5Hex(byte[] data) {
        if (data == null) {
            return null;
        }
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] d = md.digest(data);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(Character.forDigit((b >> 4) & 0xf, 16));
                sb.append(Character.forDigit(b & 0xf, 16));
            }
            return sb.toString();
        } catch (Throwable t) {
            return null;
        }
    }

    public static String md5Hex(File file) {
        FileInputStream in = null;
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            in = new FileInputStream(file);
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
            }
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(Character.forDigit((b >> 4) & 0xf, 16));
                sb.append(Character.forDigit(b & 0xf, 16));
            }
            return sb.toString();
        } catch (Throwable t) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private static String join(String server, String path) {
        String s = server == null ? "" : server.trim();
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s + path;
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s == null ? "" : s, "UTF-8");
        } catch (Throwable t) {
            return "";
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
