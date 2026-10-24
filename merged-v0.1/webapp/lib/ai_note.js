'use strict';
// ai_note.js —— 课堂 AI 成稿（把转写稿整理成结构化笔记 + 事项清单）
// 参考原版《分析任务说明》的硬约束，精简为 Web 版提示词。

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash-vision-exp';

function mmss(sec) {
  var s = Math.max(0, Math.round(sec));
  var m = Math.floor(s / 60);
  var r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

function buildUserPrompt(p) {
  var lines = [];
  lines.push('请把下面这节课堂的转写稿整理成课堂笔记。');
  lines.push('');
  lines.push('【课程】' + (p.courseName || '未知课程'));
  lines.push('【日期】' + (p.dateText || ''));
  lines.push('【时长】' + (p.durationText || ''));
  if (p.markers && p.markers.length) {
    lines.push('【用户课堂标记】');
    p.markers.forEach(function (m) {
      lines.push('- ' + mmss((m.offsetMs || 0) / 1000) + ' ' + (m.type || '重点') + (m.note ? '（备注：' + m.note + '）' : ''));
    });
  }
  if (p.photos && p.photos.length) {
    lines.push('【板书照片清单】（插入笔记时用文件名，不要改文件名）');
    p.photos.forEach(function (ph) {
      lines.push('- ' + ph.name + ' @ ' + mmss((ph.offsetMs || 0) / 1000));
    });
  }
  if (p.userNote) lines.push('【用户手写笔记】' + String(p.userNote).slice(0, 2000));
  lines.push('【转写稿（每段前是时间戳 mm:ss）】');
  var segs = p.segments || [];
  var budget = 14000;
  var used = 0;
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    var line = '[' + mmss(s.start) + '] ' + String(s.text || '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (used + line.length > budget) { lines.push('…（转写过长，后续省略）'); break; }
    lines.push(line);
    used += line.length;
  }
  lines.push('');
  lines.push('【输出要求】');
  lines.push('只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块：');
  lines.push('{"title":"课程名 · M月D日 课堂笔记","markdown":"笔记正文（换行用 \\n 转义）","items":[{"title":"事项","due":"截止时间或空","quote":"老师原话","time":"mm:ss"}]}');
  lines.push('');
  lines.push('markdown 硬约束：');
  lines.push('1. 只允许：# / ## / ### 标题、普通段落、**粗体**、- 列表、1. 列表、> 引用（只用于老师原话）、---、![说明](文件名) 图片');
  lines.push('2. 禁止表格、禁止 HTML、禁止嵌套列表');
  lines.push('3. 每个 ## 小节的第一条列表项必须是 - **考点**：一句话结论（本节确实没有考点时写 - **重点**：）');
  lines.push('4. 按老师实际讲的顺序组织，不要机械照搬转写分段；合并口语废话，保留全部知识点、例题、公式、例子、老师强调的话');
  lines.push('5. 老师说「这个要考/记一下/很重要」的内容要加粗并注明（老师强调）');
  lines.push('6. 板书照片必须全部插入到对应内容处，格式 ![照片·第mm分ss秒](photo-XX.jpg)，按照片时间定位到转写相应位置');
  lines.push('7. 每个课堂标记都要有对应小节：## 🎯 课堂标记 N · mm:ss · 类型，先 > 引用老师原话，再用大白话讲清楚');
  lines.push('8. 末尾必须有 ## 📌 要办的事：作业、截止、考试、比赛、活动，每条带老师原话（> 引用）和时间戳；没有就写「无」');
  lines.push('9. 末尾必须有 ## ❓ 没听清/没看懂的部分：转写含糊处逐条列（带时间戳和你的猜测）；没有就写「无」');
  lines.push('10. 转写稿里没有的内容不许编造；拿不准的词标「(音，待核)」');
  lines.push('11. items 数组把要办的事结构化（title/due/quote/time），没有就空数组 []');
  return lines.join('\n');
}

async function callChat(cfg, system, user, maxTokens) {
  const body = {
    model: (cfg && cfg.model) || MODEL,
    max_tokens: maxTokens || 8000,
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };
  const resp = await fetch((cfg && cfg.base) || ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify(body)
  });
  const raw = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = raw && raw.error ? ((raw.error.code || '') + ' ' + (raw.error.message || '')) : ('HTTP ' + resp.status);
    throw new Error('成稿API出错: ' + msg);
  }
  const choice = raw && raw.choices && raw.choices[0];
  let text = (choice && choice.message && choice.message.content || '').trim();
  if (!text && choice && choice.message && choice.message.reasoning_content) text = String(choice.message.reasoning_content).trim();
  if (!text) throw new Error('模型没有返回内容');
  return text;
}

function extractJson(text) {
  var t = String(text || '');
  try { return JSON.parse(t); } catch (e) {}
  var s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch (err) {}
  }
  throw new Error('模型输出不是合法 JSON，前 200 字：' + t.slice(0, 200));
}

async function generateNote(cfg, payload) {
  if (!cfg || !cfg.key) cfg = { key: cfg };
  const system = '你是一名严谨的大学课堂笔记整理助手。把课堂转写稿整理成结构清晰、可直接阅读的课堂笔记，只输出 JSON。';
  const user = buildUserPrompt(payload);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callChat(cfg, system, user, 8000);
      const data = extractJson(text);
      if (!data || typeof data.markdown !== 'string' || !data.markdown.trim()) throw new Error('缺少 markdown 字段');
      return { title: data.title || '', markdown: data.markdown, items: Array.isArray(data.items) ? data.items : [] };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

module.exports = { generateNote, buildUserPrompt, MODEL };
