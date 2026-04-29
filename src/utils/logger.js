/**
 * utils/logger.js
 *
 * 统一日志输出工具
 * 作用：
 * 1. 统一日志前缀，方便在浏览器控制台筛选
 * 2. 默认只输出关键 info / warn / error 日志
 * 3. 需要排查问题时，可通过 DEBUG 开关打开 debug / group 细节
 */

import { nowIso } from "./time.js";

/**
 * 创建 logger
 * @param {string} namespace
 * @param {Object} options
 * @param {boolean} [options.enabled=true]
 * @param {boolean} [options.debugEnabled=false]
 * @returns {{
 *   debug: (...args:any[])=>void,
 *   info: (...args:any[])=>void,
 *   warn: (...args:any[])=>void,
 *   error: (...args:any[])=>void,
 *   group: (title:string, payload?:any)=>void
 * }}
 */
export function createLogger(namespace = "APP", options = {}) {
  const { enabled = true, debugEnabled = false } = options;
  const LEVEL_LABELS = {
    DEBUG: "调试",
    INFO: "信息",
    WARN: "警告",
    ERROR: "错误",
    GROUP: "分组"
  };

  // 每条日志都带模块名、级别和时间，便于追踪异步流程。
  const buildPrefix = (level) => [`[${namespace}]`, `[${LEVEL_LABELS[level] || level}]`, `[${nowIso()}]`];

  return {
    debug: (...args) => {
      if (!enabled || !debugEnabled) return;
      console.debug(...buildPrefix("DEBUG"), ...args);
    },

    info: (...args) => {
      if (!enabled) return;
      console.info(...buildPrefix("INFO"), ...args);
    },

    warn: (...args) => {
      if (!enabled) return;
      console.warn(...buildPrefix("WARN"), ...args);
    },

    error: (...args) => {
      if (!enabled) return;
      console.error(...buildPrefix("ERROR"), ...args);
    },

    group: (title, payload) => {
      if (!enabled || !debugEnabled) return;
      console.groupCollapsed(...buildPrefix("GROUP"), title);
      if (payload !== undefined) {
        console.log(payload);
      }
      console.groupEnd();
    }
  };
}

/**
 * 默认 logger
 */
export const logger = createLogger("WA");

/**
 * 根据配置动态决定是否打印
 * @param {string} namespace
 * @returns {Promise<ReturnType<typeof createLogger>>}
 */
export async function createLoggerFromStorage(namespace = "WA") {
  let enabled = true;
  let debugEnabled = false;

  try {
    const res = await chrome.storage.local.get(["DEBUG"]);
    debugEnabled = Boolean(res.DEBUG ?? false);
  } catch {
    enabled = true;
    debugEnabled = false;
  }

  return createLogger(namespace, { enabled, debugEnabled });
}
