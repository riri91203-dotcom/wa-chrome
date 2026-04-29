/**
 * 同步进度：按 chatId 记录 lastSyncedMsgId（localStorage 为权威）
 */

import { logger } from "../utils/logger.js";
import { extractChatDigits } from "../utils/chat-id.js";

const LS_KEY = "wa_sales_copilot_sync_v1";

function readMap() {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (!s) return {};
    const o = JSON.parse(s);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function writeMap(map) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch (e) {
    logger.warn("写入本地同步进度失败", e?.message || e);
  }
}

export function getLastSyncedMsgId(chatId) {
  if (!chatId) return "";
  const id = readMap()[chatId];
  return id != null ? String(id) : "";
}

/**
 * 与 getLastSyncedMsgId 相同，但若 key 字符串不一致（+86 与空格等），按数字匹配任一条目
 * @param {string} chatId
 * @returns {string}
 */
export function getLastSyncedMsgIdLoose(chatId) {
  const direct = getLastSyncedMsgId(chatId);
  if (direct) return direct;
  const want = extractChatDigits(chatId);
  if (!want) return "";
  const m = readMap();
  for (const k of Object.keys(m)) {
    if (extractChatDigits(k) === want) return String(m[k] ?? "");
  }
  return "";
}

/**
 * @param {string} chatId
 * @param {string} msgId
 */
export function setLastSyncedMsgId(chatId, msgId) {
  if (!chatId || !msgId) return;
  const m = readMap();
  m[chatId] = String(msgId);
  writeMap(m);
}

/**
 * 与 setLastSyncedMsgId 相同，并同步写入数字相同的其它 key（避免 UI/队列 chatId 字符串不一致）
 * @param {string} primaryChatId
 * @param {string} msgId
 * @param {string} [aliasChatId]
 */
export function setLastSyncedMsgIdWithAlias(primaryChatId, msgId, aliasChatId = "") {
  if (!msgId) return;
  const m = readMap();
  const id = String(msgId);
  if (primaryChatId) m[primaryChatId] = id;
  if (aliasChatId && aliasChatId !== primaryChatId) {
    const d0 = extractChatDigits(primaryChatId);
    const d1 = extractChatDigits(aliasChatId);
    if (d0 && d1 && d0 === d1) m[aliasChatId] = id;
  }
  writeMap(m);
}

/**
 * 批量清理不在活跃列表中的 lastSyncedMsgId 条目。
 * 长时间运行后，已完成聊天的 lastSyncedMsgId 会堆积在 localStorage 中，
 * 导致同个客户发新消息时被判定为"已处理"（旧 msgId 与新消息不匹配但因
 * chatStatusMap 中 completed 状态的 lastMsgTime 比对被跳过）。
 *
 * 注意：只清理不在 activeChatIds 中的条目，确保当前扫描到的未读聊天不受影响。
 *
 * @param {string[]} activeChatIds 本轮扫描到的未读 chatId 列表
 */
export function evictStaleSyncedIds(activeChatIds = []) {
  const activeDigits = new Set(
    activeChatIds
      .map((id) => String(id || "").replace(/\D/g, ""))
      .filter(Boolean)
  );

  const m = readMap();
  const keys = Object.keys(m);
  let evicted = 0;

  for (const key of keys) {
    const digits = String(key).replace(/\D/g, "");
    if (digits && !activeDigits.has(digits)) {
      delete m[key];
      evicted += 1;
    }
  }

  if (evicted > 0) {
    writeMap(m);
    logger.info("已清理非活跃聊天的同步进度记录", { evicted, remain: Object.keys(m).length });
  }
}

/**
 * 清空所有 lastSyncedMsgId 条目（停止自动回复时调用）。
 * 确保下次启动时不会因残留的旧同步点跳过客户消息。
 */
export function clearAllSyncedIds() {
  const m = readMap();
  const count = Object.keys(m).length;
  if (count > 0) {
    writeMap({});
    logger.info("已清空全部同步进度记录", { count });
  }
}
