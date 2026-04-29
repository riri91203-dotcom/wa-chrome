/**
 * content/bootstrap.js
 *
 * 已接入 utils 的 content script 入口
 * 负责：
 * 1. 防重复初始化
 * 2. 创建 store / cursor / dom / controller
 * 3. 监听 runtime 消息
 * 4. 页面加载后自动挂载
 */

import { ContentStateStore } from "./state-store.js";
import { CursorVisualizer } from "./cursor-visualizer.js";
import { WhatsAppDomAdapter } from "./dom-adapter.js";
import { WhatsAppAutoReplyController } from "./controller.js";

import { BG_MESSAGE_TYPES, CT_MESSAGE_TYPES, DOM_CONSTANTS } from "../utils/constants.js";
import { logger } from "../utils/logger.js";
import { initContentLogCollector } from "../utils/log-collector.js";
// Bootstrap 模块加载完成
const { GLOBAL_APP_KEY } = DOM_CONSTANTS;
const CONTENT_READY_KEY = "__WA_CONTENT_READY__";

async function createApp() {
  // 这里是 content 侧的依赖装配入口：
  // 先创建基础模块，再把它们注入 controller，避免各模块互相 import 形成强耦合。
  // 创建应用的三个核心组件：状态存储、光标可视化、DOM 适配器
  const store = new ContentStateStore();
  const cursor = new CursorVisualizer();
  const dom = new WhatsAppDomAdapter();

  // 创建主控制器
  const controller = new WhatsAppAutoReplyController({
    store,
    cursor,
    dom
  });

  // 初始化控制器（连接事件监听和状态订阅）
  controller.init();
  
  // 从后台进程恢复状态
  await store.hydrateFromBackground();

  // 设置初始 UI 状态
  await store.setState(
    {
      panelExpanded: true,    // 面板初始展开
      handVisible: false,
      currentAction: "等待启动"
    },
    false
  );

  // 启动主循环
  controller.ensureLoopRunning();

  return {
    store,
    cursor,
    dom,
    controller
  };
}

/**
 * runtime 消息监听
 */
function bindRuntimeMessage(app) {
  // popup/background 发来的消息都在这里汇总，再转发给 controller 或 store。
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { controller, store } = app;

    (async () => {
      switch (message?.type) {
        case CT_MESSAGE_TYPES.PING:
          // 给 popup 探测 content 是否已经注入成功。
          sendResponse({
            ok: true,
            data: { alive: true, source: "content" }
          });
          return;

        case CT_MESSAGE_TYPES.GET_STATE:
          // popup 刷新状态时读取当前页面内的实时 store。
          sendResponse({
            ok: true,
            data: store.getState()
          });
          return;

        case CT_MESSAGE_TYPES.START:
          // popup 点击启动时进入 controller.start。
          await controller.start();
          sendResponse({
            ok: true,
            data: store.getState()
          });
          return;

        case CT_MESSAGE_TYPES.STOP:
          // popup 点击停止时进入 controller.stop。
          await controller.stop();
          sendResponse({
            ok: true,
            data: store.getState()
          });
          return;

        default:
          sendResponse({
            ok: false,
            error: `Unknown content message type: ${message?.type}`
          });
      }
    })().catch((error) => {
      logger.error("内容脚本消息处理失败", error);
      sendResponse({
        ok: false,
        error: error?.message || "Unknown content runtime error"
      });
    });

    // 返回 true 表示 sendResponse 会在异步任务完成后再调用。
    return true;
  });
}

/**
 * 等页面 ready
 */
async function waitForPageReady() {
  // WhatsApp Web 首屏加载较慢，#pane-side 出现后才说明左侧聊天列表可操作。
  const maxWait = 30000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const pane = document.querySelector("#pane-side");
    if (pane) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

/**
 * 自动启动逻辑：
 * 如果 background 里已经是 enabled=true，则自动恢复运行
 */
async function autoResumeIfNeeded(app) {
  try {
    // 扩展重载或页面刷新后，如果后台开关仍是开启状态，则自动恢复运行。
    const res = await chrome.runtime.sendMessage({
      type: BG_MESSAGE_TYPES.GET_AUTO_REPLY_STATUS
    });

    if (res?.ok && res?.data?.enabled) {
      await app.store.setState(
        {
          autoReplyStatus: true,
          panelExpanded: true,
          handVisible: true,
          currentAction: "检测到自动回复已开启，准备恢复运行..."
        },
        false
      );

      logger.info("检测到自动回复已开启，开始自动恢复运行");
      await app.controller.start();
    }
  } catch (error) {
    logger.warn("自动恢复运行失败", error);
  }
}

/**
 * content script 主启动流程：
 * 等待 WhatsApp 侧边栏就绪后创建应用，并向 window 暴露实例供后续消息复用。
 */
async function bootstrap() {
  // 尽早初始化日志收集器，确保后续所有日志都被捕获
  initContentLogCollector();

  if (window[GLOBAL_APP_KEY]) {
    // 避免 popup 重复注入 loader 后创建多个 controller。
    window[CONTENT_READY_KEY] = true;
    logger.info("内容脚本已初始化，跳过重复启动");
    return;
  }

  const pageReady = await waitForPageReady();
  if (!pageReady) {
    logger.warn("WhatsApp 页面未就绪，启动流程已中止");
    return;
  }

  const app = await createApp();
  
  bindRuntimeMessage(app);

  // 把 app 挂到 window，后续可用于重复注入检测和必要时的人工调试。
  window[GLOBAL_APP_KEY] = app;
  window[CONTENT_READY_KEY] = true;

  logger.info("内容脚本初始化完成");
  
  await autoResumeIfNeeded(app);
}

bootstrap().catch((error) => {
  window[CONTENT_READY_KEY] = false;
  logger.error("内容脚本启动失败", error);
});
