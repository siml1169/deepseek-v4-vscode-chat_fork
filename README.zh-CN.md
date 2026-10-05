# DeepSeek V4 for Copilot Chat

> 🌐 本文是英文 [README](./README.md) 的中文版，**以英文版为准**；协议细节见英文 [ARCHITECTURE](./ARCHITECTURE.md)。同步时间：2026-08-25。发现两版不一致欢迎提 issue。

在 VS Code Copilot Chat 里把 DeepSeek V4（Pro / Flash / Flash Vision）当原生模型用 —— 扩展思考、Agent 模式工具调用、图片输入，以及状态栏里你真实的 DeepSeek 账单。

[![VS Code](https://img.shields.io/badge/VS%20Code-1.106%2B-blue)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[English](./README.md) · [更新日志](./CHANGELOG.md) · [架构文档（贡献者向，英文）](./ARCHITECTURE.md)

## 快速开始

你需要 VS Code 1.106+、已登录的 **GitHub Copilot Chat** 扩展（本扩展只是往它的模型选择器里加模型），以及一个有 API 余额的 DeepSeek 账号。

1. 从 VS Code Marketplace 安装 **DeepSeek V4 for Copilot Chat**。
2. 命令面板 → `Manage DeepSeek V4 Provider` → 粘贴你的 [DeepSeek API 密钥](https://platform.deepseek.com/api_keys)。
3. 在 Copilot Chat 的模型选择器里选一个 DeepSeek V4 变体。如果列表里没有，点选择器里的 **Manage Models…**，启用 DeepSeek V4。

## 模型

| 选择器条目 | API 模型 | 思考 | 图片 | 输入预算 | 输出预算 |
| ------ | ------ | :---: | :---: | ------ | ------ |
| DeepSeek V4 Pro (thinking) | `deepseek-v4-pro` | ✓ | — | 640K | 384K |
| DeepSeek V4 Pro | `deepseek-v4-pro` | — | — | 960K | 64K |
| DeepSeek V4 Flash (thinking) | `deepseek-flash` | ✓ | ✓ | 640K | 384K |
| DeepSeek V4 Flash | `deepseek-flash` | — | ✓ | 960K | 64K |
| DeepSeek V4 Flash Vision (thinking) | `deepseek-flash` | ✓ | ✓ | 640K | 384K |
| DeepSeek V4 Flash Vision | `deepseek-flash` | — | ✓ | 960K | 64K |

**(thinking)** 变体会先在隐藏的思维链里推理再作答 —— 更慢、更费 token，但更擅长难题和 Agent 任务；不带后缀的变体直接作答。所有变体共享 DeepSeek V4 的 1M token 上下文（输入 + 输出）；thinking 变体为输出预留 384K，以免长推理链被截断。

选择器 ID 和已保存的模型选择保持不变。所有 Flash 和旧 Flash Vision 条目均使用当前的 `deepseek-flash` API 模型，并支持图片；Pro 路由不变。

## 你能得到什么

- 扩展思考，深度可选（`low` / `high` / `max`），推理链跨多轮 Agent 循环保留
- Agent 模式工具调用，长多轮循环照常工作 —— 工具结果和模型自己的推理逐轮带下去
- 所有 Flash 变体原生支持图片输入
- 状态栏实时显示账户余额（自动识别 CNY / USD）；悬浮层另有本次会话花费
- 上下文窗口用量接入 Copilot Chat 原生指示器（需 VS Code 1.120+）
- 带处理建议的错误提示（400 / 401 / 402 / 422 / 429），临时故障自动重试
- 首次运行演练（Walkthrough）；未设密钥时选择器条目显示警告而不是消失

## 图片（Flash 变体）

选任意 **Flash** 变体，在 Copilot Chat 里附加图片即可；图片输入可与思考和工具调用一起使用。

- 格式：JPEG、PNG、GIF、WebP。其他附件 —— 以及发给纯文本变体的图片 —— 都会被丢弃，绝不会由其他模型转述。
- 限制：UTF-8 JSON 请求体最大 48 MiB（base64 计入），单张内联图片最大 32 MiB，每次请求最多 600 张图片。每边最大 8192 像素；请求含 15 张或更多图片时降为 4096。检查范围包括历史中实际发送的图片。
- 费用：按分辨率计算，每张最多 1024 tokens；本地估算使用此上限，实际用量以 API 返回为准。
- `deepseekv4.imageDetail` 支持 `low`、`high`、`original`、`auto`。未显式设置时省略该字段，使用 API 的 `original` 默认值。
- 图片格式按实际字节识别，不依赖声明的 MIME 类型。元数据损坏时拒绝并提示重新导出；不支持的格式会丢弃并给出诊断。
- 暂不支持外部图片 URL 或 Files API 引用。文档规定工具结果中不支持图片。

## 为什么要原生 provider？

通用的 OpenAI 兼容桥接器为 DeepSeek V4 做不到的两件事：

- **推理往返。** 带工具的 thinking 请求必须回传所有先前 assistant 轮的原始 `reasoning_content`，包括没有工具调用的轮次和已完成的用户问题。VS Code 历史不含此字段，本扩展在本地缓存它。未发送工具定义时省略历史推理，因为 API 会忽略它。原始推理缺失时给出诊断，而不是用空字符串冒充完整回传。
- **真实费用，不是估算。** 余额与会话花费来自 DeepSeek 的 `/user/balance`；缓存命中 / 未命中 token 来自真实的 `usage` 数据。

## 命令

| 命令 | 说明 |
| ------ | ------ |
| `Manage DeepSeek V4 Provider` | 设置或更新 API 密钥 |
| `Refresh DeepSeek V4 Balance` | 拉取最新账户余额 |
| `Show DeepSeek V4 Log` | 打开运行日志输出通道 |
| `Show DeepSeek V4 Reasoning Cache Stats` | 推理缓存诊断 |
| `Clear DeepSeek V4 Reasoning Cache` | 清空缓存的 `reasoning_content`（如分享日志前） |
| `Clear DeepSeek V4 Session Counter` | 重置会话花费显示 |
| `Compact Copilot Chat` | 上下文接近上限时运行 Copilot Chat 的 `/compact` |

## 设置

| 设置项 | 取值 | 默认 | 说明 |
| ------ | ------ | ------ | ------ |
| `deepseekv4.reasoningEffort` | `low` \| `high` \| `max` 及文档中的别名 | `high` | 仅影响 thinking 变体，保留已有显式配置。`minimal` → `low`，`medium`/`xhigh` → `high`，`ultra` → `max`。 |
| `deepseekv4.imageDetail` | `low` \| `high` \| `original` \| `auto` | 未设置（API：`original`） | Flash 图片处理精度，未显式设置时不发送字段。 |
| `deepseekv4.logRawReasoning` | `boolean` | `false` | 把原始 `reasoning_content` 流式写入日志（只在排查缓存击穿时有用）。可能捕获私有代码 —— 分享日志时请保持**关闭**。 |

## 计费与 Copilot 高级请求配额

每个请求都只发往 `api.deepseek.com`，用**你的**密钥认证，从你预付的 DeepSeek 余额扣费（按量计费，见 [DeepSeek 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)），绝不动你的 Copilot 配额。

2026-08-16 起，价格还取决于你**什么时候**发请求 —— DeepSeek 区分高峰和非高峰计费，非高峰是半价。扩展**刻意不编码**这些时段：它们是厂商策略，而且已经变更过一次。当前时段请看上面的价格页。状态栏只显示那个不会过期的东西：你真实的余额，直接来自 `/user/balance`。

唯一的例外来自 Copilot Chat 自身：**Agent 模式**下它可能启动**子代理**（`agent` / `runSubagent` 工具，典型如 Explore Agent），跑在 Copilot 托管模型上（无视你选的模型），这部分**会**消耗高级请求。这影响所有自带密钥（BYOK）的提供方（[community#197840](https://github.com/orgs/community/discussions/197840)、[#16](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/16)）。规避方式：

1. Agent 模式下打开工具选择器（聊天输入框里的 **Configure Tools** 图标），**取消勾选 `agent` / `runSubagent`** —— 最可靠。
2. 或把 `github.copilot.chat.exploreAgent.model` 设为某个 DeepSeek V4 模型。
3. 或不需要工具的轮次改用 Ask 模式。

## 常见问题

**报错 `The reasoning_content in the thinking mode must be passed back to the API`（400）。**
带工具的 thinking 请求必须保留原始推理。若历史来自其他模型、缓存已清空或内容已淘汰，请新开会话、禁用工具或选择不带 thinking 的变体。*Show DeepSeek V4 Reasoning Cache Stats* 可诊断；空占位符不等同于原始推理。

**弹出警告 "prompt cache hit rate dropped"。**
你这个会话在 DeepSeek 服务端的缓存前缀断了，后续轮次按全价（缓存未命中）输入价计费，而不是更便宜的缓存命中价。扩展无法判断具体原因 —— 某轮中途取消或失败、超长会话中被淘汰、编辑器重启都有可能。点 *Start New Chat* 新开会话即可止损；*Show Cache Stats* 可诊断。背景：[#19](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/19)。

**Copilot 上下文指示器显示 0 / 0%。**
升级到 VS Code **1.120+** —— 更早的宿主不会为扩展提供的模型显示用量（[#18](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/18)、[microsoft/vscode#315394](https://github.com/microsoft/vscode/issues/315394)）。

**我附加的图片被忽略了。**
所有 Flash 变体都会发送受支持的图片，Pro 不支持图片。检查格式、尺寸、数量和上文的 48 MiB / 32 MiB 限制。

**为什么不支持 OpenRouter / 自定义 base URL？**
有意为之（[#4](https://github.com/Laurent00TT/deepseek-v4-vscode-chat/issues/4)）：OpenRouter 会改写 DeepSeek 的 thinking 协议（`reasoning_details` 而非 `reasoning_content`、不同的 thinking 开关、没有缓存命中计数）—— 恰好是本扩展依赖的东西。要走 OpenRouter，请改用专门的 provider，例如 [ostash/openrouter-chat-provider](https://github.com/ostash/openrouter-chat-provider)。

## 隐私

- **零遥测。** 唯一的网络对端是 `api.deepseek.com`；图片也只发往那里。
- API 密钥存放在 VS Code **SecretStorage**（系统钥匙串），不会写入设置文件。
- 推理缓存存在磁盘上（VS Code 重启后仍在），可能包含你的代码与提示词片段；*Clear DeepSeek V4 Reasoning Cache* 可清空，`deepseekv4.logRawReasoning` 默认关闭。

## 许可

MIT，见 [LICENSE](./LICENSE)。Fork 自 [huggingface-vscode-chat](https://github.com/huggingface/huggingface-vscode-chat)，协议层为 DeepSeek V4 重写。
