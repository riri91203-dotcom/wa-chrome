/**
 * content/message-parser.js
 *
 * 已接入 utils 的消息解析器
 */

import {
  normalizeWhatsAppTime,
  normalizeWhatsAppTimeForMedia,
  mmssToDurationText,
  sleep
} from "../utils/time.js";
import {
  MESSAGE_TYPES,
  MESSAGE_TYPE_PRIORITY,
  HISTORY_MESSAGE_LIMIT
} from "../utils/constants.js";
import { logger } from "../utils/logger.js";

/**
 * 统一 anchor/history 条目标量字段，全部为 String
 * @param {Object} o
 * @returns {{ type: string, content: string, data: string, caption: string, time: string, msgId: string }}
 */
function asMessagePart(o) {
  return {
    type: String(o.type ?? MESSAGE_TYPES.TEXT),
    content: String(o.content ?? ""),
    data: String(o.data ?? ""),
    caption: String(o.caption ?? ""),
    time: String(o.time ?? ""),
    msgId: String(o.msgId ?? "")
  };
}

export class WhatsAppMessageParser {
  constructor() {}

  resolveChatId(fallbackChatId = "") {
    if (fallbackChatId) {
      // 即使有 fallbackChatId 也尝试从 DOM 读取用于对比日志，帮助排查 chatId 错配问题
      try {
        const domChatId = this._readChatIdFromDom();
        if (domChatId && fallbackChatId !== domChatId) {
          // 提取数字进行比较，格式可能不同但数字相同则视为一致
          const fallbackDigits = fallbackChatId.replace(/\D/g, "");
          const domDigits = domChatId.replace(/\D/g, "");
          if (fallbackDigits && domDigits && fallbackDigits !== domDigits) {
            logger.warn("resolveChatId: 传入 chatId 与 DOM chatId 不一致", {
              fallbackChatId,
              domChatId
            });
          }
        }
      } catch (e) {
        // 日志读取失败不影响主流程
      }
      return fallbackChatId;
    }

    return this._readChatIdFromDom();
  }

  /**
   * 从 DOM 读取 chatId（header 区域）
   * @returns {string}
   */
  _readChatIdFromDom() {
    let titleNode =
      document.querySelector("header span[title]") ||
      document.querySelector('header [dir="auto"][title]') ||
      document.querySelector('header span[dir="auto"]');

    let result = titleNode?.getAttribute("title")?.trim() || titleNode?.innerText?.trim() || "";

    if (!result || (result.length < 5 && !/\d{3,}/.test(result))) {
      const phoneElements = document.querySelectorAll(
        'header span, header div, [dir="auto"]'
      );
      for (const el of phoneElements) {
        const text = el.textContent?.trim() || el.innerText?.trim() || "";
        if (/^\+\d+\s+\d+/.test(text) || /^\d+\s+\d+\s+\d+/.test(text)) {
          result = text;
          break;
        }
      }
    }

    return result;
  }

  normalizeTime(rawTime = "") {
    return normalizeWhatsAppTime(rawTime);
  }

  /**
   * 按消息类型归一化时间（语音/文件无完整日期时仅 HH:mm）
   * @param {string} rawTime
   * @param {string} messageType
   * @returns {string}
   */
  normalizeTimeForMessage(rawTime = "", messageType = "") {
    if (messageType === MESSAGE_TYPES.VOICE || messageType === MESSAGE_TYPES.FILE) {
      return normalizeWhatsAppTimeForMedia(rawTime, messageType);
    }
    return normalizeWhatsAppTime(rawTime);
  }

  normalizeWhitespace(text = "") {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  stripMarkdownStars(s = "") {
    return String(s || "").replace(/\*+/g, "").trim();
  }

  extractGenericFileName(element) {
    if (!element) return "";

    // 优先级1：从 div[role="button"][title*="下载"] 的title属性解析
    const downloadBtn = element.querySelector('div[role="button"][title*="下载"], div[role="button"][title*="Download"]');
    if (downloadBtn) {
      const title = downloadBtn.getAttribute("title") || "";
      const cn =
        title.match(/下载[""\u201c\u201d](.+?)[""\u201c\u201d]/) ||
        title.match(/下载\s*[""]?\s*(.+?)\s*[""]?$/);
      if (cn) return this.stripMarkdownStars(cn[1]);

      const en = title.match(/Download[""]?[""]?(.+?)[""]?$/i) || title.match(/([\w.\- ]+\.(pdf|docx?|xlsx?|pptx?|zip|rar))/i);
      if (en) return this.stripMarkdownStars((en[1] || en[0]).trim());
    }

    // 优先级2：遍历其他带title的元素
    const titleNodes = element.querySelectorAll(
      '[title^="下载"], [title*="下载"], [title^="Download"], [title*="Download"]'
    );
    for (const node of titleNodes) {
      const title = node.getAttribute("title") || "";
      const cn =
        title.match(/下载[""\u201c\u201d](.+?)[""\u201c\u201d]/) ||
        title.match(/下载\s*[""]?\s*(.+?)\s*[""]?$/);
      if (cn) return this.stripMarkdownStars(cn[1]);

      const en = title.match(/Download[""]?[""]?(.+?)[""]?$/i) || title.match(/([\w.\- ]+\.(pdf|docx?|xlsx?|pptx?|zip|rar))/i);
      if (en) return this.stripMarkdownStars((en[1] || en[0]).trim());
    }

    // 优先级3：从span文本提取
    const nameSpan = element.querySelector(
      ".xlyipyv span[dir=auto]._ao3e, span[dir=auto]._ao3e, span._ao3e"
    );
    if (nameSpan) {
      const t = (nameSpan.textContent || "").trim();
      if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar)$/i.test(t)) return t;
    }

    const html = element.innerHTML || "";
    const extMatch = html.match(/([A-Za-z0-9_\- .]+\.(pdf|docx?|xlsx?|pptx?|zip|rar))/i);
    return extMatch ? extMatch[1].trim() : "";
  }

  extractPdfFileName(element) {
    return this.extractGenericFileName(element);
  }

  /**
   * 排除非广告外链（WhatsApp 自身等）
   * @param {string} href
   * @returns {boolean}
   */
  isExcludedPromoLinkHref(href = "") {
    try {
      const u = new URL(href);
      const h = u.hostname.replace(/^www\./i, "").toLowerCase();
      if (!h) return true;
      if (h.endsWith("whatsapp.com") || h.endsWith("whatsapp.net")) return true;
      if (h === "wa.me") return true;
      return false;
    } catch {
      return true;
    }
  }

  /**
   * 广告卡片主推广外链（不限 fb.me）
   * @param {Element|null} element
   * @returns {Element|null}
   */
  extractAdCardPrimaryLink(element) {
    if (!element) return null;

    const candidates = Array.from(element.querySelectorAll('a[href^="http"]'));
    const offsite = candidates.find((a) => {
      const href = a.getAttribute("href") || "";
      return href && !this.isExcludedPromoLinkHref(href);
    });
    if (offsite) return offsite;

    return (
      element.querySelector('a[href*="fb.me"]') ||
      element.querySelector('a[href*="facebook.com"]') ||
      null
    );
  }

  extractAdCardSourceText(element) {
    if (!element) return "";

    const link = this.extractAdCardPrimaryLink(element);
    if (!link) return "";

    const href = (link.getAttribute("href") || "").trim();
    const seen = new Set();
    const chunks = [];

    if (href) {
      chunks.push(href);
      seen.add(href);
    }

    const titleTexts = Array.from(link.querySelectorAll("div[title]"))
      .map((el) => (el.getAttribute("title") || "").trim())
      .filter(Boolean);

    for (const t of titleTexts) {
      if (!seen.has(t)) {
        seen.add(t);
        chunks.push(t);
      }
    }

    const spanTexts = Array.from(link.querySelectorAll('span[dir="auto"]'))
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0 && !/^data:/i.test(t));

    for (const t of spanTexts) {
      if (seen.has(t)) continue;
      seen.add(t);
      chunks.push(t);
    }

    return this.normalizeWhitespace(chunks.join(" "));
  }

  extractAdCardCaption(element) {
    if (!element) return "";

    const link = this.extractAdCardPrimaryLink(element);
    const bu = element.querySelector("._akbu span[data-testid='selectable-text']");
    if (bu) {
      const t = (bu.textContent || "").trim();
      if (t && !/^(\d{1,2}:\d{2})$/.test(t) && !/已编辑/.test(t)) return t;
    }

    const spans = Array.from(element.querySelectorAll('span[data-testid="selectable-text"]'));
    const outside = spans.filter((s) => {
      if (!link) return true;
      return !link.contains(s);
    });
    const texts = outside
      .map((s) => (s.textContent || "").trim())
      .filter((t) => t && !/^(\d{1,2}:\d{2})$/.test(t) && !/已编辑/.test(t));

    if (texts.length) return texts[texts.length - 1];
    return "";
  }

  /**
   * 先从 pending 取广告文案，再从 history（从新到旧）取
   * @param {Object[]} rawPending
   * @param {Object[]} rawHistory
   * @returns {string}
   */
  extractPlatformSource(rawPending = [], rawHistory = []) {
    const tryList = (list) => {
      const arr = Array.isArray(list) ? list : [];
      for (const raw of arr) {
        if (raw?.type === MESSAGE_TYPES.AD_CARD && raw.element) {
          const s = this.extractAdCardSourceText(raw.element);
          if (s) return s;
        }
      }
      return "";
    };

    const fromPending = tryList(rawPending);
    if (fromPending) return fromPending;

    const hist = Array.isArray(rawHistory) ? [...rawHistory] : [];
    for (let i = hist.length - 1; i >= 0; i -= 1) {
      const raw = hist[i];
      if (raw?.type === MESSAGE_TYPES.AD_CARD && raw.element) {
        const s = this.extractAdCardSourceText(raw.element);
        if (s) return s;
      }
    }
    return "";
  }

  extractImageCaptionForImage(element) {
    if (!element) return "";

    const openImg = element.querySelector('div[aria-label="打开图片"]');
    const scope = openImg?.closest(".copyable-text") || element;

    const imgInOpen = openImg?.querySelector("img[alt]") || element.querySelector('img[src^="data:image"]');
    const alt = imgInOpen?.getAttribute("alt")?.trim();
    if (alt) return alt;

    const spans = Array.from(scope.querySelectorAll('span[data-testid="selectable-text"]'));
    const texts = spans
      .map((el) => (el.textContent || "").trim())
      .filter((t) => t && !/^(\d{1,2}:\d{2})$/.test(t) && !/已编辑/.test(t));

    return texts.join("\n").trim();
  }

  extractVideoCaption(element) {
    if (!element) return "";

    const spans = Array.from(element.querySelectorAll('span[data-testid="selectable-text"]'));
    const texts = spans
      .map((el) => (el.textContent || "").trim())
      .filter((t) => t && !/^(\d{1,2}:\d{2})$/.test(t) && !/已编辑/.test(t));

    return texts.join("\n").trim();
  }

  collectDataJpegFromBackgrounds(element) {
    if (!element) return [];

    const found = [];
    const nodes = element.querySelectorAll("[style*='background-image']");

    for (const node of nodes) {
      let style = node.getAttribute("style") || "";
      style = style.replace(/&quot;/g, '"');
      const re = /url\(\s*["']?(data:image\/jpeg[^)"']+)/gi;
      let m;
      while ((m = re.exec(style)) !== null) {
        found.push(m[1]);
      }
    }

    if (found.length === 0) {
      const html = element.innerHTML || "";
      const re = /data:image\/jpeg;base64,[A-Za-z0-9+/=]+/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        found.push(m[0]);
      }
    }

    return found;
  }

  async extractVideoPosterDataUrl(element) {
    if (!element) return "";

    const urls = this.collectDataJpegFromBackgrounds(element);
    if (!urls.length) return "";

    // 严格取第2个，兜底规则才取第1个
    let pick = "";
    if (urls.length >= 2) {
      pick = urls[1];  // 优先第2个
    } else if (urls.length === 1) {
      pick = urls[0];  // 兜底第1个
    }

    if (!pick) return "";

    try {
      return await this.compressImageDataUrl(pick, 1280, 0.85);
    } catch {
      return pick;
    }
  }

  async extractVoiceTranscriptionText(element) {
    if (!element) return "";

    const readParagraph = (root) => {
      const p =
        root.querySelector(".paragraphText[data-kaption-transcription]") ||
        root.querySelector(".paragraph.kaption-paragraph .paragraphText");
      if (!p) return "";
      const attr = p.getAttribute("data-kaption-transcription");
      const text = (attr || p.textContent || "").trim();
      return text;
    };

    let text = readParagraph(element);
    if (text) return text;

    const textBtn =
      element.querySelector(".kaption-tooltip .textButton") ||
      Array.from(element.querySelectorAll("div.textButton")).find((el) => /Aa/i.test(el.textContent || ""));

    if (textBtn) {
      try {
        textBtn.click();
      } catch (e) {
        logger.warn("点击语音转文字按钮失败", e);
      }

      for (let i = 0; i < 150; i += 1) {
        await sleep(100);
        text = readParagraph(element);
        if (text) return text;
        text = readParagraph(document.body);
        if (text) return text;
      }
    }

    return "";
  }

  extractVoiceDuration(element) {
    if (!element) return "";

    const text = element.textContent || "";
    const match = text.match(/\b(\d{1,2}:\d{2})\b/);
    if (!match) return "";

    return mmssToDurationText(match[1]);
  }

  extractCartItemCount(element) {
    if (!element) return 0;
    const text = element.textContent || "";
    const match = text.match(/(\d+)\s*件商品/);
    return match ? Number(match[1]) : 0;
  }

  async fetchUrlAsDataUrl(src) {
    if (!src) return "";

    if (src.startsWith("data:")) {
      return src;
    }

    const response = await fetch(src);
    const blob = await response.blob();

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Failed to convert blob to base64"));
      reader.readAsDataURL(blob);
    });
  }

  async compressImageDataUrl(dataUrl, maxWidth = 1024, quality = 0.82) {
    if (!dataUrl) return "";

    return new Promise((resolve) => {
      const img = new Image();

      img.onload = () => {
        const ratio = img.width > maxWidth ? maxWidth / img.width : 1;
        const width = Math.round(img.width * ratio);
        const height = Math.round(img.height * ratio);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        resolve(canvas.toDataURL("image/jpeg", quality));
      };

      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async extractImageData(element) {
    if (!element) return "";

    // 优先级：blob → data:image → 其他
    const blobImg = element.querySelector("img[src^='blob:']");
    const dataImg = element.querySelector('img[src^="data:image"]');
    const anyImg = element.querySelector("img");
    const img = blobImg || dataImg || anyImg;

    const src = img?.getAttribute("src") || "";
    if (!src) return "";

    try {
      const dataUrl = await this.fetchUrlAsDataUrl(src);
      return await this.compressImageDataUrl(dataUrl, 1024, 0.82);
    } catch (error) {
      logger.warn("提取图片数据失败", error);
      return "";
    }
  }

  async extractVoiceData(element) {
    if (!element) return "";

    const audio =
      element.querySelector("audio") ||
      element.querySelector("source[src]");

    const src =
      audio?.getAttribute?.("src") ||
      element.querySelector("[src^='blob:']")?.getAttribute?.("src") ||
      "";

    if (!src) return "";

    try {
      return await this.fetchUrlAsDataUrl(src);
    } catch (error) {
      logger.warn("提取语音数据失败", error);
      return "";
    }
  }

  extractContactNameFromElement(element) {
    if (!element) return "";
    if (!element.querySelector('span[data-icon="default-contact-refreshed"]')) {
      return "";
    }
    const box = element.querySelector('div[data-testid="selectable-text"]');
    const inner = box?.querySelector("span");
    const text = (inner || box)?.textContent || "";
    return this.normalizeWhitespace(text);
  }

  /**
   * 从联系人卡片中提取电话号码（vCard 格式或纯文本）
   * @param {Element|null} element
   * @returns {string} 逗号分隔的电话号码
   */
  extractContactPhoneNumbers(element) {
    if (!element) return "";
    if (!element.querySelector('span[data-icon="default-contact-refreshed"]')) {
      return "";
    }

    const numbers = new Set();
    const spans = Array.from(
      element.querySelectorAll('span[dir="ltr"], span[dir="auto"]')
    );
    for (const span of spans) {
      const text = (span.textContent || "").trim();
      if (/\+?\d[\d\s\-()]{6,}/.test(text) && !/^\d{1,2}:\d{2}$/.test(text)) {
        const cleaned = text.replace(/[\s\-()]/g, "");
        if (cleaned.length >= 7) {
          numbers.add(text);
        }
      }
    }

    const links = Array.from(element.querySelectorAll('a[href^="tel:"]'));
    for (const link of links) {
      const href = (link.getAttribute("href") || "").trim();
      const phone = href.replace(/^tel:/, "").trim();
      if (phone) numbers.add(phone);
    }

    return Array.from(numbers).join(", ");
  }

  extractProductCaptionFromElement(element) {
    if (!element) return "";
    const named = element.querySelector(
      'span[data-testid="selectable-text"].copyable-text'
    );
    if (named) return this.normalizeWhitespace(named.textContent || "");
    const fall = element.querySelector('span[data-testid="selectable-text"]');
    return this.normalizeWhitespace(fall?.textContent || "");
  }

  /**
   * 单条 assistantMsgGroup / pending / history 共用：
   *   type:    原始大写枚举（不归一）
   *   content: 主要可见文本（图片/视频 = 标题/文件名/alt；语音 = 转写；文本 = 原文；…）
   *   data:    二进制 base64 dataUrl（图片/视频封面/语音/购物车缩略图）
   *   caption: 附属文案（图片说明、视频描述、广告说明等）
   *   time, msgId: String
   */
  async buildAnchorItemFromRaw(raw) {
    if (!raw) return null;

    const time = raw.rawTime
      ? this.normalizeTimeForMessage(raw.rawTime, raw.type)
      : "";
    const msgId = raw.msgId || "";

    switch (raw.type) {
      case MESSAGE_TYPES.TEXT:
        return asMessagePart({
          type: MESSAGE_TYPES.TEXT,
          msgId,
          time,
          content: raw.textContent || "",
          data: "",
          caption: ""
        });

      case MESSAGE_TYPES.IMAGE: {
        const data = await this.extractImageData(raw.element);
        const caption = this.extractImageCaptionForImage(raw.element);
        return asMessagePart({
          type: MESSAGE_TYPES.IMAGE,
          msgId,
          time,
          content: caption || "",
          data,
          caption
        });
      }

      case MESSAGE_TYPES.VOICE: {
        const content = await this.extractVoiceTranscriptionText(raw.element);
        const data = await this.extractVoiceData(raw.element);
        return asMessagePart({
          type: MESSAGE_TYPES.VOICE,
          msgId,
          time,
          content,
          data,
          caption: ""
        });
      }

      case MESSAGE_TYPES.VIDEO: {
        const data = await this.extractVideoPosterDataUrl(raw.element);
        const caption = this.extractVideoCaption(raw.element);
        return asMessagePart({
          type: MESSAGE_TYPES.VIDEO,
          msgId,
          time,
          content: caption || "",
          data,
          caption
        });
      }

      case MESSAGE_TYPES.FILE: {
        const fileName = this.extractGenericFileName(raw.element);
        return asMessagePart({
          type: MESSAGE_TYPES.FILE,
          msgId,
          time,
          content: fileName,
          data: "",
          caption: ""
        });
      }

      case MESSAGE_TYPES.CART: {
        const count = this.extractCartItemCount(raw.element);
        const data = await this.extractImageData(raw.element);
        return asMessagePart({
          type: MESSAGE_TYPES.CART,
          msgId,
          time,
          content: count ? `购物车 ${count} 件商品` : "购物车",
          data,
          caption: ""
        });
      }

      case MESSAGE_TYPES.AD_CARD: {
        const content = this.extractAdCardSourceText(raw.element);
        const caption = this.extractAdCardCaption(raw.element);
        return asMessagePart({
          type: MESSAGE_TYPES.AD_CARD,
          msgId,
          time,
          content,
          data: "",
          caption
        });
      }

      case MESSAGE_TYPES.CONTACT: {
        const content = this.extractContactNameFromElement(raw.element);
        const phoneNumbers = this.extractContactPhoneNumbers(raw.element);
        return asMessagePart({
          type: MESSAGE_TYPES.CONTACT,
          msgId,
          time,
          content,
          data: "",
          caption: phoneNumbers
        });
      }

      case MESSAGE_TYPES.PRODUCT: {
        const data = await this.extractImageData(raw.element);
        const caption = this.extractProductCaptionFromElement(raw.element);
        return asMessagePart({
          type: MESSAGE_TYPES.PRODUCT,
          msgId,
          time,
          content: caption || "",
          data,
          caption
        });
      }

      default:
        return asMessagePart({
          type: MESSAGE_TYPES.TEXT,
          msgId,
          time,
          content: raw.textContent || "",
          data: "",
          caption: ""
        });
    }
  }

  /**
   * 构建客服消息组（与 pending 同字段）
   * @param {Object[]} rawArray
   * @returns {Promise<Object[]>}
   */
  async buildAssistantMsgGroup(rawArray = []) {
    if (!Array.isArray(rawArray) || rawArray.length === 0) {
      return [];
    }

    const items = [];
    for (const raw of rawArray) {
      const row = await this.buildAnchorItemFromRaw(raw);
      if (row) items.push(row);
    }
    return this.filterNonEmptyAssistantGroup(items);
  }

  /**
   * assistantMsgGroup 条目：content、caption、data 均为空则剔除（不向上补 raw）
   * @param {Object[]} items
   * @returns {Object[]}
   */
  filterNonEmptyAssistantGroup(items = []) {
    return items.filter((x) => {
      const c = String(x?.content ?? "").trim();
      const cap = String(x?.caption ?? "").trim();
      const d = x?.data;
      const hasData = typeof d === "string" && d.trim() !== "";
      return Boolean(c || cap || hasData);
    });
  }

  async buildPendingContent(rawPending = []) {
    const results = [];
    for (const raw of rawPending) {
      const row = await this.buildAnchorItemFromRaw(raw);
      if (row) results.push(row);
    }
    return this.filterNonEmptyPendingContent(results);
  }

  /**
   * pending 条目：content、caption、data 均为空则剔除（不向上补）
   * @param {Object[]} items
   * @returns {Object[]}
   */
  filterNonEmptyPendingContent(items = []) {
    return items.filter((x) => {
      const c = String(x?.content ?? "").trim();
      const cap = String(x?.caption ?? "").trim();
      const d = x?.data;
      const hasData = typeof d === "string" && d.trim() !== "";
      if (hasData) return true;
      return Boolean(c || cap);
    });
  }

  /**
   * history.role：与 extractRawMessage 的 role（message-in/out）一致
   * @param {Object} raw
   * @returns {"customer"|"staff"}
   */
  mapRawRoleToHistoryRole(raw = {}) {
    return raw.role === "staff" ? "staff" : "customer";
  }

  /**
   * 单条 history：与 pending/assistant 同字段，另增 role
   * @param {Object} raw
   * @returns {Promise<Object|null>}
   */
  async buildHistoryItem(raw) {
    if (!raw) return null;

    const row = await this.buildAnchorItemFromRaw(raw);
    if (!row) return null;

    return {
      role: this.mapRawRoleToHistoryRole(raw),
      ...asMessagePart(row)
    };
  }

  /**
   * history 展示用：content/caption/data 均为空则跳过，并从更早消息向上补足至 LIMIT 条
   * @param {Object|null} item
   * @returns {boolean}
   */
  hasHistoryDisplayableContent(item) {
    if (!item) return false;
    const c = String(item.content ?? "").trim();
    const cap = String(item.caption ?? "").trim();
    const d = item.data;
    const hasData = typeof d === "string" && d.trim() !== "";
    return Boolean(c || cap || hasData);
  }

  /**
   * 从 rawMessages 末尾向前扫描；跳过无展示内容项，直至凑满 HISTORY_MESSAGE_LIMIT 条（时间正序）。
   * rawMessages 应由控制器传入足够长的末尾窗口（见 HISTORY_RAW_LOOKBACK）。
   * @param {Object[]} rawMessages
   * @returns {Promise<Object[]>}
   */
  async buildHistory(rawMessages = []) {
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return [];
    }

    const out = [];
    for (
      let i = rawMessages.length - 1;
      i >= 0 && out.length < HISTORY_MESSAGE_LIMIT;
      i -= 1
    ) {
      const item = await this.buildHistoryItem(rawMessages[i]);
      if (!item || !this.hasHistoryDisplayableContent(item)) continue;
      out.unshift(item);
    }
    return out;
  }

  async buildRequestPayload(params = {}) {
    const {
      autoReplyStatus = false,
      staffId = "",
      chatId = "",
      rawLastAssistantGroup = [],
      rawPendingContent = [],
      rawHistoryMessages = []
    } = params;

    const assistantMsgGroup = await this.buildAssistantMsgGroup(rawLastAssistantGroup);

    const pendingContent = await this.buildPendingContent(rawPendingContent);
    const platformSource = this.extractPlatformSource(
      rawPendingContent,
      rawHistoryMessages
    );
    const history = await this.buildHistory(rawHistoryMessages);

    const payload = {
      autoReplyStatus: Boolean(autoReplyStatus),
      staffId: String(staffId || "").trim(),
      chatId: this.resolveChatId(chatId),
      platformSource,
      history,
      anchorData: {
        assistantMsgGroup,
        pendingContent
      }
    };

    logger.debug("请求后端的消息已构建", {
      chatId: payload.chatId,
      historyCount: payload.history.length,
      pendingCount: payload.anchorData.pendingContent.length
    });

    return payload;
  }
}
