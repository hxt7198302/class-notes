'use strict';
// zhengfang.js —— 正方教务系统（新版）账号登录 + 课表抓取
// 使用开源库 zfnew-node（MIT）：https://github.com/maxchang3/zfnew-node
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function parseSection(jc) {
  const s = String(jc || '');
  const m = s.match(/(\d+)\s*[-~—]\s*(\d+)/);
  if (m) return { start: +m[1], end: +m[2] };
  const m2 = s.match(/(\d+)/);
  if (m2) return { start: +m2[1], end: +m2[1] };
  return { start: 1, end: 1 };
}

function normalizeWeeks(zcd) {
  let t = String(zcd || '').replace(/周/g, '').replace(/[（(]/g, '').replace(/[)）]/g, '');
  t = t.replace(/[，,]/g, '、').replace(/\s+/g, '');
  // "1-16单" 保留，inWeek 支持范围+单双
  return t || '全周';
}

function currentTerm() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  if (m >= 8) return { year: String(y), term: '1' };      // 9月-次年1月 第一学期
  if (m <= 1) return { year: String(y - 1), term: '1' };  // 1月 第一学期
  return { year: String(y - 1), term: '2' };              // 2-7月 第二学期
}

async function loginAndFetch(baseUrl, username, password) {
  return withLock(async () => {
    const zfnew = require('zfnew-node');
    const School = zfnew.School, GetInfo = zfnew.GetInfo;
    let base = String(baseUrl || '').trim();
    if (!base) throw new Error('请填写正方教务系统地址，如 https://jwxt.example.edu.cn/');
    if (!/^https?:\/\//.test(base)) base = 'https://' + base;
    if (!base.endsWith('/')) base += '/';
    const school = new School(base);
    const info = await school.login(String(username), String(password));
    if (!info || String(info.code) !== '1') {
      throw new Error('正方登录失败：' + ((info && info.result) || '账号或密码错误，或学校需要验证码'));
    }
    GetInfo.init(school.info());
    const t = currentTerm();
    const map = [{
      kcmc: 'courseTitle', xm: 'teacher', kch_id: 'courseId', jc: 'courseSection',
      zcd: 'courseWeek', cdmc: 'courseRoom', xqj: 'weekday', xqmc: 'campus'
    }, 'kbList'];
    let list;
    try {
      list = await GetInfo.getSchedule(t.year, t.term, map);
    } catch (e) {
      // 兼容无 xqj 字段的学校（会抛错/返回空）
      list = [];
    }
    const arr = Array.isArray(list) ? list : (list ? [list] : []);
    const courses = [];
    arr.forEach((it) => {
      if (!it || !it.courseTitle) return;
      const day = Math.min(7, Math.max(1, parseInt(it.weekday, 10) || 0));
      if (!day) return;
      const sec = parseSection(it.courseSection);
      courses.push({
        name: String(it.courseTitle).replace(/^\([^)]*\)/, '').trim(),
        teacher: it.teacher || '',
        room: it.courseRoom || '',
        day: day,
        start: sec.start,
        end: sec.end,
        weeks: normalizeWeeks(it.courseWeek),
        code: it.courseId || ''
      });
    });
    if (!courses.length) throw new Error('正方登录成功，但没有解析到课表（学校接口字段可能不同）');
    return courses;
  });
}

module.exports = { loginAndFetch: loginAndFetch };
