'use strict';
// 学习通 sidecar 代理（零第三方依赖，只用 Node 内置 http/https）
// sidecar = pc-agent\chaoxing\chaoxing_service.py，只监听 127.0.0.1:8781（回环）；
// 这里只做「本机 → sidecar」转发，地址来自环境变量 CHAOXING_SIDECAR，不额外对外暴露端口。

const http = require('http');
const https = require('https');

const DEFAULT_BASE = 'http://127.0.0.1:8781';
const DEFAULT_TIMEOUT = 15000;
const MAX_BODY = 2 * 1024 * 1024;
const UNREACHABLE = '学习通服务未启动（v1 需要本机 pc-agent 在线）';

/** sidecar 基地址：环境变量 CHAOXING_SIDECAR，缺省 http://127.0.0.1:8781，去掉末尾斜杠 */
function baseUrl() {
  const raw = String(process.env.CHAOXING_SIDECAR || '').trim() || DEFAULT_BASE;
  return raw.replace(/\/+$/, '');
}

function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** 响应体：优先按 JSON 解析，非 JSON 保留原文（sidecar 正常都返回 JSON） */
function toBody(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) { return t; }
}

/**
 * 转发一个请求到学习通 sidecar。
 * @param {string} pathname sidecar 路径（可带 query，如 '/login/start?open=1'）
 * @param {string} method HTTP 方法，默认 GET
 * @param {number} timeoutMs 总超时毫秒，默认 15000
 * @returns {Promise<{status:number, body:any}>}
 * 连接失败/超时抛 Error（code = CHAOXING_UNREACHABLE / CHAOXING_TIMEOUT），message 可直接给用户看。
 */
function proxy(pathname, method, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let u;
    try {
      u = new URL(String(pathname || '/'), baseUrl());
    } catch (e) {
      return reject(fail('CHAOXING_SIDECAR 地址不合法：' + baseUrl(), 'CHAOXING_BAD_BASE'));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT;
    let timedOut = false;
    let settled = false;

    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: String(method || 'GET').toUpperCase(),
      headers: { Accept: 'application/json' },
    }, function (res) {
      const chunks = [];
      let size = 0;
      res.on('data', function (c) {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: res.statusCode || 0, body: toBody(Buffer.concat(chunks).toString('utf8')) });
      });
      res.on('error', function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(fail(UNREACHABLE, 'CHAOXING_UNREACHABLE'));
      });
    });

    const timer = setTimeout(function () {
      timedOut = true;
      req.destroy();
    }, ms);

    req.on('error', function (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) return reject(fail('学习通服务响应超时（' + ms + 'ms 无响应），本机 sidecar 可能卡住了', 'CHAOXING_TIMEOUT'));
      const code = e && e.code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'EADDRNOTAVAIL') {
        return reject(fail(UNREACHABLE, 'CHAOXING_UNREACHABLE'));
      }
      return reject(fail('学习通服务连接失败：' + (e && e.message ? e.message : String(e)), 'CHAOXING_UNREACHABLE'));
    });

    req.end();
  });
}

module.exports = { proxy: proxy, baseUrl: baseUrl, UNREACHABLE: UNREACHABLE };
