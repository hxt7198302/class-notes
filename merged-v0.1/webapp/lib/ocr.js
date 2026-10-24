// ocr.js —— 本地OCR课表识别编排: 两遍识别(全图找范围 → 裁剪放大精读) + 几何层
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { decodePNG, encodePNGRGB, cropResizeBilinear } = require('./png');
const { extractTimetable } = require('./cells');

function ocrPNG(pngBuf, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'ocr_engine.ps1')]);
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('OCR超时')); }, timeoutMs);
    p.stdout.on('data', c => out += c);
    p.stderr.on('data', c => err += c);
    p.on('error', e => { clearTimeout(timer); reject(new Error('无法启动powershell: ' + e.message)); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`OCR失败(exit ${code}): ${err || out.slice(0, 200)}`));
      try {
        const j = JSON.parse(out);
        if (j && j.error) return reject(new Error(j.error));
        resolve(j);
      } catch (e) { reject(new Error('OCR输出解析失败: ' + out.slice(0, 150))); }
    });
    p.stdin.write(pngBuf.toString('base64'));
    p.stdin.end();
  });
}

// 第一遍: 找节次数字列(全图), 决定裁剪框
// 数字列按x容差聚类(固定分桶会把 x=99/x=101 劈成两桶); 裁剪框上界按行距自适应(手机截图行距大)
function findCrop(img, words) {
  const digs = [];
  for (const w of words) {
    if (!/^\d{1,2}$/.test(w.text)) continue;
    const v = +w.text;
    if (v < 1 || v > 25) continue;
    digs.push(w);
  }
  if (digs.length < 3) return null;
  // x聚类(容差30: 节次数字窄且紧密, 与邻列周次数字相距远)
  const byX = digs.slice().sort((a, b) => a.x - b.x);
  const clusters = [];
  for (const w of byX) {
    const last = clusters[clusters.length - 1];
    if (last && w.x - last.maxX < 30) { last.ws.push(w); last.maxX = w.x + w.w; }
    else clusters.push({ ws: [w], maxX: w.x + w.w });
  }
  // 连续前缀评分: 段内互异数字从1开始能连到几(节次列=1,2,3...连续; 周次/时间/学号不可能连续)
  function prefixScore(ws) {
    const u = new Set(ws.map(w => +w.text));
    let k = 0;
    while (u.has(k + 1)) k++;
    return k;
  }
  let best = null, bestTop = Infinity;
  for (const cl of clusters) {
    // x±14 垂直对齐过滤(剔邻列渗入的零散数字)
    const xs = cl.ws.map(w => w.x + w.w / 2).sort((a, b) => a - b);
    const xMed = xs[Math.floor(xs.length / 2)];
    const aligned = cl.ws.filter(w => Math.abs((w.x + w.w / 2) - xMed) < 14);
    if (process.env.KB_CROP_DEBUG) console.log(`[findCrop] 簇 x≈${Math.round(xMed)} 词数=${cl.ws.length} 对齐数=${aligned.length}`);
    if (aligned.length < 3) continue;
    // y分段(剔状态栏等远处异物)
    const byY = aligned.slice().sort((a, b) => a.y - b.y);
    const segs = [[byY[0]]];
    for (let i = 1; i < byY.length; i++) {
      const seg = segs[segs.length - 1];
      if (byY[i].y - seg[seg.length - 1].y > 150) segs.push([byY[i]]);
      else seg.push(byY[i]);
    }
    for (const seg of segs) {
      // 合格段=含"从1连起"的数字; 取最靠上的(节次列在页面上部, 课程列表序号在页脚)
      const u = new Set(seg.map(w => +w.text));
      let k = 0;
      while (u.has(k + 1)) k++;
      if (process.env.KB_CROP_DEBUG) console.log(`[findCrop] 段 y=${Math.round(seg[0].y)}-${Math.round(seg[seg.length - 1].y)} 前缀=${k} 值=[${seg.map(w => w.text).join(',')}]`);
      if (k >= 3 && seg[0].y < bestTop) { bestTop = seg[0].y; best = { ws: seg }; }
    }
  }
  if (process.env.KB_CROP_DEBUG) console.log('[findCrop] bestTop=', Math.round(bestTop));
  if (!best) return null;
  const seen = new Set();
  const col = best.ws.filter(w => { if (seen.has(+w.text)) return false; seen.add(+w.text); return true; })
    .sort((a, b) => a.y - b.y);
  if (process.env.KB_CROP_DEBUG) console.log('[findCrop] 节次列:', col.map(w => w.text + '@' + Math.round(w.y)).join(' '));
  const gaps = [];
  for (let i = 1; i < col.length; i++) gaps.push(col[i].y - col[i - 1].y);
  gaps.sort((a, b) => a - b);
  const pitch = gaps[Math.floor(gaps.length / 2)] || 60;
  const digitX = Math.min(...best.ws.map(w => w.x));
  return {
    x0: Math.max(0, digitX - 45),
    y0: Math.max(0, col[0].y - pitch * 1.9),
    x1: img.width,
    y1: Math.min(img.height, col[col.length - 1].y + col[col.length - 1].h + pitch * 1.4),
    pitch
  };
}

// (条带专扫方案已移除: 对压缩截图的节次列读取先天残缺, 外推/注入均引入更严重回归——2026-09-03 验证后废弃)

// 后验防垃圾: 课程列表表格被误识别时, "课名"呈纯英数代码形态(如 BDTN021/C)T)——
// 真课名必含至少2个中文字符, 不满足者剔除
function filterJunkCourses(data) {
  if (data && Array.isArray(data.courses)) {
    data.courses = data.courses.filter(c => {
      const zh = (String(c.name || '').match(/[\u4e00-\u9fa5]/g) || []).length;
      return zh >= 2;
    });
  }
  return data;
}

async function parseTimetablePNG(pngBuf) {
  const img = decodePNG(pngBuf);
  const ctx = {}; // (保留占位: 条带专扫方案已验证不可靠并移除)
  // Windows OCR 对同一张图存在轮次波动(节次列/表头时读时不读)——整流程三轮重试, 三次抽样稀释波动
  let lastErr = null;
  for (let round = 0; round < 3; round++) {
    try {
      if (round > 0) console.log(`[OCR] === 全流程第 ${round + 1} 轮 ===`);
      const out = await attemptOnce(img, pngBuf, ctx);
      return out;
    } catch (e) {
      lastErr = e;
      if (!/节次列|表头|定位/.test(e.message)) throw e; // 仅定位类失败可重试
    }
  }
  throw lastErr;
}

async function attemptOnce(img, pngBuf, ctx) {
  let words1 = await ocrPNG(pngBuf);
  let crop = findCrop(img, words1);
  for (let t = 1; !crop && t <= 2; t++) {
    console.log(`[OCR] 节次列未定位, 第${t}次重试…`);
    words1 = await ocrPNG(pngBuf);
    crop = findCrop(img, words1);
  }
  if (!crop) {
    // 表头锚定救命: pass1 对表头"星期X"和页脚"课程列表"这类大字读取稳定(节次小数字才是弱项)
    // 用表头行定表格顶、页脚定表格底, 把课程列表区裁出画面
    const dayWords = words1.filter(w => /星期/.test(w.text) || /^周[一二三四五六日天]$/.test(w.text));
    if (dayWords.length >= 3) {
      const hy = Math.min(...dayWords.map(w => w.y));
      const footW = words1.find(w => (w.text || '').includes('课程列表'));
      const y1 = footW ? Math.max(hy + 120, footW.y - 12) : img.height;
      const xs = dayWords.map(w => w.x).sort((a, b) => a - b);
      const spread = xs[xs.length - 1] - xs[0];
      if (spread > img.width * 0.35) { // 表头词横跨大半图宽才可信
        crop = { x0: 0, y0: Math.max(0, Math.round(hy - 30)), x1: img.width, y1: Math.min(img.height, Math.round(y1)), pitch: Math.round(spread / 5) };
        console.log('[OCR] 表头锚定 crop:', JSON.stringify(crop), ' 表头词', dayWords.length);
      }
    }
  }
  if (!crop) {
    // 条带专扫救命: 扫最左侧竖条放大补读节次数字, 按"节次列严格等距"最小二乘外推补全 1-12 (封顶防卷入页脚)
    try {
      const bx0 = 0, bx1 = Math.round(img.width * 0.13);
      const wantScale = 2.9;
      const nB = Math.max(1, Math.ceil(img.height * wantScale / 4090));
      const out = [];
      for (let b = 0; b < nB; b++) {
        const y0 = Math.round(img.height * b / nB), y1 = Math.round(img.height * (b + 1) / nB);
        const sc = Math.min(wantScale, 4090 / (y1 - y0));
        const st = cropResizeBilinear(img, bx0, y0, bx1, y1, sc);
        const ws = await ocrPNG(encodePNGRGB(st.width, st.height, st.rgb));
        for (const w of ws) {
          if (!/^\d{1,2}$/.test(w.text)) continue;
          const v = +w.text;
          if (v < 1 || v > 25) continue;
          out.push({ text: w.text, x: w.x / sc + bx0, y: w.y / sc + y0, w: w.w / sc, h: w.h / sc });
        }
      }
      const byY = out.slice().sort((a, b) => a.y - b.y);
      let col = [];
      if (byY.length) {
        const segs = [[byY[0]]];
        for (let i = 1; i < byY.length; i++) {
          const sg = segs[segs.length - 1];
          if (byY[i].y - sg[sg.length - 1].y > 150) segs.push([byY[i]]);
          else sg.push(byY[i]);
        }
        let bestS = null, bs = 0;
        for (const sg of segs) {
          const u = new Set(sg.map(w => +w.text));
          let k = 0;
          while (u.has(k + 1)) k++;
          if (k > bs) { bs = k; bestS = sg; }
        }
        if (bestS) {
          const seen = new Set();
          for (const w of bestS.slice().sort((a, b) => a.y - b.y)) {
            if (!seen.has(+w.text)) { seen.add(+w.text); col.push(w); }
          }
        }
      }
      if (col.length >= 2) {
        // 等距外推: 最小二乘 y = a + b*sec, 补齐 1-12 (封顶12节防卷入页脚)
        const pts = col.map(w => ({ s: +w.text, y: w.y }));
        const n = pts.length;
        const sm = pts.reduce((t, p) => t + p.s, 0), sym = pts.reduce((t, p) => t + p.y, 0);
        const ssm = pts.reduce((t, p) => t + p.s * p.s, 0), sxy = pts.reduce((t, p) => t + p.s * p.y, 0);
        const denom = n * ssm - sm * sm;
        const b2 = denom ? (n * sxy - sm * sym) / denom : 0;
        const a2 = (sym - b2 * sm) / n;
        if (b2 > 40 && b2 < 250) {
          const xCol = col.reduce((t, w) => t + w.x, 0) / col.length;
          const have = new Map(pts.map(p => [p.s, p.y]));
          col = [];
          for (let sec = 1; sec <= 12; sec++) {
            const y = have.has(sec) ? have.get(sec) : a2 + b2 * sec;
            col.push({ text: String(sec), x: xCol, y, w: 24, h: 24 });
          }
          const ys = col.map(w => w.y);
          const gp = [];
          for (let i = 1; i < ys.length; i++) gp.push(ys[i] - ys[i - 1]);
          gp.sort((x, y) => x - y);
          const pitch = gp[Math.floor(gp.length / 2)] || 70;
          const xCol2 = col.reduce((t, w) => t + w.x, 0) / col.length;
          crop = {
            x0: Math.max(0, Math.round(xCol2 - 45)),
            y0: Math.max(0, Math.round(ys[0] - pitch * 1.9)),
            x1: img.width,
            y1: Math.min(img.height, Math.round(ys[ys.length - 1] + pitch * 0.8)),
            pitch
          };
          ctx.stripRef = col; // 节次列真源: 供 pass2 词流注入(替换污染数字列)
          console.log('[OCR] 条带专扫+外推定位节次列:', col.map(w => w.text + '@' + Math.round(w.y)).join(' '));
        }
      }
    } catch (e) { console.log('[strip] 失败:', e.message); }
  }
  if (!crop) { console.log('[OCR] 多种定位均失败, 退化整图(节次边界可能有偏差, 请核对)'); crop = { x0: 0, y0: 0, x1: img.width, y1: img.height, pitch: 70 }; }
  if (process.env.KB_CROP_DEBUG) console.log('[findCrop] crop=', JSON.stringify(crop));
  const all1 = words1.map(w => w.text).join('').replace(/\s+/g, '');
  const school = /物资学院/.test(all1) ? '北京物资学院' : '';
  const semM = all1.match(/20\d{2}[\s\S]{0,4}20\d{2}学年第?\d学期/);
  const semester = semM ? semM[0] : '';
  // 学生姓名(教务页头"姓名(学号)"模式), 用于历史记录自动命名
  const ownM = all1.match(/([\u4e00-\u9fa5]{2,4})[（(]\d{7,14}[）)]/);
  const owner = ownM ? ownM[1] : '';
  const cw = Math.max(1, crop.x1 - crop.x0), ch = Math.max(1, crop.y1 - crop.y0);

  // 目标放大率(宽约3400px), 高度超4096时分片OCR再拼回; 重叠按行距自适应(保切缝两侧各有完整一行字)
  const wantScale = Math.min(3400 / cw, 2.9);
  const nBands = Math.max(1, Math.ceil((ch * wantScale) / 4090));
  const overlap = Math.round(Math.min((crop.pitch || 70) * 0.9, 120));

  // 单片: 几何层直接跑在放大图上(坐标最精细, 桌面图走此路)
  if (nBands === 1) {
    const scale = Math.max(1, Math.min(wantScale, 4090 / Math.max(cw, ch)));
    const scaled = cropResizeBilinear(img, crop.x0, crop.y0, crop.x1, crop.y1, scale);
    const png2 = encodePNGRGB(scaled.width, scaled.height, scaled.rgb);
    // pass2 OCR 也有轮次波动: 节次列定位失败时重跑一次
    for (let attempt = 0; attempt < 2; attempt++) {
      let ws = await ocrPNG(png2);
      if (!Array.isArray(ws) || ws.length < 20) throw new Error('OCR没有读到足够文字(图片是否为课表截图?)');
      try {
        return filterJunkCourses(extractTimetable({ width: scaled.width, height: scaled.height, rgb: scaled.rgb }, ws, { school, semester }));
      } catch (e) {
        if (!/节次列|表头/.test(e.message) || attempt === 1) throw e;
        console.log('[OCR] pass2 节次列定位失败, 重跑一次…');
      }
    }
  }

  // 多片(高图): 各片放大OCR后把词映射回裁剪坐标系, 几何层在裁剪分辨率运行
  const words2 = [];
  for (let b = 0; b < nBands; b++) {
    const y0b = crop.y0 + Math.round(ch * b / nBands) - (b > 0 ? overlap : 0);   // 相邻片重叠防切字
    const y1b = crop.y0 + Math.round(ch * (b + 1) / nBands) + (b < nBands - 1 ? overlap : 0);
    const bh = y1b - y0b;
    const bScale = Math.min(wantScale, 4090 / bh, 4090 / cw);
    const scaled = cropResizeBilinear(img, crop.x0, y0b, crop.x1, y1b, bScale);
    const png2 = encodePNGRGB(scaled.width, scaled.height, scaled.rgb);
    const ws = await ocrPNG(png2);
    for (const w of ws) {
      words2.push({
        text: w.text,
        x: w.x / bScale, y: w.y / bScale + (y0b - crop.y0),
        w: w.w / bScale, h: w.h / bScale
      });
    }
  }
  // 去重叠带重复词(同文本且位置近)
  const dedup = [];
  for (const w of words2.sort((a, b) => a.y - b.y)) {
    if (!dedup.some(d => d.text === w.text && Math.abs(d.x - w.x) < 12 && Math.abs(d.y - w.y) < 12)) dedup.push(w);
  }
  if (dedup.length < 20) throw new Error('OCR没有读到足够文字(图片是否为课表截图?)');

  // 条带节次列真源注入(裁剪坐标): 剔除 pass2 污染数字列, 换成条带外推补全的干净 1-12 列
  if (ctx.stripRef && ctx.stripRef.length >= 4) {
    console.log('[inject] stripRef词数=', ctx.stripRef.length, ' crop=', JSON.stringify(crop));
    const cx = ctx.stripRef.reduce((t, w) => t + (w.x - crop.x0), 0) / ctx.stripRef.length;
    const cleaned = dedup.filter(w => !(new RegExp('^\\d{1,2}$').test(w.text) && Math.abs((w.x + w.w / 2) - cx) < 45));
    for (const w of ctx.stripRef) {
      cleaned.push({ text: w.text, x: w.x - crop.x0, y: w.y - crop.y0, w: w.w, h: w.h });
    }
    dedup.length = 0;
    dedup.push(...cleaned);
  }

  // 几何层统一在裁剪分辨率坐标上运行; pass2 波动导致节次列失败时重跑一次
  const cropImg = cropResizeBilinear(img, crop.x0, crop.y0, crop.x1, crop.y1, 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return filterJunkCourses(extractTimetable({ width: cropImg.width, height: cropImg.height, rgb: cropImg.rgb }, dedup, { school, semester, owner }));
    } catch (e) {
      if (!/节次列|表头/.test(e.message) || attempt === 1) throw e;
      console.log('[OCR] pass2 节次列定位失败, 重跑一次…');
      const ws2 = await ocrPNG(encodePNGRGB(cropImg.width, cropImg.height, cropImg.rgb));
      dedup.length = 0;
      dedup.push(...ws2);
    }
  }
}

module.exports = { parseTimetablePNG, ocrPNG };
