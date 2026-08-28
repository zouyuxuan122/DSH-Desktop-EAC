// dsh-file-drop-eac — 拖入文件/文件夹到对话（Deepseek Harness EAC 特化版）
//
// 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）：
//   · 对话区域 dragover/drop 拦截（阻止浏览器直接打开文件）；
//   · 文本/代码文件 → 读取内容注入输入框（体积上限 TEXT_MAX_BYTES 内）；
//   · 二进制 / 超大文件 → 注入完整路径提示，让 agent 用文件工具直接读取；
//   · 图片 → 完全不接管（区别于已弃用的 dsh-file-drop）：不注入任何内容，
//     交给视觉桥 / 原生缩略图处理，避免重复注入冲突；
//   · 文件夹 → 新增接管：识别拖入的是文件夹并给出可操作降级提示。
//     浏览器/Electron 出于安全限制无法把文件夹的磁盘绝对路径交给页面
//     （webUtils.getPathForFile 只接受 File，文件夹是 webkitGetAsEntry()
//     返回的目录条目，仅有虚拟路径），故提示用户改用文件/项目目录方式。
//   · 注入用 React 受控 textarea 的 native setter + input 事件（官方输入
//     框是 textarea，见 dsh-client-ui-conversation）。
//
// 纯逻辑挂在 window.__dshFileDropEacCore 上（生产无副作用），供 node 测试
// 套件直接评估本文件验证 —— 官方模块加载器只支持 classic script，不能 import。
(function () {
  'use strict';

  // ───────────────────────── 纯逻辑（可测） ─────────────────────────
  var TEXT_MAX_BYTES = 256 * 1024;
  var SNIFF_BYTES = 8192;

  var TEXT_EXT = new Set([
    '.txt', '.md', '.markdown', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs',
    '.php', '.sh', '.bat', '.ps1', '.html', '.htm', '.css', '.scss',
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

  /**
   * 文件分类：text（内容注入）/ image（本插件不接管，标记跳过分发给
   * 视觉桥）/ binary（路径提示）。
   */
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

  /** 二进制 / 超大文件的路径提示（agent 按路径读取）。 */
  function buildPathHint(_a) {
    var name = _a.name, path = _a.path, size = _a.size;
    var label = name || '（未命名文件）';
    var sizeText = size != null ? '，大小 ' + formatSize(size) : '';
    if (path) {
      return '[拖入文件：' + label + sizeText + ']\n完整路径：' + path + '\n请读取该文件内容后继续处理。';
    }
    return '[拖入文件：' + label + sizeText + ']\n（无法获取完整路径，请通过文件标签页或项目目录读取该文件。）';
  }

  /** 文件夹降级提示：浏览器/Electron 拿不到磁盘绝对路径，给出替代方案。 */
  function buildFolderHint(folders) {
    var list = (folders || []).map(function (f) {
      var v = f && f.virtualPath && f.virtualPath !== '/' ? '（' + f.virtualPath + '）' : '';
      return '  · ' + (f && f.name || '（未命名目录）') + v;
    }).join('\n');
    return [
      '[拖入文件夹：' + (folders ? folders.length : 0) + ' 个]',
      list,
      '',
      '说明：网页 / Electron 出于安全限制，无法读取文件夹的磁盘绝对路径，不能把整个目录直接交给模型。',
      '请改用以下任一方式：',
      '  · 在「文件 / 项目目录」标签打开该目录，让 agent 读取其中的文件；',
      '  · 把关键文件逐一拖入本输入框。',
      ''
    ].join('\n');
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

  /**
   * 解析 DataTransferItem 列表：目录项进 folders，其余取 File 进 files。
   * 标准接口为 getAsEntry()，Chromium/Electron 用 webkitGetAsEntry() 前缀，
   * 两者兼容。目录项只有虚拟路径（entry.name / entry.fullPath），无绝对路径。
   */
  function collectEntries(items) {
    var out = { files: [], folders: [] };
    if (!items) return out;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      var entry = null;
      if (typeof it.webkitGetAsEntry === 'function') entry = it.webkitGetAsEntry();
      else if (typeof it.getAsEntry === 'function') entry = it.getAsEntry();
      if (entry && entry.isDirectory) {
        out.folders.push({ name: entry.name || '', virtualPath: entry.fullPath || '' });
        continue;
      }
      if (typeof it.getAsFile === 'function') {
        var f = it.getAsFile();
        if (f) out.files.push(f);
      }
    }
    return out;
  }

  /**
   * 把拖入内容编排成执行计划（纯逻辑，可测）：
   *   folders  → 需要弹出文件夹降级提示的目录列表；
   *   texts    → 内容注入列表（文本/代码）；
   *   hints    → 路径提示列表（二进制/超大）；
   *   skipped  → 图片列表（本插件不接管，交给视觉桥）。
   */
  function planDrop(files, folders) {
    var plan = { folders: (folders || []).slice(), texts: [], hints: [], skipped: [] };
    if (!files) return plan;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f) continue;
      var name = f.name || '';
      var size = f.size || 0;
      var path = filePathOf(f);
      var cls = classifyFile(name, size);
      if (cls.kind === 'image') { plan.skipped.push(name); continue; }
      var rec = { file: f, name: name, size: size, path: path };
      if (cls.kind === 'text') plan.texts.push(rec);
      else plan.hints.push(rec);
    }
    return plan;
  }

  // 暴露纯逻辑供测试；生产无副作用。
  if (typeof window !== 'undefined') {
    window.__dshFileDropEacCore = {
      TEXT_MAX_BYTES: TEXT_MAX_BYTES,
      SNIFF_BYTES: SNIFF_BYTES,
      TEXT_EXT: TEXT_EXT,
      IMAGE_EXT: IMAGE_EXT,
      classifyFile: classifyFile,
      looksBinary: looksBinary,
      formatSize: formatSize,
      buildTextInsertion: buildTextInsertion,
      buildPathHint: buildPathHint,
      buildFolderHint: buildFolderHint,
      filePathOf: filePathOf,
      collectEntries: collectEntries,
      planDrop: planDrop,
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

  /** 二进制/超大文件：经 fileDrop.save 落盘到临时目录拿真实路径（HTML5 拖拽在
   * 页面拿不到磁盘路径），失败则降级为无路径提示。 */
  function injectHintWithPath(rec) {
    var fallback = function () {
      injectIntoComposer(findComposer(), buildPathHint({ name: rec.name, path: '', size: rec.size }));
    };
    var b = typeof window !== 'undefined' && window.dshDesktop && window.dshDesktop.fileDrop;
    if (!b || typeof b.save !== 'function' || !rec.file || rec.size > 64 * 1024 * 1024) {
      fallback();
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      b.save({ dataUrl: String(reader.result || ''), name: rec.name || '拖入文件' })
        .then(function (res) {
          if (res && res.ok) {
            injectIntoComposer(findComposer(), buildPathHint({ name: rec.name, path: res.path, size: res.size != null ? res.size : rec.size }));
          } else {
            fallback();
          }
        })
        .catch(fallback);
    };
    reader.onerror = fallback;
    reader.readAsDataURL(rec.file);
  }

  /** 按计划执行：先文件夹降级提示，再文本内容注入，再路径提示。 */
  function handlePlan(plan) {
    if (plan.folders && plan.folders.length) {
      injectIntoComposer(findComposer(), buildFolderHint(plan.folders));
    }
    plan.texts.forEach(function (rec) {
      var reader = new FileReader();
      reader.onload = function () {
        var out = buildTextInsertion({ name: rec.name, content: String(reader.result || ''), path: rec.path, size: rec.size });
        injectIntoComposer(findComposer(), out.text);
      };
      reader.onerror = function () {
        injectIntoComposer(findComposer(), buildPathHint({ name: rec.name, path: rec.path, size: rec.size }));
      };
      reader.readAsText(rec.file);
    });
    plan.hints.forEach(function (rec) {
      injectHintWithPath(rec);
    });
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
      // 即便全是图片/文件夹也要阻止浏览器默认打开文件。
      e.preventDefault();
      var collected = collectEntries(dt.items);
      var files = collected.files;
      var folders = collected.folders;
      // 兜底：个别实现 items 解析不到时回退 dt.files。
      if (files.length === 0 && folders.length === 0 && dt.files && dt.files.length) {
        files = Array.prototype.slice.call(dt.files);
      }
      handlePlan(planDrop(files, folders));
    });
  }

  // ───────────────────────── 注册 ─────────────────────────
  window.__ModuleLoader__.load({
    id: 'dsh-file-drop-eac',
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
