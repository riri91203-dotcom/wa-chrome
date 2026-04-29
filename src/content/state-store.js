/**
 * content/state-store.js
 *
 * 页面内运行状态管理
 */

import { logger } from "../utils/logger.js";
import { BG_MESSAGE_TYPES } from "../utils/constants.js";

// content script 内部状态的默认值，所有 UI 展示和执行进度都从这里恢复。
const DEFAULT_CONTENT_STATE = {
  appState: "IDLE",          // 应用阶段：IDLE / SCANNING / EXECUTING / COOLDOWN
  autoReplyStatus: false,    // 自动回复开关是否开启
  stopRequested: false,      // 用户是否请求了停止

  currentChatId: "",         // 当前正在处理的客户 chatId
  currentAction: "等待启动",  // 面板上显示的当前动作描述文字
  queueProgressText: "0/0",  // 队列进度文本，如 "3/10"
  scanScrollProgressText: "--", // 扫描滚动进度，如 "5/80"
  scanFoundCount: 0,         // 本轮扫描发现的未读客户数
  roundId: "",               // 本轮扫描的唯一 ID
  queueSize: 0,              // 队列总大小
  queueIndex: 0,             // 当前处理到队列中第几个

  panelExpanded: false,      // 浮动面板是否展开
  handVisible: false,        // 鼠标小手图标是否可见

  lastError: "",             // 最近一次错误信息
  lastUpdatedAt: ""          // 状态最后更新的 ISO 时间戳
};

export class ContentStateStore {
  constructor() {
    // state 保存当前页面内存状态，listeners 负责通知 UI 和控制器。
    this.state = { ...DEFAULT_CONTENT_STATE };
    this.listeners = new Set();
  }

  getState() {
    // 返回浅拷贝，避免外部直接修改内部状态对象。
    return { ...this.state };
  }

  async setState(partial = {}, syncToBackground = true) {
    // 合并状态更新
    this.state = {
      ...this.state,
      ...partial,
      lastUpdatedAt: new Date().toISOString()
    };

    // 发出状态变化事件给所有监听器
    this.emit();

    // 同步运行时状态到后台进程（可选）
    if (syncToBackground) {
      await this.syncRuntimeStateToBackground();
    }
  }

  async reset(syncToBackground = true) {
    // 将页面状态恢复成初始值，通常用于停止或重新开始任务。
    this.state = {
      ...DEFAULT_CONTENT_STATE,
      lastUpdatedAt: new Date().toISOString()
    };
    this.emit();

    if (syncToBackground) {
      await this.syncRuntimeStateToBackground();
    }
  }

  subscribe(listener) {
    // 将监听器添加到订阅集合
    this.listeners.add(listener);

    try {
      // 立即调用监听器，用当前状态初始化
      listener(this.getState());
    } catch (error) {
      // 捕获初始监听器执行的错误
    }

    // 返回取消订阅的函数
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit() {
    // 向所有监听器广播当前状态快照
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        // 执行监听器回调
        listener(snapshot);
      } catch (error) {
        // 捕获监听器执行中的错误，不影响其他监听器
      }
    }
  }

  async syncRuntimeStateToBackground() {
    try {
      // 只同步 background 需要持久化和 popup 需要展示的关键字段。
      await chrome.runtime.sendMessage({
        type: BG_MESSAGE_TYPES.SET_RUNTIME_STATE,
        payload: {
          appState: this.state.appState,
          stopRequested: this.state.stopRequested,
          currentChatId: this.state.currentChatId,
          currentAction: this.state.currentAction,
          queueProgressText: this.state.queueProgressText,
          lastError: this.state.lastError,
          lastRoundId: this.state.roundId
        }
      });
    } catch (error) {
      logger.warn("同步运行状态到后台失败", error);
    }
  }

  async hydrateFromBackground() {
    try {
      // 先恢复自动回复开关，再恢复最近一次运行进度。
      const res = await chrome.runtime.sendMessage({
        type: BG_MESSAGE_TYPES.GET_AUTO_REPLY_STATUS
      });

      if (res?.ok) {
        await this.setState(
          {
            autoReplyStatus: Boolean(res.data?.enabled)
          },
          false
        );
      }

      const stateRes = await chrome.runtime.sendMessage({
        type: BG_MESSAGE_TYPES.GET_RUNTIME_STATE
      });

      if (stateRes?.ok && stateRes?.data) {
        await this.setState(
          {
            appState: stateRes.data.appState || "IDLE",
            stopRequested: Boolean(stateRes.data.stopRequested),
            currentChatId: stateRes.data.currentChatId || "",
            currentAction: stateRes.data.currentAction || "等待启动",
            queueProgressText: stateRes.data.queueProgressText || "0/0",
            roundId: stateRes.data.lastRoundId || "",
            lastError: stateRes.data.lastError || ""
          },
          false
        );
      }
    } catch (error) {
      logger.warn("从后台恢复运行状态失败", error);
    }
  }
}
