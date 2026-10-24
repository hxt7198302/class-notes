'use strict';
// qiangzhi.js —— 强智教务系统账号登录 + 课表抓取（App 接口，无验证码）
// 接口参考：/app.do?method=authUser（登录）、/app.do?method=getKbcxAzc（按周取课表）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function baseOf(baseUrl) {
  let base = String(baseUrl || '').trim();
  if (!/^https?:\/\//.test(base)) base = 'http://' + base;
  return base.replace(/\/+$/, '');
}

function currentTermId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  if (m >= 9) return y + '-' + (y + 1) + '-1';
  if (m <= 1) return (y - 1) + '-' + y + '-1';
  return (y - 1) + '-' + y + '-2';
}

function parseSection(jc) {
  const m = String(jc || '').match(/(\d+)\s*[-~—]\s*(\d+)/);
  if (m) return { start: +m[1], end: +m[2] };
  const m2 = String(jc || '').match(/(\d+)/);
  return { start: m2 ? +m2[1] : 1, end: m2 ? +m2[1] : 1 };
}

async function loginAndFetch(baseUrl, username, password) {
  const base = baseOf(baseUrl);
  const termId = currentTermId();
  // 1) 登录
  const loginUrl = base + '/app.do?method=authUser&xh=' + encodeURIComponent(username) + '&pwd=' + encodeURIComponent(password);
  const lr = await fetch(loginUrl, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' } });
  const lj = await lr.json().catch(() => null);
  if (!lj || lj.success !== true || !lj.token) {
    throw new Error('强智登录失败：' + ((lj && (lj.message || lj.msg)) || '账号密码错误，或该学校不是强智系统'));
  }
  const token = lj.token;
  // 2) 按周取课表（1-20 周）
  const byKey = {};
  let gotAny = false;
  for (let w = 1; w <= 20; w++) {
    const u = base + '/app.do?method=getKbcxAzc&xh=' + encodeURIComponent(username) + '&xnxqid=' + encodeURIComponent(termId) + '&zc=' + w;
    let arr = null;
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'User-Agent': UA, 'token': token, 'Content-Type': 'application/x-www-form-urlencoded' } });
      arr = await r.json().catch(() => null);
    } catch (e) { arr = null; }
    if (!Array.isArray(arr)) continue;
    gotAny = true;
    arr.forEach((it) => {
      const name = it && (it.kcmc || it.courseName);
      if (!name) return;
      const sec = parseSection(it.jcs || it.jc);
      const day = parseInt(it.xqj || it.weekday || 0, 10);
      if (!day) return;
      const key = [name, it.jsxm || it.teacher, it.jsmc || it.room, day, sec.start, sec.end].join('|');
      if (!byKey[key]) {
        byKey[key] = { name: name, teacher: it.jsxm || it.teacher || '', room: it.jsmc || it.room || '', day: day, start: sec.start, end: sec.end, weeksList: [] };
      }
      byKey[key].weeksList.push(w);
    });
  }
  if (!gotAny) throw new Error('强智登录成功，但课表接口没有返回数据（可能学期不对或接口不同）');
  const fmtWeeks = (ws) => {
    ws.sort((a, b) => a - b);
    const parts = [];
    let s = ws[0], prev = ws[0];
    for (let i = 1; i <= ws.length; i++) {
      const x = ws[i];
      if (x === prev + 1) { prev = x; continue; }
      parts.push(s === prev ? String(s) : (s + '-' + prev));
      s = prev = x;
    }
    return parts.join('、');
  };
  const courses = Object.keys(byKey).map((k) => {
    const c = byKey[k];
    return { name: c.name, teacher: c.teacher, room: c.room, day: c.day, start: c.start, end: c.end, weeks: fmtWeeks(c.weeksList) };
  });
  if (!courses.length) throw new Error('强智登录成功，但没有解析到课程');
  return courses;
}

module.exports = { loginAndFetch: loginAndFetch };
