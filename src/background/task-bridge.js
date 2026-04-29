/**
 * background/task-bridge.js
 *
 * 作为 background service worker 的总入口：
 * 1. 接收 popup / content 消息
 * 2. 管理插件状态
 * 3. 调后端获取回复决策
 * 4. 下载 PDF 并转成 dataUrl
 * 5. 统一回传 content script
 */

import {
  getSettings,
  saveSettings,
  getRuntimeState,
  setRuntimeState,
  resetRuntimeState,
  isAutoReplyEnabled,
  setAutoReplyEnabled
} from "./storage.js";

import {
  requestReplyDecision,
  pingBackend,
  getManualsList,
  getBackendRuntimeConfig
} from "./api-client.js";

import {
  downloadFileAsBase64,
  inspectRemoteFile
} from "./file-uploader.js";

import {
  BG_MESSAGE_TYPES,
  BACKEND_INTENTS,
  APP_STATES
} from "../utils/constants.js";

import { logger } from "../utils/logger.js";
import { extractChatDigits } from "../utils/chat-id.js";
import { initBackgroundLogCollector, getBackgroundLogs, getAvailableDates, cleanOldLogs } from "../utils/bg-log-collector.js";

// 初始化 background 端日志收集器
initBackgroundLogCollector();

/**
 * 将对象数组格式化为文本表格，供日志导出使用
 * @param {Object[]} rows
 * @returns {string}
 */
function formatAsTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "(空)";
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const colWidths = keys.map((k) => {
    const vals = rows.map((r) => String(r?.[k] ?? ""));
    return Math.max(k.length, ...vals.map((v) => v.length));
  });
  const sep = "+-" + colWidths.map((w) => "-".repeat(w)).join("-+-") + "-+";
  const header = "| " + keys.map((k, i) => k.padEnd(colWidths[i])).join(" | ") + " |";
  const body = rows.map((r) =>
    "| " + keys.map((k, i) => String(r?.[k] ?? "").padEnd(colWidths[i])).join(" | ") + " |"
  );
  return [sep, header, sep, ...body, sep].join("\n");
}

/**
 * 标准响应结构
 * @param {boolean} ok
 * @param {any} data
 * @param {string} error
 * @returns {Object}
 */
function makeResponse(ok, data = null, error = "") {
  return {
    ok,
    data,
    error
  };
}

/**
 * 规范化后端 actions：
 * 1. text 原样透传
 * 2. pdf 下载后补充 fileData
 *
 * @param {Object} backendResult
 * @returns {Promise<Object>}
 */
async function normalizeBackendActions(backendResult) {
  const actions = Array.isArray(backendResult?.actions) ? backendResult.actions : [];

  return {
    ...backendResult,
    resolvedActions: actions.map((a) => ({ ...a }))
  };
}

/**
 * 处理后端 reply decision 全流程
 * @param {Object} payload
 * @returns {Promise<Object>}
 */
async function handleReplyDecisionRequest(payload) {
  if (!payload || typeof payload !== "object") {
    return makeResponse(false, null, "payload is required");
  }

  await setRuntimeState({
    appState: APP_STATES.EXECUTING,
    currentChatId: payload.chatId || "",
    currentAction: "正在请求后端生成回复..."
  });

  try {
    const pending = payload?.anchorData?.pendingContent || [];
    {
      const summary = [{
        chatId: payload.chatId || "",
        autoReplyStatus: Boolean(payload.autoReplyStatus),
        platformSource: payload.platformSource || "",
        pendingCount: pending.length
      }];
      console.group("请求JSON");
      console.table(summary);
      console.table(pending);
      console.log("raw", payload);
      console.groupEnd();
      logger.info("【请求JSON】raw\n" + JSON.stringify(payload, null, 2));
    }

    const backendResult = await requestReplyDecision(payload);
    const expectedDigits = extractChatDigits(payload?.chatId || "");
    const responseChatRaw = backendResult?.chatId;
    const responseDigits =
      responseChatRaw === undefined || responseChatRaw === null
        ? ""
        : extractChatDigits(String(responseChatRaw));
    if (expectedDigits && !responseDigits) {
      logger.warn("后端响应未包含 chatId，跳过校验", { expectedDigits });
    }
    if (expectedDigits && responseDigits && expectedDigits !== responseDigits) {
      const msg = `CHAT_ID_MISMATCH: 后端 chatId 数字(${responseDigits})与当前会话(${expectedDigits})不一致`;
      await setRuntimeState({
        lastError: msg,
        currentAction: "已跳过：后端返回的会话与当前聊天不匹配"
      });
      logger.warn("reply decision chatId mismatch", {
        expectedDigits,
        responseDigits
      });
      return makeResponse(false, null, msg);
    }

    const backendActions = Array.isArray(backendResult?.actions) ? backendResult.actions : [];
    {
      const summary = [{
        status: backendResult?.status || "",
        intent: backendResult?.intent || "",
        actionsCount: backendActions.length
      }];
      console.group("响应JSON");
      console.table(summary);
      console.table(backendActions);
      console.log("raw", backendResult);
      console.groupEnd();
      logger.info("【响应JSON】raw\n" + JSON.stringify(backendResult, null, 2));
    }

    // NONE：直接返回，不做文件下载
    if (backendResult.intent === BACKEND_INTENTS.NONE) {
      await setRuntimeState({
        currentAction: "后端返回 NONE"
      });

      return makeResponse(true, {
        ...backendResult,
        resolvedActions: []
      });
    }

    const normalized = await normalizeBackendActions(backendResult);

    await setRuntimeState({
      currentAction: "后端回复已生成"
    });

    return makeResponse(true, normalized);
  } catch (error) {
    await setRuntimeState({
      lastError: error?.message || "Unknown backend error",
      currentAction: "后端请求失败"
    });

    logger.error("handleReplyDecisionRequest failed", error);

    return makeResponse(false, null, error?.message || "request reply failed");
  }
}

/**
 * 统一处理消息
 * @param {Object} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<Object>}
 */
async function handleMessage(message, sender) {
  const type = message?.type;
  switch (type) {
    case BG_MESSAGE_TYPES.PING: {
      return makeResponse(true, {
        alive: true,
        from: "background",
        tabId: sender?.tab?.id || null
      });
    }

    case BG_MESSAGE_TYPES.GET_SETTINGS: {
      const settings = await getSettings();
      return makeResponse(true, settings);
    }

    case BG_MESSAGE_TYPES.SAVE_SETTINGS: {
      const next = await saveSettings(message.payload || {});
      return makeResponse(true, next);
    }

    case BG_MESSAGE_TYPES.GET_RUNTIME_STATE: {
      const state = await getRuntimeState();
      return makeResponse(true, state);
    }

    case BG_MESSAGE_TYPES.SET_RUNTIME_STATE: {
      const state = await setRuntimeState(message.payload || {});
      return makeResponse(true, state);
    }

    case BG_MESSAGE_TYPES.RESET_RUNTIME_STATE: {
      const state = await resetRuntimeState();
      return makeResponse(true, state);
    }

    case BG_MESSAGE_TYPES.GET_AUTO_REPLY_STATUS: {
      const enabled = await isAutoReplyEnabled();
      const runtimeState = await getRuntimeState();

      return makeResponse(true, {
        enabled,
        ...runtimeState
      });
    }

    case BG_MESSAGE_TYPES.SET_AUTO_REPLY_STATUS: {
      const enabled = Boolean(message?.payload?.enabled);
      const settings = await setAutoReplyEnabled(enabled);

      if (!enabled) {
        await setRuntimeState({
          appState: APP_STATES.IDLE,
          stopRequested: false,
          currentAction: "用户已停止",
          currentChatId: "",
          queueProgressText: "",
          lastError: ""
        });
      } else {
        await setRuntimeState({
          stopRequested: false,
          currentAction: "用户已启动"
        });
      }

      return makeResponse(true, {
        enabled,
        settings
      });
    }

    case BG_MESSAGE_TYPES.PING_BACKEND: {
      const result = await pingBackend();
      return makeResponse(true, result);
    }

    case BG_MESSAGE_TYPES.REQUEST_REPLY_DECISION: {
      return handleReplyDecisionRequest(message?.payload);
    }

    case BG_MESSAGE_TYPES.DOWNLOAD_FILE_AS_BASE64: {
      try {
        const fileData = await downloadFileAsBase64(message?.payload || {});
        return makeResponse(true, fileData);
      } catch (error) {
        logger.error("文件下载并转为 base64 失败", error);
        return makeResponse(false, null, error?.message || "download file failed");
      }
    }

    case BG_MESSAGE_TYPES.INSPECT_REMOTE_FILE: {
      try {
        const fileInfo = await inspectRemoteFile(message?.payload || {});
        return makeResponse(true, fileInfo);
      } catch (error) {
        logger.error("远程文件检查失败", error);
        return makeResponse(false, null, error?.message || "inspect file failed");
      }
    }

    case BG_MESSAGE_TYPES.GET_MANUALS_LIST: {
      try {
        const data = await getManualsList();
        return makeResponse(true, data);
      } catch (error) {
        logger.error("获取手册列表失败", error);
        return makeResponse(false, null, error?.message || "get manuals failed");
      }
    }

    case BG_MESSAGE_TYPES.GET_BACKEND_RUNTIME_CONFIG: {
      try {
        const data = await getBackendRuntimeConfig();
        return makeResponse(true, data);
      } catch (error) {
        logger.error("获取后端运行配置失败", error);
        return makeResponse(false, null, error?.message || "get backend config failed");
      }
    }

    case BG_MESSAGE_TYPES.GET_LOGS: {
      const dates = message?.dates || [];
      const logs = await getBackgroundLogs(dates);
      return makeResponse(true, logs);
    }

    case BG_MESSAGE_TYPES.GET_LOG_DATES: {
      const dates = await getAvailableDates();
      return makeResponse(true, dates);
    }

    default:
      return makeResponse(false, null, `Unknown message type: ${type}`);
  }
}

/**
 * 消息监听
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => {
      logger.error("后台消息处理出现未捕获错误", error);
      sendResponse(makeResponse(false, null, error?.message || "Unknown background error"));
    });

  return true;
});

/**
 * 插件安装 / 更新
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  logger.info("扩展安装或更新完成", details);

  const settings = await getSettings();
  await saveSettings(settings);

  const state = await getRuntimeState();
  await setRuntimeState(state);
});

/**
 * 浏览器启动
 */
chrome.runtime.onStartup.addListener(async () => {
  logger.info("浏览器启动，后台状态已重置");

  await setRuntimeState({
    appState: APP_STATES.IDLE,
    stopRequested: false,
    currentAction: "浏览器启动完成",
    currentChatId: "",
    queueProgressText: "",
    lastError: ""
  });
});
