/**
 * api.js — OpenAI 兼容 Chat Completions 客户端
 *
 * 只在 Service Worker（background.js）里以 ES Module 方式运行。
 * 由扩展后台发起请求，可以绕过网页的 CORS 限制；请求只会发往用户自己填写的 API 地址。
 */

export const DEFAULT_SETTINGS = Object.freeze({
  apiBaseUrl: 'https://api.deepseek.com/chat/completions',
  apiKey: '',
  model: 'deepseek-flash',
  maxTokens: 2048,
  temperature: 0.7,
  timeoutMs: 60000,
  stream: true,
  // 思考模式：auto = 不发送任何思考参数，完全交给服务端默认行为
  thinkingMode: 'disabled', // 'auto' | 'disabled' | 'enabled'
  // 思考参数的发送形式：auto 会按 API 域名自动选择
  thinkingStyle: 'auto', // 'auto' | 'thinking_object' | 'enable_thinking' | 'reasoning_effort' | 'none'
  systemPrompt: '',
  theme: 'auto'
});

export class ApiError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, extra || {});
  }
}

export class AbortError extends Error {
  constructor(message) {
    super(message || '已停止生成');
    this.name = 'AbortError';
  }
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export function mergeSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  s.apiBaseUrl = String(s.apiBaseUrl || '').trim();
  s.apiKey = String(s.apiKey || '').trim();
  s.model = String(s.model || '').trim();
  s.systemPrompt = String(s.systemPrompt || '');
  s.maxTokens = clampInt(s.maxTokens, 1, 200000, DEFAULT_SETTINGS.maxTokens);
  s.temperature = clampNum(s.temperature, 0, 2, DEFAULT_SETTINGS.temperature);
  s.timeoutMs = clampInt(s.timeoutMs, 3000, 600000, DEFAULT_SETTINGS.timeoutMs);
  s.stream = s.stream !== false;
  if (!['auto', 'disabled', 'enabled'].includes(s.thinkingMode)) s.thinkingMode = 'disabled';
  if (!['auto', 'thinking_object', 'enable_thinking', 'reasoning_effort', 'none'].includes(s.thinkingStyle)) {
    s.thinkingStyle = 'auto';
  }
  if (!['auto', 'light', 'dark'].includes(s.theme)) s.theme = 'auto';
  return s;
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 根据 API 地址推断该服务商使用的「思考模式」参数写法 */
export function resolveThinkingStyle(settings) {
  if (settings.thinkingStyle && settings.thinkingStyle !== 'auto') return settings.thinkingStyle;
  let host = '';
  try {
    host = new URL(normalizeApiUrl(settings.apiBaseUrl)).hostname.toLowerCase();
  } catch (e) {
    return 'thinking_object';
  }
  if (/(^|\.)deepseek\.com$/.test(host)) return 'thinking_object';
  if (/(^|\.)(dashscope|aliyuncs)\.com$/.test(host)) return 'enable_thinking';
  if (/(^|\.)(openai|azure)\.com$/.test(host)) return 'reasoning_effort';
  // 未知服务商：先按 DeepSeek 文档的写法尝试；若接口报错会自动去掉该参数重试
  return 'thinking_object';
}

/** 容错地补全 API 地址 */
export function normalizeApiUrl(input) {
  let url = String(input || '').trim();
  if (!url) throw new ApiError('尚未配置 API 地址。请打开设置页填写 API Base URL。', { code: 'no_url' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  url = url.replace(/\/+$/, '');
  if (!/\/chat\/completions$/i.test(url)) {
    if (/^https?:\/\/[^/]+$/i.test(url)) {
      url += '/chat/completions';
    } else if (/\/(v\d+[a-z]*)$/i.test(url)) {
      url += '/chat/completions';
    }
  }
  return url;
}

/* ------------------------------------------------------------------ */
/* 请求体                                                              */
/* ------------------------------------------------------------------ */

function buildBody(cfg, messages, stream, style, opts) {
  const dropThinking = !!(opts && opts.dropThinking);
  const dropTemperature = !!(opts && opts.dropTemperature);
  const dropMaxTokens = !!(opts && opts.dropMaxTokens);

  const body = {
    model: cfg.model,
    messages,
    stream
  };
  if (!dropMaxTokens && cfg.maxTokens > 0) body.max_tokens = cfg.maxTokens;
  if (!dropTemperature && Number.isFinite(cfg.temperature)) body.temperature = cfg.temperature;

  if (!dropThinking && cfg.thinkingMode !== 'auto') {
    const enabled = cfg.thinkingMode === 'enabled';
    switch (style) {
      case 'thinking_object':
        body.thinking = { type: enabled ? 'enabled' : 'disabled' };
        break;
      case 'enable_thinking':
        // 仅用于明确支持该字段的服务商（如 DashScope / vLLM 部署的 Qwen），不作为通用参数
        body.enable_thinking = enabled;
        break;
      case 'reasoning_effort':
        body.reasoning_effort = enabled ? 'medium' : 'minimal';
        break;
      case 'none':
      default:
        break;
    }
  }
  return body;
}

function hasThinkingParam(body) {
  return (
    Object.prototype.hasOwnProperty.call(body, 'thinking') ||
    Object.prototype.hasOwnProperty.call(body, 'enable_thinking') ||
    Object.prototype.hasOwnProperty.call(body, 'reasoning_effort')
  );
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object}   opts
 * @param {object}   opts.settings  用户设置
 * @param {Array}    opts.messages  OpenAI 格式消息数组
 * @param {AbortSignal} [opts.signal]
 * @param {(ev: object) => void} opts.onEvent  流式事件回调
 * @returns {Promise<{content: string, reasoning: string, finishReason: string|null, notice: string}>}
 */
export async function sendChatRequest({ settings, messages, signal, onEvent }) {
  const cfg = mergeSettings(settings);
  const emit = typeof onEvent === 'function' ? onEvent : function () {};

  if (!cfg.apiKey) {
    throw new ApiError('尚未填写 API Key。请点击悬浮窗右上角的 ⚙ 打开设置页填写。', { code: 'no_key' });
  }
  if (!cfg.model) {
    throw new ApiError('尚未填写模型 ID。请打开设置页填写，例如 deepseek-flash。', { code: 'no_model' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError('没有可发送的消息。', { code: 'no_message' });
  }

  const url = normalizeApiUrl(cfg.apiBaseUrl);
  const style = resolveThinkingStyle(cfg);

  let stream = cfg.stream !== false;
  let dropThinking = false;
  let dropTemperature = false;
  let dropMaxTokens = false;
  let notice = '';

  for (let attempt = 0; attempt < 5; attempt++) {
    const body = buildBody(cfg, messages, stream, style, {
      dropThinking,
      dropTemperature,
      dropMaxTokens
    });
    const local = new AbortController();
    let userAborted = false;
    let timedOut = false;

    const onOuterAbort = () => {
      userAborted = true;
      local.abort();
    };
    if (signal) {
      if (signal.aborted) userAborted = true, local.abort();
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    let idleTimer = null;
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        local.abort();
      }, Math.max(5000, cfg.timeoutMs));
    };
    touch();

    try {
      const res = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey,
          Accept: stream ? 'text/event-stream' : 'application/json'
        },
        body: JSON.stringify(body),
        signal: local.signal
      });

      if (!res.ok) {
        const raw = await safeText(res);
        const info = describeHttpError(res.status, raw, cfg);

        // 服务商不认识「思考模式」参数 → 去掉该参数重试一次，并明确告知用户
        if (
          res.status === 400 &&
          !dropThinking &&
          hasThinkingParam(body) &&
          /thinking|reasoning|unknown|unrecognized|unsupported|invalid|extra|unexpected/i.test(raw)
        ) {
          dropThinking = true;
          notice =
            '该接口 / 模型不接受关闭思考模式的参数（' +
            style +
            '），已改为不发送该参数、按服务端默认行为重试。' +
            '注意：无法确认思考模式是否真的被关闭。';
          emit({ type: 'notice', text: notice });
          continue;
        }

        // 某些兼容接口不支持 stream
        if (res.status === 400 && stream && /stream/i.test(raw)) {
          stream = false;
          notice = '该接口不支持流式输出，已改为一次性返回。';
          emit({ type: 'notice', text: notice });
          continue;
        }

        // 部分推理模型不接受 temperature，去掉后重试
        if (res.status === 400 && !dropTemperature && /temperature/i.test(raw)) {
          dropTemperature = true;
          emit({ type: 'notice', text: '该模型不接受 temperature 参数，已去掉该参数重试。' });
          continue;
        }

        // 部分模型不接受 max_tokens（例如需要 max_completion_tokens）
        if (res.status === 400 && !dropMaxTokens && /max_tokens|max_completion_tokens/i.test(raw)) {
          dropMaxTokens = true;
          emit({ type: 'notice', text: '该接口不接受 max_tokens 参数，已去掉该参数重试。' });
          continue;
        }

        throw new ApiError(info.message, { code: info.code, status: res.status, raw: info.raw, httpError: true });
      }

      touch();

      if (!stream) {
        const json = await res.json().catch(() => {
          throw new ApiError('接口返回的不是合法 JSON，请检查 API 地址是否指向 Chat Completions 接口。');
        });
        if (json && json.error) {
          throw new ApiError('接口返回错误：' + maskSecrets(json.error.message || JSON.stringify(json.error), cfg.apiKey));
        }
        const choice = json && json.choices && json.choices[0];
        const msg = (choice && (choice.message || choice.delta)) || {};
        const content = typeof msg.content === 'string' ? msg.content : contentToText(msg.content);
        const reasoning = msg.reasoning_content || msg.reasoning || '';
        if (content || reasoning) emit({ type: 'delta', text: content || '', reasoning: reasoning || '' });
        return {
          content,
          reasoning,
          finishReason: (choice && choice.finish_reason) || null,
          notice
        };
      }

      /* ---------------- 流式 ------------- */
      if (!res.body) throw new ApiError('当前浏览器无法读取流式响应。');

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let content = '';
      let reasoning = '';
      let finishReason = null;
      let streamDone = false;

      while (!streamDone) {
        const chunk = await reader.read();
        if (chunk.done) break;
        touch();
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.indexOf('\r') !== -1) buffer = buffer.replace(/\r\n/g, '\n');

        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const payload = parseSseBlock(block);
          if (!payload) continue;
          if (payload === '[DONE]') {
            streamDone = true;
            break;
          }
          let json;
          try {
            json = JSON.parse(payload);
          } catch (e) {
            continue;
          }
          if (json.error) {
            throw new ApiError('流式响应返回错误：' + maskSecrets(json.error.message || JSON.stringify(json.error), cfg.apiKey));
          }
          const choice = json.choices && json.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta || choice.message || {};
          const c = typeof delta.content === 'string' ? delta.content : contentToText(delta.content);
          const r =
            typeof delta.reasoning_content === 'string'
              ? delta.reasoning_content
              : typeof delta.reasoning === 'string'
              ? delta.reasoning
              : '';
          if (c) content += c;
          if (r) reasoning += r;
          if (c || r) emit({ type: 'delta', text: c || '', reasoning: r || '' });
        }
      }

      try {
        reader.cancel();
      } catch (e) {
        /* ignore */
      }

      return { content, reasoning, finishReason, notice };
    } catch (err) {
      if (timedOut) {
        throw new ApiError(
          '请求超时：' +
            Math.round(cfg.timeoutMs / 1000) +
            ' 秒内没有收到新的数据。\n可以在设置页调大「请求超时时间」，或者检查网络与 API 地址。',
          { code: 'timeout' }
        );
      }
      if (userAborted) throw new AbortError();
      if (err && err.name === 'AbortError') {
        if (signal && signal.aborted) throw new AbortError();
        throw new ApiError('请求被中断。', { code: 'aborted' });
      }
      if (err instanceof ApiError) throw err;
      throw new ApiError(describeNetworkError(err, url), { code: 'network' });
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  throw new ApiError('请求失败：重试次数已用尽，请检查 API 配置。', { code: 'retry_exhausted' });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

async function safeText(res) {
  try {
    return await res.text();
  } catch (e) {
    return '';
  }
}

function parseSseBlock(block) {
  let data = '';
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('data:') === 0) {
      data += line.slice(5).replace(/^ /, '');
    }
  }
  return data || null;
}

function contentToText(content) {
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p.text === 'string') return p.text;
        return '';
      })
      .join('');
  }
  return typeof content === 'string' ? content : '';
}

export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '***';
  return k.slice(0, 4) + '…' + k.slice(-2);
}

export function maskSecrets(text, key) {
  let out = String(text == null ? '' : text);
  const k = String(key || '');
  if (k && k.length >= 6) out = out.split(k).join(maskKey(k));
  out = out.replace(/\b(sk|api|key)[-_][A-Za-z0-9._-]{6,}/gi, (m) => m.slice(0, 4) + '***');
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer ***');
  return out;
}

export function describeHttpError(status, rawText, cfg) {
  const raw = String(rawText || '');
  let apiMessage = '';
  try {
    const j = JSON.parse(raw);
    const m = (j && j.error && (j.error.message || j.error.type)) || (j && j.message) || '';
    apiMessage = typeof m === 'string' ? m : JSON.stringify(m);
  } catch (e) {
    /* not json */
  }

  const hints = {
    400: '请求被拒绝',
    401: 'API Key 无效或未授权',
    403: '没有访问权限',
    404: '接口地址或模型不存在',
    405: '接口不支持该请求方法',
    413: '请求体过大（图片可能太大）',
    422: '请求参数不被支持',
    429: '请求过于频繁或额度不足',
    500: '服务端内部错误',
    502: '网关错误',
    503: '服务暂时不可用',
    504: '网关超时'
  };

  let message = (hints[status] || '请求失败') + '（HTTP ' + status + '）';

  if ((status === 400 || status === 422) && /image|vision|multimodal|image_url|visual|图片/i.test(raw)) {
    message += '\n当前模型或接口可能不支持图片输入。请换用支持视觉的模型，或去掉图片后重试。';
  }
  if (status === 401) message += '\n请到设置页检查 API Key 是否正确、账户是否有余额。';
  if (status === 403) message += '\n请检查 API Key 的权限范围，或该模型是否对你开放。';
  if (status === 404) {
    message +=
      '\n请检查 API Base URL（通常以 /chat/completions 结尾）以及模型 ID 是否存在。';
  }
  if (status === 413) message += '\n请减少图片数量或让截图更小一些。';
  if (status === 429) message += '\n请稍后重试，或检查账户配额 / 频率限制。';
  if (status >= 500) message += '\n这是服务端问题，请稍后重试。';

  const detail = maskSecrets(apiMessage || raw, cfg && cfg.apiKey).slice(0, 500).trim();
  if (detail) message += '\n服务端返回：' + detail;

  return { message, raw: raw.slice(0, 1000), code: status };
}

function describeNetworkError(err, url) {
  const msg = String((err && err.message) || err || '');
  let host = url;
  try {
    host = new URL(url).host;
  } catch (e) {
    /* ignore */
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return (
      '无法连接到 ' +
      host +
      '。\n可能原因：API 地址写错、服务未启动、网络被墙、或该服务不允许浏览器直连。\n原始错误：' +
      msg
    );
  }
  return '请求出错：' + msg;
}
