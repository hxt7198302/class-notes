// parse.js —— 把逐行 JSONL 转录结果解析成结构化课程
// 分工: 模型只做"逐行朗读"(每格文字原样, 跨行格子逐行重复), 对位与字段切分全在本文件确定性完成
'use strict';

const DAY_KEYS = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
const CN_DAY = { 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 7, 周天: 7 };

// ---------- 单元格原文 -> 四字段 ----------
// 教室特征: 含#楼号, 或含楼/中心/馆/厅/室关键词, 允许带一层小括号后缀(如 经管中心101(东))
const ROOM_RE = new RegExp('[^\\s,，、()（）]*\\#[^\\s,，、()（）]*|[^\\s,，、()（）]*(?:教学楼|实验楼|中心|楼|馆|厅|室)[^\\s,，、()（）]*(?:[（(][^（）()]{1,8}[）)])?');

function parseCellVerbatim(raw) {
  if (!raw) return null;
  let t = String(raw).split(/\s*\/\s*/).join(' ').split(/\s+/).join(' ').trim();
  if (!t || t === '-' || t === '—') return null;

  // 括号组(不含嵌套)
  const groups = [];
  for (const m of t.matchAll(/[（(]([^（）()]*)[）)]/g)) {
    groups.push({ text: m[1].trim() });
  }

  let teacher = '';
  for (const g of groups) {
    if (/^[\u4e00-\u9fa5·]{2,4}$/.test(g.text) && !/楼|室|中心|周|馆|厅/.test(g.text)) { teacher = g.text; break; }
  }

  // 教室: 优先"楼名+数字#数字"式(教学楼2#201), 否则楼栋关键词式; #式更精确不易带脏字
  let room = '';
  const rh = t.match(/(?:教学楼|实验楼)?\d+#\d+/);
  if (rh) room = rh[0];
  else {
    const rm = t.match(ROOM_RE);
    if (rm) room = rm[0];
  }
  room = room.replace(/^[,，;；\s]+/, '').replace(/[,，;；\s]+$/, '');
  const tNoRoom = room ? t.split(room).join(' ') : t;

  // 周次: 优先取"纯数字符号"的括号组(课代码组含字母先排除), 再退化到去教室后的正文
  const weeksFromText = s => {
    const cand = s.match(/(?:\d{1,2}\s*[-—~]\s*\d{1,2}|\d{1,2})(?:(?:\s*[,，、]\s*|\s+)(?:\d{1,2}\s*[-—~]\s*\d{1,2}|\d{1,2}))*/);
    return cand ? cand[0].split(/\s+/).join(' ').trim() : '';
  };
  let weeks = '';
  for (const g of groups) {
    if (/\d/.test(g.text) && !/[A-Za-z]/.test(g.text)) {
      const gm = g.text.match(ROOM_RE);
      const w = weeksFromText(gm ? g.text.split(gm[0]).join(' ') : g.text);
      if (w) { weeks = w; break; }
    }
  }
  if (!weeks) {
    // 兜底: 去教室后的原文直接找, 带边界守卫(避免吃到课代码/课名里的数字)
    // 且必须"区间"或"至少两段数字"才算周次 —— 单个裸数字(如 学术英语1 的 1)直接否决
    const T = '(?:\\d{1,2}\\s*[-—~]\\s*\\d{1,2}|\\d{1,2})';
    const S = '(?:\\s*[,，、]\\s*|\\s+)';
    const B = '(?<![A-Za-z0-9_.])';
    const E = '(?![0-9A-Za-z_.])';
    // 注意"多段序列"分支放前面: 正则交替先到先得, 单区间分支会短路掉更长的序列
    const cand = tNoRoom.match(new RegExp(B + T + S + T + E + '|' + B + '\\d{1,2}\\s*[-—~]\\s*\\d{1,2}' + E));
    if (cand) weeks = cand[0].split(/\s+/).join(' ').trim();
  }

  // 课程名: 教室/周次/全部括号组去掉后, 剩余若还有中文或字母数字才算课名
  let name = tNoRoom.replace(/[（(][^（）()]*[）)]/g, ' ');
  if (weeks) name = name.split(weeks).join(' ');
  const nameCheck = name.replace(/[^0-9A-Za-z\u4e00-\u9fa5·]/g, '');
  if (!nameCheck) {
    // 没有课名 = 某门课跨多行时"末行"(只有周次/教室的那一行)
    return { name: '', teacher, weeks: normWeeks(weeks), room };
  }
  name = name.replace(/^[^0-9A-Za-z\u4e00-\u9fa5]+/, ''); // 前导杂字符(引号/点/符号)剥到首个文字
  name = name.replace(/[\s/|,，、;；:：（(）)·．]+$/, '').split(/\s+/).join(' ');
  // OCR 常见混淆: 法被拆成"氵去"; "思想"被读成"灬想/灬思"; 课程名尾部的 A1 被读成 AI
  name = name.split('氵去').join('法');
  name = name.split('灬想').join('思想').split('灬思').join('思想');
  name = name.replace(/AI$/, 'A1');
  if (!name) return null;
  return { name, teacher, weeks: normWeeks(weeks), room };
}

function normWeeks(w) {
  const t = (w || '').trim();
  if (!t) return '全周';
  if (/^[\d,，、\s\-—~]+$/.test(t)) {
    let s = t.replace(/周/g, '').replace(/，|、/g, ',').split(/\s+/).join(',')
      .replace(/—|~/g, '-').replace(/-+/g, '-').replace(/,{2,}/g, ',').replace(/^,|,$/g, '');
    // OCR 常丢连字符: 恰好两个数字且差>1 视为区间(1 8 → 1-8); ≥3 个数字视为列举
    const toks = s.split(',').filter(Boolean);
    if (toks.length === 2 && /^\d+$/.test(toks[0]) && /^\d+$/.test(toks[1]) && +toks[1] - +toks[0] > 1) {
      s = toks[0] + '-' + toks[1];
    }
    return s;
  }
  return t; // "单周/双周"等原样交用户改
}

// ---------- JSONL -> 课程 ----------
function parseRowJSONTimetable(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let school = '', semester = '';
  const rows = [];
  for (const line of lines) {
    const s = line.indexOf('{'), e = line.lastIndexOf('}');
    if (s < 0 || e <= s) continue;
    let obj;
    try { obj = JSON.parse(line.slice(s, e + 1)); } catch (err) { continue; }
    if (obj && typeof obj === 'object') rows.push(obj);
  }
  for (const r of rows) {
    if (r.school !== undefined && r.sec === undefined) { school = r.school || ''; semester = r.semester || ''; break; }
  }

  const courses = [];
  const open = {}; // day -> {sig, c}
  let maxSec = 0;
  const closeOpen = day => { const o = open[day]; if (o) { courses.push(o.c); delete open[day]; } };
  for (const r of rows) {
    const sec = Number(r.sec);
    if (!sec || sec < 1) continue;
    if (sec > maxSec) maxSec = sec;
    for (const key of Object.keys(r)) {
      const day = DAY_KEYS[key] || CN_DAY[key];
      if (!day) continue;
      const cellRaw = String(r[key] || '').trim();
      const p = cellRaw ? parseCellVerbatim(cellRaw) : null;
      const o = open[day];
      if (!p) { closeOpen(day); continue; }
      if (!p.name) {
        // 无课名行 = 某门课跨多行时的"末行"(只有周次/教室): 补全字段并延长跨度
        if (o) {
          if ((!o.c.weeksText || o.c.weeksText === '全周') && p.weeks !== '全周') o.c.weeksText = p.weeks;
          if (!o.c.room && p.room) o.c.room = p.room;
          if (!o.c.teacher && p.teacher) o.c.teacher = p.teacher;
          o.c.endSection = sec;
        }
        continue; // 无名且无进行中的课 → 丢弃
      }
      const sig = [p.name, p.teacher, p.weeks, p.room].join('|');
      if (o && o.sig === sig) {
        // 同名同参: 可能是模型整格重复(延续), 也可能是紧挨着的下一块同名课
        // 判据: 本行只是光秃秃的课名行(无周次无教室), 而进行中的课已被"末行"补全过 → 是新一门
        const bareNameLine = p.weeks === '全周' && !p.room;
        const filled = (o.c.weeksText && o.c.weeksText !== '全周') || o.c.room;
        if (bareNameLine && filled) { closeOpen(day); open[day] = { sig, c: { name: p.name, teacher: p.teacher, day, startSection: sec, endSection: sec, weeksText: p.weeks, room: p.room } }; }
        else o.c.endSection = sec;
        continue;
      }
      closeOpen(day);
      open[day] = { sig, c: { name: p.name, teacher: p.teacher, day, startSection: sec, endSection: sec, weeksText: p.weeks, room: p.room } };
    }
  }
  Object.keys(open).forEach(closeOpen);
  return { school, semester, sectionCount: maxSec, courses };
}

module.exports = { parseRowJSONTimetable, parseCellVerbatim, normWeeks };
