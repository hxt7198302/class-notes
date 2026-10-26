// 笔记 Markdown → HTML 的极简渲染器（零依赖）。
// 只支持分析手册约定的子集：# 标题、段落、**粗体**、`代码`、- 列表、1. 列表、
// > 引用、--- 分隔线、![说明](文件名.jpg) 图片、裸链接自动加 <a>。
// v2.6 起支持理科「推导步骤」行：- ① 公式 ｜ 这步在干什么（手册 §2.9），
// 连续步骤行合成一个 .cn-derive 块，末步高亮；不认识这行的旧版 APP 按普通列表显示。
// 不支持的语法（表格/HTML标签/嵌套列表）按普通段落处理，不会崩。
export function renderNoteHtml(md, sessionId) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = s => {
    let t = esc(s);
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
      const name = src.replace(/^photos\//, '');
      return `<figure><img src="${name}" alt="${alt}" loading="lazy"><figcaption>${alt || '课堂照片'}</figcaption></figure>`;
    });
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(https?:\/\/[^\s<)"，。；、！？]+)/g, '<a href="$1" target="_blank">$1</a>');
    return t;
  };
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  let quote = false;
  let derive = null; // 推导步骤缓冲区：{ fx, note }[]
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
  const flushDerive = () => {
    if (!derive) return;
    const html = derive.map((s, i) => {
      const cls = 'cn-step' + (i === derive.length - 1 ? ' cn-final' : '');
      return `<div class="${cls}"><span class="cn-badge">${i + 1}</span><div class="cn-body">` +
        `<div class="cn-fx">${s.fx}</div>` +
        (s.note ? `<div class="cn-note">${s.note}</div>` : '') +
        `</div></div>`;
    }).join('');
    out.push(`<div class="cn-derive">${html}</div>`);
    derive = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (t.startsWith('```')) { flushDerive(); closeList(); closeQuote(); out.push('<hr class="codecut">'); continue; }
    if (t === '') { closeList(); closeQuote(); continue; }
    if (t === '---') { flushDerive(); closeList(); closeQuote(); out.push('<hr>'); continue; }
    const h = t.match(/^(#{1,4})\s+(.*)/);
    if (h) { flushDerive(); closeList(); closeQuote(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (t.startsWith('>')) {
      flushDerive(); closeList();
      if (!quote) { out.push('<blockquote>'); quote = true; }
      out.push(`<p>${inline(t.replace(/^>\s?/, ''))}</p>`);
      continue;
    }
    // §2.9 推导步骤：- ① 公式 ｜ 注解（连续行合成一个推导块）
    // 防误伤：第一步必须带全角「｜」；后续步骤按圈号顺序接续才算，
    // 这样旧笔记里普通的「- ① …」编号列表仍按普通列表渲染。
    const step = t.match(/^[-*]\s*([①-⑳])\s*(.+)$/);
    if (step) {
      const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
      const idx = CIRCLED.indexOf(step[1]);
      const body = step[2];
      const cut = body.indexOf('｜');
      const start = idx === 0 && cut >= 0;
      const cont = !!derive && idx === derive.length;
      if (start || cont) {
        closeList(); closeQuote();
        if (!derive) derive = [];
        const fx = (cut >= 0 ? body.slice(0, cut) : body).trim();
        const note = cut >= 0 ? body.slice(cut + 1).trim() : '';
        derive.push({ fx: inline(fx), note: note ? inline(note) : '' });
        continue;
      }
    }
    flushDerive();
    closeQuote();
    const ul = t.match(/^[-*]\s+(.*)/);
    const ol = t.match(/^\d+[.、]\s+(.*)/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`); continue;
    }
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`); continue;
    }
    closeList();
    out.push(`<p>${inline(t)}</p>`);
  }
  flushDerive(); closeList(); closeQuote();
  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>课堂笔记${sessionId ? ' · ' + sessionId : ''}</title>
<style>
  body { font-family: -apple-system,'MiSans','HarmonyOS Sans',sans-serif; color:#24292f;
         margin:0; padding:16px 16px 48px; background:#fff; line-height:1.75; font-size:16px; }
  h1 { font-size:22px; margin:20px 0 8px; line-height:1.4; }
  h2 { font-size:19px; margin:22px 0 6px; padding-bottom:6px; border-bottom:1px solid #e8ebec; }
  h3 { font-size:17px; margin:16px 0 4px; }
  h4 { font-size:15px; margin:12px 0 4px; color:#57606a; }
  p  { margin:8px 0; }
  ul,ol { margin:8px 0; padding-left:22px; }
  li { margin:4px 0; }
  blockquote { margin:10px 0; padding:6px 12px; border-left:3px solid #93b4ff;
               background:#f3f7ff; color:#3a4a6b; border-radius:0 8px 8px 0; }
  blockquote p { margin:2px 0; font-size:14.5px; }
  figure { margin:12px 0; }
  figure img { max-width:100%; border-radius:10px; border:1px solid #e8ebec; }
  figcaption { font-size:12px; color:#8a9499; text-align:center; margin-top:4px; }
  code { background:#f3f4f6; padding:1px 5px; border-radius:4px; font-size:14px; }
  a { color:#2563eb; word-break:break-all; }
  hr { border:0; border-top:1px dashed #d8dce0; margin:16px 0; }
  hr.codecut { border-top-style:solid; border-color:#e8ebec; }
  /* v2.6 理科推导步骤（方案 B：编号 + 大公式 + 紧跟注解）
     颜色走 --cn-* 变量：安卓端在 UiTheme 里覆盖，深色模式自动跟随；没有变量时用浅色兜底 */
  .cn-derive { margin:12px 0; padding:2px 12px; background:var(--cn-panel,#fafbfc);
               border:1px solid var(--cn-line,#e8ebec); border-radius:12px; }
  .cn-step { display:flex; gap:9px; padding:10px 0; border-bottom:1px solid var(--cn-line,#f1f3f7); }
  .cn-step:last-child { border-bottom:0; }
  .cn-badge { flex:none; width:19px; height:19px; margin-top:3px; border-radius:50%;
              border:1.4px solid var(--cn-accent,#2563eb); color:var(--cn-accent,#2563eb);
              background:var(--cn-badge-bg,#fff);
              font-family:-apple-system,sans-serif; font-size:11px; font-weight:700;
              display:flex; align-items:center; justify-content:center; line-height:1; }
  .cn-step.cn-final .cn-badge { background:var(--cn-accent,#2563eb); color:var(--cn-badge-bg,#fff); }
  .cn-body { flex:1; min-width:0; }
  .cn-fx { font-family:"Cambria Math","Times New Roman",Georgia,serif;
           font-size:17px; line-height:1.5; color:var(--cn-ink,#0f172a); word-break:break-word; }
  .cn-note { margin-top:3px; padding-left:9px; border-left:2px solid var(--cn-note-line,#e3eaf7);
             font-size:12px; line-height:1.5; color:var(--cn-sub,#8a93a0); }
  .cn-step.cn-final .cn-fx { color:var(--cn-result,#1d4ed8); }
</style></head><body>
${out.join('\n')}
</body></html>`;
}
