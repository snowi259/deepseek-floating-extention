/**
 * ui.js — 悬浮窗的 Shadow DOM 外壳
 *
 * 用 Shadow DOM 把悬浮窗和网页彻底隔离：网页的 CSS 进不来，我们的样式也不会污染网页。
 * 宿主元素挂在 <html> 上，即使网页替换了 <body> 也不会被清掉。
 */
(function () {
  'use strict';
  if (window.DSUI) return;

  var TEMPLATE = [
    '<div class="dsf-root">',
    '  <div class="dsf-panel" hidden>',
    '    <header class="dsf-header" data-role="header">',
    '      <span class="dsf-logo" aria-hidden="true">D</span>',
    '      <span class="dsf-title">DeepSeek AI</span>',
    '      <div class="dsf-head-actions">',
    '        <button class="dsf-icon" data-act="clear" type="button" title="清空当前对话">🗑</button>',
    '        <button class="dsf-icon" data-act="theme" type="button" title="切换深色 / 浅色">◐</button>',
    '        <button class="dsf-icon" data-act="settings" type="button" title="打开设置">⚙</button>',
    '        <button class="dsf-icon" data-act="minimize" type="button" title="最小化">–</button>',
    '        <button class="dsf-icon dsf-icon-close" data-act="close" type="button" title="关闭">✕</button>',
    '      </div>',
    '    </header>',
    '    <div class="dsf-messages" data-role="messages"></div>',
    '    <div class="dsf-composer">',
    '      <div class="dsf-attachments" data-role="attachments" hidden></div>',
    '      <div class="dsf-tools">',
    '        <button class="dsf-tool" data-act="capture-visible" type="button" title="截取当前网页可视区域">📷 可视区</button>',
    '        <button class="dsf-tool" data-act="capture-full" type="button" title="滚动截取整个网页">🖼 整页</button>',
    '        <button class="dsf-tool" data-act="capture-region" type="button" title="拖动鼠标选择截图区域">✂️ 区域</button>',
    '        <button class="dsf-tool" data-act="upload" type="button" title="上传本地图片">📎 图片</button>',
    '        <button class="dsf-tool dsf-tool-primary" data-act="solve" type="button" title="填入「解答截图」提示词">🎯 解题</button>',
    '      </div>',
    '      <div class="dsf-input-row">',
    '        <textarea class="dsf-input" data-role="input" rows="1" placeholder="输入问题…（Enter 发送，Shift+Enter 换行）"></textarea>',
    '      </div>',
    '      <div class="dsf-foot">',
    '        <span class="dsf-status" data-role="status"></span>',
    '        <div class="dsf-send-group">',
    '          <button class="dsf-btn dsf-btn-stop" data-act="stop" type="button" hidden>停止</button>',
    '          <button class="dsf-btn dsf-btn-send" data-act="send" type="button">发送</button>',
    '        </div>',
    '      </div>',
    '    </div>',
    '    <div class="dsf-rz dsf-rz-e" data-rz="e" title="拖动调整宽度"></div>',
    '    <div class="dsf-rz dsf-rz-s" data-rz="s" title="拖动调整高度"></div>',
    '    <div class="dsf-rz dsf-rz-se" data-rz="se" title="拖动调整大小"></div>',
    '  </div>',
    '  <div class="dsf-hud" hidden></div>',
    '  <div class="dsf-overlay" hidden></div>',
    '  <div class="dsf-lightbox" hidden>',
    '    <img alt="图片预览">',
    '    <button class="dsf-lightbox-close" type="button" title="关闭预览">✕</button>',
    '  </div>',
    '</div>'
  ].join('\n');

  function mount() {
    var host = document.createElement('div');
    host.id = 'dsf-ai-host';
    host.setAttribute('data-dsf-ai', '1');
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; ' +
      'z-index: 2147483647; pointer-events: none;';

    var shadow;
    try {
      shadow = host.attachShadow({ mode: 'closed' });
    } catch (e) {
      shadow = host.attachShadow({ mode: 'open' });
    }

    var link = document.createElement('link');
    link.rel = 'stylesheet';
    var cssUrl = '';
    try {
      cssUrl = chrome.runtime.getURL('content.css');
      link.href = cssUrl;
    } catch (e) {
      link.href = '';
    }
    // 个别网页的 CSP 可能会拦住 <link>，退化成内联 <style>
    link.addEventListener('error', function () {
      if (!cssUrl) return;
      try {
        fetch(cssUrl)
          .then(function (r) {
            return r.text();
          })
          .then(function (css) {
            var st = document.createElement('style');
            st.textContent = css;
            shadow.insertBefore(st, shadow.firstChild);
          })
          .catch(function () {
            /* ignore */
          });
      } catch (e) {
        /* ignore */
      }
    });
    shadow.appendChild(link);

    var wrap = document.createElement('div');
    wrap.className = 'dsf-wrap';
    wrap.innerHTML = TEMPLATE;
    shadow.appendChild(wrap);

    var parent = document.documentElement || document.body;
    parent.appendChild(host);

    return {
      host: host,
      shadow: shadow,
      wrap: wrap,
      refs: {
        root: wrap.querySelector('.dsf-root'),
        panel: wrap.querySelector('.dsf-panel'),
        header: wrap.querySelector('[data-role="header"]'),
        messages: wrap.querySelector('[data-role="messages"]'),
        input: wrap.querySelector('[data-role="input"]'),
        status: wrap.querySelector('[data-role="status"]'),
        attachments: wrap.querySelector('[data-role="attachments"]'),
        send: wrap.querySelector('[data-act="send"]'),
        stop: wrap.querySelector('[data-act="stop"]'),
        hud: wrap.querySelector('.dsf-hud'),
        overlay: wrap.querySelector('.dsf-overlay'),
        lightbox: wrap.querySelector('.dsf-lightbox')
      }
    };
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function iconButton(label, title, className) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className || 'dsf-mini-btn';
    btn.textContent = label;
    if (title) btn.title = title;
    return btn;
  }

  window.DSUI = {
    mount: mount,
    el: el,
    iconButton: iconButton
  };
})();
