/**
 * image.js — 本地图片处理
 *
 * 全部在浏览器本地完成：不经过任何服务器。负责校验格式、压缩尺寸，
 * 保证 base64 体积不会把 API 请求撑爆。
 */
(function () {
  'use strict';
  if (window.DSImage) return;

  var ACCEPT = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  var MAX_FILE_BYTES = 25 * 1024 * 1024; // 单个文件 25MB
  var MAX_WIDTH = 1600; // 宽度上限（整页截图靠像素总量再限制）
  var MAX_PIXELS = 4000000; // 总像素上限，约 4MP
  var MAX_CHARS = 2800000; // dataURL 字符数上限（约 2MB 二进制）

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ''));
      };
      reader.onerror = function () {
        reject(new Error('读取本地文件失败'));
      };
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error('图片格式不受支持或文件已损坏'));
      };
      img.src = src;
    });
  }

  function mimeOf(dataUrl) {
    var m = /^data:([^;,]+)/i.exec(String(dataUrl || ''));
    return m ? m[1].toLowerCase() : 'image/png';
  }

  function byteSize(dataUrl) {
    var comma = String(dataUrl).indexOf(',');
    var b64 = comma === -1 ? '' : String(dataUrl).slice(comma + 1);
    return Math.round((b64.length * 3) / 4);
  }

  function drawToDataUrl(img, width, height, type, quality) {
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    var ctx = canvas.getContext('2d');
    // 缩小图片时保留一点锐度，截图里的文字更清晰
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(type, quality);
  }

  /**
   * 压缩 / 缩放图片，返回 { dataUrl, width, height, bytes, mime }
   */
  async function normalize(dataUrl, options) {
    var opts = options || {};
    var maxWidth = opts.maxWidth || MAX_WIDTH;
    var maxPixels = opts.maxPixels || MAX_PIXELS;
    var maxChars = opts.maxChars || MAX_CHARS;

    var img = await loadImage(dataUrl);
    var width = img.naturalWidth || img.width;
    var height = img.naturalHeight || img.height;
    var mime = mimeOf(dataUrl);

    var scale = Math.min(
      1,
      maxWidth / Math.max(1, width),
      Math.sqrt(maxPixels / Math.max(1, width * height))
    );
    var needResize = scale < 0.995;
    var out = dataUrl;

    if (needResize || out.length > maxChars) {
      var preferPng = mime === 'image/png';
      var attempt = 0;
      while (attempt < 5) {
        var w = Math.max(1, Math.round(width * scale));
        var h = Math.max(1, Math.round(height * scale));

        if (preferPng) {
          var png = drawToDataUrl(img, w, h, 'image/png');
          if (png.length <= maxChars) {
            out = png;
            break;
          }
          // PNG 太大，改用 JPEG
          preferPng = false;
        }
        var quality = Math.max(0.55, 0.92 - attempt * 0.1);
        var jpg = drawToDataUrl(img, w, h, 'image/jpeg', quality);
        out = jpg;
        if (jpg.length <= maxChars) break;
        scale *= 0.8;
        attempt++;
      }
    }

    var finalImg = await loadImage(out);
    return {
      dataUrl: out,
      width: finalImg.naturalWidth || finalImg.width,
      height: finalImg.naturalHeight || finalImg.height,
      bytes: byteSize(out),
      mime: mimeOf(out)
    };
  }

  /**
   * 从本地文件生成待发送图片
   */
  async function fromFile(file) {
    if (!file) throw new Error('没有选择文件');
    var type = String(file.type || '').toLowerCase();
    if (ACCEPT.indexOf(type) === -1) {
      throw new Error('只支持 PNG / JPG / JPEG / WEBP 格式：' + (file.name || ''));
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Error('文件太大（超过 25MB）：' + (file.name || ''));
    }
    var dataUrl = await readAsDataUrl(file);
    var result = await normalize(dataUrl);
    result.name = file.name || '图片';
    return result;
  }

  /**
   * 从截图 dataURL 生成待发送图片（截图通常已经是 PNG）
   */
  async function fromDataUrl(dataUrl, name) {
    var result = await normalize(dataUrl);
    result.name = name || '截图';
    return result;
  }

  window.DSImage = {
    fromFile: fromFile,
    fromDataUrl: fromDataUrl,
    normalize: normalize,
    loadImage: loadImage,
    byteSize: byteSize,
    MAX_WIDTH: MAX_WIDTH,
    MAX_PIXELS: MAX_PIXELS
  };
})();
