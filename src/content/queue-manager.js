/**
 * content/queue-manager.js
 *
 * 已接入 utils 常量的队列管理器
 * 作用：
 * 1. 扫描结果入队
 * 2. 去重
 * 3. 完成/重试状态管理
 * 4. 供 controller 使用
 */

import { CHAT_STATUS } from "../utils/constants.js";
import { logger } from "../utils/logger.js";

export class QueueManager {
  constructor() {
    this.processingQueue = [];
    this.chatStatusMap = new Map();
  }

  clearQueue() {
    this.processingQueue = [];
    logger.debug("处理队列已清空");
  }

  /**
   * 获取队列快照
   * @returns {Object[]}
   */
  getQueue() {
    return [...this.processingQueue];
  }

  /**
   * 替换整轮队列
   * @param {Object[]} queue
   */
  setQueue(queue = []) {
    this.processingQueue = [...queue];
    logger.info("处理队列已更新", { size: this.processingQueue.length });
  }

  /**
   * 出队一个
   * @returns {Object|undefined}
   */
  shift() {
    const item = this.processingQueue.shift();
    logger.debug("队列取出一个任务", { remain: this.processingQueue.length, item });
    return item;
  }

  /**
   * 队列长度
   * @returns {number}
   */
  size() {
    return this.processingQueue.length;
  }

  /**
   * 状态读取
   * @param {string} chatId
   * @returns {Object|undefined}
   */
  getStatus(chatId) {
    return this.chatStatusMap.get(chatId);
  }

  /**
   * 状态写入
   * @param {string} chatId
   * @param {Object} status
   */
  setStatus(chatId, status = {}) {
    if (!chatId) return;

    const prev = this.chatStatusMap.get(chatId) || {};
    const next = {
      ...prev,
      ...status
    };

    this.chatStatusMap.set(chatId, next);
    logger.debug("聊天处理状态已更新", { chatId, status: next });
  }

  /**
   * 标记 pending
   * @param {string} chatId
   * @param {string} lastMsgTime
   */
  markPending(chatId, lastMsgTime = "") {
    this.setStatus(chatId, {
      status: CHAT_STATUS.PENDING,
      lastMsgTime,
      retryCount: 0
    });
  }

  /**
   * 标记 processing
   * @param {string} chatId
   */
  markProcessing(chatId) {
    this.setStatus(chatId, {
      status: CHAT_STATUS.PROCESSING
    });
  }

  /**
   * 标记 completed
   * @param {string} chatId
   * @param {string} lastMsgTime
   */
  markCompleted(chatId, lastMsgTime = "") {
    this.setStatus(chatId, {
      status: CHAT_STATUS.COMPLETED,
      retryCount: 0,
      lastMsgTime
    });
  }

  /**
   * 标记 retry
   * @param {string} chatId
   */
  markRetry(chatId) {
    const prev = this.chatStatusMap.get(chatId) || {};
    const retryCount = (prev.retryCount || 0) + 1;

    this.setStatus(chatId, {
      status: CHAT_STATUS.RETRY,
      retryCount
    });
  }

  /**
   * 清理不在活跃列表中的聊天状态，防止 chatStatusMap 无限膨胀。
   * 长时间运行后，已处理完的聊天状态会堆积，导致同号新消息被
   * completed 判定跳过（lastMsgTime 匹配旧值）。
   *
   * @param {string[]} activeChatIds 本轮扫描到的未读 chatId 列表
   */
  evictStaleStatuses(activeChatIds = []) {
    const activeDigits = new Set(
      activeChatIds
        .map((id) => String(id || "").replace(/\D/g, ""))
        .filter(Boolean)
    );

    let evicted = 0;
    for (const [chatId] of this.chatStatusMap) {
      const digits = String(chatId).replace(/\D/g, "");
      if (!activeDigits.has(digits)) {
        this.chatStatusMap.delete(chatId);
        evicted += 1;
      }
    }

    if (evicted > 0) {
      logger.info("已清理非活跃聊天的状态记录", { evicted, remain: this.chatStatusMap.size });
    }
  }

  /**
   * 根据扫描结果构建固定任务池
   * 规则：
   * 1. completed 且 lastMsgTime 未变化 -> 跳过
   * 2. 其余未读 -> 入队
   *
   * @param {Object[]} unreadChats
   * @returns {Object[]}
   */
  buildQueueFromUnreadChats(unreadChats = []) {
    const queueMap = new Map();

    for (const chat of unreadChats) {
      if (!chat?.chatId) continue;

      const existing = this.chatStatusMap.get(chat.chatId);

      if (
        existing?.status === CHAT_STATUS.COMPLETED &&
        existing?.lastMsgTime &&
        existing.lastMsgTime === (chat.previewTime || "")
      ) {
        continue;
      }

      if (!queueMap.has(chat.chatId)) {
        queueMap.set(chat.chatId, chat);
        this.markPending(chat.chatId, chat.previewTime || "");
      }
    }

    const queue = Array.from(queueMap.values());
    this.setQueue(queue);

    logger.info("已根据未读列表生成处理队列", {
      inputSize: unreadChats.length,
      outputSize: queue.length
    });

    return queue;
  }
}
