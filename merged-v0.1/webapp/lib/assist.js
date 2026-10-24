'use strict';
// assist.js —— AI 助教能力：精简笔记 / 思维导图 / 待办汇总 / 对话上下文
const fs = require('fs');
const path = require('path');

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function sessionSource(meta) {
  if (meta.aiNote && meta.aiNote.markdown) return meta.aiNote.markdown;
  if (meta.transcript && meta.transcript.text) return meta.transcript.text;
  return '';
}

function extractJson(text) {
  const t = String(text || '').replace(/^\s*\x60\x60\x60(json)?\s*/i, '').replace(/\s*\x60\x60\x60\s*$/, '');
  try { return JSON.parse(t); } catch (e) {}
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch (err) {}
  }
  throw new Error('AI 输出不是合法 JSON：' + clip(t, 200));
}

async function summarize(ai, meta) {
  const src = clip(sessionSource(meta), 12000);
  if (!src) throw new Error('这节课还没有笔记或文字稿');
  const sys = '你是课堂笔记整理助手。输出严格 JSON，不要解释、不要 markdown 代码块。';
  const user = [
    '把下面的课堂记录压缩成一页「复习卡」。',
    '只输出 JSON：{"headline":"一句话概括这节课讲什么","points":["要点1","要点2"],"keywords":["术语1","术语2"],"todo":["作业或待办"]}',
    '要求：',
    '- points 5-8 条，每条一句话，按讲课时序，保留公式/定义/例题关键信息',
    '- keywords 3-8 个课程术语（只从内容里取）',
    '- todo 只列老师明确布置的作业/截止/考试；没有就空数组',
    '- 严禁编造笔记里没有的内容',
    '',
    '课程：' + (meta.courseName || '') + '  日期：' + new Date(meta.startedAt || Date.now()).toLocaleDateString('zh-CN'),
    '课堂记录：',
    src
  ].join('\n');
  const out = await ai.chat(null, [{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 6000, timeoutMs: 150000 });
  const data = extractJson(out.text);
  return {
    headline: String(data.headline || ''),
    points: Array.isArray(data.points) ? data.points.slice(0, 10) : [],
    keywords: Array.isArray(data.keywords) ? data.keywords.slice(0, 10) : [],
    todo: Array.isArray(data.todo) ? data.todo.slice(0, 8) : []
  };
}

async function mindmap(ai, courses) {
  const items = courses.filter(function (c) { return c.text && c.text.trim(); });
  if (!items.length) throw new Error('没有可用的笔记内容');
  const src = items.map(function (c) {
    return '【' + c.name + '】' + clip(c.text, 2500);
  }).join('\n\n').slice(0, 14000);
  const sys = '你是知识结构整理助手。输出严格 JSON，不要解释、不要 markdown 代码块。';
  const multi = items.length > 1;
  const user = [
    '把下面的课程内容整理成一张思维导图树。',
    '只输出 JSON：{"name":"根节点标题","children":[{"name":"一级节点","children":[{"name":"二级节点","children":[]}]}]}',
    '要求：',
    '- 层级 2-4 层，节点文字 ≤ 12 字',
    '- 覆盖主要知识点、章节、方法、例题类型；合并重复内容',
    multi
      ? '- 根节点固定写「我的课堂知识树」，一级分支必须是每一门课程名（共 ' + items.length + ' 门，一门都不能少），每门课程的知识点只能挂在自己课程分支下，严禁把 A 课程内容放到 B 课程下'
      : '- 根节点写课程名',
    '- 严禁输出 JSON 以外的内容',
    '',
    '课程内容：',
    src
  ].join('\n');
  const out = await ai.chat(null, [{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 6000, timeoutMs: 150000 });
  const data = extractJson(out.text);
  if (!data || !data.name) throw new Error('AI 没有返回有效导图');
  return data;
}

function collectTodos(sessions) {
  const out = [];
  (sessions || []).forEach(function (s) {
    const items = (s.aiNote && s.aiNote.items) || [];
    items.forEach(function (it) {
      if (!it || !it.title) return;
      out.push({
        course: s.courseName || '',
        title: String(it.title),
        due: it.due || '',
        quote: it.quote || '',
        time: it.time || '',
        date: s.startedAt || 0,
        sid: s.id
      });
    });
    const note = String(s.note || '');
    const m = note.match(/(作业|截止|提交|考试|周[一二三四五六日天])[^\n。]{0,40}/g);
    if (m) {
      m.slice(0, 3).forEach(function (t) {
        if (out.some(function (x) { return x.title === t && x.course === s.courseName; })) return;
        out.push({ course: s.courseName || '', title: t.trim(), due: '', quote: '', time: '', date: s.startedAt || 0, sid: s.id, fromNote: true });
      });
    }
  });
  return out.sort(function (a, b) { return (b.date || 0) - (a.date || 0); });
}

module.exports = { summarize: summarize, mindmap: mindmap, collectTodos: collectTodos, clip: clip };
