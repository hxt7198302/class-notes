// 课堂笔记分析流水线：一个会话一条龙「转写 → AI 分析 → 推送」。
// 用法：node pipeline.mjs <sessionId>
// 转写用本机 faster-whisper（GPU 优先）；AI 分析用 ZCode 无头会话执行
// 《分析任务说明.md》。全程状态写 笔记/<id>/status.json，日志写 电脑端/logs/<id>.log。
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');   // 程序根目录（HERE=电脑端，退一级即到）
const SUCAI = id => path.join(ROOT, '素材', id);
const BIJI = id => path.join(ROOT, '笔记', id);
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const NTFY_TOPIC = CFG.ntfyTopic;
// 可选的私有 AI 引擎（engine=zcode 时才用）：用环境变量 ZCODE_CLI 指向你自己的无头 CLI。
// 公开版默认留空，普通用户走 engine=glm（免费 API Key）或 template（无 AI 转写稿）。
const ZCODE_CLI = process.env.ZCODE_CLI || CFG.zcodeCli || '';
const MANUAL = path.join(HERE, '分析任务说明.md');

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

async function main() {
  if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) { log('[X] 会话 id 不合法'); return; }
  const meta = readJson(path.join(SUCAI(id), 'meta.json'), null);
  if (!meta) { log(`[X] ${id} 没有 meta.json，跳过`); return; }
  const st0 = readJson(path.join(BIJI(id), 'status.json'), {});
  if (st0.state === 'done') { log(`[skip] ${id} 已完成`); return; }
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
  let doneCount = 0;
  const allRows = [];
  const skipped = [];   // 转写失败/缺失的段：跳过不拖死整堂课，合并时在时间轴上留缺口标记
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
      const r = await run(py, [
        path.join(HERE, 'transcribe.py'),
        '--input', inFile, '--outdir', outDir,
        '--model', CFG.whisperModel || 'large-v3', '--lang', CFG.lang || 'zh',
      ], {
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
    log('===== 流水线结束 =====');
    return;
  }

  // ---- 以下为原私有引擎（zcode 无头会话），保持 v1.x 行为不变 ----
  // 开源版提示：没有配置 ZCODE_CLI 就直接报清楚，别让 node 拿着空路径瞎跑
  if (!ZCODE_CLI || !fs.existsSync(ZCODE_CLI)) {
    const msg = '引擎 engine=zcode 需要先配置无头 CLI：设置环境变量 ZCODE_CLI 指向 CLI 的 .cjs/.js，或在 config.json 里加 "zcodeCli"。普通用户请改用 engine=glm 或 template。';
    writeStatus(id, { state: 'error', error: msg });
    log('[X] ' + msg);
    return;
  }
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
  const prompt = `读取并严格执行 ${MANUAL} 中的课堂记录分析流程，本次处理的会话 ID：${id}。${extra}`;
  let r2 = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`[analyze] 拉起无头会话（第 ${attempt}/3 次）…`);
    r2 = await run(process.execPath, [ZCODE_CLI, '--prompt', prompt, '--cwd', process.env.ZCODE_CWD || ROOT, '--no-color'], {
      timeoutMs: 45 * 60 * 1000,
    });
    log(`[analyze] exit=${r2.code} ${Math.round(r2.ms / 1000)}s 尾部: ${r2.out.split('\n').slice(-3).join(' | ')}`);
    const okNote = fs.existsSync(path.join(BIJI(id), 'note.md')) && readJson(path.join(BIJI(id), 'status.json'), {}).state === 'done';
    if (r2.code === 0 && okNote) break;
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
