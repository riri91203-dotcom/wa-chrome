/**
 * content/sender.js
 *
 * 已修复：
 * 1. PDF 附件预览层的发送按钮不是 button，而是 div[role="button"][aria-label="发送"]
 * 2. 发送按钮会随场景变化：文本输入区 / 附件预览层
 * 3. 点击发送前，优先寻找“可见且可点击”的发送控件
 * 4. 发完后避免误点麦克风
 */

import { sleep } from "../utils/time.js";
import {
  BACKEND_INTENTS,
  ACTION_TYPES,
  FILE_TYPES,
  BG_MESSAGE_TYPES
} from "../utils/constants.js";
import { chatIdsDigitsEqual } from "../utils/chat-id.js";
import { logger } from "../utils/logger.js";

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none"
  );
}

function isEnabled(el) {
  if (!el) return false;
  const ariaDisabled = String(el.getAttribute("aria-disabled") || "").toLowerCase();
  const disabled = el.disabled;
  return !disabled && ariaDisabled !== "true";
}

export class WhatsAppSender {
  constructor({ cursor = null, store = null, dom = null } = {}) {
    this.cursor = cursor;
    this.store = store;
    this.dom = dom;
    this._currentExpectedChatId = "";

    this.SELECTORS = {
      // 文本输入区
      inputParagraph: "p._aupe.copyable-text",
      inputEditable: '[contenteditable="true"]',

      // 附件 / 文档
      fileInput: 'input[type="file"]',

      // 常规发送按钮（文本场景）
      sendButtonCandidates: [
        'button[data-tab="11"][aria-label="发送"]',
        'button[data-tab="11"][aria-label="Send"]',
        'button[aria-label="发送"]',
        'button[aria-label="Send"]',

        // 关键修复：附件预览层发送控件常是 div role=button
        'div[role="button"][aria-label="发送"]',
        'div[role="button"][aria-label="Send"]',

        // 再兜底一层
        '[role="button"][aria-label="发送"]',
        '[role="button"][aria-label="Send"]'
      ],

      // 麦克风按钮，防止误判
      voiceButtonCandidates: [
        'button[data-tab="11"][aria-label="语音消息"]',
        'button[data-tab="11"][aria-label="Voice message"]',
        'button[aria-label="语音消息"]',
        'button[aria-label="Voice message"]',
        '[role="button"][aria-label="语音消息"]',
        '[role="button"][aria-label="Voice message"]'
      ],

      // 附件按钮
      attachButtonCandidates: [
        'button[aria-label="附加"]',
        'button[aria-label="Attach"]',
        'button[data-tab="10"][aria-label="附加"]',
        'button[data-tab="10"][aria-label="Attach"]',
        '[role="button"][aria-label="附加"]',
        '[role="button"][aria-label="Attach"]'
      ],

      // 文档菜单项
      documentMenuCandidates: [
        'button[role="menuitem"][aria-label="文档"]',
        'button[role="menuitem"][aria-label="Document"]',
        '[role="menuitem"][aria-label="文档"]',
        '[role="menuitem"][aria-label="Document"]'
      ]
    };
  }

  async setActionText(text) {
    if (!this.store) return;
    await this.store.setState({
      currentAction: text
    });
  }

  getComposerInput() {
    const candidates = Array.from(document.querySelectorAll(this.SELECTORS.inputEditable));

    for (const el of candidates) {
      if (!el) continue;
      if (!isVisible(el)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return el;
      }
    }

    return document.querySelector(this.SELECTORS.inputParagraph);
  }

  getVoiceButton() {
    for (const selector of this.SELECTORS.voiceButtonCandidates) {
      const nodes = Array.from(document.querySelectorAll(selector));
      const hit = nodes.find((el) => isVisible(el) && isEnabled(el));
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 统一查找“真正可点击的发送按钮”
   * 修复点：
   * - 支持 button / div[role=button]
   * - 排除麦克风按钮
   * - 只取当前可见、可点击的节点
   */
  getSendButton() {
    const voiceBtn = this.getVoiceButton();

    for (const selector of this.SELECTORS.sendButtonCandidates) {
      const nodes = Array.from(document.querySelectorAll(selector));

      const hit = nodes.find((el) => {
        if (!isVisible(el)) return false;
        if (!isEnabled(el)) return false;
        if (voiceBtn && el === voiceBtn) return false;

        const label = String(el.getAttribute("aria-label") || "").trim();
        if (!/发送|send/i.test(label)) return false;
        if (/语音|voice/i.test(label)) return false;

        return true;
      });

      if (hit) return hit;
    }

    return null;
  }

  getAttachButton() {
    for (const selector of this.SELECTORS.attachButtonCandidates) {
      const nodes = Array.from(document.querySelectorAll(selector));
      const hit = nodes.find((el) => isVisible(el) && isEnabled(el));
      if (hit) return hit;
    }
    return null;
  }

  getDocumentMenuItem() {
    // 先按精确选择器找
    for (const selector of this.SELECTORS.documentMenuCandidates) {
      const nodes = Array.from(document.querySelectorAll(selector));
      const hit = nodes.find((el) => isVisible(el) && isEnabled(el));
      if (hit) return hit;
    }

    // 再按通用菜单项文本兜底
    const menuItems = Array.from(
      document.querySelectorAll('button[role="menuitem"], [role="menuitem"]')
    );

    return (
      menuItems.find((el) => {
        if (!isVisible(el) || !isEnabled(el)) return false;

        const label = String(el.getAttribute("aria-label") || "").toLowerCase();
        const text = String(el.textContent || "").toLowerCase();
        return (
          label.includes("文档") ||
          text.includes("文档") ||
          label.includes("document") ||
          text.includes("document")
        );
      }) || null
    );
  }

  async focusInput(inputEl) {
    inputEl.focus();
    await sleep(120);
  }

  async insertText(inputEl, text) {
    await this.focusInput(inputEl);

    document.execCommand("insertText", false, text);
    await sleep(180);

    if (!(inputEl.textContent || "").trim() && text) {
      inputEl.textContent = text;
      inputEl.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await sleep(180);
    }
  }

  async safeClick(el) {
    if (!el) return false;

    el.scrollIntoView({
      block: "center",
      behavior: "smooth"
    });

    await sleep(220);

    if (this.cursor) {
      await this.cursor.moveToElement(el);
      await this.cursor.clickEffect();
    }

    el.click();
    await sleep(260);
    return true;
  }

  async sendText(text) {
    if (!text) return false;

    await this.setActionText("正在定位输入框...");
    logger.info("sendText start", text);

    this._assertExpectedChatOrThrow(this._currentExpectedChatId, "输入文本前");

    const input = this.getComposerInput();
    if (!input) {
      throw new Error("未找到输入框");
    }

    if (this.cursor) {
      await this.cursor.moveToElement(input);
    }

    await this.setActionText("正在输入文本...");
    await this.insertText(input, text);

    const sendBtn = this.getSendButton();
    if (!sendBtn) {
      throw new Error("未找到发送按钮");
    }

    const ariaLabel = sendBtn.getAttribute("aria-label") || "";
    if (!/发送|send/i.test(ariaLabel) || /语音|voice/i.test(ariaLabel)) {
      throw new Error(`当前按钮不是发送按钮，而是：${ariaLabel || "未知"}`);
    }

    this._assertExpectedChatOrThrow(this._currentExpectedChatId, "点击发送按钮前");

    await this.setActionText("正在点击发送按钮...");
    await this.safeClick(sendBtn);
    await sleep(400);

    logger.info("sendText success");
    return true;
  }

  dataUrlToFile(dataUrl, fileName, mimeType = "application/pdf") {
    const [meta, base64] = dataUrl.split(",");
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);

    for (let i = 0; i < len; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    const finalMime = meta.match(/data:(.*?);base64/)?.[1] || mimeType;
    return new File([bytes], fileName, { type: finalMime });
  }

  async fetchPdfAsFile({ fileUrl, fileName = "manual.pdf" } = {}) {
    if (!fileUrl) {
      throw new Error("缺少 fileUrl，无法下载 PDF");
    }

    const url = String(fileUrl).trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("fileUrl 必须是 http(s) 地址");
    }

    const res = await chrome.runtime.sendMessage({
      type: BG_MESSAGE_TYPES.DOWNLOAD_FILE_AS_BASE64,
      payload: { fileUrl: url, fileName, fileType: "pdf" }
    });

    if (!res?.ok) {
      throw new Error(res?.error || "后台下载 PDF 失败（跨域文件需经扩展后台拉取）");
    }

    const d = res.data || {};
    const name = d.fileName || fileName || "manual.pdf";
    const mime = d.mimeType || "application/pdf";
    if (!d.dataUrl) {
      throw new Error("后台未返回 PDF 数据");
    }

    return this.dataUrlToFile(d.dataUrl, name, mime);
  }

  async waitForFileInput(timeoutMs = 5000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const inputs = Array.from(document.querySelectorAll(this.SELECTORS.fileInput));
      const visibleInput = inputs.find((input) => input);
      if (visibleInput) return visibleInput;
      await sleep(150);
    }

    return null;
  }

  isImageInputCandidate(inputEl) {
    if (!inputEl) return false;
    const accept = String(inputEl.getAttribute("accept") || "").toLowerCase();
    return accept.includes("image");
  }

  async waitForDocumentMenuButton(timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const btn = this.getDocumentMenuItem();
      if (btn) return btn;
      await sleep(120);
    }
    return null;
  }

  async waitForDocumentFileInput(beforeInputs, timeoutMs = 3500) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const all = Array.from(document.querySelectorAll(this.SELECTORS.fileInput));
      const next = all.find(
        (input) => !beforeInputs.has(input) && !this.isImageInputCandidate(input)
      );
      if (next) return next;

      await sleep(120);
    }

    return null;
  }

  async pointAndClick(el, desc = "click", options = {}) {
    if (!el) {
      throw new Error(`无法执行点击: ${desc}`);
    }

    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(120);

    if (this.cursor) {
      await this.cursor.moveToElement(el);
      if (typeof this.cursor.clickEffect === "function") {
        await this.cursor.clickEffect();
      }
    }

    if (options.mode === "event_only") {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } else {
      el.click();
    }

    await sleep(260);
    return true;
  }

  async setHiddenFileInputFiles(input, files) {
    if (!input || !files?.length) {
      throw new Error("无法写入文件到隐藏 input");
    }

    const dt = new DataTransfer();
    for (const file of files) {
      dt.items.add(file);
    }

    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(180);
  }

  async waitForUploadResult(timeoutMs = 4000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const unsupportedElement = Array.from(
        document.querySelectorAll("div, span, p")
      ).find((el) => {
        const text = String(el.textContent || "").trim();
        return /不支持该文件|不支持该格式|unsupported|not supported/i.test(text);
      });

      if (unsupportedElement) {
        return "unsupported";
      }

      await sleep(150);
    }

    return null;
  }

  async closeAttachmentPreviewOrError() {
    const closeSelectors = [
      '[aria-label="关闭"]',
      '[aria-label="Close"]',
      '[title="关闭"]',
      '[title="Close"]',
      '.icon-close',
      '.close-button'
    ];

    for (const selector of closeSelectors) {
      const closeBtn = document.querySelector(selector);
      if (closeBtn && isVisible(closeBtn) && isEnabled(closeBtn)) {
        closeBtn.click();
        await sleep(220);
        return true;
      }
    }

    return false;
  }

  findAttachmentCaptionEditor() {
    const editors = Array.from(document.querySelectorAll('div[contenteditable="true"]'));
    return editors.find((editor) => {
      const placeholder = String(editor.getAttribute("data-placeholder") || "").toLowerCase();
      const text = String(editor.textContent || "").toLowerCase();
      return placeholder.includes("说明") || placeholder.includes("caption") || text.includes("说明") || text.includes("caption");
    }) || null;
  }

  async triggerAttachmentSendClick(button) {
    if (!button) return false;

    // 先尝试 event_only 模式派发事件
    await this.pointAndClick(button, "点击附件发送按钮", { mode: "event_only" });
    await sleep(500);

    // 如果按钮仍然存在于 DOM 且可见，说明 event_only 可能未生效，fallback 到 el.click()
    if (document.contains(button) && button.offsetParent !== null) {
      logger.info("附件发送按钮 event_only 未生效，尝试 el.click() fallback");
      button.click();
      await sleep(260);
    }

    return true;
  }

  async waitForAttachmentSendComplete(button, timeoutMs = 6000) {
    if (!button) return false;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // 按钮已从 DOM 移除或被隐藏
      if (!document.contains(button) || button.offsetParent === null) {
        return true;
      }
      // 备用判定：聊天输入框重新出现，说明预览层已关闭
      const composerInput = document.querySelector('#main [contenteditable="true"]');
      if (composerInput && isVisible(composerInput)) {
        return true;
      }
      await sleep(150);
    }

    return false;
  }

  async openDocumentAndUploadPdf(file) {
    const beforeInputs = new Set(Array.from(document.querySelectorAll(this.SELECTORS.fileInput)));

    const documentBtn = await this.waitForDocumentMenuButton(4000);
    if (!documentBtn) {
      return { ok: false, error: "未找到文档菜单按钮" };
    }

    await this.pointAndClick(documentBtn, "点击文档菜单", { mode: "event_only" });
    await sleep(300);

    const docInput = await this.waitForDocumentFileInput(beforeInputs, 5000);
    if (!docInput) {
      const allInputs = Array.from(document.querySelectorAll(this.SELECTORS.fileInput));
      const onlyImage = allInputs.length > 0 && allInputs.every((x) => this.isImageInputCandidate(x));
      if (onlyImage) {
        return { ok: false, error: "点击文档后仍然只有 image/* 输入框，未出现文档输入框" };
      }
      return { ok: false, error: "点击文档后未发现文档输入框" };
    }

    await this.setHiddenFileInputFiles(docInput, [file]);

    const result = await this.waitForUploadResult(5000);
    if (result === "unsupported") {
      await this.closeAttachmentPreviewOrError();
      return { ok: false, error: "文档输入框已命中，但 WhatsApp 返回不支持该文件" };
    }

    return { ok: true, kind: "document_input_after_document_click" };
  }

  /**
   * 等待附件预览层里的发送按钮出现
   * 关键修复：附件加上后，不是立即就有发送控件
   */
  async waitForSendButton(timeoutMs = 3000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const btn = this.getSendButton();
      if (btn) return btn;
      await sleep(150);
    }

    return null;
  }

  async waitForAttachmentSendButton(timeoutMs = 3000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const btn = this.getSendButton();
      if (btn && isVisible(btn)) return btn;
      await sleep(150);
    }

    return null;
  }

  async sendPdf(fileData) {
    if (!fileData) {
      throw new Error("缺少 fileData");
    }

    let file = fileData.file;
    if (!file) {
      if (!fileData.dataUrl || !fileData.fileName) {
        throw new Error("缺少 fileData.file 或 fileData.dataUrl/fileData.fileName");
      }
      file = this.dataUrlToFile(
        fileData.dataUrl,
        fileData.fileName,
        fileData.mimeType
      );
    }

    await this.setActionText("正在发送 PDF...");
    logger.info("sendPdf start", {
      fileName: file.name,
      mimeType: file.type,
      size: file.size
    });

    const attachBtn = this.getAttachButton();
    if (!attachBtn) {
      throw new Error("未找到附件按钮");
    }

    await this.setActionText("正在点击附件按钮...");
    await this.safeClick(attachBtn);

    const uploadResult = await this.openDocumentAndUploadPdf(file);
    if (!uploadResult.ok) {
      throw new Error(uploadResult.error || "文档上传失败");
    }

    await sleep(400);
    const sendBtn = await this.waitForAttachmentSendButton(6000);
    if (!sendBtn) {
      throw new Error("未找到文档发送按钮");
    }

    if (fileData.caption) {
      const captionBox = this.findAttachmentCaptionEditor();
      if (captionBox) {
        await this.pointAndClick(captionBox, "填写文档说明", { mode: "event_only" });
        captionBox.focus();
        await sleep(80);
        await this.insertText(captionBox, String(fileData.caption || ""));
        await sleep(120);
      }
    }

    await this.setActionText("正在点击 PDF 发送按钮...");
    this._assertExpectedChatOrThrow(this._currentExpectedChatId, "点击PDF发送按钮前");
    await this.triggerAttachmentSendClick(sendBtn);

    const sent = await this.waitForAttachmentSendComplete(sendBtn, 15000);
    if (!sent) {
      throw new Error("PDF 发送未完成，预览层未关闭");
    }

    logger.info("sendPdf success", file.name);
    return true;
  }

  async sendPdfByUrl({ fileUrl, fileName } = {}) {
    await this.setActionText("正在下载 PDF...");
    const file = await this.fetchPdfAsFile({ fileUrl, fileName });

    return this.sendPdf({
      file,
      fileName: file.name || fileName,
      mimeType: file.type,
      size: file.size || 0
    });
  }

  /**
   * 校验当前 UI chatId 是否与期望一致，不一致则 throw
   * @param {string} expectedChatId
   * @param {string} checkpoint
   */
  _assertExpectedChatOrThrow(expectedChatId, checkpoint = "") {
    if (!expectedChatId || !this.dom) return;
    const confident = this.dom.getCurrentChatIdWithConfidence();
    if (confident === null) {
      const leftId = this.dom.getLeftPanelSelectedChatId();
      const rightId = this.dom.getRightPanelChatId();
      throw new Error(
        `CHAT_SWITCHED_BEFORE_SEND: chatId 不一致(${checkpoint})：左侧 ${leftId || "空"}，右侧 ${rightId || "空"}，期望 ${expectedChatId}`
      );
    }
    if (!chatIdsDigitsEqual(confident, expectedChatId)) {
      throw new Error(
        `CHAT_SWITCHED_BEFORE_SEND: chatId 已切换(${checkpoint})：期望 ${expectedChatId}，当前 ${confident || "空"}`
      );
    }
  }

  /**
   * @param {string} expectedChatId
   * @returns {boolean}
   */
  _isStillOnExpectedChat(expectedChatId) {
    if (!this.dom || !expectedChatId) return false;
    const confident = this.dom.getCurrentChatIdWithConfidence();
    if (confident === null) return false;
    return chatIdsDigitsEqual(confident, expectedChatId);
  }

  async executeDecision({ intent = BACKEND_INTENTS.NONE, actions = [], expectedChatId = "" } = {}) {
    logger.group("executeDecision", { intent, actions, expectedChatId });
    this._currentExpectedChatId = expectedChatId;

    if (intent === BACKEND_INTENTS.NONE) {
      await this.setActionText("后端返回 NONE，不发送");
      return;
    }

    // TEXT_WITH_PDF 时先发 text 再发 file：PDF 发送流程会打开附件预览层，
    // 关闭后输入框可能短暂不可用，导致后续 text 发送失败。
    const sortedActions = intent === BACKEND_INTENTS.TEXT_WITH_PDF
      ? this._sortActionsTextFirst(actions)
      : actions;

    for (const action of sortedActions) {
      if (!action?.type) continue;

      if (expectedChatId && !this._isStillOnExpectedChat(expectedChatId)) {
        const actualChatId = this.dom ? this.dom.getCurrentChatId() : "";
        const msg = `发送前 chatId 不匹配，已中止：期望 ${expectedChatId}，当前 ${actualChatId || "空"}`;
        await this.setActionText(msg);
        logger.warn("发送前检测到会话已切换，中止发送", { expectedChatId, actualChatId });
        throw new Error(`CHAT_SWITCHED_BEFORE_SEND: ${msg}`);
      }

      if (action.type === ACTION_TYPES.FILE && action.fileType === FILE_TYPES.PDF) {
        if (intent !== BACKEND_INTENTS.TEXT_WITH_PDF) {
          logger.warn("skip pdf action due to intent mismatch", { intent, action });
          continue;
        }

        if (action.fileData?.dataUrl) {
          await this.sendPdf(action.fileData);
          continue;
        }

        if (action.fileUrl) {
          await this.sendPdfByUrl({
            fileUrl: action.fileUrl,
            fileName: action.fileName
          });
          continue;
        }

        logger.warn("skip pdf action because fileData/fileUrl missing", action);
        continue;
      }

      if (action.type === ACTION_TYPES.TEXT) {
        if (
          intent !== BACKEND_INTENTS.TEXT_ONLY &&
          intent !== BACKEND_INTENTS.TEXT_WITH_PDF
        ) {
          logger.warn("skip text action due to intent mismatch", { intent, action });
          continue;
        }

        await this.sendText(action.content || "");
        continue;
      }

      logger.warn("unknown action skipped", action);
    }

    await this.setActionText("发送完成");
  }

  /**
   * 将 actions 重排为 text 优先、file 靠后，确保文本在 PDF 之前发送。
   * @param {Object[]} actions
   * @returns {Object[]}
   */
  _sortActionsTextFirst(actions) {
    const textActions = actions.filter((a) => a?.type === ACTION_TYPES.TEXT);
    const otherActions = actions.filter((a) => a?.type !== ACTION_TYPES.TEXT);
    return [...textActions, ...otherActions];
  }
}