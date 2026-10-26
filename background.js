/**
 * background.js — Service Worker
 *
 * 职责：
 *  1. 工具栏图标 / 快捷键 → 让当前标签页里的悬浮窗显示或隐藏
 *  2. 提供截图能力（chrome.tabs.captureVisibleTab 只能在后台调用）
 *  3. 代理流式对话请求（后台有 host 权限，不受网页 CORS 限制）
 *  4. 打开设置页、测试连接
 */

import {
  sendChatRequest,
  mergeSettings,
  DEFAULT_SETTINGS,
  maskSecrets
} from './api.js';

const CONTENT_FILES = ['markdown.js', 'image.js', 'screenshot.js', 'ui.js', 'content.js'];

/** 浏览器内部页面，无法注入内容脚本 */
const RESTRICTED_URL = /^(chrome|edge|about|chrome-extension|edge-extension|extension|devtools|view-source|chrome-untrusted|edge-untrusted|brave|opera|vivaldi|yandex):/i;

/* ------------------------------------------------------------------ */
/* 打开 / 关闭悬浮窗                                                   */
/* ------------------------------------------------------------------ */

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'DSF_PING' });
    if (res && res.ok) return true;
  } catch (e) {
    /* 尚未注入 */
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  return true;
}

async function toggleOnTab(tab) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) return;

  if (RESTRICTED_URL.test(tab.url || '')) {
    flashBadge(tab.id, '!', '#d64545');
    return;
  }
  // 扩展商店 / PDF 阅读器等页面同样禁止注入
  if (/^https?:\/\/chromewebstore\.google\.com\//i.test(tab.url || '') ||
      /^https?:\/\/chrome\.google\.com\/webstore\//i.test(tab.url || '')) {
    flashBadge(tab.id, '!', '#d64545');
    return;
  }

  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'DSF_TOGGLE' });
  } catch (err) {
    console.warn('[DeepSeek AI] 无法在此页面创建悬浮窗：', err);
    flashBadge(tab.id, '!', '#d64545');
  }
}

function flashBadge(tabId, text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color }, () => void chrome.runtime.lastError);
    chrome.action.setBadgeText({ tabId, text }, () => void chrome.runtime.lastError);
    setTimeout(() => {
      try {
        chrome.action.setBadgeText({ tabId, text: '' }, () => void chrome.runtime.lastError);
      } catch (e) {
        /* tab 可能已关闭 */
      }
    }, 3000);
  } catch (e) {
    /* ignore */
  }
}

chrome.action.onClicked.addListener((tab) => {
  toggleOnTab(tab);
});

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-panel') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    toggleOnTab(tab);
  });
}

/* ------------------------------------------------------------------ */
/* 安装 / 更新                                                         */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // 首次安装时写入默认设置，方便用户直接看到默认值
    const stored = await chrome.storage.local.get('dsf_settings');
    if (!stored || !stored.dsf_settings) {
      await chrome.storage.local.set({ dsf_settings: { ...DEFAULT_SETTINGS } });
      chrome.runtime.openOptionsPage();
    }
  }
});

/* ------------------------------------------------------------------ */
/* 一次性消息                                                          */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'DSF_CAPTURE_VISIBLE': {
      const windowId = sender.tab && typeof sender.tab.windowId === 'number' ? sender.tab.windowId : undefined;
      const format = msg.format === 'jpeg' ? 'jpeg' : 'png';
      const options = { format };
      if (format === 'jpeg') options.quality = 92;

      const onCaptured = (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message || '截图失败' });
          return;
        }
        if (!dataUrl) {
          sendResponse({ ok: false, error: '截图结果为空' });
          return;
        }
        sendResponse({ ok: true, dataUrl });
      };

      try {
        if (typeof windowId === 'number') {
          chrome.tabs.captureVisibleTab(windowId, options, onCaptured);
        } else {
          chrome.tabs.captureVisibleTab(options, onCaptured);
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
      return true; // 异步响应
    }

    case 'DSF_OPEN_OPTIONS': {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return;
    }

    case 'DSF_GET_DEFAULTS': {
      sendResponse({ ok: true, defaults: DEFAULT_SETTINGS });
      return;
    }

    case 'DSF_TEST': {
      (async () => {
        const cfg = mergeSettings((msg.payload && msg.payload.settings) || {});
        try {
          const result = await sendChatRequest({
            settings: {
              ...cfg,
              stream: false,
              maxTokens: 32,
              // 测试连接时不发送思考模式参数，尽量提高兼容性
              thinkingMode: 'auto'
            },
            messages: [{ role: 'user', content: '请只回复两个字：可用' }],
            onEvent: () => {}
          });
          sendResponse({
            ok: true,
            reply: String(result.content || '').slice(0, 200) || '（服务端没有返回文字，但请求成功）'
          });
        } catch (err) {
          sendResponse({
            ok: false,
            error: maskSecrets((err && err.message) || String(err), cfg.apiKey)
          });
        }
      })();
      return true;
    }

    default:
      return;
  }
});

/* ------------------------------------------------------------------ */
/* 聊天端口（流式）                                                    */
/* ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dsf-chat') return;

  const controller = new AbortController();
  let closed = false;
  let first = true;

  const post = (obj) => {
    if (closed) return;
    try {
      port.postMessage(obj);
    } catch (e) {
      closed = true;
    }
  };

  port.onDisconnect.addListener(() => {
    closed = true;
    try {
      controller.abort();
    } catch (e) {
      /* ignore */
    }
  });

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'abort') {
      try {
        controller.abort();
      } catch (e) {
        /* ignore */
      }
      return;
    }

    if (msg.type !== 'start' || !first) return;
    first = false;

    const payload = msg.payload || {};
    const settings = mergeSettings(payload.settings);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];

    (async () => {
      try {
        const result = await sendChatRequest({
          settings,
          messages,
          signal: controller.signal,
          onEvent: (ev) => post(ev)
        });
        post({
          type: 'done',
          content: result.content || '',
          reasoning: result.reasoning || '',
          finishReason: result.finishReason || null,
          notice: result.notice || '',
          aborted: false
        });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          post({ type: 'done', content: '', reasoning: '', aborted: true, notice: '' });
        } else {
          post({
            type: 'error',
            message: maskSecrets((err && err.message) || String(err), settings.apiKey)
          });
        }
      }
    })();
  });
});
