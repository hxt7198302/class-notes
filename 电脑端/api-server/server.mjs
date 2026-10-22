// 课堂笔记APP 电脑端 API 服务（Node 零依赖，端口 8776）。
// 职责：接收手机上传的课堂素材（录音+照片，分块续传）、登记课程会话、
//       触发「转写→AI分析」流水线、向手机提供笔记列表与笔记内容（含照片文件）。
// 鉴权：所有请求须带 header x-app-token（与 api-token.txt 一致）；GET /api/file
//       额外允许 ?token= 查询参数（WebView/图片场景用），其余一律 header。
// v2.0 开源版：/api/deadlines 数据源可配（config.deadlinesFile，默认本机 data\），
//       新增 UDP 局域网自动发现（同 WiFi 手机一键连电脑）和 /api/ai-key（免费 key 配置）。
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import os from 'os';
import dgram from 'dgram';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { renderNoteHtml } from '../md2html.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SUCAI = path.join(ROOT, '素材');   // 素材/<sessionId>/meta.json + files\*
const BIJI = path.join(ROOT, '笔记');    // 笔记/<sessionId>/status.json + note.md/html + items.json
const COURSE_CFG = path.join(ROOT, '电脑端', 'course-config.json');   // v1.6 课程偏好（例题汇总开关表）
const TODO_DONE_FILE = path.join(ROOT, '电脑端', 'todo-done.json');   // v1.7 课程待办勾选记录 {cls:id : {ts,title}}
const MAIN_CFG_FILE = path.join(HERE, '..', 'config.json');           // 电脑端\config.json（引擎/转写/ntfy/私有部署配置）
const CFG = (() => { try { return JSON.parse(fs.readFileSync(MAIN_CFG_FILE, 'utf8')); } catch { return {}; } })();
// v1.7 小助手倒计时数据源：私有版在 config.deadlinesFile 指向小助手；开源版默认 电脑端\data\（自动建）
const DEADLINES_FILE = CFG.deadlinesFile || path.join(HERE, '..', 'data', 'deadlines.json');
const LOG = path.join(HERE, 'server-log.txt');
const TOKEN_FILE = path.join(HERE, 'api-token.txt');
const PORT = 8776;
fs.mkdirSync(SUCAI, { recursive: true });
fs.mkdirSync(BIJI, { recursive: true });

if (!fs.existsSync(TOKEN_FILE)) {
  fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(16).toString('hex'));
  console.log('[token] 已生成新 token');
}
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

function log(s) {
  const line = `[${new Date().toLocaleString('sv-SE')}] ${s}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch { }
  console.log(line);
}
function send(res, code, obj) {
  // 走隧道的响应一律 gzip（手机 HttpURLConnection 会自动带 Accept-Encoding 并透明解压），
  // 总纲/笔记这类几 KB~几十 KB 的文本能压 5~10 倍，慢隧道上体感明显
  let body = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  const acc = String((res.req && res.req.headers['accept-encoding']) || '');
  if (acc.includes('gzip') && body.length > 512) {
    body = zlib.gzipSync(body);
    h['Content-Encoding'] = 'gzip';
  }
  h['Content-Length'] = body.length;
  res.writeHead(code, h);
  res.end(body);
}
function safeId(id) { return /^[A-Za-z0-9_-]{6,64}$/.test(id || '') ? id : null; }
function sessDir(id) { return path.join(SUCAI, id); }
function noteDir(id) { return path.join(BIJI, id); }
function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }
/** 例题汇总开关表（v1.6）：{课名: true/false}；文件没有/损坏=全关 */
function courseExamples() {
  const cfg = readJson(COURSE_CFG, {});
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof k === 'string' && k.length && typeof v === 'boolean') out[k] = v;
  }
  return out;
}
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, f);
}
/** 本地时区今天的 yyyy-MM-dd（与 APP 端同一口径判过期） */
function localToday() { return new Date().toLocaleDateString('sv-SE'); }
/** 改 deadlines.json 前备份（沿用小助手 data\backup 的命名惯例；只增不删，守不删铁律） */
function backupDeadlines() {
  try {
    const dir = path.join(path.dirname(DEADLINES_FILE), 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const s = new Date().toLocaleString('sv-SE').slice(0, 16).replace(/[-: ]/g, '');   // yyyyMMddHHmm
    const dst = path.join(dir, `deadlines.json.备份${s.slice(0, 8)}-${s.slice(8)}`);
    if (!fs.existsSync(dst)) fs.copyFileSync(DEADLINES_FILE, dst);
  } catch (e) { log(`[deadline-done] 备份失败（继续改）：${e.message}`); }
}
function setStatus(id, patch) {
  const f = path.join(noteDir(id), 'status.json');
  const cur = readJson(f, {});
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  writeJson(f, next);
  return next;
}

// 把请求体收进 buffer（限制大小；分块上传每块 ≤ 8MB）
function readRaw(req, limit = 9 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- 触发分析流水线（全局串行队列） ----------
// GPU 一次只吃得下一个 large-v3：多个会话同时各拉一条流水线会把显存挤爆，
// 转写互相拖慢十几倍甚至进程硬崩，所以全局一次只跑一条，其余排队。
// 队列在内存里；服务器重启丢队列后由 rescan() 把未完成会话重新补进来。
const running = new Set();
const queue = [];
let pipelineAlive = false;
let curChild = null;      // 当前流水线子进程（看门狗用）
let curStartMs = 0;
function startPipeline(id) {
  if (running.has(id) || queue.includes(id)) return false;   // 排队中的不重复入队
  running.add(id);
  queue.push(id);
  log(`[queue] 会话 ${id} 入队（第 ${queue.length} 位）`);
  pump();
  return true;
}
function pump() {
  if (pipelineAlive || queue.length === 0) return;
  const id = queue.shift();
  pipelineAlive = true;
  const child = spawn(process.execPath, [path.join(ROOT, '电脑端', 'pipeline.mjs'), id], {
    cwd: ROOT, detached: true, stdio: 'ignore',
  });
  curChild = child; curStartMs = Date.now();
  log(`[pipeline] 会话 ${id} 分析流水线已拉起，独占转写 (pid ${child.pid})`);
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    pipelineAlive = false;
    running.delete(id);
    log(`[pipeline] 会话 ${id} 流水线退出，队列剩 ${queue.length} 个`);
    // 同日同课补跑：这条流水线跑的期间若又有新素材并进来（mergeDirty），自动再跑一遍，
    // 段级 transcribe.done 缓存保证只转写新增段
    try {
      const am = readJson(path.join(sessDir(id), 'meta.json'), {});
      if (am.mergeDirty) {
        writeJson(path.join(sessDir(id), 'meta.json'), { ...am, mergeDirty: false });
        log(`[queue] 会话 ${id} 分析期间有同课新素材并入，自动补跑`);
        queue.push(id);
      }
    } catch { }
    pump();
  };
  child.on('exit', done);
  child.on('error', done);
  child.unref();
}

// 开机/重启自愈：素材收完了但笔记还没完成的会话，全部重新入队；
// 卡在 transcribing/analyzing 超过 60 分钟没动静的（无头会话被杀等）也自动重跑
function rescan() {
  let n = 0;
  const now = Date.now();
  for (const d of fs.readdirSync(SUCAI)) {
    if (!safeId(d)) continue;
    const flag = path.join(sessDir(d), 'complete.flag');
    const st = readJson(path.join(noteDir(d), 'status.json'), {});
    const meta = readJson(path.join(sessDir(d), 'meta.json'), {});
    if (meta.mergedInto) continue;   // 已并入同日同课的碎片永不单独入队
    const staleMin = st.updatedAt ? (now - Date.parse(st.updatedAt)) / 60000 : Infinity;
    const stuck = ['transcribing', 'analyzing'].includes(st.state) && staleMin > 60;
    // mergeDirty（分析完才并进来的同课素材）也要补跑，即使状态已是 done
    const dirtyDone = st.state === 'done' && meta.mergeDirty === true;
    if (fs.existsSync(flag) && (dirtyDone || !['done', 'transcribing', 'analyzing'].includes(st.state) || stuck)) {
      setStatus(d, { state: 'queued', note: stuck ? '分析超时未交卷，自动重跑' : (dirtyDone ? '有同课新素材并入，重新整理' : '服务重启后自动重新入队') });
      startPipeline(d); n++;
    }
  }
  if (n) log(`[rescan] ${n} 个未完成会话已重新入队`);
}

// ---------- 同日同课归并（v1.4） ----------
// 一天上的同一门课（连堂两节 / 录音中断重录的多段）自动归并到当日最早的一条「锚点」会话，
// 手机笔记列表只见一项、出一篇覆盖全天的笔记。成员素材不搬运：锚点 meta 的
// segments/photos/markers 追加成员条目并带 srcId 指回成员目录，时间轴按 startedAt 差平移。
function dayKey(ms) {
  const d = new Date(Number(ms) || 0);
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function readSessMeta(id) { return readJson(path.join(sessDir(id), 'meta.json'), null); }
function mergeMemberInto(anchorId, memberId) {
  const aF = path.join(sessDir(anchorId), 'meta.json');
  const a = readSessMeta(anchorId);
  const m = readSessMeta(memberId);
  if (!a || !m || anchorId === memberId) return false;
  const shift = (m.startedAt || 0) - (a.startedAt || 0);
  const members = (a.members || []).filter(x => x.id !== memberId);
  members.push({ id: memberId, startedAt: m.startedAt || 0, durationMs: m.durationMs | 0 });
  // 成员自己之前若是别的锚点、手底下还有更早的成员，一并过继过来
  for (const sub of (m.members || [])) {
    if (!members.some(x => x.id === sub.id)) members.push(sub);
    try { writeJson(path.join(sessDir(sub.id), 'meta.json'), { ...readSessMeta(sub.id), mergedInto: anchorId }); } catch { }
  }
  const segs = (a.segments || []).slice();
  const photos = (a.photos || []).slice();
  const markers = (a.markers || []).slice();
  const mSegs = m.segments || [];
  for (let j = 0; j < mSegs.length; j++) {
    const s = mSegs[j];
    if (segs.some(x => x.srcId === memberId && x.name === s.name)) continue;   // 重复 complete 幂等
    const newIdx = segs.length;   // 只追加不重排：锚点已有段的 seg_XX 转写缓存索引保持稳定
    segs.push({ name: s.name, startOffsetMs: (s.startOffsetMs | 0) + shift, srcId: memberId });
    // 段级转写缓存搬家：成员已转写过的段平移时间轴后直接挂进锚点，流水线零重复转写
    try {
      const srcDir = path.join(sessDir(memberId), 'seg_' + String(j).padStart(2, '0'));
      if (fs.existsSync(path.join(srcDir, 'transcribe.done'))) {
        const rows = readJson(path.join(srcDir, 'transcript.json'), null);
        if (rows && rows.length) {
          const dstDir = path.join(sessDir(anchorId), 'seg_' + String(newIdx).padStart(2, '0'));
          fs.mkdirSync(dstDir, { recursive: true });
          const sh = shift / 1000;
          writeJson(path.join(dstDir, 'transcript.json'), rows.map(rw => ({ s: rw.s + sh, e: rw.e + sh, t: rw.t })));
          fs.writeFileSync(path.join(dstDir, 'transcribe.done'), new Date().toISOString());
        }
      }
    } catch (e) { log(`[merge] ${memberId} 第${j}段转写缓存搬家失败（按重新转写处理）：${e.message}`); }
  }
  for (const p of (m.photos || [])) {
    if (photos.some(x => x.srcId === memberId && x.name === p.name)) continue;
    photos.push({ name: p.name, offsetMs: (p.offsetMs | 0) + shift, takenAt: p.takenAt | 0, srcId: memberId });
  }
  for (const k of (m.markers || [])) {
    const off = (k.offsetMs | 0) + shift;
    if (markers.some(x => x.srcId === memberId && x.offsetMs === off)) continue;
    markers.push({ offsetMs: off, type: k.type || '🔖重点', note: k.note || '', srcId: memberId });
  }
  writeJson(aF, { ...a, segments: segs, photos, markers, members, mergeDirty: false });
  writeJson(path.join(sessDir(memberId), 'meta.json'), { ...m, mergedInto: anchorId });
  setStatus(memberId, { state: 'uploaded', mergedInto: anchorId, note: `已并入同日同课 ${anchorId}` });
  log(`[merge] ${memberId} 并入 ${anchorId}（平移 ${Math.round(shift / 1000)}s，段 ${m.segments?.length || 0} 照片 ${m.photos?.length || 0}）`);
  return true;
}

// ---------- 会话状态汇总（给 APP 的 /api/notes） ----------
function sessionSummary(id) {
  const meta = readJson(path.join(sessDir(id), 'meta.json'), null);
  if (!meta) return null;
  const st = readJson(path.join(noteDir(id), 'status.json'), {});
  const files = (() => { try { return fs.readdirSync(path.join(sessDir(id), 'files')); } catch { return []; } })();
  return {
    id,
    course: meta.course || '',
    startedAt: meta.startedAt || 0,
    durationMs: meta.durationMs || 0,
    photoCount: (meta.photos || []).length,
    state: st.state || (fs.existsSync(path.join(sessDir(id), 'complete.flag')) ? 'queued' : 'uploading'),
    title: st.title || '',
    error: st.error || '',
    noteUpdated: st.updatedAt || '',
    research: fs.existsSync(path.join(noteDir(id), 'research')) ? fs.readdirSync(path.join(noteDir(id), 'research')).length : 0,
    files: files.length,
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const q = u.searchParams;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'x-app-token,content-type',
      'Access-Control-Allow-Methods': 'GET,POST',
      'Access-Control-Allow-Max-Age': '86400',
    });
    return res.end();
  }
  const token = req.headers['x-app-token'] || q.get('token');
  // v2.0 配对信息端点免 token（手动连接模式用）：只绑 0.0.0.0（局域网直连部署）时才有意义，
  // 只回 token+频道+电脑名，与 UDP 发现同信任级（局域网明文，公共 WiFi 不建议）
  if (p === '/api/pair-info' && LISTEN === '0.0.0.0') {
    const lan = lanIp();
    return send(res, 200, { ok: true, app: 'classnotes', version: 2, name: os.hostname(), server: lan ? `http://${lan}:${PORT}` : '', token: TOKEN, topic: String(CFG.ntfyTopic || '') });
  }
  if (token !== TOKEN) { log(`[401] ${req.method} ${p}`); return send(res, 401, { ok: false, error: 'token 不对' }); }

  try {
    if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { ok: true, name: 'class-notes-api', ts: Date.now() });

    // ---- 上传：登记会话元数据（photos 数组带每张照片相对录音的毫秒偏移）----
    if (req.method === 'POST' && p === '/api/session/meta') {
      const body = JSON.parse((await readRaw(req)).toString('utf8'));
      const id = safeId(body.id);
      if (!id) return send(res, 400, { ok: false, error: '会话 id 不合法' });
      if (!body.course || !body.startedAt || !body.endedAt) return send(res, 400, { ok: false, error: '缺 course/startedAt/endedAt' });
      const dir = sessDir(id);
      fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
      const isNew = !fs.existsSync(path.join(dir, 'meta.json'));
      const prev = readJson(path.join(dir, 'meta.json'), null);
      writeJson(path.join(dir, 'meta.json'), {
        id, course: String(body.course).slice(0, 40),
        startedAt: body.startedAt, endedAt: body.endedAt, durationMs: body.durationMs | 0,
        device: String(body.device || '').slice(0, 80),
        // 分段录音：每段 {name, startOffsetMs}（相对整堂课开始的偏移）
        segments: (body.segments || []).map(x => ({
          name: safeName(x.name), startOffsetMs: x.startOffsetMs | 0,
        })).filter(x => x.name),
        photos: (body.photos || []).map(x => ({
          name: safeName(x.name), offsetMs: x.offsetMs | 0, takenAt: x.takenAt | 0,
        })).filter(x => x.name),
        // 课堂标记（v1.1+）：上课时用户手动打的重点 {offsetMs, type, note}
        markers: (body.markers || []).map(x => ({
          offsetMs: x.offsetMs | 0,
          type: String(x.type || '🔖重点').slice(0, 20),
          note: String(x.note || '').slice(0, 200),
        })).filter(x => x.offsetMs >= 0),
      });
      // 已并入同日同课的碎片被 APP 重复上传：保留归并关系，不重新触发整理
      if (prev && prev.mergedInto && safeId(prev.mergedInto)) {
        writeJson(path.join(dir, 'meta.json'), { ...readJson(path.join(dir, 'meta.json'), {}), mergedInto: prev.mergedInto });
        setStatus(id, { state: 'uploaded', mergedInto: prev.mergedInto, note: `已并入同日同课 ${prev.mergedInto}（重复上传不重复整理）` });
        const received = {};
        try {
          for (const f of fs.readdirSync(path.join(dir, 'files'))) received[f] = fs.statSync(path.join(dir, 'files', f)).size;
        } catch { }
        log(`[meta] 已并入的碎片 ${id} 重复上传，忽略（锚点 ${prev.mergedInto}）`);
        return send(res, 200, { ok: true, received });
      }
      // 本会话自己是锚点（手上已有并入的成员段）：APP 重传 meta 会把 segments 整个覆盖掉，
      // 把成员条目和 members 原样接回去（APP 自己的段以新传的为准）
      if (prev && Array.isArray(prev.members) && prev.members.length) {
        const fresh = readJson(path.join(dir, 'meta.json'), {});
        const segs = (fresh.segments || []).slice();
        const photos = (fresh.photos || []).slice();
        const markers = (fresh.markers || []).slice();
        for (const s of (prev.segments || [])) if (s.srcId && !segs.some(x => x.srcId === s.srcId && x.name === s.name)) segs.push(s);
        for (const p of (prev.photos || [])) if (p.srcId && !photos.some(x => x.srcId === p.srcId && x.name === p.name)) photos.push(p);
        for (const k of (prev.markers || [])) if (k.srcId && !markers.some(x => x.srcId === k.srcId && x.offsetMs === k.offsetMs)) markers.push(k);
        writeJson(path.join(dir, 'meta.json'), { ...fresh, segments: segs, photos, markers, members: prev.members, mergeDirty: prev.mergeDirty === true });
        log(`[meta] 锚点 ${id} 重传 meta，已接回 ${prev.members.length} 个成员的素材条目`);
      }
      setStatus(id, { state: 'uploading', course: body.course });
      // 续传：把服务端已收到的字节数告诉手机
      const received = {};
      try {
        for (const f of fs.readdirSync(path.join(dir, 'files'))) received[f] = fs.statSync(path.join(dir, 'files', f)).size;
      } catch { }
      log(`[meta] ${isNew ? '新会话' : '续传'} ${id} 课程=${body.course} 照片=${(body.photos || []).length}`);
      return send(res, 200, { ok: true, received });
    }

    // ---- 上传：单个文件分块追加 ----
    if (req.method === 'POST' && p === '/api/chunk') {
      const id = safeId(q.get('id'));
      const name = safeName(q.get('name'));
      if (!id || !name) return send(res, 400, { ok: false, error: 'id/name 不合法' });
      const expected = parseInt(q.get('offset') || '0', 10);
      const file = path.join(sessDir(id), 'files', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const cur = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (expected !== cur) return send(res, 409, { ok: false, received: cur, error: `偏移不对（客户端 ${expected} / 服务端 ${cur}）` });
      const buf = await readRaw(req);
      // 可选分块校验：客户端带 &md5=（hex）即核对，传输损坏当场打回重传；
      // 不带此参数（如 v1.0 APP）则跳过校验，完全兼容
      const want = String(q.get('md5') || '').toLowerCase();
      if (want && crypto.createHash('md5').update(buf).digest('hex') !== want) {
        log(`[chunk] ${id}/${name} offset=${expected} md5 校验失败，拒收`);
        return send(res, 422, { ok: false, received: cur, error: '分块 md5 校验失败，请重传该块' });
      }
      fs.appendFileSync(file, buf);
      return send(res, 200, { ok: true, received: cur + buf.length });
    }

    // ---- 上传：收尾（同日同课归并 + 触发分析）----
    if (req.method === 'POST' && p === '/api/session/complete') {
      const id = safeId(q.get('id') || '');
      const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
      const sid = safeId(body.id) || id;
      if (!sid) return send(res, 400, { ok: false, error: 'id 不合法' });
      const dir = sessDir(sid);
      if (!fs.existsSync(path.join(dir, 'meta.json'))) return send(res, 404, { ok: false, error: '先传 meta 再 complete' });
      fs.writeFileSync(path.join(dir, 'complete.flag'), new Date().toISOString());

      // ---- 同日同课归并：同课程+同自然日的收齐会话，归到开始最早的锚点 ----
      const me = readSessMeta(sid) || {};
      // 已并入锚点的碎片被重复收尾（APP 重试等）：直接忽略，绝不单独再分析
      if (me.mergedInto && safeId(me.mergedInto)) {
        log(`[complete] ${sid} 已并入 ${me.mergedInto}，忽略重复收尾`);
        return send(res, 200, { ok: true, state: 'uploaded', anchor: me.mergedInto });
      }
      let anchorId = sid;
      try {
        const group = [];
        for (const d of fs.readdirSync(SUCAI)) {
          if (!safeId(d) || d === sid) continue;
          const m = readSessMeta(d);
          if (!m || m.mergedInto || m.course !== me.course) continue;
          if (dayKey(m.startedAt) !== dayKey(me.startedAt)) continue;
          if (!fs.existsSync(path.join(sessDir(d), 'complete.flag'))) continue;   // 只归并已收齐的
          group.push(m);
        }
        const cands = [me, ...group].sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
        anchorId = cands[0].id;
        for (const m of cands.slice(1)) mergeMemberInto(anchorId, m.id);
      } catch (e) { log(`[merge] 归并失败（按不合并继续）：${e.message}`); anchorId = sid; }

      const stA = readJson(path.join(noteDir(anchorId), 'status.json'), {});
      const busy = ['transcribing', 'analyzing'].includes(stA.state || '');
      let st = null;
      if (anchorId === sid) {
        st = setStatus(anchorId, { state: 'queued', note: '素材收齐，等待分析' });
        startPipeline(anchorId);
      } else if (busy) {
        // 锚点正在跑流水线：记 dirty 标记，流水线退出时自动补跑（只转写新增段）
        const am = readSessMeta(anchorId) || {};
        writeJson(path.join(sessDir(anchorId), 'meta.json'), { ...am, mergeDirty: true });
        setStatus(anchorId, { note: '分析进行中，有同课新素材并进来，跑完自动补跑' });
        log(`[merge] ${sid} 并入正在分析的 ${anchorId}，已标记补跑`);
      } else {
        setStatus(anchorId, { state: 'queued', note: '新到的同课素材已并入，重新整理' });
        startPipeline(anchorId);
      }
      if (!st) st = { state: readJson(path.join(noteDir(sid), 'status.json'), {}).state || 'uploaded' };
      return send(res, 200, { ok: true, state: st.state, anchor: anchorId });
    }

    // ---- 笔记：列表（同日同课合并后锚点一条，碎片不单列） ----
    if (req.method === 'GET' && p === '/api/notes') {
      const list = [];
      for (const d of fs.readdirSync(SUCAI)) {
        const meta = readJson(path.join(sessDir(d), 'meta.json'), null);
        if (!meta || meta.mergedInto) continue;
        const s = sessionSummary(d);
        if (!s) continue;
        const parts = (meta.members || []).length + 1;
        if (parts > 1) s.parts = parts;
        list.push(s);
      }
      list.sort((a, b) => b.startedAt - a.startedAt);
      return send(res, 200, { ok: true, list });
    }

    // ---- 笔记：单条（含 note.html 与照片文件名清单）----
    if (req.method === 'GET' && p === '/api/note') {
      const id = safeId(q.get('id'));
      if (!id) return send(res, 400, { ok: false, error: 'id 不合法' });
      const sum = sessionSummary(id);
      if (!sum) return send(res, 404, { ok: false, error: '没有这个会话' });
      const nd = noteDir(id);
      const mdF = path.join(nd, 'note.md');
      const htmlF = path.join(nd, 'note.html');
      const mdNew = fs.existsSync(mdF) ? fs.statSync(mdF).mtimeMs : 0;
      if (mdNew && (!fs.existsSync(htmlF) || fs.statSync(htmlF).mtimeMs < mdNew)) {
        fs.writeFileSync(htmlF, renderNoteHtml(fs.readFileSync(mdF, 'utf8'), id));
      }
      let html = '';
      try { html = fs.readFileSync(htmlF, 'utf8'); } catch { }
      const photos = sum.photoCount ? readJson(path.join(sessDir(id), 'meta.json'), {}).photos : [];
      const items = readJson(path.join(nd, 'items.json'), null);
      const research = (() => { try { return fs.readdirSync(path.join(nd, 'research')); } catch { return []; } })();
      return send(res, 200, { ok: true, ...sum, html, photos, items, research });
    }

    // ---- 文件：录音/照片（素材目录，白名单路径；同日合并会话兜底到成员目录）----
    if (req.method === 'GET' && p === '/api/file') {
      const id = safeId(q.get('id'));
      const name = safeName(q.get('name'));
      if (!id || !name) return send(res, 400, { ok: false, error: 'id/name 不合法' });
      let file = path.join(sessDir(id), 'files', name);
      if (!fs.existsSync(file)) {
        const meta = readSessMeta(id);
        const ent = meta ? [...(meta.photos || []), ...(meta.segments || [])].find(x => x.name === name && x.srcId && safeId(x.srcId)) : null;
        if (ent) file = path.join(sessDir(ent.srcId), 'files', name);
      }
      if (!fs.existsSync(file)) return send(res, 404, { ok: false, error: '文件不存在' });
      const ext = path.extname(file).toLowerCase();
      const type = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.m4a': 'audio/mp4', '.aac': 'audio/aac' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'private, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // ---- 应用内更新（v1.1+）：清单 + APK 直下（APK 与清单都放电脑上，走隧道手机直连）----
    if (req.method === 'GET' && p === '/api/version') {
      const v = readJson(path.join(ROOT, '电脑端', 'latest.json'), null);
      if (!v || !v.apk) return send(res, 404, { ok: false, error: '没有版本信息' });
      return send(res, 200, { ok: true, ...v });
    }
    if (req.method === 'GET' && p === '/api/apk') {
      const v = readJson(path.join(ROOT, '电脑端', 'latest.json'), null);
      const name = String(v && v.apk || '');
      // latest.json 是我们自己写的，但防穿越照做；文件名允许中文
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return send(res, 404, { ok: false, error: '没有安装包' });
      const f = path.join(ROOT, '交付', name);
      if (!fs.existsSync(f)) return send(res, 404, { ok: false, error: '安装包不存在' });
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': fs.statSync(f).size,
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(f).pipe(res);
      return;
    }

    // ---- 课程聚合（v1.2 课程页：每课程=总纲+待办+笔记；顶层作业汇总） ----
    // v1.7：todos 每条带 id（cls:会话:序号）供勾选；todo-done.json 里 id+标题都对上的不再下发；
    //      过期的拆进 todosOverdue（APP 端默认折叠），items.json 本身不动。
    if (req.method === 'GET' && p === '/api/courses') {
      const courses = {};
      const doneMap = readJson(TODO_DONE_FILE, {}) || {};
      const hiddenTitles = new Set(Array.isArray(doneMap.__titles__) ? doneMap.__titles__.map(String) : []);
      const today = localToday();
      for (const d of fs.readdirSync(BIJI)) {
        if (!safeId(d)) continue;
        const st = readJson(path.join(BIJI, d, 'status.json'), null);
        if (!st || !st.course || String(st.course).includes('自测')) continue;   // TTS 假课不进正式课程
        const c = courses[st.course] || (courses[st.course] = { course: st.course, notes: [], todos: [], todosOverdue: [] });
        if (fs.existsSync(path.join(BIJI, d, 'note.md'))) {
          c.notes.push({ id: d, title: st.title || st.course, state: st.state || '', noteUpdated: st.updatedAt || '' });
        }
        const items = readJson(path.join(BIJI, d, 'items.json'), []);
        let idx = 0;
        for (const it of (Array.isArray(items) ? items : [])) {
          const tid = `cls:${d}:${idx}`;
          const title = String(it.title || '').slice(0, 120);
          const rec = doneMap[tid];
          if ((rec && (rec.ts | 0) > 0 && String(rec.title || '') === title) || hiddenTitles.has(title)) { idx++; continue; }   // 手机勾掉（id+标题对上）或按标题联动隐藏；reanalyze 重写后序号漂移不误藏
          const due = String(it.due || '');
          const todo = {
            id: tid, title, category: String(it.category || '其他').slice(0, 10),
            due, urgent: !!it.urgent, source: `课堂笔记APP·${st.course}`,
          };
          if (due && due < today) c.todosOverdue.push(todo); else c.todos.push(todo);
          idx++;
        }
      }
      const list = Object.values(courses);
      for (const c of list) c.notes.sort((a, b) => (a.noteUpdated < b.noteUpdated ? 1 : -1));
      list.sort((a, b) => b.notes.length - a.notes.length);
      // v1.6 例题汇总开关表一并下发（APP 端换机/重装时用它找回设置）
      return send(res, 200, { ok: true, list, examples: courseExamples() });
    }

    // ---- 课程偏好（v1.6 例题汇总开关）：APP 推 {courses:{课名:bool}}，按课合并进 course-config.json ----
    if (req.method === 'POST' && p === '/api/course-config') {
      const body = JSON.parse((await readRaw(req, 256 * 1024)).toString('utf8'));
      const courses = (body && typeof body.courses === 'object' && !Array.isArray(body.courses)) ? body.courses : null;
      if (!courses) return send(res, 400, { ok: false, error: '缺 courses 对象' });
      const next = JSON.parse(JSON.stringify(courseExamples()));   // 读-改-写合并，没提到的课不动
      let n = 0;
      for (const [name, on] of Object.entries(courses)) {
        const c = String(name).slice(0, 40).trim();
        if (!c || c.includes('..') || /[\\/:*?"<>|]/.test(c)) continue;
        next[c] = !!on;
        n++;
      }
      writeJson(COURSE_CFG, next);
      const onCount = Object.values(next).filter(Boolean).length;
      log(`[course-config] 收 ${n} 门课设置，合并后例题汇总开着 ${onCount} 门`);
      return send(res, 200, { ok: true, courses: next });
    }

    // ---- 课程总纲（电脑端\课程总纲\<课程>.md，分析流水线每课顺手更新）----
    // v1.4：带 have=（手机缓存的 md 修改时间）可增量核对——没变只回几十字节不传正文
    if (req.method === 'GET' && p === '/api/overview') {
      const course = String(q.get('course') || '').slice(0, 40);
      if (!course || course.includes('..') || /[\\/:*?"<>|]/.test(course)) return send(res, 400, { ok: false, error: '课程名不合法' });
      const f = path.join(ROOT, '电脑端', '课程总纲', course + '.md');
      if (!fs.existsSync(f)) return send(res, 404, { ok: false, error: '这门课还没有总纲（上完一节课整理笔记时会自动生成）' });
      const mdF = f, htmlF = f.replace(/\.md$/, '.html');
      const mdNew = fs.statSync(mdF).mtimeMs;
      const have = Number(q.get('have') || 0);
      if (have > 0 && mdNew <= have) return send(res, 200, { ok: true, course, unchanged: true, mdTime: mdNew });
      if (!fs.existsSync(htmlF) || fs.statSync(htmlF).mtimeMs < mdNew) {
        fs.writeFileSync(htmlF, renderNoteHtml(fs.readFileSync(mdF, 'utf8'), 'overview-' + course));
      }
      return send(res, 200, { ok: true, course, mdTime: mdNew, html: fs.readFileSync(htmlF, 'utf8') });
    }

    // ---- 北信科小助手倒计时（v1.3 课程页整合，数据源=小助手 deadlines.json） ----
    // v1.7：items=未完成未过期（旧 APP 只读这个，升级前就能享受过期消失）；overdue=过期未完成
    //（单独下发不混进 items，APP 端默认折叠展示）；recentDone=最近勾掉的几条（供误勾撤销）。
    if (req.method === 'GET' && p === '/api/deadlines') {
      if (!fs.existsSync(DEADLINES_FILE)) {
        // 开源版首访：建一个空数据源（引擎 A/C 抽到的事项会自动写进来）
        writeJson(DEADLINES_FILE, { updatedAt: new Date().toISOString(), items: [] });
        log('[deadlines] 数据源不存在，已新建空文件：' + DEADLINES_FILE);
      }
      const d = readJson(DEADLINES_FILE, null);
      if (!d) return send(res, 404, { ok: false, error: '小助手倒计时数据不可用' });
      const today = localToday();
      const items = [], overdue = [], recentDone = [];
      for (const x of (d.items || [])) {
        if (x && x.done) {
          if (x.doneAt) recentDone.push({ id: x.id || '', title: String(x.title || '').slice(0, 120), due: String(x.due || ''), doneAt: x.doneAt });
          continue;
        }
        const it = {
          id: x.id || '', title: String(x.title || '').slice(0, 160), due: String(x.due || ''),
          urgent: !!x.urgent, note: String(x.note || '').slice(0, 400), link: String(x.link || '')
        };
        const due = it.due;
        if (due && due < today) overdue.push(it); else items.push(it);
      }
      const byDue = (a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999'));
      items.sort(byDue); overdue.sort(byDue);
      recentDone.sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
      return send(res, 200, { ok: true, updatedAt: d.updatedAt || '', today, items, overdue, recentDone: recentDone.slice(0, 5) });
    }

    // ---- 待办勾选（v1.7）：手机端「勾一下就消」。id 两类：dl:<小助手id> / cls:<会话>:<序号> ----
    // dl: 直接改 deadlines.json（改前备份，同小助手备份惯例），勾掉后小助手网页与 APP 一起消失；
    // cls: 只记在 电脑端\todo-done.json（不动 items.json，零删除；流水线 reanalyze 重写也不受影响），
    //      记录同时存标题，聚合时 id+标题都对上才隐藏——防 reanalyze 后序号漂移错隐藏别的事。
    if (req.method === 'POST' && p === '/api/deadline-done') {
      const body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8'));
      const id = String((body && body.id) || '');
      const done = !!(body && body.done);
      const title = String((body && body.title) || '').slice(0, 160);
      if (id.startsWith('dl:')) {
        const raw = id.slice(3);
        if (!/^[\w.-]{1,80}$/.test(raw)) return send(res, 400, { ok: false, error: 'id 不合法' });
        const d = readJson(DEADLINES_FILE, null);
        if (!d || !Array.isArray(d.items)) return send(res, 404, { ok: false, error: '小助手倒计时数据不可用' });
        const it = d.items.find(x => x && x.id === raw);
        if (!it) return send(res, 404, { ok: false, error: '没有这条待办（可能已被电脑端更新）' });
        backupDeadlines();
        it.done = done;
        it.doneAt = done ? new Date().toISOString() : '';
        it.doneVia = '课堂笔记APP';
        writeJson(DEADLINES_FILE, d);
        // 课堂流水线抽的事项双写在 deadlines.json（cls- 开头）和 items.json 两处，两边序号没有硬对应；
        // 勾掉 cls- 项时按标题把 items.json 侧的同名事项一起隐藏（课程页/作业汇总那边也跟着消），撤销时移回。
        if (raw.startsWith('cls-')) {
          const title = String(it.title || '').slice(0, 160);
          const m = readJson(TODO_DONE_FILE, {}) || {};
          const arr = Array.isArray(m.__titles__) ? m.__titles__ : [];
          const i = arr.indexOf(title);
          if (done && i < 0 && title) arr.push(title);
          if (!done && i >= 0) arr.splice(i, 1);
          m.__titles__ = arr;
          writeJson(TODO_DONE_FILE, m);
        }
        log(`[deadline-done] ${done ? '勾掉' : '撤销'} dl:${raw}（${String(it.title || '').slice(0, 40)}）`);
        return send(res, 200, { ok: true });
      }
      if (id.startsWith('cls:')) {
        if (!/^cls:[A-Za-z0-9_-]{6,64}:\d{1,3}$/.test(id)) return send(res, 400, { ok: false, error: 'id 不合法' });
        const m = readJson(TODO_DONE_FILE, {}) || {};
        m[id] = done ? { ts: Date.now(), title } : { ts: 0, title };
        writeJson(TODO_DONE_FILE, m);
        log(`[deadline-done] ${done ? '勾掉' : '撤销'} ${id}`);
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { ok: false, error: 'id 前缀不认识：' + id.slice(0, 20) });
    }

    // ---- AI 引擎配置（v2.0）：APP 设置页填/清免费 API Key ----
    // GET 查状态（engine/hasKey/model）；POST {apiKey} 存 key 并切 glm 引擎，{apiKey:""} 清 key
    // 回到无 AI 的 template 模式（清 key 时若原来是私有 zcode 部署则回 zcode，engineBackup 记着）。
    if (req.method === 'GET' && p === '/api/ai-key') {
      const cfg = readJson(MAIN_CFG_FILE, {}) || {};
      const ai = cfg.ai || {};
      return send(res, 200, {
        ok: true, engine: cfg.engine || 'template', hasKey: !!ai.apiKey,
        model: ai.model || 'glm-4-flash', vlModel: ai.vlModel || '',
      });
    }
    if (req.method === 'POST' && p === '/api/ai-key') {
      const body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8'));
      const key = String((body && body.apiKey) || '').trim().slice(0, 200);
      const cfg = readJson(MAIN_CFG_FILE, {}) || {};
      if (key) {
        if (cfg.engine && cfg.engine !== 'glm' && !cfg.engineBackup) cfg.engineBackup = cfg.engine;   // 记住切 AI 前的引擎
        cfg.engine = 'glm';
        cfg.ai = Object.assign({}, cfg.ai, { apiKey: key, baseUrl: String(body.baseUrl || ((cfg.ai && cfg.ai.baseUrl) || 'https://open.bigmodel.cn/api/paas/v4')).slice(0, 300), model: String(body.model || ((cfg.ai && cfg.ai.model) || 'glm-4-flash')).slice(0, 100) });
        log(`[ai-key] 已配置 AI（${cfg.ai.model}），引擎切到 glm`);
      } else {
        cfg.engine = cfg.engineBackup || 'template';
        if (cfg.ai) cfg.ai.apiKey = '';
        log(`[ai-key] 已清空 AI Key，引擎回到 ${cfg.engine}`);
      }
      writeJson(MAIN_CFG_FILE, cfg);
      return send(res, 200, { ok: true, engine: cfg.engine, hasKey: !!key });
    }

    // ---- 手动补跑分析（调试用）----
    if (req.method === 'POST' && p === '/api/reanalyze') {
      const id = safeId(q.get('id'));
      if (!id) return send(res, 400, { ok: false, error: 'id 不合法' });
      setStatus(id, { state: 'queued' });
      const okStart = startPipeline(id);
      return send(res, 200, { ok: true, started: okStart });
    }

    return send(res, 404, { ok: false, error: '没有这个接口：' + p });
  } catch (e) {
    log(`[500] ${req.method} ${p}: ${e.message}`);
    return send(res, 500, { ok: false, error: e.message });
  }
});

// 素材文件名白名单：一律平铺（files\photo_001.jpg 这种），不允许路径分隔符
function safeName(n) {
  if (!n) return '';
  n = String(n);
  if (n.includes('..') || n.includes('/') || n.includes('\\') || n.startsWith('.')) return '';
  return /^[A-Za-z0-9._-]{1,120}$/.test(n) ? n : '';
}

// 看门狗：流水线子进程 4 小时还不退（无头会话挂死等，2026-09-29 实发过一次，卡死整条队列 7 小时）
// 就强杀之——子进程退出会触发上面的 done()，队列自动继续；正常跑完的流水线远到不了 4 小时
setInterval(() => {
  if (!pipelineAlive || !curChild) return;
  if (curChild.exitCode !== null || curChild.signalCode !== null) return;
  if (Date.now() - curStartMs > 4 * 60 * 60 * 1000) {
    log(`[guard] 流水线超 4 小时未退出，强杀 (pid ${curChild.pid})`);
    try { spawn('taskkill', ['/pid', String(curChild.pid), '/T', '/F']); } catch { }
  }
}, 5 * 60 * 1000).unref();

// v2.0：监听地址可配——开源版/想局域网直连的填 "0.0.0.0"（手机同 WiFi 直连、UDP 发现可用）；
//       默认 127.0.0.1（私有版走隧道，不暴露局域网，行为与 v1.x 完全一致）
const LISTEN = CFG.listen || '127.0.0.1';
server.listen(PORT, LISTEN, () => {
  log(`课堂笔记 API 已上岗 http://${LISTEN}:${PORT}（token 鉴权）`);
  if (LISTEN === '0.0.0.0') startDiscovery();
  rescan();
});
process.on('uncaughtException', e => log('[uncaught] ' + (e.stack || e.message)));

// ---------- UDP 局域网自动发现（v2.0 开源版，参照 KDE Connect 的 UDP 广播配对） ----------
// 手机 APP 在同一 WiFi 广播 "classnotes-discover"，本机回应 token+ntfy频道+局域网地址，APP 一键完成配对。
// 信任模型：家庭/宿舍 WiFi 适用；回应不含其它信息，token 即长期凭证（公共 WiFi 下建议改走隧道+手动配置）。
function startDiscovery() {
  const port = (CFG.pair && CFG.pair.udpPort) || 8779;
  try {
    const sock = dgram.createSocket('udp4');
    sock.on('error', e => log('[discover] UDP 监听失败（不影响 API）：' + e.message));
    sock.on('message', (buf, rinfo) => {
      const msg = String(buf).trim();
      if (msg !== 'classnotes-discover') return;
      const lan = lanIp();
      if (!lan) return;
      const reply = JSON.stringify({
        app: 'classnotes', version: 2, name: os.hostname(),
        server: `http://${lan}:${PORT}`, token: TOKEN, topic: String(CFG.ntfyTopic || ''),
      });
      sock.send(reply, rinfo.port, rinfo.address);
      log(`[discover] 已回应 ${rinfo.address} 的配对发现`);
    });
    sock.bind(port, () => { try { sock.setBroadcast(true); } catch { } });
    log(`[discover] 局域网自动发现已开启（UDP ${port}）`);
  } catch (e) { log('[discover] 开启失败：' + e.message); }
}
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}
