/**
 * content.js — 悬浮窗控制器
 *
 * 负责：创建/显示/隐藏面板、拖动、缩放、附件、消息渲染、流式对话、截图编排。
 */
(function () {
  'use strict';
  if (window.__DSF_AI_READY__) return;
  window.__DSF_AI_READY__ = true;

  var K_SETTINGS = 'dsf_settings';
  var K_GEOM = 'dsf_geometry';

  var MIN_W = 340;
  var MIN_H = 300;
  var MAX_IMAGES = 4;

  var SOLVE_PROMPT =
    '请仔细识别图片中的所有题目，确保题目内容识别准确，然后逐题解答。' +
    '按照题目要求输出答案。如果是计算题，请提供必要的计算步骤。' +
    '如果是选择题，请明确给出选项和答案。如果图片中存在多个题目，请逐题回答。';

  var state = {
    ui: null,
    visible: false,
    minimized: false,
    capturing: false,
    settings: {},
    theme: 'auto',
    messages: [],
    attachments: [],
    geom: { width: 420, height: 620, left: null, top: 80 },
    streaming: false,
    port: null,
    currentAi: null,
    updateTimer: null,
    saveTimer: null,
    uid: 0
  };

  var initPromise = null;

  /* ================================================================== */
  /* 工具                                                                */
  /* ================================================================== */

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function storageGet(key) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(key, function (res) {
          resolve(res || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  function storageSet(obj) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set(obj, function () {
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  function uid() {
    state.uid += 1;
    return 'm' + Date.now().toString(36) + state.uid;
  }

  function hasApiKey() {
    return !!(state.settings && String(state.settings.apiKey || '').trim());
  }

  function openOptions() {
    try {
      chrome.runtime.sendMessage({ type: 'DSF_OPEN_OPTIONS' });
    } catch (e) {
      /* ignore */
    }
  }

  /* ================================================================== */
  /* 启动                                                                */
  /* ================================================================== */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    try {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'DSF_TOGGLE') {
        togglePanel();
        sendResponse({ ok: true });
      } else if (msg.type === 'DSF_PING') {
        sendResponse({ ok: true });
      }
    } catch (e) {
      try {
        sendResponse({ ok: false, error: String(e) });
      } catch (err) {
        /* ignore */
      }
    }
  });

  function init() {
    if (!initPromise) initPromise = doInit();
    return initPromise;
  }

  async function doInit() {
    var mounted = DSUI.mount();
    state.ui = mounted;
    wireEvents(mounted);

    var stored = await storageGet(K_SETTINGS);
    state.settings = stored[K_SETTINGS] || {};
    state.theme = state.settings.theme || 'auto';

    var geo = await storageGet(K_GEOM);
    if (geo[K_GEOM] && typeof geo[K_GEOM] === 'object') {
      state.geom = Object.assign({}, state.geom, geo[K_GEOM]);
    }

    applyTheme();
    applyGeometry();
    renderMessages();
    renderAttachments();
    updateStreamingUI();
    watchStorage();
    keepAlive();
    return mounted;
  }

  async function togglePanel() {
    try {
      await init();
      if (state.visible) hidePanel();
      else showPanel();
    } catch (e) {
      console.warn('[DeepSeek AI] 初始化悬浮窗失败：', e);
    }
  }

  function showPanel() {
    var ui = state.ui;
    if (!ui) return;
    ui.refs.panel.hidden = false;
    state.visible = true;
    if (state.minimized) {
      state.minimized = false;
      ui.refs.panel.classList.remove('is-min');
      applyGeometry();
    }
    // 设置可能在其他标签页被修改过
    refreshSettings();
    if (state.messages.length === 0) renderMessages();
  }

  function hidePanel() {
    var ui = state.ui;
    if (!ui) return;
    ui.refs.panel.hidden = true;
    state.visible = false;
  }

  function keepAlive() {
    // 某些 SPA 会整体替换 <html> 的子节点，定期检查宿主元素是否还在
    setInterval(function () {
      if (!state.ui) return;
      var host = state.ui.host;
      if (!host.isConnected) {
        try {
          (document.documentElement || document.body).appendChild(host);
        } catch (e) {
          /* ignore */
        }
      }
    }, 3000);
  }

  function watchStorage() {
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes[K_SETTINGS]) {
          state.settings = changes[K_SETTINGS].newValue || {};
          state.theme = state.settings.theme || 'auto';
          applyTheme();
        }
      });
    } catch (e) {
      /* ignore */
    }
  }

  async function refreshSettings() {
    var stored = await storageGet(K_SETTINGS);
    state.settings = stored[K_SETTINGS] || {};
    state.theme = state.settings.theme || 'auto';
    applyTheme();
  }

  /* ================================================================== */
  /* 主题                                                                */
  /* ================================================================== */

  function resolvedTheme() {
    if (state.theme === 'light' || state.theme === 'dark') return state.theme;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  function applyTheme() {
    if (!state.ui) return;
    state.ui.refs.panel.setAttribute('data-theme', resolvedTheme());
  }

  async function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    var idx = order.indexOf(state.theme);
    state.theme = order[(idx + 1) % order.length];
    applyTheme();
    state.settings.theme = state.theme;
    await storageSet({ dsf_settings: state.settings });
    var labels = { auto: '跟随系统', light: '浅色', dark: '深色' };
    setStatus('主题：' + labels[state.theme], 'info');
  }

  /* ================================================================== */
  /* 位置与大小                                                          */
  /* ================================================================== */

  function applyGeometry() {
    if (!state.ui) return;
    var panel = state.ui.refs.panel;
    var vw = window.innerWidth || 1024;
    var vh = window.innerHeight || 768;

    var maxW = Math.max(MIN_W, vw - 16);
    var maxH = Math.max(MIN_H, vh - 16);

    var width = clamp(Number(state.geom.width) || 420, MIN_W, maxW);
    var height = clamp(Number(state.geom.height) || 620, MIN_H, maxH);
    var left =
      state.geom.left == null ? vw - width - 24 : clamp(Number(state.geom.left) || 0, -width + 80, vw - 80);
    var top =
      state.geom.top == null
        ? clamp(72, 0, Math.max(0, vh - height - 16))
        : clamp(Number(state.geom.top) || 0, 0, Math.max(0, vh - 44));

    state.geom.width = width;
    state.geom.height = height;
    state.geom.left = left;
    state.geom.top = top;

    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
    panel.style.width = Math.round(width) + 'px';
    if (!state.minimized) panel.style.height = Math.round(height) + 'px';
  }

  function saveGeometrySoon() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      storageSet({ dsf_geometry: state.geom });
    }, 350);
  }

  function wireDrag(header) {
    var panel = state.ui.refs.panel;
    var drag = null;

    header.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('button')) return;
      var rect = panel.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, w: rect.width, h: rect.height };
      panel.classList.add('is-dragging');
      try {
        header.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      e.preventDefault();
    });

    header.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var left = clamp(e.clientX - drag.dx, -drag.w + 90, vw - 90);
      var top = clamp(e.clientY - drag.dy, 0, Math.max(0, vh - 44));
      state.geom.left = left;
      state.geom.top = top;
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
    });

    function endDrag(e) {
      if (!drag) return;
      drag = null;
      panel.classList.remove('is-dragging');
      try {
        header.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      saveGeometrySoon();
    }

    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
  }

  function wireResize(handle) {
    var panel = state.ui.refs.panel;
    var dir = handle.getAttribute('data-rz');
    var start = null;

    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var rect = panel.getBoundingClientRect();
      start = {
        x: e.clientX,
        y: e.clientY,
        w: rect.width,
        h: rect.height,
        left: rect.left,
        top: rect.top
      };
      panel.classList.add('is-resizing');
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      e.preventDefault();
      e.stopPropagation();
    });

    handle.addEventListener('pointermove', function (e) {
      if (!start) return;
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var dx = e.clientX - start.x;
      var dy = e.clientY - start.y;

      if (dir.indexOf('e') !== -1) {
        var w = clamp(start.w + dx, MIN_W, Math.max(MIN_W, vw - start.left - 8));
        state.geom.width = w;
        panel.style.width = Math.round(w) + 'px';
      }
      if (dir.indexOf('s') !== -1) {
        var h = clamp(start.h + dy, MIN_H, Math.max(MIN_H, vh - start.top - 8));
        state.geom.height = h;
        if (!state.minimized) {
          state.minimized = false;
          panel.classList.remove('is-min');
          panel.style.height = Math.round(h) + 'px';
        }
      }
    });

    function endResize(e) {
      if (!start) return;
      start = null;
      panel.classList.remove('is-resizing');
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      saveGeometrySoon();
    }

    handle.addEventListener('pointerup', endResize);
    handle.addEventListener('pointercancel', endResize);
  }

  /* ================================================================== */
  /* 事件绑定                                                            */
  /* ================================================================== */

  function wireEvents(mounted) {
    var refs = mounted.refs;
    var wrap = mounted.wrap;

    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (btn) {
        handleAction(btn.getAttribute('data-act'));
      }
    });

    refs.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        handleSend();
      }
    });

    refs.input.addEventListener('input', autosize);

    refs.input.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//i.test(items[i].type)) {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        handleFiles(files);
      }
    });

    // 文件选择框（放在 Shadow DOM 里，不影响网页）
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(fileInput.files || []);
      fileInput.value = '';
      if (files.length) handleFiles(files);
    });
    wrap.appendChild(fileInput);
    mounted.fileInput = fileInput;

    wireDrag(refs.header);
    var handles = wrap.querySelectorAll('[data-rz]');
    for (var i = 0; i < handles.length; i++) wireResize(handles[i]);

    // 图片预览
    refs.lightbox.addEventListener('click', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'IMG' || t.classList.contains('dsf-lightbox'))) {
        // 点击图片本身不关闭，点击背景或关闭按钮才关闭
        if (t.tagName === 'IMG') return;
      }
      closeLightbox();
    });

    refs.messages.addEventListener('click', function (e) {
      var copyBtn = e.target.closest ? e.target.closest('[data-copy]') : null;
      if (copyBtn) {
        var id = copyBtn.getAttribute('data-copy');
        var msg = state.messages.filter(function (m) {
          return m.id === id;
        })[0];
        if (msg) copyText(msg.text, copyBtn);
        e.preventDefault();
        return;
      }
      var thumb = e.target.closest ? e.target.closest('[data-preview]') : null;
      if (thumb) {
        openLightbox(thumb.getAttribute('data-preview'));
        e.preventDefault();
      }
    });

    // 阻止事件冒泡到网页（网页的快捷键 / 滚动劫持 / 拖拽等）
    var stopEvents = [
      'mousedown',
      'mouseup',
      'pointerdown',
      'pointerup',
      'dblclick',
      'contextmenu',
      'keydown',
      'keyup',
      'keypress',
      'wheel',
      'input',
      'paste',
      'click'
    ];
    stopEvents.forEach(function (type) {
      wrap.addEventListener(
        type,
        function (e) {
          e.stopPropagation();
        },
        type === 'wheel' ? { passive: true } : false
      );
    });

    window.addEventListener('resize', function () {
      if (!state.ui) return;
      applyGeometry();
      saveGeometrySoon();
    });

    try {
      window
        .matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', function () {
          if (state.theme === 'auto') applyTheme();
        });
    } catch (e) {
      /* ignore */
    }
  }

  function handleAction(action) {
    switch (action) {
      case 'send':
        handleSend();
        break;
      case 'stop':
        stopStream();
        break;
      case 'clear':
        clearConversation();
        break;
      case 'theme':
        cycleTheme();
        break;
      case 'settings':
        openOptions();
        break;
      case 'minimize':
        toggleMinimize();
        break;
      case 'close':
        hidePanel();
        break;
      case 'upload':
        if (state.ui && state.ui.fileInput) {
          state.ui.fileInput.value = '';
          state.ui.fileInput.click();
        }
        break;
      case 'solve':
        fillSolvePrompt();
        break;
      case 'capture-visible':
        captureVisibleFlow();
        break;
      case 'capture-full':
        captureFullFlow();
        break;
      case 'capture-region':
        captureRegionFlow();
        break;
      default:
        break;
    }
  }

  function toggleMinimize() {
    var panel = state.ui.refs.panel;
    state.minimized = !state.minimized;
    panel.classList.toggle('is-min', state.minimized);
    if (state.minimized) {
      panel.style.height = '';
    } else {
      applyGeometry();
    }
  }

  function autosize() {
    if (!state.ui) return;
    var input = state.ui.refs.input;
    input.style.height = 'auto';
    input.style.height = Math.min(140, Math.max(38, input.scrollHeight)) + 'px';
  }

  /* ================================================================== */
  /* 状态栏                                                              */
  /* ================================================================== */

  var statusTimer = null;

  function setStatus(text, kind) {
    if (!state.ui) return;
    var el = state.ui.refs.status;
    el.textContent = text || '';
    el.className = 'dsf-status' + (kind ? ' is-' + kind : '');
    if (statusTimer) clearTimeout(statusTimer);
    if (text && kind !== 'busy') {
      statusTimer = setTimeout(function () {
        if (state.ui) state.ui.refs.status.textContent = '';
      }, 6000);
    }
  }

  /* ================================================================== */
  /* 附件                                                                */
  /* ================================================================== */

  async function handleFiles(files) {
    for (var i = 0; i < files.length; i++) {
      if (state.attachments.length >= MAX_IMAGES) {
        setStatus('最多同时发送 ' + MAX_IMAGES + ' 张图片', 'warn');
        break;
      }
      try {
        setStatus('正在处理图片…', 'busy');
        var img = await DSImage.fromFile(files[i]);
        pushAttachment(img);
      } catch (e) {
        setStatus(String(e && e.message ? e.message : e), 'error');
      }
    }
    if (state.attachments.length) setStatus('', '');
  }

  async function addDataUrlImage(dataUrl, name) {
    if (state.attachments.length >= MAX_IMAGES) {
      setStatus('最多同时发送 ' + MAX_IMAGES + ' 张图片，请先删除一张', 'warn');
      return;
    }
    try {
      var img = await DSImage.fromDataUrl(dataUrl, name);
      pushAttachment(img);
    } catch (e) {
      setStatus('图片处理失败：' + (e && e.message ? e.message : e), 'error');
    }
  }

  function pushAttachment(img) {
    state.attachments.push({
      id: uid(),
      dataUrl: img.dataUrl,
      name: img.name || '图片',
      width: img.width,
      height: img.height,
      bytes: img.bytes
    });
    renderAttachments();
  }

  function renderAttachments() {
    if (!state.ui) return;
    var box = state.ui.refs.attachments;
    box.innerHTML = '';
    if (!state.attachments.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    state.attachments.forEach(function (att) {
      var item = document.createElement('div');
      item.className = 'dsf-att';

      var img = document.createElement('img');
      img.src = att.dataUrl;
      img.alt = att.name;
      img.title = att.name + ' · ' + Math.round(att.width) + '×' + Math.round(att.height);
      img.addEventListener('click', function () {
        openLightbox(att.dataUrl);
      });
      item.appendChild(img);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'dsf-att-remove';
      remove.textContent = '✕';
      remove.title = '删除这张图片';
      remove.addEventListener('click', function (e) {
        e.stopPropagation();
        state.attachments = state.attachments.filter(function (x) {
          return x.id !== att.id;
        });
        renderAttachments();
        setStatus('已删除图片', 'info');
      });
      item.appendChild(remove);

      box.appendChild(item);
    });
  }

  /* ================================================================== */
  /* 消息渲染                                                            */
  /* ================================================================== */

  function scrollBottom(force) {
    var box = state.ui.refs.messages;
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function scrollIfNearBottom() {
    scrollBottom(false);
  }

  function renderMessages() {
    if (!state.ui) return;
    var box = state.ui.refs.messages;
    var wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;

    box.innerHTML = '';
    state.messages.forEach(function (m) {
      m.el = null;
      box.appendChild(buildMessageEl(m));
    });

    if (!state.messages.length) box.appendChild(buildEmptyState());
    if (wasNearBottom) box.scrollTop = box.scrollHeight;
  }

  function buildEmptyState() {
    var box = document.createElement('div');
    box.className = 'dsf-empty';
    box.innerHTML =
      '<div class="dsf-empty-title">有什么可以帮你？</div>' +
      '<div class="dsf-empty-sub">截一张图，或者直接提问。图片会随消息一起发给模型。</div>' +
      '<div class="dsf-empty-tips">' +
      '<span>📷 可视区截图</span><span>🖼 整页截图</span><span>✂️ 区域截图</span><span>📎 本地图片</span>' +
      '</div>';

    if (!hasApiKey()) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dsf-empty-cta';
      btn.textContent = '先去配置 API Key';
      btn.addEventListener('click', openOptions);
      box.appendChild(btn);
    }
    return box;
  }

  function buildMessageEl(msg) {
    var wrap = document.createElement('div');
    wrap.className = 'dsf-msg dsf-msg-' + (msg.role === 'user' ? 'user' : 'ai');
    if (msg.error) wrap.classList.add('is-error');
    var bubble = document.createElement('div');
    bubble.className = 'dsf-bubble';
    wrap.appendChild(bubble);
    msg.el = wrap;
    msg.bubble = bubble;
    paintBubble(msg);
    return wrap;
  }

  function paintBubble(msg) {
    var bubble = msg.bubble;
    if (!bubble) return;
    bubble.innerHTML = '';

    if (msg.role === 'user') {
      if (msg.images && msg.images.length) {
        var gallery = document.createElement('div');
        gallery.className = 'dsf-msg-images';
        msg.images.forEach(function (src) {
          var img = document.createElement('img');
          img.src = src;
          img.alt = '图片';
          img.setAttribute('data-preview', src);
          gallery.appendChild(img);
        });
        bubble.appendChild(gallery);
      }
      if (msg.text) {
        var text = document.createElement('div');
        text.className = 'dsf-user-text';
        text.textContent = msg.text;
        bubble.appendChild(text);
      }
      return;
    }

    // ---- AI ----
    var md = document.createElement('div');
    md.className = 'dsf-md';
    if (msg.text) {
      md.innerHTML = DSMarkdown.render(msg.text);
    } else if (msg.streaming) {
      md.innerHTML = '<span class="dsf-typing"><i></i><i></i><i></i></span>';
    }
    bubble.appendChild(md);

    if (msg.streaming && msg.reasoning && !msg.text) {
      var thinking = document.createElement('div');
      thinking.className = 'dsf-thinking-hint';
      thinking.textContent = '模型正在思考…（已接收 ' + msg.reasoning.length + ' 字思考内容，不会作为答案显示）';
      bubble.appendChild(thinking);
    }

    if (!msg.streaming && msg.reasoning && msg.reasoning.trim()) {
      var details = document.createElement('details');
      details.className = 'dsf-reasoning';
      var summary = document.createElement('summary');
      summary.textContent = '思考过程（' + msg.reasoning.trim().length + ' 字，已折叠）';
      details.appendChild(summary);
      var pre = document.createElement('pre');
      pre.textContent = msg.reasoning.trim();
      details.appendChild(pre);
      bubble.appendChild(details);
    }

    if (msg.notice) {
      var notice = document.createElement('div');
      notice.className = 'dsf-notice';
      notice.textContent = msg.notice;
      bubble.appendChild(notice);
    }

    if (msg.error) {
      var err = document.createElement('div');
      err.className = 'dsf-error';
      err.textContent = msg.error;
      bubble.appendChild(err);
    }

    if (!msg.streaming && msg.text) {
      var actions = document.createElement('div');
      actions.className = 'dsf-msg-actions';
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'dsf-mini-btn';
      copy.setAttribute('data-copy', msg.id);
      copy.textContent = '复制';
      actions.appendChild(copy);
      bubble.appendChild(actions);
    }
  }

  function updateMessageEl(msg) {
    if (!msg || !msg.bubble) return;
    paintBubble(msg);
    scrollIfNearBottom();
  }

  function scheduleUpdate(msg) {
    if (state.updateTimer) return;
    state.updateTimer = setTimeout(function () {
      state.updateTimer = null;
      updateMessageEl(msg);
    }, 70);
  }

  /* ================================================================== */
  /* 剪贴板                                                              */
  /* ================================================================== */

  function copyText(text, btn) {
    var done = function (ok) {
      if (btn) {
        var old = btn.textContent;
        btn.textContent = ok ? '已复制' : '复制失败';
        setTimeout(function () {
          btn.textContent = old;
        }, 1500);
      }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          done(true);
        },
        function () {
          done(fallbackCopy(text));
        }
      );
    } else {
      done(fallbackCopy(text));
    }
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ================================================================== */
  /* 图片预览                                                            */
  /* ================================================================== */

  function openLightbox(src) {
    if (!state.ui) return;
    var box = state.ui.refs.lightbox;
    var img = box.querySelector('img');
    if (img) img.src = src;
    box.hidden = false;
  }

  function closeLightbox() {
    if (!state.ui) return;
    var box = state.ui.refs.lightbox;
    box.hidden = true;
    var img = box.querySelector('img');
    if (img) img.src = '';
  }

  /* ================================================================== */
  /* 对话                                                                */
  /* ================================================================== */

  function fillSolvePrompt() {
    if (!state.ui) return;
    var input = state.ui.refs.input;
    input.value = SOLVE_PROMPT;
    autosize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    if (!state.attachments.length) {
      setStatus('已填入解题提示词 —— 别忘了先截图或上传题目图片', 'info');
    } else {
      setStatus('已填入解题提示词，可修改后发送', 'info');
    }
  }

  function clearConversation() {
    if (state.streaming) {
      setStatus('请先停止正在生成的回答', 'warn');
      return;
    }
    state.messages = [];
    renderMessages();
    setStatus('对话已清空', 'info');
  }

  function buildApiMessages() {
    var out = [];
    var sys = String((state.settings && state.settings.systemPrompt) || '').trim();
    if (sys) out.push({ role: 'system', content: sys });

    var usable = state.messages.filter(function (m) {
      if (m.error) return false;
      if (m.role === 'user') return !!(m.text && m.text.trim()) || (m.images && m.images.length);
      return !!(m.text && m.text.trim());
    });

    // 从最近的用户消息往前分配图片额度，避免历史图片把请求撑爆
    var budget = MAX_IMAGES;
    var enriched = [];
    for (var i = usable.length - 1; i >= 0; i--) {
      var m = usable[i];
      if (m.role === 'user') {
        var imgs = (m.images || []).slice(0, Math.max(0, budget));
        budget -= imgs.length;
        enriched.unshift({ msg: m, images: imgs });
      } else {
        enriched.unshift({ msg: m, images: [] });
      }
    }

    enriched.forEach(function (item) {
      var m = item.msg;
      if (m.role === 'assistant') {
        out.push({ role: 'assistant', content: m.text.trim() });
        return;
      }
      var text = (m.text || '').trim();
      var dropped = (m.images || []).length - item.images.length;
      var note = dropped > 0 ? '（另有 ' + dropped + ' 张历史图片因长度限制未随本次请求发送）' : '';

      if (!item.images.length) {
        out.push({ role: 'user', content: text + (note ? '\n' + note : '') });
        return;
      }

      var parts = [];
      var combined = (text + (note ? '\n' + note : '')).trim();
      if (combined) parts.push({ type: 'text', text: combined });
      item.images.forEach(function (url) {
        parts.push({ type: 'image_url', image_url: { url: url } });
      });
      out.push({ role: 'user', content: parts });
    });

    return out;
  }

  function handleSend() {
    if (!state.ui || state.streaming) return;

    var input = state.ui.refs.input;
    var text = input.value.trim();
    var images = state.attachments.map(function (a) {
      return a.dataUrl;
    });

    if (!text && !images.length) {
      setStatus('请先输入问题，或添加一张图片', 'warn');
      return;
    }

    if (!hasApiKey()) {
      setStatus('还没有配置 API Key，正在打开设置页…', 'warn');
      openOptions();
      return;
    }

    var userMsg = {
      id: uid(),
      role: 'user',
      text: text,
      images: images,
      ts: Date.now()
    };
    state.messages.push(userMsg);

    input.value = '';
    autosize();
    state.attachments = [];
    renderAttachments();

    var aiMsg = {
      id: uid(),
      role: 'assistant',
      text: '',
      reasoning: '',
      streaming: true,
      ts: Date.now()
    };
    state.messages.push(aiMsg);

    renderMessages();
    scrollBottom(true);

    startStream(buildApiMessages(), aiMsg);
  }

  function startStream(apiMessages, aiMsg) {
    state.streaming = true;
    state.currentAi = aiMsg;
    updateStreamingUI();
    scrollBottom(true);

    var port;
    try {
      port = chrome.runtime.connect({ name: 'dsf-chat' });
    } catch (e) {
      failStream(aiMsg, '扩展后台连接失败（扩展可能刚刚被更新）。请刷新页面后重试。');
      return;
    }
    state.port = port;

    port.onMessage.addListener(function (ev) {
      if (!ev || typeof ev !== 'object') return;
      if (aiMsg.done) return;

      if (ev.type === 'delta') {
        if (ev.text) aiMsg.text += ev.text;
        if (ev.reasoning) aiMsg.reasoning += ev.reasoning;
        scheduleUpdate(aiMsg);
      } else if (ev.type === 'notice') {
        aiMsg.notice = (aiMsg.notice ? aiMsg.notice + '\n' : '') + ev.text;
        scheduleUpdate(aiMsg);
      } else if (ev.type === 'done') {
        finishStream(aiMsg, ev);
      } else if (ev.type === 'error') {
        failStream(aiMsg, ev.message || '请求失败');
      }
    });

    port.onDisconnect.addListener(function () {
      if (aiMsg.done) return;
      // 后台可能异常终止
      if (state.streaming && state.currentAi === aiMsg) {
        finishStream(aiMsg, {
          aborted: true,
          content: aiMsg.text,
          reasoning: aiMsg.reasoning
        });
      }
    });

    try {
      port.postMessage({
        type: 'start',
        payload: {
          messages: apiMessages,
          settings: state.settings
        }
      });
    } catch (e) {
      failStream(aiMsg, '发送请求失败：' + (e && e.message ? e.message : e));
    }
  }

  function stopStream() {
    if (!state.streaming) return;
    var aiMsg = state.currentAi;
    try {
      if (state.port) state.port.postMessage({ type: 'abort' });
    } catch (e) {
      /* ignore */
    }
    if (aiMsg) {
      finishStream(aiMsg, {
        aborted: true,
        content: aiMsg.text,
        reasoning: aiMsg.reasoning
      });
    }
    setStatus('已停止生成', 'info');
  }

  function finishStream(aiMsg, ev) {
    if (!aiMsg || aiMsg.done) return;
    aiMsg.done = true;
    aiMsg.streaming = false;
    state.streaming = false;
    state.currentAi = null;

    if (state.port) {
      try {
        state.port.disconnect();
      } catch (e) {
        /* ignore */
      }
      state.port = null;
    }
    if (state.updateTimer) {
      clearTimeout(state.updateTimer);
      state.updateTimer = null;
    }

    if (ev.aborted) {
      aiMsg.text = String(ev.content != null ? ev.content : aiMsg.text || '');
      if (ev.reasoning) aiMsg.reasoning = ev.reasoning;
      if (!aiMsg.text.trim()) {
        if (!aiMsg.reasoning.trim()) aiMsg.error = '已停止生成。';
      }
    } else {
      if (typeof ev.content === 'string' && ev.content) aiMsg.text = ev.content;
      if (ev.reasoning) aiMsg.reasoning = ev.reasoning;
      // 同一条提示可能已经通过 notice 事件显示过，避免重复
      if (ev.notice && (!aiMsg.notice || aiMsg.notice.indexOf(ev.notice) === -1)) {
        aiMsg.notice = (aiMsg.notice ? aiMsg.notice + '\n' : '') + ev.notice;
      }

      if (!aiMsg.text.trim()) {
        if (aiMsg.reasoning.trim()) {
          aiMsg.error =
            '模型只输出了思考内容，没有给出最终答案。\n' +
            '建议：在设置页关闭思考模式（或换用支持关闭思考的模型），调大「最大输出 Token」后重试。';
        } else if (ev.finishReason === 'length') {
          aiMsg.error = '模型输出达到上限但没有返回内容，请调大「最大输出 Token」后重试。';
        } else {
          aiMsg.error = '模型没有返回任何内容。请重试，或检查模型 ID 与 API 配置。';
        }
      } else if (ev.finishReason === 'length') {
        aiMsg.notice = (aiMsg.notice ? aiMsg.notice + '\n' : '') + '回答达到「最大输出 Token」上限，内容可能被截断。';
      }
    }

    updateMessageEl(aiMsg);
    updateStreamingUI();
    scrollBottom(true);
  }

  function failStream(aiMsg, message) {
    if (!aiMsg || aiMsg.done) return;
    aiMsg.done = true;
    aiMsg.streaming = false;
    aiMsg.error = message;
    state.streaming = false;
    state.currentAi = null;
    if (state.port) {
      try {
        state.port.disconnect();
      } catch (e) {
        /* ignore */
      }
      state.port = null;
    }
    updateMessageEl(aiMsg);
    updateStreamingUI();
    scrollBottom(true);
  }

  function updateStreamingUI() {
    if (!state.ui) return;
    var refs = state.ui.refs;
    refs.stop.hidden = !state.streaming;
    refs.send.textContent = state.streaming ? '发送中' : '发送';
    refs.send.classList.toggle('is-busy', state.streaming);
    var tools = state.ui.wrap.querySelectorAll('.dsf-tool');
    for (var i = 0; i < tools.length; i++) {
      tools[i].disabled = state.capturing;
    }
  }

  /* ================================================================== */
  /* 截图                                                                */
  /* ================================================================== */

  function hideForCapture() {
    if (!state.ui) return;
    state.ui.refs.panel.style.visibility = 'hidden';
  }

  function showAfterCapture() {
    if (!state.ui) return;
    state.ui.refs.panel.style.visibility = '';
  }

  function setHud(text) {
    if (!state.ui) return;
    var hud = state.ui.refs.hud;
    hud.textContent = text;
    hud.hidden = !text;
  }

  async function captureVisibleFlow() {
    if (!state.ui || state.capturing) return;
    state.capturing = true;
    updateStreamingUI();
    setStatus('正在截取可视区域…', 'busy');
    try {
      hideForCapture();
      await sleep(160);
      var dataUrl = await DSShot.captureVisible('png');
      showAfterCapture();
      await addDataUrlImage(dataUrl, '可视区域截图');
      setStatus('截图已添加到输入框下方，可继续输入问题', 'ok');
    } catch (e) {
      showAfterCapture();
      setStatus(String((e && e.message) || e), 'error');
    } finally {
      state.capturing = false;
      updateStreamingUI();
    }
  }

  async function captureRegionFlow() {
    if (!state.ui || state.capturing) return;
    state.capturing = true;
    updateStreamingUI();
    var ui = state.ui;

    hideForCapture();
    setStatus('拖动鼠标选择区域，Esc 取消', 'busy');

    var rect = null;
    try {
      rect = await DSShot.selectRegion(ui.refs.overlay);
    } catch (e) {
      rect = null;
    }

    if (!rect) {
      showAfterCapture();
      setStatus('已取消区域截图', 'info');
      state.capturing = false;
      updateStreamingUI();
      return;
    }

    try {
      setStatus('正在截取选定区域…', 'busy');
      await sleep(160);
      var dataUrl = await DSShot.cropViewportRect(rect);
      showAfterCapture();
      await addDataUrlImage(dataUrl, '区域截图');
      setStatus('区域截图已添加', 'ok');
    } catch (e) {
      showAfterCapture();
      setStatus('区域截图失败：' + ((e && e.message) || e), 'error');
    } finally {
      state.capturing = false;
      updateStreamingUI();
    }
  }

  async function captureFullFlow() {
    if (!state.ui || state.capturing) return;
    var ui = state.ui;
    state.capturing = true;
    updateStreamingUI();
    hideForCapture();
    setStatus('正在截取整页…', 'busy');
    setHud('正在截取整页…');

    try {
      var result = await DSShot.grabFullPage({
        onProgress: function (n, total) {
          setHud('正在截取整页 ' + n + ' / ' + total + ' 屏');
        },
        beforeFrame: async function () {
          if (ui.refs.hud) ui.refs.hud.style.visibility = 'hidden';
        },
        afterFrame: async function () {
          if (ui.refs.hud) ui.refs.hud.style.visibility = '';
        }
      });

      setHud('');
      showAfterCapture();
      await addDataUrlImage(result.dataUrl, '整页截图');

      var msg = '整页截图已添加（共 ' + result.tiles + ' 屏）';
      if (result.scaled) msg += '，页面过长已按比例缩小';
      if (result.truncated) msg += '；超出最大高度，只截取了前 ' + result.tiles + ' 屏';
      if (result.stalled) {
        msg = '这个页面没有整体滚动（可能用了内部滚动容器），整页截图只包含当前屏。请改用「可视区」分段截图。';
      }
      setStatus(msg, result.truncated || result.stalled ? 'warn' : 'ok');
    } catch (e) {
      setHud('');
      showAfterCapture();
      setStatus(
        '整页截图失败：' + ((e && e.message) || e) + '。可以先用「可视区」截图。',
        'error'
      );
    } finally {
      setHud('');
      state.capturing = false;
      updateStreamingUI();
    }
  }
})();
