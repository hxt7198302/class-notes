// 课堂笔记分析引擎（v2.0 开源版）：
//   引擎 C（template）  —— 无 AI：转写稿按时轴分节 + 照片自动插图 + 正则抓「可能要注意的事」。
//                          零账号零费用，任何装了 whisper 的电脑都能出，是开源版的默认底座。
//   引擎 A（glm/OpenAI兼容）—— 免费 key 模式：BYOK 三件套（baseUrl/model/apiKey），
//                          一套 OpenAI 兼容 /chat/completions 代码通吃智谱 GLM-4-Flash（免费）、
//                          硅基流动、Groq、本地 Ollama。可选 VL 模型给照片写说明。
// 原私有引擎（zcode 无头会话）在 pipeline.mjs 里，config.engine=zcode 时走老路，两边互不影响。
// 所有引擎的落盘约定一致：笔记/<id>/note.md + items.json + status.json（done）。
import fs from 'fs';
import path from 'path';

// ---------- 公共小工具 ----------
function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }
function mmss(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function pad2(n) { return String(n).padStart(2, '0'); }

/** 读转写行：transcript.json = [{s,e,t}, ...]（秒；兼容 {start,end,text} 老格式） */
function readRows(id, SUCAI) {
  const rows = readJson(path.join(SUCAI(id), 'transcript.json'), []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map(r => ({
      start: typeof r.s === 'number' ? r.s : (typeof r.start === 'number' ? r.start : NaN),
      end: typeof r.e === 'number' ? r.e : (typeof r.end === 'number' ? r.end : NaN),
      text: String(r.t || r.text || '').trim(),
    }))
    .filter(r => Number.isFinite(r.start) && r.text);
}

/** 事项追加进 deadlines（引擎 A/C 自己的闭环；DEADLINES_FILE 由调用方给，没有就跳过） */
export function appendDeadlines(deadlinesFile, sid, course, items, log, engineName) {
  if (!deadlinesFile || !Array.isArray(items) || !items.length) return;
  try {
    const engineLabel = engineName === 'glm' ? 'AI整理' : '转写稿自动抓取';
    let d = readJson(deadlinesFile, null);
    if (!d || !Array.isArray(d.items)) d = { updatedAt: '', items: [] };   // 还没建过就先建初始结构
    const dateStr = new Date().toISOString().slice(0, 10);
    let add = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const did = `cls-${sid}-${i}`;
      if (d.items.some(x => x && x.id === did)) continue;
      d.items.push({
        id: did, title: String(it.title || '').slice(0, 160), due: String(it.due || ''),
        urgent: !!it.urgent, done: false, source: `课堂笔记APP·${course}（${dateStr} ${engineLabel}）`,
        note: String(it.note || it.quote || '').slice(0, 400), link: '',
      });
      add++;
    }
    d.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(deadlinesFile), { recursive: true });
    fs.writeFileSync(deadlinesFile + '.tmp', JSON.stringify(d, null, 1));
    fs.renameSync(deadlinesFile + '.tmp', deadlinesFile);
    if (add) log(`[deadlines] 联动追加 ${add} 条待办`);
  } catch (e) { log(`[deadlines] 联动失败（不影响笔记）：${e.message}`); }
}

// ============================================================
// 引擎 C：模板转写稿（无 AI）
// ============================================================
export async function analyzeTemplate(id, ctx) {
  const { SUCAI, BIJI, CFG, log, writeStatus, deadlinesFile } = ctx;
  const meta = readJson(path.join(SUCAI(id), 'meta.json'), {});
  const rows = readRows(id, SUCAI);
  if (!rows.length) throw new Error('没有可用的转写文本（转写失败或空录音）');
  const photos = (meta.photos || []).slice().sort((a, b) => (a.offsetMs | 0) - (b.offsetMs | 0));
  const durSec = Math.max(rows[rows.length - 1].end || 0, (meta.durationMs || 0) / 1000);
  const course = meta.course || '未命名课程';
  const started = meta.startedAt ? new Date(meta.startedAt) : new Date();
  const dateStr = `${started.getMonth() + 1}月${started.getDate()}日`;

  // ---- 正则抓「可能要注意的事」：宁可多抓给用户删，不静默漏 ----
  const CUE = /(作业|习题|交上来|交到|提交|截止|最迟|考试|测验| quiz |报名|比赛|竞赛|答辩|论文|报告|预习|复习|带.{0,6}(书|教材|笔)|下周|下节课|明[天晚]|周[一二三四五六日天]|\d{1,2}\s*月\s*\d{1,2}\s*[日号])/;
  const cues = [];
  for (const r of rows) {
    const t = String(r.text).trim();
    if (t.length < 6 || t.length > 200) continue;
    if (CUE.test(t) && !cues.some(c => c.text === t)) cues.push({ text: t, sec: r.start });
  }
  const cueItems = cues.slice(0, 20).map(c => ({
    title: `(未核实) ${c.text.slice(0, 80)}`, category: '其他', due: '', urgent: false,
    quote: c.text, offsetSec: Math.round(c.sec),
  }));

  // ---- 按每 5 分钟分节出稿 ----
  const CHUNK = 300;
  const lines = [];
  lines.push(`# 《${course}》课堂记录（转写稿模式）`);
  lines.push('');
  lines.push(`> ${dateStr} · 约 ${Math.max(1, Math.round(durSec / 60))} 分钟 · ${photos.length} 张照片 · ${rows.length} 段转写`);
  lines.push('>');
  lines.push('> 本稿由语音转写自动生成（**未配置 AI 整理**）：内容为课堂原话的忠实转写，按每 5 分钟分节，照片已按拍摄时间插入。');
  lines.push('> 想要 AI 整理版（要点提炼、大白话讲解、例题汇总、自动抽待办）？在 APP「设置」里填一个免费的 API Key 即可，见说明文档。');
  lines.push('');
  if (cueItems.length) {
    lines.push('## 📌 可能要注意的事（关键词自动抓取，未经核实，请自己确认）');
    lines.push('');
    for (const c of cues.slice(0, 20)) lines.push(`- ${c.text}（${mmss(c.sec)}）`);
    lines.push('');
  }
  const totalChunks = Math.max(1, Math.ceil(durSec / CHUNK));
  let photoIdx = 0;
  for (let c = 0; c < totalChunks; c++) {
    const from = c * CHUNK, to = (c + 1) * CHUNK;
    const inRows = rows.filter(r => r.start >= from && r.start < to);
    if (!inRows.length && !photos.some(p => (p.offsetMs / 1000) >= from && (p.offsetMs / 1000) < to)) continue;
    lines.push(`## 第 ${Math.round(from / 60)}-${Math.round(Math.min(to, durSec) / 60)} 分钟`);
    lines.push('');
    for (const r of inRows) {
      // 照片：插到拍摄时间之后的第一句前面（或节尾）
      while (photoIdx < photos.length && (photos[photoIdx].offsetMs / 1000) <= r.start) {
        const p = photos[photoIdx++];
        const ps = p.offsetMs / 1000;
        lines.push('');
        lines.push(`![照片 · 第${Math.floor(ps / 60)}分${pad2(Math.round(ps % 60))}秒（转写稿模式未识别内容）](${p.name})`);
        lines.push('');
      }
      lines.push(`${r.text.trim()}`);
    }
    while (photoIdx < photos.length && (photos[photoIdx].offsetMs / 1000) < to) {
      const p = photos[photoIdx++];
      const ps = p.offsetMs / 1000;
      lines.push('');
      lines.push(`![照片 · 第${Math.floor(ps / 60)}分${pad2(Math.round(ps % 60))}秒（转写稿模式未识别内容）](${p.name})`);
      lines.push('');
    }
    lines.push('');
  }
  const note = lines.join('\n');
  fs.mkdirSync(BIJI(id), { recursive: true });
  fs.writeFileSync(path.join(BIJI(id), 'note.md'), note, 'utf8');
  fs.writeFileSync(path.join(BIJI(id), 'items.json'), JSON.stringify(cueItems, null, 1), 'utf8');
  writeStatus(id, {
    state: 'done', title: `${course}（转写稿）`, course,
    summary: `转写稿模式：${rows.length} 段转写 / ${photos.length} 张照片 / 抓到 ${cueItems.length} 条待核事项`,
  });
  appendDeadlines(deadlinesFile, id, course, cueItems, log, "template");
  log(`[template] 完成：${rows.length} 段 / ${photos.length} 图 / ${cueItems.length} 事项`);
}

// ============================================================
// 引擎 A：OpenAI 兼容云 API（免费 key 模式）
// ============================================================
async function chatOnce(ai, messages, maxTokens, log) {
  const url = String(ai.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${ai.apiKey}` },
    body: JSON.stringify({ model: ai.model || 'glm-4-flash', messages, temperature: 0.2, max_tokens: maxTokens || 8000 }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`AI 接口 ${res.status}：${t.slice(0, 200)}`);
  }
  const j = await res.json();
  let out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!out) throw new Error('AI 返回空内容');
  out = String(out).replace(/<think>[\s\S]*?<\/think>/g, '').trim();   // 本地 qwen3 等会带思考块，剥掉
  if (!out) throw new Error('AI 返回内容只有思考块');
  return out;
}

/** 可选：VL 模型逐张看照片写说明（没配 vlModel 就跳过，笔记只按时间轴插图不写内容） */
async function describePhotos(ai, SUCAI, id, photos, log) {
  if (!ai.vlModel || !photos.length) return {};
  const desc = {};
  for (const p of photos) {
    try {
      const f = path.join(SUCAI(id), 'files', p.name);
      if (!fs.existsSync(f)) continue;
      const b64 = fs.readFileSync(f).toString('base64');
      const url = String(ai.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${ai.apiKey}` },
        body: JSON.stringify({
          model: ai.vlModel,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
              { type: 'text', text: '这是课堂上拍的一张照片（板书/PPT/讲义）。用一句话（30字内）说明它拍的是什么内容，直接给说明本身，不要任何前后缀。' },
            ],
          }],
          temperature: 0.1, max_tokens: 100,
        }),
        signal: AbortSignal.timeout(3 * 60 * 1000),
      });
      if (res.ok) {
        const j = await res.json();
        const t = j?.choices?.[0]?.message?.content;
        if (t) { desc[p.name] = String(t).trim().slice(0, 60); continue; }
      }
      log(`[glm-vl] ${p.name} 描述失败（${res.status}），跳过`);
    } catch (e) { log(`[glm-vl] ${p.name} 描述异常：${e.message}，跳过`); }
  }
  return desc;
}

const SYS_PROMPT = `你是一名认真负责的课堂笔记整理员。你会收到一堂课的语音转写文本（每句带[分:秒]时间戳）、课程名和课堂照片清单（文件名+拍摄时间+一句话说明）。请产出一份给学生课后复习用的完整课堂笔记，严格要求：

1. 用 markdown。开头是「# 《课程名》课堂笔记（日期）」。
2. 按知识脉络分节（不是按时间硬切），每节提炼要点；老师讲解难以懂的地方补一句大白话解释，标注「💡」。
3. 讲得慢/强调/说"要考"的地方标注「⭐ 重点」；原话有价值的用引用块保留并附时间，如「> 原话（32:10）：……」。
4. 照片：在内容对应的段落插入 markdown 图片，格式 ![照片说明 · 第X分Y秒](文件名.jpg)。文件名必须与清单完全一致，不许编造不存在的照片。
5. 防幻觉红线：只依据转写文本与照片说明写笔记，转写听不清的词标（音）；没有讲到的内容绝不编造；不确定的写明"待核实"。
6. 老师布置的作业/考试/报名等事项，在笔记末尾出一节「📌 要办的事」，每条一行。
7. 笔记正文结束后，另起一行输出三个反引号开头的 items 标记块，里面是 JSON 数组（给程序解析），每条：{"title":"事项短句","category":"作业|考试|比赛|社团|其他","due":"YYYY-MM-DD或空","urgent":true/false,"quote":"老师原话","offsetSec":整数秒}。相对日期（下周三等）要换算成具体 YYYY-MM-DD。
8. 全程简体中文。`;

export async function analyzeGlm(id, ctx) {
  const { SUCAI, BIJI, CFG, log, writeStatus, deadlinesFile, renderNoteHtml } = ctx;
  const ai = (CFG && CFG.ai) || {};
  if (!ai.apiKey) throw new Error('还没配置 AI 的 API Key（在 APP 设置里填一次即可）');

  const meta = readJson(path.join(SUCAI(id), 'meta.json'), {});
  const rows = readRows(id, SUCAI);
  if (!rows.length) throw new Error('没有可用的转写文本（转写失败或空录音）');
  const photos = (meta.photos || []).slice().sort((a, b) => (a.offsetMs | 0) - (b.offsetMs | 0));
  const course = meta.course || '未命名课程';
  const started = meta.startedAt ? new Date(meta.startedAt) : new Date();
  const dateStr = `${started.getFullYear()}年${started.getMonth() + 1}月${started.getDate()}日`;
  log(`[glm] 开始：${rows.length} 段转写 / ${photos.length} 张照片 / 模型 ${ai.model || 'glm-4-flash'}`);

  writeStatus(id, { state: 'analyzing', progress: 40, error: '' });
  const desc = await describePhotos(ai, SUCAI, id, photos, log);
  const usedVL = Object.keys(desc).length;

  const photoList = photos.map(p => {
    const sec = (p.offsetMs | 0) / 1000;
    const d = desc[p.name] ? `，内容：${desc[p.name]}` : '';
    return `- ${p.name}（第${Math.floor(sec / 60)}分${pad2(Math.round(sec % 60))}秒${d}）`;
  }).join('\n');

  let transcript = rows.map(r => `[${mmss(r.start)}] ${String(r.text).trim()}`).join('\n');
  // 超长保护：小上下文模型（本地 Ollama 默认 4K）装不下一整节课；截到 maxInputChars 并如实标注
  const maxChars = (ai.maxInputChars | 0) || 50000;
  let cutRow = null;
  if (transcript.length > maxChars) {
    let acc = 0;
    for (const r of rows) { acc += String(r.text).length + 16; if (acc > maxChars) break; cutRow = r; }
    transcript = transcript.slice(0, maxChars);
    log(`[glm] 转写超长（${rows.length} 段），已截断到约第 ${cutRow ? mmss(cutRow.start) : '00:00'}`);
  }
  const userMsg = `课程：《${course}》\n日期：${dateStr}\n时长：约 ${Math.round((meta.durationMs || 0) / 60000)} 分钟${cutRow ? `（转写过长，本次只含到第 ${mmss(cutRow.start)} 的内容，笔记开头要注明）` : ''}\n\n课堂照片清单（${photos.length} 张，${usedVL ? '已附内容说明' : '未做内容识别，只按时间插图'}）：\n${photoList || '（无照片）'}\n\n转写全文：\n${transcript}`;

  let out = null, lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log(`[glm] 第 ${attempt}/3 次请求…`);
      out = await chatOnce(ai, [
        { role: 'system', content: SYS_PROMPT },
        { role: 'user', content: userMsg },
      ], 12000, log);
      if (out.includes('#')) break;
    } catch (e) { lastErr = e; log(`[glm] 失败：${e.message}`); if (attempt < 3) await new Promise(r => setTimeout(r, 20 * 1000)); }
  }
  if (!out) throw new Error(`AI 分析失败：${lastErr ? lastErr.message : '没返回内容'}`);

  // 拆出末尾 items JSON 块（容错：没有就当没有事项）
  let note = out, items = [];
  const m = out.match(/```(?:items)?\s*\n?(\[[\s\S]*?\])\s*\n?```/);
  if (m) {
    note = out.slice(0, m.index).trimEnd() + '\n';
    try { items = JSON.parse(m[1]); if (!Array.isArray(items)) items = []; } catch { items = []; }
  }
  fs.mkdirSync(BIJI(id), { recursive: true });
  fs.writeFileSync(path.join(BIJI(id), 'note.md'), note, 'utf8');
  fs.writeFileSync(path.join(BIJI(id), 'items.json'), JSON.stringify(items, null, 1), 'utf8');
  writeStatus(id, {
    state: 'done', title: `${course} 笔记`, course,
    summary: `AI 整理：${rows.length} 段转写 / ${photos.length} 张照片（${usedVL} 张有说明）/ ${items.length} 条事项`,
  });

  // 课程总纲（可选，默认开；便宜的一次增量合并调用）
  if (ai.overview !== false) {
    try {
      writeStatus(id, { state: 'analyzing', progress: 90, error: '' });
      const ovDir = path.join(path.dirname(BIJI(id)), '..', '电脑端', '课程总纲');
      const ovFile = path.join(ovDir, `${course}.md`);
      const old = fs.existsSync(ovFile) ? fs.readFileSync(ovFile, 'utf8') : '（还没有总纲，这是第一节课）';
      const ovOut = await chatOnce(ai, [
        { role: 'system', content: '你是课程总纲维护员。把新笔记的知识点合并进旧总纲：保持原有结构与进度线，新增内容接续，重复的不重复写，输出完整新版总纲 markdown（不是 diff）。绝不能丢掉旧总纲里已有的章节。' },
        { role: 'user', content: `课程：《${course}》\n\n旧总纲：\n${old.slice(0, 20000)}\n\n本节笔记：\n${note.slice(0, 20000)}` },
      ], 8000, log);
      if (ovOut.includes('#')) {
        fs.mkdirSync(ovDir, { recursive: true });
        fs.writeFileSync(ovFile, ovOut, 'utf8');
        log('[glm] 课程总纲已更新');
      }
    } catch (e) { log(`[glm] 总纲更新失败（不影响笔记）：${e.message}`); }
  }

  appendDeadlines(deadlinesFile, id, course, items, log, "glm");
  log(`[glm] 完成：${items.length} 条事项${usedVL ? ` / ${usedVL} 张照片有说明` : ''}`);
}
