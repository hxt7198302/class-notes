'use strict';
// 课堂助手 · 本地服务（Node 零依赖）
// 课表 + 上课录音 + 板书照片 + 课堂笔记。端口默认 3003。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// 数据目录默认 webapp/data；测试/多实例可用 DATA_DIR 指向临时目录
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const SESS_DIR = path.join(DATA_DIR, 'sessions');
const CLASSES_FILE = path.join(DATA_DIR, 'classes.json');
const PORT = Number(process.env.PORT || 3003);

for (const d of [DATA_DIR, SESS_DIR]) fs.mkdirSync(d, { recursive: true });

const LIB_DIR = path.join(ROOT, 'lib');
let _ocr = null, _prompts = null, _parse = null;
function libOcr() { if (!_ocr) _ocr = require(path.join(LIB_DIR, 'ocr.js')); return _ocr; }
function libPrompts() { if (!_prompts) _prompts = require(path.join(LIB_DIR, 'prompts.js')); return _prompts; }
function libParse() { if (!_parse) _parse = require(path.join(LIB_DIR, 'parse.js')); return _parse; }
let _aiNote = null;
function libAiNote() { if (!_aiNote) _aiNote = require(path.join(LIB_DIR, 'ai_note.js')); return _aiNote; }
let _aiProvider = null;
function libAiProvider() { if (!_aiProvider) _aiProvider = require(path.join(LIB_DIR, 'ai_provider.js')); return _aiProvider; }
let _assist = null;
function libAssist() { if (!_assist) _assist = require(path.join(LIB_DIR, 'assist.js')); return _assist; }
let _eams = null;
function libEams() { if (!_eams) _eams = require(path.join(LIB_DIR, 'eams.js')); return _eams; }
let _zhengfang = null;
function libZhengfang() { if (!_zhengfang) _zhengfang = require(path.join(LIB_DIR, 'zhengfang.js')); return _zhengfang; }
let _qiangzhi = null;
function libQiangzhi() { if (!_qiangzhi) _qiangzhi = require(path.join(LIB_DIR, 'qiangzhi.js')); return _qiangzhi; }
let _eamsParse = null;
function libEamsParse() { if (!_eamsParse) _eamsParse = require(path.join(LIB_DIR, 'eams_parse.js')); return _eamsParse; }
let _htmlParse = null;
function libHtmlParse() { if (!_htmlParse) _htmlParse = require(path.join(LIB_DIR, 'html_parse.js')); return _htmlParse; }
let _chaoxing = null;
function libChaoxing() { if (!_chaoxing) _chaoxing = require(path.join(LIB_DIR, 'chaoxing_proxy.js')); return _chaoxing; }
// P1：原作者 v2.12 上传/读取协议（自带 x-app-token 鉴权与 data/agent 存储）
let _agentApi = null;
function libAgentApi() {
  if (!_agentApi) _agentApi = require(path.join(LIB_DIR, 'agent_api.js')).create({ dataDir: DATA_DIR });
  return _agentApi;
}
function rescueJsonLines(text) {
  const out = [];
  const re = /\{[^{}]*"sec"\s*:\s*\d+[^{}]*\}/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.push(m[0]);
  return out.join('\n');
}
function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const re = new RegExp('^' + name + '\\s*=\\s*"?([^"\\r\\n]+)"?', 'm');
    const m = txt.match(re);
    if (m) return m[1].trim();
  } catch (e) {}
  return '';
}
function pythonCmd() {
  const fromEnv = envValue('PYTHON_CMD');
  if (fromEnv) return fromEnv;
  const candidates = [
    path.join(ROOT, 'tools', 'python.exe'),
    '/usr/bin/python3',
    '/usr/local/bin/python3'
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return process.platform === 'win32' ? 'python' : 'python3';
}
function ffmpegCmd() {
  const fromEnv = envValue('FFMPEG_PATH');
  if (fromEnv) return fromEnv;
  const candidates = [path.join(ROOT, 'tools', 'ffmpeg.exe'), path.join(ROOT, 'tools', 'ffmpeg')];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return 'ffmpeg';
}
function appPin() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = txt.match(/^CHAT_PIN\s*=\s*"?([^"\r\n]+)"?/m);
    return m ? m[1].trim() : '';
  } catch (e) { return ''; }
}
function checkPin(req, url) {
  const pin = appPin();
  if (!pin) return true;
  const got = String(req.headers['x-app-pin'] || url.searchParams.get('pin') || '');
  return got === pin;
}
function deepseekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = txt.match(/^DEEPSEEK_API_KEY\s*=\s*"?([^\r\n"]+)"?/m);
    if (m) return m[1].trim();
  } catch (e) {}
  return '';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(text);
}
// 学习通路由统一出口：sidecar 没起/超时都回 200 + ok:false，前端按「未启动」提示，不弹 500。
async function chaoxingRoute(res, sidePath, sideMethod, timeoutMs) {
  try {
    const out = await libChaoxing().proxy(sidePath, sideMethod, timeoutMs);
    const body = out && out.body;
    if (!body || typeof body !== 'object') {
      return sendJSON(res, 200, { ok: false, error: '学习通服务返回了非 JSON（' + String(body || '').slice(0, 120) + '）' });
    }
    const code = out.status >= 200 && out.status < 400 ? 200 : out.status;
    return sendJSON(res, code, body);
  } catch (e) {
    return sendJSON(res, 200, { ok: false, error: e && e.message ? e.message : '学习通服务不可用' });
  }
}
function readBody(req, limit) {
  const max = limit || 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function readJSONFile(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; }
}
function writeJSONFile(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function safeName(n) { return typeof n === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(n); }
function safeId(s) { return typeof s === 'string' && /^[A-Za-z0-9-]{4,48}$/.test(s); }
function defaultClasses() {
  return { meta: { name: '我的课表', school: '', weekStart: '', weeksTotal: 20 }, sections: [], courses: [] };
}
function getClasses() {
  const c = readJSONFile(CLASSES_FILE, null);
  if (!c || !Array.isArray(c.courses)) return defaultClasses();
  if (!Array.isArray(c.sections)) c.sections = [];
  if (!c.meta) c.meta = defaultClasses().meta;
  return c;
}
function sessionDir(id) { return path.join(SESS_DIR, id); }
function readMeta(id) { return readJSONFile(path.join(sessionDir(id), 'meta.json'), null); }
function listSessions() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(SESS_DIR); } catch (e) { names = []; }
  for (const name of names) {
    if (!safeId(name)) continue;
    const m = readMeta(name);
    if (m) out.push(m);
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return out;
}
function newId() {
  return 's' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}
function statSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}
function writeFileAtomic(target, buf) {
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);
}
// 同一个会话的写操作串行化，避免并发请求 read-modify-write 互相覆盖
const sessionQueues = new Map();
function withSessionLock(id, fn) {
  const prev = sessionQueues.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  sessionQueues.set(id, run.catch(function () {}));
  return run;
}

async function handleAPI(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  // P1：先认领 /api/session/meta、/api/chunk、/api/notes 等新路由（token 鉴权在模块内做），
  // 不匹配时返回 false 交回下面的旧路由，CHAT_PIN 逻辑对旧路由保持不变。
  if (await libAgentApi().handle(req, res, url)) return;
  if (!checkPin(req, url)) return sendJSON(res, 401, { ok: false, error: '需要访问口令（.env 里设置了 CHAT_PIN）' });

  if (p === '/api/health' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, name: '课堂助手', version: 1, port: PORT });
  }

  // ---------- 课表 ----------
  // ---------- 课表识别（复用课表助手的本地 OCR / 大模型兜底） ----------
  if (p === '/api/ocr-parse' && method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 25 * 1024 * 1024)).toString('utf8'));
      const b64 = String(b.imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) throw new Error('图片为空');
      const data = await libOcr().parseTimetablePNG(buf);
      return sendJSON(res, 200, { ok: true, engine: 'local-ocr', data: data });
    } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/parse-timetable' && method === 'POST') {
    try {
      const key = deepseekKey();
      if (!key) return sendJSON(res, 200, { ok: false, error: '未配置 DEEPSEEK_API_KEY（在 工程\\课堂助手\\.env 写入一行）' });
      const b = JSON.parse((await readBody(req, 25 * 1024 * 1024)).toString('utf8'));
      const b64 = String(b.imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
      const mime = b.mimeType || 'image/png';
      if (!b64) throw new Error('图片为空');
      const prompts = libPrompts();
      let data = null, lastText = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2500));
        const text = await prompts.callVisionText(key, prompts.TIMETABLE_PROMPT, b64, mime);
        lastText = text;
        data = libParse().parseRowJSONTimetable(text);
        if (!data.courses || !data.courses.length) {
          // 模型偶尔把思考过程混进正文：从任何文本里抢救 JSON 行
          const rescued = rescueJsonLines(text);
          if (rescued) {
            const d2 = libParse().parseRowJSONTimetable(rescued);
            if (d2.courses && d2.courses.length) { data = d2; break; }
          }
        } else { break; }
      }
      if (!data.courses || !data.courses.length) {
        return sendJSON(res, 200, { ok: false, error: '识别未返回课程（模型输出异常），请重试', raw: String(lastText || '').slice(0, 300) });
      }
      return sendJSON(res, 200, { ok: true, engine: 'deepseek-vision', data: data });
    } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/campus/import' && method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8'));
      const type = String(b.type || 'eams').toLowerCase();
      const baseUrl = String(b.baseUrl || '').trim();
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      if (!username || !password) return sendJSON(res, 400, { ok: false, error: '请输入学号和密码' });
      let courses = [];
      if (type === 'eams') {
        const lr = await libEams().login(username, password);
        if (!lr.cookie) return sendJSON(res, 200, { ok: false, error: '登录失败：没有拿到会话（可能被限流或账号密码错误）' });
        const ct = await libEams().fetchCourseTable(lr.cookie);
        if (ct.looksLogin) return sendJSON(res, 200, { ok: false, error: '登录未成功（页面仍是登录页），请确认密码' });
        if (ct.looksError) return sendJSON(res, 200, { ok: false, error: '已登录但课表页被限流，请等 1-2 分钟再试' });
        courses = libEamsParse().parseEamsCourseTable(ct.html);
        if (!courses.length) return sendJSON(res, 200, { ok: false, error: '登录成功但课表解析为空，可改用 HTML 导入' });
        var eamsMeta = null;
        try { eamsMeta = libEamsParse().parseEamsMeta(ct.html); } catch (e) {}
        if (eamsMeta && eamsMeta.weeksTotal) {
          return sendJSON(res, 200, { ok: true, type: type, courses: courses, count: courses.length, meta: eamsMeta });
        }
      } else if (type === 'zhengfang') {
        courses = await libZhengfang().loginAndFetch(baseUrl, username, password);
      } else if (type === 'qiangzhi') {
        courses = await libQiangzhi().loginAndFetch(baseUrl, username, password);
      } else {
        return sendJSON(res, 400, { ok: false, error: '不支持的教务类型：' + type });
      }
      return sendJSON(res, 200, { ok: true, type: type, courses: courses, count: courses.length });
    } catch (e) {
      const msg = String((e && e.message) || '');
      if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/i.test(msg)) {
        return sendJSON(res, 200, { ok: false, error: '当前服务器网络访问不到该教务系统，请改用本机地址或截图/HTML 导入' });
      }
      return sendJSON(res, 200, { ok: false, error: msg });
    }
  }
  if (p === '/api/eams/parse-html' && method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 20 * 1024 * 1024)).toString('utf8'));
      const html = String(b.html || '');
      if (!html || html.length < 100) return sendJSON(res, 200, { ok: false, error: 'HTML 内容太短，请保存完整的课表页面' });
      const parsed = libHtmlParse().parseHtml(html);
      let meta = null;
      try { meta = libEamsParse().parseEamsMeta(html); } catch (e) {}
      return sendJSON(res, 200, { ok: true, engine: parsed.engine, courses: parsed.courses, count: parsed.courses.length, meta: meta });
    } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/eams/import' && method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      if (!username || !password) return sendJSON(res, 400, { ok: false, error: '请输入学号和密码' });
      const lib = libEams();
      const lr = await lib.login(username, password);
      if (!lr.cookie) return sendJSON(res, 200, { ok: false, error: '登录失败：没有拿到会话（可能被 WAF 拦截或账号密码错误）' });
      const ct = await lib.fetchCourseTable(lr.cookie);
      try {
        const dir = path.join(ROOT, 'data', 'eams-debug');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'course-table.html'), ct.html, 'utf8');
      } catch (e) {}
      let parsed = [];
      if (!ct.looksLogin && !ct.looksError) {
        try { parsed = libEamsParse().parseEamsCourseTable(ct.html); } catch (e) {}
      }
      return sendJSON(res, 200, {
        ok: true,
        loginStatus: lr.status,
        redirected: lr.redirected,
        tableStatus: ct.status,
        looksLogin: ct.looksLogin,
        looksError: !!ct.looksError,
        courses: parsed,
        courseCount: parsed.length,
        semesterId: ct.semesterId || '',
        homeStatus: ct.homeStatus,
        frameStatus: ct.frameStatus,
        frameSize: ct.frameSize,
        length: ct.html.length,
        sample: ct.html.slice(0, 400)
      });
    } catch (e) {
      const msg = String((e && e.message) || '');
      if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/i.test(msg)) {
        return sendJSON(res, 200, {
          ok: false,
          error: '当前服务器的网络访问不到学校教务系统（校外网络可能被限制）。请改用本机地址 http://127.0.0.1:3003 重试，或先用截图识别导入。'
        });
      }
      return sendJSON(res, 200, { ok: false, error: msg });
    }
  }
  if (p === '/api/ai/chat' && method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
      const messages = Array.isArray(b.messages) ? b.messages.slice(-20) : [];
      if (!messages.length) return sendJSON(res, 400, { ok: false, error: '缺少 messages' });
      const out = await libAiProvider().chat(req, messages, { maxTokens: 3000, timeoutMs: 120000 });
      return sendJSON(res, 200, { ok: true, text: out.text, provider: out.provider, model: out.model });
    } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/assist/summary' && method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
      const sid = String(b.sid || '');
      if (!safeId(sid)) return sendJSON(res, 400, { ok: false, error: 'bad sid' });
      const meta = readMeta(sid);
      if (!meta) return sendJSON(res, 404, { ok: false, error: '会话不存在' });
      const data = await libAssist().summarize(libAiProvider(), meta);
      return sendJSON(res, 200, { ok: true, summary: data, course: meta.courseName, sid: sid });
    } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/assist/mindmap' && method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
      const courseId = String(b.courseId || '');
      const all = !courseId;
      const sessions = listSessions();
      const byCourse = {};
      sessions.forEach((s) => {
        if (s.status !== 'done' && s.status !== 'recording') return;
        if (!all && s.courseId !== courseId) return;
        const meta = readMeta(s.id);
        if (!meta) return;
        const text = (meta.aiNote && meta.aiNote.markdown) || (meta.transcript && meta.transcript.text) || meta.note || '';
        if (!text) return;
        const key = s.courseName || '未命名课程';
        if (!byCourse[key]) byCourse[key] = [];
        byCourse[key].push(text);
      });
      const courses = Object.keys(byCourse).map((name) => ({ name: name, text: byCourse[name].join('\n\n') }));
      if (!courses.length) return sendJSON(res, 200, { ok: false, error: '没有可用笔记（先转写或生成 AI 笔记）' });
      const data = await libAssist().mindmap(libAiProvider(), courses);
      return sendJSON(res, 200, { ok: true, tree: data, scope: all ? 'all' : courseId, courseCount: courses.length });
    } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/assist/todos' && method === 'GET') {
    try {
      const items = libAssist().collectTodos(listSessions());
      return sendJSON(res, 200, { ok: true, items: items.slice(0, 50) });
    } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/assist/chat' && method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
      const history = Array.isArray(b.messages) ? b.messages.slice(-12) : [];
      const sessions = listSessions();
      const today = new Date();
      const dayIdx = ((today.getDay() + 6) % 7) + 1;
      const classes = getClasses();
      const todayCourses = (classes.courses || []).filter((c) => c.day === dayIdx);
      const recent = sessions.filter((s) => s.status === 'done').slice(0, 8).map((s) => {
        const meta = readMeta(s.id) || s;
        const text = (meta.aiNote && meta.aiNote.markdown) || (meta.transcript && meta.transcript.text) || meta.note || '';
        return '- ' + (s.courseName || '') + ' ' + new Date(s.startedAt || 0).toLocaleDateString('zh-CN') + '：' + libAssist().clip(text.replace(/\n/g, ' '), 160);
      });
      const todos = libAssist().collectTodos(sessions).slice(0, 12).map((t) => '- ' + (t.course || '') + '：' + t.title + (t.due ? '（' + t.due + '）' : ''));
      const sys = [
        '你是「课堂助手」的 AI 助教，帮助学生学习和管理课堂记录。',
        '当前日期：' + today.toLocaleDateString('zh-CN') + '（周' + '一二三四五六日'[dayIdx - 1] + '）',
        '今天课表：' + (todayCourses.length ? todayCourses.map((c) => c.name + '（' + (c.room || '') + '）').join('、') : '今天没有课'),
        '最近课堂笔记：',
        recent.join('\n') || '（暂无）',
        '待办事项：',
        todos.join('\n') || '（暂无）',
        '规则：回答用中文、简洁直接；涉及课表/笔记/待办时只依据上面数据；没查询到就说没有，不要编造。'
      ].join('\n');
      const messages = [{ role: 'system', content: sys }].concat(history);
      const out = await libAiProvider().chat(req, messages, { maxTokens: 3000, timeoutMs: 120000 });
      return sendJSON(res, 200, { ok: true, text: out.text, provider: out.provider, model: out.model });
    } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/system-check' && method === 'GET') {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
    const ffmpeg = ffmpegCmd();
    const py312 = pythonCmd();
    const smallDir = path.join(ROOT, 'models', 'faster-whisper-small');
    const tinyDir = path.join(ROOT, 'models', 'faster-whisper-tiny');
    add('服务运行', true, '端口 ' + PORT);
    add('数据目录可写', (() => { try { fs.accessSync(DATA_DIR, fs.constants.W_OK); return true; } catch (e) { return false; } })(), DATA_DIR);
    add('课表数据', Array.isArray(getClasses().courses), (getClasses().courses || []).length + ' 门课程');
    let sessCount = 0;
    try { sessCount = listSessions().length; } catch (e) {}
    add('课堂记录', true, sessCount + ' 条');
    add('Python（转写）', fs.existsSync(py312) || py312 === 'python', py312);
    const modelDir = fs.existsSync(smallDir) ? smallDir : tinyDir;
    add('Whisper 模型', fs.existsSync(modelDir), fs.existsSync(modelDir) ? path.basename(modelDir) : '缺少 models/faster-whisper-*');
    add('ffmpeg', fs.existsSync(ffmpeg) || ffmpeg === 'ffmpeg', ffmpeg);
    const key = deepseekKey();
    add('DeepSeek Key（AI 识别）', !!key, key ? '已配置' : '未配置 .env');
    add('OCR 模块', fs.existsSync(path.join(LIB_DIR, 'ocr.js')) && fs.existsSync(path.join(LIB_DIR, 'ocr_engine.ps1')), 'lib/ocr.js + ocr_engine.ps1');
    add('课表识别接口', true, '/api/ocr-parse /api/parse-timetable');
    let totalBytes = 0;
    try {
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          const st = fs.statSync(p);
          if (st.isDirectory()) walk(p); else totalBytes += st.size;
        }
      };
      walk(path.join(SESS_DIR));
    } catch (e) {}
    add('课堂数据占用', true, (totalBytes / 1024 / 1024).toFixed(1) + ' MB');
    return sendJSON(res, 200, { ok: true, checks, node: process.version, platform: process.platform });
  }
  if (p === '/api/schools' && method === 'GET') {
    try { return sendJSON(res, 200, { ok: true, data: require(path.join(LIB_DIR, 'schools.js')) }); }
    catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
  }

  if (p === '/api/classes' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, data: getClasses() });
  }
  if (p === '/api/classes' && method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (!body || !Array.isArray(body.courses)) throw new Error('courses 必须是数组');
      const data = { meta: body.meta || {}, sections: body.sections || [], courses: body.courses };
      writeJSONFile(CLASSES_FILE, data);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  }

  // ---------- AI 状态 ----------
  if (p === '/api/ai/status' && method === 'GET') {
    try {
      const cfg = libAiProvider().resolve(req);
      return sendJSON(res, 200, { ok: true, hasKey: !!cfg.key, provider: cfg.name, model: cfg.model });
    } catch (e) { return sendJSON(res, 200, { ok: true, hasKey: false, provider: '', model: '' }); }
  }

  // ---------- 课堂会话 ----------
  if (p === '/api/sessions/delete' && method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const sid = String(b.id || '');
      if (!safeId(sid)) return sendJSON(res, 400, { ok: false, error: '无效的记录 id' });
      fs.rmSync(path.join(SESS_DIR, sid), { recursive: true, force: true });
      return sendJSON(res, 200, { ok: true, id: sid });
    } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
  }
  if (p === '/api/sessions/purge' && method === 'POST') {
    try {
      let n = 0;
      for (const name of fs.readdirSync(SESS_DIR)) {
        if (!safeId(name)) continue;
        fs.rmSync(path.join(SESS_DIR, name), { recursive: true, force: true });
        n++;
      }
      return sendJSON(res, 200, { ok: true, removed: n });
    } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
  }
  if (p === '/api/sessions' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
    return sendJSON(res, 200, { ok: true, sessions: listSessions().slice(0, limit) });
  }
  if (p === '/api/sessions' && method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
      const cls = getClasses();
      const course = (cls.courses || []).find((c) => c.id === b.courseId) || null;
      const id = newId();
      const meta = {
        id,
        courseId: b.courseId || '',
        courseName: b.courseName || (course ? course.name : '未选课'),
        teacher: b.teacher || (course ? course.teacher : '') || '',
        room: b.room || (course ? course.room : '') || '',
        startedAt: Number(b.startedAt) || Date.now(),
        endedAt: 0,
        durationMs: 0,
        status: 'recording',
        segments: [],
        photos: [],
        markers: [],
        note: '',
        createdAt: Date.now(),
      };
      fs.mkdirSync(path.join(sessionDir(id), 'rec'), { recursive: true });
      fs.mkdirSync(path.join(sessionDir(id), 'photos'), { recursive: true });
      writeJSONFile(path.join(sessionDir(id), 'meta.json'), meta);
      return sendJSON(res, 200, { ok: true, session: meta });
    } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  }

  const m = p.match(/^\/api\/sessions\/([A-Za-z0-9-]{4,48})(?:\/(chunk|photo|finish|note|marker|transcribe|transcript|polish-transcript|ai-note))?$/);
  if (m) {
    const id = m[1];
    const action = m[2];
    if (!safeId(id)) return sendJSON(res, 400, { ok: false, error: 'bad id' });
    const meta = readMeta(id);
    if (!meta) return sendJSON(res, 404, { ok: false, error: '会话不存在' });

    if (!action && method === 'GET') return sendJSON(res, 200, { ok: true, session: meta });

    if (action === 'chunk' && method === 'POST') {
      try {
        const name = url.searchParams.get('name');
        const offsetMs = Number(url.searchParams.get('offsetMs')) || 0;
        if (!safeName(name)) return sendJSON(res, 400, { ok: false, error: 'bad name' });
        const buf = await readBody(req, 20 * 1024 * 1024);
        await withSessionLock(id, function () {
          const m = readMeta(id);
          if (!m) throw new Error('会话不存在');
          writeFileAtomic(path.join(sessionDir(id), 'rec', name), buf);
          const existing = (m.segments || []).find((s) => s.name === name);
          if (existing) { existing.bytes = buf.length; existing.offsetMs = offsetMs; }
          else m.segments.push({ name, offsetMs, bytes: buf.length });
          m.segments.sort((a, b) => a.offsetMs - b.offsetMs);
          writeJSONFile(path.join(sessionDir(id), 'meta.json'), m);
        });
        return sendJSON(res, 200, { ok: true, bytes: buf.length, segments: (readMeta(id).segments || []).length });
      } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    }

    if (action === 'photo' && method === 'POST') {
      try {
        const name = url.searchParams.get('name');
        const offsetMs = Number(url.searchParams.get('offsetMs')) || 0;
        if (!safeName(name)) return sendJSON(res, 400, { ok: false, error: 'bad name' });
        const buf = await readBody(req, 20 * 1024 * 1024);
        await withSessionLock(id, function () {
          const m = readMeta(id);
          if (!m) throw new Error('会话不存在');
          writeFileAtomic(path.join(sessionDir(id), 'photos', name), buf);
          const existing = (m.photos || []).find((s) => s.name === name);
          if (existing) existing.offsetMs = offsetMs;
          else m.photos.push({ name, offsetMs, bytes: buf.length });
          m.photos.sort((a, b) => a.offsetMs - b.offsetMs);
          writeJSONFile(path.join(sessionDir(id), 'meta.json'), m);
        });
        return sendJSON(res, 200, { ok: true, photos: (readMeta(id).photos || []).length });
      } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    }

    // 转写：异步启动（手机端等待时间长也不掉线），状态写入 meta.transcriptStatus
    if (action === 'transcribe' && method === 'POST') {
      try {
        const py = pythonCmd();
        const script = path.join(LIB_DIR, 'whisper_transcribe.py');
        const smallDir = path.join(ROOT, 'models', 'faster-whisper-small');
        const tinyDir = path.join(ROOT, 'models', 'faster-whisper-tiny');
        const wantModel = String(url.searchParams.get('model') || 'quality').toLowerCase();
        const modelDir = (wantModel === 'fast' || wantModel === 'tiny') ? tinyDir : (fs.existsSync(smallDir) ? smallDir : tinyDir);
        const outFile = path.join(sessionDir(id), 'transcript.json');
        const ffmpeg = ffmpegCmd();
        if (!fs.existsSync(script)) throw new Error('转写脚本缺失：lib/whisper_transcribe.py');
        if (!fs.existsSync(modelDir)) throw new Error('转写模型缺失：models/faster-whisper-tiny');
        if (!(meta.segments || []).length) throw new Error('这节课没有录音段');
        if (meta.transcriptStatus === 'running') return sendJSON(res, 200, { ok: true, status: 'running', message: '转写进行中' });
        const started = startTranscribeJob(id, { py, script, modelDir, outFile, ffmpeg, wantModel });
        return sendJSON(res, 200, { ok: true, status: 'running', model: wantModel === 'fast' ? 'tiny' : 'small', started: started });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
    }
    if (action === 'polish-transcript' && method === 'POST') {
      try {
        const m = readMeta(id);
        if (!m || !m.transcript || !m.transcript.text) return sendJSON(res, 200, { ok: false, error: '还没有文字稿，请先转写' });
        const text = String(m.transcript.text);
        const courseName = (m.courseName || '').replace(/[\r\n]/g, '');
        const sys = '你是课堂录音转写稿的校对助手。请修正语音识别造成的同音错别字和学科术语错误（例如把「导书」改为「导数」、「缺险」改为「曲线」、「鞋律」改为「斜率」），保持原文内容、顺序和口语风格，不要总结、不要增删内容。严格要求：你的回复只包含校对后的全文正文，不要任何解释、前言、寒暄或补充说明；即使原文很短或看起来不完整，也原样输出校对结果。';
        const chunks = [];
        for (let i = 0; i < text.length; i += 3000) chunks.push(text.slice(i, i + 3000));
        const out = [];
        for (const c of chunks) {
          const r = await libAiProvider().chat(req, [
            { role: 'system', content: sys },
            { role: 'user', content: '课程：' + (courseName || '课堂') + '\n转写稿：\n' + c }
          ], { temperature: 0.1, maxTokens: 4000, timeoutMs: 120000 });
          out.push(r.text);
        }
        const polished = out.join('\n');
        await withSessionLock(id, function () {
          const m2 = readMeta(id);
          if (!m2 || !m2.transcript) return;
          m2.transcript.polished = { text: polished, at: Date.now() };
          writeJSONFile(path.join(sessionDir(id), 'meta.json'), m2);
        });
        return sendJSON(res, 200, { ok: true, polished: polished });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
    }
    if (action === 'transcript' && method === 'GET') {
      const m2 = readMeta(id) || {};
      return sendJSON(res, 200, { ok: true, status: m2.transcriptStatus || (m2.transcript ? 'done' : 'idle'), transcript: m2.transcript || null, error: m2.transcriptError || '' });
    }

    if (action === 'ai-note' && method === 'POST') {
      try {
        const aiCfg = libAiProvider().resolve(req);
        if (!aiCfg.key) return sendJSON(res, 200, { ok: false, error: '未配置 AI Key：请在「我的 → AI 设置」填自己的 key，或在 .env 配置 ZHIPU_API_KEY / DEEPSEEK_API_KEY' });
        const m = readMeta(id);
        const tr = m.transcript;
        if (!tr || !tr.text) return sendJSON(res, 200, { ok: false, error: '先转写文字稿，再生成 AI 笔记' });
        const segs = (tr.segments && tr.segments.length) ? tr.segments : [{ start: 0, end: 0, text: tr.text }];
        const d = new Date(m.startedAt || Date.now());
        const payload = {
          courseName: m.courseName,
          dateText: (d.getMonth() + 1) + '月' + d.getDate() + '日',
          durationText: Math.round((m.durationMs || 0) / 60000) + ' 分钟',
          segments: segs,
          markers: m.markers || [],
          photos: m.photos || [],
          userNote: m.note || ''
        };
        const note = await libAiNote().generateNote({ key: aiCfg.key, model: aiCfg.model, base: aiCfg.base }, payload);
        let out = null;
        await withSessionLock(id, function () {
          const m2 = readMeta(id);
          if (!m2) throw new Error('会话不存在');
          m2.aiNote = { title: note.title, markdown: note.markdown, items: note.items, model: aiCfg.model, at: Date.now() };
          writeJSONFile(path.join(sessionDir(id), 'meta.json'), m2);
          out = m2.aiNote;
        });
        return sendJSON(res, 200, { ok: true, aiNote: out });
      } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
    }

    if (action === 'marker' && method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
        let count = 0;
        await withSessionLock(id, function () {
          const m = readMeta(id);
          if (!m) throw new Error('会话不存在');
          m.markers = m.markers || [];
          m.markers.push({ offsetMs: Number(b.offsetMs) || 0, type: b.type || '重点', note: b.note || '', createdAt: Date.now() });
          count = m.markers.length;
          writeJSONFile(path.join(sessionDir(id), 'meta.json'), m);
        });
        return sendJSON(res, 200, { ok: true, markers: count });
      } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    }

    if (action === 'finish' && method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8'));
        let out = null;
        await withSessionLock(id, function () {
          const m = readMeta(id);
          if (!m) throw new Error('会话不存在');
          m.endedAt = Number(b.endedAt) || Date.now();
          m.durationMs = Number(b.durationMs) || Math.max(0, m.endedAt - m.startedAt);
          m.note = typeof b.note === 'string' ? b.note : (m.note || '');
          if (typeof b.summary === 'string') m.summary = b.summary;
          m.status = 'done';
          writeJSONFile(path.join(sessionDir(id), 'meta.json'), m);
          out = m;
        });
        return sendJSON(res, 200, { ok: true, session: out });
      } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    }

    if (action === 'transcript' && method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
        let out = null;
        await withSessionLock(id, function () {
          const m = readMeta(id);
          if (!m) throw new Error('会话不存在');
          if (typeof b.text === 'string') {
            m.transcript = m.transcript || {};
            m.transcript.text = b.text;
            m.transcript.editedAt = Date.now();
            writeJSONFile(path.join(sessionDir(id), 'meta.json'), m);
          }
          out = m.transcript;
        });
        return sendJSON(res, 200, { ok: true, transcript: out });
      } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    }

    if (action === 'note' && method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
        let out = null;
        await withSessionLock(id, function () {
          const m = readMeta(id);
          if (!m) throw new Error('会话不存在');
          if (typeof b.note === 'string') m.note = b.note;
          if (typeof b.summary === 'string') m.summary = b.summary;
          m.updatedAt = Date.now();
          writeJSONFile(path.join(sessionDir(id), 'meta.json'), m);
          out = m;
        });
        return sendJSON(res, 200, { ok: true, session: out });
      } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    }

    if (!action && method === 'DELETE') {
      try {
        fs.rmSync(sessionDir(id), { recursive: true, force: true });
        return sendJSON(res, 200, { ok: true });
      } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
    }
    return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  }

  // ---------- 媒体 ----------
  const mm = p.match(/^\/api\/media\/([A-Za-z0-9-]{4,48})\/(rec|photos)\/([^/]+)$/);
  if (mm && method === 'GET') {
    const id = mm[1], kind = mm[2], name = decodeURIComponent(mm[3]);
    if (!safeId(id) || !safeName(name)) return sendText(res, 400, 'bad path');
    const p2 = path.join(sessionDir(id), kind, name);
    if (!fs.existsSync(p2)) return sendText(res, 404, 'not found');
    const ext = path.extname(name).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const stat = fs.statSync(p2);
    const range = req.headers.range;
    if (range) {
      const rm = range.match(/bytes=(\d*)-(\d*)/);
      let start = rm && rm[1] ? parseInt(rm[1], 10) : 0;
      let end = rm && rm[2] ? parseInt(rm[2], 10) : stat.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) { res.writeHead(416); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(p2, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(p2).pipe(res);
  }

  // ---------- 学习通（v1 可选集成） ----------
  // 转发到本机 127.0.0.1:8781 的 Python sidecar（只监听回环，手机/隧道都连不到它）。
  // sidecar 不在线不是服务器故障：一律 200 + ok:false，由前端提示「需要本机 pc-agent 在线」。
  if (p === '/api/chaoxing/status' && method === 'GET') {
    return await chaoxingRoute(res, '/status', 'GET', 20000);
  }
  if (p === '/api/chaoxing/login/status' && method === 'GET') {
    return await chaoxingRoute(res, '/login/status', 'GET', 10000);
  }
  if (p === '/api/chaoxing/login/start' && method === 'POST') {
    return await chaoxingRoute(res, '/login/start?open=1', 'POST', 40000);
  }
  if (p === '/api/chaoxing/summary' && method === 'GET') {
    const force = url.searchParams.get('force') === '1';
    return await chaoxingRoute(res, force ? '/summary?force=1' : '/summary', 'GET', 15000);
  }
  if (p === '/api/chaoxing/logout' && method === 'POST') {
    return await chaoxingRoute(res, '/logout', 'POST', 15000);
  }
  if (p === '/api/chaoxing/verify/open' && method === 'POST') {
    return await chaoxingRoute(res, '/verify/open', 'POST', 10000);
  }

  return sendJSON(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname.startsWith('/api/')) return await handleAPI(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed');

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!target.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'forbidden');
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      // SPA 兜底
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(fallback)) return sendFile(req, res, fallback);
      return sendText(res, 404, 'not found');
    }
    return sendFile(req, res, target);
  } catch (e) {
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: e.message });
  }
});

// 异步转写任务：立即返回，后台跑 Python，状态写 meta.json
function startTranscribeJob(id, opt) {
  const meta = readMeta(id);
  if (!meta) return false;
  const courseName = (meta.courseName || '').replace(/[\r\n"]/g, '');
  let terms = '';
  try {
    const cls = getClasses();
    const course = (cls.courses || []).find((c) => c.id === meta.courseId);
    if (course && course.terms) terms = String(course.terms).replace(/[\r\n"]/g, '');
  } catch (e) {}
  let prompt = '这是一节' + (courseName || '大学') + '课堂录音';
  if (terms) prompt += '，涉及术语：' + terms;
  prompt += '，内容涉及专业术语，请用简体中文输出，术语按学科规范书写。';
  withSessionLock(id, function () {
    const m = readMeta(id);
    if (!m) return;
    m.transcriptStatus = 'running';
    m.transcriptStartedAt = Date.now();
    m.transcriptError = '';
    writeJSONFile(path.join(sessionDir(id), 'meta.json'), m);
  }).catch(() => {});
  let child;
  try {
    child = spawn(opt.py, [opt.script, '--session', sessionDir(id), '--model', opt.modelDir, '--out', opt.outFile, '--ffmpeg', opt.ffmpeg, '--prompt', prompt], { windowsHide: true });
  } catch (e) {
    finishTranscribe(id, { ok: false, error: '启动转写失败：' + e.message });
    return false;
  }
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); });
  const hardTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (e) {}
    finishTranscribe(id, { ok: false, error: '转写超时（超过 90 分钟）' });
  }, 90 * 60 * 1000);
  child.on('error', (e) => { clearTimeout(hardTimer); finishTranscribe(id, { ok: false, error: '启动转写失败：' + e.message }); });
  child.on('close', (code) => {
    clearTimeout(hardTimer);
    if (code !== 0) return finishTranscribe(id, { ok: false, error: '转写失败（exit ' + code + '）：' + err.slice(-300) });
    let result = null;
    try { result = JSON.parse(fs.readFileSync(opt.outFile, 'utf8')); } catch (e) { return finishTranscribe(id, { ok: false, error: '转写结果读取失败：' + e.message }); }
    if (!result.ok) return finishTranscribe(id, { ok: false, error: result.error || '转写失败' });
    finishTranscribe(id, result);
  });
  return true;
}
function finishTranscribe(id, result) {
  try {
    withSessionLock(id, function () {
      const m = readMeta(id);
      if (!m) return;
      if (result && result.ok) {
        m.transcript = { text: result.text, segments: result.segments, model: result.model, tookMs: result.tookMs, at: Date.now() };
        m.transcriptStatus = 'done';
        m.transcriptError = '';
      } else {
        m.transcriptStatus = 'error';
        m.transcriptError = (result && result.error) || '转写失败';
      }
      writeJSONFile(path.join(sessionDir(id), 'meta.json'), m);
    });
  } catch (e) {}
}
function sendFile(req, res, p) {
  const ext = path.extname(p).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(p);
  const etag = '"' + stat.size.toString(36) + '-' + Math.round(stat.mtimeMs).toString(36) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'ETag': etag });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(p).pipe(res);
}

server.listen(PORT, () => {
  console.log('课堂助手已启动: http://127.0.0.1:' + PORT);
  console.log('数据目录: ' + DATA_DIR);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('端口 ' + PORT + ' 已被占用，换 PORT 环境变量再试');
  else console.error('服务错误: ' + e.message);
  process.exit(1);
});
