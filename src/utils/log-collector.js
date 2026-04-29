/**
 * utils/log-collector.js
 *
 * Content Script 端的日志收集器 + 导出功能
 * 1. 拦截 console.info/warn/error，将日志按日期存入 chrome.storage.local
 * 2. 导出时按选中日期从 storage 拉取 + 向 background 请求指定日期日志，合并后下载
 */

import { BG_MESSAGE_TYPES } from "./constants.js";

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
    // storage 写入失败时静默处理
  }
}

function pushLog(level, args) {
  const entry = {
    time: nowStr(),
    level: LEVEL_MAP[level] || level,
    source: "content",
    message: formatMessage(args)
  };
  pushLogToStorage(entry);

  const today = todayDateKey();
  if (lastCleanupDate !== today) {
    lastCleanupDate = today;
    cleanOldLogs();
  }
}

export function initContentLogCollector() {
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
 * 获取指定日期的 content 端日志
 * @param {string[]} dates - 日期列表，格式为 "YYYY-MM-DD"
 * @returns {Promise<Array>}
 */
export async function getContentLogs(dates) {
  if (!Array.isArray(dates) || dates.length === 0) return [];
  const keys = dates.map((d) => `${LOG_KEY_PREFIX}${d}`);
  try {
    const result = await chrome.storage.local.get(keys);
    const allLogs = [];
    for (const key of keys) {
      if (Array.isArray(result[key])) {
        allLogs.push(...result[key].filter((e) => e.source === "content"));
      }
    }
    return allLogs;
  } catch {
    return [];
  }
}

/**
 * 获取 content 端所有可用的日志日期列表
 * @returns {Promise<string[]>}
 */
export async function getAvailableDates() {
  try {
    const all = await chrome.storage.local.get(null);
    const dates = new Set();
    for (const key of Object.keys(all)) {
      if (key.startsWith(LOG_KEY_PREFIX)) {
        const entries = all[key];
        if (Array.isArray(entries) && entries.some((e) => e.source === "content")) {
          dates.add(key.slice(LOG_KEY_PREFIX.length));
        }
      }
    }
    return [...dates].sort().reverse();
  } catch {
    return [];
  }
}

/**
 * 清理超过 LOG_RETENTION_DAYS 天的旧日志（仅清理 content 来源的条目）
 */
export async function cleanOldLogs() {
  try {
    const all = await chrome.storage.local.get(null);
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - LOG_RETENTION_DAYS);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
    const keysToRemove = [];
    const keysToUpdate = {};

    for (const key of Object.keys(all)) {
      if (!key.startsWith(LOG_KEY_PREFIX)) continue;
      const dateStr = key.slice(LOG_KEY_PREFIX.length);
      if (dateStr < cutoffStr) {
        keysToRemove.push(key);
      }
    }

    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch {
    // 清理失败静默处理
  }
}

/**
 * 格式化单条日志为中文文本行
 * @param {{ time: string, level: string, source: string, message: string }} entry
 * @returns {string}
 */
function formatLogEntry(entry) {
  const time = entry.time || "";
  const level = entry.level || "";
  const source = entry.source === "background" ? "后台" : "页面";
  return `[${time}] [${level}] [${source}] ${entry.message}`;
}

/**
 * 获取所有可用日期（合并 content + background 端）
 * @returns {Promise<string[]>}
 */
export async function getAllAvailableDates() {
  const contentDates = await getAvailableDates();

  let bgDates = [];
  try {
    const res = await chrome.runtime.sendMessage({
      type: BG_MESSAGE_TYPES.GET_LOG_DATES
    });
    if (res?.ok && Array.isArray(res.data)) {
      bgDates = res.data;
    }
  } catch {
    // background 不可用时忽略
  }

  const merged = [...new Set([...contentDates, ...bgDates])];
  merged.sort().reverse();
  return merged;
}

/**
 * 收集指定日期的 content + background 日志，合并排序后下载为文本文件
 * @param {string[]} dates - 日期列表，格式为 "YYYY-MM-DD"
 */
export async function collectAndExportLogs(dates) {
  if (!Array.isArray(dates) || dates.length === 0) return;

  const contentLogs = await getContentLogs(dates);

  let bgLogs = [];
  try {
    const res = await chrome.runtime.sendMessage({
      type: BG_MESSAGE_TYPES.GET_LOGS,
      dates
    });
    if (res?.ok && Array.isArray(res.data)) {
      bgLogs = res.data;
    }
  } catch (e) {
    bgLogs = [{
      time: nowStr(),
      level: "错误",
      source: "background",
      message: `获取后台日志失败：${e?.message || e}`
    }];
  }

  const allLogs = [...contentLogs, ...bgLogs];
  allLogs.sort((a, b) => (a.time || "").localeCompare(b.time || ""));

  const header = [
    "========================================",
    "  WhatsApp 自动回复 - 日志导出",
    `  导出时间：${new Date().toLocaleString("zh-CN")}`,
    `  导出日期：${dates.join(", ")}`,
    `  总条数：${allLogs.length}（页面端 ${contentLogs.length}，后台端 ${bgLogs.length}）`,
    "========================================",
    ""
  ].join("\n");

  const body = allLogs.map(formatLogEntry).join("\n");

  const fileContent = header + body + "\n";

  const blob = new Blob([fileContent], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const filename = `whatsapp-auto-reply-logs-${timestamp}.txt`;

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();

  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(anchor);
  }, 1000);
}
