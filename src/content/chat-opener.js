/**
 * content/chat-opener.js
 *
 * 已接入 utils 的聊天打开器
 * 规则：
 * 1. 先在当前可见区域找
 * 2. 找不到则做 3 次微调滚动
 * 3. 仍找不到则执行全量定位
 * 4. 成功后点击打开聊天
 */

import { sleep } from "../utils/time.js";
import { logger } from "../utils/logger.js";

export class ChatOpener {
  constructor({ dom, cursor = null, store = null }) {
    // ChatOpener 只负责“找到并打开聊天”，不读取消息、不请求后端。
    this.dom = dom;
    this.cursor = cursor;
    this.store = store;
  }

  async setActionText(text) {
    // 将当前动作写到面板，方便用户看到自动化正在做什么。
    if (!this.store) return;
    await this.store.setState({
      currentAction: text
    });
  }

  /**
   * 尝试打开当前视口内的聊天
   * @param {string} chatId
   * @returns {Promise<boolean>}
   */
  async tryOpenVisible(chatId) {
    // 最便宜的路径：目标就在当前聊天列表可见区域内。
    const row = this.dom.findVisibleRowByChatId(chatId);
    if (!row) return false;

    await this.setActionText(`正在打开 ${chatId}`);
    logger.debug("当前可见区域已找到聊天", chatId);
    return this.dom.openChatRow(row, this.cursor);
  }

  /**
   * 微调滚动定位
   * @param {string} chatId
   * @param {number[]} deltas
   * @returns {Promise<boolean>}
   */
  async tryOpenByNudging(chatId, deltas = [-180, 180, 240]) {
    // 轻微上下滚动几次，处理目标刚好在视口边缘或虚拟列表未刷新的情况。
    for (let i = 0; i < deltas.length; i += 1) {
      await this.setActionText(`正在重新定位 ${chatId}（第 ${i + 1} 次）`);
      logger.debug("微调滚动定位聊天", { chatId, attempt: i + 1, delta: deltas[i] });

      await this.dom.nudgeScroll(deltas[i], 250);

      const row = this.dom.findVisibleRowByChatId(chatId);
      if (row) {
        await this.setActionText(`已重新定位 ${chatId}，准备打开`);
        logger.debug("微调滚动定位成功", { chatId, attempt: i + 1 });
        return this.dom.openChatRow(row, this.cursor);
      }
    }

    logger.warn("微调滚动未找到聊天", chatId);
    return false;
  }

  /**
   * 全量滚动查找后打开
   * @param {string} chatId
   * @returns {Promise<boolean>}
   */
  async tryOpenByFullLocate(chatId) {
    // 兜底路径：回到顶部后逐屏查找，耗时更长，所以只在前两种方式失败后使用。
    await this.setActionText(`正在全量查找 ${chatId}`);
    logger.debug("开始全量查找聊天", chatId);

    const row = await this.dom.locateRowByChatId(chatId, 20);
    if (!row) {
      logger.warn("全量查找未找到聊天", chatId);
      return false;
    }

    await this.setActionText(`全量查找成功，正在打开 ${chatId}`);
    logger.debug("全量查找聊天成功", chatId);
    return this.dom.openChatRow(row, this.cursor);
  }

  /**
   * 打开聊天的统一入口
   * @param {string} chatId
   * @returns {Promise<boolean>}
   */
  async openByChatId(chatId) {
    if (!chatId) return false;

    logger.debug("开始打开聊天", chatId);

    // 三段式定位：可见区域 -> 微调滚动 -> 全量查找。
    if (await this.tryOpenVisible(chatId)) {
      await sleep(400);
      return true;
    }

    if (await this.tryOpenByNudging(chatId)) {
      await sleep(400);
      return true;
    }

    if (await this.tryOpenByFullLocate(chatId)) {
      await sleep(400);
      return true;
    }

    logger.warn("打开聊天失败", chatId);
    return false;
  }
}
