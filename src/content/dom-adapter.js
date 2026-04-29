/**
 * content/dom-adapter.js
 *
 * 负责所有 WhatsApp Web DOM 适配
 * 原则：
 * 1. 尽量不用动态 class
 * 2. 优先依赖 aria / role / data-tab / title / 文本内容
 * 3. 提供扫描、滚动、查找、点击辅助函数
 */

import { logger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";
import { chatIdsDigitsEqual } from "../utils/chat-id.js";

/**
 * 本文件只做 DOM 读写，不保存业务状态。
 * WhatsApp Web 的 class 经常变化，这里优先使用 aria、role、title、文本等相对稳定的信息。
 */

/**
 * 判断元素是否有真实渲染尺寸。
 * 只检查尺寸，不判断 opacity / visibility，适合筛掉虚拟列表里的空壳节点。
 * @param {Element|null} el
 * @returns {boolean}
 */
function isElementVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * 清理 WhatsApp 文本里的隐藏方向字符和多余空白，方便做文本比较。
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  return (text || "")
    .replace(/\u200e/g, "")
    .replace(/\u200f/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class WhatsAppDomAdapter {
  constructor() {
    // 所有选择器集中在这里，WhatsApp DOM 变动时优先从这里修。
    this.SELECTORS = {
      unreadFilterTabButtons: 'div[role="tablist"][aria-label="chat-list-filters"] button[role="tab"]',
      unreadFilterButton: 'button[data-tab="3"][aria-controls="chat-list"]',
      unreadFilterButtonById: 'button#label_item_1[role="tab"]',
      unreadFilterButtonAltEn: 'button[aria-label*="Unread"][role="tab"]',
      unreadFilterButtonAltZh: 'button[aria-label*="未读"][role="tab"]',
      paneSide: "#pane-side",
      chatListGrid: 'div[aria-label="聊天列表"][role="grid"]',
      chatRows: '#pane-side div[role="grid"] div[role="row"]',
      chatRowsFallback: '#pane-side div[role="row"]',
      unreadBadgeZh: 'span[aria-label*="未读"], span[aria-label*="条未读消息"]',
      unreadBadgeEn: 'span[aria-label*="unread"]',
      chatName: 'span[dir="auto"][title]',
      clickableChatNode: 'div[tabindex="0"][aria-selected]',
      chatsNavButtonZh: 'button[data-navbar-item][aria-label="对话"]',
      chatsNavButtons: "button[data-navbar-item]"
    };
  }

  /**
   * 主导航「对话 / Chats」按钮
   * @returns {Element|null}
   */
  getChatsNavButton() {
    const zh = document.querySelector(this.SELECTORS.chatsNavButtonZh);
    if (zh) return zh;

    const buttons = Array.from(document.querySelectorAll(this.SELECTORS.chatsNavButtons));
    const hit = buttons.find((btn) => {
      const label = normalizeText(btn.getAttribute("aria-label") || "");
      if (!label) return false;
      if (label === "对话") return true;
      if (/^chats?$/i.test(label)) return true;
      if (/聊天|訊息|消息/i.test(label)) return true;
      return false;
    });
    return hit || null;
  }

  /**
   * 主导航是否已选中「对话」列表（左侧聊天列表可见前提）
   * @returns {boolean}
   */
  isChatsNavSelected() {
    const btn = this.getChatsNavButton();
    if (!btn) return false;

    if (btn.getAttribute("data-navbar-item-selected") === "true") return true;

    const pressed = btn.getAttribute("aria-pressed") || "";
    if (pressed.startsWith("true")) return true;

    const selected = btn.getAttribute("aria-selected");
    if (selected === "true") return true;

    const current = btn.getAttribute("aria-current");
    if (current === "true" || current === "page") return true;

    return false;
  }

  /**
   * 确保选中主导航「对话」，以便出现 #pane-side 聊天列表
   * @param {{ moveToElement?: Function, clickEffect?: Function }|null} cursor
   * @param {number} maxAttempts
   * @returns {Promise<boolean>}
   */
  async ensureChatsNavSelected(cursor = null, maxAttempts = 4) {
    if (this.isChatsNavSelected() && this.getPaneSide()) {
      return true;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const btn = this.getChatsNavButton();
      if (!btn) {
        logger.warn("未找到 WhatsApp 对话导航按钮");
        await sleep(400);
        continue;
      }

      if (this.isChatsNavSelected() && this.getPaneSide()) {
        return true;
      }

      if (cursor) {
        await cursor.moveToElement(btn);
        await cursor.clickEffect();
      }

      try {
        btn.click();
      } catch (error) {
        logger.warn("点击 WhatsApp 对话导航失败", { attempt: attempt + 1, error: String(error) });
      }
      this.dispatchHybridClick(btn);
      await sleep(700);

      if (this.isChatsNavSelected() && this.getPaneSide()) {
        return true;
      }
    }

    logger.warn("无法激活 WhatsApp 对话导航");
    return Boolean(this.getPaneSide());
  }

  /**
   * 扫描前：先「对话」再「未读」筛选
   * @param {{ moveToElement?: Function, clickEffect?: Function }|null} cursor
   * @returns {Promise<boolean>}
   */
  async ensureUnreadListForScan(cursor = null) {
    await this.ensureChatsNavSelected(cursor);
    return this.clickUnreadFilter(cursor);
  }

  /**
   * 等待 WhatsApp 聊天列表加载完成
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async waitUntilReady(timeoutMs = 20000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const pane = this.getPaneSide();
      if (pane) return true;
      await sleep(500);
    }

    return false;
  }

  getUnreadFilterButton() {
    // 新版 WhatsApp 会把筛选按钮放在 tablist 内，先按文本/aria 找，找不到再走旧选择器。
    const tabButtons = Array.from(document.querySelectorAll(this.SELECTORS.unreadFilterTabButtons));
    if (tabButtons.length) {
      const byText = tabButtons.find((btn) => normalizeText(btn.innerText).includes("未读"));
      if (byText) return byText;

      const byAria = tabButtons.find((btn) => {
        const label = normalizeText(btn.getAttribute("aria-label") || "");
        return /未读|unread/i.test(label);
      });
      if (byAria) return byAria;
    }

    return (
      document.querySelector(this.SELECTORS.unreadFilterButton) ||
      document.querySelector(this.SELECTORS.unreadFilterButtonById) ||
      document.querySelector(this.SELECTORS.unreadFilterButtonAltZh) ||
      document.querySelector(this.SELECTORS.unreadFilterButtonAltEn)
    );
  }

  /**
   * 未读筛选 tab 是否已激活（不依赖语言）
   * WhatsApp Web 可能用 aria-pressed / aria-selected / aria-current
   */
  isUnreadFilterActive() {
    const btn = this.getUnreadFilterButton();
    if (!btn) return false;

    const pressed = btn.getAttribute("aria-pressed");
    if (pressed === "true") return true;

    const selected = btn.getAttribute("aria-selected");
    if (selected === "true") return true;

    const current = btn.getAttribute("aria-current");
    if (current === "true" || current === "page") return true;

    const tabEl = btn.closest('[role="tab"]');
    if (tabEl && tabEl.getAttribute("aria-selected") === "true") return true;

    return false;
  }

  getPaneSide() {
    // #pane-side 是 WhatsApp 左侧聊天列表的外层容器，也是判断页面 ready 的关键节点。
    return document.querySelector(this.SELECTORS.paneSide);
  }

  getChatRows() {
    // 优先取 grid 内 row；部分版本 DOM 缺 aria-label 时使用 fallback。
    const rows = Array.from(document.querySelectorAll(this.SELECTORS.chatRows));
    if (rows.length) return rows;
    return Array.from(document.querySelectorAll(this.SELECTORS.chatRowsFallback));
  }

  /**
   * 找可滚动容器
   * 优先用 pane-side 本身，否则向内查找真正滚动节点
   */
  getScrollableChatContainer() {
    const pane = this.getPaneSide();
    if (!pane) return null;

    if (pane.scrollHeight > pane.clientHeight) {
      return pane;
    }

    const all = [pane, ...pane.querySelectorAll("*")];
    for (const el of all) {
      if (el.scrollHeight > el.clientHeight + 10) {
        return el;
      }
    }

    return pane;
  }

  /**
   * 确保“未读”筛选已开启（已开启则不再重复点击）
   * @param {{ moveToElement?: Function, clickEffect?: Function }|null} cursor
   * @param {number} maxAttempts
   * @returns {Promise<boolean>}
   */
  async clickUnreadFilter(cursor = null, maxAttempts = 4) {
    const btn = this.getUnreadFilterButton();
    if (!btn) {
      logger.warn("未找到 WhatsApp 未读筛选按钮");
      return false;
    }

    if (this.isUnreadFilterActive()) {
      return true;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const targetBtn = this.getUnreadFilterButton() || btn;
      if (cursor) {
        await cursor.moveToElement(targetBtn);
        await cursor.clickEffect();
      }

      try {
        targetBtn.click();
      } catch (error) {
        logger.warn("点击 WhatsApp 未读筛选失败", { attempt: attempt + 1, error: String(error) });
      }
      this.dispatchHybridClick(targetBtn);
      await sleep(600);

      if (this.isUnreadFilterActive()) {
        return true;
      }
    }

    logger.warn("多次点击后仍无法激活未读筛选");
    return false;
  }

  dispatchHybridClick(el) {
    if (!el) return;
    // WhatsApp 有些控件只响应完整鼠标事件序列，单纯 el.click() 不一定触发业务逻辑。
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const type of types) {
      el.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX,
          clientY,
          button: 0
        })
      );
    }
  }

  /**
   * 获取某一行里的 chatName/chatId
   * 优先取 title
   *
   * @param {Element} row
   * @returns {string}
   */
  getChatIdFromRow(row) {
    if (!row) return "";

    const nameNode = row.querySelector(this.SELECTORS.chatName);
    const title = nameNode?.getAttribute("title")?.trim() || "";
    if (title) return title;

    // title 缺失时退回到可见文本，兼容联系人名/手机号被渲染成普通 span 的情况。
    const autoTexts = row.querySelectorAll('span[dir="auto"][title], span[dir="auto"]');
    for (const node of autoTexts) {
      const text = node.textContent?.trim();
      if (text) return text;
    }

    return "";
  }

  /**
   * 提取消息预览时间
   * 这里只做侧边栏时间，不做消息正文时间解析
   * @param {Element} row
   * @returns {string}
   */
  getChatPreviewTime(row) {
    if (!row) return "";
    const spans = Array.from(row.querySelectorAll("span"));
    const found = spans
      .map((el) => (el.textContent || "").trim())
      .find((text) => /^(\d{1,2}:\d{2})$/.test(text));
    return found || "";
  }

  /**
   * 提取侧边栏预览文本
   * @param {Element} row
   * @returns {string}
   */
  getChatPreviewText(row) {
    if (!row) return "";

    const candidates = Array.from(row.querySelectorAll("span[title], span[dir='ltr'], span[dir='auto']"))
      .map((el) => (el.getAttribute("title") || el.textContent || "").trim())
      .filter(Boolean);

    const chatId = this.getChatIdFromRow(row);

    for (const text of candidates) {
      if (text === chatId) continue;
      if (/^\d{1,2}:\d{2}$/.test(text)) continue;
      if (/未读消息|unread/i.test(text)) continue;
      return text;
    }

    return "";
  }

  /**
   * 是否为未读行
   * @param {Element} row
   * @returns {boolean}
   */
  isUnreadRow(row) {
    if (!row) return false;

    // 未读标记在不同语言下的 aria-label 不一致，所以中英文各做一组选择器。
    const zh = row.querySelector(this.SELECTORS.unreadBadgeZh);
    const en = row.querySelector(this.SELECTORS.unreadBadgeEn);

    if (zh || en) return true;

    const text = row.textContent || "";
    return /未读消息|unread/i.test(text);
  }

  /**
   * 是否是需要处理的客户
   * 按你的规则：跳过官方系统类，不含手机号的先跳过
   *
   * @param {string} chatId
   * @returns {boolean}
   */
  isLikelyCustomerChat(chatId) {
    if (!chatId) return false;

    const normalized = String(chatId).trim();

    // 至少包含较长数字串，适配手机号/国际号码
    const digitCount = (normalized.match(/\d/g) || []).length;
    if (digitCount < 6) return false;

    // 跳过一些已知系统类文本
    if (/Facebook Business|WhatsApp Business|Facebook|Kaption|官方|系统/i.test(normalized)) {
      return false;
    }

    return true;
  }

  /**
   * 从行里提取聊天元信息
   * @param {Element} row
   * @returns {Object|null}
   */
  extractChatMetaFromRow(row) {
    if (!row || !isElementVisible(row)) return null;

    // 只把疑似真实客户的行交给后续队列，避免处理系统入口或普通频道。
    const chatId = this.getChatIdFromRow(row);
    if (!this.isLikelyCustomerChat(chatId)) return null;

    return {
      chatId,
      unread: this.isUnreadRow(row),
      previewText: this.getChatPreviewText(row),
      previewTime: this.getChatPreviewTime(row)
    };
  }

  /**
   * 强制滚动到聊天列表顶部
   */
  async scrollChatListToTop() {
    const scroller = this.getScrollableChatContainer();
    if (!scroller) return;
    scroller.scrollTop = 0;
    await sleep(400);
  }

  /**
   * 判断是否到底
   * @returns {boolean}
   */
  isChatListAtBottom() {
    const scroller = this.getScrollableChatContainer();
    if (!scroller) return true;
    
    const scrollTop = scroller.scrollTop;
    const clientHeight = scroller.clientHeight;
    const scrollHeight = scroller.scrollHeight;
    const scrollRemaining = scrollHeight - scrollTop - clientHeight;
    const atBottom = scrollRemaining < 48;
    
    if (scrollRemaining < 100) {
      logger.debug("检查聊天列表是否到达底部", {
        scrollTop,
        clientHeight,
        scrollHeight,
        remaining: scrollRemaining,
        result: atBottom
      });
    }
    
    return atBottom;
  }

  /**
   * 滚动一屏（虚拟列表下可能 scrollTop 不变但可见行变化，需结合锚点判断）
   * @returns {Promise<{ moved: boolean, scrollDelta: number, atBottom: boolean, anchorChanged: boolean }>}
   */
  async scrollChatListOnePage(waitMs = 550) {
    const scroller = this.getScrollableChatContainer();
    if (!scroller) {
      return {
        moved: false,
        scrollDelta: 0,
        atBottom: true,
        anchorChanged: false
      };
    }

    // 记录滚动前后的顶部/底部聊天作为锚点；
    // 虚拟列表有时 scrollTop 不变，但可见行已经替换，所以不能只看 scrollTop。
    const beforeTop = this.getTopVisibleChatId();
    const beforeBottom = this.getBottomVisibleChatId();
    const before = scroller.scrollTop;
    const delta = Math.max(240, scroller.clientHeight - 40);
    scroller.scrollTop = before + delta;
    await sleep(waitMs);

    const after = scroller.scrollTop;
    const scrollDelta = after - before;
    const afterTop = this.getTopVisibleChatId();
    const afterBottom = this.getBottomVisibleChatId();
    const atBottom = this.isChatListAtBottom();

    const anchorChanged =
      (beforeTop && beforeTop !== afterTop) ||
      (beforeBottom && beforeBottom !== afterBottom) ||
      (!beforeTop && afterTop) ||
      (!beforeBottom && afterBottom);

    const moved = Math.abs(scrollDelta) > 2 || anchorChanged;

    return {
      moved,
      scrollDelta,
      atBottom,
      anchorChanged
    };
  }

  /**
   * 微调滚动
   * @param {number} delta
   */
  async nudgeScroll(delta = 160, waitMs = 250) {
    const scroller = this.getScrollableChatContainer();
    if (!scroller) return false;

    const before = scroller.scrollTop;
    scroller.scrollTop = before + delta;
    await sleep(waitMs);

    return scroller.scrollTop !== before;
  }

  /**
   * 获取当前可见未读客户列表
   * @returns {Array<Object>}
   */
  getVisibleUnreadChats() {
    const rows = this.getChatRows();
    const results = [];

    for (const row of rows) {
      const meta = this.extractChatMetaFromRow(row);
      if (!meta) continue;
      if (!meta.unread) continue;
      results.push(meta);
    }

    return results;
  }

  /**
   * 获取当前可见聊天列表（无论是否未读）
   * @returns {Array<Object>}
   */
  getVisibleChats() {
    const rows = this.getChatRows();
    const results = [];

    for (const row of rows) {
      const meta = this.extractChatMetaFromRow(row);
      if (!meta) continue;
      results.push(meta);
    }

    return results;
  }

  /**
   * 记录锚点 A：当前顶部第一个可识别客户
   * @returns {string}
   */
  getTopVisibleChatId() {
    const rows = this.getChatRows();
    for (const row of rows) {
      const meta = this.extractChatMetaFromRow(row);
      if (meta?.chatId) {
        return meta.chatId;
      }
    }
    return "";
  }

  /**
   * 记录锚点 B：当前底部最后一个可识别客户
   * @returns {string}
   */
  getBottomVisibleChatId() {
    const rows = this.getChatRows();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const meta = this.extractChatMetaFromRow(rows[i]);
      if (meta?.chatId) {
        return meta.chatId;
      }
    }
    return "";
  }

  /**
   * 当前 DOM 是否可见某个 chatId
   * @param {string} chatId
   * @returns {Element|null}
   */
  findVisibleRowByChatId(chatId) {
    const rows = this.getChatRows();
    for (const row of rows) {
      const meta = this.extractChatMetaFromRow(row);
      if (meta?.chatId && chatIdsDigitsEqual(meta.chatId, chatId)) {
        return row;
      }
    }
    return null;
  }

  /**
   * 全量滚动查找某个 chatId
   * 这里用于 EXECUTING 阶段找不到目标时的兜底
   *
   * @param {string} chatId
   * @param {number} maxSteps
   * @returns {Promise<Element|null>}
   */
  async locateRowByChatId(chatId, maxSteps = 20) {
    if (!chatId) return null;

    // 先看当前视口，避免不必要地回到顶部导致用户界面跳动。
    let row = this.findVisibleRowByChatId(chatId);
    if (row) return row;

    await this.scrollChatListToTop();

    for (let i = 0; i < maxSteps; i += 1) {
      row = this.findVisibleRowByChatId(chatId);
      if (row) return row;

      const scrollResult = await this.scrollChatListOnePage();
      const moved = scrollResult.moved;
      if (!moved || this.isChatListAtBottom()) {
        row = this.findVisibleRowByChatId(chatId);
        if (row) return row;
        break;
      }
    }

    return null;
  }

  /**
   * 点击打开聊天
   * @param {Element} row
   * @param {CursorVisualizer|null} cursor
   */
  async openChatRow(row, cursor = null) {
    if (!row) return false;
    const meta = this.extractChatMetaFromRow(row);
    const candidates = this.collectRowClickCandidates(row);
    // 同一行里可能有头像、文字、可点击容器等多个节点，逐个尝试直到右侧聊天真正打开。
    for (const clickable of candidates) {
      clickable.scrollIntoView({
        block: "center",
        behavior: "smooth"
      });
      await sleep(220);

      if (cursor) {
        await cursor.moveToElement(clickable);
        await cursor.clickEffect();
      }

      try {
        clickable.click();
      } catch (error) {
        logger.warn("点击聊天行失败", { error: String(error) });
      }
      this.dispatchHybridClick(clickable);

      const opened = await this.waitForChatOpen(meta, row, 2200);
      if (opened) return true;
    }
    return false;
  }

  collectRowClickCandidates(row) {
    // 候选节点按“最像真实点击目标”的顺序排列，最后才回退到整行。
    const list = [
      row.querySelector('div._ak8l'),
      row.querySelector('div[aria-selected][tabindex]'),
      row.querySelector('div[aria-selected]'),
      row.querySelector(this.SELECTORS.clickableChatNode),
      row.querySelector('[tabindex="0"]'),
      row.querySelector('span[dir="auto"][title]'),
      row.querySelector('span[title]'),
      row
    ].filter(Boolean);
    return [...new Set(list)].filter((el) => !this.isAvatarArea(el));
  }

  isAvatarArea(el) {
    // 头像区域点击后可能打开资料卡，不一定进入聊天，所以从候选列表中排除。
    if (!el) return false;
    if (el.tagName === "IMG") return true;
    if (el.closest("img")) return true;
    const cls = String(el.className || "");
    return cls.includes("_ak8h");
  }

  getCurrentChatName() {
    // 右侧聊天头部通常会把联系人名/号码放在 header 的 title 或 dir=auto 节点里。
    const el =
      document.querySelector("header span[title]") ||
      document.querySelector('header [dir="auto"][title]') ||
      document.querySelector('header span[dir="auto"]');
    return normalizeText(el?.getAttribute("title") || el?.innerText || "");
  }

  isLikelyHeaderStatusText(text) {
    // 头部除了名字，还会出现在线状态、最后上线时间、正在输入等，需要排除。
    const normalized = normalizeText(text);
    if (!normalized) return true;
    if (/^(today|昨天|今日)/i.test(normalized)) return true;
    if (/^今天\s*\d{1,2}:\d{2}$/i.test(normalized)) return true;
    if (/^昨天\s*\d{1,2}:\d{2}$/i.test(normalized)) return true;
    if (/^last seen/i.test(normalized)) return true;
    if (/^(online|typing|recording)/i.test(normalized)) return true;
    if (/^\d{1,2}:\d{2}$/.test(normalized)) return true;
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(normalized)) return true;
    if (
      /在线|离线|通话中|正在输入|输入中|最后上线|最近上线|查看过|正在录音|typing|recording/i.test(
        normalized
      )
    ) {
      return true;
    }
    return false;
  }

  extractPhoneLikeText(text) {
    // 从联系人头部文本里提取类似手机号的片段，兼容 +86、空格、短横线。
    const normalized = normalizeText(text);
    const match = normalized.match(/\+?\d[\d\s-]{6,}\d/);
    return match ? normalizeText(match[0]) : "";
  }

  getCurrentChatId() {
    // 首选左侧选中行，因为它和队列来源一致；选中行不可用时再读右侧 header。
    const rows = this.getChatRows();
    for (const row of rows) {
      if (!this.isRowSelected(row)) continue;
      const selectedChatId = this.getChatIdFromRow(row);
      if (selectedChatId) {
        return selectedChatId;
      }
    }

    const headerCandidates = Array.from(
      document.querySelectorAll("header span[title], header [dir='auto'][title], header span[dir='auto']")
    )
      .map((el) => normalizeText(el.getAttribute?.("title") || el.textContent || ""))
      .filter(Boolean);

    for (const text of headerCandidates) {
      if (this.isLikelyHeaderStatusText(text)) continue;
      const phoneLike = this.extractPhoneLikeText(text);
      if (phoneLike) return phoneLike;
      if (this.isLikelyCustomerChat(text)) return text;
    }

    const headerTextNodes = Array.from(document.querySelectorAll("header span[dir='auto'], header span"));
    for (const node of headerTextNodes) {
      const phoneLike = this.extractPhoneLikeText(node.textContent || "");
      if (phoneLike) {
        return phoneLike;
      }
    }

    return this.getCurrentChatName();
  }

  /**
   * 仅从左侧选中行读取 chatId（不读右侧 header）
   * @returns {string}
   */
  getLeftPanelSelectedChatId() {
    const rows = this.getChatRows();
    for (const row of rows) {
      if (!this.isRowSelected(row)) continue;
      const selectedChatId = this.getChatIdFromRow(row);
      if (selectedChatId) {
        return selectedChatId;
      }
    }
    return "";
  }

  /**
   * 仅从右侧 header 读取 chatId
   * @returns {string}
   */
  getRightPanelChatId() {
    const headerCandidates = Array.from(
      document.querySelectorAll("header span[title], header [dir='auto'][title], header span[dir='auto']")
    )
      .map((el) => normalizeText(el.getAttribute?.("title") || el.textContent || ""))
      .filter(Boolean);

    for (const text of headerCandidates) {
      if (this.isLikelyHeaderStatusText(text)) continue;
      const phoneLike = this.extractPhoneLikeText(text);
      if (phoneLike) return phoneLike;
      if (this.isLikelyCustomerChat(text)) return text;
    }

    const headerTextNodes = Array.from(document.querySelectorAll("header span[dir='auto'], header span"));
    for (const node of headerTextNodes) {
      const phoneLike = this.extractPhoneLikeText(node.textContent || "");
      if (phoneLike) {
        return phoneLike;
      }
    }

    return this.getCurrentChatName();
  }

  /**
   * 双重确认 chatId：同时从左侧选中行和右侧 header 读取，两者一致才返回
   * 不一致时返回 null 并记录警告日志，表示 DOM 可能处于切换中间态
   * @returns {string|null} chatId 或 null（不一致时）
   */
  getCurrentChatIdWithConfidence() {
    const leftChatId = this.getLeftPanelSelectedChatId();
    const rightChatId = this.getRightPanelChatId();

    if (!leftChatId && !rightChatId) {
      logger.debug("getCurrentChatIdWithConfidence: 左右面板均未读取到 chatId");
      return "";
    }

    if (!leftChatId || !rightChatId) {
      const found = leftChatId || rightChatId;
      logger.debug("getCurrentChatIdWithConfidence: 只有一侧面板有 chatId", { leftChatId, rightChatId, fallback: found });
      return found;
    }

    if (chatIdsDigitsEqual(leftChatId, rightChatId)) {
      return leftChatId;
    }

    logger.warn("getCurrentChatIdWithConfidence: 左右面板 chatId 不一致，DOM 可能处于切换中间态", {
      leftChatId,
      rightChatId
    });
    return null;
  }

  isRowSelected(row) {
    if (!row) return false;
    return Boolean(
      row.querySelector('div[aria-selected="true"]') ||
        row.querySelector('[aria-selected="true"]')
    );
  }

  async waitForChatOpen(expectedMeta, row = null, timeoutMs = 3000) {
    const start = Date.now();
    const expectedName = normalizeText(expectedMeta?.chatId || "");
    while (Date.now() - start < timeoutMs) {
      // 打开成功需要同时满足右栏主面板存在，避免点击后只选中了行但主聊天区还没渲染。
      const currentName = this.getCurrentChatName();
      const paneReady = Boolean(document.querySelector("#main"));
      if ((expectedName && currentName === expectedName && paneReady) || (this.isRowSelected(row) && paneReady)) {
        return true;
      }
      await sleep(200);
    }
    return false;
  }
}
