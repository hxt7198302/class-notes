'use strict';
// html_parse.js —— 通用课表 HTML 解析器
// 思路：先试金智 EAMS 专用解析；不行再按"表格类课表"通用解析；再不行按"卡片块"解析。
const { parseEamsCourseTable } = require('./eams_parse');

const WEEK_RE = /(?:星期|周)([一二三四五六日天1-7])/g;
const DAY_CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7 };

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (mm, d) => String.fromCharCode(+d));
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.split('\n').map((x) => x.replace(/[ \t\u00a0]+/g, ' ').trim()).filter((x) => x).join('\n');
}

function parseWeeks(text) {
  const t = String(text || '');
  // 常见："1-16周" / "第1-16周" / "1-16(单)" / "1-16周(单周)" / "1-5,7-9" / "1-16单周"
  const m = t.match(/(\d{1,2}\s*[-—~]\s*\d{1,2}(?:\s*[-—~]\s*\d{1,2})?(?:\s*[单双])?[周]?|[0-9]{1,2}(?:\s*[、,，]\s*\d{1,2}(?:\s*[-—~]\s*\d{1,2})?)*[单双]?[周]?)/);
  if (!m) return '';
  let w = m[0].replace(/[周]/g, '').replace(/[（(]/g, '').replace(/[)）]/g, '')
    .replace(/\s+/g, '').replace(/[，,]/g, '、');
  w = w.replace(/(\d+[-—~]\d+)单/g, '$1单').replace(/(\d+[-—~]\d+)双/g, '$1双');
  return w || '';
}

function isRoom(s) {
  return /(楼|室|教室|号|栋|校区|实验|操场|场|#|区|馆|中心|102|20[0-9]|10[0-9])/.test(s) && !/(老师|教师|教授|讲师)/.test(s);
}
function isTeacher(s) {
  return /(老师|教师|教授|讲师|助教)/.test(s);
}
function isWeeks(s) {
  return !!parseWeeks(s) && /周|\d\s*[-—~]\s*\d/.test(s);
}

function splitCourseCell(cellHtml) {
  const text = htmlToText(cellHtml);
  if (!text || text === '无') return null;
  if (!parseWeeks(text)) return null; // 没有周次信息，多半不是课程格
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return null;
  let weeks = '';
  const nameCandidates = [];
  let teacher = '';
  let room = '';
  lines.forEach((ln) => {
    if (isWeeks(ln) && !weeks) { weeks = parseWeeks(ln); return; }
    if (isRoom(ln) && !room) { room = ln; return; }
    if (isTeacher(ln) && !teacher) { teacher = ln; return; }
    nameCandidates.push(ln);
  });
  let name = nameCandidates[0] || '';
  if (!name) return null;
  // 若第一行含括号代码，去掉
  name = name.replace(/[（(][^)）]{2,40}[)）]\s*$/, '').trim() || name;
  return { name: name, teacher: teacher, room: room, weeks: weeks || '全周' };
}

function extractTables(html) {
  return String(html || '').match(/<table[\s\S]*?<\/table>/gi) || [];
}

function extractRows(tableHtml) {
  const rows = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  return rows.map((r) => {
    const cells = [];
    const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let m;
    while ((m = re.exec(r))) {
      const attrs = r.slice(m.index, m.index + 60);
      const spanM = attrs.match(/rowspan\s*=\s*["']?(\d+)/i);
      cells.push({ html: m[1], rowspan: spanM ? +spanM[1] : 1 });
    }
    return cells;
  }).filter((c) => c.length);
}

function parseTableCourses(html) {
  const tables = extractTables(html);
  const results = [];
  tables.forEach((tbl) => {
    const rows = extractRows(tbl);
    if (rows.length < 2) return;
    // 找表头行（含 星期一~日）
    let headerIdx = -1, dayMap = {};
    for (let i = 0; i < Math.min(4, rows.length); i++) {
      const texts = rows[i].map((c) => htmlToText(c.html));
      const found = {};
      texts.forEach((tx, ci) => {
        const re = /(?:星期|周)([一二三四五六日天1-7])/g;
        let mm;
        while ((mm = re.exec(tx))) found[ci] = DAY_CN[mm[1]];
      });
      if (Object.keys(found).length >= 3) { headerIdx = i; dayMap = found; break; }
    }
    if (headerIdx < 0) return;
    // 行首列 → 节次
    rows.forEach((row, ri) => {
      if (ri <= headerIdx) return;
      let section = 0;
      const firstText = htmlToText(row[0] && row[0].html || '');
      const sm = firstText.match(/(\d{1,2})/);
      if (sm) section = +sm[1];
      if (!section) return;
      Object.keys(dayMap).forEach((ciStr) => {
        const ci = +ciStr;
        const cell = row[ci];
        if (!cell) return;
        const course = splitCourseCell(cell.html);
        if (!course) return;
        results.push({
          name: course.name, teacher: course.teacher, room: course.room,
          day: dayMap[ciStr], start: section, end: section, weeks: course.weeks
        });
      });
    });
  });
  // 合并同课程同天连续节次
  return mergeAdjacent(results);
}

function parseCardCourses(html) {
  // 卡片类：找含"周"的重复块（div/li），提取课程名 + 周次
  const blocks = String(html || '').match(/<(?:div|li|td)[^>]*>[\s\S]{20,800}?<\/(?:div|li|td)>/gi) || [];
  const results = [];
  blocks.forEach((b) => {
    const text = htmlToText(b);
    if (!text) return;
    const weeks = parseWeeks(text);
    if (!weeks) return;
    const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return;
    // 只处理看起来像课程的块：至少 2 行且不是纯表格结构
    const name = lines.find((ln) => /[\u4e00-\u9fa5]{2,}/.test(ln) && !isWeeks(ln) && !isRoom(ln) && !isTeacher(ln));
    if (!name) return;
    const teacher = lines.find((ln) => isTeacher(ln) && ln !== name) || '';
    const room = lines.find((ln) => isRoom(ln) && ln !== name) || '';
    const dayLine = lines.find((ln) => /(?:星期|周)[一二三四五六日天1-7]/.test(ln));
    let day = 0;
    if (dayLine) {
      const dm = dayLine.match(/(?:星期|周)([一二三四五六日天1-7])/);
      if (dm) day = DAY_CN[dm[1]] || 0;
    }
    const secLine = lines.find((ln) => /第?\s*\d+\s*[-—~]?\s*\d*\s*节/.test(ln)) || '';
    let start = 1, end = 1;
    const sm = secLine.match(/(\d+)\s*[-—~]?\s*(\d*)/);
    if (sm) { start = +sm[1]; end = sm[2] ? +sm[2] : start; }
    if (!day) return;
    results.push({ name: name, teacher: teacher, room: room, day: day, start: start, end: end, weeks: weeks });
  });
  return mergeAdjacent(results);
}

function mergeAdjacent(list) {
  const merged = [];
  list.sort((a, b) => a.day - b.day || a.start - b.start);
  list.forEach((it) => {
    const found = merged.find((x) => x.name === it.name && x.day === it.day && x.weeks === it.weeks &&
      x.teacher === it.teacher && x.room === it.room && it.start <= x.end + 1 && it.start >= x.start - 1);
    if (found) { found.start = Math.min(found.start, it.start); found.end = Math.max(found.end, it.end); }
    else merged.push({ ...it });
  });
  return merged;
}

function parseHtml(text) {
  const html = String(text || '');
  if (html.length < 200) return { engine: 'none', courses: [], error: '内容太短，不是完整的课表页面' };
  // 1) 金智 EAMS 专用
  try {
    const eams = parseEamsCourseTable(html);
    if (eams.length) return { engine: 'eams', courses: eams };
  } catch (e) {}
  // 2) 通用表格
  try {
    const table = parseTableCourses(html);
    if (table.length) return { engine: 'table', courses: table };
  } catch (e) {}
  // 3) 卡片块
  try {
    const card = parseCardCourses(html);
    if (card.length) return { engine: 'card', courses: card };
  } catch (e) {}
  return { engine: 'none', courses: [] };
}

module.exports = { parseHtml, parseTableCourses, parseCardCourses, htmlToText, parseWeeks };
