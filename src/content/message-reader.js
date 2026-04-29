/**
 * content/message-reader.js
 *
 * 已接入 utils 常量与日志的消息读取器
 * 负责读取当前已打开聊天窗口中的消息 DOM
 */

import { MESSAGE_TYPES } from "../utils/constants.js";
import { createShortKey } from "../utils/hash.js";
import { sleep } from "../utils/time.js";
import { logger } from "../utils/logger.js";

export class WhatsAppMessageReader {
  constructor() {
    this.SELECTORS = {
      messageIn: ".message-in",
      messageOut: ".message-out",
      copyableText: ".copyable-text",
      selectableText: 'span[data-testid="selectable-text"]',
      imageOpenButton: 'div[aria-label="打开图片"]',
      audioPlayButton: 'button[aria-label="播放语音消息"]',
      attachButton: 'button[data-tab="10"][aria-label="附加"]',
      sendButton: 'button[data-tab="11"][aria-label="发送"]',
      voiceButton: 'button[data-tab="11"][aria-label="语音消息"]',
      cartText: '[title="查看已收到的购物车"]',
      fileDownloadTitleNode: '[title^="下载"]'
    };
  }

  /**
   * @param {Element} el
   * @returns {boolean}
   */
  _elementIsMessageIn(el) {
    return Boolean(el?.classList?.contains("message-in"));
  }

  /**
   * @param {Element} el
   * @returns {boolean}
   */
  _elementIsMessageOut(el) {
    return Boolean(el?.classList?.contains("message-out"));
  }

  /**
   * 会话最后一条气泡是否为客户（仅此时应继续自动回复流程）
   * @returns {boolean}
   */
  isLastThreadMessageFromCustomer() {
    const all = this.getAllMessageElements();
    if (!all.length) return false;
    const lastEl = all[all.length - 1];
    if (this._elementIsMessageOut(lastEl)) return false;
    if (this._elementIsMessageIn(lastEl)) return true;
    return false;
  }

  /**
   * 同步 / 自动回复共用的锚点读取（含可选一次重试）
   * @returns {Promise<{ assistantMsgGroup: Object[], pendingContent: Object[], lastCustomerInboundMsgId: string }>}
   */
  async readCoreAnchorDataForSync() {
    let data = this._readCoreAnchorDataOnce();

    const suspectStale =
      data.pendingContent.length > 0 &&
      data.assistantMsgGroup.length === 0 &&
      this._mainShowsStaffOutButNoAssistantGroup(data);

    if (suspectStale) {
      await sleep(500);
      data = this._readCoreAnchorDataOnce();
    }

    logger.debug("读取同步锚点核心数据", {
      assistantCount: data.assistantMsgGroup.length,
      pendingCount: data.pendingContent.length,
      lastCustomerInboundMsgId: data.lastCustomerInboundMsgId
    });

    return data;
  }

  /**
   * @returns {{ assistantMsgGroup: Object[], pendingContent: Object[], lastCustomerInboundMsgId: string }}
   */
  _readCoreAnchorDataOnce() {
    const split = this.findPendingTailAndAssistantAbove();
    const { assistantMsgGroup, pendingContent, lastCustomerInboundMsgId } = split;

    return {
      assistantMsgGroup,
      pendingContent,
      lastCustomerInboundMsgId
    };
  }

  /**
   * 尾部连续 message-in 为 pending；其正上方连续 message-out 为 assistant。
   * @returns {{
   *   assistantMsgGroup: Object[],
   *   pendingContent: Object[],
   *   lastAssistantElementIndex: number,
   *   lastCustomerInboundMsgId: string
   * }}
   */
  findPendingTailAndAssistantAbove() {
    const all = this.getAllMessageElements();
    return this._splitPendingTailAndAssistantAboveElements(all);
  }

  /**
   * @param {Element[]} all
   * @returns {{
   *   assistantMsgGroup: Object[],
   *   pendingContent: Object[],
   *   lastAssistantElementIndex: number,
   *   lastCustomerInboundMsgId: string
   * }}
   */
  _splitPendingTailAndAssistantAboveElements(all) {
    const n = all.length;
    let pendingStart = n;
    for (let i = n - 1; i >= 0; i -= 1) {
      if (!this._elementIsMessageIn(all[i])) break;
      pendingStart = i;
    }

    const pendingContent =
      pendingStart < n
        ? all.slice(pendingStart).map((el) => this.extractRawMessage(el))
        : [];

    const assistantEls = [];
    let j = pendingStart - 1;
    while (j >= 0 && this._elementIsMessageOut(all[j])) {
      assistantEls.unshift(all[j]);
      j -= 1;
    }

    const assistantMsgGroup = assistantEls.map((el) => this.extractRawMessage(el));
    const lastAssistantElementIndex =
      assistantEls.length > 0 ? pendingStart - 1 : -1;

    let lastCustomerInboundMsgId = "";
    for (let k = n - 1; k >= 0; k -= 1) {
      if (!this._elementIsMessageIn(all[k])) continue;
      const raw = this.extractRawMessage(all[k]);
      lastCustomerInboundMsgId =
        raw.msgId || this.createMessageFingerprint(raw, k);
      break;
    }

    return {
      assistantMsgGroup,
      pendingContent,
      lastAssistantElementIndex,
      lastCustomerInboundMsgId
    };
  }

  /**
   * 当前窗口最后一条 message-in 的稳定 id（同步进度）；无气泡或 id 时用指纹
   * @returns {string}
   */
  getLastCustomerInboundMsgId() {
    const split = this.findPendingTailAndAssistantAbove();
    return split.lastCustomerInboundMsgId || "";
  }

  /**
   * 当前线程最后一条气泡（任意角色）的稳定 id
   * @returns {string}
   */
  getLastBubbleMsgId() {
    const all = this.getAllMessageElements();
    if (!all.length) return "";
    const idx = all.length - 1;
    const raw = this.extractRawMessage(all[idx]);
    return raw.msgId || this.createMessageFingerprint(raw, idx);
  }

  /**
   * 最后一条气泡是否为我方（message-out）
   * @returns {boolean}
   */
  isLastBubbleMessageOut() {
    const all = this.getAllMessageElements();
    if (!all.length) return false;
    return this._elementIsMessageOut(all[all.length - 1]);
  }

  /**
   * 会话最后一条气泡的稳定 id（用于非同步场景）；无 msgId 时用指纹
   * @returns {string}
   */
  _resolveLastThreadMsgId() {
    const all = this.getAllRawMessages();
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const m = all[i];
      if (m?.msgId) return m.msgId;
    }
    const lastIndex = all.length - 1;
    const last = all[lastIndex];
    if (last) return this.createMessageFingerprint(last, lastIndex);
    return "";
  }

  /**
   * #main 内已有 message-out，但当前解析未得到任何客服组 → 可能误根或未挂载完
   * @param {{ assistantMsgGroup: Object[] }} data
   * @returns {boolean}
   */
  _mainShowsStaffOutButNoAssistantGroup(data) {
    if (data.assistantMsgGroup.length > 0) return false;
    const main = document.querySelector("#main");
    if (!main) return false;
    return Boolean(main.querySelector(this.SELECTORS.messageOut));
  }

  /**
   * 尝试找到主聊天消息区域
   * @returns {Element|null}
   */
  getMessageRoot() {
    const bubbleSel = `${this.SELECTORS.messageIn}, ${this.SELECTORS.messageOut}`;

    const main = document.querySelector("#main");
    if (
      main &&
      (main.querySelector(this.SELECTORS.messageIn) ||
        main.querySelector(this.SELECTORS.messageOut))
    ) {
      return main;
    }

    let best = null;
    let bestCount = 0;
    const candidates = Array.from(document.querySelectorAll("div"));
    for (const el of candidates) {
      const hasIn = el.querySelector?.(this.SELECTORS.messageIn);
      const hasOut = el.querySelector?.(this.SELECTORS.messageOut);
      if (!hasIn && !hasOut) continue;

      const n = el.querySelectorAll(bubbleSel).length;
      if (n > bestCount) {
        bestCount = n;
        best = el;
      }
    }

    if (best) return best;
    return document.body;
  }

  /**
   * 获取当前聊天中所有消息节点，按 DOM 顺序返回
   * @returns {Element[]}
   */
  getAllMessageElements() {
    const root = this.getMessageRoot();
    if (!root) return [];

    return Array.from(
      root.querySelectorAll(`${this.SELECTORS.messageIn}, ${this.SELECTORS.messageOut}`)
    );
  }

  /**
   * 轮询 message-in / message-out 气泡数直至在 stableNeedMs 内不变，减少刚切会话时 DOM 未挂全导致的漏读。
   * @param {Object} [options]
   * @param {number} [options.maxMs]
   * @param {number} [options.pollMs]
   * @param {number} [options.stableNeedMs]
   * @param {number} [options.minRows] 至少该条数后才允许判稳；0 表示允许空窗也计时（一般不推荐）
   * @returns {Promise<{ count: number }>}
   */
  async waitForMessageDomSettled(options = {}) {
    const {
      maxMs = 2000,
      pollMs = 160,
      stableNeedMs = 450,
      minRows = 1
    } = options;

    const t0 = Date.now();
    let last = -1;
    let stableStart = null;

    while (Date.now() - t0 < maxMs) {
      const n = this.getAllMessageElements().length;

      if (n < minRows) {
        last = n;
        stableStart = null;
        await sleep(pollMs);
        continue;
      }

      if (n !== last) {
        last = n;
        stableStart = Date.now();
      } else if (stableStart && Date.now() - stableStart >= stableNeedMs) {
        logger.debug("消息 DOM 已稳定", { count: n, stableNeedMs });
        return { count: n };
      }

      await sleep(pollMs);
    }

    const count = this.getAllMessageElements().length;
    logger.debug("等待消息 DOM 稳定超时", { count, maxMs });
    return { count };
  }

  /**
   * 判断消息角色（message-in / message-out）
   * @param {Element} messageEl
   * @returns {"customer"|"staff"}
   */
  getRoleByElement(messageEl) {
    if (this._elementIsMessageOut(messageEl)) return "staff";
    if (this._elementIsMessageIn(messageEl)) return "customer";
    return "customer";
  }

  /**
   * 规范化 data-id 为 msgId
   * @param {string} rawId
   * @returns {string}
   */
  normalizeMsgId(rawId) {
    const value = String(rawId || "").trim();
    return value || "";
  }

  getMsgId(messageEl) {
    if (!messageEl) return "";

    const selfId = this.normalizeMsgId(messageEl.getAttribute("data-id"));
    if (selfId) return selfId;

    const parent = messageEl.closest?.("[data-id]");
    const parentId = this.normalizeMsgId(parent?.getAttribute?.("data-id"));
    if (parentId) return parentId;

    const inner = messageEl.querySelector("[data-id]");
    const innerId = this.normalizeMsgId(inner?.getAttribute?.("data-id"));
    if (innerId) return innerId;

    return "";
  }

  /**
   * 获取 data-pre-plain-text
   * @param {Element} messageEl
   * @returns {string}
   */
  getPrePlainText(messageEl) {
    if (!messageEl) return "";

    const node = messageEl.querySelector(".copyable-text[data-pre-plain-text]");
    return node?.getAttribute("data-pre-plain-text") || "";
  }

  /**
   * 读取纯文本正文
   * @param {Element} messageEl
   * @returns {string}
   */
  getTextContent(messageEl) {
    if (!messageEl) return "";

    const nodes = Array.from(messageEl.querySelectorAll(this.SELECTORS.selectableText));
    const texts = nodes
      .filter((el) => !el.closest?.("div.quoted-mention._ao3e"))
      .map((el) => (el.textContent || "").trim())
      .filter(Boolean);

    return texts.join("\n").trim();
  }

  extractTimeFromTextSources(messageEl) {
    if (!messageEl) return "";

    const fullPattern = /\d{1,2}:\d{2},\s*\d{4}年\d{1,2}月\d{1,2}日/;

    const candidates = Array.from(messageEl.querySelectorAll("[title], span, div, p, a"));
    for (const node of candidates) {
      const title = String(node.getAttribute?.("title") || "").trim();
      const text = String(node.textContent || "").trim();
      const fullMatch = title.match(fullPattern) || text.match(fullPattern);
      if (fullMatch) return fullMatch[0];
    }

    return "";
  }

  extractTimeFromSpecificSpans(messageEl) {
    if (!messageEl) return "";

    const specificSelectors = [
      'span[style*="--x-fontSize"]',
      'span[class*="x193iq5w"]',
      'span[class*="x13faqbe"]'
    ];

    for (const selector of specificSelectors) {
      const spans = Array.from(messageEl.querySelectorAll(selector));
      for (const span of spans) {
        const text = String(span.textContent || "").trim();
        const timeMatch = text.match(/^(\d{1,2}):(\d{2})$/);
        if (timeMatch) {
          return text;
        }
      }
    }

    return "";
  }


  extractTimeForVoiceMessage(messageEl) {
    if (!messageEl) return "";

    const raw = this.getPrePlainText(messageEl);
    if (raw) {
      const match = raw.match(/^\[(.+?)\]/);
      if (match) return match[1];
    }

    const audioParent = messageEl.querySelector(this.SELECTORS.audioPlayButton)?.closest("div") || messageEl;
    const fullTime = this.extractTimeFromTextSources(audioParent);
    if (fullTime && /\d{4}年/.test(fullTime)) {
      return fullTime;
    }

    return this.extractTimeFromSpecificSpans(messageEl) || "";
  }

  extractTimeForFileMessage(messageEl) {
    if (!messageEl) return "";

    const raw = this.getPrePlainText(messageEl);
    if (raw) {
      const match = raw.match(/^\[(.+?)\]/);
      if (match) return match[1];
    }

    const fileNode =
      messageEl.querySelector(this.SELECTORS.fileDownloadTitleNode) ||
      messageEl.querySelector('[title^="下载"]') ||
      messageEl.querySelector('[title*="下载"]') ||
      messageEl.querySelector('[title^="Download"]') ||
      messageEl.querySelector('[title*="Download"]');

    if (fileNode) {
      const fileParent = fileNode.closest("div") || messageEl;
      const fullTime = this.extractTimeFromTextSources(fileParent);
      if (fullTime && /\d{4}年/.test(fullTime)) {
        return fullTime;
      }
    }

    return this.extractTimeFromSpecificSpans(messageEl) || "";
  }

  extractTimeGeneric(messageEl) {
    if (!messageEl) return "";

    const raw = this.getPrePlainText(messageEl);
    if (raw) {
      const match = raw.match(/^\[(.+?)\]/);
      if (match) return match[1];
    }

    const spans = Array.from(messageEl.querySelectorAll('span[data-testid="selectable-text"]'));
    for (const span of spans) {
      const text = (span.textContent || "").trim();
      if (/\d{1,2}:\d{2},\s*\d{4}年\d{1,2}月\d{1,2}日/.test(text)) {
        return text;
      }
    }

    const allSpans = Array.from(messageEl.querySelectorAll("span[title]"));
    for (const span of allSpans) {
      const title = span.getAttribute("title") || "";
      if (/\d{1,2}:\d{2}.*\d{4}年/.test(title)) {
        return title;
      }
    }

    return this.extractTimeFromSpecificSpans(messageEl) || "";
  }

  /**
   * 获取消息时间（原始，不做最终格式化）
   * 多层回退机制确保总能获取时间
   * @param {Element} messageEl
   * @returns {string}
   */
  getRawTime(messageEl) {
    if (!messageEl) return "";

    const type = this.inferMessageType(messageEl);
    if (type === MESSAGE_TYPES.VOICE) {
      return this.extractTimeForVoiceMessage(messageEl) || this.extractTimeGeneric(messageEl);
    }

    if (type === MESSAGE_TYPES.FILE) {
      return this.extractTimeForFileMessage(messageEl) || this.extractTimeGeneric(messageEl);
    }

    return this.extractTimeGeneric(messageEl);
  }

  /**
   * 判断是否图片消息
   * @param {Element} messageEl
   * @returns {boolean}
   */
  /**
   * 联系人卡片（含 default-contact-refreshed 图标）
   * @param {Element} messageEl
   * @returns {boolean}
   */
  isContactMessage(messageEl) {
    if (!messageEl) return false;
    return Boolean(
      messageEl.querySelector('span[data-icon="default-contact-refreshed"]')
    );
  }

  /**
   * 商品链接卡：带 data: 商品图 + 「查看」/特定 span，区别于普通图片
   * @param {Element} messageEl
   * @returns {boolean}
   */
  isProductMessage(messageEl) {
    if (!messageEl) return false;
    const openBtn = messageEl.querySelector(this.SELECTORS.imageOpenButton);
    if (!openBtn) return false;
    const img = openBtn.querySelector('img[src^="data:image/"]');
    if (!img) return false;
    if (messageEl.querySelector('span[data-icon="default-contact-refreshed"]')) {
      return false;
    }
    const hasViewHint =
      Boolean(messageEl.querySelector("span.x1lliihq._ao3e")) ||
      /\b查看\b/.test(messageEl.textContent || "") ||
      /\bView\b/i.test(messageEl.textContent || "");
    return hasViewHint;
  }

  isImageMessage(messageEl) {
    if (!messageEl) return false;
    if (this.isProductMessage(messageEl)) return false;
    return Boolean(messageEl.querySelector(this.SELECTORS.imageOpenButton));
  }

  /**
   * 判断是否语音消息
   * @param {Element} messageEl
   * @returns {boolean}
   */
  isVoiceMessage(messageEl) {
    if (!messageEl) return false;
    return Boolean(messageEl.querySelector(this.SELECTORS.audioPlayButton));
  }

  /**
   * 判断是否视频消息
   * @param {Element} messageEl
   * @returns {boolean}
   */
  isVideoMessage(messageEl) {
    if (!messageEl) return false;

    const html = messageEl.innerHTML || "";
    // 修复：同时检查多个可能的视频标识
    const hasMsgVideoIcon = html.includes("msg-video");
    const hasMediaPlayIcon = html.includes("media-play");
    const hasPlayButton = Boolean(messageEl.querySelector('button[aria-label*="play"], button[aria-label*="播放"]'));

    if (!hasMsgVideoIcon && !hasMediaPlayIcon && !hasPlayButton) {
      return false;
    }

    // 验证是否包含背景图像（base64格式的视频封面）
    const hasBackgroundImage = html.includes("background-image") || html.includes("data:image/jpeg");
    
    return hasBackgroundImage;
  }

  /**
   * 判断是否购物车消息
   * @param {Element} messageEl
   * @returns {boolean}
   */
  isCartMessage(messageEl) {
    if (!messageEl) return false;
    const text = messageEl.textContent || "";
    return text.includes("件商品") && text.includes("查看已收到的购物车");
  }

  /**
   * 判断是否文件消息（重点是 pdf）
   * @param {Element} messageEl
   * @returns {boolean}
   */
  isFileMessage(messageEl) {
    if (!messageEl) return false;

    const titleNode =
      messageEl.querySelector(this.SELECTORS.fileDownloadTitleNode) ||
      messageEl.querySelector('[title^="下载"]') ||
      messageEl.querySelector('[title*="下载"]') ||
      messageEl.querySelector('[title^="Download"]') ||
      messageEl.querySelector('[title*="Download"]');
    if (titleNode) return true;

    if (messageEl.querySelector('[data-icon="document-W-icon"]')) return true;

    const html = messageEl.innerHTML || "";
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar)\b/i.test(html)) return true;

    return false;
  }

  /**
   * 判断是否广告卡片消息（Meta 经典样式或其它平台外链卡片）
   * @param {Element} messageEl
   * @returns {boolean}
   */
  isAdCardMessage(messageEl) {
    if (!messageEl) return false;

    const html = messageEl.innerHTML || "";
    const hasFbIcon = html.includes("logo-facebook-round");
    const hasFbLink = Boolean(messageEl.querySelector('a[href*="fb.me"]'));
    if (hasFbIcon && hasFbLink) return true;

    const anchors = Array.from(messageEl.querySelectorAll('a[href^="http"]'));
    const hasOffsitePromo = anchors.some((a) => {
      const href = a.getAttribute("href") || "";
      try {
        const h = new URL(href).hostname.replace(/^www\./i, "").toLowerCase();
        return (
          Boolean(h) &&
          !h.endsWith("whatsapp.com") &&
          !h.endsWith("whatsapp.net") &&
          h !== "wa.me"
        );
      } catch {
        return false;
      }
    });

    const titledBlocks = messageEl.querySelectorAll("div[title]").length;
    if (hasOffsitePromo && titledBlocks >= 2) return true;
    if (hasOffsitePromo && hasFbIcon) return true;

    return false;
  }

  /**
   * 推断消息类型（按优先级排序避免误判）
   * 与 MESSAGE_TYPE_PRIORITY + CART(介于 PRODUCT 与 IMAGE) 一致
   * AD_CARD → FILE → CONTACT → PRODUCT → CART → IMAGE → VIDEO → VOICE → TEXT
   * @param {Element} messageEl
   * @returns {string}
   */
  inferMessageType(messageEl) {
    if (this.isAdCardMessage(messageEl)) return MESSAGE_TYPES.AD_CARD;
    if (this.isFileMessage(messageEl)) return MESSAGE_TYPES.FILE;
    if (this.isContactMessage(messageEl)) return MESSAGE_TYPES.CONTACT;
    if (this.isProductMessage(messageEl)) return MESSAGE_TYPES.PRODUCT;
    if (this.isCartMessage(messageEl)) return MESSAGE_TYPES.CART;
    if (this.isImageMessage(messageEl)) return MESSAGE_TYPES.IMAGE;
    if (this.isVideoMessage(messageEl)) return MESSAGE_TYPES.VIDEO;
    if (this.isVoiceMessage(messageEl)) return MESSAGE_TYPES.VOICE;
    return MESSAGE_TYPES.TEXT;
  }

  /**
   * 提取一条消息的原始结构
   * @param {Element} messageEl
   * @returns {Object}
   */
  extractRawMessage(messageEl) {
    const role = this.getRoleByElement(messageEl);
    const type = this.inferMessageType(messageEl);
    let msgId = this.getMsgId(messageEl);
    if (!msgId) {
      const stable = `${role}|${type}|${this.getRawTime(messageEl)}|${String(
        this.getTextContent(messageEl) || ""
      ).slice(0, 200)}|${String(this.getPrePlainText(messageEl) || "").slice(0, 120)}`;
      msgId = `local_${createShortKey(stable)}`;
    }

    return {
      element: messageEl,
      role,
      type,
      msgId,
      rawTime: this.getRawTime(messageEl),
      rawHeader: this.getPrePlainText(messageEl),
      textContent: this.getTextContent(messageEl)
    };
  }

  createMessageFingerprint(raw = {}, index = 0) {
    const role = String(raw.role || "");
    const type = String(raw.type || "");
    const msgId = String(raw.msgId || "");
    const rawTime = String(raw.rawTime || "");
    const textContent = String(raw.textContent || "");
    const rawHeader = String(raw.rawHeader || "");
    return `${role}|${type}|${msgId}|${rawTime}|${textContent}|${rawHeader}|${index}`;
  }

  /**
   * 找最后一条我方消息（紧贴 pending 上方的连续 message-out 组最后一条）
   * @returns {Object|null}
   */
  findLastAssistantMessage() {
    const group = this.findLastAssistantMessageGroup();
    const arr = Array.isArray(group) ? group : [];
    if (!arr.length) {
      logger.debug("未找到最后一条我方消息");
      return null;
    }
    const found = arr[arr.length - 1];
    logger.debug("已找到最后一条我方消息", found);
    return found;
  }

  /**
   * 最后一组连续客服消息：pending 尾段 message-in 正上方的连续 message-out。
   * @returns {Object[] & { lastElementIndex: number }}
   */
  findLastAssistantMessageGroup() {
    const split = this.findPendingTailAndAssistantAbove();
    const group = split.assistantMsgGroup;
    const lastElementIndex = split.lastAssistantElementIndex;

    if (!group.length) {
      logger.debug("未找到待处理消息上方的我方消息组");
      return Object.assign([], { lastElementIndex: -1 });
    }

    logger.debug("已找到最后一组我方消息", {
      count: group.length,
      lastElementIndex
    });

    return Object.assign([...group], { lastElementIndex });
  }

  /**
   * 在一段 raw 消息上计算 assistantMsgGroup / pendingContent（与 DOM message-in/out 规则一致）
   * @param {Object[]} rawList extractRawMessage 结构
   * @returns {{ assistantMsgGroup: Object[], pendingContent: Object[] }}
   */
  computeAnchorFromRawList(rawList = []) {
    if (!Array.isArray(rawList) || rawList.length === 0) {
      return { assistantMsgGroup: [], pendingContent: [] };
    }

    const n = rawList.length;
    let pendingStart = n;
    for (let i = n - 1; i >= 0; i -= 1) {
      if (rawList[i].role !== "customer") break;
      pendingStart = i;
    }

    const pendingContent =
      pendingStart < n ? rawList.slice(pendingStart) : [];

    const assistantMsgGroup = [];
    let j = pendingStart - 1;
    while (j >= 0 && rawList[j].role === "staff") {
      assistantMsgGroup.unshift(rawList[j]);
      j -= 1;
    }

    return { assistantMsgGroup, pendingContent };
  }

  /**
   * 在 raw 列表中定位曾记录的「线程尾部 id」（msgId 或指纹），用于增量切片
   * @param {Object[]} all
   * @param {string} storedId
   * @returns {number}
   */
  findRawIndexByStoredThreadTailId(all, storedId) {
    if (!storedId || !Array.isArray(all) || !all.length) return -1;
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const m = all[i];
      const sid = m?.msgId || this.createMessageFingerprint(m, i);
      if (sid === storedId) return i;
    }
    return -1;
  }

  /**
   * 当前线程最后一条消息的 msgId 或指纹（用于同步比对）
   * @returns {string}
   */
  getLastThreadMsgId() {
    return this._resolveLastThreadMsgId();
  }

  /**
   * 找最后一条我方消息的索引（DOM 下标）
   * @returns {number}
   */
  findLastAssistantMessageIndex() {
    const split = this.findPendingTailAndAssistantAbove();
    return typeof split.lastAssistantElementIndex === "number"
      ? split.lastAssistantElementIndex
      : -1;
  }

  /**
   * 尾部连续 message-in（与 findPendingTailAndAssistantAbove 一致）
   * @returns {Object[]}
   */
  readPendingMessagesAfterLastAssistant() {
    const { pendingContent } = this.findPendingTailAndAssistantAbove();

    logger.debug("读取最后一条我方消息后的待处理消息", {
      lastAssistantIndex: this.findLastAssistantMessageIndex(),
      count: pendingContent.length
    });

    return pendingContent;
  }

  /**
   * 尾部连续 message-in（cachedGroup 参数保留兼容，忽略并统一从 DOM 重算）
   * @param {Object[] & { lastElementIndex?: number }} [_cachedGroup]
   * @returns {Object[]}
   */
  readPendingMessagesAfterLastAssistantGroup(_cachedGroup) {
    const { pendingContent, lastAssistantElementIndex } =
      this.findPendingTailAndAssistantAbove();

    logger.debug("读取最后一组我方消息后的待处理消息", {
      lastGroupIndex: lastAssistantElementIndex,
      pendingCount: pendingContent.length
    });

    return pendingContent;
  }

  getAllRawMessages() {
    const all = this.getAllMessageElements();
    return all.map((el) => this.extractRawMessage(el));
  }

  readMessagesForSync(anchor = null) {
    const allMessages = this.getAllRawMessages();
    const normalizedAnchor = anchor && typeof anchor === "object" ? anchor : null;

    if (!allMessages.length) {
      return {
        assistantMsgGroup: [],
        pendingContent: [],
        lastMessage: null,
        nextAnchor: null,
        hasDelta: false,
        totalMessages: 0
      };
    }

    let startIndex = 0;
    if (normalizedAnchor) {
      const anchorIndex = allMessages.findIndex((message, index) => {
        if (normalizedAnchor.msgId && message.msgId) {
          return message.msgId === normalizedAnchor.msgId;
        }

        const fingerprint = this.createMessageFingerprint(message, index);
        return fingerprint === normalizedAnchor.fingerprint;
      });

      if (anchorIndex >= 0) {
        startIndex = anchorIndex + 1;
      }
    }

    const deltaMessages = allMessages.slice(startIndex);
    const firstCustomerDeltaIndex = deltaMessages.findIndex((message) => message.role === "customer");

    let assistantMsgGroup = [];
    let pendingContent = [];

    if (firstCustomerDeltaIndex >= 0) {
      assistantMsgGroup = deltaMessages
        .slice(0, firstCustomerDeltaIndex)
        .filter((message) => message.role === "staff");
      pendingContent = deltaMessages
        .slice(firstCustomerDeltaIndex)
        .filter((message) => message.role === "customer");
    } else {
      assistantMsgGroup = deltaMessages.filter((message) => message.role === "staff");
      pendingContent = deltaMessages.filter((message) => message.role === "customer");
    }

    const lastIndex = allMessages.length - 1;
    const lastMessage = allMessages[lastIndex] || null;
    const nextAnchor = lastMessage
      ? {
          msgId: lastMessage.msgId || "",
          fingerprint: this.createMessageFingerprint(lastMessage, lastIndex)
        }
      : null;

    logger.debug("读取消息同步增量", {
      anchor: normalizedAnchor,
      startIndex,
      assistantCount: assistantMsgGroup.length,
      pendingCount: pendingContent.length,
      totalMessages: allMessages.length
    });

    return {
      assistantMsgGroup,
      pendingContent,
      lastMessage,
      nextAnchor,
      hasDelta: deltaMessages.length > 0,
      totalMessages: allMessages.length
    };
  }

  /**
   * 读取当前聊天 anchorData
   * @returns {Promise<Object>}
   */
  async readAnchorData() {
    await sleep(600);
    const lastAssistantMsg = this.findLastAssistantMessage();
    const pendingContent = this.readPendingMessagesAfterLastAssistant();

    const anchorData = {
      lastAssistantMsg,
      pendingContent
    };

    logger.debug("读取当前聊天锚点数据", anchorData);
    return {
      anchorData
    };
  }
}