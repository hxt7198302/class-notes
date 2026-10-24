'use strict';
// ai_provider.js —— 统一 AI 调用（智谱 / DeepSeek / 自定义 OpenAI 兼容），支持请求头 BYOK
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function readEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch (e) {}
  return out;
}

const PROVIDERS = {
  zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', defaultModel: 'glm-4-flash', keyEnv: 'ZHIPU_API_KEY' },
  deepseek: { base: 'https://api.deepseek.com/chat/completions', defaultModel: 'deepseek-chat', keyEnv: 'DEEPSEEK_API_KEY' }
};

function resolve(req) {
  const env = readEnv();
  const h = (req && req.headers) || {};
  const name = String(h['x-ai-provider'] || env.AI_PROVIDER || 'zhipu').toLowerCase();
  const p = PROVIDERS[name] || PROVIDERS.zhipu;
  const key = String(h['x-ai-key'] || env[p.keyEnv] || env.DEEPSEEK_API_KEY || '');
  const model = String(h['x-ai-model'] || env.AI_MODEL || p.defaultModel);
  const base = String(h['x-ai-base'] || p.base);
  return { name, key, model, base };
}

async function chat(req, messages, opts) {
  const cfg = resolve(req);
  if (!cfg.key) throw new Error('未配置 AI key（在「我的 → AI 设置」里填，或在 .env 配置）');
  const body = { model: cfg.model, messages, temperature: (opts && opts.temperature) || 0.3 };
  if (opts && opts.maxTokens) body.max_tokens = opts.maxTokens;
  const timeoutMs = (opts && opts.timeoutMs) || 120000;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs);
    try {
      const resp = await fetch(cfg.base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const raw = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = raw && raw.error ? ((raw.error.code || '') + ' ' + (raw.error.message || '')) : ('HTTP ' + resp.status);
        throw new Error('AI 调用失败：' + msg);
      }
      const choice = raw && raw.choices && raw.choices[0];
      const text = (choice && choice.message && choice.message.content || '').trim();
      if (!text) throw new Error('AI 没有返回内容');
      return { text: text, model: cfg.model, provider: cfg.name, usage: raw.usage || null };
    } catch (e) {
      lastErr = e;
      if (e && e.name === 'AbortError') throw new Error('AI 响应超时（' + Math.round(timeoutMs / 1000) + ' 秒），请稍后重试');
      if (String(e && e.message).indexOf('AI 调用失败') === 0) throw e;
      if (attempt === 0) continue;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

module.exports = { chat: chat, resolve: resolve, PROVIDERS: PROVIDERS };
