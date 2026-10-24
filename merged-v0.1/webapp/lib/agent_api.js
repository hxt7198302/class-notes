'use strict';
// 课堂助手 · Agent 上传/读取 API（P1）
// 对齐原作者 v2.12 契约：/api/session/meta、/api/chunk、/api/session/complete、
// /api/notes、/api/note、/api/source、/api/file、/api/session/note。
//
// 存储布局（<dataDir> 默认 webapp/data，可用环境变量 DATA_DIR 覆盖，测试用临时目录）：
//   <dataDir>/agent/<会话ID>/meta.json
//   <dataDir>/agent/<会话ID>/files/<name>
//   <dataDir>/agent/<会话ID>/status.json
//   <dataDir>/agent/<会话ID>/note.md
//   <dataDir>/agent/<会话ID>/items.json
//   <dataDir>/agent/<会话ID>/complete.flag
//
// 鉴权：x-app-token（也接受 ?token=，方便 <audio>/Range 请求）必须等于
//   <dataDir>/api-token.txt；文件不存在时自动生成 32 位 hex。APP_TOKEN 环境变量优先。
//   AGENT_API_OPEN=1 可关闭校验（仅调试）。/api/health 与静态资源不走这里，天然免鉴权。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,120}$/;
const MAX_BODY = 64 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.amr': 'audio/amr',
  '.pdf': 'application/pdf',
  '.apk': 'application/vnd.android.package-archive'
};

const ROUTES = new Set([
  '/api/session/meta',
  '/api/chunk',
  '/api/session/complete',
  '/api/session/note',
  '/api/notes',
  '/api/note',
  '/api/source',
  '/api/file'
]);

function sendJSON(res, code, obj, extraHeaders) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extraHeaders || {}));
  res.end(body);
}

function sendText(res, code, text) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        const err = new Error('body too large');
        err.code = 'TOO_LARGE';
        reject(err);
        try { req.destroy(); } catch (e) {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request aborted')));
  });
}

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}

function writeJSONAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function statSize(file) {
  try { return fs.statSync(file).size; } catch (e) { return 0; }
}

function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function safeId(id) {
  return typeof id === 'string' && ID_RE.test(id) ? id : '';
}

// 文件名白名单：允许点号但禁止 '..' 路径穿越（与 pc-agent 的 safeName 同义）
function safeName(n) {
  if (typeof n !== 'string' || !n) return '';
  if (n === '.' || n.includes('..') || n.includes('/') || n.includes('\\')) return '';
  return NAME_RE.test(n) ? n : '';
}

function create(opts) {
  const options = opts || {};
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const agentRoot = path.join(dataDir, 'agent');
  const tokenFile = path.join(dataDir, 'api-token.txt');
  // 目录建不出来不致命：旧的 /api/* 路由还要继续用，具体写盘时报错即可
  try { fs.mkdirSync(agentRoot, { recursive: true }); } catch (e) {}

  let cachedToken = process.env.APP_TOKEN ? String(process.env.APP_TOKEN).trim() : '';
  ensureTokenFile();
  if (!cachedToken) cachedToken = readTokenFile();

  function readTokenFile() {
    try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { return ''; }
  }

  function ensureTokenFile() {
    try {
      if (fs.existsSync(tokenFile)) return;
      fs.mkdirSync(dataDir, { recursive: true });
      const tok = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(tokenFile, tok, { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
      // 并发启动时另一个进程抢先写了（EEXIST）：直接用它的
    }
  }

  function currentToken() {
    if (cachedToken) return cachedToken;
    cachedToken = readTokenFile();
    return cachedToken;
  }

  function apiOpen() {
    return /^(1|true|yes|on)$/i.test(String(process.env.AGENT_API_OPEN || '').trim());
  }

  function sameToken(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  function authorized(req, url) {
    if (apiOpen()) return true;
    const got = String(req.headers['x-app-token'] || url.searchParams.get('token') || '');
    return sameToken(got, currentToken());
  }

  function sessionDir(id) { return path.join(agentRoot, id); }
  function metaFile(id) { return path.join(sessionDir(id), 'meta.json'); }
  function statusFile(id) { return path.join(sessionDir(id), 'status.json'); }
  function noteFile(id) { return path.join(sessionDir(id), 'note.md'); }
  function itemsFile(id) { return path.join(sessionDir(id), 'items.json'); }
  function flagFile(id) { return path.join(sessionDir(id), 'complete.flag'); }
  function filesDir(id) { return path.join(sessionDir(id), 'files'); }
  function filePath(id, name) { return path.join(filesDir(id), name); }

  function setStatus(id, patch) {
    const next = Object.assign({}, readJSON(statusFile(id), {}), patch || {}, { updatedAt: new Date().toISOString() });
    writeJSONAtomic(statusFile(id), next);
    return next;
  }

  function listReceived(id) {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(filesDir(id)); } catch (e) { return out; }
    for (const name of names) {
      if (!safeName(name)) continue;
      out[name] = statSize(filePath(id, name));
    }
    return out;
  }

  // 按文件名串行化：校验偏移 → 校验 md5 → 追加，避免并发同 offset 重复写入
  const fileLocks = new Map();
  function withFileLock(key, fn) {
    const prev = fileLocks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const guard = run.catch(function () {});
    fileLocks.set(key, guard);
    guard.then(function () { if (fileLocks.get(key) === guard) fileLocks.delete(key); });
    return run;
  }

  // ---------- 路由实现 ----------

  // POST /api/session/meta —— 登记/续传元数据；合并写入，保留未知字段
  async function postSessionMeta(req, res, url) {
    let body;
    try {
      const raw = await readRaw(req);
      body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body 必须是 JSON 对象');
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad-json', message: '请求体不是合法 JSON：' + e.message });
    }
    const id = safeId(body.id || url.searchParams.get('id'));
    if (!id) return sendJSON(res, 400, { ok: false, error: 'id', message: '会话 id 不合法（^[A-Za-z0-9_-]{4,64}$）' });

    fs.mkdirSync(filesDir(id), { recursive: true });
    const prev = readJSON(metaFile(id), null) || {};
    const meta = Object.assign({}, prev);   // 先保留所有未知/兼容字段
    const now = Date.now();

    const courseName = body.courseName != null ? String(body.courseName).slice(0, 80) : '';
    const course = body.course != null ? String(body.course).slice(0, 40)
      : (courseName ? courseName.slice(0, 40) : String(prev.course || ''));
    meta.id = id;
    meta.schemaVersion = 1;
    meta.course = course;
    if (courseName) meta.courseName = courseName;
    else if (!meta.courseName) meta.courseName = course;
    if (body.teacher != null) meta.teacher = String(body.teacher).slice(0, 80);
    if (body.room != null) meta.room = String(body.room).slice(0, 80);
    if (body.startedAt != null) meta.startedAt = toInt(body.startedAt, prev.startedAt || 0);
    if (body.endedAt != null) meta.endedAt = toInt(body.endedAt, prev.endedAt || 0);
    if (body.durationMs != null) meta.durationMs = Math.max(0, toInt(body.durationMs, prev.durationMs || 0));
    if (body.device != null) meta.device = String(body.device).slice(0, 80);
    if (body.legacyId != null) meta.legacyId = String(body.legacyId).slice(0, 64);

    // segments：按 name 合并（APP 重传覆盖自己的段，保留已并入成员的 srcId 段）
    const segMap = new Map();
    const putSeg = (x) => {
      if (!x || typeof x !== 'object') return;
      const name = safeName(x.name);
      if (!name) return;
      const ent = { name: name, startOffsetMs: Math.max(0, toInt(x.startOffsetMs, 0)) };
      if (safeId(x.srcId)) ent.srcId = x.srcId;
      segMap.set(name, ent);
    };
    (Array.isArray(prev.segments) ? prev.segments : []).forEach(putSeg);
    (Array.isArray(body.segments) ? body.segments : []).forEach(putSeg);
    meta.segments = Array.from(segMap.values()).sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.name.localeCompare(b.name));

    // photos：按 name 合并
    const photoMap = new Map();
    const putPhoto = (x) => {
      if (!x || typeof x !== 'object') return;
      const name = safeName(x.name);
      if (!name) return;
      const ent = { name: name, offsetMs: Math.max(0, toInt(x.offsetMs, 0)) };
      if (Number(x.takenAt)) ent.takenAt = toInt(x.takenAt, 0);
      if (safeId(x.srcId)) ent.srcId = x.srcId;
      const old = photoMap.get(name);
      photoMap.set(name, Object.assign({}, old || {}, ent));
    };
    (Array.isArray(prev.photos) ? prev.photos : []).forEach(putPhoto);
    (Array.isArray(body.photos) ? body.photos : []).forEach(putPhoto);
    meta.photos = Array.from(photoMap.values()).sort((a, b) => a.offsetMs - b.offsetMs || a.name.localeCompare(b.name));

    // markers：去重合并（同 offset/type/note 只留一条）
    const markerMap = new Map();
    const putMarker = (x) => {
      if (!x || typeof x !== 'object') return;
      const off = toInt(x.offsetMs, -1);
      if (off < 0) return;
      const type = String(x.type || '重点').slice(0, 20);
      const note = String(x.note || '').slice(0, 200);
      const key = off + '|' + type + '|' + note;
      const ent = { offsetMs: off, type: type, note: note };
      if (Number(x.createdAt)) ent.createdAt = toInt(x.createdAt, 0);
      if (safeId(x.srcId)) ent.srcId = x.srcId;
      markerMap.set(key, ent);
    };
    (Array.isArray(prev.markers) ? prev.markers : []).forEach(putMarker);
    (Array.isArray(body.markers) ? body.markers : []).forEach(putMarker);
    meta.markers = Array.from(markerMap.values()).sort((a, b) => a.offsetMs - b.offsetMs);

    // 客户端连照片的字节数也一并上报时，补进 meta（展示用，不影响文件真实大小）
    if (body.files && typeof body.files === 'object' && !Array.isArray(body.files)) meta.files = body.files;

    meta.createdAt = Number(prev.createdAt) || now;
    meta.updatedAt = now;
    writeJSONAtomic(metaFile(id), meta);

    const complete = fs.existsSync(flagFile(id));
    setStatus(id, { state: complete ? 'uploaded' : 'uploading', course: meta.course, title: (readJSON(statusFile(id), {}).title || '') });
    return sendJSON(res, 200, { ok: true, id: id, received: listReceived(id) });
  }

  // POST /api/chunk?id=&name=&offset=&md5= —— 原始字节追加
  async function postChunk(req, res, url) {
    const id = safeId(url.searchParams.get('id'));
    const name = safeName(url.searchParams.get('name'));
    if (!id) return sendJSON(res, 400, { ok: false, error: 'id' });
    if (!name) return sendJSON(res, 400, { ok: false, error: 'name' });
    const offsetRaw = url.searchParams.get('offset');
    const offset = offsetRaw == null || offsetRaw === '' ? 0 : Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0) return sendJSON(res, 400, { ok: false, error: 'offset-param' });

    let buf;
    try {
      buf = await readRaw(req);
    } catch (e) {
      if (e && e.code === 'TOO_LARGE') return sendJSON(res, 413, { ok: false, error: 'too-large' });
      return sendJSON(res, 400, { ok: false, error: 'body', message: e.message });
    }

    fs.mkdirSync(filesDir(id), { recursive: true });
    const target = filePath(id, name);
    const result = await withFileLock(target, async () => {
      const cur = statSize(target);
      if (cur !== offset) {
        return { code: 409, obj: { ok: false, error: 'offset', size: cur, expected: offset, message: '偏移不对（客户端 ' + offset + ' / 服务端 ' + cur + '）' } };
      }
      const want = String(url.searchParams.get('md5') || '').trim().toLowerCase();
      if (want) {
        const got = crypto.createHash('md5').update(buf).digest('hex');
        if (!/^[0-9a-f]{32}$/.test(want) || got !== want) {
          return { code: 422, obj: { ok: false, error: 'md5', size: cur, message: '分块 md5 校验失败，请重传该块' } };
        }
      }
      if (buf.length) fs.appendFileSync(target, buf);
      return { code: 200, obj: { ok: true, size: cur + buf.length } };
    });
    return sendJSON(res, result.code, result.obj);
  }

  // POST /api/session/complete?id= —— 收尾：complete.flag + status.state=uploaded
  async function postSessionComplete(req, res, url) {
    let body = {};
    try {
      const raw = await readRaw(req);
      if (raw.length) body = JSON.parse(raw.toString('utf8')) || {};
    } catch (e) {
      body = {};
    }
    const id = safeId(url.searchParams.get('id') || (body && body.id));
    if (!id) return sendJSON(res, 400, { ok: false, error: 'id' });
    if (!fs.existsSync(metaFile(id))) return sendJSON(res, 404, { ok: false, error: 'not-found', message: '先传 meta 再 complete' });
    fs.writeFileSync(flagFile(id), new Date().toISOString(), 'utf8');
    const st = setStatus(id, { state: 'uploaded' });
    return sendJSON(res, 200, { ok: true, id: id, state: 'uploaded', status: st });
  }

  // POST /api/session/note —— {id, markdown} 写 note.md
  async function postSessionNote(req, res, url) {
    let body;
    try {
      body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad-json', message: e.message });
    }
    const id = safeId((body && body.id) || url.searchParams.get('id'));
    if (!id) return sendJSON(res, 400, { ok: false, error: 'id' });
    if (!fs.existsSync(metaFile(id))) return sendJSON(res, 404, { ok: false, error: 'not-found' });
    if (typeof body.markdown !== 'string') return sendJSON(res, 400, { ok: false, error: 'markdown' });
    fs.mkdirSync(sessionDir(id), { recursive: true });
    fs.writeFileSync(noteFile(id), body.markdown, 'utf8');
    setStatus(id, {});
    return sendJSON(res, 200, { ok: true, id: id, size: Buffer.byteLength(body.markdown, 'utf8') });
  }

  // GET /api/notes —— 列表
  async function getNotes(req, res) {
    const notes = [];
    let names = [];
    try { names = fs.readdirSync(agentRoot); } catch (e) { names = []; }
    for (const id of names) {
      if (!safeId(id)) continue;
      const meta = readJSON(metaFile(id), null);
      if (!meta) continue;
      if (meta.deleted === true) continue;
      if (meta.mergedInto && safeId(meta.mergedInto)) continue;   // 归并碎片不单列
      const st = readJSON(statusFile(id), {}) || {};
      const complete = fs.existsSync(flagFile(id));
      const ai = meta.aiNote && typeof meta.aiNote === 'object' ? meta.aiNote : {};
      notes.push({
        id: id,
        course: String(meta.course || meta.courseName || ''),
        title: String(st.title || ai.title || meta.courseName || meta.course || ''),
        state: String(st.state || (complete ? 'uploaded' : 'uploading')),
        summary: String(st.summary || ai.summary || ''),
        startedAt: Number(meta.startedAt) || 0,
        durationMs: Number(meta.durationMs) || 0,
        photoCount: Array.isArray(meta.photos) ? meta.photos.length : 0,
        segmentCount: Array.isArray(meta.segments) ? meta.segments.length : 0,
        hasNote: fs.existsSync(noteFile(id)) && statSize(noteFile(id)) > 0
      });
    }
    notes.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return sendJSON(res, 200, { ok: true, notes: notes });
  }

  // GET /api/note?id= —— 单篇
  async function getNote(req, res, url) {
    const id = safeId(url.searchParams.get('id'));
    if (!id) return sendJSON(res, 400, { ok: false, error: 'id' });
    const meta = readJSON(metaFile(id), null);
    if (!meta) return sendJSON(res, 404, { ok: false, error: 'not-found' });
    let note = '';
    try { note = fs.readFileSync(noteFile(id), 'utf8'); } catch (e) { note = ''; }
    return sendJSON(res, 200, {
      ok: true,
      id: id,
      meta: meta,
      status: readJSON(statusFile(id), {}) || {},
      note: note,
      items: readJSON(itemsFile(id), null)
    });
  }

  // GET /api/source?id= —— 原始素材
  async function getSource(req, res, url) {
    const id = safeId(url.searchParams.get('id'));
    if (!id) return sendJSON(res, 400, { ok: false, error: 'id' });
    const meta = readJSON(metaFile(id), null);
    if (!meta) return sendJSON(res, 404, { ok: false, error: 'not-found' });
    const segments = (Array.isArray(meta.segments) ? meta.segments : []).map((s) => {
      const name = safeName(s && s.name) || String((s && s.name) || '');
      return {
        name: name,
        offsetMs: Math.max(0, toInt(s && s.startOffsetMs, 0)),
        size: name ? statSize(filePath(id, name)) : 0
      };
    });
    const photos = (Array.isArray(meta.photos) ? meta.photos : []).map((p) => {
      const name = safeName(p && p.name) || String((p && p.name) || '');
      return {
        name: name,
        offsetMs: Math.max(0, toInt(p && p.offsetMs, 0)),
        size: name ? statSize(filePath(id, name)) : 0
      };
    });
    return sendJSON(res, 200, {
      ok: true,
      id: id,
      meta: meta,
      transcript: meta.transcript || null,
      segments: segments,
      photos: photos
    });
  }

  // GET /api/file?id=&name= —— 二进制 + HTTP Range
  async function getFile(req, res, url) {
    const id = safeId(url.searchParams.get('id'));
    const name = safeName(url.searchParams.get('name'));
    if (!id) return sendJSON(res, 400, { ok: false, error: 'id' });
    if (!name) return sendJSON(res, 400, { ok: false, error: 'name' });
    const target = filePath(id, name);
    let size = 0;
    try {
      const st = fs.statSync(target);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch (e) {
      return sendJSON(res, 404, { ok: false, error: 'not-found' });
    }
    const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'private, max-age=86400',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    };
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        let start = m[1] === '' ? -1 : parseInt(m[1], 10);
        let end = m[2] === '' ? -1 : parseInt(m[2], 10);
        if (start < 0 && end >= 0) {           // bytes=-500（末尾 N 字节）
          start = Math.max(0, size - end);
          end = size - 1;
        } else {
          if (start < 0) start = 0;
          if (end < 0 || end >= size) end = size - 1;
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + size, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' });
          return res.end();
        }
        headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
        headers['Content-Length'] = end - start + 1;
        res.writeHead(206, headers);
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(target, { start: start, end: end });
        stream.on('error', function () { try { res.destroy(); } catch (e) {} });
        return stream.pipe(res);
      }
    }
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(target);
    stream.on('error', function () { try { res.destroy(); } catch (e) {} });
    return stream.pipe(res);
  }

  // ---------- 总入口 ----------
  // 返回 true 表示已认领并完成响应；false 交回 server.js 的旧路由。
  async function handle(req, res, url) {
    const p = url.pathname;
    if (!ROUTES.has(p)) return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'x-app-token,content-type,range',
        'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS',
        'Access-Control-Expose-Headers': 'Content-Range,Content-Length,Accept-Ranges',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return true;
    }
    if (!authorized(req, url)) {
      sendJSON(res, 401, { ok: false, error: 'token', message: 'x-app-token 不对或缺失（token 见 data/api-token.txt，可用 APP_TOKEN 覆盖）' });
      return true;
    }
    try {
      if (p === '/api/session/meta') {
        if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method' }), true;
        await postSessionMeta(req, res, url);
        return true;
      }
      if (p === '/api/chunk') {
        if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method' }), true;
        await postChunk(req, res, url);
        return true;
      }
      if (p === '/api/session/complete') {
        if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method' }), true;
        await postSessionComplete(req, res, url);
        return true;
      }
      if (p === '/api/session/note') {
        if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method' }), true;
        await postSessionNote(req, res, url);
        return true;
      }
      if (p === '/api/notes') {
        if (req.method !== 'GET') return sendJSON(res, 405, { ok: false, error: 'method' }), true;
        await getNotes(req, res);
        return true;
      }
      if (p === '/api/note') {
        if (req.method !== 'GET') return sendJSON(res, 405, { ok: false, error: 'method' }), true;
        await getNote(req, res, url);
        return true;
      }
      if (p === '/api/source') {
        if (req.method !== 'GET') return sendJSON(res, 405, { ok: false, error: 'method' }), true;
        await getSource(req, res, url);
        return true;
      }
      if (p === '/api/file') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { ok: false, error: 'method' }), true;
        await getFile(req, res, url);
        return true;
      }
      return false;
    } catch (e) {
      if (!res.headersSent) sendJSON(res, 500, { ok: false, error: 'server', message: (e && e.message) || String(e) });
      else { try { res.destroy(); } catch (err) {} }
      return true;
    }
  }

  return {
    handle: handle,
    routes: ROUTES,
    dataDir: dataDir,
    tokenFile: tokenFile
  };
}

module.exports = { create: create };
