// dsh-file-drop — 拖入文件到对话（DSH Desktop 配套插件）
//
// 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）：
//   · 对话区域 dragover/drop 拦截（阻止浏览器打开文件）；
//   · 文本/代码文件 → 读取内容注入输入框（体积上限 TEXT_MAX_BYTES 内）；
//   · 图片 / 二进制 / 超大文件 → 注入路径提示文本，让 agent 用
//     inspect_image（dsh-tool-vision）或文件工具直接处理；
//   · 注入用 React 受控 textarea 的 native setter + input 事件（官方输入
//     框是 textarea，见 dsh-client-ui-conversation）。
//
// 纯逻辑挂在 window.__dshFileDropCore 上（生产无副作用），供 node 测试套件
// 直接评估本文件验证 —— 官方模块加载器只支持 classic script，不能 import。
(function () {
  'use strict';

  // ───────────────────────── 纯逻辑（可测） ─────────────────────────
  var TEXT_MAX_BYTES = 256 * 1024;
  var SNIFF_BYTES = 8192;

  var TEXT_EXT = new Set([
    '.txt', '.md', '.markdown', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs',
    '.php', '.sh', '.bat', '.ps1', '.sql', '.html', '.htm', '.css', '.scss',
    '.less', '.xml', '.csv', '.tsv', '.log', '.env', '.gitignore', '.npmrc',
    '.lock', '.sum', '.properties', '.editorconfig', '.vue', '.svelte',
  ]);
  var IMAGE_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif', '.ico', '.tiff',
  ]);

  function extOf(name) {
    var dot = String(name || '').lastIndexOf('.');
    if (dot <= 0) return '';
    return String(name).slice(dot).toLowerCase();
  }

  /** 文件分类：text（内容注入）/ image（路径提示）/ binary（路径提示）。 */
  function classifyFile(name, size) {
    var ext = extOf(name);
    if (IMAGE_EXT.has(ext)) return { kind: 'image', reason: 'image' };
    if (TEXT_EXT.has(ext) || ext === '') return { kind: 'text', reason: ext === '' ? 'extensionless' : 'text' };
    return { kind: 'binary', reason: 'binary' };
  }

  /** 头部 NUL 字节嗅探：文本里出现 \0 视为二进制。 */
  function looksBinary(content) {
    var head = String(content || '').slice(0, SNIFF_BYTES);
    return head.indexOf('\u0000') !== -1;
  }

  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * 构造要注入输入框的文本。
   * 内容在 TEXT_MAX_BYTES 内 → { kind: 'text', text }；
   * 超过 → { kind: 'path-hint', text }（有 path 时给完整路径让 agent 读文件）。
   */
  function buildTextInsertion(_a) {
    var name = _a.name, content = _a.content, path = _a.path, size = _a.size;
    var text = String(content || '');
    if (text.length > TEXT_MAX_BYTES || looksBinary(text)) {
      return { kind: 'path-hint', text: buildPathHint({ name: name, path: path, size: size != null ? size : text.length }) };
    }
    return {
      kind: 'text',
      text: '<!-- 拖入文件：' + name + ' -->\n' + text,
    };
  }

  /** 图片 / 二进制 / 超大文件的路径提示（agent 按路径读取或 inspect_image）。 */
  function buildPathHint(_a) {
    var name = _a.name, path = _a.path, size = _a.size;
    var label = name || '（未命名文件）';
    var sizeText = size != null ? '，大小 ' + formatSize(size) : '';
    if (path) {
      return '[拖入文件：' + label + sizeText + ']\n完整路径：' + path + '\n请读取该文件内容后继续；图片请用 inspect_image 工具分析。';
    }
    return '[拖入文件：' + label + sizeText + ']\n（无法获取完整路径，请通过文件标签页或项目目录读取该文件。）';
  }

  // 暴露纯逻辑供测试；生产无副作用。
  if (typeof window !== 'undefined') {
    window.__dshFileDropCore = {
      TEXT_MAX_BYTES: TEXT_MAX_BYTES,
      classifyFile: classifyFile,
      looksBinary: looksBinary,
      buildTextInsertion: buildTextInsertion,
      buildPathHint: buildPathHint,
    };
  }

  // ───────────────────────── DOM 粘合 ─────────────────────────

  /** 找到当前会话的输入框（React 受控 textarea）。 */
  function findComposer() {
    var ae = typeof document !== 'undefined' ? document.activeElement : null;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return ae;
    var root = document.querySelector('[data-slot="conversation.session"]');
    var scope = root || document;
    return scope.querySelector('textarea');
  }

  /** 向 React 受控 textarea 注入文本（native setter + input 事件）。 */
  function injectIntoComposer(textarea, text) {
    if (!textarea || !text) return false;
    textarea.focus();
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    var next = (textarea.value || '') + text;
    if (!next.endsWith('\n')) next += '\n';
    setter.call(textarea, next);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  /** Electron 里取拖入文件的完整路径（webUtils.getPathForFile 经 preload 暴露）。 */
  function filePathOf(file) {
    try {
      if (file && window.dshDesktop && typeof window.dshDesktop.getPathForFile === 'function') {
        var p = window.dshDesktop.getPathForFile(file);
        return typeof p === 'string' && p ? p : '';
      }
    } catch (_e) { /* 浏览器环境无此能力 */ }
    return '';
  }

  function handleDroppedFile(file) {
    var name = file.name || '';
    var size = file.size || 0;
    var path = filePathOf(file);
    var cls = classifyFile(name, size);

    if (cls.kind === 'text') {
      var reader = new FileReader();
      reader.onload = function () {
        var out = buildTextInsertion({ name: name, content: String(reader.result || ''), path: path, size: size });
        injectIntoComposer(findComposer(), out.text);
      };
      reader.onerror = function () {
        injectIntoComposer(findComposer(), buildPathHint({ name: name, path: path, size: size }));
      };
      reader.readAsText(file);
      return;
    }

    injectIntoComposer(findComposer(), buildPathHint({ name: name, path: path, size: size }));
  }

  function hasFiles(types) {
    if (!types) return false;
    for (var i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  function attachDropHandlers() {
    if (typeof document === 'undefined') return;
    document.addEventListener('dragover', function (e) {
      if (hasFiles(e.dataTransfer && e.dataTransfer.types)) e.preventDefault();
    });
    document.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (!dt || !hasFiles(dt.types)) return;
      e.preventDefault();
      var files = dt.files;
      for (var i = 0; i < files.length; i++) {
        try { handleDroppedFile(files[i]); } catch (_e) { /* 单个文件失败不影响其余 */ }
      }
    });
  }

  // ───────────────────────── 注册 ─────────────────────────
  window.__ModuleLoader__.load({
    id: 'dsh-file-drop',
    factory: function (require) {
      var inject = [];
      function apply() {
        attachDropHandlers();
      }
      var module = { exports: {} };
      module.exports = { inject: inject, apply: apply };
      return module.exports;
    },
  });
})();