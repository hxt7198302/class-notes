// 课堂笔记APP 电脑端 API 服务（Node 零依赖，端口 8776）。
// 职责：接收手机上传的课堂素材（录音+照片，分块续传）、登记课程会话、
//       触发「转写→AI分析」流水线、向手机提供笔记列表与笔记内容（含照片文件）。
// 鉴权：所有请求须带 header x-app-token（与 api-token.txt 一致）；GET /api/file
//       额外允许 ?token= 查询参数（WebView/图片场景用），其余一律 header。
// v2.0 开源版：/api/deadlines 数据源可配（config.deadlinesFile，默认本机 data\），
//       新增 UDP 局域网自动发现（同 WiFi 手机一键连电脑）和 /api/ai-key（免费 key 配置）。
import http from 'http';
import https from 'https';
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
const COURSE_TERMS = path.join(ROOT, '电脑端', 'course-terms.json'); // v2.8 课程术语表 {课名: "词1 词2"}
const TIMETABLE_FILE = path.join(ROOT, '电脑端', 'timetable.json');  // v2.8 课表（手机「今天/下一节」卡）
const TODO_DONE_FILE = path.join(ROOT, '电脑端', 'todo-done.json');   // v1.7 课程待办勾选记录 {cls:id : {ts,title}}
const MAIN_CFG_FILE = path.join(HERE, '..', 'config.json');           // 电脑端\config.json（引擎/转写/ntfy/私有部署配置）
const CFG = (() => { try { return JSON.parse(fs.readFileSync(MAIN_CFG_FILE, 'utf8')); } catch { return {}; } })();
// v1.7 小助手倒计时数据源：私有版在 config.deadlinesFile 指向小助手；开源版默认 电脑端\data\（自动建）
const DEADLINES_FILE = CFG.deadlinesFile || path.join(HERE, '..', 'data', 'deadlines.json');
const LOG = path.join(HERE, 'server-log.txt');
const TOKEN_FILE = path.join(HERE, 'api-token.txt');
const PORT = Number(process.env.CLASSNOTES_PORT) || 8776;   // 可用环境变量改端口（自测/多实例用）
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

// ---- 学习通 sidecar 按需拉起（v2.11）----
// 用户不该记着"先开后端"：手机第一次请求学习通时，若 127.0.0.1:8781 没响应就 spawn 一次。
// 单例 + 15 秒冷却，防手机连点/多请求把进程拉成一串。
const CX_PORT = Number(process.env.CHAOXING_PORT) || 8781;
const CX_SCRIPT = path.join(ROOT, '电脑端', 'chaoxing', 'chaoxing_service.py');
let cxStarting = null;
let cxLastTry = 0;
async function cxAlive() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 600);
  try {
    const r = await fetch(`http://127.0.0.1:${CX_PORT}/health`, { signal: ac.signal });
    return r.ok;
  } catch { return false; } finally { clearTimeout(t); }
}
async function ensureChaoxing() {
  if (await cxAlive()) return true;
  if (Date.now() - cxLastTry < 15000) return false;
  cxLastTry = Date.now();
  if (!cxStarting) {
    cxStarting = (async () => {
      try {
        const py = process.platform === 'win32' ? 'python' : 'python3';
        const ch = spawn(py, ['-X', 'utf8', CX_SCRIPT], { detached: true, stdio: 'ignore', windowsHide: true });
        ch.unref();
        log('[chaoxing] sidecar 未运行，已拉起');
      } catch (e) {
        log(`[chaoxing] 拉起 sidecar 失败：${e.message}`);
      }
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await cxAlive()) return true;
      }
      return false;
    })();
    setTimeout(() => { cxStarting = null; }, 12000);
  }
  return cxStarting;
}
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
/** v2.8 课程术语表：{课名: "词1 词2 ..."}；只保留字符串，单课上限 200 字（防 prompt 过长反而降质） */
function courseTerms() {
  const cfg = readJson(COURSE_TERMS, {});
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof k === 'string' && k.length && typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 200);
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

// 按文件串行化分块落盘（v2.2 修 2026-10-16 事故）：
// 旧代码在 await readRaw(req) 之前读文件大小，同一个 offset 并发到达时两个请求都能过校验，
// 各 append 一次 → m4a 出现 2×3MiB 重复块、moov 丢失、转写报 Invalid data，整段笔记缺失。
// 现在同一文件的「校验偏移 → 校验 md5 → 追加」放进一把文件锁里串行执行，第二个请求会拿到 409
// 并以服务端真实字节数续传；不同文件互不影响。
const fileLocks = new Map();
function withFileLock(key, fn) {
  const prev = fileLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);   // 前一个失败也要继续跑后一个
  const guard = run.catch(() => { });
  fileLocks.set(key, guard);
  guard.finally(() => { if (fileLocks.get(key) === guard) fileLocks.delete(key); });
  return run;
}

// 整文件 MD5（流式，不整文件读进内存）：/api/session/verify 用（2026-10-24 由测试版并入）
function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    const s = fs.createReadStream(file);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
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

// ---------- 触发分析流水线（v2.2：转写串行、AI 分析可并行） ----------
// GPU 一次只吃得下一个 large-v3：多个会话同时各拉一条流水线会把显存挤爆，转写互相拖慢
// 十几倍甚至进程硬崩。所以转写阶段仍然全局串行（pipeline.mjs 里的转写锁保证），
// 但转写完成后等 AI 分析的那十几~几十分钟不必再堵住后面的课——v2.2 起允许 maxParallel
// （默认 2）条流水线同时在跑，分析阶段并行，转写阶段自动排队。
// 队列在内存里；服务器重启丢队列后由 rescan() 把未完成会话重新补进来。
const MAX_PARALLEL = Math.max(1, Math.min(4, Number(CFG.maxParallel) || 2));
const running = new Set();          // 排队中 + 运行中的会话 id（防重复入队）
const queue = [];
const active = new Map();           // id -> { child, startMs }（看门狗用）
function startPipeline(id) {
  if (running.has(id) || queue.includes(id)) return false;   // 排队中的不重复入队
  running.add(id);
  queue.push(id);
  log(`[queue] 会话 ${id} 入队（第 ${queue.length} 位）`);
  pump();
  return true;
}
function pump() {
  while (active.size < MAX_PARALLEL && queue.length > 0) {
    const id = queue.shift();
    const child = spawn(process.execPath, [path.join(ROOT, '电脑端', 'pipeline.mjs'), id], {
      cwd: ROOT, detached: true, stdio: 'ignore',
    });
    active.set(id, { child, startMs: Date.now() });
    log(`[pipeline] 会话 ${id} 分析流水线已拉起（并行 ${active.size}/${MAX_PARALLEL}，pid ${child.pid}）`);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      active.delete(id);
      running.delete(id);
      log(`[pipeline] 会话 ${id} 流水线退出，队列剩 ${queue.length} 个`);
      // 同日同课补跑：这条流水线跑的期间若又有新素材并进来（mergeDirty），自动再跑一遍，
      // 段级 transcribe.done 缓存保证只转写新增段。
      // 2026-10-18 修：旧代码只把 id 塞回队列、不改状态，pipeline 进来看到 state=done 直接
      // [skip] —— 高数 10-16 第二节课和两张照片就是这样被吞掉的。入队前必须把状态拨回 queued。
      try {
        const am = readJson(path.join(sessDir(id), 'meta.json'), {});
        if (am.mergeDirty) {
          writeJson(path.join(sessDir(id), 'meta.json'), { ...am, mergeDirty: false });
          setStatus(id, { state: 'queued', note: '分析期间有同课新素材并入，自动补跑' });
          log(`[queue] 会话 ${id} 分析期间有同课新素材并入，自动补跑`);
          if (!running.has(id)) { running.add(id); queue.push(id); }   // 并发 complete 可能已经把它排上了，别重复排
        }
      } catch { }
      pump();
    };
    child.on('exit', done);
    child.on('error', done);
    child.unref();
  }
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
    // 正在等手机补传的会话（repairing=true）绝不能入队分析：它的坏文件已被挪进 files_备份、
    // 新文件还没传上来，此时分析只会把半截素材做成残缺笔记，还会把状态改成 done。
    // 2026-10-18 实测踩坑：服务重启后 rescan 把英语/线代两个半截修复的会话拉去分析。
    if (meta.repairing === true) continue;
    // 永久性失败（如 GLM 内容安全拦截 [1301]）不再自动重排：重试多少次都不会过，
    // 只会每次开机白占队列几分钟~几十分钟。要再试由用户/我们手动 POST /api/reanalyze。
    // 老状态文件没有 permanentFailure 字段：按历史报错文案补判一次（国家安全 38 次、近代史 10 次）。
    if (st.permanentFailure !== true && /1301|内容安全|unsafe or sensitive/i.test(String(st.error || ''))) {
      setStatus(d, { permanentFailure: true });
      log(`[rescan] ${d} 历史失败为内容安全拦截，标记为永久失败，不再自动重排`);
    }
    if (st.permanentFailure === true || /1301|内容安全|unsafe or sensitive/i.test(String(st.error || ''))) continue;
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
          // 2026-10-24 修复（合并稿时间戳虚增）：段缓存时间必须保持相对成员段起点，
          // 由 pipeline 按 segment.startOffsetMs 统一平移一次；这里再平移会叠加两遍。
          writeJson(path.join(dstDir, 'transcript.json'), rows.map(rw => ({ s: rw.s, e: rw.e, t: rw.t })));
          fs.writeFileSync(path.join(dstDir, 'transcribe.done'), new Date().toISOString());
        }
      }
    } catch (e) { log(`[merge] ${memberId} 第${j}段转写缓存搬家失败（按重新转写处理）：${e.message}`); }
  }
  for (const p of (m.photos || [])) {
    if (photos.some(x => x.srcId === memberId && x.name === p.name)) continue;
    // takenAt 是 13 位毫秒时间戳，| 0 会截成 int32（变负数）；用 Number 保留原值
    photos.push({ name: p.name, offsetMs: (p.offsetMs | 0) + shift, takenAt: Number(p.takenAt) || 0, srcId: memberId });
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

// ---------- 损坏素材体检（v2.3）：给 APP 一键自动修复用 ----------
// 判定「同一个 3MiB 块被重复追加」：文件大小是 3MiB 整数倍，且各块 md5 出现重复。
// 这是 v2.2 之前上传并发的后遗症，真实录音不可能出现整块重复。
const SCAN_CHUNK = 3 * 1024 * 1024;
async function dupBlockFile(file) {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size < SCAN_CHUNK * 2 || st.size % SCAN_CHUNK !== 0) return false;
    const fh = await fs.promises.open(file, 'r');
    try {
      const seen = new Set();
      const buf = Buffer.alloc(SCAN_CHUNK);
      let pos = 0;
      while (pos < st.size) {
        const { bytesRead } = await fh.read(buf, 0, SCAN_CHUNK, pos);
        if (!bytesRead) break;
        const h = crypto.createHash('md5').update(buf.subarray(0, bytesRead)).digest('hex');
        if (seen.has(h)) return true;
        seen.add(h);
        pos += bytesRead;
      }
      return false;
    } finally { await fh.close(); }
  } catch { return false; }
}

async function scanDamage() {
  const groups = new Map();
  let totalFiles = 0, totalBytes = 0;
  for (const d of fs.readdirSync(SUCAI)) {
    if (!safeId(d)) continue;
    const meta = readSessMeta(d);
    if (!meta) continue;
    // 正在重传（repairing=true）的也照常列出：上次传到一半 APP 被杀，下次启动要能续上；
    // prepareReupload 会把这些半截文件挪进备份再从头传。
    const fd = path.join(sessDir(d), 'files');
    let names = [];
    try { names = fs.readdirSync(fd).filter(n => /\.(m4a|aac|mp3|wav)$/i.test(n)); } catch { continue; }
    const bad = [];
    let bytes = 0;
    for (const n of names) {
      if (!(await dupBlockFile(path.join(fd, n)))) continue;
      bad.push(n);
      try { bytes += fs.statSync(path.join(fd, n)).size; } catch { }
    }
    // 半截修复兜底：上一次修复把坏文件挪进 files_备份 后手机断了（APP 被杀/断网），
    // 现在 files/ 里只剩好文件、坏文件既不在原位也不再重复——只按重复块扫会永远漏掉这一课。
    // 只要会话还挂着 repairing=true，就把它应有但现在缺失的录音也列出来，让 APP 重新补传。
    if (meta.repairing === true) {
      const have = new Set(names);
      const own = (meta.segments || []).filter(s => !s.srcId).map(s => s.name).filter(n => n && /\.(m4a|aac|mp3|wav)$/i.test(n));
      for (const n of own) {
        if (have.has(n)) continue;
        if (!bad.includes(n)) bad.push(n);
      }
    }
    if (!bad.length) continue;
    const anchor = safeId(meta.mergedInto) || d;
    const g = groups.get(anchor) || { anchor, course: meta.course || '', startedAt: meta.startedAt || 0, sessions: [] };
    g.sessions.push({ id: d, course: meta.course || '', startedAt: meta.startedAt || 0, files: bad, bytes });
    groups.set(anchor, g);
    totalFiles += bad.length;
    totalBytes += bytes;
  }
  const list = [...groups.values()];
  for (const g of list) {
    const am = readSessMeta(g.anchor) || {};
    g.course = am.course || g.course;
    g.startedAt = am.startedAt || g.startedAt;
    g.state = readJson(path.join(noteDir(g.anchor), 'status.json'), {}).state || '';
    g.sessions.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  }
  list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return { groups: list, totalFiles, totalBytes };
}

// ---------- 重传修复收尾（v2.2） ----------
// APP 正常会显式调 repair-done；万一 APP 中途被杀/断网，最后一次 complete 之后静默 10 分钟
// 就自动收尾，避免 repairing 标记把这一课永远卡在「重传中」。给 10 分钟是留够继续传下一段的时间
// （同一组可能有好几段，隧道慢时 3 分钟不够，提前收尾会把只传了一半的素材丢给流水线）。
const repairTimers = new Map();
function scheduleRepairFinish(anchor) {
  const old = repairTimers.get(anchor);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    repairTimers.delete(anchor);
    try { finishRepair(anchor, 'auto'); } catch (e) { log(`[repair] ${anchor} 自动收尾失败：${e.message}`); }
  }, 10 * 60 * 1000);
  t.unref();
  repairTimers.set(anchor, t);
}
function finishRepair(anchor, why = 'app') {
  const am = readSessMeta(anchor) || {};
  const ids = new Set([anchor, ...((am.members || []).map(x => safeId(x.id)).filter(Boolean))]);
  // 整组还有会话在传（例如先传完的成员把 3 分钟定时器点着了，锚点的大文件还没传完）：
  // 推迟收尾，别让流水线去分析半截素材。超过 60 分钟仍卡 uploading 视为放弃，照常收尾。
  const stillUploading = [...ids].some(x => {
    const s = readJson(path.join(noteDir(x), 'status.json'), {});
    if (s.state !== 'uploading') return false;
    const age = s.updatedAt ? Date.now() - Date.parse(s.updatedAt) : Infinity;
    return age < 60 * 60 * 1000;
  });
  if (stillUploading) {
    scheduleRepairFinish(anchor);
    log(`[repair] ${anchor} 还有会话在上传，收尾推迟 10 分钟（${why}）`);
    return { deferred: true };
  }
  for (const x of ids) {
    const m = readSessMeta(x);
    if (m && m.repairing) writeJson(path.join(sessDir(x), 'meta.json'), { ...m, repairing: false });
    if (x !== anchor) setStatus(x, { state: 'uploaded', note: `已并入 ${anchor}（素材重传修复）` });
  }
  const stA = readJson(path.join(noteDir(anchor), 'status.json'), {});
  if (['transcribing', 'analyzing'].includes(stA.state || '')) {
    const cur = readSessMeta(anchor) || {};
    writeJson(path.join(sessDir(anchor), 'meta.json'), { ...cur, mergeDirty: true });
    setStatus(anchor, { note: '素材已重传，当前分析跑完后自动补跑' });
    log(`[repair] ${anchor} 正在分析，重传结果已标记补跑（${why}）`);
    return { deferred: true };
  }
  setStatus(anchor, { state: 'queued', permanentFailure: false, error: '', note: '素材已重传，重新整理' });
  startPipeline(anchor);
  log(`[repair] ${anchor} 素材重传完成，重新入队（${why}）`);
  return { deferred: false };
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
    summary: st.summary || '',
    error: st.error || '',
    noteUpdated: st.updatedAt || '',
    research: fs.existsSync(path.join(noteDir(id), 'research')) ? fs.readdirSync(path.join(noteDir(id), 'research')).length : 0,
    files: files.length,
  };
}

// v2.9：判断请求是不是从本机来的（/api/pair-info 只在回环放行）
function isLoopback(req) {
  const a = String(req.socket && req.socket.remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
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
  // v2.9：只在从本机回环访问时才给配对信息。开了 0.0.0.0 之后局域网里任何人都能打这个口，
  // 而它会把 token 明文回出去——等于把鉴权作废。手机端早就配过对，靠 ntfy 拿地址即可，不需要它。
  if (p === '/api/pair-info' && LISTEN === '0.0.0.0' && isLoopback(req)) {
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
          name: safeName(x.name), offsetMs: x.offsetMs | 0, takenAt: Number(x.takenAt) || 0,
        })).filter(x => x.name),
        // 课堂标记（v1.1+）：上课时用户手动打的重点 {offsetMs, type, note}
        markers: (body.markers || []).map(x => ({
          offsetMs: x.offsetMs | 0,
          type: String(x.type || '🔖重点').slice(0, 20),
          note: String(x.note || '').slice(0, 200),
        })).filter(x => x.offsetMs >= 0),
        // 重传修复标记（v2.2）：素材重传期间别急着拉起分析，等手机把整组传完、调 repair-done 再统一跑
        repairing: prev ? prev.repairing === true : false,
        mergeDirty: prev ? prev.mergeDirty === true : false,
      });
      // 已并入同日同课的碎片被 APP 重复上传：保留归并关系，不重新触发整理
      if (prev && prev.mergedInto && safeId(prev.mergedInto)) {
        writeJson(path.join(dir, 'meta.json'), { ...readJson(path.join(dir, 'meta.json'), {}), mergedInto: prev.mergedInto });
        // 重传修复中的成员：上传还没完，保持 uploading，别让 finishRepair 的「还在传」判断被提前骗过
        if (prev.repairing !== true) {
          setStatus(id, { state: 'uploaded', mergedInto: prev.mergedInto, note: `已并入同日同课 ${prev.mergedInto}（重复上传不重复整理）` });
        }
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

    // ---- v2.10：手机端把失败原因送回来（只记日志，绝不落成文件）----
    if (req.method === 'POST' && p === '/api/client-log') {
      try {
        const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
        const kind = String(body.kind || 'log').slice(0, 40);
        const route = String(body.route || '').slice(0, 20);
        const text = String(body.text || '').replace(/\s+/g, ' ').slice(0, 2000);
        log(`[client] ${kind}${route ? ' · ' + route : ''}：${text}`);
      } catch (e) { log(`[client] 日志解析失败：${e.message}`); }
      return send(res, 200, { ok: true });
    }

    // ---- 上传：单个文件分块追加 ----
    if (req.method === 'POST' && p === '/api/chunk') {
      const id = safeId(q.get('id'));
      const name = safeName(q.get('name'));
      if (!id || !name) return send(res, 400, { ok: false, error: 'id/name 不合法' });
      const expected = parseInt(q.get('offset') || '0', 10);
      const file = path.join(sessDir(id), 'files', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const buf = await readRaw(req);
      // 收完包再进锁：锁里重新读一次真实大小（关键！不能沿用 await 之前的快照）
      const result = await withFileLock(file, async () => {
        const cur = fs.existsSync(file) ? fs.statSync(file).size : 0;
        if (expected !== cur) return { code: 409, obj: { ok: false, received: cur, error: `偏移不对（客户端 ${expected} / 服务端 ${cur}）` } };
        // 可选分块校验：客户端带 &md5=（hex）即核对，传输损坏当场打回重传；
        // 不带此参数（如 v1.0 APP）则跳过校验，完全兼容
        const want = String(q.get('md5') || '').toLowerCase();
        if (want && crypto.createHash('md5').update(buf).digest('hex') !== want) {
          log(`[chunk] ${id}/${name} offset=${expected} md5 校验失败，拒收`);
          return { code: 422, obj: { ok: false, received: cur, error: '分块 md5 校验失败，请重传该块' } };
        }
        fs.appendFileSync(file, buf);
        return { code: 200, obj: { ok: true, received: cur + buf.length } };
      });
      return send(res, result.code, result.obj);
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
        // 重传修复的成员传完了：3 分钟没等到 repair-done（APP 被杀/断网）就自动收尾重跑，
        // 避免 repairing 标记把这一课永远卡在「重传中」。
        if (me.repairing === true) {
          // 成员自己的上传状态也要落下，否则 finishRepair 会把它当成「还在传」而一直推迟
          setStatus(sid, { state: 'uploaded', note: `已并入 ${me.mergedInto}（素材重传修复）` });
          scheduleRepairFinish(me.mergedInto);
        }
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
      if (me.repairing === true) {
        // 重传修复中（v2.2）：整组素材可能分好几次 complete，等都传完由 APP 调 /api/session/repair-done
        // 统一入队，避免锚点先跑一遍、成员再并进来又补跑一遍，白烧两次 AI 分析。
        st = setStatus(anchorId, { state: 'uploaded', note: '素材重传中，传完统一重新整理' });
        scheduleRepairFinish(anchorId);   // 兜底：APP 没来得及调 repair-done 也自动收尾
        log(`[repair] ${sid} 重传收尾（锚点 ${anchorId}），等 repair-done 再统一重跑`);
      } else if (anchorId === sid) {
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
      // v2.8 导出/分享：把 Markdown 原文一并下发（APP 本地缓存后离线也能导出）
      let md = '';
      try { md = fs.readFileSync(mdF, 'utf8'); } catch { }
      const photos = sum.photoCount ? readJson(path.join(sessDir(id), 'meta.json'), {}).photos : [];
      const items = readJson(path.join(nd, 'items.json'), null);
      const research = (() => { try { return fs.readdirSync(path.join(nd, 'research')); } catch { return []; } })();
      return send(res, 200, { ok: true, ...sum, html, md, photos, items, research });
    }

    // ---- 原始素材（v2.6）：分段录音清单 + 照片清单 + 逐句转写 ----
    // 只读接口，供 APP 的「原始素材页」：录音/照片本地优先，原文按需拉这里。
    // 转写不等整课结束：已完成段 + 正在转的半成品段（transcript.json 每 5 秒刷盘）都返回。
    if (req.method === 'GET' && p === '/api/source') {
      const id = safeId(q.get('id'));
      if (!id) return send(res, 400, { ok: false, error: 'id 不合法' });
      const meta = readSessMeta(id);
      if (!meta) return send(res, 404, { ok: false, error: '没有这个会话' });
      const st = readJson(path.join(noteDir(id), 'status.json'), {});
      const segs = (Array.isArray(meta.segments) && meta.segments.length)
        ? meta.segments : [{ name: 'recording.m4a', startOffsetMs: 0 }];
      const anchorStart = meta.startedAt || 0;
      const metaCache = new Map();
      const memberMeta = (mid) => {
        if (!metaCache.has(mid)) metaCache.set(mid, readSessMeta(mid));
        return metaCache.get(mid);
      };
      const outSegs = [];
      const cues = [];
      let doneCnt = 0;
      let progSum = 0;
      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i] || {};
        const name = String(sg.name || '');
        const startMs = Math.max(0, sg.startOffsetMs | 0);
        const srcId = safeId(sg.srcId || '');
        const idx = String(i).padStart(2, '0');
        let rows = null;
        let done = false;
        const anchorSegDir = path.join(sessDir(id), 'seg_' + idx);
        let usedDir = anchorSegDir;
        // 同日合并进来的段：优先读成员自己的 seg_XX（行是"段内相对时间"，最可靠）。
        // 锚点 seg_XX 里可能是旧版搬运过来的副本（只平移了成员起点、没有加段内起点），时间会整体偏晚。
        if (srcId) {
          const mm = memberMeta(srcId);
          const mi = (mm && Array.isArray(mm.segments))
            ? mm.segments.findIndex(x => x && x.name === name) : -1;
          if (mi >= 0) {
            const d = path.join(sessDir(srcId), 'seg_' + String(mi).padStart(2, '0'));
            const r = readJson(path.join(d, 'transcript.json'), null);
            if (Array.isArray(r) && r.length) { rows = r; usedDir = d; }
            if (fs.existsSync(path.join(d, 'transcribe.done'))) done = true;
          }
        }
        // 锚点原生转写（成员段若没转写过，也会由流水线在锚点目录里转）
        if (!rows) {
          const r = readJson(path.join(anchorSegDir, 'transcript.json'), null);
          if (Array.isArray(r) && r.length) { rows = r; usedDir = anchorSegDir; }
          if (fs.existsSync(path.join(anchorSegDir, 'transcribe.done'))) done = true;
        } else if (!done) {
          done = fs.existsSync(path.join(usedDir, 'transcribe.done'));
        }
        if (done) doneCnt++;
        const base = startMs / 1000;
        if (rows) {
          for (const rw of rows) {
            const s = Number(rw.s), e = Number(rw.e);
            if (!isFinite(s) || !isFinite(e)) continue;
            cues.push({ s: +(s + base).toFixed(2), e: +(e + base).toFixed(2), t: String(rw.t || '') });
          }
        }
        const segSt = readJson(path.join(usedDir, 'status.json'), {});
        const segProg = done ? 100
          : (typeof segSt.progress === 'number' ? Math.max(0, Math.min(99, segSt.progress)) : (rows ? 50 : 0));
        progSum += segProg;
        outSegs.push({
          name,
          startOffsetMs: startMs,
          srcId: srcId || undefined,
          done,
          partial: !!rows && !done,
          progress: segProg,
          exists: fs.existsSync(path.join(sessDir(id), 'files', name)) ||
            !!(srcId && fs.existsSync(path.join(sessDir(srcId), 'files', name))),
        });
      }
      cues.sort((a, b) => a.s - b.s || a.e - b.e);
      // 总时长：锚点与所有成员的结束时刻取最大（meta.durationMs 只代表锚点自己那一段）
      let endMs = anchorStart + (meta.durationMs || 0);
      for (const m of (meta.members || [])) endMs = Math.max(endMs, (m.startedAt || 0) + (m.durationMs || 0));
      const lastSegStart = segs.reduce((mx, x) => Math.max(mx, (x.startOffsetMs | 0)), 0);
      endMs = Math.max(endMs, anchorStart + lastSegStart + 600000);
      const totalSegs = segs.length;
      return send(res, 200, {
        ok: true,
        id,
        course: meta.course || '',
        startedAt: anchorStart,
        endedAt: endMs,
        durationMs: Math.max(0, endMs - anchorStart),
        state: st.state || meta.state || '',
        progress: (typeof st.progress === 'number') ? st.progress : null,
        transcriptDone: doneCnt,
        transcriptTotal: totalSegs,
        transcriptProgress: totalSegs ? Math.round(progSum / totalSegs) : 0,
        transcriptComplete: doneCnt === totalSegs,
        segments: outSegs,
        photos: (meta.photos || []).map(x => ({
          name: x.name, offsetMs: x.offsetMs | 0, takenAt: Number(x.takenAt) || 0, srcId: x.srcId || undefined,
        })),
        transcript: cues,
        // startedAt 是 13 位毫秒时间戳，| 0 会截成 int32（变负数）
        members: (meta.members || []).map(x => ({
          id: x.id, startedAt: Number(x.startedAt) || 0, durationMs: Number(x.durationMs) || 0,
        })),
      });
    }

    // ---- 文件：录音/照片（素材目录，白名单路径；同日合并会话兜底到成员目录）----
    if (req.method === 'GET' && p === '/api/file') {
      const id = safeId(q.get('id'));
      const name = safeName(q.get('name'));
      const srcQ = safeId(q.get('src') || '');   // v2.6：同日合并的成员段，同名 recording_00.m4a 有好几份，必须指明 srcId
      if (!id || !name) return send(res, 400, { ok: false, error: 'id/name 不合法' });
      let file = srcQ ? path.join(sessDir(srcQ), 'files', name) : path.join(sessDir(id), 'files', name);
      if (!fs.existsSync(file)) {
        const meta = readSessMeta(id);
        const ent = meta ? [...(meta.photos || []), ...(meta.segments || [])].find(x => x.name === name && x.srcId && safeId(x.srcId)) : null;
        if (ent) file = path.join(sessDir(ent.srcId), 'files', name);
      }
      if (!fs.existsSync(file)) return send(res, 404, { ok: false, error: '文件不存在' });
      const ext = path.extname(file).toLowerCase();
      const type = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.m4a': 'audio/mp4', '.aac': 'audio/aac' }[ext] || 'application/octet-stream';
      // v2.6：补 HTTP Range（206）。手机本地缺段时要流式听电脑上的录音，
      // 没有 Range 时 MediaPlayer 拖动/TLS 隧道下续播会失败。对图片请求向后兼容。
      const size = fs.statSync(file).size;
      const headers = {
        'Content-Type': type,
        'Cache-Control': 'private, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
      };
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (m) {
          let start = m[1] === '' ? -1 : parseInt(m[1], 10);
          let end = m[2] === '' ? -1 : parseInt(m[2], 10);
          if (start < 0 && end >= 0) { start = Math.max(0, size - end); end = size - 1; } // bytes=-500
          else {
            if (start < 0) start = 0;
            if (end < 0 || end >= size) end = size - 1;
          }
          if (!isFinite(start) || !isFinite(end) || start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Access-Control-Allow-Origin': '*' });
            return res.end();
          }
          headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
          headers['Content-Length'] = end - start + 1;
          res.writeHead(206, headers);
          fs.createReadStream(file, { start, end }).pipe(res);
          return;
        }
      }
      headers['Content-Length'] = size;
      res.writeHead(200, headers);
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

    // ---- 课表（v2.8）：给手机「今天/下一节」卡；数据来自 电脑端\timetable.json ----
    if (req.method === 'GET' && p === '/api/timetable') {
      const t = readJson(TIMETABLE_FILE, null);
      if (!t || !Array.isArray(t.courses)) return send(res, 404, { ok: false, error: '还没有课表文件（电脑端\\timetable.json）' });
      return send(res, 200, { ok: true, ...t, serverTs: Date.now() });
    }

    // ---- 连接体检（v2.8）：只报实测，不做「配置存在就打绿灯」 ----
    if (req.method === 'GET' && p === '/api/health') {
      let diskFree = null, diskTotal = null;
      try {
        const st = fs.statfsSync(ROOT);
        diskFree = st.bavail * st.bsize;
        diskTotal = st.blocks * st.bsize;
      } catch { }
      let noteDirs = 0;
      try { noteDirs = fs.readdirSync(BIJI).length; } catch { }
      return send(res, 200, {
        ok: true, name: 'class-notes-api', ts: Date.now(),
        model: CFG.whisperModel || 'large-v3', lang: CFG.lang || 'zh',
        diskFree, diskTotal, noteDirs,
        timetable: fs.existsSync(TIMETABLE_FILE),
      });
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
      // v2.8 课程术语表一并下发
      return send(res, 200, { ok: true, list, examples: courseExamples(), terms: courseTerms() });
    }

    // ---- 课程偏好（v1.6 例题汇总开关 / v2.8 课程术语）：APP 推 {courses:{课名:bool}, terms:{课名:str}}，按课合并 ----
    if (req.method === 'POST' && p === '/api/course-config') {
      const body = JSON.parse((await readRaw(req, 256 * 1024)).toString('utf8'));
      const courses = (body && typeof body.courses === 'object' && !Array.isArray(body.courses)) ? body.courses : null;
      const terms = (body && typeof body.terms === 'object' && !Array.isArray(body.terms)) ? body.terms : null;
      if (!courses && !terms) return send(res, 400, { ok: false, error: '缺 courses 或 terms 对象' });
      let n = 0;
      if (courses) {
        const next = JSON.parse(JSON.stringify(courseExamples()));   // 读-改-写合并，没提到的课不动
        for (const [name, on] of Object.entries(courses)) {
          const c = String(name).slice(0, 40).trim();
          if (!c || c.includes('..') || /[\\/:*?"<>|]/.test(c)) continue;
          next[c] = !!on;
          n++;
        }
        writeJson(COURSE_CFG, next);
      }
      let tn = 0;
      if (terms) {
        const tnext = JSON.parse(JSON.stringify(courseTerms()));
        for (const [name, val] of Object.entries(terms)) {
          const c = String(name).slice(0, 40).trim();
          if (!c || c.includes('..') || /[\\/:*?"<>|]/.test(c)) continue;
          const s = String(val == null ? '' : val).replace(/\s+/g, ' ').trim().slice(0, 200);
          if (s) tnext[c] = s; else delete tnext[c];
          tn++;
        }
        writeJson(COURSE_TERMS, tnext);
      }
      const onCount = Object.values(courseExamples()).filter(Boolean).length;
      log(`[course-config] 收 ${n} 门例题设置、${tn} 门术语，合并后例题汇总开着 ${onCount} 门`);
      return send(res, 200, { ok: true, courses: courseExamples(), terms: courseTerms() });
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

    // ---- 手机黑匣子（v1.8）：APP 的崩溃日志（crash-*.txt）与录音服务日志（rec-log*.txt）存档到 素材\_diag\ ----
    // 手机端 syncAll 按水位线只传新增；这里原样落盘。2026-10-08 大模型课录音 7分22秒无痕死亡查无实据，
    // 起此端点：下次再死，crash 堆栈 + rec-log 面包屑两相对照就是死因铁证。
    if (req.method === 'POST' && p === '/api/diag') {
      const body = JSON.parse((await readRaw(req, 1024 * 1024)).toString('utf8'));
      const logs = Array.isArray(body && body.logs) ? body.logs : [];
      if (!logs.length) return send(res, 400, { ok: false, error: '缺 logs' });
      const dir = path.join(SUCAI, '_diag');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      let n = 0;
      for (const item of logs) {
        const name = String((item && item.name) || '');
        const text = String((item && item.text) || '');
        if (!name || !/^[\w.-]{1,120}$/.test(name) || !text) continue;
        fs.writeFileSync(path.join(dir, `${stamp}-${name}`), text.slice(0, 400 * 1024), 'utf8');
        n++;
      }
      log(`[diag] 收手机诊断日志 ${n} 份，存 ${dir}`);
      return send(res, 200, { ok: true, saved: n });
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
      // 手动补跑是人明确要求再试一次：清掉 permanentFailure（否则 rescan 仍会跳过）和旧报错
      setStatus(id, { state: 'queued', permanentFailure: false, error: '', note: '手动重新整理' });
      const okStart = startPipeline(id);
      return send(res, 200, { ok: true, started: okStart });
    }

    // ---- 素材重传修复（v2.2）：电脑上的录音可能被旧版并发上传写坏了（2×3MiB 重复块） ----
    // APP 长按课堂记录 →「重新上传这天的素材」先调这里：把现有文件挪进 files_备份\（不删），
    // 手机随后从 0 字节重传原始录音；全部传完再调 /api/session/repair-done 统一重跑分析。
    // v2.3：损坏素材体检（APP 启动后自动调，扫描整库找「重复追加」的录音）
    if (req.method === 'GET' && p === '/api/repair/scan') {
      try {
        const r = await scanDamage();
        log(`[repair-scan] 发现 ${r.groups.length} 组 / ${r.totalFiles} 个损坏录音（${Math.round(r.totalBytes / 1048576)} MB）`);
        return send(res, 200, { ok: true, ...r });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message });
      }
    }

    if (req.method === 'POST' && p === '/api/session/reupload') {
      const id = safeId(q.get('id'));
      if (!id) return send(res, 400, { ok: false, error: 'id 不合法' });
      const meta = readSessMeta(id);
      if (!meta) return send(res, 404, { ok: false, error: '没有这个会话' });
      const anchor0 = safeId(meta.mergedInto) || id;
      const st0 = readJson(path.join(noteDir(id), 'status.json'), {});
      if (running.has(id) || queue.includes(id) || running.has(anchor0) || queue.includes(anchor0) ||
        ['transcribing', 'analyzing'].includes(st0.state || '')) {
        return send(res, 409, { ok: false, error: '这一课正在转写/分析或排队中，等它跑完再重传' });
      }
      const files = path.join(sessDir(id), 'files');
      const bak = path.join(sessDir(id), 'files_备份');
      const d = new Date();
      const p2 = n => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
      // files=只挪指定的损坏文件（自动体检修复用）；不传=整会话全部重传（长按菜单用）
      const only = String(q.get('files') || '').split(',').map(x => safeName(x.trim())).filter(Boolean);
      let moved = 0;
      if (fs.existsSync(files)) {
        fs.mkdirSync(bak, { recursive: true });
        for (const name of fs.readdirSync(files)) {
          if (only.length && !only.includes(name)) continue;
          const src = path.join(files, name);
          let s; try { s = fs.statSync(src); } catch { continue; }
          if (!s.isFile()) continue;
          const ext = path.extname(name);
          const base = name.slice(0, name.length - ext.length);
          let dst = path.join(bak, `${base}.备份${stamp}${ext}`);
          let k = 1;
          while (fs.existsSync(dst)) { dst = path.join(bak, `${base}.备份${stamp}-${k}${ext}`); k++; }
          try { fs.renameSync(src, dst); moved++; }
          catch (e) {
            log(`[reupload] ${id}/${name} 挪进备份失败：${e.message}`);
            return send(res, 500, { ok: false, error: `文件被占用，稍后再试（${name}）` });
          }
        }
      }
      // 2026-10-24（由测试版并入）：把段级转写缓存挪进 seg_备份<时间戳>（不删），
      // 否则重传后流水线看到 transcribe.done 会直接复用旧转写，笔记看起来“没变”。
      let segMoved = 0;
      try {
        const segBak = path.join(sessDir(id), 'seg_备份' + stamp);
        for (const d of fs.readdirSync(sessDir(id))) {
          if (!/^seg_\d+$/.test(d)) continue;
          fs.mkdirSync(segBak, { recursive: true });
          fs.renameSync(path.join(sessDir(id), d), path.join(segBak, d));
          segMoved++;
        }
      } catch (e) { log(`[reupload] ${id} 段缓存挪备份失败（不影响上传）：${e.message}`); }
      writeJson(path.join(sessDir(id), 'meta.json'), { ...meta, repairing: true });
      setStatus(id, { state: 'uploading', note: '重新上传素材中' });
      log(`[reupload] ${id} 旧文件 ${moved} 个已挪进 files_备份，段缓存 ${segMoved} 个已挪进 seg_备份，等待手机重传（锚点 ${anchor0}）`);
      return send(res, 200, { ok: true, moved, segMoved, anchor: anchor0 });
    }

    // ---- 整文件 MD5 + 字节核对（2026-10-24 由测试版并入生产）----
    // 入参 {id, files:[{name,size,md5}]}；逐文件在服务端流式计算真实 size/md5 后比对。
    // 只允许 meta 里登记过的素材文件名，防止任意读文件。
    if (req.method === 'POST' && p === '/api/session/verify') {
      const body = JSON.parse((await readRaw(req, 1024 * 1024)).toString('utf8') || '{}');
      const id = safeId(body.id);
      if (!id) return send(res, 400, { ok: false, error: '会话 id 不合法' });
      const meta = readSessMeta(id);
      if (!meta) return send(res, 404, { ok: false, error: '没有这个会话' });
      // 只核对“这一节自己的”文件：合并会话的 meta 里还挂着成员的段（srcId=成员 id），
      // 那些文件在成员自己的目录里，不能算进本会话的 missing。
      const own = x => !x || !x.srcId || x.srcId === id;
      const listed = new Set([...(meta.segments || []), ...(meta.photos || [])].filter(own).map(x => x && x.name).filter(Boolean));
      const out = [];
      let allMatch = true;
      for (const f of (Array.isArray(body.files) ? body.files : [])) {
        const name = safeName(f && f.name);
        if (!name || !listed.has(name)) {
          allMatch = false;
          out.push({ name: String((f && f.name) || ''), error: '文件名不合法或未登记' });
          continue;
        }
        const file = path.join(sessDir(id), 'files', name);
        let exists = false, serverSize = 0, serverMd5 = '';
        try {
          if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            exists = true;
            serverSize = fs.statSync(file).size;
            serverMd5 = await md5File(file);
          }
        } catch (e) { log(`[verify] ${id}/${name} 读取失败：${e.message}`); }
        const clientSize = Number(f && f.size) || 0;
        const clientMd5 = String((f && f.md5) || '').toLowerCase();
        const sizeMatch = exists && serverSize === clientSize;
        const md5Match = exists && serverMd5 !== '' && serverMd5 === clientMd5;
        if (!sizeMatch || !md5Match) allMatch = false;
        out.push({ name, clientSize, serverSize, exists, sizeMatch, clientMd5, serverMd5, md5Match });
      }
      const expected = [...listed];
      const have = (() => { try { return fs.readdirSync(path.join(sessDir(id), 'files')); } catch { return []; } })();
      const missing = expected.filter(n => !have.includes(n));
      const extra = have.filter(n => !expected.includes(n));
      log(`[verify] ${id} 核对 ${out.length} 个文件，allMatch=${allMatch && missing.length === 0}`);
      return send(res, 200, { ok: true, id, files: out, missing, extra, allMatch: allMatch && missing.length === 0 });
    }

    // ---- 重传完成（v2.2）：APP 把这一组的会话都传完后调这里，统一触发一次重新整理 ----
    if (req.method === 'POST' && p === '/api/session/repair-done') {
      const id = safeId(q.get('id'));
      if (!id) return send(res, 400, { ok: false, error: 'id 不合法' });
      const meta = readSessMeta(id);
      if (!meta) return send(res, 404, { ok: false, error: '没有这个会话' });
      const anchor = safeId(meta.mergedInto) || id;
      const t = repairTimers.get(anchor);
      if (t) { clearTimeout(t); repairTimers.delete(anchor); }
      const r = finishRepair(anchor, 'app');
      return send(res, 200, { ok: true, anchor, deferred: !!r.deferred });
    }

    // ---- 学习通只读查询（v2.11）----
    // 转发到本机 127.0.0.1:8781 的 Python sidecar（只监听回环，手机连不到它）。
    // 所有路由先过上面的 x-app-token 鉴权；sidecar 不额外暴露端口。
    if (p.startsWith('/api/chaoxing/')) {
      const SIDE = `http://127.0.0.1:${Number(process.env.CHAOXING_PORT) || 8781}`;
      const route = {
        '/api/chaoxing/status': ['/status', 'GET', 20000],
        '/api/chaoxing/login/status': ['/login/status', 'GET', 10000],
        '/api/chaoxing/login/start': ['/login/start?open=1', 'POST', 40000],
        '/api/chaoxing/summary': ['/summary', 'GET', 15000],
        '/api/chaoxing/logout': ['/logout', 'POST', 15000],
        '/api/chaoxing/verify/open': ['/verify/open', 'POST', 10000],
      }[p];
      if (!route) return send(res, 404, { ok: false, error: '没有这个接口：' + p });
      await ensureChaoxing();
      let url = SIDE + route[0];
      if (p === '/api/chaoxing/summary' && q.get('force') === '1') url += '?force=1';
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), route[2]);
      try {
        const r = await fetch(url, { method: route[1], signal: ac.signal });
        const text = await r.text();
        let obj;
        try { obj = JSON.parse(text); } catch { obj = { ok: false, state: 'error', error: '学习通服务返回了非 JSON' }; }
        return send(res, r.ok ? 200 : r.status, obj);
      } catch (e) {
        log(`[chaoxing] ${p} 转发失败：${e.message}`);
        const msg = ac.signal.aborted ? '学习通服务响应太慢（超时）' : '电脑端学习通服务没启动（chaoxing_service.py）';
        return send(res, 502, { ok: false, state: 'unavailable', error: msg });
      } finally {
        clearTimeout(timer);
      }
    }

    return send(res, 404, { ok: false, error: '没有这个接口：' + p });
  } catch (e) {
    // v2.10：带上来源地址和声明长度——局域网直连会显示 192.168.x.x，隧道是 127.0.0.1，
    // 下次「重传中断」能直接看出走的是哪条线、断在多大的块上
    const from = (req.socket && req.socket.remoteAddress) || '-';
    const len = req.headers && req.headers['content-length'] || '-';
    log(`[500] ${req.method} ${p}: ${e.message}（from=${from} len=${len}）`);
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
  for (const [id, a] of active) {
    if (!a.child || a.child.exitCode !== null || a.child.signalCode !== null) continue;
    if (Date.now() - a.startMs > 4 * 60 * 60 * 1000) {
      log(`[guard] 会话 ${id} 流水线超 4 小时未退出，强杀 (pid ${a.child.pid})`);
      try { spawn('taskkill', ['/pid', String(a.child.pid), '/T', '/F']); } catch { }
    }
  }
}, 5 * 60 * 1000).unref();

// v2.0：监听地址可配——开源版/想局域网直连的填 "0.0.0.0"（手机同 WiFi 直连、UDP 发现可用）；
//       默认 127.0.0.1（私有版走隧道，不暴露局域网，行为与 v1.x 完全一致）
const LISTEN = CFG.listen || '127.0.0.1';
server.listen(PORT, LISTEN, () => {
  log(`课堂笔记 API 已上岗 http://${LISTEN}:${PORT}（token 鉴权）`);
  if (LISTEN === '0.0.0.0') {
    startDiscovery();
    publishLan();
    setInterval(publishLan, 10 * 60 * 1000).unref();
  }
  rescan();
});

// v2.9 局域网地址广播：把 http://<本机局域网IP>:8776 用标题 classnotes-lan 发到 ntfy 同主题。
// APP 收到后先花 1.5 秒探一下——通就走局域网直连（同 WiFi 时比隧道快几十倍），
// 不通就继续用隧道的 https 网址。DHCP 换了 IP 也会在 10 分钟内自动纠正。
function publishLan() {
  const topic = CFG.ntfyTopic;
  if (!topic) return;
  const lan = lanIp();
  if (!lan) return;
  const body = `http://${lan}:${PORT}`;
  try {
    const req = https.request(
      { hostname: 'ntfy.sh', path: `/${encodeURIComponent(topic)}`, method: 'POST',
        headers: { 'X-Title': 'classnotes-lan', 'X-Tags': 'house', 'Content-Length': Buffer.byteLength(body) } },
      res => { res.resume(); log(`[lan] 局域网地址已广播 ${body}（HTTP ${res.statusCode}）`); }
    );
    req.on('error', e => log(`[lan] 广播失败：${e.message}`));
    req.setTimeout(10000, () => { try { req.destroy(); } catch { } });
    req.end(body);
  } catch (e) { log(`[lan] 广播异常：${e.message}`); }
}
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
// v2.9：优先挑真·局域网的网卡。本机装着 VMware（VMnet1/8 都是 192.168.x.1 的虚拟网卡），
// 按原来的「第一个非内网 IPv4」会挑到虚拟网卡，手机永远连不上；这里按网卡名排掉虚拟网卡。
function lanIp() {
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      all.push({ name: String(name), addr: ni.address });
    }
  }
  const virtual = /vmware|virtualbox|vethernet|hyper-v|loopback|docker|tap|bluetooth/i;
  const real = all.filter(x => !virtual.test(x.name));
  const pick =
    real.find(x => /^192\.168\./.test(x.addr)) ||
    real.find(x => /^10\./.test(x.addr)) ||
    real.find(x => /^172\.(1[6-9]|2\d|3[01])\./.test(x.addr)) ||
    real[0] || all[0];
  return pick ? pick.addr : null;
}
