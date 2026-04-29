/**
 * background/storage.js
 *
 * 最终统一版 storage 管理器
 * 负责：
 * 1. 设置项默认值
 * 2. 运行时状态默认值
 * 3. 读写 chrome.storage.local
 * 4. 自动补齐默认值
 * 5. 自动回复开关管理
 */

import {
  APP_STATES,
  STORAGE_KEYS,
  DEFAULTS
} from "../utils/constants.js";
import { nowIso } from "../utils/time.js";
import { logger } from "../utils/logger.js";

/**
 * 设置默认值
 * 注意：
 * - API / 模型 / Prompt 为后端统一管理
 * - popup 不再配置这些字段
 */
export const DEFAULT_SETTINGS = {
  [STORAGE_KEYS.AUTO_REPLY_ENABLED]: false,
  [STORAGE_KEYS.STAFF_ID]: DEFAULTS.STAFF_ID,
  [STORAGE_KEYS.BACKEND_BASE_URL]: DEFAULTS.BACKEND_BASE_URL,
  [STORAGE_KEYS.REPLY_API_PATH]: DEFAULTS.REPLY_API_PATH,
  [STORAGE_KEYS.FILE_PROXY_API_PATH]: DEFAULTS.FILE_PROXY_API_PATH,
  [STORAGE_KEYS.SCAN_WAIT_MS]: DEFAULTS.SCAN_WAIT_MS,
  [STORAGE_KEYS.EXECUTE_RETRY_LIMIT]: DEFAULTS.EXECUTE_RETRY_LIMIT,
  [STORAGE_KEYS.COOLDOWN_MIN_MS]: DEFAULTS.COOLDOWN_MIN_MS,
  [STORAGE_KEYS.COOLDOWN_MAX_MS]: DEFAULTS.COOLDOWN_MAX_MS,
  [STORAGE_KEYS.HISTORY_LIMIT]: DEFAULTS.HISTORY_LIMIT,
  [STORAGE_KEYS.DEBUG]: DEFAULTS.DEBUG
};

/**
 * 运行时状态默认值
 */
export const DEFAULT_RUNTIME_STATE = {
  appState: APP_STATES.IDLE,
  stopRequested: false,
  currentChatId: "",
  currentAction: "",
  queueProgressText: "",
  lastError: "",
  lastRoundId: "",
  lastSyncedMsgId: "",
  lastSyncedTime: "",
  updatedAt: ""
};

/**
 * 获取原始 storage
 * @param {string[]|Object|string|null} keys
 * @returns {Promise<Object>}
 */
export async function getStorage(keys = null) {
  return chrome.storage.local.get(keys);
}

/**
 * 设置 storage
 * @param {Object} data
 * @returns {Promise<void>}
 */
export async function setStorage(data) {
  await chrome.storage.local.set(data);
}

/**
 * 删除 storage
 * @param {string|string[]} keys
 * @returns {Promise<void>}
 */
export async function removeStorage(keys) {
  await chrome.storage.local.remove(keys);
}

/**
 * 获取完整设置（自动补齐默认值）
 * @returns {Promise<Object>}
 */
export async function getSettings() {
  const saved = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const result = {
    ...DEFAULT_SETTINGS,
    ...saved
  };

  return result;
}

/**
 * 批量更新设置
 * @param {Object} partial
 * @returns {Promise<Object>}
 */
export async function saveSettings(partial = {}) {
  const current = await getSettings();
  const next = {
    ...current,
    ...partial
  };

  await chrome.storage.local.set(next);

  return next;
}

/**
 * 获取完整运行时状态（自动补齐默认值）
 * @returns {Promise<Object>}
 */
export async function getRuntimeState() {
  const saved = await chrome.storage.local.get(Object.keys(DEFAULT_RUNTIME_STATE));
  return {
    ...DEFAULT_RUNTIME_STATE,
    ...saved
  };
}

/**
 * 更新运行时状态
 * @param {Object} partial
 * @returns {Promise<Object>}
 */
export async function setRuntimeState(partial = {}) {
  const current = await getRuntimeState();
  const next = {
    ...current,
    ...partial,
    updatedAt: nowIso()
  };

  await chrome.storage.local.set(next);

  return next;
}

/**
 * 重置运行时状态
 * @returns {Promise<Object>}
 */
export async function resetRuntimeState() {
  const resetState = {
    ...DEFAULT_RUNTIME_STATE,
    updatedAt: nowIso()
  };

  await chrome.storage.local.set(resetState);
  logger.info("运行时状态已重置");

  return getRuntimeState();
}

/**
 * 获取自动回复开关
 * @returns {Promise<boolean>}
 */
export async function isAutoReplyEnabled() {
  const settings = await getSettings();
  return Boolean(settings[STORAGE_KEYS.AUTO_REPLY_ENABLED]);
}

/**
 * 设置自动回复开关
 * @param {boolean} enabled
 * @returns {Promise<Object>}
 */
export async function setAutoReplyEnabled(enabled) {
  const nextValue = Boolean(enabled);

  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTO_REPLY_ENABLED]: nextValue
  });

  const settings = await getSettings();
  logger.info("自动回复开关已更新", { enabled: nextValue });

  return settings;
}

/**
 * 初始化 storage（首次安装/升级时调用）
 * 作用：
 * 1. 补齐缺失设置
 * 2. 补齐缺失运行时字段
 * 3. 不覆盖已有值
 *
 * @returns {Promise<{settings:Object,runtimeState:Object}>}
 */
export async function initializeStorage() {
  const current = await chrome.storage.local.get(null);

  const settingsPatch = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in current)) {
      settingsPatch[key] = value;
    }
  }

  const runtimePatch = {};
  for (const [key, value] of Object.entries(DEFAULT_RUNTIME_STATE)) {
    if (!(key in current)) {
      runtimePatch[key] = value;
    }
  }

  const patch = {
    ...settingsPatch,
    ...runtimePatch
  };

  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
    logger.info("存储默认值已补齐", { keys: Object.keys(patch) });
  } else {
    logger.info("存储默认值无需补齐");
  }

  return {
    settings: await getSettings(),
    runtimeState: await getRuntimeState()
  };
}

/**
 * 获取适合前端展示的状态快照
 * popup / content 可直接使用
 *
 * @returns {Promise<Object>}
 */
export async function getUnifiedStatusSnapshot() {
  const settings = await getSettings();
  const runtimeState = await getRuntimeState();

  return {
    autoReplyEnabled: Boolean(settings[STORAGE_KEYS.AUTO_REPLY_ENABLED]),
    backendBaseUrl: settings[STORAGE_KEYS.BACKEND_BASE_URL],
    replyApiPath: settings[STORAGE_KEYS.REPLY_API_PATH],
    debug: Boolean(settings[STORAGE_KEYS.DEBUG]),
    ...runtimeState
  };
}

/**
 * 获取客服 ID (staffId)
 * @returns {Promise<string>}
 */
export async function getStaffId() {
  const settings = await getSettings();
  return String(settings[STORAGE_KEYS.STAFF_ID] || "");
}

/**
 * 设置客服 ID (staffId)
 * @param {string} staffId
 * @returns {Promise<Object>}
 */
export async function setStaffId(staffId) {
  const sanitized = String(staffId || "").trim();

  await chrome.storage.local.set({
    [STORAGE_KEYS.STAFF_ID]: sanitized
  });

  logger.info("客服 ID 已更新");

  return getSettings();
}

/**
 * 获取最后同步的消息 ID
 * @returns {Promise<string>}
 */
export async function getLastSyncedMsgId() {
  const state = await getRuntimeState();
  return String(state[STORAGE_KEYS.LAST_SYNCED_MSG_ID] || "");
}

/**
 * 获取最后同步的时间
 * @returns {Promise<string>}
 */
export async function getLastSyncedTime() {
  const state = await getRuntimeState();
  return String(state[STORAGE_KEYS.LAST_SYNCED_TIME] || "");
}

/**
 * 设置最后同步信息（消息 ID 和时间）
 * @param {string} msgId
 * @param {string} time - ISO 时间戳
 * @returns {Promise<Object>}
 */
export async function setLastSyncedInfo(msgId, time) {
  const sanitizedMsgId = String(msgId || "").trim();
  const syncTime = String(time || "").trim();

  await chrome.storage.local.set({
    [STORAGE_KEYS.LAST_SYNCED_MSG_ID]: sanitizedMsgId,
    [STORAGE_KEYS.LAST_SYNCED_TIME]: syncTime
  });

  return getRuntimeState();
}
