/**
 * content/unread-scanner.js
 *
 * 已接入 utils 的未读扫描模块
 * 基于 dom-adapter 完成：
 * 1. 确保未读筛选已打开
 * 2. 置顶后自上而下逐屏滚动扫描
 * 3. 提取未读客户并入队
 * 4. 返回本轮固定快照
 */

import { sleep } from "../utils/time.js";
import { logger } from "../utils/logger.js";

/** scrollChatListOnePage 内等待 DOM 稳定（毫秒） */
const SCAN_SCROLL_INNER_WAIT_MS = 550;
/** 每屏滚动后再停顿，与 inner wait 叠加避免过快（毫秒） */
const SCAN_SCROLL_EXTRA_SETTLE_MS = 400;

export class UnreadScanner {
  constructor({ dom, cursor = null, store = null, queueManager = null }) {
    this.dom = dom;
    this.cursor = cursor;
    this.store = store;
    this.queueManager = queueManager;
  }

  async setActionText(text, queueProgressText = "", extra = {}) {
    if (!this.store) return;
    await this.store.setState({
      currentAction: text,
      ...(queueProgressText ? { queueProgressText } : {}),
      ...extra
    });
  }

  /**
   * 扫描一轮未读列表，返回：
   * {
   *   anchorA,
   *   anchorB,
   *   queue,
   *   filterFailed
   * }
   *
   * @returns {Promise<Object>}
   */
  async scanOnce() {
    logger.info("开始扫描未读聊天");

    await this.setActionText("正在切换到「对话」并打开未读列表...", "0/0", {
      scanScrollProgressText: "0/0",
      scanFoundCount: 0,
      lastError: ""
    });

    const filterOk = await this.dom.ensureUnreadListForScan(this.cursor);
    logger.debug("未读筛选切换结果", { clicked: filterOk });

    if (!filterOk) {
      await this.setActionText(
        "无法自动打开「未读」筛选，请在左侧手动点「未读」后再次启动",
        "0/0",
        {
          lastError: "未读筛选未激活",
          scanScrollProgressText: "0/0",
          scanFoundCount: 0
        }
      );
      this.queueManager?.setQueue([]);
      return {
        anchorA: "",
        anchorB: "",
        queue: [],
        filterFailed: true
      };
    }

    await sleep(500);
    await this.dom.scrollChatListToTop();
    await sleep(320);

    const anchorA = this.dom.getTopVisibleChatId();
    logger.debug("扫描起点锚点", { anchorA });

    const queueMap = new Map();
    let steps = 0;
    let noProgressCount = 0;
    const MAX_SCROLL_STEPS = 80;

    while (steps < MAX_SCROLL_STEPS) {
      const visibleUnread = this.dom.getVisibleUnreadChats();

      logger.debug("未读扫描循环状态", {
        step: steps,
        visibleUnreadCount: visibleUnread.length,
        queueSize: queueMap.size,
        maxSteps: MAX_SCROLL_STEPS
      });

      for (const chat of visibleUnread) {
        if (!chat?.chatId) continue;

        const existing = this.queueManager?.getStatus(chat.chatId);

        if (
          existing?.status === "completed" &&
          existing?.lastMsgTime &&
          existing.lastMsgTime === (chat.previewTime || "")
        ) {
          continue;
        }

        if (!queueMap.has(chat.chatId)) {
          queueMap.set(chat.chatId, chat);
          this.queueManager?.markPending(chat.chatId, chat.previewTime || "");
        }
      }

      await this.setActionText(
        `正在扫描未读... 第 ${steps + 1}/${MAX_SCROLL_STEPS} 屏，已发现 ${queueMap.size} 个客户`,
        queueMap.size > 0 ? `0/${queueMap.size}` : "0/0",
        {
          scanScrollProgressText: `${steps + 1}/${MAX_SCROLL_STEPS}`,
          scanFoundCount: queueMap.size,
          lastError: ""
        }
      );

      if (this.dom.isChatListAtBottom()) {
        logger.debug("扫描到达列表底部", { step: steps, queueSize: queueMap.size });
        break;
      }

      const scrollResult = await this.dom.scrollChatListOnePage(SCAN_SCROLL_INNER_WAIT_MS);
      steps += 1;

      if (scrollResult.atBottom && !scrollResult.moved && !scrollResult.anchorChanged) {
        logger.debug("列表底部无法继续滚动", { step: steps });
        break;
      }

      if (!scrollResult.moved && !scrollResult.anchorChanged) {
        noProgressCount += 1;
        logger.warn("扫描滚动未产生进展", { step: steps, noProgressCount });
        if (noProgressCount >= 3) {
          const nudged = await this.dom.nudgeScroll(240, 320);
          if (nudged) {
            noProgressCount = 0;
          } else if (this.dom.isChatListAtBottom()) {
            break;
          } else {
            break;
          }
        }
      } else {
        noProgressCount = 0;
      }

      await sleep(SCAN_SCROLL_EXTRA_SETTLE_MS);
    }

    const anchorB = this.dom.getBottomVisibleChatId();
    const queue = Array.from(queueMap.values());

    this.queueManager?.setQueue(queue);

    logger.info("未读扫描完成", {
      anchorA,
      anchorB,
      totalSteps: steps,
      queueSize: queue.length
    });

    return {
      anchorA,
      anchorB,
      queue,
      filterFailed: false
    };
  }

  /**
   * 打开指定 chatId
   * 供 controller / chat-opener 复用
   *
   * @param {string} chatId
   * @returns {Promise<boolean>}
   */
  async locateAndOpenChat(chatId) {
    if (!chatId) return false;

    logger.debug("开始定位并打开聊天", chatId);

    let row = this.dom.findVisibleRowByChatId(chatId);
    if (row) {
      logger.debug("可见区域命中聊天", chatId);
      return this.dom.openChatRow(row, this.cursor);
    }

    const deltas = [-180, 180, 240];
    for (let i = 0; i < deltas.length; i += 1) {
      await this.setActionText(`正在重新定位 ${chatId}（第 ${i + 1} 次）`);
      await this.dom.nudgeScroll(deltas[i], 250);

      row = this.dom.findVisibleRowByChatId(chatId);
      if (row) {
        logger.debug("微调滚动命中聊天", { chatId, attempt: i + 1 });
        return this.dom.openChatRow(row, this.cursor);
      }
    }

    row = await this.dom.locateRowByChatId(chatId, 20);
    if (row) {
      logger.debug("全量定位命中聊天", chatId);
      return this.dom.openChatRow(row, this.cursor);
    }

    logger.warn("定位并打开聊天失败", chatId);
    return false;
  }
}
