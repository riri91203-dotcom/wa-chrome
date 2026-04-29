/**
 * 聊天 id 比对：后端可能只返回数字，与 UI/队列中的号码做归一化比较
 * @param {string} value
 * @returns {string}
 */
export function extractChatDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function chatIdsDigitsEqual(a, b) {
  const da = extractChatDigits(a);
  const db = extractChatDigits(b);
  if (!da || !db) return false;
  return da === db;
}
