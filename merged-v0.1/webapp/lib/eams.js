'use strict';
// eams.js —— 北京物资学院 EAMS 教务系统登录 + 课表抓取（仅用于用户自己的账号）
// 说明：学校 WAF 对非浏览器请求敏感，需带浏览器 UA；密码前端 SHA1 加盐后提交。
const crypto = require('crypto');
const BASE = 'https://jwxt.bwu.edu.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SALT = '693d016f-bc9a-4939-98a5-4d3a01330462-';

function sha1(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');
}

function cookieJarUpdate(jar, resp) {
  let setCookies = [];
  try { setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : []; } catch (e) {}
  (setCookies || []).forEach((c) => {
    const kv = String(c).split(';')[0];
    if (!kv || kv.indexOf('=') < 0) return;
    const name = kv.split('=')[0];
    for (let i = jar.length - 1; i >= 0; i--) if (jar[i].split('=')[0] === name) jar.splice(i, 1);
    jar.push(kv);
  });
  return jar;
}

async function login(username, password) {
  const enc = sha1(SALT + password);
  const body = new URLSearchParams({
    username: String(username),
    password: enc,
    encodedPassword: '',
    session_locale: 'zh_CN'
  });
  let jar = [];
  const resp = await fetch(BASE + '/eams/login.action', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': BASE + '/eams/login.action',
      'Origin': BASE
    },
    body: body.toString()
  });
  jar = cookieJarUpdate(jar, resp);
  const status = resp.status;
  const loc = resp.headers.get('location') || '';
  // 跟随重定向（最多 3 次）
  let cur = loc ? new URL(loc, BASE).toString() : '';
  let lastStatus = status;
  for (let i = 0; i < 3 && cur; i++) {
    const r = await fetch(cur, { redirect: 'manual', headers: { 'User-Agent': UA, 'Cookie': jar.join('; '), 'Referer': BASE + '/eams/login.action' } });
    jar = cookieJarUpdate(jar, r);
    lastStatus = r.status;
    const l2 = r.headers.get('location') || '';
    cur = l2 ? new URL(l2, BASE).toString() : '';
  }
  return { status: status, redirected: !!loc, lastStatus: lastStatus, cookie: jar.join('; ') };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function getPage(cookie, url, referer) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Cookie': cookie,
      'Referer': referer || BASE + '/eams/home.action',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  const text = await resp.text();
  return { status: resp.status, html: text };
}

function isErrorPage(html) {
  return /请不要过快点击|actionError|stackTraceDiv/.test(html);
}

async function fetchCourseTable(cookie) {
  // 1) 先访问首页，建立会话上下文
  const home = await getPage(cookie, BASE + '/eams/home.action', BASE + '/eams/login.action');
  await sleep(900);
  // 2) 课表框架页，尝试取学期 id
  const frame = await getPage(cookie, BASE + '/eams/courseTableForStd.action', BASE + '/eams/home.action');
  let semesterId = '';
  const m = frame.html.match(/semester\.id=(\d+)/);
  if (m) semesterId = m[1];
  await sleep(900);
  // 3) 课表内容页
  const url = BASE + '/eams/courseTableForStd!courseTable.action' + (semesterId ? ('?semester.id=' + semesterId) : '');
  let ct = await getPage(cookie, url, BASE + '/eams/courseTableForStd.action');
  if (isErrorPage(ct.html)) {
    await sleep(2200);
    ct = await getPage(cookie, url, BASE + '/eams/courseTableForStd.action');
  }
  return {
    status: ct.status,
    html: ct.html,
    looksLogin: /logindiv|loginForm/.test(ct.html),
    looksError: isErrorPage(ct.html),
    semesterId: semesterId,
    homeStatus: home.status,
    frameStatus: frame.status,
    frameSize: frame.html.length
  };
}

module.exports = { login: login, fetchCourseTable: fetchCourseTable, BASE: BASE };
