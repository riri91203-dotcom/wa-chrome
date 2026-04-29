/**
 * utils/constants.js
 */

export const APP_STATES = {
  IDLE: "IDLE",
  SCANNING: "SCANNING",
  EXECUTING: "EXECUTING",
  COOLDOWN: "COOLDOWN"
};

export const CHAT_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  RETRY: "retry"
};

/** 与 message-parser 发往后端/reader 的 type 字符串一致，均为大写 SCREAMING */
export const MESSAGE_TYPES = {
  AD_CARD: "ad_card",
  FILE: "file",
  CONTACT: "contact",
  PRODUCT: "product",
  CART: "cart",
  IMAGE: "image",
  VIDEO: "video",
  VOICE: "voice",
  TEXT: "text"
};

/**
 * 类型优先级（高 → 低）。CART 不在本数组中，由 getMessageTypePriorityIndex 插在 PRODUCT 与 IMAGE 之间。
 * AD_CARD → FILE → CONTACT → PRODUCT → IMAGE → VIDEO → VOICE → TEXT
 */
export const MESSAGE_TYPE_PRIORITY = [
  MESSAGE_TYPES.AD_CARD,
  MESSAGE_TYPES.FILE,
  MESSAGE_TYPES.CONTACT,
  MESSAGE_TYPES.PRODUCT,
  MESSAGE_TYPES.IMAGE,
  MESSAGE_TYPES.VIDEO,
  MESSAGE_TYPES.VOICE,
  MESSAGE_TYPES.TEXT
];

/**
 * @param {string} type
 * @returns {number} 越小越优先；未知类型为 999
 */
export function getMessageTypePriorityIndex(type) {
  if (type === MESSAGE_TYPES.CART) {
    const p = MESSAGE_TYPE_PRIORITY.indexOf(MESSAGE_TYPES.PRODUCT);
    const i = MESSAGE_TYPE_PRIORITY.indexOf(MESSAGE_TYPES.IMAGE);
    if (p >= 0 && i >= 0) return (p + i) / 2;
  }
  const idx = MESSAGE_TYPE_PRIORITY.indexOf(type);
  return idx === -1 ? 999 : idx;
}

/** 请求体 history：取会话末尾若干条（含最后一条） */
export const HISTORY_MESSAGE_LIMIT = 5;

/**
 * 供 buildHistory 向上补全：从线程末尾多取若干条 raw，跳过无展示内容项后仍能凑满 HISTORY_MESSAGE_LIMIT
 */
export const HISTORY_RAW_LOOKBACK = 60;

export const BACKEND_INTENTS = {
  TEXT_ONLY: "TEXT_ONLY",
  TEXT_WITH_PDF: "TEXT_WITH_PDF",
  NONE: "NONE"
};

export const ACTION_TYPES = {
  TEXT: "text",
  FILE: "file"
};

export const FILE_TYPES = {
  PDF: "pdf"
};

export const BG_MESSAGE_TYPES = {
  PING: "BG_PING",
  GET_SETTINGS: "BG_GET_SETTINGS",
  SAVE_SETTINGS: "BG_SAVE_SETTINGS",
  GET_RUNTIME_STATE: "BG_GET_RUNTIME_STATE",
  SET_RUNTIME_STATE: "BG_SET_RUNTIME_STATE",
  RESET_RUNTIME_STATE: "BG_RESET_RUNTIME_STATE",
  GET_AUTO_REPLY_STATUS: "BG_GET_AUTO_REPLY_STATUS",
  SET_AUTO_REPLY_STATUS: "BG_SET_AUTO_REPLY_STATUS",
  PING_BACKEND: "BG_PING_BACKEND",
  REQUEST_REPLY_DECISION: "BG_REQUEST_REPLY_DECISION",
  DOWNLOAD_FILE_AS_BASE64: "BG_DOWNLOAD_FILE_AS_BASE64",
  INSPECT_REMOTE_FILE: "BG_INSPECT_REMOTE_FILE",
  GET_MANUALS_LIST: "BG_GET_MANUALS_LIST",
  GET_BACKEND_RUNTIME_CONFIG: "BG_GET_BACKEND_RUNTIME_CONFIG",
  GET_LOGS: "BG_GET_LOGS",
  GET_LOG_DATES: "BG_GET_LOG_DATES"
};

export const CT_MESSAGE_TYPES = {
  PING: "CT_PING",
  GET_STATE: "CT_GET_STATE",
  START: "CT_START",
  STOP: "CT_STOP"
};

export const STORAGE_KEYS = {
  AUTO_REPLY_ENABLED: "AUTO_REPLY_ENABLED",
  STAFF_ID: "STAFF_ID",
  BACKEND_BASE_URL: "BACKEND_BASE_URL",
  REPLY_API_PATH: "REPLY_API_PATH",
  FILE_PROXY_API_PATH: "FILE_PROXY_API_PATH",
  SCAN_WAIT_MS: "SCAN_WAIT_MS",
  EXECUTE_RETRY_LIMIT: "EXECUTE_RETRY_LIMIT",
  COOLDOWN_MIN_MS: "COOLDOWN_MIN_MS",
  COOLDOWN_MAX_MS: "COOLDOWN_MAX_MS",
  HISTORY_LIMIT: "HISTORY_LIMIT",
  DEBUG: "DEBUG",
  LAST_SYNCED_MSG_ID: "LAST_SYNCED_MSG_ID",
  LAST_SYNCED_TIME: "LAST_SYNCED_TIME"
};

export const DEFAULTS = {
  STAFF_ID: "",
  BACKEND_BASE_URL: "http://192.168.1.156:5678",
  REPLY_API_PATH: "/webhook/wbot",
  FILE_PROXY_API_PATH: "",
  SCAN_WAIT_MS: 300,
  EXECUTE_RETRY_LIMIT: 3,
  COOLDOWN_MIN_MS: 10000,
  COOLDOWN_MAX_MS: 20000,
  HISTORY_LIMIT: 15,
  DEBUG: false
};

export const DOM_CONSTANTS = {
  PANEL_ROOT_ID: "wa-auto-reply-root",
  PANEL_ID: "wa-auto-reply-panel",
  HAND_ID: "wa-auto-reply-hand",
  GLOBAL_APP_KEY: "__WA_AUTO_REPLY_APP__"
};

