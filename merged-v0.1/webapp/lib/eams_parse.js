'use strict';
// eams_parse.js —— 解析 EAMS 课表页 HTML（浏览器保存的 courseTableForStd.action 页面）
// EAMS 课表用 JS 生成：new TaskActivity(...) + index = N*unitCount+M
//   index 的 N = 星期（0=周一），M = 节次（0=第1节）
//   TaskActivity 参数中的双引号字符串依次为：[课程代码, 课程名称, 课程ID, 教室, 周次位图]

function fmtWeeks(bitmap) {
  const ws = [];
  for (let i = 0; i < bitmap.length; i++) if (bitmap[i] === '1') ws.push(i + 1);
  if (!ws.length) return '全周';
  const parts = [];
  let s = ws[0], prev = ws[0];
  for (let i = 1; i <= ws.length; i++) {
    const w = ws[i];
    if (w === prev + 1) { prev = w; continue; }
    parts.push(s === prev ? String(s) : (s + '-' + prev));
    s = prev = w;
  }
  return parts.join('、');
}

function parseEamsCourseTable(html) {
  const text = String(html || '');
  const unitCount = +(text.match(/var unitCount\s*=\s*(\d+);/) || [0, 12])[1] || 12;
  const re = /activity\s*=\s*new\s+TaskActivity\(([\s\S]*?)\)\s*;\s*index\s*=\s*(\d+)\s*\*\s*unitCount\s*\+\s*(\d+)\s*;/g;
  const raw = [];
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    const strs = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
    if (strs.length < 5) continue;
    const code = strs[0] || '';
    const name = (strs[1] || '').replace(/\([^)]*\)\s*$/, '').trim();
    const room = (strs[3] || '').trim();
    const bitmap = strs[4] || '';
    const before = text.slice(Math.max(0, m.index - 4000), m.index);
    const teacherNames = [...before.matchAll(/name:"([^"]+)"/g)].map((x) => x[1]);
    const teacher = teacherNames.length ? teacherNames[teacherNames.length - 1] : '';
    if (!name) continue;
    const day = Math.min(7, Math.max(1, +m[2] + 1));
    const unit = Math.min(unitCount, Math.max(1, +m[3] + 1));
    raw.push({
      name: name,
      teacher: teacher,
      room: room,
      day: day,
      start: unit,
      end: unit,
      weeks: fmtWeeks(bitmap),
      code: code
    });
  }
  // 同一课程 + 同一天 + 同教室 + 同周次 + 连续节次 → 合并
  const merged = [];
  raw.sort((a, b) => a.day - b.day || a.start - b.start);
  raw.forEach((it) => {
    const found = merged.find((x) =>
      x.name === it.name && x.teacher === it.teacher && x.room === it.room &&
      x.weeks === it.weeks && x.day === it.day && it.start <= x.end + 1 && it.start >= x.start - 1
    );
    if (found) {
      found.start = Math.min(found.start, it.start);
      found.end = Math.max(found.end, it.end);
    } else {
      merged.push({ ...it });
    }
  });
  return merged;
}

// 从 EAMS 课表页提取学期元信息：学期 id、教学周总数
function parseEamsMeta(html) {
  const text = String(html || '');
  const sem = text.match(/name="semester\.id"\s+value="(\d+)"/);
  let weeksTotal = 0;
  const sw = text.match(/id="startWeek"[\s\S]{0,4000}?<\/select>/);
  if (sw) {
    const nums = [...sw[0].matchAll(/第(\d{1,2})周/g)].map((m) => +m[1]);
    if (nums.length) weeksTotal = Math.max.apply(null, nums);
  }
  return { semesterId: sem ? sem[1] : '', weeksTotal: weeksTotal };
}

module.exports = { parseEamsCourseTable: parseEamsCourseTable, parseEamsMeta: parseEamsMeta };
