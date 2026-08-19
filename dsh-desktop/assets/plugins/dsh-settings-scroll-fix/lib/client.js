window.__ModuleLoader__.load({
  id: "dsh-settings-scroll-fix",
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const CSS_ID = "dsh-settings-scroll-fix/styles.css";
    if (typeof document !== "undefined" && !document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-settings-scroll-fix";
      style.dataset.pluginCss = CSS_ID;
      style.textContent = [
        ".VOzbGW_options, .VOzbGW_navList {",
        "  overflow-y: auto !important;",
        "  overscroll-behavior: contain;",
        "  scrollbar-width: thin;",
        "}",
        ".VOzbGW_options::-webkit-scrollbar, .VOzbGW_navList::-webkit-scrollbar {",
        "  width: 8px;",
        "}",
        ".VOzbGW_panel {",
        "  overflow: hidden !important;",
        "}"
      ].join("\n");
      document.head.appendChild(style);
    }

    exports.apply = function () {};
    exports.inject = [];
    return module.exports;
  }
});
