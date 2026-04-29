/**
 * popup.js
 *
 * 精简版 popup：
 * 1. 不再配置 API Key / 模型 / Prompt
 * 2. 只负责启动 / 停止 / 刷新状态
 * 3. 优先和当前 WhatsApp 标签页里的 content script 通信
 * 4. 如果 content 不可达，则回退读取 background 的 runtime state
 */

import { BG_MESSAGE_TYPES, CT_MESSAGE_TYPES, APP_STATES } from "../utils/constants.js";
import { logger } from "../utils/logger.js";

const pluginStatusEl = document.getElementById("pluginStatus");
const appStateEl = document.getElementById("appState");
const currentChatIdEl = document.getElementById("currentChatId");
const currentActionEl = document.getElementById("currentAction");
const queueProgressTextEl = document.getElementById("queueProgressText");
const staffIdInputEl = document.getElementById("staffIdInput");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const refreshBtn = document.getElementById("refreshBtn");

/**
 * 获取当前活动标签页
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  return tabs?.[0] || null;
}

/**
 * 当前页面是否是 WhatsApp Web
 * @param {chrome.tabs.Tab|null} tab
 * @returns {boolean}
 */
function isWhatsAppTab(tab) {
  return Boolean(tab?.url && tab.url.startsWith("https://web.whatsapp.com/"));
}

/**
 * 发消息给当前 tab 的 content script
 * @param {Object} message
 * @returns {Promise<any>}
 */
async function sendToActiveContent(message) {
  const tab = await getActiveTab();

  if (!tab?.id) {
    throw new Error("未找到当前活动标签页");
  }

  if (!isWhatsAppTab(tab)) {
    throw new Error("当前标签页不是 WhatsApp Web");
  }

  return chrome.tabs.sendMessage(tab.id, message);
}

function isNoReceiverError(error) {
  // Chrome 在 content script 未注入时会返回固定的接收端不存在错误。
  const msg = String(error?.message || error || "");
  return msg.includes("Receiving end does not exist");
}

function sleep(ms) {
  // 小延迟用于等待动态注入的 content script 完成初始化。
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function injectBootstrapLoaderToTab(tabId) {
  // popup 无法直接 import content module，只能注入普通 loader 脚本。
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content/bootstrap-loader.js"]
  });
}

/**
 * 确保 content listener 已可达
 * 1) 先 CT_PING
 * 2) 无接收端时主动注入 loader
 * 3) 重试 CT_PING
 */
async function ensureContentReady() {
  const tab = await getActiveTab();

  if (!tab?.id) {
    throw new Error("未找到当前活动标签页");
  }

  if (!isWhatsAppTab(tab)) {
    throw new Error("当前标签页不是 WhatsApp Web");
  }

  try {
    const pingRes = await chrome.tabs.sendMessage(tab.id, {
      type: CT_MESSAGE_TYPES.PING
    });
    if (pingRes?.ok) return tab.id;
  } catch (error) {
    if (!isNoReceiverError(error)) {
      throw error;
    }
  }

  logger.warn("内容脚本不可达，准备注入启动脚本", { tabId: tab.id });

  try {
    await injectBootstrapLoaderToTab(tab.id);
  } catch (error) {
    logger.error("注入 content 启动脚本失败", error);
    throw new Error("content 注入失败，请刷新 WhatsApp 页面后重试");
  }

  const maxRetries = 5;
  for (let i = 0; i < maxRetries; i += 1) {
    await sleep(400);
    try {
      const pingRes = await chrome.tabs.sendMessage(tab.id, {
        type: CT_MESSAGE_TYPES.PING
      });
      if (pingRes?.ok) {
        logger.info("内容脚本注入后已连通", { tabId: tab.id, retry: i + 1 });
        return tab.id;
      }
    } catch (error) {
      if (!isNoReceiverError(error)) {
        throw error;
      }
    }
  }

  throw new Error("content 未就绪，请刷新 WhatsApp 页面后重试");
}

/**
 * 从 background 获取运行时状态
 * @returns {Promise<Object|null>}
 */
async function getRuntimeStateFromBackground() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: BG_MESSAGE_TYPES.GET_RUNTIME_STATE
    });

    if (res?.ok) {
      return res.data || null;
    }

    return null;
  } catch (error) {
    logger.warn("从后台获取运行状态失败", error);
    return null;
  }
}

/**
 * 更新状态显示
 * @param {Object} state
 */
function renderState(state = {}) {
  const enabled = state.autoReplyStatus || state.appState !== APP_STATES.IDLE;

  pluginStatusEl.textContent = enabled ? "RUNNING" : "STOPPED";
  pluginStatusEl.className = `value ${enabled ? "running" : "stopped"}`;

  appStateEl.textContent = state.appState || APP_STATES.IDLE;
  currentChatIdEl.textContent = state.currentChatId || "-";
  currentActionEl.textContent = state.currentAction || "等待操作";
  queueProgressTextEl.textContent = state.queueProgressText || "0/0";
}

/**
 * 从 background 获取客服 ID
 * @returns {Promise<string>}
 */
async function getStaffIdFromBackground() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: BG_MESSAGE_TYPES.GET_SETTINGS
    });

    if (res?.ok && res?.data) {
      return res.data.STAFF_ID || "";
    }

    return "";
  } catch (error) {
    logger.warn("从后台获取客服 ID 失败", error);
    return "";
  }
}

/**
 * 保存客服 ID 到 background
 * @param {string} staffId
 * @returns {Promise<boolean>}
 */
async function saveStaffIdToBackground(staffId) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: BG_MESSAGE_TYPES.SAVE_SETTINGS,
      payload: {
        STAFF_ID: String(staffId || "").trim()
      }
    });

    if (res?.ok) {
      logger.info("客服 ID 保存成功");
      return true;
    }

    return false;
  } catch (error) {
    logger.error("保存客服 ID 失败", error);
    return false;
  }
}

/**
 * 初始化 staffId 输入框
 */
async function initStaffIdInput() {
  const staffId = await getStaffIdFromBackground();
  staffIdInputEl.value = staffId;

  staffIdInputEl.addEventListener("change", async (e) => {
    const newStaffId = e.target.value.trim();
    const success = await saveStaffIdToBackground(newStaffId);
    if (success) {
      logger.info("客服 ID 已更新");
    } else {
      logger.warn("客服 ID 更新失败");
      // 恢复旧值
      staffIdInputEl.value = staffId;
    }
  });
}

/**
 * 刷新状态：从 content script 或 background 获取最新信息
 */
async function refreshState() {
  // 先尝试从 content script 获取实时状态
  try {
    // 确保 content listener 已就绪
    await ensureContentReady();

    // 向 content 发送状态查询消息
    const contentRes = await sendToActiveContent({
      type: CT_MESSAGE_TYPES.GET_STATE
    });

    // 如果成功，更新 UI
    if (contentRes?.ok && contentRes?.data) {
      renderState(contentRes.data);
      return;
    }
  } catch (error) {
    // 如果 content 不可用，记录警告並回退到 background 状态
    logger.warn("从内容脚本获取状态失败", error);
  }

  // 回退：从 background 获取运行时状态
  const runtimeState = await getRuntimeStateFromBackground();
  if (runtimeState) {
    renderState(runtimeState);
    return;
  }

  // 无法读取任何真实状态时，渲染默认空状态
  renderState({
    appState: APP_STATES.IDLE,
    currentChatId: "",
    currentAction: "无法获取状态",
    queueProgressText: "0/0",
    autoReplyStatus: false
  });
}

/**
 * 启动控件：首先确保 content 就绪，然后发送 START 消息
 */
async function startPlugin() {
  try {
    // 确保 content listener 已就绪
    await ensureContentReady();

    // 发送 START 消息到 content script
    const res = await sendToActiveContent({
      type: CT_MESSAGE_TYPES.START
    });

    // 处理响应
    if (!res?.ok) {
      throw new Error(res?.error || "启动失败");
    }

    // 更新 UI 显示
    renderState(res.data || {});
  } catch (error) {
    // 记录错误并更新显示
    logger.error("启动控件失败", error);
    renderState({
      appState: APP_STATES.IDLE,
      currentAction: error?.message || "启动失败",
      autoReplyStatus: false
    });
  }
}

/**
 * 停止
 */
async function stopPlugin() {
  try {
    await ensureContentReady();

    const res = await sendToActiveContent({
      type: CT_MESSAGE_TYPES.STOP
    });

    if (!res?.ok) {
      throw new Error(res?.error || "停止失败");
    }

    renderState(res.data || {});
  } catch (error) {
    logger.error("停止控件失败", error);
    renderState({
      appState: APP_STATES.IDLE,
      currentAction: error?.message || "停止失败",
      autoReplyStatus: false
    });
  }
}

/**
 * 初始化
 */
function bindEvents() {
  startBtn.addEventListener("click", startPlugin);
  stopBtn.addEventListener("click", stopPlugin);
  refreshBtn.addEventListener("click", refreshState);
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await refreshState();
  await initStaffIdInput();
});
