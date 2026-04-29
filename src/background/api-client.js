/**
 * background/api-client.js
 *
 * 负责和后端交互：
 * 1. 请求自动回复决策
 * 2. 健康检查
 * 3. 获取手册列表
 * 4. 获取运行配置
 */

import { getSettings } from "./storage.js";
import { BACKEND_INTENTS } from "../utils/constants.js";
import { logger } from "../utils/logger.js";

/**
 * 拼接 URL
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function joinUrl(baseUrl, path) {
  const safeBase = String(baseUrl || "").replace(/\/+$/, "");
  const safePath = String(path || "").startsWith("/") ? path : `/${path || ""}`;
  return `${safeBase}${safePath}`;
}

/**
 * 读取 response json 或 text
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function parseResponseBody(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!text) return null;

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return { rawText: text };
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

/**
 * fetch JSON
 * @param {string} url
 * @param {RequestInit} options
 * @returns {Promise<any>}
 */
async function fetchJson(url, options = {}) {
  logger.info("fetchJson request", {
    url,
    method: options.method || "GET"
  });

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await parseResponseBody(response);

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.response = data;
    throw error;
  }

  return data;
}

/**
 * 校验后端回复结构
 * @param {any} data
 * @returns {boolean}
 */
function isValidReplyDecision(data) {
  if (!data || typeof data !== "object") return false;
  if (data.status !== "success") return false;

  const validIntents = Object.values(BACKEND_INTENTS);
  if (!validIntents.includes(data.intent)) return false;

  if (!Array.isArray(data.actions)) return false;

  return true;
}

/**
 * 请求自动回复决策
 * @param {Object} payload
 * @returns {Promise<Object>}
 */
export async function requestReplyDecision(payload) {
  const settings = await getSettings();
  const url = joinUrl(settings.BACKEND_BASE_URL, settings.REPLY_API_PATH);

  const data = await fetchJson(url, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  logger.group("requestReplyDecision raw response", data);

  if (!isValidReplyDecision(data)) {
    throw new Error("后端返回结构不符合预期");
  }

  logger.group("requestReplyDecision response", data);
  return data;
}

/**
 * 健康检查
 * @returns {Promise<{ok:boolean,status?:number,error?:string}>}
 */
export async function pingBackend() {
  try {
    const settings = await getSettings();
    const url = settings.BACKEND_BASE_URL.replace(/\/+$/, "");

    const response = await fetch(url, {
      method: "GET"
    });

    return {
      ok: response.ok,
      status: response.status
    };
  } catch (error) {
    logger.warn("pingBackend failed", error);
    return {
      ok: false,
      error: error?.message || "Unknown backend error"
    };
  }
}

/**
 * 获取手册列表
 * GET /api/v1/manuals
 * @returns {Promise<any>}
 */
export async function getManualsList() {
  const settings = await getSettings();
  const url = joinUrl(settings.BACKEND_BASE_URL, "/api/v1/manuals");

  const data = await fetchJson(url, {
    method: "GET"
  });

  logger.group("getManualsList response", data);
  return data;
}

/**
 * 获取后端运行配置
 * GET /api/v1/config
 * @returns {Promise<any>}
 */
export async function getBackendRuntimeConfig() {
  const settings = await getSettings();
  const url = joinUrl(settings.BACKEND_BASE_URL, "/api/v1/config");

  const data = await fetchJson(url, {
    method: "GET"
  });

  logger.group("getBackendRuntimeConfig response", data);
  return data;
}