/**
 * utils/retry.js
 *
 * 重试工具
 * 用途：
 * 1. 重试异步操作
 * 2. 带退避时间
 * 3. 等待条件满足
 */

import { sleep } from "./time.js";

/**
 * 指数退避时间
 * @param {number} attempt 从 1 开始
 * @param {number} baseMs
 * @param {number} maxMs
 * @returns {number}
 */
export function getBackoffDelay(attempt, baseMs = 300, maxMs = 3000) {
  const delay = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(delay, maxMs);
}

/**
 * 通用重试执行器
 *
 * @template T
 * @param {() => Promise<T>} task
 * @param {Object} options
 * @param {number} [options.retries=3]
 * @param {number} [options.baseDelayMs=300]
 * @param {number} [options.maxDelayMs=3000]
 * @param {(error:any, attempt:number)=>boolean|Promise<boolean>} [options.shouldRetry]
 * @param {(attempt:number, error:any)=>void|Promise<void>} [options.onRetry]
 * @returns {Promise<T>}
 */
export async function retry(task, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 300,
    maxDelayMs = 3000,
    shouldRetry = async () => true,
    onRetry = async () => {}
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;

      if (attempt > retries) {
        break;
      }

      const allowRetry = await shouldRetry(error, attempt);
      if (!allowRetry) {
        throw error;
      }

      await onRetry(attempt, error);

      const delay = getBackoffDelay(attempt, baseDelayMs, maxDelayMs);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * 轮询等待条件成立
 *
 * @param {() => boolean|Promise<boolean>} checker
 * @param {Object} options
 * @param {number} [options.timeoutMs=5000]
 * @param {number} [options.intervalMs=200]
 * @param {string} [options.timeoutMessage="waitUntil timeout"]
 * @returns {Promise<boolean>}
 */
export async function waitUntil(checker, options = {}) {
  const {
    timeoutMs = 5000,
    intervalMs = 200,
    timeoutMessage = "waitUntil timeout"
  } = options;

  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const ok = await checker();
    if (ok) return true;
    await sleep(intervalMs);
  }

  throw new Error(timeoutMessage);
}

/**
 * 忽略异常执行
 *
 * @template T
 * @param {() => Promise<T>} task
 * @param {T|null} fallback
 * @returns {Promise<T|null>}
 */
export async function safeExecute(task, fallback = null) {
  try {
    return await task();
  } catch {
    return fallback;
  }
}

/**
 * 限次重试某个同步/异步条件
 *
 * @param {() => boolean|Promise<boolean>} checker
 * @param {number} maxAttempts
 * @param {number} intervalMs
 * @returns {Promise<boolean>}
 */
export async function retryCheck(checker, maxAttempts = 3, intervalMs = 250) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const ok = await checker();
    if (ok) return true;
    if (i < maxAttempts - 1) {
      await sleep(intervalMs);
    }
  }

  return false;
}  