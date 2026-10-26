/**
 * screenshot.js — 截图能力
 *
 * 可视区域截图：后台调用 chrome.tabs.captureVisibleTab()
 * 整页截图：滚动页面 → 逐屏截图 → canvas 拼接
 * 区域截图：透明遮罩 + 鼠标拖选 → 按设备像素比裁剪
 */
(function () {
  'use strict';
  if (window.DSShot) return;

  var MAX_TILES = 40; // 最多拼接 40 屏，防止超长页面卡死
  var MAX_CANVAS_PIXELS = 24000000; // 输出画布最大像素（约 24MP）
  var MAX_CANVAS_DIM = 26000;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        resolve();
      });
    });
  }

  function sendBg(msg) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          settled = true;
          var err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || '扩展后台无响应'));
            return;
          }
          resolve(res);
        });
      } catch (e) {
        if (!settled) reject(e);
      }
    });
  }

  async function captureVisible(format) {
    var res;
    try {
      res = await sendBg({ type: 'DSF_CAPTURE_VISIBLE', format: format || 'png' });
    } catch (e) {
      throw new Error(
        '截图失败：' +
          (e && e.message ? e.message : e) +
          '。如果扩展刚刚更新过，请刷新页面后重试。'
      );
    }
    if (!res || !res.ok || !res.dataUrl) {
      var detail = res && res.error ? res.error : '未知错误';
      throw new Error(
        '当前页面无法截图（' +
          detail +
          '）。浏览器内部页面、扩展商店、PDF 阅读器等受保护页面不允许截图。'
      );
    }
    return res.dataUrl;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error('截图数据解码失败'));
      };
      img.src = src;
    });
  }

  async function loadBitmap(dataUrl) {
    var blob = await (await fetch(dataUrl)).blob();
    if (typeof createImageBitmap === 'function') {
      return await createImageBitmap(blob);
    }
    var img = await loadImage(dataUrl);
    return img;
  }

  async function waitForImages(timeoutMs) {
    var imgs = Array.prototype.slice.call(document.images || []);
    var pending = imgs.filter(function (img) {
      return !img.complete && img.src;
    });
    if (!pending.length) return;
    await Promise.race([
      Promise.all(
        pending.map(function (img) {
          return new Promise(function (resolve) {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          });
        })
      ),
      sleep(timeoutMs || 3000)
    ]);
  }

  /**
   * 整页截图
   * @param {object} hooks
   * @param {(current:number, total:number)=>void} hooks.onProgress
   * @param {()=>Promise<void>} hooks.beforeFrame 每帧截图前（用来隐藏 HUD）
   * @param {()=>Promise<void>} hooks.afterFrame  每帧截图后
   * @param {()=>boolean} hooks.isCancelled
   */
  async function grabFullPage(hooks) {
    hooks = hooks || {};
    var onProgress = hooks.onProgress || function () {};
    var beforeFrame = hooks.beforeFrame || async function () {};
    var afterFrame = hooks.afterFrame || async function () {};
    var isCancelled = hooks.isCancelled || function () { return false; };

    var docEl = document.documentElement;
    var body = document.body;

    // ---------- 准备工作 ----------
    var hideScrollbarStyle = document.createElement('style');
    hideScrollbarStyle.textContent =
      '::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}';
    (document.head || docEl).appendChild(hideScrollbarStyle);

    var prevBehavior = docEl.style.scrollBehavior;
    docEl.style.scrollBehavior = 'auto';

    var startX = window.scrollX;
    var startY = window.scrollY;

    var vh = window.innerHeight;
    var vw = docEl.clientWidth || window.innerWidth;
    var pageH = Math.max(vh, docEl.scrollHeight, body ? body.scrollHeight : 0);

    // 暂时隐藏 position:fixed 的元素，避免它们在每一屏重复出现
    var hiddenEls = [];
    try {
      var all = body ? body.getElementsByTagName('*') : [];
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'META') continue;
        var cs = window.getComputedStyle(el);
        if (cs.position === 'fixed' && cs.display !== 'none' && cs.visibility !== 'hidden') {
          hiddenEls.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      }
    } catch (e) {
      /* 某些页面可能访问受限，忽略 */
    }

    function restorePage() {
      for (var k = 0; k < hiddenEls.length; k++) {
        var item = hiddenEls[k];
        if (item[1]) item[0].style.setProperty('visibility', item[1], item[2] || '');
        else item[0].style.removeProperty('visibility');
      }
      hiddenEls.length = 0;
      hideScrollbarStyle.remove();
      docEl.style.scrollBehavior = prevBehavior;
      try {
        window.scrollTo(startX, startY);
      } catch (e) {
        /* ignore */
      }
    }

    try {
      await waitForImages(3500);
      await nextFrame();

      // 重新测量（隐藏滚动条后 clientWidth 可能变化）
      vw = docEl.clientWidth || window.innerWidth;
      pageH = Math.max(vh, docEl.scrollHeight, body ? body.scrollHeight : 0);

      var total = Math.max(1, Math.ceil(pageH / vh));
      var tiles = [];
      var y = 0;
      var guard = 0;
      var lastY = null;
      var stalled = false;

      while (guard < MAX_TILES && !isCancelled()) {
        guard++;
        window.scrollTo(0, y);
        await nextFrame();
        await nextFrame();
        await sleep(140);

        var actualY = window.scrollY || window.pageYOffset || 0;
        // 页面滚动不了（例如内部滚动容器），不要死循环
        if (lastY !== null && Math.abs(actualY - lastY) < 2) {
          stalled = true;
          break;
        }
        lastY = actualY;

        onProgress(tiles.length + 1, total);

        await beforeFrame();
        await sleep(60);
        var dataUrl = await captureVisible('png');
        await afterFrame();

        tiles.push({ dataUrl: dataUrl, y: actualY });

        if (actualY + vh >= pageH - 2) break;
        y = actualY + vh;
        // captureVisibleTab 有频率限制（约 2 次/秒）
        await sleep(520);
      }

      if (!tiles.length) throw new Error('没有截取到任何画面');

      // ---------- 拼接 ----------
      var first = await loadBitmap(tiles[0].dataUrl);
      var scale = (first.naturalWidth || first.width) / Math.max(1, window.innerWidth);
      if (typeof first.close === 'function') first.close();

      var outW = Math.max(1, Math.round(vw * scale));
      var outH = Math.max(1, Math.round(pageH * scale));

      var k = 1;
      if (outH > MAX_CANVAS_DIM) k = MAX_CANVAS_DIM / outH;
      if (outW * outH * k * k > MAX_CANVAS_PIXELS) {
        k = Math.min(k, Math.sqrt(MAX_CANVAS_PIXELS / (outW * outH)));
      }
      k = Math.max(0.05, Math.min(1, k));

      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(outW * k));
      canvas.height = Math.max(1, Math.round(outH * k));

      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(k, k);

      for (var t = 0; t < tiles.length; t++) {
        var bmp = await loadBitmap(tiles[t].dataUrl);
        var bw = bmp.naturalWidth || bmp.width;
        var bh = bmp.naturalHeight || bmp.height;
        var drawW = Math.min(bw, Math.round(vw * scale));
        var drawH = Math.min(bh, Math.round(vh * scale));
        ctx.drawImage(
          bmp,
          0,
          0,
          drawW,
          drawH,
          0,
          Math.round(tiles[t].y * scale),
          drawW,
          drawH
        );
        if (typeof bmp.close === 'function') bmp.close();
        tiles[t].dataUrl = null;
      }

      var outUrl;
      if (k < 1) {
        // 已经缩放过的长页面用 JPEG，体积可控
        outUrl = canvas.toDataURL('image/jpeg', 0.92);
      } else {
        outUrl = canvas.toDataURL('image/png');
        if (outUrl.length > 4500000) {
          outUrl = canvas.toDataURL('image/jpeg', 0.92);
        }
      }

      // 释放画布内存
      canvas.width = 0;
      canvas.height = 0;

      return {
        dataUrl: outUrl,
        tiles: tiles.length,
        truncated: guard >= MAX_TILES && tiles[tiles.length - 1].y + vh < pageH - 2,
        stalled: stalled && tiles.length <= 1 && pageH > vh + 4,
        scaled: k < 1,
        pageWidth: vw,
        pageHeight: pageH
      };
    } finally {
      restorePage();
    }
  }

  /**
   * 按视口坐标裁剪当前可视区域截图
   * @param {{x:number,y:number,w:number,h:number}} rect CSS 像素、相对视口
   */
  async function cropViewportRect(rect) {
    var dataUrl = await captureVisible('png');
    var img = await loadImage(dataUrl);

    var scaleX = img.naturalWidth / Math.max(1, window.innerWidth);
    var scaleY = img.naturalHeight / Math.max(1, window.innerHeight);

    var sx = Math.max(0, Math.round(rect.x * scaleX));
    var sy = Math.max(0, Math.round(rect.y * scaleY));
    var sw = Math.max(1, Math.round(rect.w * scaleX));
    var sh = Math.max(1, Math.round(rect.h * scaleY));

    sw = Math.min(sw, img.naturalWidth - sx);
    sh = Math.min(sh, img.naturalHeight - sy);

    var canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    return canvas.toDataURL('image/png');
  }

  /**
   * 区域选择：在 overlay 元素上绘制遮罩，返回 Promise<rect|null>
   */
  function selectRegion(overlay) {
    return new Promise(function (resolve) {
      var finished = false;
      var dragging = false;
      var startX = 0;
      var startY = 0;
      var rect = null;

      overlay.innerHTML =
        '<div class="dsf-region-box" hidden></div>' +
        '<div class="dsf-region-toolbar" hidden>' +
        '<button type="button" data-region="ok">✓ 截取</button>' +
        '<button type="button" data-region="redo">重选</button>' +
        '<button type="button" data-region="cancel">取消</button>' +
        '</div>' +
        '<div class="dsf-region-tip">按住鼠标左键拖动选择区域 · Esc 取消</div>';

      var box = overlay.querySelector('.dsf-region-box');
      var toolbar = overlay.querySelector('.dsf-region-toolbar');

      overlay.hidden = false;

      function cleanup(result) {
        if (finished) return;
        finished = true;
        window.removeEventListener('keydown', onKey, true);
        overlay.hidden = true;
        overlay.innerHTML = '';
        document.documentElement.style.cursor = '';
        resolve(result);
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cleanup(null);
        }
      }

      function updateBox(x1, y1, x2, y2) {
        var left = Math.min(x1, x2);
        var top = Math.min(y1, y2);
        var w = Math.abs(x2 - x1);
        var h = Math.abs(y2 - y1);
        rect = { x: left, y: top, w: w, h: h };
        box.hidden = false;
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        box.style.width = w + 'px';
        box.style.height = h + 'px';
        box.textContent = Math.round(w) + ' × ' + Math.round(h);
      }

      function placeToolbar() {
        toolbar.hidden = false;
        var tw = toolbar.offsetWidth || 210;
        var th = toolbar.offsetHeight || 40;
        var left = Math.min(window.innerWidth - tw - 8, Math.max(8, rect.x + rect.w - tw));
        var top = rect.y + rect.h + 10;
        if (top + th > window.innerHeight - 8) top = Math.max(8, rect.y - th - 10);
        toolbar.style.left = left + 'px';
        toolbar.style.top = top + 'px';
      }

      overlay.addEventListener(
        'pointerdown',
        function (e) {
          if (e.button !== 0) return;
          if (e.target.closest && e.target.closest('.dsf-region-toolbar')) return;
          dragging = true;
          startX = e.clientX;
          startY = e.clientY;
          toolbar.hidden = true;
          box.hidden = false;
          box.textContent = '';
          updateBox(startX, startY, startX, startY);
          try {
            overlay.setPointerCapture(e.pointerId);
          } catch (err) {
            /* ignore */
          }
          e.preventDefault();
          e.stopPropagation();
        },
        true
      );

      overlay.addEventListener(
        'pointermove',
        function (e) {
          if (!dragging) return;
          updateBox(startX, startY, e.clientX, e.clientY);
          e.preventDefault();
        },
        true
      );

      overlay.addEventListener(
        'pointerup',
        function (e) {
          if (!dragging) return;
          dragging = false;
          updateBox(startX, startY, e.clientX, e.clientY);
          if (rect && rect.w > 4 && rect.h > 4) placeToolbar();
          else {
            box.hidden = true;
            rect = null;
          }
          e.preventDefault();
        },
        true
      );

      toolbar.addEventListener(
        'click',
        function (e) {
          var btn = e.target.closest ? e.target.closest('[data-region]') : null;
          if (!btn) return;
          var action = btn.getAttribute('data-region');
          if (action === 'ok') {
            if (!rect) return;
            cleanup(rect);
          } else if (action === 'redo') {
            rect = null;
            box.hidden = true;
            toolbar.hidden = true;
          } else {
            cleanup(null);
          }
          e.preventDefault();
          e.stopPropagation();
        },
        true
      );

      window.addEventListener('keydown', onKey, true);
    });
  }

  window.DSShot = {
    captureVisible: captureVisible,
    grabFullPage: grabFullPage,
    cropViewportRect: cropViewportRect,
    selectRegion: selectRegion,
    loadImage: loadImage,
    MAX_TILES: MAX_TILES
  };
})();
