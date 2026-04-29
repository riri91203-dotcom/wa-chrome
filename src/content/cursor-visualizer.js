/**
 * content/cursor-visualizer.js
 *
 * 页面右上角状态面板 + 小手光标
 */

import { BG_MESSAGE_TYPES } from "../utils/constants.js";
import { collectAndExportLogs, getAllAvailableDates } from "../utils/log-collector.js";

const ROOT_ID = "wa-auto-reply-root";
const PANEL_ID = "wa-auto-reply-panel";
const HAND_ID = "wa-auto-reply-hand";

const PHONE_REGEX = /^1[3-9]\d{9}$/;

function createStyleTag() {
  // 样式由 content script 注入页面，避免依赖扩展外部 CSS 文件。
  const style = document.createElement("style");
  style.id = "wa-auto-reply-style";
  style.textContent = `
    #${ROOT_ID} {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483646;
      font-family: Arial, "Microsoft YaHei", sans-serif;
    }

    #${PANEL_ID} {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 340px;
      background: rgba(17, 24, 39, 0.95);
      color: #fff;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      padding: 12px;
      pointer-events: auto;
      user-select: none;
      transition: transform 0.2s ease, opacity 0.2s ease;
      overflow: hidden;
    }

    #${PANEL_ID}.collapsed .wa-auto-reply-body {
      display: none;
    }

    #${PANEL_ID}.minimized {
      width: 240px;
    }

    #${PANEL_ID}.minimized .wa-auto-reply-body {
      display: none;
    }

    .wa-auto-reply-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 8px;
      cursor: move;
      user-select: none;
    }

    .wa-auto-reply-minimize-btn {
      border: 0;
      border-radius: 6px;
      padding: 4px 8px;
      background: rgba(148, 163, 184, 0.2);
      color: #fff;
      cursor: pointer;
      pointer-events: auto;
      font-size: 14px;
      line-height: 1;
      transition: background 0.2s ease;
    }

    .wa-auto-reply-minimize-btn:hover {
      background: rgba(148, 163, 184, 0.4);
    }

    .wa-auto-reply-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 12px;
      line-height: 1.5;
    }

    .wa-auto-reply-label {
      color: #cbd5e1;
      flex: 0 0 auto;
      font-weight: 500;
    }

    .wa-auto-reply-value {
      color: #fff;
      text-align: right;
      word-break: break-word;
      flex: 1 1 auto;
      min-width: 80px;
      font-weight: 500;
    }

    .wa-auto-reply-staff-input {
      flex: 1;
      padding: 6px 8px;
      border: 1px solid #475569;
      border-radius: 6px;
      font-size: 11px;
      color: #fff;
      background: rgba(100, 116, 139, 0.3);
      font-family: Arial, "Microsoft YaHei", sans-serif;
      line-height: 1.2;
      transition: background 0.2s ease, border-color 0.2s ease;
    }

    .wa-auto-reply-staff-input:focus {
      outline: none;
      border-color: #60a5fa;
      background: rgba(30, 58, 138, 0.5);
    }

    .wa-auto-reply-staff-input::placeholder {
      color: #94a3b8;
    }

    .wa-auto-reply-save-btn {
      padding: 6px 12px;
      border: 1px solid #475569;
      border-radius: 6px;
      background: #3b82f6;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      font-family: Arial, "Microsoft YaHei", sans-serif;
      line-height: 1.2;
      transition: background 0.2s ease, opacity 0.2s ease;
    }

    .wa-auto-reply-save-btn:hover:not(:disabled) {
      background: #2563eb;
    }

    .wa-auto-reply-save-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .wa-auto-reply-actions {
      display: flex;
      gap: 6px;
      margin-top: 4px;
    }

    .wa-auto-reply-btn {
      flex: 1;
      border: 0;
      border-radius: 6px;
      padding: 8px 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      transition: background 0.2s ease, opacity 0.2s ease;
    }

    .wa-auto-reply-btn.start {
      background: #22c55e;
      color: #0b1220;
    }

    .wa-auto-reply-btn.start:hover:not(:disabled) {
      background: #16a34a;
    }

    .wa-auto-reply-btn.stop {
      background: #ef4444;
      color: #fff;
    }

    .wa-auto-reply-btn.stop:hover:not(:disabled) {
      background: #dc2626;
    }

    .wa-auto-reply-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .wa-auto-reply-mini {
      font-size: 11px;
      color: #fca5a5;
      margin-top: 4px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 40px;
      overflow-y: auto;
    }

    .wa-auto-reply-export-btn {
      display: block;
      width: 100%;
      margin-top: 4px;
      padding: 6px 0;
      border: 1px solid #475569;
      border-radius: 6px;
      background: rgba(71, 85, 105, 0.3);
      color: #cbd5e1;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      font-family: Arial, "Microsoft YaHei", sans-serif;
      transition: background 0.2s ease, color 0.2s ease;
    }

    .wa-auto-reply-export-btn:hover {
      background: rgba(71, 85, 105, 0.5);
      color: #fff;
    }

    #${HAND_ID} {
      position: fixed;
      width: 28px;
      height: 28px;
      left: 0;
      top: 0;
      z-index: 2147483647;
      pointer-events: none;
      display: none;
      transform: translate(-9999px, -9999px) scale(1);
      transition:
        left 0.45s ease,
        top 0.45s ease,
        transform 0.12s ease,
        opacity 0.2s ease;
      opacity: 0;
    }

    #${HAND_ID}.visible {
      display: block;
      opacity: 1;
    }

    #${HAND_ID}::before {
      content: "☝";
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      font-size: 24px;
      color: #fde047;
      text-shadow:
        0 0 4px rgba(0, 0, 0, 0.5),
        0 0 10px rgba(250, 204, 21, 0.35);
    }

    @keyframes wa-shake {
      0%, 100% { transform: translateX(0); }
      20% { transform: translateX(-4px); }
      40% { transform: translateX(4px); }
      60% { transform: translateX(-4px); }
      80% { transform: translateX(4px); }
    }

    .wa-auto-reply-staff-input.shake {
      animation: wa-shake 0.4s ease;
      border-color: #ef4444 !important;
    }

    .wa-staff-error-tip {
      font-size: 11px;
      color: #fca5a5;
      margin-top: 2px;
      white-space: nowrap;
    }

    .wa-log-date-picker {
      margin-top: 4px;
      border: 1px solid #475569;
      border-radius: 6px;
      background: rgba(30, 41, 59, 0.9);
      padding: 6px 8px;
      max-height: 180px;
      overflow-y: auto;
    }

    .wa-log-date-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
      font-size: 11px;
      color: #cbd5e1;
      font-weight: 600;
    }

    .wa-log-select-all {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      font-weight: 400;
      color: #94a3b8;
    }

    .wa-log-select-all input[type="checkbox"] {
      margin: 0;
      accent-color: #3b82f6;
    }

    .wa-log-date-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .wa-log-date-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 4px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      color: #e2e8f0;
      transition: background 0.15s ease;
    }

    .wa-log-date-item:hover {
      background: rgba(71, 85, 105, 0.4);
    }

    .wa-log-date-item input[type="checkbox"] {
      margin: 0;
      accent-color: #3b82f6;
    }

    .wa-log-date-item .wa-log-date-label {
      flex: 1;
    }

    .wa-log-date-item .wa-log-count {
      color: #94a3b8;
      font-size: 10px;
    }

    .wa-log-empty-tip {
      font-size: 11px;
      color: #94a3b8;
      text-align: center;
      padding: 8px 0;
    }
  `;
  return style;
}

export class CursorVisualizer {
  constructor() {
    // root 承载面板和小手；onStart/onStop 由 controller 注入，避免 UI 直接依赖业务逻辑。
    this.root = null;
    this.panel = null;
    this.hand = null;
    this.onStart = null;
    this.onStop = null;
  }

  mount() {
    // mount 可重复调用；已存在的 DOM 会复用，避免多次注入面板。
    if (!document.getElementById("wa-auto-reply-style")) {
      // 不存在时创建样式
      document.head.appendChild(createStyleTag());
    }

    let root = document.getElementById(ROOT_ID);
    if (!root) {
      // 不存在时创建根元素
      root = document.createElement("div");
      root.id = ROOT_ID;
      document.body.appendChild(root);
    }

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      // 不存在时创建控制面板
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.className = "";
      panel.innerHTML = `
        <div class="wa-auto-reply-title">
          <span>WhatsApp 自动回复</span>
          <button class="wa-auto-reply-minimize-btn" data-action="minimize">-</button>
        </div>

        <div class="wa-auto-reply-body">
          <div class="wa-auto-reply-row">
            <span class="wa-auto-reply-label">状态</span>
            <span class="wa-auto-reply-value" data-field="appState">IDLE</span>
          </div>

          <div class="wa-auto-reply-row">
            <span class="wa-auto-reply-label">队列</span>
            <span class="wa-auto-reply-value" data-field="queueProgressText">0/0</span>
          </div>

          <div class="wa-auto-reply-row">
            <span class="wa-auto-reply-label">扫描进度</span>
            <span class="wa-auto-reply-value" data-field="scanScrollProgressText">--</span>
          </div>

          <div class="wa-auto-reply-row">
            <span class="wa-auto-reply-label">已发现</span>
            <span class="wa-auto-reply-value" data-field="scanFoundCount">0</span>
          </div>

          <div class="wa-auto-reply-row">
            <span class="wa-auto-reply-label">客户</span>
            <span class="wa-auto-reply-value" data-field="currentChatId">-</span>
          </div>

          <div class="wa-auto-reply-row">
            <span class="wa-auto-reply-label">动作</span>
            <span class="wa-auto-reply-value" data-field="currentAction">等待启动</span>
          </div>

          <div class="wa-auto-reply-row">
            <span class="wa-auto-reply-label">手机号</span>
            <input
              type="text"
              class="wa-auto-reply-staff-input"
              id="wa-staff-id-input"
              placeholder="输入11位手机号"
              maxlength="11"
            />
            <button class="wa-auto-reply-save-btn" id="wa-staff-save-btn">保存</button>
          </div>

          <div class="wa-auto-reply-actions">
            <button class="wa-auto-reply-btn start" data-action="start">启动</button>
            <button class="wa-auto-reply-btn stop" data-action="stop">停止</button>
          </div>

          <button class="wa-auto-reply-export-btn" id="wa-export-logs-btn">导出日志</button>

          <div class="wa-log-date-picker" id="wa-log-date-picker" style="display:none;">
            <div class="wa-log-date-header">
              <span>选择导出日期</span>
              <label class="wa-log-select-all">
                <input type="checkbox" id="wa-log-select-all-cb" checked /> 全选
              </label>
            </div>
            <div class="wa-log-date-list" id="wa-log-date-list"></div>
          </div>

          <div class="wa-auto-reply-mini" data-field="lastError"></div>
        </div>
      `;
      root.appendChild(panel);
    }

    let hand = document.getElementById(HAND_ID);
    if (!hand) {
      hand = document.createElement("div");
      hand.id = HAND_ID;
      root.appendChild(hand);
    }

    if (!panel.dataset.boundActions) {
      // 只绑定一次事件，防止 mount 多次调用造成重复启动/停止。
      panel.querySelector('[data-action="start"]').addEventListener("click", async () => {
        if (typeof this.onStart === "function") {
          try {
            // 启动前校验 staffId
            const staffId = await this._fetchStaffIdFromBackground();
            if (!staffId || !PHONE_REGEX.test(staffId)) {
              const input = panel.querySelector("#wa-staff-id-input");
              if (input) {
                input.classList.add("shake");
                input.focus();
                setTimeout(() => input.classList.remove("shake"), 500);
              }
              this._showStaffErrorTip(panel, "请先输入有效的11位手机号并保存");
              return;
            }
            this._clearStaffErrorTip(panel);
            // 启动回调在 controller 中完成，UI 这里只负责触发。
            await this.onStart();
          } catch (error) {
            // 错误信息由 controller 的 setState 处理并显示在 lastError 字段
          }
        }
      });

      panel.querySelector('[data-action="stop"]').addEventListener("click", async () => {
        if (typeof this.onStop === "function") {
          try {
            // 停止回调同样交给 controller，保证状态变更路径统一。
            await this.onStop();
          } catch (error) {
            // 错误信息由 controller 的 setState 处理并显示在 lastError 字段
          }
        }
      });

      const staffIdInput = panel.querySelector("#wa-staff-id-input");
      const saveBtn = panel.querySelector("#wa-staff-save-btn");
      if (staffIdInput && saveBtn) {
        // 面板内也允许直接维护客服手机号，保存到 background 的统一设置里。
        chrome.runtime.sendMessage(
          { type: BG_MESSAGE_TYPES.GET_SETTINGS },
          (response) => {
            if (response?.ok && response?.data?.STAFF_ID) {
              staffIdInput.value = response.data.STAFF_ID;
            }
          }
        );

        saveBtn.addEventListener("click", () => {
          const staffId = staffIdInput.value.trim();
          if (!staffId) {
            this._showStaffErrorTip(panel, "请输入手机号");
            staffIdInput.classList.add("shake");
            staffIdInput.focus();
            setTimeout(() => staffIdInput.classList.remove("shake"), 500);
            return;
          }
          if (!PHONE_REGEX.test(staffId)) {
            this._showStaffErrorTip(panel, "手机号格式不正确，需11位数字");
            staffIdInput.classList.add("shake");
            staffIdInput.focus();
            setTimeout(() => staffIdInput.classList.remove("shake"), 500);
            return;
          }
          this._clearStaffErrorTip(panel);

          const originalText = saveBtn.textContent;
          // 保存期间禁用按钮，避免连续点击发出重复写入请求。
          saveBtn.disabled = true;
          saveBtn.textContent = "保存中...";

          chrome.runtime.sendMessage(
            {
              type: BG_MESSAGE_TYPES.SAVE_SETTINGS,
              payload: { STAFF_ID: staffId }
            },
            (response) => {
              if (response?.ok) {
                saveBtn.textContent = "已保存";
                setTimeout(() => {
                  saveBtn.textContent = originalText;
                  saveBtn.disabled = false;
                }, 1500);
                return;
              }

              saveBtn.textContent = "保存失败";
              setTimeout(() => {
                saveBtn.textContent = originalText;
                saveBtn.disabled = false;
              }, 1800);
            }
          );
        });
      }

      const minimizeBtn = panel.querySelector('[data-action="minimize"]');
      if (minimizeBtn) {
        minimizeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.toggleMinimize();
        });
      }

      const panelTitle = panel.querySelector(".wa-auto-reply-title");
      if (panelTitle) {
        panelTitle.addEventListener("mousedown", (e) => {
          if (e.target.closest('[data-action="minimize"]')) return;
          this.startDrag(e);
        });
      }

      if (localStorage.getItem("wa-panel-minimized") === "true") {
        // 记住用户最小化偏好，刷新页面后保持面板形态。
        panel.classList.add("minimized");
      }

      const exportBtn = panel.querySelector("#wa-export-logs-btn");
      const datePicker = panel.querySelector("#wa-log-date-picker");
      const dateList = panel.querySelector("#wa-log-date-list");
      const selectAllCb = panel.querySelector("#wa-log-select-all-cb");

      if (exportBtn && datePicker && dateList) {
        let pickerVisible = false;

        const toggleDatePicker = async () => {
          pickerVisible = !pickerVisible;
          if (pickerVisible) {
            datePicker.style.display = "block";
            exportBtn.textContent = "确认导出";
            const dates = await getAllAvailableDates();
            dateList.innerHTML = "";
            if (dates.length === 0) {
              dateList.innerHTML = '<div class="wa-log-empty-tip">暂无日志</div>';
            } else {
              for (const d of dates) {
                const item = document.createElement("label");
                item.className = "wa-log-date-item";
                item.innerHTML = `<input type="checkbox" value="${d}" checked /><span class="wa-log-date-label">${d}</span>`;
                dateList.appendChild(item);
              }
            }
            if (selectAllCb) selectAllCb.checked = true;
          } else {
            const checked = dateList.querySelectorAll('input[type="checkbox"]:checked');
            const selectedDates = Array.from(checked).map((cb) => cb.value);
            if (selectedDates.length === 0) {
              datePicker.style.display = "none";
              exportBtn.textContent = "导出日志";
              pickerVisible = false;
              return;
            }
            exportBtn.disabled = true;
            exportBtn.textContent = "导出中...";
            try {
              await collectAndExportLogs(selectedDates);
              exportBtn.textContent = "已导出";
            } catch (e) {
              exportBtn.textContent = "导出失败";
            }
            datePicker.style.display = "none";
            setTimeout(() => {
              exportBtn.textContent = "导出日志";
              exportBtn.disabled = false;
            }, 1500);
            pickerVisible = false;
          }
        };

        exportBtn.addEventListener("click", toggleDatePicker);

        if (selectAllCb) {
          selectAllCb.addEventListener("change", () => {
            const cbs = dateList.querySelectorAll('input[type="checkbox"]');
            cbs.forEach((cb) => { cb.checked = selectAllCb.checked; });
          });
        }
      }

      panel.dataset.boundActions = "1";
    }

    this.root = root;
    this.panel = panel;
    this.hand = hand;
  }

  _fetchStaffIdFromBackground() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: BG_MESSAGE_TYPES.GET_SETTINGS },
          (response) => {
            resolve(response?.ok ? String(response.data?.STAFF_ID || "").trim() : "");
          }
        );
      } catch (_e) {
        resolve("");
      }
    });
  }

  _showStaffErrorTip(panel, msg) {
    let tip = panel.querySelector(".wa-staff-error-tip");
    if (!tip) {
      const staffRow = panel.querySelector("#wa-staff-id-input")?.closest(".wa-auto-reply-row");
      if (staffRow) {
        tip = document.createElement("div");
        tip.className = "wa-staff-error-tip";
        staffRow.after(tip);
      }
    }
    if (tip) tip.textContent = msg;
  }

  _clearStaffErrorTip(panel) {
    const tip = panel.querySelector(".wa-staff-error-tip");
    if (tip) tip.textContent = "";
  }

  bindActions(onStart, onStop) {
    // 保存启动/停止回调，按钮点击时再调用。
    this.onStart = onStart;
    this.onStop = onStop;
  }

  expandPanel() {
    this.mount();
    this.panel.classList.remove("collapsed");
  }

  collapsePanel() {
    this.mount();
    this.panel.classList.add("collapsed");
  }

  renderState(state = {}) {
    // 根据 store 中的状态快照刷新面板。
    this.mount();

    // 小工具函数：按 data-field 更新面板中的对应字段。
    const setText = (field, value) => {
      const el = this.panel.querySelector(`[data-field="${field}"]`);
      if (el) {
        el.textContent = value ?? "";
      }
    };

    setText("appState", state.appState || "IDLE");
    setText("queueProgressText", state.queueProgressText || "0/0");
    setText("scanScrollProgressText", state.scanScrollProgressText ?? "--");
    setText("scanFoundCount", String(state.scanFoundCount ?? 0));
    setText("currentChatId", state.currentChatId || "-");
    setText("currentAction", state.currentAction || "等待启动");
    setText("lastError", state.lastError ? `错误：${state.lastError}` : "");

    // 运行中禁用启动按钮，未运行时禁用停止按钮，避免状态互相打架。
    const running = Boolean(state.autoReplyStatus);
    const startBtn = this.panel.querySelector('[data-action="start"]');
    const stopBtn = this.panel.querySelector('[data-action="stop"]');
    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
  }

  showHand() {
    this.mount();
    this.hand.classList.add("visible");
  }

  hideHand() {
    this.mount();
    this.hand.classList.remove("visible");
  }

  async moveTo(x, y) {
    // 小手移动到指定坐标，用于可视化自动点击过程。
    this.mount();
    this.showHand();
    this.hand.style.left = `${Math.max(0, x)}px`;
    this.hand.style.top = `${Math.max(0, y)}px`;
    await this.sleep(460);
  }

  async moveToElement(el) {
    if (!el) return;

    // 使用元素左上区域作为目标点，避免点到超宽元素的空白中间。
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.min(rect.width, 24);
    const y = rect.top + Math.min(rect.height, 20);
    await this.moveTo(x, y);
  }

  async clickEffect() {
    // 点击效果只做缩放动画，不真正触发点击；实际点击由 DOM adapter/sender 负责。
    this.mount();
    this.hand.style.transform = "scale(0.9)";
    await this.sleep(100);
    this.hand.style.transform = "scale(1)";
    await this.sleep(100);
  }

  async restAtCorner() {
    // 空闲时把小手停到右上角附近，降低遮挡聊天内容的概率。
    await this.moveTo(window.innerWidth - 80, 100);
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  toggleMinimize() {
    this.mount();
    // 只隐藏面板主体，不销毁 DOM，后续状态更新仍可继续写入。
    this.panel.classList.toggle("minimized");
    if (this.panel.classList.contains("minimized")) {
      localStorage.setItem("wa-panel-minimized", "true");
    } else {
      localStorage.removeItem("wa-panel-minimized");
    }
  }

  startDrag(e) {
    // 允许在 minimized 状态下拖动
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = this.panel.getBoundingClientRect();
    const panelX = rect.left;
    const panelY = rect.top;

    const onMouseMove = (moveEvent) => {
      // 限制面板不被拖出窗口外，避免用户找不到控制面板。
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const newX = panelX + deltaX;
      const newY = panelY + deltaY;

      this.panel.style.left = `${Math.max(0, Math.min(newX, window.innerWidth - this.panel.offsetWidth))}px`;
      this.panel.style.top = `${Math.max(0, Math.min(newY, window.innerHeight - this.panel.offsetHeight))}px`;
      this.panel.style.right = "auto";
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }
}
