/**
 * utils/bg-log-collector.js
 *
 * Background Service Worker 端的日志收集器
 * 拦截 console.info/warn/error，将日志按日期存入 chrome.storage.local，
 * 供 content script 通过消息按日期拉取。
 */

const LOG_KEY_PREFIX = "LOG_";
const MAX_ENTRIES_PER_DAY = 5000;
const LOG_RETENTION_DAYS = 7;

const LEVEL_MAP = {
  info: "信息",
  warn: "警告",
  error: "错误"
};

let initialized = false;
let lastCleanupDate = "";

function nowStr() {
  return new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    fractionalSecondDigits: 3
  }).replace(/\//g, "-");
}

function todayDateKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${LOG_KEY_PREFIX}${y}-${m}-${d}`;
}

function formatMessage(args) {
  return args.map((a) => {
    if (a === undefined) return "undefined";
    if (a === null) return "null";
    if (typeof a === "object") {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }
    return String(a);
  }).join(" ");
}

async function pushLogToStorage(entry) {
  const dateKey = todayDateKey();
  try {
    const result = await chrome.storage.local.get(dateKey);
    const entries = result[dateKey] || [];
    entries.push(entry);
    if (entries.length > MAX_ENTRIES_PER_DAY) {
      entries.splice(0, entries.length - MAX_ENTRIES_PER_DAY);
    }
    await chrome.storage.local.set({ [dateKey]: entries });
  } catch {
    // storage 写入失败时静默处理，避免递归日志
  }
}

function pushLog(level, args) {
  const entry = {
    time: nowStr(),
    level: LEVEL_MAP[level] || level,
    source: "background",
    message: formatMessage(args)
  };
  pushLogToStorage(entry);

  const today = todayDateKey();
  if (lastCleanupDate !== today) {
    lastCleanupDate = today;
    cleanOldLogs();
  }
}

export function initBackgroundLogCollector() {
  if (initialized) return;
  initialized = true;

  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;

  console.info = function (...args) {
    pushLog("info", args);
    origInfo.apply(console, args);
  };

  console.warn = function (...args) {
    pushLog("warn", args);
    origWarn.apply(console, args);
  };

  console.error = function (...args) {
    pushLog("error", args);
    origError.apply(console, args);
  };

  cleanOldLogs();
}

/**
 * 获取指定日期的日志
 * @param {string[]} dates - 日期列表，格式为 "YYYY-MM-DD"
 * @returns {Promise<Array>}
 */
export async function getBackgroundLogs(dates) {
  if (!Array.isArray(dates) || dates.length === 0) return [];
  const keys = dates.map((d) => `${LOG_KEY_PREFIX}${d}`);
  try {
    const result = await chrome.storage.local.get(keys);
    const allLogs = [];
    for (const key of keys) {
      if (Array.isArray(result[key])) {
        allLogs.push(...result[key]);
      }
    }
    return allLogs;
  } catch {
    return [];
  }
}

/**
 * 获取所有可用的日志日期列表
 * @returns {Promise<string[]>}
 */
export async function getAvailableDates() {
  try {
    const all = await chrome.storage.local.get(null);
    const dates = [];
    for (const key of Object.keys(all)) {
      if (key.startsWith(LOG_KEY_PREFIX)) {
        dates.push(key.slice(LOG_KEY_PREFIX.length));
      }
    }
    dates.sort().reverse();
    return dates;
  } catch {
    return [];
  }
}

/**
 * 清理超过 LOG_RETENTION_DAYS 天的旧日志
 */
export async function cleanOldLogs() {
  try {
    const all = await chrome.storage.local.get(null);
    const keysToRemove = [];
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - LOG_RETENTION_DAYS);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;

    for (const key of Object.keys(all)) {
      if (key.startsWith(LOG_KEY_PREFIX)) {
        const dateStr = key.slice(LOG_KEY_PREFIX.length);
        if (dateStr < cutoffStr) {
          keysToRemove.push(key);
        }
      }
    }

    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch {
    // 清理失败静默处理
  }
}
