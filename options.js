/**
 * options.js — 设置页逻辑
 *
 * 只写入 chrome.storage.local，不联网、不上传。
 */

import { DEFAULT_SETTINGS, mergeSettings, normalizeApiUrl } from './api.js';

const K_SETTINGS = 'dsf_settings';
const $ = (id) => document.getElementById(id);

const PRESETS = {
  deepseek: {
    apiBaseUrl: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-flash',
    thinkingStyle: 'thinking_object'
  },
  dashscope: {
    apiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-vl-max',
    thinkingStyle: 'enable_thinking'
  },
  openai: {
    apiBaseUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    thinkingStyle: 'reasoning_effort'
  },
  cf: {
    apiBaseUrl:
      'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1/chat/completions',
    model: '@cf/meta/llama-3.1-8b-instruct',
    thinkingStyle: 'none'
  }
};

let statusTimer = null;

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text || '';
  el.className = 'status' + (kind ? ' is-' + kind : '');
  if (statusTimer) clearTimeout(statusTimer);
  if (text) {
    statusTimer = setTimeout(() => {
      el.textContent = '';
    }, 5000);
  }
}

function fillForm(raw) {
  const s = mergeSettings(raw);
  $('apiBaseUrl').value = s.apiBaseUrl;
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('maxTokens').value = s.maxTokens;
  $('timeoutMs').value = Math.round(s.timeoutMs / 1000);
  $('temperature').value = s.temperature;
  $('temp-value').textContent = String(s.temperature);
  $('stream').checked = !!s.stream;
  $('thinkingMode').value = s.thinkingMode;
  $('thinkingStyle').value = s.thinkingStyle;
  $('systemPrompt').value = s.systemPrompt;
  $('theme').value = s.theme;
}

function readForm() {
  const timeoutSeconds = Number($('timeoutMs').value);
  return mergeSettings({
    apiBaseUrl: $('apiBaseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    maxTokens: $('maxTokens').value,
    timeoutMs: Number.isFinite(timeoutSeconds) ? timeoutSeconds * 1000 : DEFAULT_SETTINGS.timeoutMs,
    temperature: $('temperature').value,
    stream: $('stream').checked,
    thinkingMode: $('thinkingMode').value,
    thinkingStyle: $('thinkingStyle').value,
    systemPrompt: $('systemPrompt').value,
    theme: $('theme').value
  });
}

async function load() {
  const stored = await chrome.storage.local.get(K_SETTINGS);
  const settings = stored[K_SETTINGS] || {};
  fillForm(Object.keys(settings).length ? settings : DEFAULT_SETTINGS);
}

async function save() {
  const settings = readForm();

  let url = settings.apiBaseUrl;
  try {
    url = normalizeApiUrl(url);
  } catch (e) {
    setStatus('请先填写 API 地址', 'error');
    return;
  }
  settings.apiBaseUrl = url;
  $('apiBaseUrl').value = url;

  await chrome.storage.local.set({ [K_SETTINGS]: settings });
  setStatus('已保存', 'ok');
}

async function testConnection() {
  const btn = $('test-btn');
  const result = $('test-result');
  const settings = readForm();
  const key = settings.apiKey;

  result.hidden = false;
  result.className = 'result';
  result.textContent = '正在请求 ' + settings.apiBaseUrl + ' …';
  btn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'DSF_TEST',
      payload: { settings }
    });
    if (res && res.ok) {
      result.className = 'result is-ok';
      result.textContent = '✅ 连接成功，模型返回：' + (res.reply || '（空）');
    } else {
      result.className = 'result is-error';
      result.textContent = '❌ ' + ((res && res.error) || '未知错误');
    }
  } catch (e) {
    result.className = 'result is-error';
    result.textContent = '❌ 测试失败：' + (e && e.message ? e.message : e);
  } finally {
    btn.disabled = false;
    if (key) {
      // 防止密钥意外出现在页面上
      result.textContent = result.textContent.split(key).join('***');
    }
  }
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  $('apiBaseUrl').value = preset.apiBaseUrl;
  $('model').value = preset.model;
  $('thinkingStyle').value = preset.thinkingStyle;
  setStatus('已套用模板，记得保存', 'info');
}

/* ---------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  load();

  $('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });

  $('temperature').addEventListener('input', () => {
    $('temp-value').textContent = $('temperature').value;
  });

  $('toggle-key').addEventListener('click', () => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggle-key').textContent = show ? '隐藏' : '显示';
  });

  $('model-preset').addEventListener('change', (e) => {
    if (e.target.value) {
      $('model').value = e.target.value;
      e.target.value = '';
    }
  });

  $('provider-preset').addEventListener('change', (e) => {
    applyPreset(e.target.value);
    e.target.value = '';
  });

  $('test-btn').addEventListener('click', testConnection);

  $('reset-btn').addEventListener('click', () => {
    fillForm(DEFAULT_SETTINGS);
    setStatus('已恢复默认值，点击「保存设置」生效', 'info');
  });
});
