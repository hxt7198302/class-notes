/* 课堂助手 · 前端逻辑（无构建，原生 JS） */
'use strict';

/* ---------------- 基础工具 ---------------- */
function $(id) { return document.getElementById(id); }
function pad(n) { return String(n).padStart(2, '0'); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function toast(msg) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  requestAnimationFrame(function () { t.classList.add('show'); });
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.classList.remove('show'); setTimeout(function(){ t.classList.add('hidden'); }, 220); }, 2200);
}
function api(path, opts) {
  var o = opts || {};
  var headers = {};
  var src = o.headers || {};
  Object.keys(src).forEach(function (k) { headers[k] = src[k]; });
  var pin = localStorage.getItem('kb-pin');
  if (pin) headers['x-app-pin'] = pin;
  var appToken = localStorage.getItem('kb-app-token');
  if (appToken) headers['x-app-token'] = appToken;
  var aiProv = localStorage.getItem('kb-ai-provider');
  var aiKey = localStorage.getItem('kb-ai-key');
  var aiModel = localStorage.getItem('kb-ai-model');
  if (aiProv) headers['x-ai-provider'] = aiProv;
  if (aiKey) headers['x-ai-key'] = aiKey;
  if (aiModel) headers['x-ai-model'] = aiModel;
  var init = { method: o.method || 'GET', headers: headers };
  if (o.body !== undefined) init.body = o.body;
  return fetch(path, init).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (j) {
      if (res.status === 401) { throw new Error('PIN_REQUIRED'); }
      if (!res.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + res.status));
      return j;
    });
  });
}
function appTokenHeaders(extra) {
  var h = {};
  var tok = '';
  try { tok = localStorage.getItem('kb-app-token') || ''; } catch (e) {}
  if (tok) h['x-app-token'] = tok;
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  return h;
}
function fmtDur(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  return m + ' 分';
}
function fmtClock(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? h + ':' + pad(m) + ':' + pad(ss) : pad(m) + ':' + pad(ss);
}
function fmtDateTime(ts) {
  var d = new Date(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fmtDateCn(d) {
  var wd = ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()];
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + wd;
}
function hhmmToMin(s) { var p = String(s || '0:0').split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
function parseLocalDate(s) {
  var m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
function fmtISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function mondayOf(d) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var wd = x.getDay() || 7;
  x.setDate(x.getDate() - (wd - 1));
  return x;
}
function addDays(d, n) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }

var WEEK_NAMES = ['周一','周二','周三','周四','周五','周六','周日'];
var DEFAULT_SECTIONS = [
  { n: 1, start: '08:00', end: '08:45' }, { n: 2, start: '08:50', end: '09:35' },
  { n: 3, start: '09:55', end: '10:40' }, { n: 4, start: '10:45', end: '11:30' },
  { n: 5, start: '13:30', end: '14:15' }, { n: 6, start: '14:20', end: '15:05' },
  { n: 7, start: '15:25', end: '16:10' }, { n: 8, start: '16:15', end: '17:00' },
  { n: 9, start: '18:10', end: '18:55' }, { n: 10, start: '19:00', end: '19:45' },
  { n: 11, start: '19:55', end: '20:40' }, { n: 12, start: '20:45', end: '21:30' }
];
var PALETTE = ['#5b8def','#54b8a6','#e0736c','#d9a441','#8f7be8','#4fa3d1','#d06fa8','#7fae52','#c9874e','#6f7dd7','#c26b6b','#5aa9a3'];
var ROW_H = 56;
var SEG_MS = 30000; /* 每 30 秒切一段，防丢；后续可调 */

/* ---------------- 状态 ---------------- */
var state = {
  classes: { meta: {}, sections: [], courses: [] },
  sessions: [],
  weekStartDate: null,
  currentWeek: 1,
  displayWeek: 1,
  view: 'timetable',
  rec: null,
  finishSid: null,
  wakeLock: null,
  noteFilter: '',
  noteQuery: '',
  aiBusy: false,
  chatHistory: [],
  lastMindmap: null,
  routeParams: {},
  notesCache: null,
  notesFallback: false
};

function sections() {
  var s = (state.classes && state.classes.sections) || [];
  return s.length ? s : DEFAULT_SECTIONS;
}
function weekOf(d) {
  if (!state.weekStartDate) return 1;
  var diff = Math.round((mondayOf(d) - state.weekStartDate) / 86400000 / 7) + 1;
  return Math.max(1, diff);
}
function weekDate(week, day) {
  var base = state.weekStartDate || mondayOf(new Date());
  return addDays(base, (week - 1) * 7 + (day - 1));
}
function todayWeekday() { return new Date().getDay() || 7; }
function inWeek(weeksText, w) {
  var t = String(weeksText == null ? '' : weeksText).trim();
  if (!t || t === '全周' || t === '全部') return true;
  var parts = t.split(/[,，、;；\s]+/);
  for (var i = 0; i < parts.length; i++) {
    var s = parts[i].trim();
    if (!s) continue;
    if (/单周/.test(s)) { if (w % 2 === 1) return true; continue; }
    if (/双周/.test(s)) { if (w % 2 === 0) return true; continue; }
    var m = s.match(/^(\d{1,2})\s*[-—~]\s*(\d{1,2})\s*([单双]?)$/);
    if (m) {
      if (w >= +m[1] && w <= +m[2]) {
        if (m[3] === '单') { if (w % 2 === 1) return true; continue; }
        if (m[3] === '双') { if (w % 2 === 0) return true; continue; }
        return true;
      }
      continue;
    }
    if (/^\d{1,2}$/.test(s)) { if (+s === w) return true; }
  }
  return false;
}
function paletteOf(course) {
  var idx = Number(course.color);
  if (!isFinite(idx) || idx < 0) {
    var h = 0;
    for (var i = 0; i < course.name.length; i++) h = (h * 31 + course.name.charCodeAt(i)) % 997;
    idx = h % PALETTE.length;
  }
  return PALETTE[idx % PALETTE.length];
}
function fgOf(bg) {
  var hex = String(bg).replace('#', '');
  if (hex.length !== 6) return '#fff';
  var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#1b2233' : '#ffffff';
}
function secRange(a, b) {
  var ss = sections();
  var s0 = ss[Math.max(0, a - 1)], s1 = ss[Math.max(0, b - 1)];
  if (!s0 || !s1) return '';
  return s0.start + '–' + s1.end;
}
function nowTop() {
  var now = new Date();
  var mins = now.getHours() * 60 + now.getMinutes();
  var ss = sections();
  for (var i = 0; i < ss.length; i++) {
    var s = hhmmToMin(ss[i].start), e = hhmmToMin(ss[i].end);
    if (mins >= s && mins <= e) return i * ROW_H + ((mins - s) / Math.max(1, e - s)) * ROW_H;
  }
  for (var j = 0; j < ss.length; j++) {
    if (mins < hhmmToMin(ss[j].start)) return j * ROW_H;
  }
  return null;
}

/* ---------------- 视图切换 / 路由 ---------------- */
var VIEWS = ['timetable', 'class', 'notes', 'assist', 'me', 'chaoxing', 'source', 'course', 'todo'];
function setActiveView(name) {
  state.view = name;
  VIEWS.forEach(function (v) {
    var el = $('view-' + v);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  var tabName = name === 'chaoxing' ? 'me' : (name === 'source' || name === 'course' || name === 'todo' ? 'notes' : name);
  document.querySelectorAll('.tab').forEach(function (t) {
    t.classList.toggle('active', t.dataset.view === tabName);
  });
  if (name === 'class') renderClassPage();
  if (name === 'notes') renderNotes();
  if (name === 'assist') renderAssist();
  if (name === 'me') renderMe();
  if (name === 'chaoxing') loadChaoxing(false);
  else cxStopPoll();
  if (name === 'timetable') renderTimetable();
  if (name === 'source') renderSourcePage();
  if (name === 'course') renderCoursePage();
  if (name === 'todo') renderTodoPage(false);
  if (name !== 'source') srcStopAudio();
  window.scrollTo(0, 0);
}
function routeHash(route, params) {
  var parts = [];
  params = params || {};
  Object.keys(params).forEach(function (k) {
    var v = params[k];
    if (v === undefined || v === null || v === '') return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  return '#' + route + (parts.length ? '?' + parts.join('&') : '');
}
function writeHash(route, params) {
  try { history.replaceState(null, '', routeHash(route, params)); } catch (e) {}
}
function switchView(name) {
  state.routeParams = {};
  setActiveView(name);
  writeHash(name, {});
}
function navigate(route, params) {
  state.routeParams = params || {};
  setActiveView(route);
  writeHash(route, state.routeParams);
}
function parseRoute() {
  var raw = String(location.hash || '').replace(/^#\/?/, '');
  var i = raw.indexOf('?');
  var route = (i >= 0 ? raw.slice(0, i) : raw).replace(/\/+$/, '');
  var params = {};
  var qs = i >= 0 ? raw.slice(i + 1) : '';
  qs.split('&').forEach(function (kv) {
    if (!kv) return;
    var pos = kv.indexOf('=');
    var k = pos >= 0 ? kv.slice(0, pos) : kv;
    var v = pos >= 0 ? kv.slice(pos + 1) : '';
    try { params[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) {}
  });
  return { route: route, params: params };
}
function paramsKey(p) {
  p = p || {};
  return Object.keys(p).sort().map(function (k) { return k + '=' + String(p[k]); }).join('&');
}
function applyRoute(r) {
  var route = r && r.route;
  if (VIEWS.indexOf(route) < 0) route = 'timetable';
  state.routeParams = (r && r.params) || {};
  setActiveView(route);
  writeHash(route, state.routeParams);
}

/* ---------------- 加载 ---------------- */
var CACHE_CLASSES = 'kb-cache-classes';
var CACHE_SESSIONS = 'kb-cache-sessions';
function cacheSet(k, v) { try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), v: v })); } catch (e) {} }
function cacheGet(k) { try { var o = JSON.parse(localStorage.getItem(k) || 'null'); return o && o.v ? o.v : null; } catch (e) { return null; } }
function applyClassesData(d) {
  d = d || {};
  state.classes = { meta: d.meta || {}, sections: d.sections || [], courses: d.courses || [] };
  var ws = parseLocalDate(state.classes.meta.weekStart);
  state.weekStartDate = ws || mondayOf(new Date());
  if (!state.classes.meta.weekStart) state.classes.meta.weekStart = fmtISO(state.weekStartDate);
  state.currentWeek = weekOf(new Date());
  var totalW = +state.classes.meta.weeksTotal || 20;
  state.displayWeek = Math.min(Math.max(1, state.currentWeek), Math.max(1, totalW));
}
function loadClasses() {
  return api('/api/classes').then(function (j) {
    var d = j.data || {};
    applyClassesData(d);
    cacheSet(CACHE_CLASSES, state.classes);
  }).catch(function (e) { toast('课表加载失败：' + e.message); });
}
function loadSessions() {
  return api('/api/sessions').then(function (j) {
    state.sessions = j.sessions || [];
    cacheSet(CACHE_SESSIONS, state.sessions);
  }).catch(function (e) { toast('笔记加载失败：' + e.message); });
}
function saveClasses() {
  return api('/api/classes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.classes)
  }).then(function () { renderAll(); }).catch(function (e) { toast('保存失败：' + e.message); });
}

/* ---------------- 渲染：课表 ---------------- */
function visibleDays() {
  // 周一到周五固定；周六、周日只有当天有课才显示（空间留给课程内容）
  var out = [1, 2, 3, 4, 5];
  var w = state.displayWeek;
  [6, 7].forEach(function (d) {
    var has = state.classes.courses.some(function (c) { return c.day === d && inWeek(c.weeks, w); });
    if (has) out.push(d);
  });
  return out;
}
// 同一天课程重叠时并排：按开始节排序分组，组内分配 lane
function layoutDay(courses) {
  var sorted = courses.slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; });
  var groups = [];
  sorted.forEach(function (c) {
    var g = groups[groups.length - 1];
    if (g && c.start <= g.maxEnd) { g.items.push(c); if (c.end > g.maxEnd) g.maxEnd = c.end; }
    else groups.push({ items: [c], maxEnd: c.end });
  });
  var out = {};
  groups.forEach(function (g) {
    var lanes = [];
    g.items.forEach(function (c) {
      var lane = 0;
      while (lanes[lane] !== undefined && lanes[lane] >= c.start) lane++;
      lanes[lane] = c.end;
      out[c.id] = { lane: lane };
    });
    var total = lanes.length;
    g.items.forEach(function (c) { out[c.id].total = total; });
  });
  return out;
}
function renderTimetable() {
  var w = state.displayWeek;
  ROW_H = window.innerWidth <= 560 ? 76 : 56;
  var dow = todayWeekday();
  var days = visibleDays();
  var ss = sections();
  var now = new Date();
  $('dateTitle').textContent = fmtDateCn(now);
  var meta = state.classes.meta || {};
  var mon = weekDate(w, 1), sun = weekDate(w, 7);
  var range = (mon.getMonth() + 1) + '/' + mon.getDate() + '–' + (sun.getMonth() + 1) + '/' + sun.getDate();
  $('dateSub').textContent = '第 ' + w + ' 周（' + range + '）· ' + (meta.school || '我的课表');
  $('weekPill').textContent = '第 ' + w + ' 周';

  /* 下一节课卡片 */
  var next = nextCourseInfo();
  var nc = $('nextCard');
  if (next) {
    var c = next.c;
    var t = next.state === 'ongoing' ? '正在上课' : (next.state === 'next' ? '下一节' : ('下节 · ' + WEEK_NAMES[next.dow - 1]));
    var right = next.state === 'ongoing' ? ('还剩 ' + next.diff + ' 分钟')
      : (next.state === 'next' ? (next.diff > 0 ? (next.diff + ' 分钟后') : '马上开始')
      : (next.daysAhead === 1 ? '明天' : (next.daysAhead + ' 天后')));
    nc.className = 'nextcard';
    nc.innerHTML = '<div><div class="nc-label">' + t + '</div><div class="nc-title">' + esc(c.name) + '</div>' +
      '<div class="nc-meta">' + esc(secRange(c.start, c.end)) + (c.room ? ' · ' + esc(c.room) : '') + '</div></div>' +
      '<div class="nc-count">' + right + '</div>';
    nc.onclick = function () { openCourseSheet(c.id); };
  } else {
    nc.className = 'nextcard empty';
    nc.innerHTML = '<div><div class="nc-label">' + (state.displayWeek === state.currentWeek ? '今天' : '第 ' + w + ' 周') + '</div>' +
      '<div class="nc-title" style="font-size:15px">' + (state.displayWeek === state.currentWeek ? '今天没有课了' : '查看第 ' + w + ' 周') + '</div></div>' +
      '<div class="nc-count" style="font-size:12px;opacity:.7">好好休息</div>';
    nc.onclick = null;
  }

  /* 表头 */
  var secW = window.innerWidth <= 560 ? 34 : 46;
  var dayMinW = window.innerWidth <= 560 ? 43 : 64;
  var cols = secW + 'px repeat(' + days.length + ', minmax(' + dayMinW + 'px, 1fr))';
  var html = '<div class="tt-head" style="grid-template-columns:' + cols + '">';
  html += '<div class="tt-hcell tt-corner"></div>';
  days.forEach(function (d) {
    var dt = weekDate(w, d);
    var isToday = w === state.currentWeek && d === dow;
    html += '<div class="tt-hcell' + (isToday ? ' today' : '') + '"><b>' + WEEK_NAMES[d - 1] + '</b><span>' + (dt.getMonth() + 1) + '/' + dt.getDate() + '</span></div>';
  });
  html += '</div>';

  /* 表体 */
  html += '<div class="tt-body" style="grid-template-columns:' + cols + ';height:' + (ss.length * ROW_H) + 'px">';
  html += '<div class="tt-times">';
  for (var i = 0; i < ss.length; i++) {
    html += '<div class="tt-time" style="top:' + (i * ROW_H) + 'px"><b>' + (i + 1) + '</b>' + esc(ss[i].start) + '</div>';
  }
  html += '</div>';
  days.forEach(function (d) {
    var isToday = w === state.currentWeek && d === dow;
    html += '<div class="tt-col' + (isToday ? ' today' : '') + '">';
    for (var k = 0; k < ss.length; k++) html += '<div class="tt-gridline" style="top:' + (k * ROW_H) + 'px"></div>';
    var dayCourses = state.classes.courses.filter(function (c) { return c.day === d && inWeek(c.weeks, w); });
    var lay = layoutDay(dayCourses);
    dayCourses.forEach(function (c) {
      var start = Math.max(1, Math.min(ss.length, c.start || 1));
      var end = Math.max(start, Math.min(ss.length, c.end || start));
      var top = (start - 1) * ROW_H + 2;
      var h = (end - start + 1) * ROW_H - 4;
      var bg = paletteOf(c);
      var short = h < ROW_H * 1.5;
      var info = lay[c.id] || { lane: 0, total: 1 };
      var wPct = 100 / Math.max(1, info.total);
      var lPct = info.lane * wPct;
      html += '<button class="course' + (short ? ' short' : '') + '" data-course="' + c.id + '" style="top:' + top + 'px;height:' + h + 'px;left:calc(' + lPct + '% + 2px);width:calc(' + wPct + '% - 4px);background:' + bg + ';color:' + fgOf(bg) + '">';
      var narrow = window.innerWidth <= 560;
      var s0t = ss[c.start - 1] ? ss[c.start - 1].start : '';
      var e0t = ss[c.end - 1] ? ss[c.end - 1].end : '';
      var timeTxt = narrow ? (s0t + '\n' + e0t) : secRange(c.start, c.end);
      // 按优先级折叠：名称 > 时间段（开始+结束） > 地点 > 教师；手机端空间不足时从低优先级开始隐藏
      var showRoom = !narrow || h >= ROW_H * 1.9;
      var showTeacher = !narrow || h >= ROW_H * 3.2;
      html += '<span class="c-name">' + esc(c.name) + '</span>';
      html += '<span class="c-time">' + esc(timeTxt) + '</span>';
      if (showRoom && c.room) html += '<span class="c-room">' + esc(c.room) + '</span>';
      if (showTeacher && c.teacher) html += '<span class="c-teacher">' + esc(c.teacher) + '</span>';
      html += '</button>';
    });
    if (isToday) {
      var t = nowTop();
      if (t != null) html += '<div class="tt-now" style="top:' + t + 'px"></div>';
    }
    html += '</div>';
  });
  html += '</div>';
  var box = $('timetable');
  box.innerHTML = html;
  if (location.search.indexOf('debug=1') >= 0) {
    try {
      var gs = document.querySelector('.gridscroll');
      var tt = document.querySelector('.timetable');
      var hd = document.querySelector('.tt-head');
      var old = document.getElementById('dbgbox'); if (old) old.remove();
      var dbg = document.createElement('div');
      dbg.id = 'dbgbox';
      dbg.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;background:#fff;color:#f00;font:11px monospace;padding:4px;white-space:pre';
      dbg.textContent = 'W' + window.innerWidth + ' dpr' + (window.devicePixelRatio || 1) + ' html' + document.documentElement.clientWidth + ' body' + document.body.offsetWidth + ' app' + document.querySelector('.app').offsetWidth + '\nview' + document.querySelector('.view:not(.hidden)').offsetWidth + ' gs' + gs.offsetWidth + ' tt' + tt.offsetWidth + ' hd' + hd.offsetWidth + '\ncols ' + hd.style.gridTemplateColumns + '\nscrollW ' + document.documentElement.scrollWidth + ' bodyScroll ' + document.body.scrollWidth;
      document.body.appendChild(dbg);
    } catch (e) {}
  }
  box.querySelectorAll('[data-course]').forEach(function (btn) {
    btn.addEventListener('click', function () { openCourseSheet(btn.dataset.course); });
  });
}
function nextCourseInfo() {
  var now = new Date();
  if (state.displayWeek !== state.currentWeek) return null;
  var dow = todayWeekday();
  var ss = sections();
  var mins = now.getHours() * 60 + now.getMinutes();
  var list = state.classes.courses.filter(function (c) {
    return c.day === dow && inWeek(c.weeks, state.currentWeek);
  }).sort(function (a, b) { return a.start - b.start; });
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var s = hhmmToMin(ss[c.start - 1] ? ss[c.start - 1].start : '00:00');
    var e = hhmmToMin(ss[c.end - 1] ? ss[c.end - 1].end : '00:00');
    if (mins >= s && mins <= e) return { c: c, state: 'ongoing', diff: Math.max(0, e - mins) };
    if (mins < s) return { c: c, state: 'next', diff: s - mins };
  }
  // 今天没课了：找本周后续天里最近的一节
  var rest = state.classes.courses.filter(function (x) {
    return x.day > dow && inWeek(x.weeks, state.currentWeek);
  }).sort(function (a, b) { return a.day - b.day || a.start - b.start; });
  if (rest.length) {
    return { c: rest[0], state: 'upcoming', dow: rest[0].day, daysAhead: rest[0].day - dow };
  }
  // 本周没课了：找下一周的最近一节
  var nextWeekCourses = state.classes.courses.filter(function (x) {
    return inWeek(x.weeks, state.currentWeek + 1);
  }).sort(function (a, b) { return a.day - b.day || a.start - b.start; });
  if (nextWeekCourses.length) {
    var c2 = nextWeekCourses[0];
    return { c: c2, state: 'upcoming', dow: c2.day, daysAhead: (7 - dow) + c2.day };
  }
  return null;
}

/* ---------------- 课程详情 ---------------- */
function openCourseSheet(id) {
  var c = state.classes.courses.find(function (x) { return x.id === id; });
  if (!c) return;
  var ss = sections();
  var s0 = ss[c.start - 1] || {}, s1 = ss[c.end - 1] || {};
  var count = state.sessions.filter(function (x) { return x.courseId === c.id; }).length;
  var html = '<h3>' + esc(c.name) + '</h3>';
  html += '<p class="sheet-sub">' + WEEK_NAMES[c.day - 1] + ' 第 ' + c.start + '-' + c.end + ' 节 · ' + esc(s0.start || '') + '–' + esc(s1.end || '') + '</p>';
  html += '<div class="card" style="box-shadow:none;background:var(--bg);margin-bottom:12px">';
  html += '<p class="muted">地点：' + esc(c.room || '待定') + '</p>';
  html += '<p class="muted">教师：' + esc(c.teacher || '待定') + '</p>';
  html += '<p class="muted">周次：' + esc(c.weeks || '全周') + '</p>';
  html += '<p class="muted">已有课堂笔记：' + count + ' 条</p>';
  html += '</div>';
  html += '<div class="sheet-actions">';
  html += '<button class="btn primary" data-action="start-course" data-id="' + c.id + '">开始上课</button>';
  html += '<button class="btn" data-action="close-sheet">关闭</button>';
  html += '</div>';
  openSheet(html);
}

/* ---------------- Sheet / Modal ---------------- */
function openSheet(html) {
  $('sheetBody').innerHTML = html;
  $('sheetMask').classList.remove('hidden');
  $('sheet').classList.remove('hidden');
  requestAnimationFrame(function () {
    $('sheetMask').classList.add('show');
    $('sheet').classList.add('show');
  });
}
function closeSheet() {
  $('sheetMask').classList.remove('show');
  $('sheet').classList.remove('show');
  setTimeout(function () {
    $('sheetMask').classList.add('hidden');
    $('sheet').classList.add('hidden');
  }, 260);
}
function openModal(name) {
  var el = $(name === 'finish' ? 'finishModal' : name);
  var mask = $(name === 'finish' ? 'finishMask' : name + 'Mask');
  if (!el) return;
  el.classList.remove('hidden');
  if (mask) mask.classList.remove('hidden');
  requestAnimationFrame(function () {
    el.classList.add('show');
    if (mask) mask.classList.add('show');
  });
}
function closeModal(name) {
  var el = $(name === 'finish' ? 'finishModal' : name);
  var mask = $(name === 'finish' ? 'finishMask' : name + 'Mask');
  if (!el) return;
  el.classList.remove('show');
  if (mask) mask.classList.remove('show');
  setTimeout(function () {
    el.classList.add('hidden');
    if (mask) mask.classList.add('hidden');
  }, 240);
}

/* ---------------- 课堂页 ---------------- */
function todayCourses() {
  var dow = todayWeekday();
  return state.classes.courses.filter(function (c) {
    return c.day === dow && inWeek(c.weeks, state.currentWeek);
  }).sort(function (a, b) { return a.start - b.start; });
}
function renderClassPage() {
  if (state.rec) return;
  var list = todayCourses();
  var sel = $('selCourse');
  var html = '';
  list.forEach(function (c) {
    var ss = sections();
    var t = (ss[c.start - 1] ? ss[c.start - 1].start : '') + '–' + (ss[c.end - 1] ? ss[c.end - 1].end : '');
    html += '<option value="' + c.id + '">' + esc(c.name) + (c.room ? ' · ' + esc(c.room) : '') + '（' + esc(t) + '）</option>';
  });
  if (!list.length) {
    state.classes.courses.forEach(function (c) { html += '<option value="' + c.id + '">' + esc(c.name) + '</option>'; });
  }
  sel.innerHTML = html;
  $('heroCourse').textContent = list.length ? '今天有 ' + list.length + ' 节课' : '今天课表没有课';
  $('heroTime').textContent = list.length ? '选择课程后点开始；下课记得保存笔记' : '可以从下拉里手动选一门课开始（临时补录）';
  var tl = $('todayList');
  if (!list.length) {
    tl.innerHTML = '<button class="item" id="todayEmptyAdd"><div class="item-main"><div class="item-title">今天没有排课</div><div class="item-sub">点这里去「我的 → 课表管理」添加课程</div></div><span class="item-badge">去课表管理</span></button>';
    var addBtn = $('todayEmptyAdd');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        switchView('me');
        // 切到「我的」后滚动到课表管理卡片（不弹出添加表单，避免唐突）
        setTimeout(function () {
          try {
            var cards = document.querySelectorAll('#view-me .card');
            var mgmt = cards.length ? cards[0] : null;
            if (mgmt) {
              var bar = document.querySelector('.topbar');
              var off = bar ? bar.offsetHeight + 12 : 76;
              var y = window.scrollY + mgmt.getBoundingClientRect().top - off;
              window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
            }
          } catch (e) {}
        }, 120);
      });
    }
    return;
  }
  tl.innerHTML = list.map(function (c) {
    var ss = sections();
    return '<button class="item" data-quick-start="' + c.id + '">' +
      '<div class="item-main"><div class="item-title">' + esc(c.name) + '</div>' +
      '<div class="item-sub">第 ' + c.start + '-' + c.end + ' 节 · ' + esc(ss[c.start - 1] ? ss[c.start - 1].start : '') + ' · ' + esc(c.room || '地点待定') + '</div></div>' +
      '<span class="item-badge">开始</span></button>';
  }).join('');
  tl.querySelectorAll('[data-quick-start]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      $('selCourse').value = btn.dataset.quickStart;
      startClass(btn.dataset.quickStart);
    });
  });
}
function setNoAudioMode() {
  var st = $('recState');
  if (st) { st.textContent = '无录音模式（麦克风不可用）'; st.classList.add('warn'); }
  var dot = document.querySelector('.rec-dot');
  if (dot) dot.classList.add('off');
  var hint = $('recHint');
  if (hint) hint.textContent = '麦克风不可用：仍可拍板书、写笔记；点「结束上课」保存这条课堂记录';
  var m = $('recMeta');
  if (m) m.textContent = '无录音 · 可拍照和笔记';
}
function updateRecMeta() {
  if (!state.rec) return;
  $('recMeta').textContent = '已录 ' + state.rec.segments + ' 段 · ' + state.rec.photos + ' 张板书 · ' + state.rec.markers + ' 个标记';
}
function resetClassUI() {
  $('classRec').classList.add('hidden');
  $('classIdle').classList.remove('hidden');
  $('recThumbs').innerHTML = '';
  $('recTimer').textContent = '00:00';
  var st = $('recState');
  if (st) { st.textContent = '正在上课'; st.classList.remove('warn'); }
  var dot = document.querySelector('.rec-dot');
  if (dot) dot.classList.remove('off');
  var hint = $('recHint');
  if (hint) hint.textContent = '保持页面在前台；锁屏或切后台可能中断录音（第一版限制）';
}
function startTicker() {
  clearInterval(state.rec.timer);
  state.rec.timer = setInterval(function () {
    if (!state.rec) return;
    $('recTimer').textContent = fmtClock(Date.now() - state.rec.startedAt);
  }, 500);
}

/* ---------------- 录音防丢（IndexedDB 暂存，页面崩溃/断网可补传） ---------------- */
var chunkDB = null;
function openChunkDB() {
  return new Promise(function (resolve) {
    if (!window.indexedDB) { resolve(null); return; }
    var req = indexedDB.open('classroom-chunks', 1);
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'key' });
    };
    req.onsuccess = function () { chunkDB = req.result; resolve(chunkDB); };
    req.onerror = function () { resolve(null); };
  });
}
function savePendingChunk(item) {
  return openChunkDB().then(function (db) {
    if (!db) return;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction('chunks', 'readwrite');
        tx.objectStore('chunks').put(item);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      } catch (e) { resolve(); }
    });
  });
}
function deletePendingChunk(key) {
  return openChunkDB().then(function (db) {
    if (!db) return;
    try {
      var tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').delete(key);
    } catch (e) {}
  });
}
function listPendingChunks() {
  return openChunkDB().then(function (db) {
    if (!db) return [];
    return new Promise(function (resolve) {
      try {
        var out = [];
        var tx = db.transaction('chunks', 'readonly');
        var req = tx.objectStore('chunks').openCursor();
        req.onsuccess = function (e) {
          var cur = e.target.result;
          if (cur) { out.push(cur.value); cur.continue(); } else { resolve(out); }
        };
        req.onerror = function () { resolve([]); };
      } catch (e) { resolve([]); }
    });
  });
}
function checkInstallHint() {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (window.innerWidth > 900) return;
    if (localStorage.getItem('kb-install-hint') === '1') return;
    localStorage.setItem('kb-install-hint', '1');
    setTimeout(function () { toast('手机浏览器菜单可「添加到主屏幕」，用起来像 APP'); }, 2500);
  } catch (e) {}
}
function checkRecovery() {
  Promise.all([listPendingChunks(), Promise.resolve(state.sessions || [])]).then(function (res) {
    var chunks = res[0] || [];
    var recs = (res[1] || []).filter(function (s) { return s.status === 'recording'; });
    if (!chunks.length && !recs.length) return;
    var html = '<h3>发现需要处理的记录</h3><p class="sheet-sub">上次退出时可能有未完成的操作，数据都还在本机</p>';
    recs.forEach(function (s) {
      html += '<div class="item"><div class="item-main"><div class="item-title">未结束的课堂：' + esc(s.courseName) + '</div>' +
        '<div class="item-sub">' + fmtDateTime(s.startedAt) + ' · 已录 ' + (s.segments || []).length + ' 段 · ' + (s.photos || []).length + ' 张板书</div></div></div>';
      html += '<div class="sheet-actions" style="margin-top:6px"><button class="btn primary tiny" data-action="resume-finish" data-sid="' + s.id + '">结束并写笔记</button>' +
        '<button class="btn tiny" data-action="resume-del" data-sid="' + s.id + '">删除</button></div>';
    });
    if (chunks.length) {
      html += '<div class="item" style="margin-top:8px"><div class="item-main"><div class="item-title">未上传的录音段 ' + chunks.length + ' 个</div>' +
        '<div class="item-sub">' + chunks.map(function (c) { return esc(c.name); }).join('、') + '</div></div></div>';
      html += '<div class="sheet-actions" style="margin-top:6px"><button class="btn primary tiny" data-action="resume-chunks">全部补传</button>' +
        '<button class="btn tiny" data-action="discard-chunks">丢弃</button></div>';
    }
    html += '<div class="sheet-actions"><button class="btn" data-action="close-sheet">稍后处理</button></div>';
    openSheet(html);
  });
}
function checkPendingChunks() {
  listPendingChunks().then(function (list) {
    if (!list.length) return;
    var html = '<h3>发现未上传的录音段</h3><p class="sheet-sub">上次录音时网络中断或页面被关闭，这些段还在本机，可以补传</p>';
    html += '<div class="list">';
    list.forEach(function (it) {
      html += '<div class="item"><div class="item-main"><div class="item-title">' + esc(it.name) + '</div>' +
        '<div class="item-sub">会话 ' + esc(it.sid) + ' · ' + fmtDateTime(it.at || Date.now()) + '</div></div></div>';
    });
    html += '</div>';
    html += '<div class="sheet-actions"><button class="btn primary" data-action="resume-chunks">全部补传</button><button class="btn" data-action="discard-chunks">丢弃</button></div>';
    openSheet(html);
  });
}
function resumeChunks() {
  listPendingChunks().then(function (list) {
    var i = 0;
    function next() {
      if (i >= list.length) { closeSheet(); toast('补传完成'); return; }
      var it = list[i++];
      uploadWithRetry(it.sid, it.name, it.offsetMs || 0, it.blob, 3).then(function (ok) {
        return ok ? deletePendingChunk(it.key) : null;
      }).then(next).catch(next);
    }
    next();
  });
}
function discardChunks() {
  listPendingChunks().then(function (list) {
    Promise.all(list.map(function (it) { return deletePendingChunk(it.key); })).then(function () {
      closeSheet(); toast('已丢弃未上传段');
    });
  });
}

/* ---------------- 录音/网络保护 ---------------- */
function requestWakeLock() {
  if (!('wakeLock' in navigator) || !navigator.wakeLock) return;
  try {
    navigator.wakeLock.request('screen').then(function (lock) {
      state.wakeLock = lock;
      lock.addEventListener('release', function () { state.wakeLock = null; });
    }).catch(function () {});
  } catch (e) {}
}
function releaseWakeLock() {
  try { if (state.wakeLock) state.wakeLock.release(); } catch (e) {}
  state.wakeLock = null;
}
function uploadWithRetry(sid, name, offset, blob, tries) {
  var total = tries || 3;
  var i = 0;
  var key = sid + '/' + name;
  // 先落 IndexedDB：页面崩溃/断网也不丢段
  savePendingChunk({ key: key, sid: sid, name: name, offsetMs: offset, blob: blob, at: Date.now() });
  function attempt() {
    return fetch('/api/sessions/' + sid + '/chunk?name=' + encodeURIComponent(name) + '&offsetMs=' + offset, { method: 'POST', headers: appTokenHeaders(), body: blob })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        deletePendingChunk(key);
        return true;
      })
      .catch(function (err) {
        i++;
        if (i >= total) {
          toast('录音段上传失败：' + name + '（已暂存本机，稍后可补传）');
          return false;
        }
        return new Promise(function (r) { setTimeout(r, 700 * i); }).then(attempt);
      });
  }
  return attempt();
}

/* ---------------- 录音音量指示 ---------------- */
var audioMeter = { ctx: null, analyser: null, data: null, raf: null };
function startAudioMeter(stream) {
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !stream) return;
    audioMeter.ctx = new Ctx();
    var src = audioMeter.ctx.createMediaStreamSource(stream);
    audioMeter.analyser = audioMeter.ctx.createAnalyser();
    audioMeter.analyser.fftSize = 256;
    src.connect(audioMeter.analyser);
    audioMeter.data = new Uint8Array(audioMeter.analyser.frequencyBinCount);
    var fill = $('recMeter');
    var tick = function () {
      if (!audioMeter.analyser) return;
      audioMeter.analyser.getByteTimeDomainData(audioMeter.data);
      var sum = 0;
      for (var i = 0; i < audioMeter.data.length; i++) {
        var v = (audioMeter.data[i] - 128) / 128;
        sum += v * v;
      }
      var rms = Math.sqrt(sum / audioMeter.data.length);
      var pct = Math.min(100, Math.round(rms * 320));
      if (fill) fill.style.width = pct + '%';
      audioMeter.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {}
}
function stopAudioMeter() {
  if (audioMeter.raf) cancelAnimationFrame(audioMeter.raf);
  try { if (audioMeter.ctx) audioMeter.ctx.close(); } catch (e) {}
  audioMeter = { ctx: null, analyser: null, data: null, raf: null };
  var fill = $('recMeter');
  if (fill) fill.style.width = '0%';
}

/* ---------------- 录音 ---------------- */
function pickMime() {
  if (!window.MediaRecorder) return '';
  var list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (var i = 0; i < list.length; i++) {
    try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) {}
  }
  return '';
}
function startSegment() {
  if (!state.rec || !state.rec.recording || !state.rec.stream) return;
  var rec = state.rec;
  var idx = rec.segIndex++;
  var offset = Date.now() - rec.startedAt;
  var chunks = [];
  var mr;
  try { mr = rec.mime ? new MediaRecorder(rec.stream, { mimeType: rec.mime }) : new MediaRecorder(rec.stream); }
  catch (e) { toast('录音初始化失败：' + e.message); return; }
  rec.recorder = mr;
  mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = function () {
    var type = mr.mimeType || 'audio/webm';
    var blob = new Blob(chunks, { type: type });
    var name = 'seg-' + String(idx).padStart(3, '0') + '.' + (type.indexOf('mp4') >= 0 ? 'm4a' : 'webm');
    uploadSegment(blob, name, offset);
    if (state.rec && state.rec.recording) startSegment();
  };
  mr.start();
  rec.chunkTimer = setTimeout(function () { try { mr.stop(); } catch (e) {} }, SEG_MS);
}
function uploadSegment(blob, name, offset) {
  if (!state.rec) return Promise.resolve();
  var sid = state.rec.sid;
  state.rec.segments++;
  updateRecMeta();
  var p = uploadWithRetry(sid, name, offset, blob, 3);
  state.rec.lastUpload = p;
  return p;
}
function startClass(courseId) {
  var course = state.classes.courses.find(function (c) { return c.id === courseId; });
  if (!course) { toast('课程不存在'); return; }
  if (state.rec) { toast('已在上课中'); return; }
  api('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId: course.id, courseName: course.name, teacher: course.teacher, room: course.room, startedAt: Date.now() })
  }).then(function (j) {
    var s = j.session;
    state.rec = { sid: s.id, course: course, startedAt: s.startedAt, recording: true, segIndex: 0, segments: 0, photos: 0, markers: 0, stream: null, recorder: null, mime: '', chunkTimer: null, lastUpload: Promise.resolve(), timer: null };
    switchView('class');
    $('classIdle').classList.add('hidden');
    $('classRec').classList.remove('hidden');
    $('recCourse').textContent = course.name + (course.room ? ' · ' + course.room : '');
    updateRecMeta();
    startTicker();
    requestWakeLock();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('当前浏览器不支持录音；仍可拍照和写笔记');
      setNoAudioMode();
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }).then(function (stream) {
      if (!state.rec) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      state.rec.stream = stream;
      state.rec.mime = pickMime();
      startAudioMeter(stream);
      startSegment();
    }).catch(function (e) {
      toast('麦克风不可用（' + e.message + '），已进入无录音模式');
      setNoAudioMode();
    });
  }).catch(function (e) { toast('开始上课失败：' + e.message); });
}
function stopClass() {
  if (!state.rec) return;
  var rec = state.rec;
  rec.recording = false;
  clearTimeout(rec.chunkTimer);
  if (rec.recorder && rec.recorder.state !== 'inactive') {
    try { rec.recorder.stop(); } catch (e) {}
  }
  var endedAt = Date.now();
  var durationMs = endedAt - rec.startedAt;
  Promise.resolve(rec.lastUpload).catch(function () {}).then(function () {
    return new Promise(function (r) { setTimeout(r, 350); });
  }).then(function () {
    return api('/api/sessions/' + rec.sid + '/finish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endedAt: endedAt, durationMs: durationMs, note: '' })
    });
  }).then(function () {
    if (rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); });
    stopAudioMeter();
    clearInterval(rec.timer);
    releaseWakeLock();
    state.finishSid = rec.sid;
    $('finishMeta').textContent = '时长 ' + fmtDur(durationMs) + ' · 照片 ' + rec.photos + ' 张 · 标记 ' + rec.markers + ' 个';
    openModal('finish');
  }).catch(function (e) { toast('结束上课失败：' + e.message); });
}
function saveFinish() {
  var note = $('finishNote').value.trim();
  var sid = state.finishSid;
  var done = function () {
    closeModal('finish');
    $('finishNote').value = '';
    state.rec = null;
    state.finishSid = null;
    releaseWakeLock();
    resetClassUI();
    loadSessions().then(function () { switchView('notes'); toast('笔记已保存'); });
  };
  if (!sid) { done(); return; }
  api('/api/sessions/' + sid + '/note', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note })
  }).then(done).catch(function (e) { toast('保存失败：' + e.message); });
}

/* ---------------- 拍照 / 标记 ---------------- */
function compressImage(file, maxSide, quality) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      var scale = Math.min(1, maxSide / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      cv.toBlob(function (b) { URL.revokeObjectURL(url); b ? resolve(b) : reject(new Error('压缩失败')); }, 'image/jpeg', quality);
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}
function onPhotoPicked() {
  var input = $('photoInput');
  var f = input.files && input.files[0];
  input.value = '';
  if (!f || !state.rec) return;
  compressImage(f, 1600, 0.82).then(function (blob) {
    var rec = state.rec;
    var name = 'photo-' + String(rec.photos + 1).padStart(2, '0') + '-' + Date.now() + '.jpg';
    var offset = Date.now() - rec.startedAt;
    return fetch('/api/sessions/' + rec.sid + '/photo?name=' + encodeURIComponent(name) + '&offsetMs=' + offset, { method: 'POST', headers: appTokenHeaders(), body: blob }).then(function () {
      rec.photos++;
      updateRecMeta();
      var img = document.createElement('img');
      img.src = URL.createObjectURL(blob);
      $('recThumbs').prepend(img);
      toast('板书已保存');
    });
  }).catch(function (e) { toast('拍照失败：' + e.message); });
}
function addMarker() {
  if (!state.rec) return;
  var offset = Date.now() - state.rec.startedAt;
  fetch('/api/sessions/' + state.rec.sid + '/marker', {
    method: 'POST', headers: appTokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ offsetMs: offset, type: '重点', note: '' })
  }).then(function () {
    state.rec.markers++; updateRecMeta(); toast('已标记重点');
  }).catch(function () { toast('标记失败'); });
}

/* ---------------- 笔记页 ---------------- */
/* ---- 笔记页数据：课程夹 + 自定义笔记 ---- */
var NOTE_META_KEY = 'kb-note-meta';
function noteMeta() {
  try {
    var m = JSON.parse(localStorage.getItem(NOTE_META_KEY) || 'null');
    if (m && Array.isArray(m.folders)) {
      if (!m.assignments || typeof m.assignments !== 'object') m.assignments = {};
      if (!Array.isArray(m.customNotes)) m.customNotes = [];
      return m;
    }
  } catch (e) {}
  return { folders: [], assignments: {}, customNotes: [] };
}
function saveNoteMeta(m) { try { localStorage.setItem(NOTE_META_KEY, JSON.stringify(m)); } catch (e) {} }
// 自动课程夹：同一课程名的课堂笔记超过 2 条时，自动创建同名课程夹并归入（只归入尚未分类的记录，尊重用户手动调整）
function autoFolders() {
  var m = noteMeta();
  var changed = false;
  var all = (state.sessions || []).filter(function (s) { return s.status === 'done' || s.status === 'recording'; });
  var byCourse = {};
  all.forEach(function (s) {
    var n = s.courseName || '未选课';
    (byCourse[n] = byCourse[n] || []).push(s);
  });
  Object.keys(byCourse).forEach(function (name) {
    var list = byCourse[name];
    if (list.length <= 2) return;
    var fid = '';
    var exist = m.folders.find(function (f) { return f.name === name; });
    if (exist) {
      fid = exist.id;
    } else {
      fid = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      m.folders.push({ id: fid, name: name, createdAt: Date.now(), auto: true });
      changed = true;
    }
    list.forEach(function (s) {
      var k = 's:' + s.id;
      if (!m.assignments[k]) { m.assignments[k] = fid; changed = true; }
    });
  });
  if (changed) saveNoteMeta(m);
  return m;
}
function folderName(id) { var f = noteMeta().folders.find(function (x) { return x.id === id; }); return f ? f.name : ''; }
function noteSel() {
  if (!state.noteSelect) state.noteSelect = { active: false, ids: {} };
  return state.noteSelect;
}
function noteSelCount() { return Object.keys(noteSel().ids).length; }
function noteSelBegin(id) {
  state.noteSelect = { active: true, ids: {} };
  if (id) state.noteSelect.ids[id] = true;
  renderNotes();
  toast('已进入批量选择');
}
function noteSelToggle(id) {
  var s = noteSel();
  if (s.ids[id]) delete s.ids[id]; else s.ids[id] = true;
  renderNotes();
}
function noteSelExit() { state.noteSelect = { active: false, ids: {} }; renderNotes(); }
function notedIdsInList() {
  return Array.prototype.map.call(document.querySelectorAll('#notesList [data-note-item]'), function (el) { return el.getAttribute('data-note-item'); });
}
function noteSelAll() {
  var s = noteSel();
  notedIdsInList().forEach(function (id) { s.ids[id] = true; });
  renderNotes();
}
function noteSelInvert() {
  var s = noteSel(), next = {};
  notedIdsInList().forEach(function (id) { if (!s.ids[id]) next[id] = true; });
  s.ids = next;
  renderNotes();
}
function noteMoveToFolder() {
  var ids = Object.keys(noteSel().ids);
  if (!ids.length) { toast('先选择笔记'); return; }
  var m = noteMeta();
  var opts = m.folders.map(function (f) { return '<option value="' + f.id + '">' + esc(f.name) + '</option>'; }).join('');
  var html = '<h3>移到课程夹</h3><p class="sheet-sub">已选 ' + ids.length + ' 项</p>';
  if (!m.folders.length) html += '<p class="muted" style="margin-bottom:8px">还没有课程夹，可以先取消去创建</p>';
  html += '<div class="field">课程夹<select id="mvFolder"><option value="">不归入任何夹</option>' + opts + '</select></div>';
  html += '<div class="sheet-actions"><button class="btn primary" id="btnMvOk">确定</button><button class="btn" data-action="close-sheet">取消</button></div>';
  openSheet(html);
  $('btnMvOk').addEventListener('click', function () {
    var fid = $('mvFolder').value || '';
    var m2 = noteMeta();
    ids.forEach(function (id) {
      if (id.indexOf('s:') === 0) {
        if (fid) m2.assignments[id] = fid; else delete m2.assignments[id];
      } else {
        var n = m2.customNotes.find(function (x) { return 'n:' + x.id === id; });
        if (n) n.folderId = fid;
      }
    });
    saveNoteMeta(m2);
    closeSheet(); noteSelExit(); toast('已移动到课程夹');
  });
}
function noteSelDelete() {
  var ids = Object.keys(noteSel().ids);
  if (!ids.length) { toast('先选择笔记'); return; }
  var sids = ids.filter(function (id) { return id.indexOf('s:') === 0; }).map(function (id) { return id.slice(2); });
  var nids = ids.filter(function (id) { return id.indexOf('n:') === 0; }).map(function (id) { return id.slice(2); });
  if (!confirm('删除已选 ' + ids.length + ' 项？' + (sids.length ? '（含 ' + sids.length + ' 条课堂记录，不可恢复）' : ''))) return;
  var m = noteMeta();
  if (nids.length) { m.customNotes = m.customNotes.filter(function (n) { return nids.indexOf(n.id) < 0; }); saveNoteMeta(m); }
  function done() {
    state.sessions = (state.sessions || []).filter(function (s) { return sids.indexOf(s.id) < 0; });
    noteSelExit(); toast('已删除');
    try { renderClassPage(); } catch (e) {}
  }
  if (!sids.length) { done(); return; }
  Promise.all(sids.map(function (sid) {
    return api('/api/sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid }) }).catch(function () {});
  })).then(done);
}
function bindNoteSlideSelect() {
  var box = $('notesList');
  if (!box || box.dataset.slideBound) return;
  box.dataset.slideBound = '1';
  var down = false, lastEl = null;
  box.addEventListener('touchstart', function () { down = true; }, { passive: true });
  box.addEventListener('touchend', function () { down = false; lastEl = null; }, { passive: true });
  box.addEventListener('touchmove', function (e) {
    var s = noteSel();
    if (!s.active || !down) return;
    var t = e.touches && e.touches[0];
    if (!t) return;
    var el = document.elementFromPoint(t.clientX, t.clientY);
    var item = el && el.closest ? el.closest('[data-note-item]') : null;
    if (!item || item === lastEl) return;
    lastEl = item;
    var id = item.getAttribute('data-note-item');
    if (!s.ids[id]) {
      s.ids[id] = true;
      item.classList.add('note-selected');
      var cnt = $('noteSelCount');
      if (cnt) cnt.textContent = '已选 ' + noteSelCount() + ' 项';
    }
  }, { passive: true });
}
function openAddNoteMenu() {
  var html = '<h3>添加到笔记</h3><p class="sheet-sub">新建课程夹，或写一条自己的笔记</p>';
  html += '<div class="sheet-actions" style="flex-direction:column;gap:10px">';
  html += '<button class="btn primary" id="btnNewFolder" style="width:100%">新建课程夹</button>';
  html += '<button class="btn primary" id="btnNewNote" style="width:100%">新建笔记</button>';
  html += '<button class="btn" data-action="close-sheet" style="width:100%">取消</button></div>';
  openSheet(html);
  $('btnNewFolder').addEventListener('click', openFolderForm);
  $('btnNewNote').addEventListener('click', openNoteForm);
}
function openFolderForm() {
  var html = '<h3>新建课程夹</h3><p class="sheet-sub">给笔记分组，比如「高数」「英语」</p>';
  html += '<div class="field">名称<input id="nfName" placeholder="如 高等数学" maxlength="20"></div>';
  html += '<div class="sheet-actions"><button class="btn primary" id="btnNfSave">创建</button><button class="btn" data-action="close-sheet">取消</button></div>';
  openSheet(html);
  setTimeout(function () { var el = $('nfName'); if (el) el.focus(); }, 80);
  $('btnNfSave').addEventListener('click', function () {
    var name = ($('nfName').value || '').trim();
    if (!name) { toast('请输入名称'); return; }
    var m = noteMeta();
    m.folders.push({ id: 'f' + Date.now().toString(36), name: name, createdAt: Date.now() });
    saveNoteMeta(m);
    closeSheet(); renderNotes(); toast('已创建课程夹');
  });
}
function openNoteForm() {
  var m = noteMeta();
  var opts = m.folders.map(function (f) { return '<option value="' + f.id + '">' + esc(f.name) + '</option>'; }).join('');
  var html = '<h3>新建笔记</h3><p class="sheet-sub">写一条自己的笔记，可归入课程夹</p>';
  html += '<div class="field">标题<input id="nnTitle" placeholder="如 高数第 3 章要点" maxlength="40"></div>';
  html += '<div class="field">内容<textarea id="nnContent" rows="5" placeholder="记录你的笔记…"></textarea></div>';
  html += '<div class="field">课程夹<select id="nnFolder"><option value="">不归入</option>' + opts + '</select></div>';
  html += '<div class="sheet-actions"><button class="btn primary" id="btnNnSave">保存</button><button class="btn" data-action="close-sheet">取消</button></div>';
  openSheet(html);
  $('btnNnSave').addEventListener('click', function () {
    var title = ($('nnTitle').value || '').trim();
    var content = ($('nnContent').value || '').trim();
    if (!title && !content) { toast('写点内容吧'); return; }
    var m2 = noteMeta();
    m2.customNotes.push({ id: 'n' + Date.now().toString(36), title: title || '未命名笔记', content: content, folderId: $('nnFolder').value || '', createdAt: Date.now() });
    saveNoteMeta(m2);
    closeSheet(); renderNotes(); toast('笔记已保存');
  });
}
function openCustomNote(id) {
  var n = noteMeta().customNotes.find(function (x) { return x.id === id; });
  if (!n) return;
  var html = '<div class="note-detail"><h3>' + esc(n.title || '未命名笔记') + '</h3>';
  html += '<p class="nd-meta">笔记 · ' + fmtDateTime(n.createdAt) + (n.folderId ? ' · ' + esc(folderName(n.folderId)) : '') + '</p>';
  html += '<div class="nd-note" style="white-space:pre-wrap">' + esc(n.content || '') + '</div>';
  html += '<div class="sheet-actions"><button class="btn tiny" data-action="custom-note-edit" data-nid="' + n.id + '">编辑</button>' +
    '<button class="btn tiny" style="color:var(--danger)" data-action="custom-note-del" data-nid="' + n.id + '">删除</button></div></div>';
  openSheet(html);
}
function editCustomNote(id) {
  var m = noteMeta();
  var n = m.customNotes.find(function (x) { return x.id === id; });
  if (!n) return;
  var opts = m.folders.map(function (f) { return '<option value="' + f.id + '"' + (n.folderId === f.id ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('');
  var html = '<h3>编辑笔记</h3>';
  html += '<div class="field">标题<input id="nnTitle" value="' + esc(n.title || '') + '" maxlength="40"></div>';
  html += '<div class="field">内容<textarea id="nnContent" rows="6">' + esc(n.content || '') + '</textarea></div>';
  html += '<div class="field">课程夹<select id="nnFolder"><option value="">不归入</option>' + opts + '</select></div>';
  html += '<div class="sheet-actions"><button class="btn primary" id="btnNnSave">保存</button><button class="btn" data-action="close-sheet">取消</button></div>';
  openSheet(html);
  $('btnNnSave').addEventListener('click', function () {
    var m2 = noteMeta();
    var n2 = m2.customNotes.find(function (x) { return x.id === id; });
    if (!n2) return;
    n2.title = ($('nnTitle').value || '').trim() || '未命名笔记';
    n2.content = $('nnContent').value || '';
    n2.folderId = $('nnFolder').value || '';
    saveNoteMeta(m2); closeSheet(); renderNotes(); toast('已保存');
  });
}
function deleteCustomNote(id) {
  if (!confirm('删除这条笔记？')) return;
  var m = noteMeta();
  m.customNotes = m.customNotes.filter(function (n) { return n.id !== id; });
  saveNoteMeta(m); closeSheet(); renderNotes(); toast('已删除');
}
function renderNotes() {
  var all = (state.sessions || []).filter(function (s) { return s.status === 'done' || s.status === 'recording'; });
  var meta = autoFolders();
  var filter = state.noteFilter || '';
  if (filter.indexOf('f:') === 0 && !meta.folders.some(function (f) { return f.id === filter.slice(2); })) { filter = ''; state.noteFilter = ''; }
  if (filter && filter.indexOf('f:') !== 0) { filter = ''; state.noteFilter = ''; }
  var q = (state.noteQuery || '').trim().toLowerCase();
  var items = [];
  all.forEach(function (s) {
    var id = 's:' + s.id;
    items.push({ id: id, kind: 'session', s: s, time: s.startedAt || 0, folderId: meta.assignments[id] || '' });
  });
  meta.customNotes.forEach(function (n) {
    var id = 'n:' + n.id;
    items.push({ id: id, kind: 'note', n: n, time: n.createdAt || 0, folderId: n.folderId || '' });
  });
  var list = items.filter(function (it) {
    if (filter.indexOf('f:') === 0 && it.folderId !== filter.slice(2)) return false;
    if (!q) return true;
    var hay = it.kind === 'session'
      ? (it.s.courseName + ' ' + (it.s.note || '') + ' ' + ((it.s.transcript && it.s.transcript.text) || ''))
      : ((it.n.title || '') + ' ' + (it.n.content || ''));
    return hay.toLowerCase().indexOf(q) >= 0;
  });
  list.sort(function (a, b) { return b.time - a.time; });
  var chips = $('noteChips');
  if (chips) {
    var ch = '<button class="chip' + (!filter ? ' active' : '') + '" data-chip="">全部</button>';
    meta.folders.forEach(function (f) {
      ch += '<button class="chip' + (filter === 'f:' + f.id ? ' active' : '') + '" data-chip="f:' + f.id + '">' + esc(f.name) + '</button>';
    });
    chips.innerHTML = ch;
    chips.querySelectorAll('[data-chip]').forEach(function (b) {
      b.addEventListener('click', function () { state.noteFilter = b.dataset.chip || ''; renderNotes(); });
    });
  }
  var sel = noteSel();
  $('notesCount').textContent = list.length
    ? ('共 ' + list.length + ' 条记录' + (q ? '（搜索：' + state.noteQuery.trim() + '）' : '') + (sel.active ? ' · 批量选择中' : ''))
    : (q ? '没有匹配的记录' : (filter ? '这个课程夹还没有内容' : '暂无记录，去「课堂」开始第一节课'));
  var box = $('notesList');
  if (!list.length) {
    box.innerHTML = '<div class="item"><div class="item-main"><div class="item-title">暂无笔记</div><div class="item-sub">点右上角 + 新建笔记或课程夹；也可以去「课堂」开始第一节课</div></div></div>';
  } else {
    box.innerHTML = list.map(function (it) {
      var selected = !!sel.ids[it.id];
      var check = sel.active ? '<span class="note-check">✓</span>' : '';
      var folderTag = it.folderId ? ' · ' + esc(folderName(it.folderId)) : '';
      if (it.kind === 'note') {
        var n = it.n;
        return '<button class="item note-item' + (selected ? ' note-selected' : '') + '" data-note-item="' + it.id + '">' + check +
          '<span class="dot" style="background:var(--brand)"></span>' +
          '<div class="item-main"><div class="item-title">' + esc(n.title || '未命名笔记') + '</div>' +
          '<div class="item-sub">笔记 · ' + fmtDateTime(n.createdAt) + folderTag + '</div>' +
          (n.content ? '<div class="item-note">' + esc(n.content) + '</div>' : '') +
          '</div><span class="item-arrow">›</span></button>';
      }
      var s = it.s;
      var sub = fmtDateTime(s.startedAt) + ' · ' + fmtDur(s.durationMs || 0) + ' · ' + (s.photos ? s.photos.length + ' 张板书' : '无板书') + folderTag;
      return '<button class="item note-item' + (selected ? ' note-selected' : '') + '" data-note-item="' + it.id + '">' + check +
        '<div class="item-main"><div class="item-title">' + esc(s.courseName) + '</div>' +
        '<div class="item-sub">' + sub + '</div>' +
        (s.note ? '<div class="item-note">' + esc(s.note) + '</div>' : '') +
        '</div><span class="item-arrow">›</span></button>';
    }).join('');
    box.querySelectorAll('[data-note-item]').forEach(function (btn) {
      var id = btn.getAttribute('data-note-item');
      var lpTimer = null;
      function startLP() {
        cancelLP();
        lpTimer = setTimeout(function () {
          lpTimer = null;
          if (!noteSel().active) noteSelBegin(id);
        }, 450);
      }
      function cancelLP() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }
      btn.addEventListener('touchstart', startLP, { passive: true });
      btn.addEventListener('mousedown', startLP);
      btn.addEventListener('touchmove', cancelLP, { passive: true });
      btn.addEventListener('touchend', cancelLP);
      btn.addEventListener('mouseup', cancelLP);
      btn.addEventListener('mouseleave', cancelLP);
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        cancelLP();
        if (noteSel().active) { if (!btn.dataset.suppressClick) noteSelToggle(id); return; }
        if (id.indexOf('s:') === 0) openNoteSheet(id.slice(2));
        else openCustomNote(id.slice(2));
      });
    });
  }
  var selBar = $('noteSelectBar');
  var actBar = $('noteActionBar');
  if (selBar) selBar.classList.toggle('hidden', !sel.active);
  if (actBar) actBar.classList.toggle('hidden', !sel.active);
  var cnt = $('noteSelCount');
  if (cnt) cnt.textContent = '已选 ' + noteSelCount() + ' 项';
  bindNoteSlideSelect();
}
function openNoteSheet(sid) {
  var s = state.sessions.find(function (x) { return x.id === sid; });
  if (!s) return;
  var html = '<div class="note-detail"><h3>' + esc(s.courseName) + '</h3>';
  html += '<p class="nd-meta">' + fmtDateTime(s.startedAt) + ' · 时长 ' + fmtDur(s.durationMs || 0) + (s.room ? ' · ' + esc(s.room) : '') + '</p>';
  html += '<div class="sheet-actions" style="margin-top:10px">';
  html += '<button class="btn tiny primary" data-action="open-source" data-sid="' + s.id + '">原始素材</button>';
  html += '<button class="btn tiny" data-action="open-course" data-course="' + esc(s.courseName) + '">课程总纲</button>';
  html += '</div>';
  if ((s.segments || []).length) {
    html += '<div class="nd-section">录音（' + s.segments.length + ' 段）</div>';
    s.segments.forEach(function (seg) {
      html += '<audio controls preload="none" src="/api/media/' + s.id + '/rec/' + encodeURIComponent(seg.name) + '"></audio>';
    });
  }
  var tr = s.transcript;
  if (tr && tr.text) {
    var pol = tr.polished && tr.polished.text;
    var showPol = state.showPolished && state.showPolished[s.id] === false ? false : !!pol;
    html += '<div class="nd-section">文字稿（' + esc(tr.model || '') + (tr.tookMs ? ' · ' + Math.round(tr.tookMs / 1000) + 's' : '') + '）</div>';
    if (showPol) {
      html += '<div class="nd-note" id="trBox">' + esc(pol) + '</div>';
      html += '<p class="muted" style="margin:4px 0 0">这是 AI 校对版（修正了识别错别字）；<a href="javascript:void(0)" data-action="toggle-raw" data-sid="' + s.id + '" style="color:var(--brand)">查看原始转写</a></p>';
    } else {
      html += '<div class="nd-note" id="trBox">' + esc(tr.text) + '</div>';
      if (pol) html += '<p class="muted" style="margin:4px 0 0"><a href="javascript:void(0)" data-action="toggle-raw" data-sid="' + s.id + '" style="color:var(--brand)">查看 AI 校对版</a></p>';
    }
    html += '<div class="sheet-actions" style="margin-top:8px">';
    html += '<button class="btn tiny primary" data-action="polish-text" data-sid="' + s.id + '">' + (pol ? '重新 AI 校对' : 'AI 校对（修错别字）') + '</button>';
    html += '<button class="btn tiny" data-action="transcript-edit" data-sid="' + s.id + '">编辑文字稿</button>';
    html += '<button class="btn tiny" data-action="export-md" data-sid="' + s.id + '">导出 Markdown</button>';
    html += '</div>';
  } else if (s.transcriptStatus === 'running') {
    html += '<div class="nd-section">文字稿</div><div id="trBox" class="nd-note nd-empty">转写进行中…（后台处理，可以关闭页面，稍后回来看）</div>';
    setTimeout(function () { pollTranscript(s.id); }, 400);
  } else if ((s.segments || []).length) {
    html += '<div class="nd-section">文字稿</div><div id="trBox" class="nd-note nd-empty">还没有转写</div>';
    if (s.transcriptError) html += '<p class="muted" style="color:var(--danger);margin:6px 0">上次转写失败：' + esc(s.transcriptError) + '</p>';
    html += '<div class="sheet-actions" style="margin-top:8px">';
    html += '<button class="btn" data-action="transcribe" data-sid="' + s.id + '">直接转文字</button>';
    html += '<button class="btn primary" data-action="transcribe-ai" data-sid="' + s.id + '"' + (aiReady() ? '' : ' disabled title="先在「我的 → AI 设置」接入 AI"') + '>AI 辅助转文字</button>';
    html += '</div>';
  }
  if (s.aiNote && s.aiNote.markdown) {
    html += '<div class="nd-section">AI 笔记（' + esc(s.aiNote.model || '') + '）</div>';
    html += '<div class="md-body">' + renderMd(s.id, s.aiNote.markdown) + '</div>';
    if (s.aiNote.items && s.aiNote.items.length) {
      html += '<div class="nd-section">要办的事（' + s.aiNote.items.length + '）</div><div class="md-list">';
      s.aiNote.items.forEach(function (it) {
        html += '<div class="md-item"><div class="md-item-t">' + esc(it.title || '') + (it.due ? '（截止 ' + esc(it.due) + '）' : '') + '</div>' +
          (it.quote ? '<div class="md-item-q">「' + esc(it.quote) + '」</div>' : '') +
          (it.time ? '<div class="md-item-time">' + esc(it.time) + '</div>' : '') + '</div>';
      });
      html += '</div>';
    }
    html += '<div class="sheet-actions" style="margin-top:8px">';
    html += '<button class="btn tiny" data-action="ai-note-regen" data-sid="' + s.id + '">重新生成</button>';
    html += '<button class="btn tiny" data-action="export-md" data-sid="' + s.id + '">导出 Markdown</button>';
    html += '</div>';
  } else if (s.transcript && s.transcript.text) {
    html += '<div class="nd-section">AI 笔记</div>';
    html += '<button class="btn" data-action="ai-note" data-sid="' + s.id + '">生成结构化 AI 笔记</button>';
    html += '<p class="muted" style="margin-top:6px;font-size:12px">基于转写稿：分节 + 考点 + 老师原话 + 课堂标记 + 要办的事 + 存疑清单</p>';
  }
  if ((s.photos || []).length) {
    html += '<div class="nd-section">板书（' + s.photos.length + ' 张）</div><div class="nd-photos">';
    s.photos.forEach(function (p) {
      var src = '/api/media/' + s.id + '/photos/' + encodeURIComponent(p.name);
      html += '<img loading="lazy" src="' + src + '" data-full="' + src + '" alt="板书">';
    });
    html += '</div>';
  }
  html += '<div class="nd-section">笔记</div>';
  html += '<textarea id="ndEdit" class="field" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);min-height:120px;line-height:1.7" placeholder="写下这节课的重点、作业、没听懂的地方…">' + (s.note ? esc(s.note) : '') + '</textarea>';
  html += '<div class="sheet-actions">';
  html += '<button class="btn primary" data-action="save-note" data-sid="' + s.id + '">保存笔记</button>';
  html += '<button class="btn danger" data-action="del-note" data-sid="' + s.id + '">删除记录</button>';
  html += '<button class="btn" data-action="close-sheet">关闭</button>';
  html += '</div></div>';
  openSheet(html);
  var imgs = $('sheetBody').querySelectorAll('.nd-photos img');
  imgs.forEach(function (img) { img.addEventListener('click', function () { window.open(img.dataset.full, '_blank'); }); });
}
function renderMd(sid, md) {
  var lines = String(md || '').split('\n');
  var html = '';
  var inList = false, inQuote = false;
  function inline(s) {
    s = esc(s);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (mm, alt, file) {
      if (!/^[A-Za-z0-9._-]+$/.test(file)) return esc(alt);
      return '<img loading="lazy" src="/api/media/' + sid + '/photos/' + encodeURIComponent(file) + '" alt="' + esc(alt) + '">';
    });
    return s;
  }
  lines.forEach(function (line) {
    var t = line.trim();
    if (!t) { if (inList) { html += '</ul>'; inList = false; } if (inQuote) { html += '</blockquote>'; inQuote = false; } return; }
    if (/^---+$/.test(t)) { if (inList) { html += '</ul>'; inList = false; } if (inQuote) { html += '</blockquote>'; inQuote = false; } html += '<hr>'; return; }
    var h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      if (inList) { html += '</ul>'; inList = false; }
      if (inQuote) { html += '</blockquote>'; inQuote = false; }
      var tag = h[1].length === 1 ? 'h3' : (h[1].length === 2 ? 'h4' : 'h5');
      html += '<' + tag + ' class="md-h">' + inline(h[2]) + '</' + tag + '>';
      return;
    }
    if (/^>\s?/.test(t)) {
      if (inList) { html += '</ul>'; inList = false; }
      if (!inQuote) { html += '<blockquote class="md-q">'; inQuote = true; }
      html += '<p>' + inline(t.replace(/^>\s?/, '')) + '</p>';
      return;
    }
    if (/^[-*]\s+/.test(t)) {
      if (inQuote) { html += '</blockquote>'; inQuote = false; }
      if (!inList) { html += '<ul class="md-ul">'; inList = true; }
      html += '<li>' + inline(t.replace(/^[-*]\s+/, '')) + '</li>';
      return;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (inQuote) { html += '</blockquote>'; inQuote = false; }
    html += '<p class="md-p">' + inline(t) + '</p>';
  });
  if (inList) html += '</ul>';
  if (inQuote) html += '</blockquote>';
  return html;
}
function doAiNote(sid) {
  if (state.aiBusy) { toast('正在处理中，请稍候'); return; }
  state.aiBusy = true;
  var btns = document.querySelectorAll('[data-action="ai-note"],[data-action="ai-note-regen"]');
  btns.forEach(function (b) { b.disabled = true; b.textContent = '生成中…（约 1-2 分钟，请稍候）'; });
  api('/api/sessions/' + sid + '/ai-note', { method: 'POST' }).then(function (j) {
    var s = state.sessions.find(function (x) { return x.id === sid; });
    if (s) s.aiNote = j.aiNote;
    var sheetOpen = !$('sheet').classList.contains('hidden');
    if (sheetOpen) openNoteSheet(sid);
    toast('AI 笔记已生成');
  }).catch(function (e) { toast('生成失败：' + e.message); openNoteSheet(sid); }).then(function () { state.aiBusy = false; });
}
function saveNoteInline(sid) {
  var ta = $('ndEdit');
  var note = ta ? ta.value : '';
  api('/api/sessions/' + sid + '/note', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note })
  }).then(function (j) {
    var s = state.sessions.find(function (x) { return x.id === sid; });
    if (s) s.note = note;
    toast('笔记已保存');
    renderNotes();
    closeSheet();
  }).catch(function (e) { toast('保存失败：' + e.message); });
}
function startEditTranscript(sid) {
  var s = state.sessions.find(function (x) { return x.id === sid; });
  var box = $('trBox');
  if (!s || !box) return;
  var text = (s.transcript && s.transcript.text) || '';
  box.innerHTML = '<textarea id="trEdit" style="width:100%;min-height:130px;padding:10px;border-radius:12px;border:1px solid var(--line);background:var(--card);line-height:1.7">' + esc(text) + '</textarea>' +
    '<div class="sheet-actions" style="margin-top:8px"><button class="btn primary tiny" data-action="transcript-save" data-sid="' + sid + '">保存文字稿</button></div>';
}
function saveTranscript(sid) {
  var ta = $('trEdit');
  if (!ta) return;
  api('/api/sessions/' + sid + '/transcript', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: ta.value })
  }).then(function (j) {
    var s = state.sessions.find(function (x) { return x.id === sid; });
    if (s) s.transcript = j.transcript;
    openNoteSheet(sid); toast('文字稿已保存');
  }).catch(function (e) { toast('保存失败：' + e.message); });
}
function exportNoteMarkdown(sid) {
  var s = state.sessions.find(function (x) { return x.id === sid; });
  if (!s) return;
  var lines = [];
  if (s.aiNote && s.aiNote.markdown) {
    lines.push('# ' + (s.aiNote.title || (s.courseName + ' · ' + fmtDateTime(s.startedAt))));
    lines.push('');
    lines.push(s.aiNote.markdown);
    if (s.aiNote.items && s.aiNote.items.length) {
      lines.push('');
      lines.push('## 要办的事');
      s.aiNote.items.forEach(function (it) { lines.push('- ' + (it.title || '') + (it.due ? '（截止 ' + it.due + '）' : '') + (it.quote ? ' —— 「' + it.quote + '」' : '')); });
    }
    var blob0 = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    var a0 = document.createElement('a');
    a0.href = URL.createObjectURL(blob0);
    a0.download = s.courseName + '-' + fmtISO(new Date(s.startedAt)) + '-AI笔记.md';
    document.body.appendChild(a0); a0.click(); a0.remove();
    URL.revokeObjectURL(a0.href);
    toast('已导出 AI 笔记');
    return;
  }
  lines.push('# ' + s.courseName + ' · ' + fmtDateTime(s.startedAt));
  lines.push('');
  lines.push('- 时长：' + fmtDur(s.durationMs || 0));
  if (s.room) lines.push('- 地点：' + s.room);
  if (s.teacher) lines.push('- 教师：' + s.teacher);
  lines.push('');
  if (s.note) { lines.push('## 课堂笔记'); lines.push(''); lines.push(s.note); lines.push(''); }
  if (s.transcript && s.transcript.text) { lines.push('## 文字稿'); lines.push(''); lines.push(s.transcript.text); lines.push(''); }
  if ((s.photos || []).length) {
    lines.push('## 板书');
    lines.push('');
    s.photos.forEach(function (p) { lines.push('![' + p.name + '](/api/media/' + s.id + '/photos/' + encodeURIComponent(p.name) + ')'); });
  }
  var blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = s.courseName + '-' + fmtISO(new Date(s.startedAt)) + '.md';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
  toast('已导出 Markdown');
}
function doPolishTranscript(sid, silent) {
  var s = state.sessions.find(function (x) { return x.id === sid; });
  if (!s || !s.transcript || !s.transcript.text) { toast('先转写再校对'); return; }
  if (state.aiBusy) { toast('正在处理中，请稍候'); return; }
  state.aiBusy = true;
  if (!silent) toast('AI 正在校对文字稿…（约 10-30 秒）');
  var btn = document.querySelector('[data-action="polish-text"]');
  if (btn) { btn.disabled = true; btn.textContent = '校对中…'; }
  api('/api/sessions/' + sid + '/polish-transcript', { method: 'POST' }).then(function (j) {
    state.aiBusy = false;
    if (!j.ok) { toast('校对失败：' + j.error); if (btn) { btn.disabled = false; btn.textContent = 'AI 校对（修错别字）'; } return; }
    s.transcript.polished = { text: j.polished, at: Date.now() };
    if (state.showPolished) state.showPolished[sid] = true;
    if (!$('sheet').classList.contains('hidden')) openNoteSheet(sid);
    toast(silent ? 'AI 辅助转写完成（已校对）' : 'AI 校对完成');
  }).catch(function (e) {
    state.aiBusy = false;
    toast('校对失败：' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'AI 校对（修错别字）'; }
  });
}
function togglePolishedView(sid) {
  if (!state.showPolished) state.showPolished = {};
  var s = state.sessions.find(function (x) { return x.id === sid; });
  var pol = s && s.transcript && s.transcript.polished && s.transcript.polished.text;
  var cur = state.showPolished[sid];
  state.showPolished[sid] = cur === false ? true : false;
  if (!$('sheet').classList.contains('hidden')) openNoteSheet(sid);
}
var _trPoll = null;
function aiReady() {
  var c = aiCfg();
  if (c.key) return true;
  return !!state.hasServerAiKey;
}
function checkAiStatus() {
  api('/api/ai/status').then(function (j) {
    state.hasServerAiKey = !!(j && j.hasKey);
    if (j && j.provider) { state.aiProviderName = j.provider; }
  }).catch(function () {});
}
function doTranscribe(sid, aiAssist) {
  if (state.aiBusy) { toast('正在处理中，请稍候'); return; }
  state.aiBusy = true;
  var trModel = localStorage.getItem('kb-tr-model') || 'quality';
  var btn = document.querySelector('[data-action="transcribe"]');
  var btnAi = document.querySelector('[data-action="transcribe-ai"]');
  if (btn) { btn.disabled = true; btn.textContent = '转写中…'; }
  if (btnAi) { btnAi.disabled = true; btnAi.textContent = '转写中…'; }
  var box = $('trBox'); if (box) box.textContent = aiAssist ? '正在启动转写（完成后会自动 AI 校对）…' : '正在启动转写…';
  api('/api/sessions/' + sid + '/transcribe?model=' + encodeURIComponent(trModel), { method: 'POST' }).then(function (j) {
    if (!j.ok) { toast('启动转写失败：' + j.error); state.aiBusy = false; return; }
    toast(aiAssist ? 'AI 辅助转写已开始：先转文字，完成后自动 AI 校对' : (trModel === 'fast' ? '转写已开始（快速模式，1 小时课约 2-6 分钟）' : '转写已开始（清晰模式，1 小时课约 20-30 分钟，可先去做别的）'));
    pollTranscript(sid, aiAssist);
  }).catch(function (e) { toast('转写失败：' + e.message); state.aiBusy = false; });
}
function pollTranscript(sid, aiAssist) {
  if (_trPoll) clearInterval(_trPoll);
  var startedAt = Date.now();
  _trPoll = setInterval(function () {
    api('/api/sessions/' + sid + '/transcript').then(function (j) {
      if (j.status === 'done' && j.transcript) {
        clearInterval(_trPoll); _trPoll = null;
        var s = state.sessions.find(function (x) { return x.id === sid; });
        if (s) { s.transcript = j.transcript; s.transcriptStatus = 'done'; s.transcriptError = ''; }
        state.aiBusy = false;
        if (aiAssist) {
          toast('转写完成，正在 AI 校对…');
          doPolishTranscript(sid, true);
        } else {
          if (!$('sheet').classList.contains('hidden')) openNoteSheet(sid);
          toast('转写完成');
        }
      } else if (j.status === 'error') {
        clearInterval(_trPoll); _trPoll = null;
        state.aiBusy = false;
        var box2 = $('trBox'); if (box2) box2.textContent = '转写失败：' + (j.error || '未知错误');
        toast('转写失败：' + (j.error || '未知错误'));
      } else {
        var sec = Math.round((Date.now() - startedAt) / 1000);
        var box = $('trBox');
        if (box) box.textContent = '正在转写… 已等 ' + sec + ' 秒（后台进行，可关闭本页，稍后回来看结果）';
        var btn = document.querySelector('[data-action="transcribe"]');
        if (btn) { btn.disabled = true; btn.textContent = '转写中… ' + sec + 's'; }
      }
    }).catch(function () {});
  }, 3000);
}
function deleteNote(sid) {
  if (!confirm('删除这条课堂记录？录音和照片会一起删掉。')) return;
  api('/api/sessions/' + sid, { method: 'DELETE' }).then(function () {
    state.sessions = state.sessions.filter(function (x) { return x.id !== sid; });
    renderNotes(); closeSheet(); toast('已删除');
  }).catch(function (e) { toast('删除失败：' + e.message); });
}

/* ---------------- 我的 ---------------- */
/* ---------------- AI 助教 ---------------- */
function aiCfg() {
  return {
    provider: localStorage.getItem('kb-ai-provider') || '',
    key: localStorage.getItem('kb-ai-key') || '',
    model: localStorage.getItem('kb-ai-model') || ''
  };
}
function loadAiSettings() {
  var c = aiCfg();
  if ($('aiProvider')) $('aiProvider').value = c.provider;
  if ($('aiKey')) $('aiKey').value = c.key;
  if ($('aiModel')) $('aiModel').value = c.model;
}
function saveAiSettings() {
  localStorage.setItem('kb-ai-provider', $('aiProvider').value || '');
  localStorage.setItem('kb-ai-key', ($('aiKey').value || '').trim());
  localStorage.setItem('kb-ai-model', ($('aiModel').value || '').trim());
  toast('AI 设置已保存');
}
var ASSIST_CACHE_KEY = 'kb-assist-cache';
function assistCache() {
  try { var o = JSON.parse(localStorage.getItem(ASSIST_CACHE_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
}
function assistCacheSet(key, val) {
  var c = assistCache(); c[key] = val;
  try { localStorage.setItem(ASSIST_CACHE_KEY, JSON.stringify(c)); } catch (e) {}
}
function assistCacheGet(key) {
  var c = assistCache(); return c[key] || null;
}
function assistCacheDel(key) {
  var c = assistCache(); delete c[key];
  try { localStorage.setItem(ASSIST_CACHE_KEY, JSON.stringify(c)); } catch (e) {}
}
function appendAssistMessage(html, opts) {
  opts = opts || {};
  var list = $('chatList');
  if (!list) return null;
  var tip = list.querySelector('.chat-tip');
  if (tip) tip.remove();
  var div = document.createElement('div');
  div.className = 'chat-msg ai assist-msg';
  div.innerHTML = '<div class="assist-msg-body">' + html + '</div>' + (opts.actions || '');
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
  return div;
}
function bindAssistMsgActions(div) {
  if (!div) return;
  div.querySelectorAll('[data-fold-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var body = btn.closest('.assist-foldable');
      if (!body) return;
      body.classList.toggle('expanded');
      btn.textContent = body.classList.contains('expanded') ? '收起' : '展开全部';
    });
  });
}
function renderAssist() {
  var today = new Date();
  var dayIdx = ((today.getDay() + 6) % 7) + 1;
  var todayCourses = (state.classes.courses || []).filter(function (c) { return c.day === dayIdx; });
  var sub = $('assistSub');
  if (sub) sub.textContent = (today.getMonth() + 1) + '月' + today.getDate() + '日 周' + '一二三四五六日'[dayIdx - 1] + (todayCourses.length ? ' · 今天有 ' + todayCourses.length + ' 节课' : ' · 今天没有课');
  renderChatHistory();
}
function assistLoading(text) {
  var p = $('assistPanel');
  p.classList.remove('hidden');
  p.innerHTML = '<div class="assist-loading">' + esc(text) + '</div>';
  try { p.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
}
function assistSummaryPick() {
  var list = (state.sessions || []).filter(function (s) { return (s.transcript && s.transcript.text) || (s.aiNote && s.aiNote.markdown); });
  if (!list.length) { toast('还没有可总结的笔记（先转写一节课）'); return; }
  var html = '<h3>选择要精简的课</h3><div class="list">';
  list.slice(0, 8).forEach(function (s) {
    var hasCache = !!assistCacheGet('sum:' + s.id);
    html += '<button class="item" data-action="assist-summary" data-sid="' + s.id + '"><div class="item-main"><div class="item-title">' + esc(s.courseName) + (hasCache ? ' <span style="color:var(--brand);font-size:11px">● 已精简</span>' : '') + '</div><div class="item-sub">' + fmtDateTime(s.startedAt) + (hasCache ? ' · 点击在对话区查看' : (s.aiNote ? ' · 有 AI 笔记' : ' · 有文字稿')) + '</div></div><span class="item-arrow">›</span></button>';
  });
  html += '</div><div class="sheet-actions"><button class="btn" data-action="close-sheet">取消</button></div>';
  openSheet(html);
}
function doAssistSummary(sid) {
  closeSheet();
  var cached = assistCacheGet('sum:' + sid);
  if (cached) { showSummaryMessage(cached.data, cached, true, sid); return; }
  var msg = appendAssistMessage('<div class="assist-loading">正在精简这节课（约 5-20 秒）…</div>');
  api('/api/assist/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: sid }) }).then(function (j) {
    assistCacheSet('sum:' + sid, { data: j, at: Date.now() });
    if (msg) msg.remove();
    showSummaryMessage(j, null, false, sid);
  }).catch(function (e) {
    if (msg) msg.remove();
    appendAssistMessage('<div class="assist-loading">生成失败：' + esc(e.message) + '</div>');
  });
}
function summaryCardHtml(j) {
  var s = j.summary || {};
  var html = '<div class="review-card"><div class="review-head">' + esc(s.headline || j.course || '复习卡') + '</div><ul class="review-points">';
  (s.points || []).forEach(function (p) { html += '<li>' + esc(p) + '</li>'; });
  html += '</ul>';
  if ((s.keywords || []).length) {
    html += '<div class="review-tags">';
    s.keywords.forEach(function (k) { html += '<span class="review-tag">' + esc(k) + '</span>'; });
    html += '</div>';
  }
  if ((s.todo || []).length) {
    html += '<div style="margin-top:10px;font-size:13px"><b>要办：</b>' + (s.todo || []).map(function (t) { return esc(t); }).join('、') + '</div>';
  }
  html += '</div>';
  return html;
}
function showSummaryMessage(j, cached, isCached, sid) {
  var s = j.summary || {};
  var actions = '<div class="assist-msg-actions"><button class="btn tiny" data-fold-toggle>展开全部</button><button class="btn tiny" data-assist-regen="sum" data-sid="' + esc(sid || '') + '">重新生成</button></div>';
  var div = appendAssistMessage('<div class="assist-foldable clamped">' + summaryCardHtml(j) + '</div>', { actions: actions });
  bindAssistMsgActions(div);
  var regen = div && div.querySelector('[data-assist-regen]');
  if (regen && s) {
    regen.addEventListener('click', function () {
      var sid = regen.dataset.sid;
      if (sid) { assistCacheDel('sum:' + sid); doAssistSummary(sid); }
    });
  }
  renderChatHistory();
  return div;
}
function assistMindmapPick() {
  var courses = state.classes.courses || [];
  var allCache = !!assistCacheGet('mm:all');
  var html = '<h3>生成思维导图</h3><p class="sheet-sub">选择范围（需要有笔记或文字稿）；已生成过的点击可直接查看</p><div class="list">';
  html += '<button class="item" data-action="assist-mindmap" data-cid=""><div class="item-main"><div class="item-title">全部课程' + (allCache ? ' <span style="color:var(--brand);font-size:11px">● 已生成</span>' : '') + '</div><div class="item-sub">' + (allCache ? '点击在对话区查看图片' : '合并所有笔记生成一张知识树') + '</div></div><span class="item-arrow">›</span></button>';
  courses.forEach(function (c) {
    var has = (state.sessions || []).some(function (s) { return s.courseId === c.id; });
    var hasCache = !!assistCacheGet('mm:' + c.id);
    html += '<button class="item" data-action="assist-mindmap" data-cid="' + c.id + '"><div class="item-main"><div class="item-title">' + esc(c.name) + (hasCache ? ' <span style="color:var(--brand);font-size:11px">● 已生成</span>' : '') + '</div><div class="item-sub">' + (hasCache ? '点击在对话区查看图片' : (has ? '有课堂记录' : '暂无记录（也可以试）')) + '</div></div><span class="item-arrow">›</span></button>';
  });
  html += '</div><div class="sheet-actions"><button class="btn" data-action="close-sheet">取消</button></div>';
  openSheet(html);
}
function doAssistMindmap(courseId) {
  closeSheet();
  var ckey = 'mm:' + (courseId || 'all');
  var cached = assistCacheGet(ckey);
  if (cached) { showMindmapMessage(cached.tree, ckey, true); return; }
  var msg = appendAssistMessage('<div class="assist-loading">正在生成思维导图（约 5-20 秒）…</div>');
  api('/api/assist/mindmap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: courseId || '' }) }).then(function (j) {
    assistCacheSet(ckey, { tree: j.tree, at: Date.now() });
    if (msg) msg.remove();
    showMindmapMessage(j.tree, ckey, false);
  }).catch(function (e) {
    if (msg) msg.remove();
    appendAssistMessage('<div class="assist-loading">生成失败：' + esc(e.message) + '</div>');
  });
}
function showMindmapMessage(tree, ckey, isCached) {
  if (!tree) { appendAssistMessage('<div class="assist-loading">导图数据为空</div>'); return; }
  var svg = mindmapSvg(tree);
  var actions = '<div class="assist-msg-actions">' +
    '<button class="btn tiny" data-fold-toggle>展开全部</button>' +
    '<button class="btn tiny" data-mm-copy>复制大纲</button>' +
    '<button class="btn tiny" data-mm-download>下载图片</button>' +
    '<button class="btn tiny" data-mm-regen data-key="' + esc(ckey) + '">重新生成</button></div>';
  var div = appendAssistMessage('<div class="assist-foldable clamped"><div class="mm-svg-wrap">' + svg + '</div></div>', { actions: actions });
  bindAssistMsgActions(div);
  var copyBtn = div.querySelector('[data-mm-copy]');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    var txt = mindmapToText(tree);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('大纲已复制'); }).catch(function () { toast('复制失败'); });
    } else { toast('当前浏览器不支持复制'); }
  });
  var dlBtn = div.querySelector('[data-mm-download]');
  if (dlBtn) dlBtn.addEventListener('click', function () { downloadMindmapPng(svg); });
  var regen = div.querySelector('[data-mm-regen]');
  if (regen) regen.addEventListener('click', function () {
    assistCacheDel(ckey);
    doAssistMindmap(ckey === 'mm:all' ? '' : ckey.slice(3));
  });
  renderChatHistory();
  return div;
}
// 简单横向树布局 → SVG 字符串
function mindmapSvg(tree) {
  var nodes = [], edges = [];
  function measure(n) {
    var name = String(n.name || '');
    var w = Math.min(320, Math.max(56, name.length * 12 + 22));
    var kids = (n.children || []).map(measure);
    var h = kids.length ? kids.reduce(function (a, k) { return a + k.h; }, 0) : 28;
    return { w: w, h: h, node: n, kids: kids };
  }
  var root = measure(tree);
  function place(m, x, y) {
    var cy = y + m.h / 2;
    var depthColor = m.node.name;
    nodes.push({ x: x, y: cy, w: m.w, text: String(m.node.name || ''), root: m === root });
    var cx = x + m.w + 34;
    var kidY = y;
    m.kids.forEach(function (k) {
      edges.push({ x1: x + m.w, y1: cy, x2: cx, y2: kidY + k.h / 2 });
      place(k, cx, kidY);
      kidY += k.h;
    });
  }
  place(root, 20, 20);
  var maxX = 0, maxY = 0;
  nodes.forEach(function (n) { maxX = Math.max(maxX, n.x + n.w + 24); maxY = Math.max(maxY, n.y + 24); });
  if (!isFinite(maxX) || maxX <= 0) maxX = 600;
  if (!isFinite(maxY) || maxY <= 0) maxY = 400;
  var dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (document.documentElement.getAttribute('data-theme') !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var bg = dark ? '#0f1729' : '#ffffff';
  var fg = dark ? '#e5ecff' : '#1f2937';
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + maxX + '" height="' + maxY + '" viewBox="0 0 ' + maxX + ' ' + maxY + '">';
  svg += '<rect width="100%" height="100%" fill="' + bg + '"/>';
  edges.forEach(function (e) {
    svg += '<path d="M' + e.x1 + ',' + e.y1 + ' C' + (e.x1 + 16) + ',' + e.y1 + ' ' + (e.x2 - 16) + ',' + e.y2 + ' ' + e.x2 + ',' + e.y2 + '" fill="none" stroke="#94a3b8" stroke-width="1.4"/>';
  });
  nodes.forEach(function (n) {
    var fill = n.root ? '#3b6ef6' : (dark ? '#1e2a44' : '#eef2ff');
    var color = n.root ? '#ffffff' : fg;
    svg += '<rect x="' + n.x + '" y="' + (n.y - 14) + '" width="' + n.w + '" height="28" rx="9" fill="' + fill + '"/>';
    svg += '<text x="' + (n.x + 11) + '" y="' + (n.y + 4) + '" font-size="12" font-family="system-ui,-apple-system,sans-serif" fill="' + color + '">' + escXml(n.text) + '</text>';
  });
  svg += '</svg>';
  return svg;
}
function escXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function downloadMindmapPng(svgStr) {
  try {
    var img = new Image();
    var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    img.onload = function () {
      var cw = img.width || 800, ch = img.height || 600;
      var scale = Math.min(2, 2400 / Math.max(cw, ch));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(cw * scale));
      canvas.height = Math.max(1, Math.round(ch * scale));
      var ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (b) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = '思维导图-' + fmtISO(new Date()) + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
        toast('已下载图片');
      }, 'image/png');
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('图片生成失败'); };
    img.src = url;
  } catch (e) { toast('下载失败：' + e.message); }
}
function mindmapToText(node, depth) {
  depth = depth || 0;
  var pad = new Array(depth + 1).join('  ');
  var s = pad + (node.name || '') + '\n';
  (node.children || []).forEach(function (c) { s += mindmapToText(c, depth + 1); });
  return s;
}
function renderMindmap(tree) {
  state.lastMindmap = tree;
  function node(n, depth) {
    var cls = depth === 0 ? 'mm-node mm-root' : (depth === 1 ? 'mm-node mm-l1' : 'mm-node');
    var html = '<div class="' + cls + '"><span class="mm-label">' + esc(n.name || '') + '</span>';
    if (n.children && n.children.length) {
      n.children.forEach(function (ch) { html += node(ch, depth + 1); });
    }
    return html + '</div>';
  }
  var p = $('assistPanel');
  p.classList.remove('hidden');
  p.innerHTML = '<div class="mindmap">' + node(tree, 0) + '</div>' +
    '<div class="sheet-actions" style="margin-top:8px"><button class="btn tiny" id="btnCopyMd">复制大纲</button></div>';
  var btn = $('btnCopyMd');
  if (btn) {
    btn.addEventListener('click', function () {
      var txt = mindmapToText(tree);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toast('大纲已复制'); }).catch(function () { toast('复制失败'); });
      } else { toast('当前浏览器不支持复制'); }
    });
  }
}
function todoKey(it) {
  return (it.course || '') + '|' + (it.title || '') + '|' + (it.date || 0);
}
function todoDoneSet() {
  try { return JSON.parse(localStorage.getItem('kb-todo-done') || '[]'); } catch (e) { return []; }
}
function assistTodos() {
  assistLoading('正在汇总待办…');
  api('/api/assist/todos').then(function (j) {
    var items = j.items || [];
    var p = $('assistPanel');
    p.classList.remove('hidden');
    if (!items.length) { p.innerHTML = '<div class="assist-loading">暂无待办（笔记里没提到作业/截止）</div>'; return; }
    var done = todoDoneSet();
    var html = '<div class="review-card"><div class="review-head">待办汇总（' + items.length + '）</div>';
    items.forEach(function (it) {
      var k = todoKey(it);
      var isDone = done.indexOf(k) >= 0;
      html += '<div class="todo-item' + (isDone ? ' done' : '') + '" data-todo-key="' + esc(k) + '"><div class="todo-check"></div><div class="todo-main"><div class="todo-title">' + esc(it.title) + '</div><div class="todo-sub">' + esc(it.course) + (it.due ? ' · 截止 ' + esc(it.due) : '') + (it.quote ? ' · 「' + esc(it.quote) + '」' : '') + '</div></div></div>';
    });
    html += '</div>';
    p.innerHTML = html;
    p.querySelectorAll('[data-todo-key]').forEach(function (el) {
      el.addEventListener('click', function () {
        var k = el.dataset.todoKey;
        var list = todoDoneSet();
        var i = list.indexOf(k);
        if (i >= 0) list.splice(i, 1); else list.push(k);
        try { localStorage.setItem('kb-todo-done', JSON.stringify(list)); } catch (e) {}
        el.classList.toggle('done');
      });
    });
  }).catch(function (e) { $('assistPanel').classList.remove('hidden'); $('assistPanel').innerHTML = '<div class="assist-loading">失败：' + esc(e.message) + '</div>'; });
}
function chatHistorySave() {
  try { localStorage.setItem('kb-chat-history', JSON.stringify((state.chatHistory || []).slice(-20))); } catch (e) {}
}
function chatHistoryLoad() {
  try { return JSON.parse(localStorage.getItem('kb-chat-history') || '[]'); } catch (e) { return []; }
}
function renderChatHistory() {
  var list = $('chatList');
  if (!list || list.querySelector('.chat-msg')) return;
  var h = chatHistoryLoad();
  if (!h.length) return;
  var tip = list.querySelector('.chat-tip');
  if (tip) tip.remove();
  h.forEach(function (m) {
    var div = document.createElement('div');
    div.className = 'chat-msg ' + (m.role === 'user' ? 'user' : 'ai');
    div.textContent = m.content || '';
    list.appendChild(div);
  });
}
function clearChat() {
  state.chatHistory = [];
  try { localStorage.removeItem('kb-chat-history'); } catch (e) {}
  var list = $('chatList');
  if (list) {
    list.innerHTML = '<div class="chat-tip" id="chatTip">我是你的课堂助手 AI 助教，可以问我：今天有什么课？这周有什么作业？帮我总结高数那节课。</div>';
  }
  toast('对话已清空');
}
function appendChat(role, text, loading) {
  var list = $('chatList');
  var tip = list.querySelector('.chat-tip');
  if (tip) tip.remove();
  var div = document.createElement('div');
  div.className = 'chat-msg ' + role + (loading ? ' loading' : '');
  div.textContent = text;
  list.appendChild(div);
  try { div.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
  return div;
}
function sendChat() {
  var input = $('chatInput');
  var text = (input.value || '').trim();
  if (!text) return;
  input.value = '';
  appendChat('user', text);
  if (!state.chatHistory) state.chatHistory = [];
  state.chatHistory.push({ role: 'user', content: text });
  chatHistorySave();
  var loading = appendChat('ai', '思考中…', true);
  api('/api/assist/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: state.chatHistory.slice(-12) }) }).then(function (j) {
    if (loading.parentNode) loading.remove();
    appendChat('ai', j.text || '');
    state.chatHistory.push({ role: 'assistant', content: j.text || '' });
    if (state.chatHistory.length > 30) state.chatHistory = state.chatHistory.slice(-30);
    chatHistorySave();
  }).catch(function (e) {
    if (loading.parentNode) loading.remove();
    appendChat('ai', '出错了：' + e.message);
    chatHistorySave();
  });
}

var courseListExpanded = false;
function renderMe() {
  var box = $('courseList');
  if (!state.classes.courses.length) {
    box.innerHTML = '<p class="muted">还没有课程，点右上角添加</p>';
  } else {
    var allCourses = state.classes.courses;
    var LIMIT = 6;
    var collapsed = allCourses.length > LIMIT && !courseListExpanded;
    var shown = collapsed ? allCourses.slice(0, LIMIT) : allCourses;
    box.innerHTML = shown.map(function (c) {
      return '<button class="courserow" data-edit-course="' + c.id + '">' +
        '<span class="dot" style="background:' + paletteOf(c) + '"></span>' +
        '<span class="cr-main"><span class="cr-name">' + esc(c.name) + '</span>' +
        '<span class="cr-meta">' + WEEK_NAMES[c.day - 1] + ' 第 ' + c.start + '-' + c.end + ' 节 · ' + esc(c.room || '地点待定') + '</span></span>' +
        '<span class="cr-del" data-del-course="' + c.id + '">删除</span></button>';
    }).join('');
    box.querySelectorAll('[data-edit-course]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        if (e.target && e.target.dataset && e.target.dataset.delCourse) return;
        openCourseEdit(btn.dataset.editCourse);
      });
    });
    box.querySelectorAll('[data-del-course]').forEach(function (del) {
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = del.dataset.delCourse;
        if (!confirm('删除这门课？')) return;
        state.classes.courses = state.classes.courses.filter(function (c) { return c.id !== id; });
        saveClasses(); toast('已删除');
      });
    });
    if (allCourses.length > LIMIT) {
      var tg = document.createElement('button');
      tg.className = 'btn tiny';
      tg.style.cssText = 'width:100%;margin-top:10px';
      tg.textContent = courseListExpanded ? '收起课程列表' : ('展开全部 ' + allCourses.length + ' 门课');
      tg.addEventListener('click', function () {
        courseListExpanded = !courseListExpanded;
        renderMe();
      });
      box.appendChild(tg);
    }
  }
  $('weekStart').value = state.classes.meta.weekStart || fmtISO(state.weekStartDate);
  $('weeksTotal').value = state.classes.meta.weeksTotal || 20;
  $('themeSelect').value = localStorage.getItem('kb-theme') || 'auto';
  $('transcribeModel').value = localStorage.getItem('kb-tr-model') || 'quality';
  loadAiSettings();
  if ($('noteSearch')) $('noteSearch').value = state.noteQuery || '';
}
function openCourseEdit(id) {
  var c = id ? state.classes.courses.find(function (x) { return x.id === id; }) : null;
  var isNew = !c;
  c = c || { id: '', name: '', teacher: '', room: '', day: 1, start: 1, end: 2, weeks: '1-18', color: Math.floor(Math.random() * PALETTE.length) };
  var ss = sections();
  var dayOpts = WEEK_NAMES.map(function (w, i) { return '<option value="' + (i + 1) + '"' + (c.day === i + 1 ? ' selected' : '') + '>' + w + '</option>'; }).join('');
  var secOpts = ss.map(function (s, i) { return '<option value="' + (i + 1) + '">第 ' + (i + 1) + ' 节</option>'; }).join('');
  var colorOpts = PALETTE.map(function (p, i) { return '<option value="' + i + '"' + (i === c.color ? ' selected' : '') + '>颜色 ' + (i + 1) + '</option>'; }).join('');
  var html = '<h3>' + (isNew ? '添加课程' : '编辑课程') + '</h3><p class="sheet-sub">' + (isNew ? '手动录入一门课' : '修改后立即生效') + '</p>';
  html += '<div class="field">课程名称<input id="fcName" value="' + esc(c.name) + '" placeholder="如 高等数学A1"></div>';
  html += '<div class="row2"><div class="field">教师<input id="fcTeacher" value="' + esc(c.teacher || '') + '"></div><div class="field">地点<input id="fcRoom" value="' + esc(c.room || '') + '"></div></div>';
  html += '<div class="row2"><div class="field">星期<select id="fcDay">' + dayOpts + '</select></div><div class="field">颜色<select id="fcColor">' + colorOpts + '</select></div></div>';
  html += '<div class="row2"><div class="field">起始节<select id="fcStart">' + secOpts.replace('value="' + c.start + '"', 'value="' + c.start + '" selected') + '</select></div><div class="field">结束节<select id="fcEnd">' + secOpts.replace('value="' + c.end + '"', 'value="' + c.end + '" selected') + '</select></div></div>';
  html += '<div class="field">周次<input id="fcWeeks" value="' + esc(c.weeks || '1-18') + '" placeholder="如 1-8,11-18 或 全周"></div>';
  html += '<div class="field">术语提示（选填，转写时帮助纠正专业词）<input id="fcTerms" value="' + esc(c.terms || '') + '" placeholder="如 导数、曲线、切线、斜率"></div>';
  html += '<div class="sheet-actions"><button class="btn primary" data-action="save-course" data-id="' + (isNew ? '' : c.id) + '">保存</button><button class="btn" data-action="close-sheet">取消</button></div>';
  openSheet(html);
}
function saveCourseEdit(id) {
  var name = ($('fcName').value || '').trim();
  if (!name) { toast('课程名不能为空'); return; }
  if (name.length > 40) name = name.slice(0, 40);
  var course = {
    id: id || ('c' + Date.now().toString(36)),
    name: name,
    teacher: ($('fcTeacher').value || '').trim(),
    room: ($('fcRoom').value || '').trim(),
    day: +$('fcDay').value,
    start: +$('fcStart').value,
    end: +$('fcEnd').value,
    weeks: ($('fcWeeks').value || '全周').trim(),
    color: +$('fcColor').value,
    terms: ($('fcTerms').value || '').trim()
  };
  if (course.end < course.start) course.end = course.start;
  var maxSec = sections().length;
  course.start = Math.min(Math.max(1, course.start), maxSec);
  course.end = Math.min(Math.max(course.start, course.end), maxSec);
  if (id) {
    var i = state.classes.courses.findIndex(function (x) { return x.id === id; });
    if (i >= 0) state.classes.courses[i] = course;
  } else {
    state.classes.courses.push(course);
  }
  saveClasses();
  closeSheet();
  toast('已保存');
}
function saveSettings() {
  state.classes.meta.weekStart = $('weekStart').value || state.classes.meta.weekStart;
  state.classes.meta.weeksTotal = +$('weeksTotal').value || 20;
  var ws = parseLocalDate(state.classes.meta.weekStart);
  if (ws) state.weekStartDate = ws;
  state.currentWeek = weekOf(new Date());
  state.displayWeek = state.currentWeek;
  saveClasses();
  toast('设置已保存');
}

/* ---------------- 主题 ---------------- */
function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode || 'auto');
  localStorage.setItem('kb-theme', mode || 'auto');
}
function toggleTheme() {
  var cur = localStorage.getItem('kb-theme') || 'auto';
  var next = cur === 'light' ? 'dark' : (cur === 'dark' ? 'auto' : 'light');
  applyTheme(next);
  $('themeSelect').value = next;
  toast('主题：' + (next === 'auto' ? '跟随系统' : (next === 'light' ? '浅色' : '深色')));
}

/* ---------------- 数据管理 ---------------- */
function exportClassesJson() {
  var data = { meta: state.classes.meta, sections: state.classes.sections, courses: state.classes.courses };
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '课堂助手-课表-' + fmtISO(new Date()) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
  toast('课表已导出');
}
function onClassesFilePicked() {
  var input = $('classesFile');
  var f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.courses)) throw new Error('文件里没有 courses 数组');
      if (!confirm('导入会替换当前课表（' + data.courses.length + ' 门课），继续？')) return;
      state.classes = { meta: data.meta || {}, sections: data.sections || [], courses: data.courses };
      var ws = parseLocalDate(state.classes.meta.weekStart) || mondayOf(new Date());
      state.weekStartDate = ws;
      if (!state.classes.meta.weekStart) state.classes.meta.weekStart = fmtISO(ws);
      state.currentWeek = weekOf(new Date());
      var totalW = +state.classes.meta.weeksTotal || 20;
      state.displayWeek = Math.min(Math.max(1, state.currentWeek), Math.max(1, totalW));
      saveClasses();
      toast('课表已导入（' + data.courses.length + ' 门）');
    } catch (e) { toast('导入失败：' + e.message); }
  };
  reader.readAsText(f, 'utf-8');
}
function exportIcs() {
  var ss = sections();
  var meta = state.classes.meta || {};
  var totalW = +meta.weeksTotal || 20;
  var courses = state.classes.courses || [];
  if (!courses.length) { toast('课表是空的，先导入课程'); return; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function icsTime(d) {
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }
  function dayDate(week, day, hhmm) {
    var base = weekDate(week, day);
    var parts = String(hhmm || '00:00').split(':');
    var d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), +(parts[0] || 0), +(parts[1] || 0), 0, 0);
    return d;
  }
  var lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Classroom Assistant//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:课堂助手课表',
    'X-WR-TIMEZONE:Asia/Shanghai'
  ];
  var count = 0;
  courses.forEach(function (c) {
    var s0 = ss[c.start - 1] || { start: '08:00' };
    var s1 = ss[c.end - 1] || { end: '09:35' };
    for (var w = 1; w <= totalW; w++) {
      if (!inWeek(c.weeks, w)) continue;
      var dtStart = dayDate(w, c.day, s0.start || '08:00');
      var dtEnd = dayDate(w, c.day, s1.end || '09:35');
      if (dtEnd <= dtStart) dtEnd = new Date(dtStart.getTime() + 45 * 60000);
      var desc = (c.teacher ? '教师：' + c.teacher + '\n' : '') + (c.room ? '地点：' + c.room : '') + '\n周次：' + (c.weeks || '全周') + '（第 ' + w + ' 周）';
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + c.id + '-w' + w + '@classroom-assistant');
      lines.push('DTSTAMP:' + icsTime(new Date()));
      lines.push('DTSTART:' + icsTime(dtStart));
      lines.push('DTEND:' + icsTime(dtEnd));
      lines.push('SUMMARY:' + (c.name || '课程').replace(/[,;]/g, ' '));
      if (c.room) lines.push('LOCATION:' + String(c.room).replace(/[,;]/g, ' '));
      lines.push('DESCRIPTION:' + desc.replace(/\n/g, '\\n'));
      lines.push('END:VEVENT');
      count++;
    }
  });
  lines.push('END:VCALENDAR');
  var blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '课堂助手课表-' + fmtISO(new Date()) + '.ics';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
  toast('已导出 ' + count + ' 个日历事件');
}
function purgeSessions() {
  if (!confirm('清空所有课堂记录（录音/板书/笔记）？此操作不可恢复。')) return;
  if (!confirm('再确认一次：确定要清空全部课堂记录吗？')) return;
  api('/api/sessions/purge', { method: 'POST' }).then(function (j) {
    state.sessions = [];
    state.noteFilter = '';
    state.noteQuery = '';
    if ($('noteSearch')) $('noteSearch').value = '';
    renderNotes(); renderClassPage();
    toast('已清空 ' + (j.removed || 0) + ' 条课堂记录');
  }).catch(function (e) { toast('清空失败：' + e.message); });
}

/* ---------------- 未结束课堂恢复 ---------------- */
function checkUnfinishedSessions() {
  var recs = (state.sessions || []).filter(function (s) { return s.status === 'recording'; });
  if (!recs.length) return;
  var html = '<h3>有未结束的课堂</h3><p class="sheet-sub">上次可能没点「结束上课」就离开了页面（录音和板书已保存）</p>';
  html += '<div class="list">';
  recs.forEach(function (s) {
    html += '<div class="item"><div class="item-main"><div class="item-title">' + esc(s.courseName) + '</div>' +
      '<div class="item-sub">' + fmtDateTime(s.startedAt) + ' · 已录 ' + (s.segments || []).length + ' 段 · ' + (s.photos || []).length + ' 张板书</div></div></div>';
    html += '<div class="sheet-actions" style="margin-top:8px">';
    html += '<button class="btn primary tiny" data-action="resume-finish" data-sid="' + s.id + '">结束并写笔记</button>';
    html += '<button class="btn tiny" data-action="resume-del" data-sid="' + s.id + '">删除</button>';
    html += '</div>';
  });
  html += '</div>';
  html += '<div class="sheet-actions"><button class="btn" data-action="close-sheet">稍后处理</button></div>';
  openSheet(html);
}
function resumeFinish(sid) {
  var s = state.sessions.find(function (x) { return x.id === sid; });
  if (!s) return;
  var now = Date.now();
  api('/api/sessions/' + sid + '/finish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endedAt: now, durationMs: Math.max(0, now - s.startedAt), note: s.note || '' })
  }).then(function (j) {
    var idx = state.sessions.findIndex(function (x) { return x.id === sid; });
    if (idx >= 0) state.sessions[idx] = j.session;
    openNoteSheet(sid);
    toast('已结束，可以补写笔记');
  }).catch(function (e) { toast('操作失败：' + e.message); });
}
function resumeDelete(sid) {
  if (!confirm('删除这条未结束的课堂记录？录音会一起删除。')) return;
  api('/api/sessions/' + sid, { method: 'DELETE' }).then(function () {
    state.sessions = state.sessions.filter(function (x) { return x.id !== sid; });
    closeSheet(); renderNotes(); toast('已删除');
  }).catch(function (e) { toast('删除失败：' + e.message); });
}

/* ---------------- 导入课表（截图识别） ---------------- */
var importState = { b64: '', mime: 'image/png', courses: [], engine: 'ai', meta: null };

function openImportSheet() {
  importState = { b64: '', mime: 'image/png', courses: [], engine: 'ai' };
  var html = '<h3>导入课表</h3>';
  html += '<div style="display:flex;gap:8px;margin:12px 0 14px">';
  html += '<button class="btn primary" id="tabEams" style="flex:1;padding:12px 4px;font-size:14px;font-weight:600">账号</button>';
  html += '<button class="btn" id="tabOcr" style="flex:1;padding:12px 4px;font-size:14px">截图</button>';
  html += '<button class="btn" id="tabCsv" style="flex:1;padding:12px 4px;font-size:14px">CSV</button>';
  html += '<button class="btn" id="tabHtml" style="flex:1;padding:12px 4px;font-size:14px">HTML</button>';
  html += '</div>';
  html += '<div id="paneEams">';
  html += '<p class="sheet-sub">选择教务系统，输入学号密码自动拉取；密码不保存。支持北物资 EAMS、正方、强智，其他学校可用截图/HTML/CSV 导入</p>';
  html += '<select id="campusType" class="select" style="width:100%;height:48px;font-size:15px;margin-bottom:10px;border-radius:12px">';
  html += '<option value="eams">北京物资学院（金智 EAMS）</option>';
  html += '<option value="zhengfang">正方教务系统（多数高校）</option>';
  html += '<option value="qiangzhi">强智教务系统</option>';
  html += '</select>';
  html += '<input id="campusBase" class="field" placeholder="教务系统网址（正方/强智必填，如 https://jwxt.xxx.edu.cn/）" style="display:none;width:100%;height:52px;font-size:15px;padding:0 16px;margin-bottom:10px;border-radius:14px">';
  html += '<input id="eamsUser" class="field" placeholder="学号" autocomplete="username" style="width:100%;height:52px;font-size:17px;padding:0 16px;margin-bottom:12px;border-radius:14px">';
  html += '<input id="eamsPass" class="field" type="password" placeholder="教务系统密码（信息门户密码）" autocomplete="current-password" style="width:100%;height:52px;font-size:17px;padding:0 16px;margin-bottom:14px;border-radius:14px">';
  html += '<button class="btn primary big" id="btnEamsImport" style="width:100%">登录并拉取课表</button>';
  html += '<p id="eamsStatus" class="muted" style="margin-top:10px"></p>';
  html += '<div id="eamsPreview"></div>';
  html += '</div>';
  html += '<div id="paneOcr" style="display:none">';
  html += '<p class="sheet-sub">上传教务系统课表截图，识别后核对，再合并或替换</p>';
  html += '<div id="impDrop" style="border:2px dashed var(--line);border-radius:16px;padding:30px;text-align:center;color:var(--dim);cursor:pointer;font-size:15px">点击选择截图 或 Ctrl+V 粘贴</div>';
  html += '<input type="file" id="impFile" accept="image/*" class="hidden">';
  html += '<div id="impPrev" style="margin-top:10px"></div>';
  html += '<div class="sheet-actions" id="impActions" style="display:none">';
  html += '<button class="btn primary" data-action="imp-ai">AI 识别（推荐）</button>';
  html += '<button class="btn" data-action="imp-local">本地 OCR</button>';
  html += '</div>';
  html += '<p id="impStatus" class="muted" style="margin-top:10px"></p>';
  html += '<div id="impPreview"></div>';
  html += '</div>';
  html += '<div id="paneCsv" style="display:none">';
  html += '<p class="sheet-sub">从 WakeUp 课程表等 App 导出 CSV，或按模板填写（课程名称,星期,开始节数,结束节数,老师,地点,周数）</p>';
  html += '<div id="csvDrop" style="border:2px dashed var(--line);border-radius:16px;padding:30px;text-align:center;color:var(--dim);cursor:pointer;font-size:15px">点击选择 CSV 文件</div>';
  html += '<input type="file" id="csvFile" accept=".csv,text/csv,text/plain" class="hidden">';
  html += '<p id="csvStatus" class="muted" style="margin-top:10px"></p>';
  html += '<div id="csvPreview"></div>';
  html += '</div>';
  html += '<div id="paneHtml" style="display:none">';
  html += '<p class="sheet-sub">在浏览器登录教务系统 → 打开课表页 → Ctrl+S 保存网页（仅 HTML）→ 上传这里，自动解析成课表</p>';
  html += '<div id="htmlDrop" style="border:2px dashed var(--line);border-radius:16px;padding:30px;text-align:center;color:var(--dim);cursor:pointer;font-size:15px">点击选择课表页 HTML 文件</div>';
  html += '<input type="file" id="htmlFile" accept=".html,.htm,text/html" class="hidden">';
  html += '<p id="htmlStatus" class="muted" style="margin-top:10px"></p>';
  html += '<div id="htmlPreview"></div>';
  html += '</div>';
  openSheet(html);
  var drop = $('impDrop');
  var file = $('impFile');
  drop.addEventListener('click', function () { file.click(); });
  drop.addEventListener('dragover', function (e) { e.preventDefault(); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer.files && e.dataTransfer.files[0]) setImportImage(e.dataTransfer.files[0]); });
  file.addEventListener('change', function () { if (file.files && file.files[0]) setImportImage(file.files[0]); });
  function switchTab(which) {
    ['eams', 'ocr', 'csv', 'html'].forEach(function (k) {
      var pane = $('pane' + k.charAt(0).toUpperCase() + k.slice(1));
      if (pane) pane.style.display = which === k ? '' : 'none';
      var tab = $('tab' + k.charAt(0).toUpperCase() + k.slice(1));
      if (tab) tab.className = 'btn' + (which === k ? ' primary' : '');
    });
  }
  $('tabEams').addEventListener('click', function () { switchTab('eams'); });
  $('tabOcr').addEventListener('click', function () { switchTab('ocr'); });
  $('tabCsv').addEventListener('click', function () { switchTab('csv'); });
  $('tabHtml').addEventListener('click', function () { switchTab('html'); });
  $('btnEamsImport').addEventListener('click', doEamsImport);
  $('campusType').addEventListener('change', function () {
    var base = $('campusBase');
    if (base) base.style.display = $('campusType').value === 'eams' ? 'none' : '';
  });
  var htmlDrop = $('htmlDrop');
  var htmlInput = $('htmlFile');
  htmlDrop.addEventListener('click', function () { htmlInput.click(); });
  htmlInput.addEventListener('change', function () {
    var f = htmlInput.files && htmlInput.files[0];
    if (!f) return;
    $('htmlStatus').textContent = '读取文件中…';
    var reader = new FileReader();
    reader.onload = function () {
      $('htmlStatus').textContent = '解析中…';
      api('/api/eams/parse-html', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: reader.result }) }).then(function (j) {
        if (!j.ok) { $('htmlStatus').textContent = '解析失败：' + j.error; return; }
        importState.meta = j.meta || null;
        var courses = j.courses || [];
        $('htmlStatus').textContent = '解析到 ' + courses.length + ' 条课程，核对后导入';
        if (!courses.length) { $('htmlStatus').textContent = '没有解析到课程。请确认保存的是课表页面（不是登录页），或换用截图识别。'; return; }
        importState.courses = courses;
        renderImportPreview();
        $('htmlPreview').innerHTML = $('impPreview').innerHTML;
        $('impPreview').innerHTML = '';
        var actions = $('impActions');
        if (actions) actions.style.display = 'none';
        bindPreviewBox($('htmlPreview'));
      }).catch(function (e) { $('htmlStatus').textContent = '解析请求失败：' + e.message; });
    };
    reader.readAsText(f, 'utf-8');
    htmlInput.value = '';
  });
  var csvDrop = $('csvDrop');
  var csvFile = $('csvFile');
  csvDrop.addEventListener('click', function () { csvFile.click(); });
  csvFile.addEventListener('change', function () {
    var f = csvFile.files && csvFile.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var courses = parseWakeupCsv(reader.result);
      $('csvStatus').textContent = courses.length ? ('解析到 ' + courses.length + ' 条课程，核对后点底部「导入」') : '没有解析到课程，检查 CSV 是否含表头「课程名称」';
      if (!courses.length) return;
      importState.courses = courses;
      renderImportPreview();
      // 把预览显示到 CSV Tab 里（renderImportPreview 写入 impPreview，需同步高亮 Tab 内容）
      $('csvPreview').innerHTML = $('impPreview').innerHTML;
      $('impPreview').innerHTML = '';
      var actions = $('impActions');
      if (actions) actions.style.display = 'none';
      bindPreviewBox($('csvPreview'));
    };
    reader.readAsText(f, 'utf-8');
    csvFile.value = '';
  });
}
function doEamsImport() {
  var type = $('campusType') ? $('campusType').value : 'eams';
  var base = $('campusBase') ? ($('campusBase').value || '').trim() : '';
  var u = ($('eamsUser').value || '').trim();
  var p = $('eamsPass').value || '';
  var st = $('eamsStatus');
  if (!u || !p) { st.textContent = '请输入学号和密码'; return; }
  if (type !== 'eams' && !base) { st.textContent = '请填写教务系统网址（正方/强智必填）'; return; }
  st.textContent = '正在登录教务系统…（约 5-20 秒）';
  $('btnEamsImport').disabled = true;
  api('/api/campus/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: type, baseUrl: base, username: u, password: p })
  }).then(function (j) {
    $('btnEamsImport').disabled = false;
    if (!j.ok) { st.textContent = '失败：' + j.error; return; }
    importState.meta = j.meta || null;
    var courses = j.courses || [];
    if (courses.length) {
      importState.courses = courses;
      renderImportPreview();
      $('eamsPreview').innerHTML = $('impPreview').innerHTML;
      $('impPreview').innerHTML = '';
      var ea = $('impActions');
      if (ea) ea.style.display = 'none';
      bindPreviewBox($('eamsPreview'));
      st.textContent = '登录成功，解析到 ' + courses.length + ' 条课程，核对后导入';
      toast('已拉取并解析课表');
    } else {
      st.textContent = '登录成功，但没有解析到课程。可改用 HTML 导入：保存课表页后上传。';
    }
  }).catch(function (e) {
    $('btnEamsImport').disabled = false;
    st.textContent = '请求失败：' + e.message;
  });
}
function fileToPngBase64(file, maxSide) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      var scale = Math.min(1, maxSide / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      var dataUrl = cv.toDataURL('image/png');
      resolve({ b64: dataUrl.split(',')[1], url: dataUrl });
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}
function setImportImage(file) {
  importState.courses = [];
  $('impStatus').textContent = '图片处理中…';
  $('impPreview').innerHTML = '';
  fileToPngBase64(file, 1800).then(function (r) {
    importState.b64 = r.b64;
    $('impPrev').innerHTML = '<img src="' + r.url + '" style="max-width:100%;max-height:220px;border-radius:12px;border:1px solid var(--line)">';
    $('impActions').style.display = 'flex';
    $('impStatus').textContent = '已选择图片，点「AI 识别」开始（约 10-30 秒）';
  }).catch(function (e) { $('impStatus').textContent = '图片处理失败：' + e.message; });
}
function parseCsvLine(line) {
  var out = [], cur = '', q = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function parseWakeupCsv(text) {
  var lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var start = 0;
  for (var i = 0; i < Math.min(6, lines.length); i++) {
    if (lines[i].indexOf('课程名称') >= 0) { start = i + 1; break; }
  }
  var out = [];
  for (var j = start; j < lines.length; j++) {
    var line = lines[j].trim();
    if (!line) continue;
    var cols = parseCsvLine(line);
    if (cols.length < 7) continue;
    var name = (cols[0] || '').trim();
    if (!name || /课程名称/.test(name)) continue;
    var day = parseInt(cols[1], 10);
    var s = parseInt(cols[2], 10);
    var e = parseInt(cols[3], 10);
    var teacher = (cols[4] || '').trim(); if (teacher === '无') teacher = '';
    var room = (cols[5] || '').trim(); if (room === '无') room = '';
    var weeks = (cols[6] || '').trim();
    if (!day || day < 1 || day > 7 || !s || !e) continue;
    out.push({ name: name, teacher: teacher, room: room, day: day, start: s, end: Math.max(s, e), weeks: weeks || '全周' });
  }
  return out;
}
function bindPreviewBox(box) {
  if (!box) return;
  box.querySelectorAll('[data-imp-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      importState.courses.splice(+b.dataset.impDel, 1);
      renderImportPreview();
      box.innerHTML = $('impPreview').innerHTML;
      $('impPreview').innerHTML = '';
      bindPreviewBox(box);
    });
  });
  box.querySelectorAll('[data-imp-edit]').forEach(function (b) {
    b.addEventListener('click', function () {
      var idx = +b.dataset.impEdit;
      var c = importState.courses[idx];
      var name = window.prompt('课程名称', c.name);
      if (name === null) return;
      c.name = name.trim();
      var day = window.prompt('星期（1-7）', c.day);
      if (day !== null) c.day = Math.min(7, Math.max(1, +day || 1));
      var sec = window.prompt('开始节数', c.start);
      if (sec !== null) c.start = Math.max(1, +sec || 1);
      var sec2 = window.prompt('结束节数', c.end);
      if (sec2 !== null) c.end = Math.max(c.start, +sec2 || c.start);
      var room = window.prompt('地点', c.room);
      if (room !== null) c.room = room.trim();
      var weeks = window.prompt('周次（如 1-16 或 1-5、7-11单）', c.weeks);
      if (weeks !== null) c.weeks = weeks.trim();
      renderImportPreview();
      box.innerHTML = $('impPreview').innerHTML;
      $('impPreview').innerHTML = '';
      bindPreviewBox(box);
    });
  });
}
function doImportRecognize(engine) {
  if (!importState.b64) { toast('先选择一张截图'); return; }
  importState.engine = engine;
  var status = $('impStatus');
  status.textContent = engine === 'ai' ? 'AI 识别中…（约 10-30 秒）' : '本地 OCR 识别中…（约 2-10 秒）';
  var url = engine === 'ai' ? '/api/parse-timetable' : '/api/ocr-parse';
  api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: importState.b64, mimeType: 'image/png' })
  }).then(function (j) {
    var list = (j.data && j.data.courses) ? j.data.courses : [];
    importState.courses = list.map(function (c) {
      return {
        name: c.name || '', teacher: c.teacher || '', room: c.room || '',
        day: Math.min(7, Math.max(1, +c.day || 1)),
        start: Math.max(1, +c.startSection || 1),
        end: Math.max(+c.startSection || 1, +c.endSection || +c.startSection || 1),
        weeks: c.weeksText || '全周'
      };
    }).filter(function (c) { return c.name; });
    renderImportPreview();
  }).catch(function (e) {
    status.textContent = '识别失败：' + e.message;
  });
}
function renderImportPreview() {
  var list = importState.courses;
  if (!list.length) { $('impStatus').textContent = '没有识别到课程，换一张更清晰的截图试试'; return; }
  $('impStatus').textContent = '识别完成（' + (importState.engine === 'ai' ? 'AI' : '本地 OCR') + '）：' + list.length + ' 门课，核对后导入';
  var html = '<div style="display:flex;flex-direction:column;gap:6px;margin-top:10px">';
  list.forEach(function (c, i) {
    html += '<div style="display:flex;align-items:center;gap:8px;background:var(--bg);border-radius:10px;padding:8px 10px">';
    html += '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13.5px">' + esc(c.name) + '</div>';
    html += '<div style="color:var(--dim);font-size:11.5px">' + WEEK_NAMES[c.day - 1] + ' 第 ' + c.start + '-' + c.end + ' 节 · ' + esc(c.weeks) + (c.room ? ' · ' + esc(c.room) : '') + (c.teacher ? ' · ' + esc(c.teacher) : '') + '</div></div>';
    html += '<button class="btn tiny" data-action="imp-edit" data-i="' + i + '">改</button>';
    html += '<button class="btn tiny" data-action="imp-del" data-i="' + i + '">删</button>';
    html += '</div>';
  });
  html += '</div>';
  html += '<div class="sheet-actions">';
  html += '<button class="btn primary" data-action="imp-apply-merge">合并导入</button>';
  html += '<button class="btn" data-action="imp-apply-replace">替换全部</button>';
  html += '<button class="btn" data-action="close-sheet">取消</button>';
  html += '</div>';
  $('impPreview').innerHTML = html;
}
function importDelete(index) {
  importState.courses.splice(index, 1);
  renderImportPreview();
}
function renderImportEdit(index) {
  var c = importState.courses[index];
  if (!c) return;
  var dayOpts = WEEK_NAMES.map(function (w, i) {
    return '<option value="' + (i + 1) + '"' + (c.day === i + 1 ? ' selected' : '') + '>' + w + '</option>';
  }).join('');
  var ss = sections();
  var secOpts = function (sel) {
    return ss.map(function (s, i) {
      return '<option value="' + (i + 1) + '"' + (sel === i + 1 ? ' selected' : '') + '>第 ' + (i + 1) + ' 节</option>';
    }).join('');
  };
  var html = '<div class="card" style="box-shadow:none;background:var(--bg);margin-top:10px">';
  html += '<div class="field">课程名称<input id="ieName" value="' + esc(c.name) + '"></div>';
  html += '<div class="row2"><div class="field">星期<select id="ieDay">' + dayOpts + '</select></div><div class="field">周次<input id="ieWeeks" value="' + esc(c.weeks) + '"></div></div>';
  html += '<div class="row2"><div class="field">起始节<select id="ieStart">' + secOpts(c.start) + '</select></div><div class="field">结束节<select id="ieEnd">' + secOpts(c.end) + '</select></div></div>';
  html += '<div class="row2"><div class="field">教室<input id="ieRoom" value="' + esc(c.room) + '"></div><div class="field">教师<input id="ieTeacher" value="' + esc(c.teacher) + '"></div></div>';
  html += '<div class="sheet-actions"><button class="btn primary" data-action="imp-save" data-i="' + index + '">保存修改</button><button class="btn" data-action="imp-back">返回列表</button></div>';
  html += '</div>';
  $('impPreview').innerHTML = html;
}
function saveImportEdit(index) {
  var c = importState.courses[index];
  if (!c) return;
  c.name = ($('ieName').value || '').trim() || c.name;
  c.day = +$('ieDay').value;
  c.start = +$('ieStart').value;
  c.end = +$('ieEnd').value;
  if (c.end < c.start) c.end = c.start;
  c.weeks = ($('ieWeeks').value || '全周').trim();
  c.room = ($('ieRoom').value || '').trim();
  c.teacher = ($('ieTeacher').value || '').trim();
  renderImportPreview();
  toast('已修改');
}
function applyImport(mode) {
  var list = importState.courses;
  if (!list.length) { toast('没有可导入的课程'); return; }
  var newCourses = list.map(function (c) {
    var same = state.classes.courses.find(function (x) { return x.day === c.day && x.start === c.start && x.end === c.end && x.name === c.name; });
    return {
      id: same ? same.id : ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
      name: c.name, teacher: c.teacher, room: c.room,
      day: c.day, start: c.start, end: c.end, weeks: c.weeks,
      color: same ? same.color : Math.floor(Math.random() * PALETTE.length)
    };
  });
  if (mode === 'replace') {
    state.classes.courses = newCourses;
  } else {
    var merged = state.classes.courses.slice();
    newCourses.forEach(function (c) {
      var idx = merged.findIndex(function (x) { return x.day === c.day && x.start === c.start && x.end === c.end && x.name === c.name; });
      if (idx >= 0) merged[idx] = c; else merged.push(c);
    });
    state.classes.courses = merged;
  }
  var weekMsg = '';
  if (importState.meta && +importState.meta.weeksTotal > 0) {
    state.classes.meta.weeksTotal = +importState.meta.weeksTotal;
    state.displayWeek = Math.min(Math.max(1, state.displayWeek), state.classes.meta.weeksTotal);
    weekMsg = '，学期总周数已自动设为 ' + state.classes.meta.weeksTotal + ' 周';
  }
  saveClasses();
  closeSheet();
  toast('已导入 ' + newCourses.length + ' 门课' + weekMsg);
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { switchView(t.dataset.view); });
  });
  $('btnTheme').addEventListener('click', toggleTheme);
  $('btnPrevWeek').addEventListener('click', function () {
    var total = +state.classes.meta.weeksTotal || 20;
    state.displayWeek = Math.max(1, state.displayWeek - 1); renderTimetable();
  });
  $('btnNextWeek').addEventListener('click', function () {
    var total = +state.classes.meta.weeksTotal || 20;
    state.displayWeek = Math.min(Math.max(total, state.currentWeek), state.displayWeek + 1); renderTimetable();
  });
  window.addEventListener('resize', function () {
    clearTimeout(bindEvents._rz);
    bindEvents._rz = setTimeout(function () { renderTimetable(); }, 180);
  });
  $('btnToday').addEventListener('click', function () {
    state.displayWeek = weekOf(new Date()); renderTimetable(); toast('已回到今天');
  });
  $('weekPill').addEventListener('click', function () {
    state.displayWeek = weekOf(new Date()); renderTimetable();
  });
  $('btnStartClass').addEventListener('click', function () {
    var id = $('selCourse').value;
    if (!id) { toast('先选择一门课'); return; }
    startClass(id);
  });
  $('btnStopClass').addEventListener('click', stopClass);
  $('btnPhoto').addEventListener('click', function () { $('photoInput').click(); });
  $('photoInput').addEventListener('change', onPhotoPicked);
  $('btnMark').addEventListener('click', addMarker);
  $('btnFinishSave').addEventListener('click', saveFinish);
  $('btnAddCourse').addEventListener('click', function () { openCourseEdit(''); });
  $('btnOpenImport').addEventListener('click', openImportSheet);
  $('btnCheckup').addEventListener('click', function () { window.open('/checkup.html', '_blank'); });
  document.querySelectorAll('[data-assist]').forEach(function (b) {
    b.addEventListener('click', function () {
      var kind = b.dataset.assist;
      if (kind === 'summary') assistSummaryPick();
      if (kind === 'mindmap') assistMindmapPick();
      if (kind === 'todos') assistTodos();
    });
  });
  if ($('btnChatSend')) $('btnChatSend').addEventListener('click', sendChat);
  if ($('chatInput')) $('chatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });
  if ($('btnSaveAi')) $('btnSaveAi').addEventListener('click', saveAiSettings);
  if ($('btnClearChat')) $('btnClearChat').addEventListener('click', clearChat);
  document.querySelectorAll('[data-quick]').forEach(function (b) {
    b.addEventListener('click', function () {
      var i = $('chatInput');
      if (!i) return;
      i.value = b.dataset.quick || '';
      sendChat();
    });
  });
  var noteSearch = $('noteSearch');
  if (noteSearch) {
    noteSearch.addEventListener('input', function () {
      clearTimeout(bindEvents._sq);
      bindEvents._sq = setTimeout(function () {
        state.noteQuery = noteSearch.value || '';
        renderNotes();
      }, 200);
    });
  }
  $('btnAddNoteFab').addEventListener('click', openAddNoteMenu);
  $('btnNoteSelCancel').addEventListener('click', noteSelExit);
  $('btnNoteSelAll').addEventListener('click', noteSelAll);
  $('btnNoteSelInvert').addEventListener('click', noteSelInvert);
  $('btnNoteMove').addEventListener('click', noteMoveToFolder);
  $('btnNoteDelete').addEventListener('click', noteSelDelete);
  bindMergeEntries();
  bindAppToken();
  window.addEventListener('hashchange', function () {
    var rr = parseRoute();
    if (rr.route === state.view && paramsKey(rr.params) === paramsKey(state.routeParams)) return;
    applyRoute(rr);
  });
  $('btnExportIcs').addEventListener('click', exportIcs);
  (function bindImportHelp() {
    var btn = $('btnImportHelp');
    var panel = $('importHelpPanel');
    if (!btn || !panel) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.toggle('show');
    });
    document.addEventListener('click', function (e) {
      if (!panel.classList.contains('show')) return;
      if (panel.contains(e.target) || e.target === btn) return;
      panel.classList.remove('show');
    });
  })();
  $('btnExportClasses').addEventListener('click', exportClassesJson);
  $('btnImportClasses').addEventListener('click', function () { $('classesFile').click(); });
  $('classesFile').addEventListener('change', onClassesFilePicked);
  $('btnPurgeSessions').addEventListener('click', purgeSessions);
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('themeSelect').addEventListener('change', function () { applyTheme($('themeSelect').value); });
  $('transcribeModel').addEventListener('change', function () {
    localStorage.setItem('kb-tr-model', $('transcribeModel').value);
    toast('转写模式：' + ($('transcribeModel').value === 'fast' ? '快速' : '清晰'));
  });
  $('sheetMask').addEventListener('click', closeSheet);
  $('finishMask').addEventListener('click', function () { toast('点「保存笔记」完成本课记录'); });
  $('sheetBody').addEventListener('click', function (e) {
    var act = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!act) return;
    var action = act.dataset.action;
    if (action === 'close-sheet') closeSheet();
    if (action === 'start-course') { closeSheet(); switchView('class'); setTimeout(function () { startClass(act.dataset.id); }, 250); }
    if (action === 'save-note') saveNoteInline(act.dataset.sid);
    if (action === 'del-note') deleteNote(act.dataset.sid);
    if (action === 'transcribe') doTranscribe(act.dataset.sid, false);
    if (action === 'transcribe-ai') doTranscribe(act.dataset.sid, true);
    if (action === 'ai-note' || action === 'ai-note-regen') doAiNote(act.dataset.sid);
    if (action === 'transcript-edit') startEditTranscript(act.dataset.sid);
    if (action === 'transcript-save') saveTranscript(act.dataset.sid);
    if (action === 'export-md') exportNoteMarkdown(act.dataset.sid);
    if (action === 'save-course') saveCourseEdit(act.dataset.id);
    if (action === 'imp-ai') doImportRecognize('ai');
    if (action === 'imp-local') doImportRecognize('local');
    if (action === 'imp-del') importDelete(+act.dataset.i);
    if (action === 'imp-edit') renderImportEdit(+act.dataset.i);
    if (action === 'imp-save') saveImportEdit(+act.dataset.i);
    if (action === 'imp-back') renderImportPreview();
    if (action === 'resume-chunks') resumeChunks();
    if (action === 'discard-chunks') discardChunks();
    if (action === 'resume-finish') resumeFinish(act.dataset.sid);
    if (action === 'resume-del') resumeDelete(act.dataset.sid);
    if (action === 'assist-summary') doAssistSummary(act.dataset.sid);
    if (action === 'assist-mindmap') doAssistMindmap(act.dataset.cid);
    if (action === 'imp-apply-merge') applyImport('merge');
    if (action === 'imp-apply-replace') applyImport('replace');
    if (action === 'custom-note-edit') editCustomNote(act.dataset.nid);
    if (action === 'custom-note-del') deleteCustomNote(act.dataset.nid);
    if (action === 'polish-text') doPolishTranscript(act.dataset.sid);
    if (action === 'toggle-raw') togglePolishedView(act.dataset.sid);
    if (action === 'open-source') { closeSheet(); navigate('source', { id: act.dataset.sid }); }
    if (action === 'open-course') { closeSheet(); navigate('course', { name: act.dataset.course }); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeSheet(); }
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.rec && state.rec.recording) {
      toast('切到后台可能中断录音，请回到页面');
    }
    if (!document.hidden && state.rec && state.rec.recording) requestWakeLock();
  });
  window.addEventListener('beforeunload', function (e) {
    if (state.rec && state.rec.recording) {
      e.preventDefault();
      e.returnValue = '正在上课录音，离开可能丢失录音';
      return e.returnValue;
    }
  });
  document.addEventListener('paste', function (e) {
    if (!$('impDrop')) return;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') === 0) {
        var f = items[i].getAsFile();
        if (f) { setImportImage(f); e.preventDefault(); break; }
      }
    }
  });
  window.addEventListener('online', function () { toast('网络已恢复'); });
  window.addEventListener('offline', function () {
    if (state.rec) toast('网络断开：录音仍在本机，恢复后会自动上传');
  });
}

/* ---------------- 启动 ---------------- */
function renderAll() {
  renderTimetable();
  renderClassPage();
  renderNotes();
  renderMe();
}
function hideBoot() {
  var b = $('boot');
  if (!b) return;
  b.classList.add('hide');
  setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 400);
}
function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
  setTimeout(hideBoot, 3500);
  var q = {};
  try { (location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) { if (!kv) return; var p = kv.split('='); q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); }); } catch (e) {}
  applyTheme(q.theme || localStorage.getItem('kb-theme') || 'auto');
  bindEvents();
  var cxOpen = $('btnOpenChaoxing'); if (cxOpen) cxOpen.addEventListener('click', function () { switchView('chaoxing'); });
  var cxBack = $('btnCxBack'); if (cxBack) cxBack.addEventListener('click', function () { switchView('me'); });
  var cxRef = $('btnCxRefresh'); if (cxRef) cxRef.addEventListener('click', function () { loadChaoxing(true); });
  checkAiStatus();
  // 首屏秒开：先用本地缓存渲染，再后台刷新
  var cachedClasses = cacheGet(CACHE_CLASSES);
  var cachedSessions = cacheGet(CACHE_SESSIONS);
  if (cachedClasses) {
    try {
      applyClassesData(cachedClasses);
      if (cachedSessions) state.sessions = cachedSessions;
      renderAll();
      hideBoot();
    } catch (e) {}
  }
  function onLoadError(e) {
    if (String(e && e.message) === 'PIN_REQUIRED') {
      var pin = window.prompt('请输入访问口令（.env 的 CHAT_PIN）');
      if (pin) { localStorage.setItem('kb-pin', pin); location.reload(); return; }
    }
    try { applyRoute(parseRoute()); } catch (e) {}
    renderAll(); hideBoot();
  }
  Promise.all([loadClasses(), loadSessions()]).then(function () {
    applyRoute(parseRoute());
    renderAll();
    hideBoot();
    setTimeout(checkRecovery, 1200);
    setTimeout(checkInstallHint, 3000);
  }).catch(onLoadError);
}
/* ---------------- 学习通 v1（本机 pc-agent 提供，只读） ---------------- */
var CX_ERR_OFFLINE = '学习通服务未启动（需本机 pc-agent 在线）';
var CX_POLL_MS = 3000;
var CX_POLL_MAX = 40;
var cxPoll = null;
var cxLastStatus = null;

function cxErrText(e) {
  var m = String((e && e.message) || '').trim();
  if (!m) return CX_ERR_OFFLINE;
  if (/not found|failed to fetch|networkerror|load failed|econnrefused|etimedout|unexpected token|json|^http 5\d\d$|连不上/i.test(m)) return CX_ERR_OFFLINE;
  return m;
}
function cxReq(path, opts) {
  opts = opts || {};
  return fetch(path, { method: opts.method || 'GET', headers: appTokenHeaders({ 'Content-Type': 'application/json' }) })
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j || {};
      });
    });
}
function cxSetStatus(text) { var el = $('cxStatus'); if (el) el.textContent = text; }
function cxSetEntry(text) { var el = $('cxEntryState'); if (el) el.textContent = text; }
function cxSetState(text, mode) {
  var el = $('cxStateTag');
  if (el) { el.textContent = text; el.className = 'cx-state' + (mode ? ' ' + mode : ''); }
  var dot = $('cxDot');
  if (dot) dot.className = 'cx-dot' + (mode === 'on' ? ' on' : mode === 'warn' ? ' warn' : mode === 'off' ? ' err' : '');
}
function cxShowError(text) {
  var el = $('cxError');
  if (!el) return;
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = text;
}
function cxClearActions() { var a = $('cxActions'); if (a) a.innerHTML = ''; }
function cxBtn(label, fn, primary) {
  var a = $('cxActions'); if (!a) return;
  var b = document.createElement('button');
  b.className = 'cx-btn' + (primary ? ' primary' : '');
  b.textContent = label;
  b.addEventListener('click', fn);
  a.appendChild(b);
}
function cxStatusData(res) {
  var d = (res && (res.data || res)) || {};
  var running = d.running;
  if (running === undefined) running = d.online;
  if (running === undefined && d.service && typeof d.service === 'object') running = d.service.running;
  if (running === undefined && d.service && typeof d.service === 'string') running = d.service;
  if (running === undefined) running = true; /* 接口能回包就当服务在 */
  var loggedIn = d.loggedIn;
  if (loggedIn === undefined) loggedIn = d.logged_in;
  if (loggedIn === undefined) loggedIn = d.isLogin;
  if (loggedIn === undefined) loggedIn = d.signedIn;
  if (loggedIn === undefined) {
    loggedIn = /^(logged_?in|logged|ok|success|ready|online)$/i.test(String(d.state || d.status || '').trim());
  } else if (typeof loggedIn === 'string') {
    loggedIn = /^(logged_?in|logged|ok|success|ready|online|yes|1|true)$/i.test(loggedIn.trim());
  } else {
    loggedIn = !!loggedIn;
  }
  var u = d.user || d.account || d.profile || {};
  var name = String((u && (u.name || u.nickname || u.userName || u.realName)) || d.userName || d.nickname || '');
  return {
    running: !(running === false || running === 0 || running === '0' || running === 'false' || running === 'off' || running === 'stopped'),
    loggedIn: !!loggedIn,
    user: name
  };
}
function cxSetEmptyAll(text) {
  ['cxHw', 'cxNotice', 'cxExam', 'cxProgress'].forEach(function (id) {
    var box = $(id);
    if (box) { box.className = 'cx-empty'; box.textContent = text; }
  });
  ['cxHwCount', 'cxNoticeCount', 'cxExamCount', 'cxProgressCount'].forEach(function (id) {
    var c = $(id);
    if (c) c.textContent = '';
  });
}
function cxShowOffline(reason) {
  cxLastStatus = null;
  cxSetEntry('未连接');
  cxSetState('未启动', 'off');
  cxSetStatus('未启动：本机学习通服务没有响应');
  cxShowError(reason || CX_ERR_OFFLINE);
  cxClearActions();
  cxBtn('重新检查', function () { loadChaoxing(true); }, true);
  cxSetEmptyAll('服务未启动，暂时没有数据');
}
function cxShowLogin() {
  cxSetEntry('未登录');
  cxSetState('未登录', 'warn');
  cxSetStatus('未登录：在电脑上打开登录页，扫码或账号登录后自动同步');
  cxShowError('');
  cxClearActions();
  cxBtn('在电脑上打开登录页', function () { cxStartLogin(); }, true);
  cxSetEmptyAll('登录后显示');
}
function cxShowLogged(sub) {
  var name = (cxLastStatus && cxLastStatus.user) || '';
  cxSetEntry('已登录');
  cxSetState('已登录', 'on');
  cxSetStatus('已登录' + (name ? '：' + name : '') + (sub ? ' · ' + sub : ''));
  cxShowError('');
  cxClearActions();
  cxBtn('刷新数据', function () { loadChaoxing(true); });
  cxBtn('退出登录', function () { cxLogout(); });
}
function cxStartLogin() {
  cxSetStatus('正在唤起电脑端登录页…');
  cxShowError('');
  cxReq('/api/chaoxing/login/start', { method: 'POST' }).then(function (r) {
    if (r && r.ok === false) { cxShowError(cxErrText(new Error(r.error || '打开登录页失败'))); return; }
    cxSetStatus('二维码已在电脑弹出：请在电脑确认，本页每 3 秒检查一次（最多 40 次）');
    pollLogin();
  }).catch(function (e) {
    var msg = cxErrText(e);
    if (msg === CX_ERR_OFFLINE) { cxShowOffline(msg); return; }
    cxSetStatus('发起登录失败：' + msg);
    cxShowError(msg);
  });
}
function cxLogout() {
  cxReq('/api/chaoxing/logout', { method: 'POST' }).then(function (r) {
    if (r && r.ok === false) { toast(r.error || '退出失败'); return; }
    toast('已退出学习通');
    cxStopPoll();
    cxLastStatus = null;
    cxShowLogin();
  }).catch(function (e) {
    var msg = cxErrText(e);
    toast('退出失败：' + msg);
    if (msg === CX_ERR_OFFLINE) cxShowOffline(msg);
  });
}
function cxStopPoll() {
  if (cxPoll) { clearInterval(cxPoll); cxPoll = null; }
}
function pollLogin() {
  cxStopPoll();
  var n = 0;
  cxPoll = setInterval(function () {
    n++;
    if (n > CX_POLL_MAX) {
      cxStopPoll();
      cxSetStatus('登录轮询超时（约 2 分钟），请点刷新重试');
      return;
    }
    cxReq('/api/chaoxing/login/status').then(function (r) {
      var d = cxStatusData(r);
      if (d.loggedIn) {
        cxStopPoll();
        cxSetStatus('已登录，正在读取数据…');
        toast('学习通已登录');
        loadChaoxing(true);
      }
    }).catch(function () { /* 单次失败不打断，等下一轮 */ });
  }, CX_POLL_MS);
}
function loadChaoxing(force) {
  cxSetStatus('检查中…');
  cxSetState('检查中');
  cxShowError('');
  cxClearActions();
  cxReq('/api/chaoxing/status').then(function (st) {
    var d = cxStatusData(st);
    cxLastStatus = d;
    if (!d.running) { cxShowOffline(); return null; }
    if (!d.loggedIn) { cxShowLogin(); return null; }
    cxShowLogged('正在同步作业 / 通知 / 考试 / 任务点…');
    return cxReq('/api/chaoxing/summary' + (force ? '?force=1' : '')).then(function (sum) {
      cxRenderSummary(sum);
    });
  }).catch(function (e) {
    var msg = cxErrText(e);
    if (/未登录|未登陆|need login/i.test(msg)) { cxShowLogin(); return; }
    cxShowOffline(msg);
  });
}
function cxArr(d, names) { for (var i = 0; i < names.length; i++) { if (d && Array.isArray(d[names[i]])) return d[names[i]]; } return []; }
function cxRenderSummary(sum) {
  var d = (sum && sum.data) || sum || {};
  if (sum && sum.ok === false) {
    var em = cxErrText(new Error(sum.error || ''));
    if (/未登录|未登陆|need login/i.test(em)) cxShowLogin(); else cxShowOffline(em);
    return;
  }
  var hw = cxArr(d, ['homework', 'homeworks', 'assignments', 'works']);
  var notices = cxArr(d, ['notices', 'notice', 'notifications', 'messages']);
  var exams = cxArr(d, ['exams', 'exam', 'examinations']);
  var progress = cxArr(d, ['progress', 'chapters', 'tasks', 'taskPoints']);
  renderList('cxHw', 'cxHwCount', hw, function (x) { return (x.course ? x.course + ' · ' : '') + (x.title || x.name || x.text || '') + (x.due ? '（截止 ' + x.due + '）' : ''); }, '暂无作业或互评任务');
  renderList('cxNotice', 'cxNoticeCount', notices, function (x) { return (x.course ? '[' + x.course + '] ' : '') + (x.title || x.content || x.text || ''); }, '暂无老师通知');
  renderList('cxExam', 'cxExamCount', exams, function (x) { return (x.course ? x.course + ' · ' : '') + (x.title || x.name || '') + (x.time ? ' @ ' + x.time : ''); }, '暂无考试安排');
  renderList('cxProgress', 'cxProgressCount', progress, function (x) { return (x.course || x.name || '') + ' ' + (x.percent != null ? x.percent + '%' : (x.done != null && x.total != null ? x.done + '/' + x.total : '')); }, '暂无章节任务点');
  var now = new Date();
  var total = hw.length + notices.length + exams.length + progress.length;
  cxShowLogged((total ? '共 ' + total + ' 条 · ' : '') + '更新于 ' + pad(now.getHours()) + ':' + pad(now.getMinutes()));
}
function renderList(boxId, countId, list, fmt, emptyText) {
  var box = $(boxId); if (!box) return;
  if (!list.length) {
    box.className = 'cx-empty';
    box.textContent = emptyText || '暂无数据';
  } else {
    box.className = 'cx-list';
    box.innerHTML = list.slice(0, 30).map(function (x) {
      var txt = '';
      try { txt = fmt(x) || ''; } catch (e) { txt = ''; }
      return '<div class="cx-item">' + esc(txt) + '</div>';
    }).join('');
  }
  var c = countId ? $(countId) : null;
  if (c) c.textContent = list.length ? '(' + list.length + ')' : '';
}

/* ---------------- 合并版 P2：原始素材 / 课程总纲 / 待办 ---------------- */
var srcState = { id: '', data: null, usingLocal: false, seq: 0, activeSeg: -1, objectUrl: null };
var courseState = { name: '', seq: 0 };
var todoState = { items: [], seq: 0 };

function appToken() {
  try { return String(localStorage.getItem('kb-app-token') || '').trim(); } catch (e) { return ''; }
}
function appTokenState() {
  var el = $('appTokenState');
  if (!el) return;
  el.textContent = appToken() ? '已设置' : '未设置';
}
function bindAppToken() {
  var input = $('appToken');
  if (input) input.value = appToken();
  appTokenState();
  var save = $('btnSaveToken');
  if (save) save.addEventListener('click', saveAppToken);
  var clr = $('btnClearToken');
  if (clr) clr.addEventListener('click', clearAppToken);
}
function saveAppToken() {
  var input = $('appToken');
  var v = input ? String(input.value || '').trim() : '';
  try {
    if (v) localStorage.setItem('kb-app-token', v);
    else localStorage.removeItem('kb-app-token');
  } catch (e) {}
  appTokenState();
  nativeSetToken(v);
  toast(v ? '令牌已保存' : '已清除令牌');
  appTokenChanged();
}
function clearAppToken() {
  var input = $('appToken');
  if (input) input.value = '';
  try { localStorage.removeItem('kb-app-token'); } catch (e) {}
  appTokenState();
  nativeSetToken('');
  toast('已清除令牌');
  appTokenChanged();
}
function nativeSetToken(v) {
  try {
    if (window.ClassroomNative && typeof window.ClassroomNative.setToken === 'function') {
      window.ClassroomNative.setToken(v || '');
    }
  } catch (e) {}
}
function appTokenChanged() {
  if (state.view === 'source') { srcState.data = null; renderSourcePage(); }
  if (state.view === 'course') { state.notesCache = null; state.notesFallback = false; renderCoursePage(); }
  if (state.view === 'todo') renderTodoPage(true);
}
function bindMergeEntries() {
  var b = $('btnOpenCourseIndex');
  if (b) b.addEventListener('click', function () { navigate('course', {}); });
  b = $('btnOpenTodoPage');
  if (b) b.addEventListener('click', function () { navigate('todo', {}); });
  b = $('btnSourceBack');
  if (b) b.addEventListener('click', function () { switchView('notes'); });
  b = $('btnSourceRefresh');
  if (b) b.addEventListener('click', function () { srcReload(); });
  b = $('btnCourseBack');
  if (b) b.addEventListener('click', function () { switchView('notes'); });
  b = $('btnCourseRefresh');
  if (b) b.addEventListener('click', function () { courseRefresh(); });
  b = $('btnTodoBack');
  if (b) b.addEventListener('click', function () { switchView('notes'); });
  b = $('btnTodoRefresh');
  if (b) b.addEventListener('click', function () { renderTodoPage(true); });
}

/* ---------------- 原始素材页 ---------------- */
function srcFileUrl(item, kind) {
  var id = srcState.id;
  if (!id) return '';
  var name = item && item.name ? item.name : '';
  if (srcState.usingLocal) {
    return '/api/media/' + encodeURIComponent(id) + '/' + (kind === 'photos' ? 'photos' : 'rec') + '/' + encodeURIComponent(name);
  }
  return '/api/file?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name);
}
function srcWhen(ts) {
  if (!ts) return '';
  var d = new Date(typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : ts);
  if (isNaN(d.getTime())) return String(ts);
  return fmtDateTime(d.getTime());
}
function srcToSec(v) {
  var n = Number(v);
  if (!isFinite(n) || n < 0) n = 0;
  return n > 20000 ? n / 1000 : n;
}
function srcShowError(text) {
  var el = $('sourceError');
  if (!el) return;
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = text;
}
function srcHideError() { srcShowError(''); }
function srcStopAudio() {
  var a = $('sourceAudio');
  if (!a) return;
  try { a.pause(); } catch (e) {}
}
function srcResetPlayer() {
  srcStopAudio();
  var wrap = $('sourceAudioWrap');
  if (wrap) wrap.classList.add('hidden');
  var a = $('sourceAudio');
  if (a) {
    a.onerror = null;
    a.onloadedmetadata = null;
    try { a.removeAttribute('src'); a.load(); } catch (e) {}
  }
  if (srcState.objectUrl) {
    try { URL.revokeObjectURL(srcState.objectUrl); } catch (e) {}
    srcState.objectUrl = null;
  }
  srcState.activeSeg = -1;
}
function srcLoading() {
  ['sourceSegments', 'sourceTranscript', 'sourcePhotos'].forEach(function (id) {
    var el = $(id);
    if (el) el.innerHTML = '<div class="src-empty">加载中…</div>';
  });
  ['sourceSegCount', 'sourceTrCount', 'sourcePhotoCount'].forEach(function (id) {
    var el = $(id);
    if (el) el.textContent = '';
  });
}
function srcEmptyAll(msg) {
  ['sourceSegments', 'sourceTranscript', 'sourcePhotos'].forEach(function (id) {
    var el = $(id);
    if (el) el.innerHTML = '<div class="src-empty">' + esc(msg) + '</div>';
  });
  ['sourceSegCount', 'sourceTrCount', 'sourcePhotoCount'].forEach(function (id) {
    var el = $(id);
    if (el) el.textContent = '';
  });
}
function srcNormalizeSource(id, j) {
  j = j || {};
  var meta = j.meta || {};
  return {
    id: id,
    meta: meta,
    transcript: j.transcript || null,
    segments: Array.isArray(j.segments) ? j.segments : (Array.isArray(meta.segments) ? meta.segments : []),
    photos: Array.isArray(j.photos) ? j.photos : (Array.isArray(meta.photos) ? meta.photos : [])
  };
}
function srcLocalData(id) {
  var s = null;
  (state.sessions || []).forEach(function (x) { if (!s && x.id === id) s = x; });
  if (!s) return null;
  var tr = null;
  if (s.transcript && (s.transcript.text || (s.transcript.segments || []).length)) {
    tr = { text: s.transcript.text || '', segments: s.transcript.segments || [] };
  }
  return {
    id: id,
    meta: { course: s.courseName, courseName: s.courseName, title: s.courseName, startedAt: s.startedAt, durationMs: s.durationMs, room: s.room },
    transcript: tr,
    segments: s.segments || [],
    photos: s.photos || []
  };
}
function renderSourcePage() {
  var id = (state.routeParams && state.routeParams.id) || '';
  srcResetPlayer();
  var titleEl = $('sourceTitle');
  if (titleEl) titleEl.textContent = '原始素材';
  var subEl = $('sourceSub');
  if (subEl) subEl.textContent = '录音 · 文字稿 · 板书';
  if (!id) {
    srcState.id = '';
    srcState.data = null;
    srcHideError();
    srcEmptyAll('缺少会话 ID，请从「笔记详情」点「原始素材」进入');
    return;
  }
  srcLoad(id, false);
}
function srcLoad(id, force) {
  if (!force && srcState.data && srcState.id === id) { srcRender(srcState.data); return; }
  var seq = ++srcState.seq;
  srcState.id = id;
  srcState.data = null;
  srcState.usingLocal = false;
  srcResetPlayer();
  srcHideError();
  srcLoading();
  var subEl = $('sourceSub');
  if (subEl) subEl.textContent = '加载中…';
  api('/api/source?id=' + encodeURIComponent(id)).then(function (j) {
    if (seq !== srcState.seq) return;
    srcState.data = srcNormalizeSource(id, j);
    srcRender(srcState.data);
  }).catch(function (e) {
    if (seq !== srcState.seq) return;
    var local = srcLocalData(id);
    if (local) {
      srcState.usingLocal = true;
      srcState.data = local;
      srcRender(local);
      srcShowError('新素材接口暂不可用（' + ((e && e.message) || '网络错误') + '），已改用本机已加载的课堂数据。');
    } else {
      srcState.data = null;
      srcEmptyAll('暂时取不到原始素材：' + ((e && e.message) || '网络错误'));
      srcShowError('原始素材接口暂未就绪，或这节课没有录音 / 文字稿 / 板书。');
    }
  });
}
function srcReload() {
  var id = (state.routeParams && state.routeParams.id) || srcState.id;
  if (id) srcLoad(id, true);
  else renderSourcePage();
}
function srcRender(data) {
  if (!data) return;
  var meta = data.meta || {};
  var title = meta.courseName || meta.course || meta.title || '原始素材';
  var titleEl = $('sourceTitle');
  if (titleEl) titleEl.textContent = title;
  var bits = [];
  var when = srcWhen(meta.startedAt);
  if (when) bits.push(when);
  var dur = Number(meta.durationMs) || 0;
  if (dur > 0) bits.push('时长 ' + fmtDur(dur));
  if (meta.room) bits.push(String(meta.room));
  if (srcState.usingLocal) bits.push('本机数据');
  var subEl = $('sourceSub');
  if (subEl) subEl.textContent = bits.length ? bits.join(' · ') : '录音 · 文字稿 · 板书';
  srcRenderSegments(data.segments || []);
  srcRenderTranscript(data.transcript);
  srcRenderPhotos(data.photos || []);
}
function srcRenderSegments(segs) {
  var box = $('sourceSegments');
  if (!box) return;
  var count = $('sourceSegCount');
  if (count) count.textContent = segs.length ? segs.length + ' 段' : '';
  if (!segs.length) {
    box.innerHTML = '<div class="src-empty">这节课没有录音分段</div>';
    return;
  }
  box.innerHTML = segs.map(function (sg, i) {
    var size = Number(sg.size || sg.bytes || 0);
    var sizeText = '';
    if (size > 0) sizeText = size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(size / 1024)) + ' KB';
    var off = Math.max(0, Number(sg.offsetMs) || 0);
    return '<div class="src-seg" data-seg-row="' + i + '">' +
      '<button class="src-play" data-seg-play="' + i + '" aria-label="播放第 ' + (i + 1) + ' 段">▶</button>' +
      '<div class="src-seg-main"><div class="src-seg-t">第 ' + (i + 1) + ' 段 · ' + fmtClock(off) + '</div>' +
      '<div class="src-seg-s">' + esc(sizeText || sg.name || '') + '</div></div></div>';
  }).join('');
  box.querySelectorAll('[data-seg-play]').forEach(function (b) {
    b.addEventListener('click', function () { srcPlaySegment(Number(b.dataset.segPlay), 0); });
  });
}
function srcRenderTranscript(tr) {
  var box = $('sourceTranscript');
  if (!box) return;
  var count = $('sourceTrCount');
  var lines = tr && Array.isArray(tr.segments) ? tr.segments : [];
  if (!lines.length) {
    if (count) count.textContent = '';
    if (tr && tr.text) {
      if (count) count.textContent = '全文';
      box.innerHTML = '<div class="src-note">' + esc(tr.text) + '</div>';
    } else {
      box.innerHTML = '<div class="src-empty">还没有文字稿。回笔记详情可以点「直接转文字」。</div>';
    }
    return;
  }
  if (count) count.textContent = lines.length + ' 句';
  box.innerHTML = lines.map(function (ln, i) {
    var sec = srcToSec(ln.start);
    return '<button class="src-line" data-line-i="' + i + '" data-sec="' + sec + '">' +
      '<span class="src-line-t">' + fmtClock(sec * 1000) + '</span>' +
      '<span class="src-line-x">' + esc(ln.text || '') + '</span></button>';
  }).join('');
  box.querySelectorAll('[data-line-i]').forEach(function (b) {
    b.addEventListener('click', function () { srcSeekTo(Number(b.dataset.sec), b); });
  });
}
function srcRenderPhotos(photos) {
  var box = $('sourcePhotos');
  if (!box) return;
  var count = $('sourcePhotoCount');
  if (count) count.textContent = photos.length ? photos.length + ' 张' : '';
  if (!photos.length) {
    box.innerHTML = '<div class="src-empty">这节课没有板书照片</div>';
    return;
  }
  box.innerHTML = photos.map(function (p, i) {
    return '<figure class="src-photo"><img loading="lazy" alt="板书 ' + (i + 1) + '" data-photo-i="' + i + '">' +
      '<figcaption>' + fmtClock(Math.max(0, Number(p.offsetMs) || 0)) + '</figcaption></figure>';
  }).join('');
  box.querySelectorAll('[data-photo-i]').forEach(function (img) {
    var i = Number(img.dataset.photoI);
    var p = photos[i];
    var url = srcFileUrl(p, 'photos');
    img.dataset.full = url;
    img.addEventListener('click', function () { if (img.dataset.full) window.open(img.dataset.full, '_blank'); });
    img.onerror = function () {
      img.onerror = null;
      srcFetchMedia(url).then(function (blob) {
        var bu = URL.createObjectURL(blob);
        img.src = bu;
        img.dataset.full = bu;
      }).catch(function () { img.alt = '照片加载失败'; });
    };
    img.src = url;
  });
}
function srcPlaySegment(index, atSec) {
  var data = srcState.data;
  if (!data || !data.segments || !data.segments[index]) return;
  var wrap = $('sourceAudioWrap');
  if (wrap) wrap.classList.remove('hidden');
  srcState.activeSeg = index;
  document.querySelectorAll('#sourceSegments .src-seg').forEach(function (row, i) {
    row.classList.toggle('active', i === index);
  });
  srcSetAudioSrc(srcFileUrl(data.segments[index], 'rec'), atSec);
}
function srcSetAudioSrc(url, atSec, isBlob) {
  var audio = $('sourceAudio');
  if (!audio || !url) return;
  if (!isBlob) {
    if (srcState.objectUrl) {
      try { URL.revokeObjectURL(srcState.objectUrl); } catch (e) {}
      srcState.objectUrl = null;
    }
  }
  var pending = Math.max(0, Number(atSec) || 0);
  audio.onerror = null;
  audio.onloadedmetadata = function () {
    audio.onloadedmetadata = null;
    if (pending > 0) { try { audio.currentTime = pending; } catch (e) {} }
    var pr = audio.play();
    if (pr && pr.catch) pr.catch(function () {});
  };
  if (!isBlob) {
    audio.onerror = function () {
      audio.onerror = null;
      srcFetchMedia(url).then(function (blob) {
        var bu = URL.createObjectURL(blob);
        srcState.objectUrl = bu;
        srcSetAudioSrc(bu, pending, true);
      }).catch(function (e) { toast('音频加载失败：' + ((e && e.message) || '网络错误')); });
    };
  }
  audio.src = url;
  try { audio.load(); } catch (e) {}
}
function srcFetchMedia(url) {
  return fetch(url, { headers: appTokenHeaders() }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var ct = (res.headers && res.headers.get ? res.headers.get('content-type') : '') || '';
    if (ct.indexOf('application/json') >= 0) throw new Error('接口返回了 JSON');
    return res.blob();
  });
}
function srcSeekTo(sec, btn) {
  var data = srcState.data;
  if (!data) return;
  var secs = srcToSec(sec);
  var segs = data.segments || [];
  var ms = secs * 1000;
  var idx = -1;
  var off = 0;
  for (var i = 0; i < segs.length; i++) {
    var o = Number(segs[i].offsetMs) || 0;
    var nx = i + 1 < segs.length ? (Number(segs[i + 1].offsetMs) || 0) : Infinity;
    if (ms >= o && ms < nx) { idx = i; off = (ms - o) / 1000; break; }
  }
  if (idx < 0 && segs.length) {
    var first = Number(segs[0].offsetMs) || 0;
    var last = Number(segs[segs.length - 1].offsetMs) || 0;
    if (ms < first) { idx = 0; off = 0; }
    else { idx = segs.length - 1; off = Math.max(0, secs - last / 1000); }
  }
  if (idx >= 0) srcPlaySegment(idx, off);
  else toast('这节课没有录音分段，不能跳转');
  var box = $('sourceTranscript');
  if (box) box.querySelectorAll('.src-line').forEach(function (x) { x.classList.remove('active'); });
  if (btn) btn.classList.add('active');
}

/* ---------------- 课程总纲页 ---------------- */
function courseSetHeader(title, sub) {
  var t = $('courseTitle');
  if (t) t.textContent = title;
  var s = $('courseSub');
  if (s) s.textContent = sub;
}
function courseShowError(text) {
  var el = $('courseError');
  if (!el) return;
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = text;
}
function courseFoot(text) {
  var el = $('courseFoot');
  if (el) el.textContent = text;
}
function courseShowStats(show) {
  var el = $('courseStats');
  if (el) el.classList.toggle('hidden', !show);
}
function courseApplyStats(list) {
  var photos = 0;
  var dur = 0;
  list.forEach(function (n) {
    photos += Number(n.photoCount) || 0;
    dur += Number(n.durationMs) || 0;
  });
  var a = $('courseStatNotes');
  if (a) a.textContent = String(list.length);
  var b = $('courseStatPhotos');
  if (b) b.textContent = String(photos);
  var c = $('courseStatDur');
  if (c) c.textContent = dur > 0 ? fmtDur(dur) : '0 分';
}
function localNotes() {
  return (state.sessions || []).filter(function (s) {
    return s.status === 'done' || s.status === 'recording';
  }).map(function (s) {
    return {
      id: s.id,
      course: s.courseName || '',
      title: s.courseName || '课堂记录',
      state: s.status,
      summary: s.summary || s.note || (s.aiNote && s.aiNote.summary) || '',
      startedAt: s.startedAt || 0,
      durationMs: s.durationMs || 0,
      photoCount: (s.photos || []).length,
      segmentCount: (s.segments || []).length,
      hasNote: !!s.note
    };
  });
}
function courseFetchNotes(force) {
  if (!force && state.notesCache && !state.notesFallback) {
    return Promise.resolve({ notes: state.notesCache, fallback: false });
  }
  return api('/api/notes').then(function (j) {
    var notes = Array.isArray(j.notes) ? j.notes : [];
    state.notesCache = notes;
    state.notesFallback = false;
    return { notes: notes, fallback: false };
  }).catch(function (e) {
    var local = localNotes();
    state.notesCache = local;
    state.notesFallback = true;
    return { notes: local, fallback: true, error: e };
  });
}
function courseGroup(notes) {
  var map = {};
  var order = [];
  (notes || []).forEach(function (n) {
    n = n || {};
    var name = String(n.course || '').trim() || '未命名课程';
    if (!map[name]) {
      map[name] = { name: name, count: 0, photos: 0, durationMs: 0, last: 0 };
      order.push(name);
    }
    var g = map[name];
    g.count++;
    g.photos += Number(n.photoCount) || 0;
    g.durationMs += Number(n.durationMs) || 0;
    var at = Number(n.startedAt) || 0;
    if (at > g.last) g.last = at;
  });
  return order.map(function (name) { return map[name]; }).sort(function (a, b) { return b.last - a.last; });
}
function renderCoursePage() {
  var name = (state.routeParams && state.routeParams.name) || '';
  courseState.name = String(name || '').trim();
  if (courseState.name) courseLoad(courseState.name, false);
  else courseLoadList(false);
}
function courseRefresh() {
  if (courseState.name) courseLoad(courseState.name, true);
  else courseLoadList(true);
}
function courseLoadList(force) {
  var seq = ++courseState.seq;
  courseSetHeader('课程总纲', '按课程汇总所有笔记');
  courseShowStats(false);
  courseShowError('');
  courseFoot('加载中…');
  var box = $('courseListBox');
  if (box) {
    box.className = 'list';
    box.innerHTML = '<div class="src-empty">加载中…</div>';
  }
  courseFetchNotes(force).then(function (res) {
    if (seq !== courseState.seq) return;
    var notes = res.notes || [];
    var groups = courseGroup(notes);
    if (res.fallback) courseShowError('笔记接口暂不可用（' + ((res.error && res.error.message) || '网络错误') + '），下面改用本机已加载的课堂数据。');
    else courseShowError('');
    courseSetHeader('课程总纲', groups.length ? '共 ' + groups.length + ' 门课 · ' + notes.length + ' 条笔记' : '按课程汇总所有笔记');
    courseFoot(res.fallback ? '新接口未联调，以上是从本机缓存聚合出来的记录。' : '课程总纲由笔记聚合而成，点条目进入课程。');
    if (!box) return;
    if (!groups.length) {
      box.className = 'list';
      box.innerHTML = '<div class="src-empty">还没有笔记。去「课堂」上第一节课，或在「笔记」页新建一条。</div>';
      return;
    }
    box.className = 'list';
    box.innerHTML = groups.map(function (g) {
      return '<button class="item" data-course-open="' + esc(g.name) + '"><div class="item-main">' +
        '<div class="item-title">' + esc(g.name) + '</div>' +
        '<div class="item-sub">' + g.count + ' 条笔记 · ' + g.photos + ' 张照片 · ' + fmtDur(g.durationMs) + '</div>' +
        '</div><span class="item-arrow">›</span></button>';
    }).join('');
    box.querySelectorAll('[data-course-open]').forEach(function (b) {
      b.addEventListener('click', function () { navigate('course', { name: b.getAttribute('data-course-open') }); });
    });
  });
}
function courseLoad(name, force) {
  var seq = ++courseState.seq;
  courseState.name = name;
  courseSetHeader(name, '课程总纲');
  courseShowStats(true);
  courseShowError('');
  courseFoot('加载中…');
  courseApplyStats([]);
  var box = $('courseListBox');
  if (box) {
    box.className = 'list';
    box.innerHTML = '<div class="src-empty">加载中…</div>';
  }
  courseFetchNotes(force).then(function (res) {
    if (seq !== courseState.seq) return;
    var list = (res.notes || []).filter(function (n) {
      return String((n && n.course) || '').trim() === name;
    });
    list.sort(function (a, b) { return (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0); });
    courseApplyStats(list);
    if (res.fallback) courseShowError('笔记接口暂不可用（' + ((res.error && res.error.message) || '网络错误') + '），下面改用本机已加载的课堂数据。');
    else courseShowError('');
    courseSetHeader(name, '课程总纲 · ' + list.length + ' 条笔记');
    courseFoot(res.fallback ? '新接口未联调，以上是从本机缓存聚合出来的记录。' : '点一条记录进入笔记详情，详情里可看原始素材。');
    if (!box) return;
    if (!list.length) {
      box.className = 'list';
      box.innerHTML = '<div class="src-empty">这门课还没有笔记</div>';
      return;
    }
    box.className = 'list';
    box.innerHTML = list.map(function (n) {
      var id = n.id || '';
      var title = n.title || n.course || '课堂记录';
      var sub = [];
      var when = srcWhen(n.startedAt);
      if (when) sub.push(when);
      if (Number(n.durationMs) > 0) sub.push(fmtDur(Number(n.durationMs)));
      if (Number(n.photoCount) > 0) sub.push(Number(n.photoCount) + ' 张照片');
      if (Number(n.segmentCount) > 0) sub.push(Number(n.segmentCount) + ' 段录音');
      var summary = n.summary || '';
      return '<button class="item" data-note-open="' + esc(id) + '"><div class="item-main">' +
        '<div class="item-title">' + esc(title) + '</div>' +
        '<div class="item-sub">' + esc(sub.join(' · ')) + '</div>' +
        (summary ? '<div class="item-note">' + esc(summary) + '</div>' : '') +
        '</div><span class="item-arrow">›</span></button>';
    }).join('');
    box.querySelectorAll('[data-note-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        var sid = b.getAttribute('data-note-open');
        var hit = null;
        list.forEach(function (x) { if (!hit && x.id === sid) hit = x; });
        openNoteFromIndex(hit || { id: sid });
      });
    });
  });
}
function openNoteFromIndex(n) {
  if (!n) return;
  var sid = n.id || '';
  if (!sid) { toast('这条记录没有会话 ID'); return; }
  var s = null;
  (state.sessions || []).forEach(function (x) { if (!s && x.id === sid) s = x; });
  if (s) { openNoteSheet(sid); return; }
  openIndexNoteSheet(n);
}
function openIndexNoteSheet(n) {
  var sub = [];
  if (n.course) sub.push(n.course);
  var when = srcWhen(n.startedAt);
  if (when) sub.push(when);
  if (Number(n.durationMs) > 0) sub.push('时长 ' + fmtDur(Number(n.durationMs)));
  var html = '<div class="note-detail"><h3>' + esc(n.title || n.course || '课堂记录') + '</h3>';
  html += '<p class="nd-meta">' + esc(sub.join(' · ')) + '</p>';
  if (n.summary) html += '<div class="nd-section">摘要</div><div class="nd-note">' + esc(n.summary) + '</div>';
  else html += '<div class="nd-note nd-empty">这条记录还没有摘要，可以点「原始素材」看录音与文字稿。</div>';
  html += '<div class="sheet-actions" style="margin-top:12px">';
  if (n.id) html += '<button class="btn primary tiny" data-action="open-source" data-sid="' + esc(n.id) + '">原始素材</button>';
  html += '<button class="btn tiny" data-action="close-sheet">关闭</button></div></div>';
  openSheet(html);
}

/* ---------------- 待办页 ---------------- */
function todoShowError(text) {
  var el = $('todoError');
  if (!el) return;
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = text;
}
function todoUpdateCount() {
  var el = $('todoCount');
  if (!el) return;
  var items = todoState.items || [];
  var done = todoDoneSet();
  var n = 0;
  items.forEach(function (it) { if (done.indexOf(todoKey(it)) >= 0) n++; });
  el.textContent = items.length ? ('共 ' + items.length + ' 条 · 已完成 ' + n + ' 条') : '';
}
function todoRender() {
  var box = $('todoListBox');
  if (!box) return;
  var items = todoState.items || [];
  if (!items.length) {
    box.className = 'todo-list';
    box.innerHTML = '<div class="src-empty">暂无待办：AI 助教会从笔记里找作业、截止和考试。</div>';
    todoUpdateCount();
    return;
  }
  var done = todoDoneSet();
  box.className = 'todo-list';
  box.innerHTML = items.map(function (it) {
    var k = todoKey(it);
    var isDone = done.indexOf(k) >= 0;
    var meta = [];
    if (it.course) meta.push(it.course);
    if (it.due) meta.push('截止 ' + it.due);
    return '<div class="todo-item' + (isDone ? ' done' : '') + '" data-todo-key="' + esc(k) + '">' +
      '<span class="todo-check"></span><div class="todo-main">' +
      '<div class="todo-title">' + esc(it.title || '待办') + '</div>' +
      '<div class="todo-sub">' + esc(meta.join(' · ')) + (it.quote ? ' · 「' + esc(it.quote) + '」' : '') + '</div>' +
      '</div></div>';
  }).join('');
  box.querySelectorAll('[data-todo-key]').forEach(function (el) {
    el.addEventListener('click', function () {
      var k = el.getAttribute('data-todo-key');
      var list = todoDoneSet();
      var i = list.indexOf(k);
      if (i >= 0) list.splice(i, 1); else list.push(k);
      try { localStorage.setItem('kb-todo-done', JSON.stringify(list)); } catch (e) {}
      el.classList.toggle('done');
      todoUpdateCount();
    });
  });
  todoUpdateCount();
}
function renderTodoPage(force) {
  var box = $('todoListBox');
  if (!box) return;
  var seq = ++todoState.seq;
  todoShowError('');
  box.className = 'todo-list';
  box.innerHTML = '<div class="src-empty">加载中…</div>';
  var count = $('todoCount');
  if (count) count.textContent = '';
  api('/api/assist/todos').then(function (j) {
    if (seq !== todoState.seq) return;
    todoState.items = Array.isArray(j.items) ? j.items : [];
    todoRender();
  }).catch(function (e) {
    if (seq !== todoState.seq) return;
    todoState.items = [];
    todoRender();
    todoShowError('待办接口暂不可用：' + ((e && e.message) || '网络错误'));
  });
}

document.addEventListener('DOMContentLoaded', init);
