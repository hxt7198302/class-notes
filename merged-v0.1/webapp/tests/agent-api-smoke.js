'use strict';
// P1 Agent 上传/读取协议冒烟测试（零依赖，Node 22 内置 fetch）
// 起一个独立 server.js（PORT=3011、APP_TOKEN=testtoken、DATA_DIR=临时目录），
// 串行验证：meta → chunk×2 → 续传 → 409 → 422 → complete → note 写入 → notes → note → source → file+Range。
// 用法：node tests/agent-api-smoke.js
// 退出码：0 = PASS；1 = 有失败（打印原因）。

const { spawn } = require('child_process');
const { once } = require('events');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3011);
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'testtoken';
const ID = 'c20261024-181500-smoke';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-agent-smoke-'));
const dataDir = path.join(tmpRoot, 'data');
const sessDir = path.join(dataDir, 'agent', ID);
const filesDir = path.join(sessDir, 'files');
const targetFile = path.join(filesDir, 'demo.txt');

let child = null;
let passed = 0;
let failed = 0;
const failures = [];
let serverLog = '';
let cleaned = false;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failed++;
    failures.push(name + ' :: ' + (e && e.message ? e.message : String(e)));
    console.log('  FAIL  ' + name + '  ->  ' + (e && e.message ? e.message : String(e)));
  }
}

async function request(pathname, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  if (o.token !== null) headers['x-app-token'] = o.token || TOKEN;
  const res = await fetch(BASE + pathname, {
    method: o.method || 'GET',
    headers: headers,
    body: o.body,
    signal: AbortSignal.timeout(20000)
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  if (!o.raw) { try { json = JSON.parse(buf.toString('utf8')); } catch (e) {} }
  return { status: res.status, headers: res.headers, buf: buf, json: json, text: buf.toString('utf8') };
}

const jsonPost = (pathname, obj) => request(pathname, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(obj), 'utf8')
});

function readJSONFile(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function metaBody() {
  const now = Date.now();
  return {
    id: ID,
    course: '软件工程',
    courseName: '软件工程',
    startedAt: now - 3600000,
    endedAt: now,
    durationMs: 3600000,
    device: 'smoke-test',
    segments: [{ name: 'recording_00.m4a', startOffsetMs: 0 }],
    photos: [{ name: 'photo_001.jpg', offsetMs: 5000 }],
    markers: [{ offsetMs: 1000, type: '重点', note: '冒烟标记' }]
  };
}

async function startServer() {
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    APP_TOKEN: TOKEN,
    DATA_DIR: dataDir
  });
  delete env.AGENT_API_OPEN;
  delete env.CHAT_PIN;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });
  child.on('exit', (code, sig) => {
    serverLog += '\n[server exit code=' + code + ' signal=' + sig + ']';
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('server.js 启动即退出（exit=' + child.exitCode + '）\n' + serverLog.slice(-2000));
    }
    try {
      const res = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return;
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('等待 server.js 启动超时（15s）\n' + serverLog.slice(-2000));
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (child && child.exitCode === null) {
    try { child.kill(); } catch (e) {}
    await Promise.race([once(child, 'exit').catch(() => {}), sleep(4000)]);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch (e) {} }
  }
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (e) {
      await sleep(200);
    }
  }
  console.error('警告：临时目录未删除干净：' + tmpRoot);
}

async function main() {
  console.log('P1 Agent API 冒烟测试');
  console.log('  端口 ' + PORT + ' · 临时数据目录 ' + dataDir);

  await startServer();

  const full = Buffer.from('课堂助手 P1 冒烟：meta / chunk / 续传 / 409 / 422 / complete / notes / note / source / file+Range。\nSecond line for range test.\n', 'utf8');
  const part1 = full.subarray(0, 17);
  const part2 = full.subarray(17);

  await step('GET /api/health 免鉴权 → 200', async () => {
    const r = await request('/api/health', { token: null });
    assert.equal(r.status, 200);
    assert.equal(r.json && r.json.ok, true);
  });

  await step('GET /api/classes 旧路由免 token 不回归 → 200', async () => {
    const r = await request('/api/classes', { token: null });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(Array.isArray(r.json.data.courses));
  });

  await step('无 token 访问 /api/notes → 401', async () => {
    const r = await request('/api/notes', { token: null });
    assert.equal(r.status, 401);
    assert.equal(r.json.ok, false);
  });

  await step('错误 token 访问 /api/notes → 401', async () => {
    const r = await request('/api/notes', { token: 'wrong-token' });
    assert.equal(r.status, 401);
  });

  await step('POST /api/session/meta → 200 且写盘 schemaVersion=1', async () => {
    const r = await jsonPost('/api/session/meta', metaBody());
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.id, ID);
    assert.deepEqual(r.json.received, {});
    const disk = readJSONFile(path.join(sessDir, 'meta.json'));
    assert.equal(disk.id, ID);
    assert.equal(disk.schemaVersion, 1);
    assert.equal(disk.course, '软件工程');
    assert.equal(disk.segments.length, 1);
    assert.equal(disk.photos[0].offsetMs, 5000);
    assert.equal(disk.markers.length, 1);
  });

  await step('POST /api/chunk 第 1 块（offset=0 且 md5 正确）→ 200 size=17', async () => {
    const r = await request('/api/chunk?id=' + ID + '&name=demo.txt&offset=0&md5=' + md5(part1), { method: 'POST', body: part1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.size, part1.length);
    assert.equal(fs.statSync(targetFile).size, part1.length);
  });

  await step('重发 meta（续传握手）→ received.demo.txt=17', async () => {
    const r = await jsonPost('/api/session/meta', metaBody());
    assert.equal(r.status, 200);
    assert.equal(r.json.received['demo.txt'], part1.length);
    assert.equal(fs.statSync(targetFile).size, part1.length);
  });

  await step('POST /api/chunk 第 2 块（offset=17，md5 正确）→ 200 且拼接完整', async () => {
    const r = await request('/api/chunk?id=' + ID + '&name=demo.txt&offset=' + part1.length + '&md5=' + md5(part2), { method: 'POST', body: part2 });
    assert.equal(r.status, 200);
    assert.equal(r.json.size, full.length);
    assert.deepStrictEqual(fs.readFileSync(targetFile), full);
  });

  await step('人为错误 offset → 409 {ok:false,error:"offset",size:实际}', async () => {
    const r = await request('/api/chunk?id=' + ID + '&name=demo.txt&offset=999', { method: 'POST', body: Buffer.from('x') });
    assert.equal(r.status, 409);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'offset');
    assert.equal(r.json.size, full.length);
    assert.equal(fs.statSync(targetFile).size, full.length);
  });

  await step('人为错误 md5 → 422 且文件不变', async () => {
    const r = await request('/api/chunk?id=' + ID + '&name=demo.txt&offset=' + full.length + '&md5=' + '0'.repeat(32), { method: 'POST', body: Buffer.from('bad') });
    assert.equal(r.status, 422);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'md5');
    assert.equal(fs.statSync(targetFile).size, full.length);
    assert.deepStrictEqual(fs.readFileSync(targetFile), full);
  });

  await step('非法文件名（../evil.txt）→ 400', async () => {
    const r = await request('/api/chunk?id=' + ID + '&name=' + encodeURIComponent('../evil.txt') + '&offset=0', { method: 'POST', body: Buffer.from('x') });
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
  });

  await step('POST /api/session/complete → 200，complete.flag + status.state=uploaded', async () => {
    const r = await request('/api/session/complete?id=' + ID, { method: 'POST', body: Buffer.alloc(0) });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(fs.existsSync(path.join(sessDir, 'complete.flag')));
    const st = readJSONFile(path.join(sessDir, 'status.json'));
    assert.equal(st.state, 'uploaded');
    assert.ok(typeof st.updatedAt === 'string' && st.updatedAt.length >= 10);
  });

  const markdown = '# 冒烟笔记\n\n- P1 上传协议\n- Range 测试\n';
  await step('POST /api/session/note 写 note.md → 200', async () => {
    const r = await jsonPost('/api/session/note', { id: ID, markdown: markdown });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(fs.readFileSync(path.join(sessDir, 'note.md'), 'utf8'), markdown);
  });

  await step('GET /api/notes → 列表含本会话且字段齐全', async () => {
    const r = await request('/api/notes');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(Array.isArray(r.json.notes));
    const n = r.json.notes.find((x) => x.id === ID);
    assert.ok(n, '列表里没有 ' + ID);
    assert.equal(n.course, '软件工程');
    assert.equal(n.state, 'uploaded');
    assert.equal(n.title, '软件工程');
    assert.equal(typeof n.summary, 'string');
    assert.equal(n.startedAt > 0, true);
    assert.equal(n.durationMs, 3600000);
    assert.equal(n.photoCount, 1);
    assert.equal(n.segmentCount, 1);
    assert.equal(n.hasNote, true);
  });

  await step('GET /api/note → meta/status/note/items', async () => {
    const r = await request('/api/note?id=' + ID);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.meta.id, ID);
    assert.equal(r.json.status.state, 'uploaded');
    assert.equal(r.json.note, markdown);
    assert.strictEqual(r.json.items, null);
  });

  await step('GET /api/source → transcript 与 segments/photos 带真实 size', async () => {
    const r = await request('/api/source?id=' + ID);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.meta.id, ID);
    assert.strictEqual(r.json.transcript, null);
    assert.deepStrictEqual(r.json.segments, [{ name: 'recording_00.m4a', offsetMs: 0, size: 0 }]);
    assert.deepStrictEqual(r.json.photos, [{ name: 'photo_001.jpg', offsetMs: 5000, size: 0 }]);
  });

  await step('GET /api/file → 200 全量 + text/plain + 字节一致', async () => {
    const r = await request('/api/file?id=' + ID + '&name=demo.txt', { raw: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /^text\/plain/);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.deepStrictEqual(r.buf, full);
  });

  await step('GET /api/file + Range bytes=0-3 → 206 + Content-Range', async () => {
    const r = await request('/api/file?id=' + ID + '&name=demo.txt', { raw: true, headers: { range: 'bytes=0-3' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 0-3/' + full.length);
    assert.deepStrictEqual(r.buf, full.subarray(0, 4));
  });

  await step('GET /api/file + Range bytes=-5（末尾 5 字节）→ 206', async () => {
    const r = await request('/api/file?id=' + ID + '&name=demo.txt', { raw: true, headers: { range: 'bytes=-5' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes ' + (full.length - 5) + '-' + (full.length - 1) + '/' + full.length);
    assert.deepStrictEqual(r.buf, full.subarray(full.length - 5));
  });

  await step('GET /api/file + 越界 Range → 416 + Content-Range: bytes */size', async () => {
    const r = await request('/api/file?id=' + ID + '&name=demo.txt', { raw: true, headers: { range: 'bytes=999999-1000000' } });
    assert.equal(r.status, 416);
    assert.equal(r.headers.get('content-range'), 'bytes */' + full.length);
  });

  await step('Range 请求可用 ?token= 查询参数（<audio> 场景）', async () => {
    const r = await request('/api/file?id=' + ID + '&name=demo.txt&token=' + TOKEN, { raw: true, token: null, headers: { range: 'bytes=0-1' } });
    assert.equal(r.status, 206);
    assert.deepStrictEqual(r.buf, full.subarray(0, 2));
  });

  await step('token 文件按 32 位 hex 自动生成', async () => {
    const f = path.join(dataDir, 'api-token.txt');
    assert.ok(fs.existsSync(f), '缺少 api-token.txt');
    assert.match(fs.readFileSync(f, 'utf8').trim(), /^[0-9a-f]{32}$/);
  });

  await step('旧路由 /api/health 仍 200（结束时回归）', async () => {
    const r = await request('/api/health', { token: null });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });
}

(async () => {
  let fatal = null;
  try {
    await main();
  } catch (e) {
    fatal = e;
  }
  await cleanup();
  console.log('');
  if (fatal) {
    console.error('FAIL  测试提前中断：' + (fatal.stack || fatal));
    if (serverLog) console.error('server 日志：\n' + serverLog.slice(-3000));
    process.exit(1);
  }
  if (failed > 0) {
    console.error('FAIL  ' + failed + ' 项失败 / ' + (passed + failed) + ' 项');
    failures.forEach((f) => console.error('  - ' + f));
    console.error('server 日志：\n' + serverLog.slice(-3000));
    process.exit(1);
  }
  console.log('PASS  ' + passed + ' 项断言全部通过（临时目录已清理）');
  process.exit(0);
})();
