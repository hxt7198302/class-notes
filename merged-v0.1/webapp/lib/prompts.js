// prompts.js —— 视觉模型调用封装 + 识别 prompt 常量
// 视觉通道: DeepSeek deepseek-v4-flash-vision-exp (思考模型, max_tokens 必须给足)

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash-vision-exp';

// 从 .env 文本中取 key(容忍 CRLF / 引号)
function keyFromEnvText(text) {
  const m = text.match(/^DEEPSEEK_API_KEY\s*=\s*"?([^\r\n"]+)"?/m);
  return m ? m[1].trim() : null;
}

// key 解析: 环境变量优先, 回退读项目根目录 .env (本地开发)
function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, '..', '.env');
    if (fs.existsSync(p)) return keyFromEnvText(fs.readFileSync(p, 'utf8'));
  } catch (e) { /* 读不到就真没有 */ }
  return null;
}

const TIMETABLE_PROMPT = `你是课表逐行转录引擎。逐行读这张课表截图, 输出 JSONL(每行一个独立的 JSON 对象), 除此之外不要输出任何表格、解释或代码块标记。

第1行(固定): {"school":"图中可见的校名,没有就空串","semester":"图中可见的学期,没有就空串"}
之后每一行对应图中的一个节次行(从第1节行到最后一个节次行):
{"sec":1,"mon":"","tue":"","wed":"","thu":"","fri":"","sat":"","sun":""}

规则:
1. sec = 图中最左侧该行的节次数字(图里写几就填几); "大课间/午休/午餐/晚餐"这类非上课行跳过不要输出
2. mon=星期一, tue=星期二, wed=星期三, thu=星期四, fri=星期五, sat=星期六, sun=星期日; 图中没有的星期省略该键
3. 每个有课的格子填该格子里的文字原样(保留括号), 格子内换行写成 " / "; 例: "学术英语1(SFLC381_40T.14) (示例教师) / (1-8 11-18,教学楼1#304)"; 空格子填 ""
4. 【最重要】一个格子纵向合并跨多行(比如覆盖第5到第8节), 必须在它覆盖的每一行都重复填写完全相同的内容, 一行都不能漏
5. 只转录每个格子自己印着的文字, 严禁把其他格子的文字抄到这个格子; 看不清就留空字符串`;

const CALENDAR_PROMPT = `你是作息时间表结构化引擎。从大学作息时间表截图中提取每节课的上下课时间, 只输出一个 JSON 对象, 不要任何解释、不要 markdown 代码块。格式:
{"school":"","columns":[{"name":"列名(如'第一教学楼'/'研究生', 没有分列就填'默认')","sections":{"1":["08:00","08:45"],"2":["08:55","09:40"]}}],"notes":["备注,如'第X节时间以XX楼为准'"]}
规则:
- 节次序号用阿拉伯数字作键, 时间统一 "HH:MM" 24小时制
- 表格若分多列(不同教学楼/研究生不同时间), 每列一个对象, name 填列标题
- '大课间/午休/午餐/晚餐'这类行不是节次, 跳过
- 只提取图中真实存在的内容, 禁止编造`;

// 调 DeepSeek 视觉; 返回原始文本(转录类任务用)
async function callVisionText(apiKey, promptText, imageBase64, mimeType) {
  const body = {
    model: MODEL,
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${imageBase64}` } }
      ]
    }]
  };
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const raw = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = raw && raw.error ? `${raw.error.code || ''} ${raw.error.message || ''}` : `HTTP ${resp.status}`;
    throw new Error(`视觉API出错: ${msg}`);
  }
  const choice = raw && raw.choices && raw.choices[0];
  let text = (choice && choice.message && choice.message.content || '').trim();
  if (!text && choice && choice.message && choice.message.reasoning_content) {
    text = choice.message.reasoning_content; // 思考模型兜底
  }
  if (!text) throw new Error('模型没有返回内容');
  return text;
}

// 调 DeepSeek 视觉; 返回解析后的 JSON 对象(作息表等 JSON 任务用)
async function callVision(apiKey, promptText, imageBase64, mimeType) {
  const text = await callVisionText(apiKey, promptText, imageBase64, mimeType);
  return extractJSON(text);
}

// 从模型回复中抠 JSON: 优先整体 parse, 否则截第一个 { 到最后一个 }
function extractJSON(text) {
  if (!text) throw new Error('模型没有返回内容');
  try { return JSON.parse(text); } catch (e) { /* 继续截取 */ }
  const s = text.indexOf('{'), t = text.lastIndexOf('}');
  if (s >= 0 && t > s) {
    const slice = text.slice(s, t + 1);
    try { return JSON.parse(slice); } catch (e) { /* 落到报错 */ }
  }
  throw new Error('模型返回的不是合法 JSON, 原文前200字: ' + text.slice(0, 200));
}

module.exports = { TIMETABLE_PROMPT, CALENDAR_PROMPT, callVision, callVisionText, extractJSON, resolveApiKey, MODEL };
