// 笔记 Markdown → HTML 的极简渲染器（零依赖）。
// 只支持分析手册约定的子集：# 标题、段落、**粗体**、`代码`、- 列表、1. 列表、
// > 引用、--- 分隔线、![说明](文件名.jpg) 图片、裸链接自动加 <a>。
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
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (t.startsWith('```')) { closeList(); closeQuote(); out.push('<hr class="codecut">'); continue; }
    if (t === '') { closeList(); closeQuote(); continue; }
    if (t === '---') { closeList(); closeQuote(); out.push('<hr>'); continue; }
    const h = t.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeList(); closeQuote(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (t.startsWith('>')) {
      closeList();
      if (!quote) { out.push('<blockquote>'); quote = true; }
      out.push(`<p>${inline(t.replace(/^>\s?/, ''))}</p>`);
      continue;
    }
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
  closeList(); closeQuote();
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
</style></head><body>
${out.join('\n')}
</body></html>`;
}
