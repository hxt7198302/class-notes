// 同日同课存量回填：把已经收齐/出完笔记的「同课程+同自然日」多段会话归并到当日最早的锚点。
// 与 server.mjs 的 mergeMemberInto 同一套规则（srcId + 时间平移 + 段级转写缓存搬家），
// 供 v1.4 上线时对存量数据一次性补并；之后新上传的由服务端自动归并，不再用本脚本。
// 用法：node 同日合并-补跑.mjs [--dry] [--since=YYYY-MM-DD]
//   --dry          只打印归并计划，不动任何文件
//   --since=日期   只处理该日期（含）之后的会话；不填=全部
// 改前把要动的 meta/status/note 备份到 任务根\备份\同日合并-<时间戳>\，零删除。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SUCAI = path.join(ROOT, '素材');
const BIJI = path.join(ROOT, '笔记');
const BAK = path.join(ROOT, '备份');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const since = (args.find(a => a.startsWith('--since=')) || '').split('=')[1] || '';

const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const writeJson = (f, obj) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, f);
};
const dayKey = ms => {
  const d = new Date(Number(ms) || 0);
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
const safeId = s => /^[A-Za-z0-9_-]{6,64}$/.test(s || '') ? s : null;

// ---------- 收集分组 ----------
const sess = [];
for (const d of fs.readdirSync(SUCAI)) {
  if (!safeId(d)) continue;
  const m = readJson(path.join(SUCAI, d, 'meta.json'), null);
  if (!m) continue;
  if (String(m.course || '').includes('自测')) continue;
  if (m.mergedInto) continue;
  if (!fs.existsSync(path.join(SUCAI, d, 'complete.flag'))) continue;
  if (since && dayKey(m.startedAt) < since) continue;
  sess.push(m);
}
const groups = new Map();
for (const m of sess) {
  const k = m.course + '|' + dayKey(m.startedAt);
  (groups.get(k) || groups.set(k, []).get(k)).push(m);
}

const plans = [];
for (const [k, list] of groups) {
  if (list.length < 2) continue;
  list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  plans.push({ key: k, anchor: list[0], members: list.slice(1) });
}
plans.sort((a, b) => a.key.localeCompare(b.key));

console.log(`待归并分组 ${plans.length} 个${dry ? '（dry 只看不改）' : ''}：`);
for (const p of plans) {
  console.log(`  [${p.key}] 锚点=${p.anchor.id}（${dayKey(p.anchor.startedAt)} ${new Date(p.anchor.startedAt).toTimeString().slice(0, 5)}）`);
  for (const m of p.members) console.log(`    <- ${m.id}（${new Date(m.startedAt).toTimeString().slice(0, 5)} 起，段${m.segments?.length || 0} 照片${m.photos?.length || 0}）`);
}
if (dry || plans.length === 0) process.exit(0);

// ---------- 备份 ----------
const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 17);
let bakDir = '';
const backup = id => {
  const srcs = [
    [SUCAI, id, 'meta.json'],
    [BIJI, id, 'status.json'],
    [BIJI, id, 'note.md'],
    [BIJI, id, 'items.json'],
  ];
  for (const [root, id2, f] of srcs) {
    const p = path.join(root, id2, f);
    if (!fs.existsSync(p)) continue;
    const dst = path.join(bakDir, path.basename(root), id2, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(p, dst);
  }
};

// ---------- 执行归并 ----------
for (const p of plans) {
  bakDir = path.join(BAK, '同日合并-' + ts);
  fs.mkdirSync(bakDir, { recursive: true });
  const a = p.anchor, aId = a.id;
  backup(aId);
  const segs = (a.segments || []).slice();
  const photos = (a.photos || []).slice();
  const markers = (a.markers || []).slice();
  const members = (a.members || []).slice();
  let movedSegs = 0, copiedCache = 0;
  for (const m of p.members) {
    backup(m.id);
    const shift = (m.startedAt || 0) - (a.startedAt || 0);
    const mSegs = m.segments || [];
    let copiedHere = 0;
    for (let j = 0; j < mSegs.length; j++) {
      const s = mSegs[j];
      if (segs.some(x => x.srcId === m.id && x.name === s.name)) continue;
      const newIdx = segs.length;
      segs.push({ name: s.name, startOffsetMs: (s.startOffsetMs | 0) + shift, srcId: m.id });
      movedSegs++;
      const srcDir = path.join(SUCAI, m.id, 'seg_' + String(j).padStart(2, '0'));
      if (fs.existsSync(path.join(srcDir, 'transcribe.done'))) {
        const rows = readJson(path.join(srcDir, 'transcript.json'), null);
        if (rows && rows.length) {
          const dstDir = path.join(SUCAI, aId, 'seg_' + String(newIdx).padStart(2, '0'));
          fs.mkdirSync(dstDir, { recursive: true });
          const sh = shift / 1000;
          writeJson(path.join(dstDir, 'transcript.json'), rows.map(rw => ({ s: rw.s + sh, e: rw.e + sh, t: rw.t })));
          fs.writeFileSync(path.join(dstDir, 'transcribe.done'), new Date().toISOString());
          copiedCache++; copiedHere++;
        }
      }
    }
    for (const ph of (m.photos || [])) {
      if (photos.some(x => x.srcId === m.id && x.name === ph.name)) continue;
      photos.push({ name: ph.name, offsetMs: (ph.offsetMs | 0) + shift, takenAt: ph.takenAt | 0, srcId: m.id });
    }
    for (const mk of (m.markers || [])) {
      const off = (mk.offsetMs | 0) + shift;
      if (markers.some(x => x.srcId === m.id && x.offsetMs === off)) continue;
      markers.push({ offsetMs: off, type: mk.type || '🔖重点', note: mk.note || '', srcId: m.id });
    }
    members.push({ id: m.id, startedAt: m.startedAt || 0, durationMs: m.durationMs | 0 });
    // 成员：标记已并入 + 状态落 uploaded（rescan 见 mergedInto 不会再入队）
    writeJson(path.join(SUCAI, m.id, 'meta.json'), { ...m, mergedInto: aId });
    const mst = readJson(path.join(BIJI, m.id, 'status.json'), {});
    writeJson(path.join(BIJI, m.id, 'status.json'), { ...mst, state: 'uploaded', mergedInto: aId, error: '', note: `已并入同日同课 ${aId}`, updatedAt: new Date().toISOString() });
    console.log(`  [${aId}] <- ${m.id} 平移 ${Math.round(shift / 1000)}s：+${mSegs.length} 段，转写缓存复用 ${copiedHere} 段`);
  }
  writeJson(path.join(SUCAI, aId, 'meta.json'), { ...a, segments: segs, photos, markers, members, mergeDirty: false });
  // 锚点置 queued：新服务启动时 rescan 会自动入队重跑（段级缓存全在，几乎只重做 AI 分析）
  const st = readJson(path.join(BIJI, aId, 'status.json'), {});
  writeJson(path.join(BIJI, aId, 'status.json'), { ...st, state: 'queued', error: '', note: `同日同课回填归并 ${p.members.length} 段（转写缓存${copiedCache}段复用），待重跑分析`, updatedAt: new Date().toISOString() });
  console.log(`  [${aId}] 归并完成：共 ${segs.length} 段 / ${photos.length} 照片 / ${markers.length} 标记，状态→queued`);
}
console.log(`\n备份在 ${path.join(BAK, '同日合并-' + ts)}。下一步：重启 API 服务，rescan 会自动把锚点重新入队。`);
