# WhatsApp Sales Copilot Chrome Extension

## 项目描述

这是一个Chrome浏览器扩展，旨在帮助销售人员更高效地在WhatsApp上进行客户沟通和管理。该扩展提供了自动消息处理、队列管理、状态同步等功能，帮助销售团队提升工作效率。

## 功能特性

- **消息解析与读取**：自动解析WhatsApp消息内容
- **自动发送**：支持批量或定时发送消息
- **队列管理**：管理待发送消息队列
- **状态存储**：本地存储聊天状态和数据
- **音频保持活跃**：防止WhatsApp因不活跃而断开
- **聊天ID管理**：处理聊天标识符
- **日志收集**：记录操作日志用于调试
- **重试机制**：失败消息自动重试
- **时间工具**：处理时间相关功能
- **文件上传**：支持文件上传功能
- **API客户端**：与后端API交互

## 安装步骤

1. 下载或克隆此项目到本地。
2. 打开Chrome浏览器，输入 `chrome://extensions/` 进入扩展管理页面。
3. 开启右上角的"开发者模式"。
4. 点击"加载已解压的扩展程序"，选择项目根目录。
5. 扩展将出现在扩展列表中，确保它已启用。

## 使用方法

1. 安装扩展后，打开WhatsApp Web (https://web.whatsapp.com)。
2. 点击扩展图标打开弹出窗口。
3. 根据需要配置设置。
4. 扩展将自动开始监控和处理消息。

## 开发说明

### 项目结构

- `manifest.json`：扩展清单文件，定义扩展的基本信息、权限和脚本入口
- `package_lock.json`：npm依赖锁定文件，确保依赖版本一致
- `src/background/`：后台脚本目录，处理扩展的后台逻辑
  - `api-client.js`：API客户端，用于与后端服务器通信
  - `file-uploader.js`：文件上传功能，处理文件上传到服务器
  - `storage.js`：存储管理，处理本地存储和数据持久化
  - `task-bridge.js`：任务桥接，连接后台和内容脚本的任务
- `src/content/`：内容脚本目录，注入到WhatsApp页面中执行
  - `audio-keepalive.js`：音频保持活跃，防止WhatsApp因不活跃断开
  - `bootstrap-loader.js`：引导加载器，初始化内容脚本
  - `bootstrap.js`：引导脚本，启动扩展功能
  - `chat-opener.js`：聊天开启器，自动打开聊天窗口
  - `controller.js`：控制器，协调内容脚本的各个模块
  - `cursor-visualizer.js`：光标可视化，显示鼠标位置
  - `dom-adapter.js`：DOM适配器，适配WhatsApp页面的DOM操作
  - `message-parser.js`：消息解析器，解析WhatsApp消息内容
  - `message-reader.js`：消息读取器，读取聊天消息
  - `queue-manager.js`：队列管理器，管理消息发送队列
  - `sender.js`：发送器，处理消息发送逻辑
  - `state-store.js`：状态存储器，存储聊天状态
  - `sync-local-storage.js`：本地存储同步，同步本地存储数据
  - `unread-scanner.js`：未读扫描器，扫描未读消息
  - `visibility-guard.js`：可见性守卫，监控页面可见性
- `src/popup/`：弹出页面目录，扩展图标点击时显示的界面
  - `popup.css`：弹出页面样式文件
  - `popup.html`：弹出页面HTML结构
  - `popup.js`：弹出页面逻辑脚本
- `utils/`：工具函数目录，提供通用工具
  - `bg-log-collector.js`：后台日志收集器，收集后台日志
  - `chat-id.js`：聊天ID工具，处理聊天标识符
  - `constants.js`：常量定义文件
  - `hash.js`：哈希工具，生成哈希值
  - `log-collector.js`：日志收集器，收集日志
  - `logger.js`：日志器，提供日志功能
  - `retry.js`：重试工具，实现重试机制
  - `time.js`：时间工具，处理时间相关操作

### 技术栈

- JavaScript (ES6+)
- Chrome Extension API
- HTML/CSS (用于弹出页面)

### 构建与运行

此项目使用npm管理依赖。运行以下命令安装依赖：

```bash
npm install
```

### 权限说明

扩展需要以下权限：
- `activeTab`：访问当前标签页
- `storage`：本地存储
- `tabs`：标签页管理
- `https://www.whatsapp.com/*`：访问WhatsApp Web

## 贡献

欢迎提交Issue和Pull Request来改进此项目。

## 许可证

[MIT License](LICENSE)

## 联系方式

如有问题，请通过GitHub Issues联系。
