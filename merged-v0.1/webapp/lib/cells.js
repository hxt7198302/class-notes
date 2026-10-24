// cells.js —— 几何层: OCR词 + 逐行彩色剖面 -> 课程
// 架构: 星期锚点切列 → 词聚成文本行 → 有课名的行=新课, 纯括号行=续行 → 纵向彩色填充延伸定节次跨度
'use strict';
const { parseCellVerbatim } = require('./parse');
const schools = require('./schools');

const CN_DAY = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

// ---------- 课名纠正: 识别名 vs 内置规范课名表 ----------
const CANON = (() => {
  const s = [];
  for (const k of Object.keys(schools)) (schools[k].courseNames || []).forEach(n => { if (!s.includes(n)) s.push(n); });
  return s;
})();
function dice(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bg = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ra = bg(a), rb = bg(b);
  let hit = 0;
  for (const [g, c] of ra) if (rb.has(g)) hit += Math.min(c, rb.get(g));
  return 2 * hit / ((a.length - 1) + (b.length - 1));
}
function levSim(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return a === b ? 1 : 0;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[n] / Math.max(m, n);
}
function canonicalName(name) {
  if (!name || !CANON.length) return name;
  const sq = String(name).replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '');
  if (!sq) return name;
  let best = null, bs = 0, lv = 0;
  for (const cn of CANON) {
    const d = dice(sq, cn);
    if (d > bs) { bs = d; best = cn; lv = levSim(sq, cn); }
  }
  if (!best) return name;
  if (bs >= 0.85) return best;
  const hasJunk = /[\s：:·•„…'“”‘’、,，。.\-—~()（）]/.test(name) || /灬|氵/.test(sq);
  const lenDiff = sq.length !== best.length;
  // 双判据: dice 或 编辑距离相似度过强线即视为可纠正; 但必须有杂字/长度差佐证, 或等长且差异全汉字
  const strong = bs >= 0.6 || lv >= 0.55;
  if (!strong) return name;
  if (hasJunk || lenDiff) return best;
  if (sq.length === best.length) {
    const diffs = [...sq].filter((ch, i) => ch !== best[i]);
    if (diffs.length && diffs.every(ch => /[\u4e00-\u9fa5]/.test(ch))) return best;
  }
  return name;
}

function normalizeText(t) {
  t = String(t).replace(/([\u4e00-\u9fa5）])\s+(?=[\u4e00-\u9fa5（()])/g, '$1');
  t = t.replace(/([\u4e00-\u9fa5）])\s+(?=[0-9#A-Za-z])/g, '$1');
  t = t.replace(/(\d)\s*[．·]\s*(\d)/g, '$1-$2');
  t = t.replace(/(\d)\s*#\s*(\d)/g, '$1#$2');
  return t.trim();
}
function normalizeLineText(ws) {
  return normalizeText(ws.map(w => w.text).join(' '));
}

function extractTimetable(img, words, meta = {}) {
  const { width, height, rgb } = img;
  const lumOf = i => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  const satOf = i => Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) - Math.min(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  const isColored = i => { const s = satOf(i), L = lumOf(i); return s >= 14 && L >= 60 && L <= 246; };

  // ---- 节次列定位(与 ocr.js findCrop 同判据): x聚类30 → x±14对齐 → y分段150 → 连续前缀评分 ----
  // 节次列的数字是从1开始的连续序列, 周次/时间/学号数字不可能连续
  const digitWords = words.filter(w => /^\d{1,2}$/.test(w.text) && +w.text >= 1 && +w.text <= 25)
    .map(w => ({ sec: +w.text, x: w.x + w.w / 2, y: w.y + w.h / 2 }));
  if (digitWords.length < 3) throw new Error(`节次数字识别不足(${digitWords.length}个)`);
  const byX = digitWords.slice().sort((a, b) => a.x - b.x);
  const clusters = [];
  for (const d of byX) {
    const last = clusters[clusters.length - 1];
    if (last && d.x - last.maxX < 30) { last.ws.push(d); last.maxX = d.x; }
    else clusters.push({ ws: [d], maxX: d.x });
  }
  function prefixScore(ws) {
    const u = new Set(ws.map(d => d.sec));
    let k = 0;
    while (u.has(k + 1)) k++;
    return k;
  }
  let bestCol = null, bestScore = 0;
  // 节次列结构先验: 必然是所有合格簇中最靠左的(左侧时间栏)——先按簇x中位数升序遍历
  clusters.sort((a, b) => {
    const ax = a.ws.reduce((t, d) => t + d.x, 0) / a.ws.length;
    const bx = b.ws.reduce((t, d) => t + d.x, 0) / b.ws.length;
    return ax - bx;
  });
  outer_loop:
  for (const cl of clusters) {
    const xs = cl.ws.map(d => d.x).sort((a, b) => a - b);
    const xMed = xs[Math.floor(xs.length / 2)];
    const aligned = cl.ws.filter(d => Math.abs(d.x - xMed) < 14);
    if (aligned.length < 3) continue;
    const byY = aligned.slice().sort((a, b) => a.y - b.y);
    const segs = [[byY[0]]];
    for (let i = 1; i < byY.length; i++) {
      const seg = segs[segs.length - 1];
      if (byY[i].y - seg[seg.length - 1].y > 150) segs.push([byY[i]]);
      else seg.push(byY[i]);
    }
    for (const seg of segs) {
      const sc = prefixScore(seg);
      if (sc >= 3 && sc > bestScore) { bestScore = sc; bestCol = seg; break outer_loop; }
    }
  }
  if (!bestCol || bestScore < 3) throw new Error(`节次列定位失败(连续前缀=${bestScore})`);
  if (global.__KB_ANCHOR_DEBUG) console.log(`  [节次列] 连续前缀=${bestScore} 值=[${bestCol.map(d => d.sec).join(',')}]`);
  const digits = bestCol.slice().sort((a, b) => a.y - b.y);
  const seenS = new Set(), digitsU = [];
  for (const d of digits) if (!seenS.has(d.sec)) { seenS.add(d.sec); digitsU.push(d); }
  if (digitsU.length < 3) throw new Error('节次列定位失败');
  const gaps = [];
  for (let i = 1; i < digitsU.length; i++) gaps.push(digitsU[i].y - digitsU[i - 1].y);
  gaps.sort((a, b) => a - b);
  const rowPitch = gaps[Math.floor(gaps.length / 2)];
  const bands = digitsU.map((d, i) => ({
    sec: d.sec,
    top: i === 0 ? d.y - rowPitch / 2 : (digitsU[i - 1].y + d.y) / 2,
    bottom: i === digitsU.length - 1 ? d.y + rowPitch / 2 : (d.y + digitsU[i + 1].y) / 2,
    cy: d.y
  }));
  const tableTop = bands[0].top, tableBottom = bands[bands.length - 1].bottom;
  // y 范围守卫: 课必须落在节次列数字覆盖范围内(±半行距)。页面底部"课程列表"表格
  // 在此范围之外, 一旦混入 pass2 词流会被此处整体丢弃 (结构守卫, 比名称过滤可靠)
  const lastBandBottom = tableBottom;

  // ---- 星期锚点(节次行上方的文字簇) ----
  const headerZone = words.filter(w => (w.y + w.h / 2) < digitsU[0].y - rowPitch * 0.3 && (w.y + w.h / 2) > tableTop - rowPitch * 2.2);
  // 页头词先按y分行(手机图页头含标题/说明/姓名多行, 直接按x链会把整页头连成一坨), 再行内按x聚类
  const allLineH = (() => {
    const hs = words.map(w => w.h).sort((a, b) => a - b);
    return hs[Math.floor(hs.length / 2)] || 20;
  })();
  const hzLines = [];
  for (const w of headerZone.slice().sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2))) {
    const last = hzLines[hzLines.length - 1];
    if (last && Math.abs((w.y + w.h / 2) - last.cy) < allLineH * 0.8) {
      last.words.push(w);
      last.cy = (last.cy * (last.words.length - 1) + (w.y + w.h / 2)) / last.words.length;
    } else hzLines.push({ words: [w], cy: w.y + w.h / 2 });
  }
  const hClusters = [];
  for (const ln of hzLines) {
    for (const w of ln.words.slice().sort((a, b) => a.x - b.x)) {
      const last = hClusters[hClusters.length - 1];
      if (last && last.line === ln && w.x - last.maxX < 40) { last.words.push(w); last.maxX = w.x + w.w; }
      else hClusters.push({ words: [w], maxX: w.x + w.w, line: ln });
    }
  }
  const anchors = [];
  for (const cl of hClusters) {
    const text = cl.words.map(w => w.text).join('').replace(/\s+/g, '');
    const m = text.match(/(?:星期|周)([一二三四五六日天])/);
    if (global.__KB_ANCHOR_DEBUG) console.log(`  [hdr簇] x=${Math.round(cl.words[0].x)} "${text}" match=${!!m}`);
    // 真表头簇就是"星期X"三四个字; 长文本(如格式说明"第n周一第m周")里的周X是误命中
    if (m && text.length <= 5) anchors.push({ day: CN_DAY[m[1]], x: (cl.words[0].x + cl.words[cl.words.length - 1].x + cl.words[cl.words.length - 1].w) / 2 });
  }
  anchors.sort((a, b) => a.x - b.x);
  let pitch;
  if (anchors.length >= 3) {
    const pArr = [];
    for (let i = 1; i < anchors.length; i++) pArr.push(anchors[i].x - anchors[i - 1].x);
    pArr.sort((a, b) => a - b);
    pitch = pArr[Math.floor(pArr.length / 2)];
  } else {
    // 表头锚点不足(反白字/波动): 教务课表恒为7等距列, 按图宽先验推断
    const leftX = digitsU[0].x + 30;
    pitch = (width - leftX - 8) / 7;
    anchors.length = 0;
    for (let d = 1; d <= 7; d++) anchors.push({ day: d, x: leftX + pitch * (d - 0.5) });
    if (global.__KB_ANCHOR_DEBUG) console.log('  [锚点] 表头识别不足, 用等距先验推断7列 pitch=', Math.round(pitch));
  }

  // ---- 列扫描 ----
  const lineH = (() => {
    const hs = words.map(w => w.h).sort((a, b) => a - b);
    return hs[Math.floor(hs.length / 2)] || 20;
  })();
  const courses = [];

  for (const a of anchors) {
    const x0 = Math.max(0, Math.round(a.x - pitch * 0.5 + 8));
    const x1 = Math.min(width - 1, Math.round(a.x + pitch * 0.5 - 8));
    if (x1 - x0 < 30) continue;

    // 逐行彩色占比(缓存, 步长2px)
    const yStart = Math.max(0, Math.floor(tableTop)), yEnd = Math.min(height - 1, Math.ceil(tableBottom));
    const occ = new Float32Array(yEnd - yStart + 1);
    for (let y = yStart; y <= yEnd; y += 1) {
      let c = 0, t = 0;
      for (let x = x0; x <= x1; x += 3) { t++; if (isColored(y * width + x)) c++; }
      occ[y - yStart] = t ? c / t : 0;
    }
    const occupied = y => y >= yStart && y <= yEnd && occ[Math.round(y) - yStart] > 0.35;

    // 列内词 → 文本行(锚定窗口聚类)
    const colWords = words.filter(w => {
      const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
      return cx >= x0 && cx <= x1 && cy >= tableTop && cy <= tableBottom;
    }).sort((p, q) => p.y - q.y);
    if (!colWords.length) continue;
    const lines = [];
    for (const w of colWords) {
      const last = lines[lines.length - 1];
      if (!last || (w.y + w.h / 2) - last.maxCy > lineH * 0.5) {
        lines.push({ anchor: w.y + w.h / 2, maxCy: w.y + w.h / 2, words: [w] });
      } else { last.words.push(w); last.maxCy = Math.max(last.maxCy, w.y + w.h / 2); }
    }
    for (const ln of lines) ln.words.sort((p, q) => p.x - q.x);

    // 分组(锚点法): 课名行的特征 = 含字母数字代码 或 ≥4个中文打头(且非拉丁开头)
    // 教师续行(颖）/双领）)永远≤2字或跟在未闭合括号后, 周次/教室行以括号或数字开头
    const lineText = ln => normalizeLineText(ln.words);
    const codeAnywhere = t => /[A-Za-z]{2,}\d|\d[A-Za-z]{2,}/.test(t);
    const cjkHeadCount = t => {
      const m = t.match(/^[\u4e00-\u9fa5]+/);
      return m ? m[0].length : 0;
    };
    const L = lines.map(ln => ({ ln, t: lineText(ln) })).filter(x => x.t);
    let bal = 0;
    for (const x of L) {
      x.balBefore = bal;
      bal += (x.t.match(/[（(]/g) || []).length - (x.t.match(/[）)]/g) || []).length;
      if (bal < 0) bal = 0;
      // 锚点: 含代码的行允许以(开头(课名与代码分行时代码行以括号起); 纯中文打头行需≥4字
      x.isAnchor = codeAnywhere(x.t) ? !/^[，,·．\d]/.test(x.t) : (cjkHeadCount(x.t) >= 4 && !/^[（(【\d，,·．]/.test(x.t));
    }
    const anchorIdx = L.map((x, i) => x.isAnchor ? i : -1).filter(i => i >= 0);
    if (!anchorIdx.length) continue;

    // 相邻锚点合并(课名与代码分行时, 间隔 < 1.8 行高视为同一门课)
    const blocks = [];
    for (const ai of anchorIdx) {
      const last = blocks[blocks.length - 1];
      if (last && (L[ai].ln.anchor - L[last[last.length - 1]].ln.anchor) < lineH * 1.8) last.push(ai);
      else blocks.push([ai]);
    }
    // 前导吸收: 块首锚点的紧邻上一行(间距<1.8行高, 前面括号已闭合, 以中文/字母开头)是课名前半
    for (const b of blocks) {
      let i = b[0] - 1;
      while (i >= 0 && (L[b[0]].ln.anchor - L[i].ln.anchor) < lineH * 1.8
        && L[i].balBefore === 0 && /^[A-Za-z\u4e00-\u9fa5]/.test(L[i].t)
        && !(blocks.some(bb => bb.includes(i)))) {
        b.unshift(i); i--;
      }
    }
    // 课组行范围: 块首(含前导)到下一块首(含其前导)之前
    const groups = blocks.map((b, bi) => {
      const start = b[0];
      const end = (bi + 1 < blocks.length ? blocks[bi + 1][0] : L.length) - 1;
      return { start, end: Math.max(end, b[b.length - 1]), first: L[start], last: L[Math.max(end, b[b.length - 1])] };
    });
    if (!groups.length) continue;

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const firstCy = g.first.ln.anchor;
      const lastCy = g.last.ln.anchor;
      // 课组纵向范围: 文本带 ± 填充延伸, 以相邻课文字中点为界
      const upBound = gi === 0 ? tableTop : (groups[gi - 1].last.ln.anchor + firstCy) / 2;
      const dnBound = gi === groups.length - 1 ? tableBottom : (lastCy + groups[gi + 1].first.ln.anchor) / 2;
      let top = firstCy - lineH * 0.7, bottom = lastCy + lineH * 0.7;
      for (let y = Math.round(top); y > upBound; y -= 2) { if (!occupied(y + 2)) break; top = y; }
      for (let y = Math.round(bottom); y < dnBound; y += 2) { if (!occupied(y - 2)) break; bottom = y; }
      top = Math.max(top, upBound); bottom = Math.min(bottom, dnBound);

      const span = bands.filter(b => b.cy >= top - 1 && b.cy <= bottom + 1);
      // y 范围守卫: 课组底边不得超过节次列末带+半行距 (页面底部课程列表区在此范围外)
      if (!span.length || bottom > lastBandBottom + rowPitch * 0.5) continue;

      // 组文本: 按行序拼接(行内已按x排序normalize), 跨行不做全局重排(会打乱行内顺序)
      let raw = '';
      for (let i = g.start; i <= g.end; i++) raw += (raw ? ' ' : '') + L[i].t;
      const gText = normalizeText(raw);
      const p = parseCellVerbatim(gText);
      if (global.__KB_DEBUG) console.log(`  [col${a.day}] group y=${Math.round(firstCy)}-${Math.round(lastCy)} span=${span[0].sec}-${span[span.length - 1].sec}\n    text: ${gText}\n    parse: ${JSON.stringify(p)}`);
      if (!p || !p.name) continue;
      courses.push({
        name: canonicalName(p.name), teacher: p.teacher || '', day: a.day,
        startSection: span[0].sec, endSection: span[span.length - 1].sec,
        weeksText: p.weeks, room: p.room
      });
    }
  }
  courses.sort((a, b) => a.day - b.day || a.startSection - b.startSection);
  // 同列相邻同名课合并: 合并格被OCR按行距切成两组时, 其中一组往往没读到周次(=全周);
  // 两组都有且不同的周次时是真正分开的两次课(如AI导论9-10/11-12), 不合并
  const merged = [];
  for (const c of courses) {
    const p = merged[merged.length - 1];
    if (!p) { merged.push(c); continue; }
    // 名字相等或互为前缀(第二组名字常带未闭合括号尾巴), 至少4字防误配
    const nm = Math.min(p.name.length, c.name.length) >= 4
      && (p.name.startsWith(c.name) || c.name.startsWith(p.name));
    if (nm && p.day === c.day && c.startSection <= p.endSection + 1
      && (p.weeksText === '全周' || c.weeksText === '全周' || p.weeksText === c.weeksText)) {
      p.endSection = Math.max(p.endSection, c.endSection);
      if (p.weeksText === '全周' && c.weeksText !== '全周') p.weeksText = c.weeksText;
      if (!p.room && c.room) p.room = c.room;
      if (!p.teacher && c.teacher) p.teacher = c.teacher;
    } else merged.push(c);
  }
  return {
    school: meta.school || '', semester: meta.semester || '', owner: meta.owner || '',
    sectionCount: digitsU[digitsU.length - 1].sec,
    courses: merged
  };
}

module.exports = { extractTimetable, canonicalName };
