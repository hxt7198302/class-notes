// 同日同课合并会话：锚点段已转写、成员段没转写时的手工补齐工具（分析会话临时用）。
// 用法：node 补转写成员段.mjs <会话ID>
// 行为：按 meta.segments 顺序，把还没有 seg_NN/transcribe.done 的段用 transcribe.py 补转写，
//       全程持 pipeline.mjs 同一把 .transcribe.lock（GPU 互斥），完成后重新合并 transcript.json/txt。
// 不删任何东西；覆盖 transcript.json/txt 前先备份到 素材\<ID>\备份\。
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const id = process.argv[2];
if (!/^[A-Za-z0-9_-]{6,64}$/.test(id || '')) { console.error('会话 id 不合法'); process.exit(1); }
const SUCAI = path.join(ROOT, '素材');
const SESS = path.join(SUCAI, id);
const meta = JSON.parse(fs.readFileSync(path.join(SESS, 'meta.json'), 'utf8'));
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const py = CFG.pythonCmd || 'python';

const pad = n => String(n).padStart(2, '0');
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const logf = path.join(HERE, 'logs', `补转写-${id}.log`);
const log = s => { const line = `[${ts()}] ${s}`; fs.appendFileSync(logf, line + '\n'); console.log(line); };

// ---------- GPU 转写锁（与 pipeline.mjs 同一把） ----------
const LOCK_DIR = path.join(HERE, '.transcribe.lock');
const LOCK_STALE_MS = 2 * 60 * 1000;
let beat = null;
async function acquireLock() {
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(path.join(LOCK_DIR, 'owner.txt'), `${id} (补转写) ${process.pid} ${new Date().toISOString()}`);
      beat = setInterval(() => { try { const n = new Date(); fs.utimesSync(LOCK_DIR, n, n); } catch { } }, 30000);
      log('[lock] 已拿到转写锁（GPU 独占）');
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') { log('[lock] 建锁出错，直接跑：' + e.message); return; }
    }
    try {
      const age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
      if (age > LOCK_STALE_MS) {
        const stale = LOCK_DIR + '.stale-' + new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(LOCK_DIR, stale);
        log('[lock] 清理陈旧锁 → ' + path.basename(stale));
        continue;
      }
    } catch { }
    log('[lock] 另一条流水线在转写，等 10 秒…');
    if (Date.now() - t0 > 40 * 60 * 1000) { log('[lock] 等锁超 40 分钟，放弃'); releaseLock(); process.exit(2); }
    await new Promise(r => setTimeout(r, 10000));
  }
}
function releaseLock() {
  try { if (beat) clearInterval(beat); } catch { }
  try { if (fs.readFileSync(path.join(LOCK_DIR, 'owner.txt'), 'utf8').includes(String(process.pid))) fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { }
}
process.on('exit', releaseLock);

const run = (cmd, args) => new Promise(res => {
  const ch = spawn(cmd, args, { windowsHide: true });
  let out = '';
  ch.stdout.on('data', d => { out += d.toString('utf8'); });
  ch.stderr.on('data', d => { out += d.toString('utf8'); });
  ch.on('close', code => res({ code, out }));
});

const matFile = seg => {
  const srcOk = seg.srcId && /^[A-Za-z0-9_-]{6,64}$/.test(seg.srcId);
  return path.join(SUCAI, srcOk ? seg.srcId : id, 'files', seg.name);
};

const segs = meta.segments || [];
const todo = [];
for (let i = 0; i < segs.length; i++) {
  const outDir = path.join(SESS, 'seg_' + pad(i));
  if (fs.existsSync(path.join(outDir, 'transcribe.done'))) continue;
  if (!fs.existsSync(matFile(segs[i]))) { log(`[skip] seg_${pad(i)} 录音缺失：${segs[i].name}`); continue; }
  todo.push(i);
}
log(`===== ${id} 待补转写 ${todo.length} 段：${todo.map(i => 'seg_' + pad(i)).join(' ')} =====`);
if (!todo.length) { log('没有待补段，退出'); process.exit(0); }

await acquireLock();
const t0 = Date.now();
for (const i of todo) {
  const seg = segs[i];
  const inFile = matFile(seg);
  const outDir = path.join(SESS, 'seg_' + pad(i));
  log(`[transcribe] seg_${pad(i)} 开始 ${seg.name}（偏移 ${(seg.startOffsetMs / 60000).toFixed(1)} 分，src=${seg.srcId || '本会话'}）`);
  const r = await run(py, [path.join(HERE, 'transcribe.py'), '--input', inFile, '--outdir', outDir,
    '--model', CFG.whisperModel || 'large-v3', '--lang', CFG.lang || 'zh']);
  const ok = fs.existsSync(path.join(outDir, 'transcribe.done'));
  log(`[transcribe] seg_${pad(i)} exit=${r.code} done=${ok} 用时 ${Math.round((Date.now() - t0) / 1000)}s 尾部: ${r.out.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')}`);
}
releaseLock();

// ---------- 重新合并 ----------
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const allRows = [];
const skipped = [];
for (let i = 0; i < segs.length; i++) {
  const seg = segs[i];
  const outDir = path.join(SESS, 'seg_' + pad(i));
  const rows = readJson(path.join(outDir, 'transcript.json'), []);
  if (!fs.existsSync(path.join(outDir, 'transcribe.done')) || !rows.length) {
    skipped.push({ i, name: seg.name, startMs: seg.startOffsetMs || 0, err: readJson(path.join(outDir, 'status.json'), {}).error || '无转写结果' });
    continue;
  }
  const shift = (seg.startOffsetMs || 0) / 1000;
  for (const rw of rows) allRows.push({ s: rw.s + shift, e: rw.e + shift, t: rw.t });
}
allRows.sort((a, b) => a.s - b.s);

const bakDir = path.join(SESS, '备份');
fs.mkdirSync(bakDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
for (const f of ['transcript.json', 'transcript.txt']) {
  const src = path.join(SESS, f);
  if (fs.existsSync(src)) {
    const ext = path.extname(f);
    fs.copyFileSync(src, path.join(bakDir, `${path.basename(f, ext)}.备份${stamp}${ext}`));
  }
}
fs.writeFileSync(path.join(SESS, 'transcript.json'), JSON.stringify(allRows, null, 1));
const fmtTs = sec => { const s = Math.max(0, Math.floor(sec)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const lines = allRows.map(rw => `[${fmtTs(rw.s)}] ${rw.t}`);
for (const sk of skipped.sort((a, b) => a.startMs - b.startMs)) {
  const from = sk.startMs / 1000;
  const marker = `【${fmtTs(from)} 起的一段录音无法转写（${sk.err}），此段内容缺失】`;
  let pos = lines.findIndex(line => { const m = line.match(/^\[(\d+):(\d+)\]/); return m && (+m[1] * 60 + +m[2]) >= from + 570; });
  if (pos < 0) pos = lines.length;
  lines.splice(pos, 0, marker);
}
fs.writeFileSync(path.join(SESS, 'transcript.txt'), lines.join('\n'));
log(`===== 合并完成：${allRows.length} 条 / 成功 ${segs.length - skipped.length}/${segs.length} 段 / 跳过 ${skipped.length} / 总耗时 ${Math.round((Date.now() - t0) / 1000)}s =====`);
