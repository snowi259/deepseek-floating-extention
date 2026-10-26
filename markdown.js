/**
 * markdown.js — 轻量 Markdown + LaTeX 渲染器（零依赖，全部在本地运行）
 *
 * 支持：
 *   - 标题、段落、引用、无序/有序列表、分割线、表格、围栏代码块
 *   - 行内代码、粗体、斜体、删除线、链接
 *   - 数学公式：$$...$$ / \[...\] / \(...\) / $...$
 *     （自研的小型 LaTeX 子集渲染：分式、根式、上下标、希腊字母、常用运算符、
 *       矩阵/cases 环境等；不是完整 KaTeX，复杂宏会以原始文本形式显示）
 *
 * 所有 HTML 都经过转义，输出可信赖。
 */
(function () {
  'use strict';
  if (window.DSMarkdown) return;

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ESC_MAP[c];
    });
  }

  function escapeAttr(s) {
    return esc(s);
  }

  /* ================================================================ */
  /* LaTeX 子集渲染                                                    */
  /* ================================================================ */

  var SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
    rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
    phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',

    times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆',
    circ: '∘', bullet: '•', oplus: '⊕', otimes: '⊗', odot: '⊙',

    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', equiv: '≡',
    approx: '≈', sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫',
    lt: '<', gt: '>',

    to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
    leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦', uparrow: '↑',
    downarrow: '↓', longrightarrow: '⟶', Longrightarrow: '⟹',

    infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏',
    int: '∫', iint: '∬', iiint: '∭', oint: '∮',

    cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',

    angle: '∠', triangle: '△', square: '□', perp: '⊥', parallel: '∥',
    because: '∵', therefore: '∴',

    in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃',
    supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',

    forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨', mid: '∣',
    prime: '′', degree: '°', aleph: 'ℵ',

    lbrace: '{', rbrace: '}', langle: '⟨', rangle: '⟩', lfloor: '⌊',
    rfloor: '⌋', lceil: '⌈', rceil: '⌉', vert: '|', Vert: '‖',

    quad: ' ', qquad: '  ',
    ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ',
    '%': '%', '$': '$', '&': '&', '#': '#', '_': '_', '{': '{', '}': '}'
  };

  var FUNCS = [
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'lim', 'max',
    'min', 'sup', 'inf', 'det', 'gcd', 'deg', 'dim', 'arg', 'ker', 'mod'
  ];

  /** 拆分顶层（不在 {} 内）的分隔符 */
  function splitTop(src, isRowDelim) {
    var parts = [];
    var depth = 0;
    var start = 0;
    for (var i = 0; i < src.length; i++) {
      var ch = src[i];
      if (ch === '\\') {
        if (isRowDelim && src[i + 1] === '\\') {
          if (depth === 0) {
            parts.push(src.slice(start, i));
            i++;
            start = i + 1;
          } else {
            i++;
          }
          continue;
        }
        i++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
      else if (!isRowDelim && ch === '&' && depth === 0) {
        parts.push(src.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(src.slice(start));
    return parts;
  }

  function texToHtml(src) {
    var i = 0;
    var s = String(src == null ? '' : src);

    function skipSpace() {
      while (i < s.length && /\s/.test(s[i])) i++;
    }

    function readGroupRaw() {
      skipSpace();
      if (s[i] !== '{') {
        var ch = s[i] || '';
        i++;
        return ch;
      }
      var depth = 0;
      var start = i + 1;
      i++;
      depth = 1;
      while (i < s.length) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) {
            var out = s.slice(start, i);
            i++;
            return out;
          }
        }
        i++;
      }
      return s.slice(start);
    }

    function atom(ch) {
      if (/[a-zA-Z]/.test(ch)) return '<span class="md-var">' + ch + '</span>';
      if (/[0-9]/.test(ch)) return '<span class="md-num">' + ch + '</span>';
      if (ch === '-') return '<span class="md-op">−</span>';
      if (ch === '*') return '<span class="md-op">∗</span>';
      if (ch === "'") return '<span class="md-op">′</span>';
      if (ch === '.') return '.';
      return '<span class="md-op">' + esc(ch) + '</span>';
    }

    function renderEnv(env, raw) {
      if (/matrix|array|cases|aligned|align|gathered/i.test(env)) {
        var rows = splitTop(raw, true);
        var cells = rows.map(function (r) {
          return splitTop(r, false).map(function (c) {
            return texToHtml(c);
          });
        });
        var html = '<span class="md-matrix-wrap">';
        if (/cases/i.test(env)) html += '<span class="md-case-brace">{</span>';
        if (/vmatrix/i.test(env)) html += '<span class="md-case-brace">|</span>';
        html += '<span class="md-matrix">';
        for (var r = 0; r < cells.length; r++) {
          html += '<span class="md-mrow">';
          for (var c = 0; c < cells[r].length; c++) {
            html += '<span class="md-mcell">' + cells[r][c] + '</span>';
          }
          html += '</span>';
        }
        html += '</span>';
        if (/vmatrix/i.test(env)) html += '<span class="md-case-brace">|</span>';
        html += '</span>';
        return html;
      }
      return '<span class="md-text">' + esc(raw) + '</span>';
    }

    function readCommand() {
      i++; // 跳过反斜杠
      var name = '';
      if (i < s.length && /[a-zA-Z]/.test(s[i])) {
        while (i < s.length && /[a-zA-Z]/.test(s[i])) {
          name += s[i];
          i++;
        }
      } else {
        name = s[i] || '';
        i++;
      }

      if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
        var num = readArg();
        var den = readArg();
        return (
          '<span class="md-frac"><span class="md-fnum">' + num +
          '</span><span class="md-fden">' + den + '</span></span>'
        );
      }

      if (name === 'sqrt') {
        skipSpace();
        var index = '';
        if (s[i] === '[') {
          var close = s.indexOf(']', i);
          if (close > -1) {
            index = s.slice(i + 1, close);
            i = close + 1;
          }
        }
        var body = readArg();
        return (
          '<span class="md-sqrt">' +
          (index ? '<span class="md-root">' + texToHtml(index) + '</span>' : '') +
          '<span class="md-radical">√</span><span class="md-radicand">' + body + '</span></span>'
        );
      }

      if (name === 'text' || name === 'textrm' || name === 'mathrm' || name === 'operatorname' || name === 'mbox') {
        return '<span class="md-text">' + esc(readGroupRaw()) + '</span>';
      }
      if (name === 'mathbf' || name === 'textbf' || name === 'boldsymbol') {
        return '<span class="md-text md-bold">' + esc(readGroupRaw()) + '</span>';
      }
      if (name === 'mathit' || name === 'textit') {
        return '<span class="md-text md-italic">' + esc(readGroupRaw()) + '</span>';
      }

      if (name === 'left' || name === 'right' || name === 'middle') {
        skipSpace();
        if (s[i] === '\\') {
          var d1 = readCommand();
          return name === 'middle' ? '' : '<span class="md-delim">' + d1 + '</span>';
        }
        var d = s[i];
        i++;
        if (!d || d === '.') return '';
        if (name === 'middle') return '<span class="md-delim">' + esc(d) + '</span>';
        return '<span class="md-delim">' + esc(d) + '</span>';
      }

      if (name === 'begin') {
        var env = readGroupRaw();
        var endTag = '\\end{' + env + '}';
        var closeIdx = s.indexOf(endTag, i);
        var raw = closeIdx === -1 ? s.slice(i) : s.slice(i, closeIdx);
        i = closeIdx === -1 ? s.length : closeIdx + endTag.length;
        return renderEnv(env, raw);
      }
      if (name === 'end') {
        var skip = readGroupRaw();
        return '';
      }

      if (name === 'limits' || name === 'nolimits' || name === 'displaystyle' || name === 'textstyle') {
        return '';
      }

      if (FUNCS.indexOf(name) !== -1) {
        return '<span class="md-func">' + name + '</span>';
      }

      if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) {
        var sym = SYMBOLS[name];
        if (sym === ' ') return '&nbsp;';
        if (sym === '') return '';
        return '<span class="md-sym">' + esc(sym) + '</span>';
      }

      if (name.length === 1 && '{}%$#&_'.indexOf(name) !== -1) return esc(name);

      return '<span class="md-unknown">\\' + esc(name) + '</span>';
    }

    function readArg() {
      skipSpace();
      if (i >= s.length) return '';
      if (s[i] === '{') {
        i++;
        return parseSeq(true);
      }
      if (s[i] === '\\') return readCommand();
      var ch = s[i];
      i++;
      return atom(ch);
    }

    function parseSeq(stopAtBrace) {
      var out = '';
      while (i < s.length) {
        var ch = s[i];

        if (ch === '}') {
          i++;
          if (stopAtBrace) break;
          continue;
        }
        if (ch === '{') {
          i++;
          out += parseSeq(true);
          continue;
        }
        if (ch === '\\') {
          out += readCommand();
          continue;
        }
        if (ch === '^') {
          i++;
          out += '<sup>' + readArg() + '</sup>';
          continue;
        }
        if (ch === '_') {
          i++;
          out += '<sub>' + readArg() + '</sub>';
          continue;
        }
        if (ch === '&') {
          i++;
          out += '<span class="md-op">&amp;</span>';
          continue;
        }
        if (ch === '~') {
          i++;
          out += '&nbsp;';
          continue;
        }
        if (/\s/.test(ch)) {
          i++;
          continue;
        }
        out += atom(ch);
        i++;
      }
      return out;
    }

    return parseSeq(false);
  }

  /* ================================================================ */
  /* Markdown                                                          */
  /* ================================================================ */

  function renderMarkdown(source) {
    var store = [];
    var text = String(source == null ? '' : source);

    // 1) 围栏代码块
    text = text.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, function (m, lang, code) {
      var language = String(lang || '').trim().split(/\s+/)[0];
      var label = language ? '<span class="md-code-lang">' + esc(language) + '</span>' : '';
      var body =
        '<pre class="md-pre">' + label + '<code>' + esc(code.replace(/\n$/, '')) + '</code></pre>';
      return stash(store, body);
    });
    text = text.replace(/~~~([^\n~]*)\n?([\s\S]*?)(?:~~~|$)/g, function (m, lang, code) {
      return stash(store, '<pre class="md-pre"><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
    });

    // 2) 行内代码
    text = text.replace(/`([^`\n]+)`/g, function (m, code) {
      return stash(store, '<code class="md-code">' + esc(code) + '</code>');
    });

    // 3) 数学公式（在转义前处理，直接使用原始 LaTeX）
    text = protectMath(text, store);

    // 4) 转义
    text = esc(text);

    // 5) 块级
    var html = renderBlocks(text);

    // 6) 还原占位符
    return html.replace(/\u0000(\d+)\u0000/g, function (m, idx) {
      var v = store[Number(idx)];
      return v == null ? '' : v;
    });
  }

  function stash(store, html) {
    store.push(html);
    return '\u0000' + (store.length - 1) + '\u0000';
  }

  function protectMath(text, store) {
    // 块级 $$...$$
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, function (m, tex) {
      return stash(store, '<span class="md-math md-math-display">' + texToHtml(tex) + '</span>');
    });
    // \[...\]
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, function (m, tex) {
      return stash(store, '<span class="md-math md-math-display">' + texToHtml(tex) + '</span>');
    });
    // \(...\)
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, function (m, tex) {
      return stash(store, '<span class="md-math">' + texToHtml(tex) + '</span>');
    });
    // 行内 $...$
    text = text.replace(/(^|[^\\$])\$(?!\s)([^\n$]{1,300}?)(?<!\s)\$(?!\d)/g, function (m, prefix, tex) {
      // 避免把「$100」这类金额当成公式
      if (!/[\\^_=<>]|[{}]/.test(tex)) return m;
      return prefix + stash(store, '<span class="md-math">' + texToHtml(tex) + '</span>');
    });
    return text;
  }

  function inlineFormat(s) {
    // 链接
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      var safe = /^(https?:|mailto:)/i.test(url) ? url : '#';
      if (safe === '#') return label;
      return '<a href="' + escapeAttr(safe) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    // 粗斜体 / 粗体 / 斜体 / 删除线
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|\W)__([^_\n]+)__/g, '$1<strong>$2</strong>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s;
  }

  function renderBlocks(text) {
    var lines = text.split('\n');
    var out = [];
    var para = [];
    var i = 0;

    function flush() {
      if (para.length) {
        out.push('<p>' + inlineFormat(para.join('<br>')) + '</p>');
        para = [];
      }
    }

    while (i < lines.length) {
      var line = lines[i];

      if (/^\s*$/.test(line)) {
        flush();
        i++;
        continue;
      }

      // 独立成行的占位符（代码块 / 公式块）
      if (/^\s*\u0000\d+\u0000\s*$/.test(line)) {
        flush();
        out.push(line.trim());
        i++;
        continue;
      }

      // 标题
      var h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        flush();
        var level = Math.min(6, h[1].length + 2); // h1 → h3（面板内不要太大）
        out.push('<h' + level + '>' + inlineFormat(h[2]) + '</h' + level + '>');
        i++;
        continue;
      }

      // 分割线
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flush();
        out.push('<hr>');
        i++;
        continue;
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        flush();
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + renderBlocks(quote.join('\n')) + '</blockquote>');
        continue;
      }

      // 表格
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
        flush();
        var header = splitTableRow(line);
        i += 2;
        var body = [];
        while (i < lines.length && lines[i].indexOf('|') !== -1 && !/^\s*$/.test(lines[i])) {
          body.push(splitTableRow(lines[i]));
          i++;
        }
        var table = '<div class="md-table-wrap"><table><thead><tr>';
        header.forEach(function (cell) {
          table += '<th>' + inlineFormat(cell) + '</th>';
        });
        table += '</tr></thead><tbody>';
        body.forEach(function (row) {
          table += '<tr>';
          for (var c = 0; c < header.length; c++) {
            table += '<td>' + inlineFormat(row[c] == null ? '' : row[c]) + '</td>';
          }
          table += '</tr>';
        });
        table += '</tbody></table></div>';
        out.push(table);
        continue;
      }

      // 列表
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        flush();
        var res = parseList(lines, i);
        out.push(res.html);
        i = res.next;
        continue;
      }

      para.push(line);
      i++;
    }

    flush();
    return out.join('\n');
  }

  function splitTableRow(line) {
    var s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map(function (c) {
      return c.trim();
    });
  }

  function parseList(lines, start) {
    var items = [];
    var ordered = /^\s*\d+[.)]\s+/.test(lines[start]);
    var i = start;

    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) {
        // 空行：如果后面还是列表项就继续
        var j = i + 1;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        if (j < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[j])) {
          i = j;
          continue;
        }
        break;
      }
      var m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (m) {
        items.push({ indent: m[1].length, text: m[3], children: [] });
        i++;
        continue;
      }
      // 续行
      if (items.length && /^\s+\S/.test(line)) {
        items[items.length - 1].text += ' ' + line.trim();
        i++;
        continue;
      }
      if (items.length && !/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        // 普通段落，结束列表
        break;
      }
      break;
    }

    var tag = ordered ? 'ol' : 'ul';
    var html = '<' + tag + '>';
    for (var k = 0; k < items.length; k++) {
      html += '<li>' + inlineFormat(items[k].text) + '</li>';
    }
    html += '</' + tag + '>';
    return { html: html, next: i };
  }

  window.DSMarkdown = {
    render: renderMarkdown,
    escapeHtml: esc,
    renderTex: function (tex) {
      return texToHtml(tex);
    }
  };
})();
