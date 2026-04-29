/**
 * utils/time.js
 *
 * 时间工具函数
 * 作用：
 * 1. 格式化时间
 * 2. 随机等待时间
 * 3. 统一把 WhatsApp 的中文时间转成 YYYY-MM-DD HH:mm:ss
 */

function pad2(value) {
  return String(value).padStart(2, "0");
}

/**
 * 当前时间戳（毫秒）
 * @returns {number}
 */
export function now() {
  return Date.now();
}

/**
 * 当前 ISO 时间
 * @returns {string}
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Date -> YYYY-MM-DD HH:mm:ss
 * @param {Date} date
 * @returns {string}
 */
export function formatDateTime(date = new Date()) {
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  ].join(" ");
}

/**
 * 时间戳 -> YYYY-MM-DD HH:mm:ss
 * @param {number} timestamp
 * @returns {string}
 */
export function formatTimestamp(timestamp) {
  if (!timestamp && timestamp !== 0) return "";
  return formatDateTime(new Date(timestamp));
}

/**
 * 把 WhatsApp 的 rawTime 转成 YYYY-MM-DD HH:mm:ss
 * 支持：
 * - 09:05, 2026年4月3日
 * - 9:05, 2026年4月3日
 * - 2026-04-03 09:05:00
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeWhatsAppTime(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return "";

  // 处理 "09:05, 2026年4月3日" 或 "09:05,2026年4月3日"
  const cnMatch = text.match(/(\d{1,2}):(\d{2}),\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (cnMatch) {
    const [, hh, mm, yyyy, month, day] = cnMatch;
    return `${yyyy}-${pad2(month)}-${pad2(day)} ${pad2(hh)}:${mm}:00`;
  }

  // 处理 "2026-04-03 09:05" 或 "2026-04-03T09:05:00"
  const standardMatch = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );
  if (standardMatch) {
    const [, yyyy, month, day, hh, mm, ss] = standardMatch;
    return `${yyyy}-${pad2(month)}-${pad2(day)} ${pad2(hh)}:${mm}:${pad2(ss || 0)}`;
  }

  // ✅ 【P1修复】兜底：如果仅有时间部分（HH:mm格式），补充当前日期
  if (/\d{1,2}:\d{2}/.test(text)) {
    // 尝试提取时间部分
    const timeMatch = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (timeMatch) {
      const [, hh, mm, ss] = timeMatch;
      // 使用当前日期补充
      const today = new Date();
      const yyyy = today.getFullYear();
      const month = pad2(today.getMonth() + 1);
      const day = pad2(today.getDate());
      return `${yyyy}-${month}-${day} ${pad2(hh)}:${mm}:${pad2(ss || 0)}`;
    }
  }

  return "";
}

/**
 * 语音 / 文件消息时间：有完整日期时同 normalizeWhatsAppTime；
 * 仅有「时:分」时不补当前年月日，返回 HH:mm（或含秒 HH:mm:ss）。
 *
 * @param {string} raw
 * @param {string} mediaType 如 "VOICE" | "FILE"（或旧小写）
 * @returns {string}
 */
export function normalizeWhatsAppTimeForMedia(raw = "", mediaType = "") {
  const text = String(raw || "").trim();
  const m = String(mediaType || "").toUpperCase();
  const isMedia = m === "VOICE" || m === "FILE";
  if (!text) return "";

  const cnMatch = text.match(/(\d{1,2}):(\d{2}),\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (cnMatch) {
    const [, hh, mm, yyyy, month, day] = cnMatch;
    return `${yyyy}-${pad2(month)}-${pad2(day)} ${pad2(hh)}:${mm}:00`;
  }

  const standardMatch = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );
  if (standardMatch) {
    const [, yyyy, month, day, hh, mm, ss] = standardMatch;
    return `${yyyy}-${pad2(month)}-${pad2(day)} ${pad2(hh)}:${mm}:${pad2(ss || 0)}`;
  }

  if (isMedia && /\d{1,2}:\d{2}/.test(text)) {
    const timeMatch = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (timeMatch) {
      const [, hh, mm, ss] = timeMatch;
      if (ss !== undefined && ss !== "") {
        return `${pad2(hh)}:${mm}:${pad2(ss)}`;
      }
      return `${pad2(hh)}:${mm}`;
    }
  }

  return normalizeWhatsAppTime(raw);
}

/**
 * 休眠
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 范围随机整数
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomBetween(min, max) {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

/**
 * 随机等待
 * @param {number} min
 * @param {number} max
 * @returns {Promise<void>}
 */
export async function randomSleep(min, max) {
  const ms = randomBetween(min, max);
  await sleep(ms);
}

/**
 * 秒数转持续时间字符串
 * 例如 5 -> "5s"
 * 例如 65 -> "65s"
 *
 * @param {number|string} seconds
 * @returns {string}
 */
export function toDurationSecondsText(seconds) {
  const num = Number(seconds || 0);
  if (!Number.isFinite(num) || num < 0) return "";
  return `${Math.floor(num)}s`;
}

/**
 * 00:10 -> 10s
 * 01:05 -> 65s
 *
 * @param {string} text
 * @returns {string}
 */
export function mmssToDurationText(text = "") {
  const match = String(text).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";

  const minutes = Number(match[1] || 0);
  const seconds = Number(match[2] || 0);
  return `${minutes * 60 + seconds}s`;
}