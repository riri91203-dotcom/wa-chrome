/**
 * utils/hash.js
 *
 * hash / 幂等 key / 简单签名工具
 * 用途：
 * 1. 给消息队列生成唯一签名
 * 2. 给 payload 生成幂等 key
 * 3. 生成 roundId / traceId / 短 key
 */

/**
 * 把任意输入序列化成稳定字符串
 * @param {any} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || value === undefined) return String(value);

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${pairs.join(",")}}`;
}

/**
 * 简单字符串 hash（非加密）
 * 适合做前端幂等 key / 缓存 key / 去重 key
 *
 * @param {string} input
 * @returns {string}
 */
export function simpleHash(input = "") {
  let hash = 2166136261;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 对对象做 hash
 * @param {any} value
 * @returns {string}
 */
export function hashObject(value) {
  return simpleHash(stableStringify(value));
}

/**
 * 生成消息签名
 * 常用于：
 * - 防重复发送
 * - 判断本轮消息是否处理过
 *
 * @param {Object} params
 * @param {string} params.chatId
 * @param {string} params.msgId
 * @param {string} params.content
 * @param {string} params.type
 * @param {string} params.time
 * @returns {string}
 */
export function buildMessageSignature(params = {}) {
  const {
    chatId = "",
    msgId = "",
    content = "",
    type = "",
    time = ""
  } = params;

  return hashObject({
    chatId,
    msgId,
    content,
    type,
    time
  });
}

/**
 * 生成后端 payload 幂等 key
 * @param {Object} payload
 * @returns {string}
 */
export function buildPayloadIdempotencyKey(payload = {}) {
  return hashObject(payload);
}

/**
 * 生成 traceId
 * @param {string} prefix
 * @returns {string}
 */
export function createTraceId(prefix = "trace") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 生成 roundId
 * @returns {string}
 */
export function createRoundId() {
  return createTraceId("round");
}

/**
 * 生成短随机 key
 * @param {string} prefix
 * @returns {string}
 */
export function createShortKey(prefix = "key") {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}