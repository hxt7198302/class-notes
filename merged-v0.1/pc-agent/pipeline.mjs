// 课堂笔记分析流水线：一个会话一条龙「转写 → AI 分析 → 推送」。
// 用法：node pipeline.mjs <sessionId>
// 转写用本机 faster-whisper（GPU 优先）；AI 分析用无头会话执行分析手册
// （zcode 引擎需自备 CLI 与分析手册，公开版默认用 glm/template 引擎）。
// 全程状态写 笔记/<id>/status.json，日志写 电脑端/logs/<id>.log。
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');   // 任务根目录（HERE=电脑端，退一级即到）
const SUCAI = id => path.join(ROOT, '素材', id);
const BIJI = id => path.join(ROOT, '笔记', id);
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const NTFY_TOPIC = CFG.ntfyTopic;
const ZCODE_CLI = process.env.ZCODE_CLI || path.join(ROOT, 'zcode', 'zcode.cjs');
const MANUAL = path.join(HERE, '分析任务说明.md'); // 公开版不包含该私有手册；使用 zcode 引擎时需自备

const id = process.argv[2];
const logFile = path.join(HERE, 'logs', `${id}.log`);
fs.mkdirSync(path.join(HERE, 'logs'), { recursive: true });

function log(s) {
  const line = `[${new Date().toLocaleString('sv-SE')}] ${s}`;
  try { fs.appendFileSync(logFile, line + '\n'); } catch { }
  console.log(line);
}
function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }
function writeStatus(id2, patch) {
  const f = path.join(BIJI(id2), 'status.json');
  const cur = readJson(f, {});
  const next = Object.assign({}, cur, patch, { updatedAt: new Date().toISOString() });
  fs.mkdirSync(BIJI(id2), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(next, null, 1));
}

function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: opts.cwd || ROOT, env: process.env });
    curRunChild = child;   // 供总守卫强杀
    let out = '';
    const grab = d => {
      out += d.toString();
      if (out.length > 400000) out = out.slice(-200000);
      if (opts.onLine) opts.onLine(d.toString());
    };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    let killer = null;
    if (opts.timeoutMs) {
      killer = setTimeout(() => {
        log(`[timeout] ${path.basename(cmd)} 超过 ${Math.round(opts.timeoutMs / 60000)} 分钟，强杀`);
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch { }
      }, opts.timeoutMs);
    }
    child.on('exit', code => {
      if (killer) clearTimeout(killer);
      if (curRunChild === child) curRunChild = null;
      resolve({ code, out: out.slice(-4000), ms: Date.now() - t0 });
    });
    child.on('error', e => { if (killer) clearTimeout(killer); if (curRunChild === child) curRunChild = null; resolve({ code: -1, out: String(e), ms: 0 }); });
  });
}
let curRunChild = null;   // 当前正在等待的子进程（总守卫用）

// ---------- GPU 转写互斥锁（v2.2） ----------
// 服务端允许最多 maxParallel 条流水线并行（AI 分析阶段可以同时跑），但本机 GPU 一次只吃得下
// 一个 large-v3：转写阶段用一把跨进程文件锁串行，后来者排队等，分析阶段不受影响。
// 锁目录每 30 秒 touch 一次当心跳；持有者被强杀后 2 分钟自动判定陈旧并挪走（不删，留 .stale-*）。
const LOCK_DIR = path.join(HERE, '.transcribe.lock');
const LOCK_STALE_MS = 2 * 60 * 1000;
let lockBeat = null;
function lockHeldByMe() {
  try { return fs.readFileSync(path.join(LOCK_DIR, 'owner.txt'), 'utf8').includes(String(process.pid)); } catch { return false; }
}
async function acquireTranscribeLock() {
  const t0 = Date.now();
  let announced = false;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(path.join(LOCK_DIR, 'owner.txt'), `${id} ${process.pid} ${new Date().toISOString()}`);
      lockBeat = setInterval(() => { try { const n = new Date(); fs.utimesSync(LOCK_DIR, n, n); } catch { } }, 30000);
      lockBeat.unref();
      log('[lock] 已拿到转写锁（GPU 独占）');
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') { log('[lock] 拿转写锁出错（不等待，直接跑）：' + e.message); return false; }
    }
    try {
      const age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
      if (age > LOCK_STALE_MS) {
        const stale = LOCK_DIR + '.stale-' + new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(LOCK_DIR, stale);
        log('[lock] 清理陈旧转写锁（持有者已退出）→ ' + path.basename(stale));
        continue;
      }
    } catch { }
    if (!announced) { log('[lock] 另一条流水线正在转写，排队等 GPU…'); announced = true; }
    if (Date.now() - t0 > 60 * 60 * 1000) { log('[lock] 等锁超 60 分钟，不再等（可能撞车）'); return false; }
    await new Promise(r => setTimeout(r, 10000));
  }
}
function releaseTranscribeLock() {
  try { if (lockBeat) { clearInterval(lockBeat); lockBeat = null; } } catch { }
  try { if (lockHeldByMe()) fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { }
}
process.on('exit', releaseTranscribeLock);

// 总守卫：单条流水线 3.5 小时还没收尾（2026-09-29 实发过：无头分析会话挂死 7 小时，
// 服务端队列跟着卡死）就强杀当前子进程并终止自己——进程退出即解锁服务端队列
const TOTAL_DEADLINE_MS = 3.5 * 60 * 60 * 1000;
const totalGuard = setTimeout(() => {
  log('[guard] 流水线总时长超 3.5 小时，强杀当前子进程并终止');
  try { if (curRunChild) spawn('taskkill', ['/pid', String(curRunChild.pid), '/T', '/F']); } catch { }
  try { writeStatus(id, { state: 'error', error: '流水线总时长超 3.5 小时被守卫终止（稍后服务会自动重跑）' }); } catch { }
  setTimeout(() => process.exit(1), 3000).unref();
}, TOTAL_DEADLINE_MS);
totalGuard.unref();

async function ntfyPush(title, body) {
  try {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { 'X-Title': title, 'X-Tags': 'memo' },
      body,
    });
    log(`[ntfy] ${title} → ${res.status}`);
  } catch (e) { log(`[ntfy] 推送失败 ${e.message}`); }
}

// 2026-10-09 用户令：每课笔记做完，把这节课抽出的待办事项（items.json）推到手机。
// 走 phone-link send.ps1 三通道（WxPusher弹屏+微信保底+ntfy）；正文经 UTF-8 文件
// 传参（-PayloadFile）避开 GBK 控制台命令行中文乱码。best-effort：失败只记日志，
// 绝不影响笔记交付。config 没配 phonePushScript（开源一键包）时整步静默跳过。
const PHONE_SEND = CFG.phonePushScript || '';
async function pushTodosToPhone(course, title) {
  try {
    if (!PHONE_SEND || !fs.existsSync(PHONE_SEND)) return;
    const items = readJson(path.join(BIJI(id), 'items.json'), []);
    if (!Array.isArray(items) || items.length === 0) { log('[todo-push] 本课没有抽出待办事项，不推送'); return; }
    const rows = items
      .slice().sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0))
      .map((it, i) => {
        const due = it.due ? `截止 ${it.due}` : '无明确截止·尽快';
        const quote = String(it.quote || '').replace(/\s+/g, ' ').slice(0, 60);
        return `${i + 1}. ${it.urgent ? '🔴' : '·'} ${it.title}（${due}）${quote ? '\n   老师原话：' + quote : ''}`;
      });
    const payload = {
      title: `📋 课堂待办·${title || course}（${items.length}条）`,
      message: `《${course}》这节课抽出的待办事项：\n\n${rows.join('\n')}\n\n已同步到课堂笔记APP课程页待办，点一下即消。`,
    };
    const tmp = path.join(HERE, 'logs', `${id}.todo-push.json`);
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8');
    const r = await run('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PHONE_SEND, '-Channel', 'auto', '-PayloadFile', tmp],
      { timeoutMs: 3 * 60 * 1000 });
    const tail = String(r.out || '').split('\n').filter(Boolean).slice(-1)[0] || '';
    log(`[todo-push] ${items.length} 条待办 → 手机 ${r.code === 0 ? '已送达' : '失败'} ${tail.slice(0, 150)}`);
  } catch (e) {
    log(`[todo-push] 推送异常（不影响笔记交付）：${e.message}`);
  }
}

// 内容安全拦截（[1301]）只会写在 ZCode 的 sqlite 里，CLI 输出通常只有一句
// 「Turn execution failed (traceId: …)」。失败后按 traceId 回查一次，准确判永久失败。
const ZCODE_DB = path.join(process.env.USERPROFILE || '', '.zcode', 'cli', 'db', 'db.sqlite');
async function traceError(traceId) {
  try {
    if (!CFG.pythonCmd || !fs.existsSync(ZCODE_DB)) return '';
    const code = 'import sqlite3,sys\n' +
      'c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\n' +
      'r=c.execute("select error_type,error_code,substr(error_message,1,300) from model_usage where trace_id=? order by started_at desc limit 1",(sys.argv[2],)).fetchone()\n' +
      'print(" | ".join(str(x) for x in r) if r else "")';
    const r = await run(CFG.pythonCmd, ['-c', code, ZCODE_DB, traceId], { timeoutMs: 25000 });
    return String(r.out || '').trim();
  } catch { return ''; }
}

async function main() {
  if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) { log('[X] 会话 id 不合法'); return; }
  const meta = readJson(path.join(SUCAI(id), 'meta.json'), null);
  if (!meta) { log(`[X] ${id} 没有 meta.json，跳过`); return; }
  const st0 = readJson(path.join(BIJI(id), 'status.json'), {});
  // v2.2 修（2026-10-16 高数事故）：分析期间并进来的同课素材会把 mergeDirty 置 true 并重新入队，
  // 旧代码只看 state=done 就 [skip]，补跑永远跑不起来——第二节课和照片就这么被吞了。
  // 现在 done + mergeDirty 必须放行，补跑只转写新增段（段级 transcribe.done 缓存）。
  if (st0.state === 'done' && meta.mergeDirty !== true) { log(`[skip] ${id} 已完成`); return; }
  if (st0.state === 'done' && meta.mergeDirty === true) log(`[resume] ${id} 分析期间有同课新素材并入，补跑`);
  if (st0.state === 'analyzing') { log(`[skip] ${id} 正在分析（可能另一条流水线在跑）`); return; }

  log(`===== 开始处理 ${id}（课程：${meta.course}）=====`);

  // ---------- 1) 转写（分段转写 → 按段起始偏移合并时间轴） ----------
  // 同日同课合并（v1.4）：段的 srcId 指向成员会话目录，素材文件仍在成员处
  const matFile = seg => {
    const srcOk = seg.srcId && /^[A-Za-z0-9_-]{6,64}$/.test(seg.srcId);
    return path.join(SUCAI(srcOk ? seg.srcId : id), 'files', seg.name);
  };
  const segs = (meta.segments && meta.segments.length)
    ? meta.segments
    : [{ name: 'recording.m4a', startOffsetMs: 0 }];
  const missing = segs.filter(s => !fs.existsSync(matFile(s)));
  if (missing.length === segs.length) {
    writeStatus(id, { state: 'error', error: '录音文件缺失（一段都没传上来）' });
    log('[X] 录音缺失，终止'); return;
  }
  if (missing.length) log(`[warn] 缺 ${missing.length}/${segs.length} 段录音：${missing.map(s => s.name).join(' ,')}（如实按已有段落整理）`);

  const fmtTs = sec => { const s = Math.max(0, Math.floor(sec)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const py = CFG.pythonCmd || 'python';
  // v2.8 术语热词：APP 课程页填的「课程术语」→ faster-whisper hotwords，专治专业名词听错
  let hotwords = '';
  try {
    const tCfg = JSON.parse(fs.readFileSync(path.join(HERE, 'course-terms.json'), 'utf8'));
    const norm = s => String(s || '').replace(/[（(].*?[)）]|\s|·/g, '').trim();
    const mc = norm(meta.course);
    const keys = Object.keys(tCfg).filter(k => k && typeof tCfg[k] === 'string' && tCfg[k].trim());
    // 精确 → 归一化相等 → 互相包含（"高等数学" 配得上 "高等数学(1)"）
    const key = keys.find(k => k === meta.course) ||
      keys.find(k => mc && norm(k) === mc) ||
      keys.find(k => mc && (mc.includes(norm(k)) || norm(k).includes(mc)));
    if (key && typeof tCfg[key] === 'string') hotwords = tCfg[key].trim().slice(0, 200);
    if (hotwords) log(`[hotwords] 《${meta.course}》注入术语热词：${hotwords}`);
  } catch { }
  let doneCount = 0;
  const allRows = [];
  const skipped = [];   // 转写失败/缺失的段：跳过不拖死整堂课，合并时在时间轴上留缺口标记
  // v2.2：分析阶段允许并行，但转写阶段仍必须独占 GPU；全部段都有缓存时不用等锁
  const needTranscribe = segs.some((s, i) => fs.existsSync(matFile(s)) &&
    !fs.existsSync(path.join(SUCAI(id), 'seg_' + String(i).padStart(2, '0'), 'transcribe.done')));
  let lockHeld = false;
  if (needTranscribe) lockHeld = await acquireTranscribeLock();
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const inFile = matFile(seg);
    if (!fs.existsSync(inFile)) {
      skipped.push({ name: seg.name, startMs: seg.startOffsetMs || 0, err: '录音文件缺失' });
      continue;
    }
    const outDir = path.join(SUCAI(id), 'seg_' + String(i).padStart(2, '0'));
    // 断点续跑以 transcribe.done 为准（transcript.json 在转写中途就会有半个）
    const doneFlag = fs.existsSync(path.join(outDir, 'transcribe.done'));
    if (doneFlag) {
      log(`[transcribe] ${seg.name} 已有结果，跳过`);
    } else {
      const base = Math.round(doneCount / segs.length * 100);
      const span = Math.max(1, Math.round(100 / segs.length));
      writeStatus(id, { state: 'transcribing', progress: base });
      const tArgs = [
        path.join(HERE, 'transcribe.py'),
        '--input', inFile, '--outdir', outDir,
        '--model', CFG.whisperModel || 'large-v3', '--lang', CFG.lang || 'zh',
      ];
      if (hotwords) tArgs.push('--hotwords', hotwords);
      const r = await run(py, tArgs, {
        timeoutMs: 90 * 60 * 1000,
        onLine: line => {
          const m = line.match(/"progress":\s*(\d+)/);
          if (m) writeStatus(id, { progress: Math.min(99, base + Math.round(parseInt(m[1], 10) / 100 * span)) });
        },
      });
      log(`[transcribe] ${seg.name} exit=${r.code} ${Math.round(r.ms / 1000)}s 尾部: ${r.out.split('\n').slice(-2).join(' | ')}`);
    }
    const rows = readJson(path.join(outDir, 'transcript.json'), []);
    if (!fs.existsSync(path.join(outDir, 'transcribe.done')) || rows.length === 0) {
      const err = readJson(path.join(outDir, 'status.json'), {}).error || '转写没有产出文本（文件可能损坏）';
      log(`[warn] ${seg.name} 转写失败，跳过该段继续：${err}`);
      skipped.push({ name: seg.name, startMs: seg.startOffsetMs || 0, err });
      continue;
    }
    const shift = (seg.startOffsetMs || 0) / 1000;
    for (const rw of rows) allRows.push({ s: rw.s + shift, e: rw.e + shift, t: rw.t });
    doneCount++;
  }
  allRows.sort((a, b) => a.s - b.s);
  if (allRows.length === 0) {
    writeStatus(id, { state: 'error', error: '转写合并后一段文本都没有' });
    log('[X] 合并为空，终止'); return;
  }
  fs.writeFileSync(path.join(SUCAI(id), 'transcript.json'), JSON.stringify(allRows, null, 1));
  const txtLines = allRows.map(rw => `[${fmtTs(rw.s)}] ${rw.t}`);
  // 失败段在时间轴上标缺口（只标 txt 给分析会话看；json 保持纯数据）。
  // 缺口按段落起点起算，标记插到缺口结束（≈10 分钟后）的第一行文本之前
  for (const sk of skipped.slice().sort((a, b) => a.startMs - b.startMs)) {
    const from = sk.startMs / 1000;
    const marker = `【${fmtTs(from)} 起的一段录音无法转写（${sk.err}），此段内容缺失】`;
    let pos = txtLines.findIndex(line => {
      const m = line.match(/^\[(\d+):(\d+)\]/);
      return m && (+m[1] * 60 + +m[2]) >= from + 570;
    });
    if (pos < 0) pos = txtLines.length;
    txtLines.splice(pos, 0, marker);
  }
  fs.writeFileSync(path.join(SUCAI(id), 'transcript.txt'), txtLines.join('\n'));
  if (lockHeld) { releaseTranscribeLock(); lockHeld = false; }   // 转写完了，把 GPU 让给排队的课
  log(`[transcribe] 合并完成：${allRows.length} 段文本 / 成功 ${doneCount}/${segs.length} 段` + (skipped.length ? `（跳过：${skipped.map(s => s.name).join('、')}）` : ''));

  // ---------- 2) AI 分析（引擎可插拔：zcode=原私有无头会话 / glm=免费key云API / template=无AI转写稿） ----------
  writeStatus(id, { state: 'analyzing', progress: 100, error: '' });   // 清掉上一轮残留的旧报错
  const ENGINE = CFG.engine || 'template';
  const deadlinesFile = CFG.deadlinesFile || path.join(HERE, 'data', 'deadlines.json');
  const ctx = { SUCAI, BIJI, CFG, log, writeStatus, deadlinesFile };

  if (ENGINE === 'template' || ENGINE === 'glm') {
    const { analyzeTemplate, analyzeGlm } = await import(pathToFileURL(path.join(HERE, 'engines.mjs')).href);
    try {
      if (ENGINE === 'glm') await analyzeGlm(id, ctx);
      else await analyzeTemplate(id, ctx);
    } catch (e) {
      writeStatus(id, { state: 'error', error: String(e.message || e).slice(0, 300) });
      log('[X] 引擎 ' + ENGINE + ' 失败：' + (e.stack || e.message));
      await ntfyPush('classnotes-error', `《${meta.course}》笔记分析出了问题：${String(e.message || e).slice(0, 80)}`);
      return;
    }
    await ntfyPush('classnotes-done', `《${meta.course}》笔记整理好了（${ENGINE === 'glm' ? 'AI 整理' : '转写稿'}），打开课堂笔记APP看`);
    await pushTodosToPhone(meta.course, meta.course);
    log('===== 流水线结束 =====');
    return;
  }

  // ---- 以下为原私有引擎（zcode 无头会话），保持 v1.x 行为不变 ----
  // v1.6 例题汇总：用户在 APP 课程页给这门课开了开关（电脑端\course-config.json），
  // 才在指令里点名——手册 §2.8 只在点名时执行，没开的课笔记保持原样
  let extra = '';
  try {
    const exCfg = JSON.parse(fs.readFileSync(path.join(HERE, 'course-config.json'), 'utf8'));
    if (exCfg[meta.course] === true) {
      extra = ` 本课程《${meta.course}》已开启「例题汇总」：必须按手册 §2.8 在笔记中产出「🧮 例题汇总」一节。`;
      log(`[examples] 《${meta.course}》开了例题汇总，指令已注入`);
    }
  } catch { }
  // v2.6 理科推导版：数理课的例题/推导/证明按手册 §2.9 的步骤行写（其余课程完全不变）
  const DERIVE_COURSES = ['高数', '高等数学', '线性代数', '线代', '大学物理', '概率', '离散', '复变', '数学分析', '计算方法'];
  if (DERIVE_COURSES.some(k => String(meta.course || '').includes(k))) {
    extra += ` 本课程《${meta.course}》属理科推导课：例题/推导/证明小节按手册 §2.9 的「- ① 公式 ｜ 旁注」步骤行写，其余小节照旧。`;
    log(`[derive] 《${meta.course}》按理科推导格式注入`);
  }
  const prompt = `读取并严格执行 ${MANUAL} 中的课堂记录分析流程，本次处理的会话 ID：${id}。${extra}`;
  let r2 = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`[analyze] 拉起无头会话（第 ${attempt}/3 次）…`);
    r2 = await run(process.execPath, [ZCODE_CLI, '--prompt', prompt, '--cwd', ROOT, '--no-color'], {
      timeoutMs: 45 * 60 * 1000,
    });
    log(`[analyze] exit=${r2.code} ${Math.round(r2.ms / 1000)}s 尾部: ${r2.out.split('\n').slice(-3).join(' | ')}`);
    const okNote = fs.existsSync(path.join(BIJI(id), 'note.md')) && readJson(path.join(BIJI(id), 'status.json'), {}).state === 'done';
    // 成品已交付就收工，不苛求退出码 0：分析会话交付笔记后还跑 026 对照轮等收尾活，
    // 那里挂了会以 exit=1 退场（2026-10-09 程序设计课实发：第 2 次已交付、对照轮 Turn
    // 失败 exit=1，旧逻辑又拉第 3 次重试把 done 状态误盖成 error）。对照轮本就是
    // best-effort，不该连累主笔记。
    if (okNote) { log('[analyze] 笔记已交付（退出码非 0 但成品在），收工'); break; }
    // 内容安全拦截是永久性失败（近 7 天出现 51 次，全是国家安全/近代史这类课）：GLM 返回
    // [1301] potentially unsafe content，重试多少次都一样，只会每次白烧几分钟~几十分钟并占队列。
    // 标记 permanentFailure，rescan 不再自动重排；要再试由手动 /api/reanalyze 触发。
    let safetyHit = /\[1301\]|potentially unsafe or sensitive content/i.test(String(r2.out || ''));
    if (!safetyHit) {
      const tm = String(r2.out || '').match(/traceId:\s*([0-9a-f-]{36})/i);
      if (tm) {
        const info = await traceError(tm[1]);
        if (info) log(`[analyze] traceId ${tm[1]} 回查：${info.slice(0, 200)}`);
        if (/1301|unsafe|sensitive/i.test(info)) safetyHit = true;
      }
    }
    if (safetyHit) {
      log('[analyze] 命中内容安全拦截（1301），重试不会成功，停止');
      writeStatus(id, {
        state: 'error', permanentFailure: true,
        error: 'AI 内容安全拦截（1301）：模型认为本课内容敏感，自动重试不会成功。需要手动重跑或换引擎/模型。',
      });
      break;
    }
    if (attempt < 3) {
      log(`[analyze] 第 ${attempt} 次未交付，60 秒后重试`);
      await new Promise(res => setTimeout(res, 60 * 1000));
      writeStatus(id, { state: 'analyzing', progress: 100, error: '' });
    }
  }

  // ---------- 3) 验收 + 推送 ----------
  const st = readJson(path.join(BIJI(id), 'status.json'), {});
  const noteFile = path.join(BIJI(id), 'note.md');
  if (st.state === 'done' && fs.existsSync(noteFile)) {
    log(`[done] ${id} 笔记完成`);
    await ntfyPush('classnotes-done', `《${st.title || meta.course}》笔记整理好了，打开课堂笔记APP看`);
    await pushTodosToPhone(meta.course, st.title);
  } else {
    const err = st.error || `分析会话退出码 ${r2.code} 但没交付 note.md`;
    writeStatus(id, { state: 'error', error: err });
    log('[X] ' + err);
    await ntfyPush('classnotes-error', `《${meta.course}》笔记分析出了问题：${err.slice(0, 80)}`);
  }
}

main().then(() => log('===== 流水线结束 =====')).catch(e => {
  log('[fatal] ' + (e.stack || e.message));
  try { writeStatus(id, { state: 'error', error: String(e).slice(0, 300) }); } catch { }
});
