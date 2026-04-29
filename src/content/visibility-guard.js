/**
 * content/visibility-guard.js
 *
 * MAIN world 脚本：覆盖 document.hidden / visibilityState，
 * 阻止 visibilitychange / blur 事件传播到页面脚本。
 * 让浏览器和 WhatsApp Web 始终认为标签页处于可见状态，
 * 避免切屏/最小化时被 Chrome 节流或暂停。
 *
 * 此文件在 MAIN world 中运行，无法访问 chrome.* API。
 */

Object.defineProperty(Document.prototype, 'hidden', {
  get: () => false,
  configurable: true
});

Object.defineProperty(Document.prototype, 'visibilityState', {
  get: () => 'visible',
  configurable: true
});

for (const eventName of ['visibilitychange', 'webkitvisibilitychange', 'blur']) {
  window.addEventListener(eventName, (e) => {
    e.stopImmediatePropagation();
    e.stopPropagation();
  }, true);
}
