/**
 * content/bootstrap-loader.js
 *
 * 这是给 manifest 注入的“普通脚本”
 * 作用：
 * 1. 避免 content_scripts 直接加载 ES module 报错
 * 2. 通过 dynamic import 加载真正的 bootstrap.js
 */

(() => {
  const LOADER_FLAG = "__WA_AUTO_REPLY_BOOTSTRAP_LOADER__";
  const LOADER_META_KEY = "__WA_AUTO_REPLY_BOOTSTRAP_LOADER_META__";

  if (window[LOADER_FLAG]) {
    const prevMeta = window[LOADER_META_KEY] || {};
    // Bootstrap loader 已执行过，防止重复初始化
    return;
  }

  window[LOADER_FLAG] = true;
  window[LOADER_META_KEY] = {
    startedAt: new Date().toISOString(),
    href: location.href
  };

  const bootstrapUrl = chrome.runtime.getURL("src/content/bootstrap.js");

  // 动态导入 bootstrap 模块
  import(bootstrapUrl)
    .then(() => {
      // Bootstrap 模块加载成功
      window[LOADER_META_KEY] = {
        ...window[LOADER_META_KEY],
        loadedAt: new Date().toISOString(),
        loaded: true
      };
    })
    .catch((error) => {
      // Bootstrap 模块加载失败
      window[LOADER_META_KEY] = {
        ...window[LOADER_META_KEY],
        loadedAt: new Date().toISOString(),
        loaded: false,
        error: error?.message || "unknown"
      };
    });
})();