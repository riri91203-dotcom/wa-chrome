/**
 * content/controller.js
 *
 * 内容脚本主控制器
 */

import { QueueManager } from "./queue-manager.js";
import { UnreadScanner } from "./unread-scanner.js";
import { ChatOpener } from "./chat-opener.js";
import { WhatsAppMessageReader } from "./message-reader.js";
import { WhatsAppMessageParser } from "./message-parser.js";
import { WhatsAppSender } from "./sender.js";

import { sleep, randomBetween } from "../utils/time.js";
import { createRoundId } from "../utils/hash.js";
import { chatIdsDigitsEqual, extractChatDigits } from "../utils/chat-id.js";
import {
  APP_STATES,
  BACKEND_INTENTS,
  BG_MESSAGE_TYPES,
  CHAT_STATUS,
  HISTORY_MESSAGE_LIMIT,
  HISTORY_RAW_LOOKBACK
} from "../utils/constants.js";
import { logger } from "../utils/logger.js";
import { startAudioKeepAlive, stopAudioKeepAlive } from "./audio-keepalive.js";
import {
  getLastSyncedMsgIdLoose,
  setLastSyncedMsgIdWithAlias,
  evictStaleSyncedIds,
  clearAllSyncedIds
} from "./sync-local-storage.js";

/** 扫描完成后、开始处理队列前，等待列表与右栏 DOM 稳定 */
const DWELL_AFTER_SCAN_MS = 1500;

export class WhatsAppAutoReplyController {
  constructor({ store, cursor, dom }) {
    // controller 负责串联所有模块：
    // store 管状态，cursor 管面板/小手，dom 管 WhatsApp 页面，reader/parser/sender 管消息读写。
    this.store = store;
    this.cursor = cursor;
    this.dom = dom;

    this.loopRunning = false;
    // syncAnchors 预留给增量同步锚点；当前主要同步进度由 localStorage 中的 lastSyncedMsgId 管。
    this.syncAnchors = new Map();

    this.queueManager = new QueueManager();
    this.unreadScanner = new UnreadScanner({
      dom: this.dom,
      cursor: this.cursor,
      store: this.store,
      queueManager: this.queueManager
    });
    this.chatOpener = new ChatOpener({
      dom: this.dom,
      cursor: this.cursor,
      store: this.store
    });

    this.reader = new WhatsAppMessageReader();
    this.parser = new WhatsAppMessageParser();
    this.sender = new WhatsAppSender({
      cursor: this.cursor,
      store: this.store,
      dom: this.dom
    });
  }

  init() {
    // 订阅状态变化，更新UI界面
    this.store.subscribe((state) => {
      // 当状态改变时更新光标可视化
      this.cursor.renderState(state);

      if (state.panelExpanded) {
        this.cursor.expandPanel();
      } else {
        this.cursor.collapsePanel();
      }

      if (state.handVisible) {
        this.cursor.showHand();
      } else {
        this.cursor.hideHand();
      }
    });

    // 绑定启动和停止按钮的回调事件
    this.cursor.bindActions(
      () => this.start(),
      () => this.stop()
    );
  }

  ensureLoopRunning() {
    // 确保主循环只运行一次
    if (this.loopRunning) {
      return;
    }

    // 启动主循环
    this.loopRunning = true;
    this.runLoop().finally(() => {
      this.loopRunning = false;
      logger.info("主循环已退出");
    });
  }

  async start() {
    // 检查是否已在运行
    const current = this.store.getState();
    if (this.loopRunning && current.autoReplyStatus && !current.stopRequested) {
      logger.info("控制器已运行自动回复，跳过启动");
      return;
    }

    // 防御性校验：staffId 必须是有效的11位手机号
    const staffId = await this._resolveStaffIdForPayload();
    if (!staffId || !/^1[3-9]\d{9}$/.test(staffId)) {
      await this.store.setState({
        appState: APP_STATES.IDLE,
        lastError: "请先填写有效的客服手机号（11位）",
        currentAction: "启动失败：手机号为空或格式不正确"
      });
      logger.warn("启动被阻止：staffId 未填写或格式不正确");
      return;
    }

    // 清除同步锚点并向后台发送启用消息
    this.syncAnchors.clear();

    await chrome.runtime.sendMessage({
      type: BG_MESSAGE_TYPES.SET_AUTO_REPLY_STATUS,
      payload: { enabled: true }
    });

    // 更新状态为扫描中
    await this.store.setState({
      autoReplyStatus: true,
      stopRequested: false,
      panelExpanded: true,
      handVisible: true,
      appState: APP_STATES.SCANNING,
      currentAction: "准备开始扫描未读列表...",
      lastError: "",
      scanScrollProgressText: "0/0",
      scanFoundCount: 0
    });

    logger.info("控制器已启动");

    startAudioKeepAlive();

    this.ensureLoopRunning();
  }

  async stop() {
    await chrome.runtime.sendMessage({
      type: BG_MESSAGE_TYPES.SET_AUTO_REPLY_STATUS,
      payload: { enabled: false }
    });

    this.queueManager.clearQueue();
    this.queueManager.chatStatusMap.clear();
    this.syncAnchors.clear();
    clearAllSyncedIds();

    await this.store.setState({
      autoReplyStatus: false,
      stopRequested: false,
      appState: APP_STATES.IDLE,
      currentChatId: "",
      currentAction: "已关闭自动回复",
      queueProgressText: "0/0",
      scanScrollProgressText: "--",
      scanFoundCount: 0,
      panelExpanded: true,
      handVisible: false
    });

    logger.info("自动回复已关闭，所有状态已清理");

    stopAudioKeepAlive();
  }

  async runLoop() {
    // 主循环的生命周期：
    // 1. 等 WhatsApp 左侧聊天列表就绪
    // 2. 自动回复关闭时休眠等待
    // 3. 开启时扫描未读队列
    // 4. 执行本轮队列
    // 5. 冷却后进入下一轮
    const ready = await this.dom.waitUntilReady();
    if (!ready) {
      await this.store.setState({
        appState: APP_STATES.IDLE,
        currentAction: "未检测到 WhatsApp 聊天列表",
        lastError: "聊天列表未加载完成",
        handVisible: false
      });
      logger.warn("WhatsApp 聊天列表未就绪");
      return;
    }

    while (true) {
      const state = this.store.getState();

      if (state.stopRequested) {
        // stopRequested 是软停止信号，当前轮会尽快收尾。
        await this.cursor.restAtCorner();
        await this.store.setState({
          appState: APP_STATES.IDLE,
          currentAction: "停止中...",
          handVisible: false
        });
        break;
      }

      if (!state.autoReplyStatus) {
        // 自动回复关闭时不退出循环，保持 content script 常驻，等待用户再次启动。
        await this.store.setState({
          appState: APP_STATES.IDLE,
          currentAction: "自动回复已关闭，点击启动继续",
          handVisible: false
        });
        await sleep(2000);
        continue;
      }

      await this.scanPhase();

      const stateAfterScan = this.store.getState();
      if (stateAfterScan.stopRequested || !stateAfterScan.autoReplyStatus) {
        // 扫描阶段可能因为未读筛选失败或用户停止而关闭自动回复。
        continue;
      }

      await this.executePhase();

      if (this.store.getState().stopRequested) {
        continue;
      }

      const bgEnabledAfterExec = await this._fetchAutoReplyEnabledFromBackground();
      if (bgEnabledAfterExec && !this.store.getState().autoReplyStatus) {
        // background 是自动回复开关的权威来源；content 状态落后时做一次校准。
        await this.store.setState({ autoReplyStatus: true }, false);
      }
      if (!bgEnabledAfterExec) {
        if (this.store.getState().autoReplyStatus) {
          await this.store.setState({ autoReplyStatus: false }, false);
        }
        continue;
      }

      // 冷却前检查右侧面板是否仍有待回复消息（用户停留在窗口导致消息被已读的场景）
      if (!this.store.getState().stopRequested && this._rightPanelOpenWantsReply()) {
        logger.info("右侧面板仍有待回复消息，跳过冷却直接进入下一轮");
        continue;
      }

      await this.cooldownPhase();
    }
  }

  async scanPhase() {
    // scanPhase 只负责建立“本轮固定队列”，不在执行阶段边处理边重新扫描。
    await this.store.setState({
      appState: APP_STATES.SCANNING,
      currentAction: "正在扫描未读列表...",
      currentChatId: "",
      queueProgressText: "0/0",
      scanScrollProgressText: "0/0",
      scanFoundCount: 0,
      handVisible: true,
      panelExpanded: true
    });

    const roundId = createRoundId();
    const { anchorA, anchorB, queue, filterFailed } = await this.unreadScanner.scanOnce();

    if (filterFailed) {
      // 未读筛选无法打开时继续运行会误扫全量列表，所以直接关闭自动回复。
      await chrome.runtime.sendMessage({
        type: BG_MESSAGE_TYPES.SET_AUTO_REPLY_STATUS,
        payload: { enabled: false }
      });

      await this.store.setState({
        appState: APP_STATES.IDLE,
        autoReplyStatus: false,
        roundId,
        queueSize: 0,
        queueIndex: 0,
        queueProgressText: "0/0",
        scanScrollProgressText: "0/0",
        scanFoundCount: 0,
        currentAction: "已停止：未读筛选无法打开",
        handVisible: false
      });

      logger.warn("扫描已中止：未读筛选未激活");
      return;
    }

    await this.store.setState({
      roundId,
      queueSize: queue.length,
      queueIndex: 0,
      queueProgressText: queue.length ? `0/${queue.length}` : "0/0",
      scanScrollProgressText: "完成",
      scanFoundCount: queue.length,
      currentAction: `扫描完成，AnchorA=${anchorA || "-"}，AnchorB=${anchorB || "-"}`,
      lastError: ""
    });

    // 清理不再活跃的残留状态，防止长时间运行后状态膨胀导致漏检。
    const activeChatIds = queue.map((c) => c.chatId).filter(Boolean);
    this.queueManager.evictStaleStatuses(activeChatIds);
    evictStaleSyncedIds(activeChatIds);

    logger.info("扫描阶段完成", {
      roundId,
      anchorA,
      anchorB,
      queueSize: queue.length
    });
  }

  async executePhase() {
    // executePhase 使用 scanPhase 产生的队列快照。
    // pending 是局部数组，退出时按原因决定清空或写回 queueManager。
    const pending = this.queueManager.getQueue().filter((c) => c?.chatId);
    const totalInitial = pending.length;

    logger.info("开始执行本轮队列", { queueSize: totalInitial });

    if (!totalInitial) {
      // 队列为空时也检查右侧面板是否有已读但未回复的消息（用户停留在窗口场景）
      if (this._rightPanelOpenWantsReply()) {
        const uiChatId = this.dom.getCurrentChatId();
        if (uiChatId) {
          logger.info("队列为空，但右侧面板有待回复消息，优先处理", uiChatId);
          await this.store.setState({
            appState: APP_STATES.EXECUTING,
            currentAction: `队列为空，处理右侧已打开对话：${uiChatId}`,
            currentChatId: uiChatId,
            queueProgressText: "0/1",
            scanScrollProgressText: "--",
            scanFoundCount: 0,
            lastError: ""
          });
          try {
            await this.executeChatTask(
              { chatId: uiChatId, previewTime: "" },
              { justOpened: false }
            );
          } catch (error) {
            const msg = String(error?.message || "");
            await this.store.setState({
              lastError: msg,
              currentAction: `处理右侧面板消息失败：${uiChatId}`
            });
            logger.error("队列为空时处理右侧面板消息失败", uiChatId, error);
          }
          return;
        }
      }

      await this.store.setState({
        appState: APP_STATES.EXECUTING,
        currentAction: "本轮没有未读客户",
        queueProgressText: "0/0",
        scanScrollProgressText: "--",
        scanFoundCount: 0,
        currentChatId: ""
      });
      logger.info("本轮队列为空，跳过执行阶段");
      return;
    }

    await this.store.setState({
      appState: APP_STATES.EXECUTING,
      currentAction: "开始执行本轮队列（本轮内不重新扫描）...",
      scanScrollProgressText: "--"
    });

    await this.store.setState({
      currentAction: "停留窗口：扫描后等待列表与右栏稳定…"
    });
    await sleep(DWELL_AFTER_SCAN_MS);

    let processed = 0;
    /** @type {"stop"|"disabled"|null} */
    let exitBreakReason = null;
    const rightOnlyPriorityOnce = new Set();

    while (pending.length) {
      // 每处理一个客户前，都重新检查停止信号和后台开关，避免 popup 状态不同步。
      const state = this.store.getState();
      if (state.stopRequested) {
        exitBreakReason = "stop";
        logger.info("执行阶段已中断：收到停止请求");
        break;
      }

      const bgEnabled = await this._fetchAutoReplyEnabledFromBackground();
      if (!bgEnabled) {
        exitBreakReason = "disabled";
        logger.info("执行阶段已中断：后台自动回复已关闭");
        break;
      }
      if (!state.autoReplyStatus) {
        await this.store.setState({ autoReplyStatus: true }, false);
      }

      const uiChatId = this.dom.getCurrentChatId();
      let chat;
      if (uiChatId && this._rightPanelOpenWantsReply()) {
        // 如果右侧当前聊天已经有待回复的新消息，优先处理它，减少来回滚动。
        const inQueueIndex = pending.findIndex((c) =>
          chatIdsDigitsEqual(c.chatId, uiChatId)
        );
        if (inQueueIndex >= 0) {
          chat = pending.splice(inQueueIndex, 1)[0];
          await this.store.setState({
            currentAction: `优先处理当前已打开对话（已在队列）：${chat.chatId}`
          });
          logger.info("优先处理右侧已打开的队列内聊天", chat.chatId);
        } else {
          const dedupeKey = extractChatDigits(uiChatId) || uiChatId;
          if (dedupeKey && rightOnlyPriorityOnce.has(dedupeKey)) {
            // 队列外右侧聊天每轮只优先一次，避免一直卡在同一个窗口。
            chat = pending.shift();
          } else {
            if (dedupeKey) rightOnlyPriorityOnce.add(dedupeKey);
            chat = { chatId: uiChatId, previewTime: "" };
            await this.store.setState({
              currentAction: `优先处理当前已打开对话（未在队列）：${chat.chatId}`
            });
            logger.info("优先处理右侧已打开的队列外聊天", chat.chatId);
          }
        }
      } else {
        chat = pending.shift();
      }

      processed += 1;
      await this.store.setState({
        queueIndex: processed,
        queueProgressText: `${processed}/${totalInitial}`,
        currentChatId: chat.chatId,
        currentAction: `正在处理客户：${chat.chatId}`,
        lastError: ""
      });

      logger.info("开始处理聊天", chat.chatId);

      const alreadyOnChat = chatIdsDigitsEqual(
        this.dom.getCurrentChatId(),
        chat.chatId
      );
      const opened =
        alreadyOnChat || (await this.chatOpener.openByChatId(chat.chatId));
      const justOpened = opened && !alreadyOnChat;
      if (!opened) {
        // 找不到聊天不算致命错误，标记 retry 后交给下一轮扫描再判断。
        this.queueManager.markRetry(chat.chatId);
        await this.store.setState({
          currentAction: `未找到 ${chat.chatId}，已跳过，等待下轮重试`
        });
        logger.warn("打开聊天失败，等待下轮重试", chat.chatId);
        continue;
      }

      this.queueManager.markProcessing(chat.chatId);

      try {
        await this.executeChatTask(chat, { justOpened });
        this.queueManager.markCompleted(chat.chatId, chat.previewTime || "");
        logger.info("聊天处理完成", chat.chatId);
      } catch (error) {
        const msg = String(error?.message || "");
        if (msg.includes("CHAT_ID_MISMATCH") || msg.includes("CHAT_SWITCHED_BEFORE_SEND")) {
          this.queueManager.markCompleted(chat.chatId, chat.previewTime || "");
          await this.store.setState({
            lastError: msg,
            currentAction: `已跳过：会话不匹配（${chat.chatId}）`
          });
          logger.warn("跳过聊天：会话不匹配", chat.chatId);
        } else {
          this.queueManager.markRetry(chat.chatId);
          await this.store.setState({
            lastError: msg || "处理聊天失败",
            currentAction: `处理 ${chat.chatId} 失败，已标记重试`
          });
          logger.error("执行聊天任务失败", chat.chatId, error);
        }
      }
    }

    if (pending.length === 0) {
      // 正常完成一轮，清掉队列，下一轮重新扫描未读。
      this.queueManager.clearQueue();
    } else if (exitBreakReason === "disabled") {
      // 后台开关关闭通常来自 popup，保留剩余队列以便恢复时继续。
      this.queueManager.setQueue(pending);
      logger.info("执行阶段已中断，剩余队列已恢复", {
        remain: pending.length
      });
    } else if (exitBreakReason === "stop") {
      // 用户明确停止时清空队列，避免下次启动处理旧任务。
      this.queueManager.clearQueue();
    } else {
      this.queueManager.setQueue(pending);
      logger.warn("执行阶段退出时仍有剩余任务，已恢复队列", {
        remain: pending.length,
        exitBreakReason
      });
    }
  }

  /**
   * 以 background 的 AUTO_REPLY 开关为准（避免 content store 滞后误判）
   * @returns {Promise<boolean>}
   */
  async _fetchAutoReplyEnabledFromBackground() {
    try {
      const res = await chrome.runtime.sendMessage({
        type: BG_MESSAGE_TYPES.GET_AUTO_REPLY_STATUS
      });
      return Boolean(res?.ok && res?.data?.enabled);
    } catch (error) {
      logger.warn("从后台读取自动回复开关失败", error);
      return this.store.getState().autoReplyStatus;
    }
  }

  /**
   * @param {string} chatId
   * @param {string} customerInboundMsgId
   */
  async _persistCustomerInboundAsLastSynced(chatId, customerInboundMsgId) {
    const id = String(customerInboundMsgId || "").trim();
    if (!chatId || !id) return;
    const uiChat = this.dom.getCurrentChatId();
    // 同时写入队列 chatId 和右侧 UI chatId，解决号码格式不同导致的缓存读不到问题。
    setLastSyncedMsgIdWithAlias(chatId, id, uiChat);
    try {
      await chrome.runtime.sendMessage({
        type: BG_MESSAGE_TYPES.SET_RUNTIME_STATE,
        payload: {
          lastSyncedMsgId: id,
          lastSyncedTime: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.warn("保存最后同步消息信息失败", error);
    }
  }

  /**
   * 将当前窗口最后一条 message-in 的 id 写入 localStorage + runtime
   * @param {string} chatId
   */
  async _persistCurrentInboundTailAsLastSynced(chatId) {
    const id = this.reader.getLastCustomerInboundMsgId();
    if (id) await this._persistCustomerInboundAsLastSynced(chatId, id);
  }

  /**
   * @param {number} maxMs
   * @param {number} pollMs
   * @returns {Promise<boolean>}
   */
  async _waitUntilLastBubbleIsOut(maxMs = 15000, pollMs = 120) {
    // 发送后等待“最后一个气泡变成我方消息”，用于确认 WhatsApp 已把消息追加到线程末尾。
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (this.reader.isLastBubbleMessageOut()) return true;
      await sleep(pollMs);
    }
    return this.reader.isLastBubbleMessageOut();
  }

  /**
   * T+2s：分支 A 新客户气泡；分支 B 与缓存一致则结束本会话
   * @param {string} chatId
   * @param {string} baselineBubbleMsgId
   * @returns {Promise<"repeat"|"leave">}
   */
  async _observeTwoSecondsAfterReply(chatId, baselineBubbleMsgId) {
    // 回复后短暂观察客户是否立刻追加新消息。
    // 若客户又发来新内容，就在同一会话内重复读取和请求后端。
    const deadline = Date.now() + 2000;
    const baseline = String(baselineBubbleMsgId || "");
    while (Date.now() < deadline) {
      await sleep(100);
      const tailId = this.reader.getLastBubbleMsgId();
      if (
        tailId &&
        tailId !== baseline &&
        this.reader.isLastThreadMessageFromCustomer()
      ) {
        logger.info("回复后检测到客户新消息，继续处理", chatId);
        return "repeat";
      }
    }
    const inboundId = this.reader.getLastCustomerInboundMsgId();
    const cached = getLastSyncedMsgIdLoose(chatId);
    if (inboundId && inboundId === cached) {
      logger.debug("回复后未发现新的客户消息", chatId);
      return "leave";
    }
    if (inboundId && inboundId !== cached) {
      logger.info("回复后缓存与最新客户消息不一致，继续处理", chatId);
      return "repeat";
    }
    return "leave";
  }

  /**
   * 当前右侧会话是否与 expected 为同一客户（按号码数字）
   * @param {string} expectedChatId
   * @returns {boolean}
   */
  _isUiChatMatchingExpected(expectedChatId) {
    const ui = this.dom.getCurrentChatId();
    if (!expectedChatId || !ui) return false;
    return chatIdsDigitsEqual(ui, expectedChatId);
  }

  /**
   * 等待 DOM 中 chatId 切换到与 expectedChatId 一致（用双重确认）
   * @param {string} expectedChatId
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async _waitForChatIdSwitch(expectedChatId, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const confident = this.dom.getCurrentChatIdWithConfidence();
      if (confident !== null && chatIdsDigitsEqual(confident, expectedChatId)) {
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  /**
   * 校验当前 UI chatId 与预期一致，不一致时在面板提示并记录错误
   * @param {string} expectedChatId 队列中的 chatId
   * @param {string} checkpointName 校验点名称（用于日志）
   * @returns {{ ok: boolean, uiChatId: string }}
   */
  async _assertChatIdMatch(expectedChatId, checkpointName = "") {
    const uiChatId = this.dom.getCurrentChatId();
    let confident = this.dom.getCurrentChatIdWithConfidence();

    if (confident === null) {
      // 左右面板 chatId 不一致，可能是 DOM 切换中间态，短暂等待后重试一次
      await sleep(500);
      confident = this.dom.getCurrentChatIdWithConfidence();
    }

    if (confident === null) {
      const leftId = this.dom.getLeftPanelSelectedChatId();
      const rightId = this.dom.getRightPanelChatId();
      const msg = `chatId 不一致（${checkpointName}）：左侧 ${leftId || "空"}，右侧 ${rightId || "空"}，期望 ${expectedChatId}`;
      await this.store.setState({
        lastError: msg,
        currentAction: msg
      });
      logger.warn("chatId 校验失败：左右面板不一致", { checkpointName, expectedChatId, leftId, rightId });
      return { ok: false, uiChatId };
    }

    if (!chatIdsDigitsEqual(uiChatId, expectedChatId)) {
      const msg = `chatId 不一致（${checkpointName}）：队列 ${expectedChatId}，当前面板 ${uiChatId || "空"}`;
      await this.store.setState({
        lastError: msg,
        currentAction: msg
      });
      logger.warn("chatId 校验失败：UI 与队列不匹配", { checkpointName, expectedChatId, uiChatId });
      return { ok: false, uiChatId };
    }

    return { ok: true, uiChatId };
  }

  /**
   * 仅根据当前右侧已打开会话：是否需要继续回复（不依赖是否在队列中）
   * @returns {boolean}
   */
  _rightPanelOpenWantsReply() {
    const ui = this.dom.getCurrentChatId();
    if (!ui) return false;
    const inbound = this.reader.getLastCustomerInboundMsgId();
    if (!inbound) return false;
    const stored = getLastSyncedMsgIdLoose(ui);
    // 最新客户消息已记录过，说明这个会话已经处理到当前尾部。
    if (inbound === stored) return false;
    // 如果线程末尾已经是我方消息，说明无需继续回复。
    if (this.reader.isLastBubbleMessageOut()) return false;
    return true;
  }

  /**
   * 右侧已打开且：最后一条 message-in 与缓存不一致、且线程末尾不是 message-out → 需要继续回复
   * @param {string} expectedChatId 队列或当前任务中的 chatId
   * @returns {boolean}
   */
  _rightPanelWantsReplyForExpectedChat(expectedChatId) {
    if (!this._isUiChatMatchingExpected(expectedChatId)) return false;
    const inbound = this.reader.getLastCustomerInboundMsgId();
    if (!inbound) return false;
    const stored = getLastSyncedMsgIdLoose(expectedChatId);
    if (inbound === stored) return false;
    if (this.reader.isLastBubbleMessageOut()) return false;
    return true;
  }

  /**
   * 请求后端前等待：客户最后一条 message-in 的 id 稳定满 2s；若已无需回复则中止
   * @param {string} chatId
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async _waitStableInboundTwoSecondsForReply(chatId) {
    const maxMs = 90000;
    const stableNeedMs = randomBetween(30000, 40000);
    const t0 = Date.now();
    let lastId = "";
    let stableStart = null;

    while (Date.now() - t0 < maxMs) {
      if (!this._isUiChatMatchingExpected(chatId)) {
        return { ok: false, reason: "chat_switched" };
      }
      if (!this._rightPanelWantsReplyForExpectedChat(chatId)) {
        return { ok: false, reason: "no_reply_needed" };
      }
      const id = this.reader.getLastCustomerInboundMsgId();
      if (!id) {
        await sleep(120);
        continue;
      }
      if (id !== lastId) {
        // id 改变代表客户尾部消息还在变化，重新计时。
        lastId = id;
        stableStart = Date.now();
      } else if (stableStart && Date.now() - stableStart >= stableNeedMs) {
        return { ok: true };
      }
      await sleep(120);
    }
    return { ok: false, reason: "timeout" };
  }

  async _resolveStaffIdForPayload() {
    // staffId 来自 background 设置；读取失败时降级为空，避免阻塞自动回复流程。
    let staffId = "";
    try {
      const settingsRes = await chrome.runtime.sendMessage({
        type: BG_MESSAGE_TYPES.GET_SETTINGS
      });
      if (settingsRes?.ok && settingsRes?.data) {
        staffId = settingsRes.data.STAFF_ID || "";
      }
    } catch (error) {
      if (
        error?.message?.includes("context invalidated") ||
        error?.message?.includes("port closed")
      ) {
        logger.warn("读取设置时扩展上下文失效，使用空客服 ID");
      } else {
        logger.warn("读取客服 ID 失败", error?.message);
      }
    }
    return staffId;
  }

  async executeChatTask(chat, { justOpened = false } = {}) {
    // 单个聊天的处理流程：
    // 1. 等 DOM 稳定
    // 2. 确认最后一条来自客户
    // 3. 读取断点后的待处理消息和历史上下文
    // 4. 请求后端决策
    // 5. 执行发送动作并记录同步点
    await sleep(justOpened ? 1500 : 800);

    // 【校验点0】打开聊天后等待 DOM chatId 切换完成
    if (justOpened) {
      await this.store.setState({
        currentAction: `等待会话切换完成：${chat.chatId}`
      });
      const switchOk = await this._waitForChatIdSwitch(chat.chatId, 5000);
      if (!switchOk) {
        const uiChatId = this.dom.getCurrentChatId();
        const msg = `chatId 切换超时：期望 ${chat.chatId}，当前面板 ${uiChatId || "空"}`;
        await this.store.setState({
          lastError: msg,
          currentAction: msg
        });
        logger.warn("打开聊天后 DOM chatId 未切换到目标", { expectedChatId: chat.chatId, uiChatId });
        return;
      }
    }

    // 【校验点1】读取消息前校验 chatId
    const check1 = await this._assertChatIdMatch(chat.chatId, "读取消息前");
    if (!check1.ok) return;

    await this.reader.waitForMessageDomSettled({
      maxMs: justOpened ? 3000 : 2000,
      pollMs: 160,
      stableNeedMs: justOpened ? 550 : 450,
      minRows: 1
    });

    const maxObserverRounds = 15;

    for (let round = 0; round < maxObserverRounds; round += 1) {

      if (round > 0 && !this._isUiChatMatchingExpected(chat.chatId)) {
        const actualChatId = this.dom.getCurrentChatId();
        await this.store.setState({
          lastError: `观察期间会话已切换：期望 ${chat.chatId}，当前 ${actualChatId || "空"}`,
          currentAction: `观察期间会话已切换，中止：${chat.chatId}`
        });
        logger.warn("观察轮次中右侧会话已切换", { expectedChatId: chat.chatId, actualChatId });
        return;
      }
      // 同一聊天内允许最多 15 轮观察，处理“机器人刚回复，客户马上又补充”的情况。
      await this.store.setState({
        currentAction:
          round === 0
            ? "正在读取聊天上下文..."
            : "检测到客户新消息，重新读取上下文..."
      });

      if (!this.reader.isLastThreadMessageFromCustomer()) {
        // 末尾不是客户消息时不能重复发送，避免对自己的回复再次回复。
        if (round === 0) {
          await this.store.setState({
            currentAction: "最后一条为我方消息，跳过回复"
          });
          logger.info(
            "跳过回复：最后一条消息不是来自客户",
            chat.chatId
          );
        }
        return;
      }

      await this.store.setState({
        currentAction: "等待客户最后一条消息稳定..."
      });
      const stable = await this._waitStableInboundTwoSecondsForReply(chat.chatId);
      if (!stable.ok) {
        if (stable.reason === "no_reply_needed") {
          await this.store.setState({
            currentAction: `等待后已无需回复或已与缓存一致，跳过：${chat.chatId}`
          });
        } else if (stable.reason === "chat_switched") {
          await this.store.setState({
            currentAction: `等待期间右侧会话已切换，跳过：${chat.chatId}`
          });
        } else {
          await this.store.setState({
            currentAction: `等待消息稳定超时，跳过：${chat.chatId}`
          });
        }
        logger.info("消息稳定性检查中止", chat.chatId, stable.reason);
        return;
      }

      // 【防重复】稳定后立即同步持久化当前 inbound msgId，防止 observer 轮次 / 右面板优先路径重复请求后端
      const currentInboundId = this.reader.getLastCustomerInboundMsgId();
      const alreadySyncedId = getLastSyncedMsgIdLoose(chat.chatId);
      if (currentInboundId && currentInboundId === alreadySyncedId) {
        logger.info("稳定后检查：客户消息已处理过，跳过重复请求", chat.chatId);
        return;
      }
      if (currentInboundId) {
        await this._persistCustomerInboundAsLastSynced(chat.chatId, currentInboundId);
      }

      const lastAssistantGroup = this.reader.findLastAssistantMessageGroup();
      const pendingMessages =
        this.reader.readPendingMessagesAfterLastAssistantGroup(lastAssistantGroup);

      await this.store.setState({
        currentAction: "正在解析消息结构..."
      });

      const staffId = await this._resolveStaffIdForPayload();

      // 【校验点2】构建 payload 前校验 chatId（消息已读取，此时 UI 必须仍然一致）
      const check2 = await this._assertChatIdMatch(chat.chatId, "构建请求前");
      if (!check2.ok) return;

      const allRawForHistory = this.reader.getAllRawMessages();
      // history 只取末尾窗口，避免请求体过大；parser 会再过滤无展示内容的消息。
      const rawHistoryMessages =
        allRawForHistory.length <= HISTORY_MESSAGE_LIMIT
          ? allRawForHistory
          : allRawForHistory.slice(
              -Math.min(allRawForHistory.length, HISTORY_RAW_LOOKBACK)
            );

      const payload = await this.parser.buildRequestPayload({
        autoReplyStatus: true,
        staffId,
        chatId: chat.chatId,
        rawLastAssistantMsg: null,
        rawLastAssistantGroup: lastAssistantGroup,
        rawPendingContent: pendingMessages,
        rawHistoryMessages
      });

      const pending = payload?.anchorData?.pendingContent || [];
      if (!pending.length) {
        // 没有断点后的客户消息时直接结束，防止空内容请求后端。
        if (round === 0) {
          await this.store.setState({
            currentAction: "断点后没有新的客户消息，跳过"
          });
          logger.info(
            "最后一个助手组后没有待处理的消息",
            chat.chatId
          );
        }
        return;
      }

      await this.store.setState({
        currentAction: "正在请求后端生成回复..."
      });

      const res = await chrome.runtime.sendMessage({
        // 后端请求走 background，便于统一处理跨域、状态和文件下载。
        type: BG_MESSAGE_TYPES.REQUEST_REPLY_DECISION,
        payload
      });

      if (!res?.ok) {
        const errText = res?.error || "后端请求失败";
        throw new Error(errText);
      }

      const decision = res.data || {};
      const intent = decision.intent || BACKEND_INTENTS.NONE;
      const resolvedActions = Array.isArray(decision.resolvedActions)
        ? decision.resolvedActions
        : [];

      logger.debug("后端决策详情", {
        intent,
        decision
      });

      if (intent === BACKEND_INTENTS.NONE || !resolvedActions.length) {
        // 后端明确不回复时，也要记录同步点，避免下一轮重复处理同一条客户消息。
        await this.store.setState({
          currentAction: "后端返回不回复"
        });
        logger.info("后端意图为无操作", chat.chatId);
        await this._persistCurrentInboundTailAsLastSynced(chat.chatId);
        return;
      }

      const autoReplyStatus = this.store.getState().autoReplyStatus;
      if (!autoReplyStatus) {
        await this.store.setState({
          currentAction: "已禁用自动回复，跳过发送"
        });
        logger.info("自动回复状态已禁用，跳过发送", chat.chatId);
        return;
      }

      await this.store.setState({
        currentAction: `后端返回 ${intent}，准备执行发送动作...`
      });

      const check3 = await this._assertChatIdMatch(chat.chatId, "发送前");
      if (!check3.ok) {
        const msg3 = `发送前 chatId 校验失败：期望 ${chat.chatId}，当前 ${check3.uiChatId || "空"}`;
        throw new Error(`CHAT_ID_MISMATCH: ${msg3}`);
      }

      await this.sender.executeDecision({
        intent,
        actions: resolvedActions,
        expectedChatId: chat.chatId
      });

      // 发送动作执行后，记录当前客户消息尾部为已处理。
      await this._persistCurrentInboundTailAsLastSynced(chat.chatId);

      const outOk = await this._waitUntilLastBubbleIsOut();
      if (!outOk) {
        await this.store.setState({
          currentAction: "等待我方消息出现在末尾超时，结束本会话"
        });
        logger.warn("等待发送消息超时", chat.chatId);
        return;
      }

      const baselineBubbleId = this.reader.getLastBubbleMsgId();
      const nextStep = await this._observeTwoSecondsAfterReply(
        chat.chatId,
        baselineBubbleId
      );

      if (nextStep === "repeat") {
        // 客户 2 秒内追加了新消息，继续本聊天的下一轮读取。
        continue;
      }

      await this.store.setState({
        currentAction: `客户 ${chat.chatId} 处理完成`
      });
      await sleep(500);
      return;
    }

    await this.store.setState({
      currentAction: `客户 ${chat.chatId} 观察者轮次过多，已停止`
    });
    logger.warn("执行聊天任务超过最大观察轮数", chat.chatId);
  }

  async cooldownPhase() {
    // 每轮处理结束后随机冷却，降低连续快速操作对 WhatsApp 页面的压力。
    let min = 10000;
    let max = 20000;

    try {
      const settingsRes = await chrome.runtime.sendMessage({
        type: BG_MESSAGE_TYPES.GET_SETTINGS
      });

      if (settingsRes?.ok && settingsRes?.data) {
        min = Number(settingsRes.data.COOLDOWN_MIN_MS || 3000);
        max = Number(settingsRes.data.COOLDOWN_MAX_MS || 5000);
      }
    } catch (error) {
      // 如果读取冷却时间设置失败，使用默认值
      logger.warn("读取冷却时间设置失败，使用默认值", error);
    }

    const cooldownMs = randomBetween(min, max);

    await this.store.setState({
      appState: APP_STATES.COOLDOWN,
      currentChatId: "",
      currentAction: `本轮完成，休眠中... ${cooldownMs}ms`,
      queueProgressText: "0/0",
      scanScrollProgressText: "--"
    });

    logger.info("本轮处理完成，进入冷却等待", { cooldownMs });

    await this.cursor.restAtCorner();
    await sleep(cooldownMs);
  }

  dumpQueueStatus() {
    // 调试辅助：把 Map 转成普通对象，方便在控制台查看。
    const result = {};
    for (const [chatId, status] of this.queueManager.chatStatusMap.entries()) {
      result[chatId] = status;
    }
    return result;
  }

  setChatStatus(chatId, status = CHAT_STATUS.PENDING, lastMsgTime = "") {
    // 调试/手动干预入口：允许外部直接设置某个聊天的队列状态。
    this.queueManager.setStatus(chatId, {
      status,
      lastMsgTime
    });
  }
}
