// dsh-image-paste — 图片粘贴发送（DSH Desktop 配套插件）
//
// 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）：
//   · 监听对话页面的 paste 事件，从 clipboardData.items 提取图片文件
//     （kind === 'file' 且 type 以 image/ 开头）；
//   · 经 preload 受控 IPC（dshDesktop.imagePaste.save）把图片保存到临时
//     目录，拿到完整路径后按 dsh-file-drop 同款格式注入输入框路径提示
//     （agent 用 inspect_image 工具分析图片后继续）；
//   · 纯文本粘贴（无图片）完全不干预，交给上游输入框处理；同时粘贴
//     文本+图片时文本照常粘贴，图片提示追加在末尾。
//
// 纯逻辑挂在 window.__dshImagePasteCore 上（生产无副作用），供 node 测试
// 套件直接评估本文件验证 —— 官方模块加载器只支持 classic script，不能 import。
(function () {
  'use strict';

  // ───────────────────────── 纯逻辑（可测） ─────────────────────────
  var MAX_IMAGE_BYTES = 15 * 1024 * 1024;

  var IMAGE_MIME_EXT = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/avif': '.avif',
    'image/ico': '.ico',
    'image/tiff': '.tiff',
    'image/x-icon': '.ico',
  };

  /** 剪贴板 item 是否为图片文件。 */
  function isImageItem(item) {
    return !!item && typeof item.kind === 'string' && item.kind === 'file' &&
      typeof item.type === 'string' && item.type.indexOf('image/') === 0;
  }

  /** 从 clipboardData.items 提取图片文件列表（跳过非图片项）。 */
  function imageFilesFrom(items) {
    var out = [];
    if (!items) return out;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!isImageItem(item)) continue;
      try {
        var f = item.getAsFile();
        if (f) out.push(f);
      } catch (_e) { /* 单个 item 失败不影响其余 */ }
    }
    return out;
  }

  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** 文件名清洗：去路径分隔符与保留字，限长；空名回退默认。 */
  function sanitizeName(name) {
    var s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 40);
    return s || '粘贴图片';
  }

  /**
   * 生成要注入输入框的文本：每张图片一行（粘贴图片：名称 + 完整路径 +
   * 大小），提示 agent 用 inspect_image 分析。
   */
  function buildPasteHint(_a) {
    var images = _a.images;
    var lines = ['[粘贴图片]'];
    for (var i = 0; i < images.length; i++) {
      var im = images[i] || {};
      var name = sanitizeName(im.name);
      var path = im.path || '';
      var sizeText = im.size != null ? '，大小 ' + formatSize(im.size) : '';
      lines.push('- ' + name + sizeText + (path ? '\n  完整路径：' + path : ''));
    }
    lines.push('请用 inspect_image 工具逐一分析这些图片后继续。');
    return lines.join('\n');
  }

  // 暴露纯逻辑供测试；生产无副作用。
  if (typeof window !== 'undefined') {
    window.__dshImagePasteCore = {
      MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
      isImageItem: isImageItem,
      imageFilesFrom: imageFilesFrom,
      sanitizeName: sanitizeName,
      buildPasteHint: buildPasteHint,
    };
  }

  // ───────────────────────── DOM 粘合 ─────────────────────────

  /** 找到当前会话的输入框（React 受控 textarea，与 dsh-file-drop 同款）。 */
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

  function saveViaBridge(file) {
    return new Promise(function (resolve, reject) {
      var b = window.dshDesktop && window.dshDesktop.imagePaste;
      if (!b || typeof b.save !== 'function') {
        reject(new Error('no bridge'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        b.save({ dataUrl: String(reader.result || ''), name: file.name || '粘贴图片' })
          .then(function (res) {
            if (res && res.ok) resolve({ name: file.name || '粘贴图片', path: res.path, size: res.size != null ? res.size : file.size });
            else reject(new Error((res && res.error) || 'save failed'));
          })
          .catch(reject);
      };
      reader.onerror = function () { reject(new Error('read failed')); };
      reader.readAsDataURL(file);
    });
  }

  function handlePastedImages(files) {
    if (!files || files.length === 0) return;
    var hints = [];
    var missing = [];
    var jobs = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if ((f.size || 0) > window.__dshImagePasteCore.MAX_IMAGE_BYTES) {
        missing.push({ name: f.name || '粘贴图片', size: f.size, path: '' });
        continue;
      }
      jobs.push(saveViaBridge(f).then(function (saved) { hints.push(saved); }));
    }
    Promise.all(jobs)
      .then(function () {
        var all = hints.concat(missing);
        if (all.length === 0) return;
        injectIntoComposer(findComposer(), window.__dshImagePasteCore.buildPasteHint({ images: all }));
      })
      .catch(function (_e) { /* 保存失败静默降级：不给输入框添乱 */ });
  }

  function attachPasteHandler() {
    if (typeof document === 'undefined') return;
    document.addEventListener('paste', function (e) {
      var cd = e.clipboardData;
      if (!cd) return;
      var files = window.__dshImagePasteCore.imageFilesFrom(cd.items);
      if (files.length === 0) return; // 纯文本粘贴：不干预上游
      // 不 preventDefault：文本部分照常粘贴，图片提示追加在末尾。
      handlePastedImages(files);
    }, false);
  }

  // ───────────────────────── 注册 ─────────────────────────
  window.__ModuleLoader__.load({
    id: 'dsh-image-paste',
    factory: function (require) {
      var inject = [];
      function apply() {
        attachPasteHandler();
      }
      var module = { exports: {} };
      module.exports = { inject: inject, apply: apply };
      return module.exports;
    },
  });
})();