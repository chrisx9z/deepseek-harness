# @deepseek-ai/dsh-session-chat-share

[English](README.md) | 中文

Web 聊天片段分享控件：选择消息范围，以 Markdown 复制，或下载为 Markdown/HTML/TXT 文件。Host 半区注册 `/share` 命令（支持 `txt` / `last <n>` 形式与可选的回合结束自动保存）；浏览器半区负责 Header 操作、侧边栏会话行 `...` 菜单入口、范围选择模态框、渲染器以及剪贴板和下载操作。消息历史通过常规的 `session.history` RPC 读取，图片通过 `session.attachment` 嵌入——不新增 Host 端点、不改动持久化，也不涉及模型。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/share` | 记录一次人工命令生命周期；提交的浏览器为该 Session 打开分享对话框。 |
| `/share txt` | 不打开对话框，将整个会话的可分享聊天保存为一个 `.txt` 文件。 |
| `/share last <n>` | 只保存最新 `<n>` 条可分享消息为 `.txt`（也可组合：`/share txt last 10`）。 |
| 其他 | 返回错误并列出可接受的形式。 |

命令仅由 Web bundle 挂载。本地 `command/executed` 确认只在提交命令的浏览器中打开对话框（或启动直接保存）；其他标签页仍渲染持久的命令行，但不重复浏览器的副作用。Header 按钮直接调用同一个控制器。

对话框按最新在前列出会话中可分享的消息（追加来源的 `user/message` 与 `assistant/message` 文本），用户可通过 From/To 下拉框或点击消息行选择闭区间范围——或切换**多选模式**导出所选行的并集——选择 Markdown、HTML、TXT 或 PNG，预览渲染结果（GFM），然后复制到剪贴板或下载。选项：**脱敏敏感信息**（凭据形态与本地绝对/家目录路径，默认开启）、**包含工具调用**（有界的工具调用行，默认关闭）与**包含子代理对话**（子会话以节标题追加，默认关闭）。产物头部在已知时携带会话标题与最后使用的模型路由，并跟随当前界面语言。Markdown 在角色标题下原样保留消息文本；HTML 是自包含页面，提供 GFM-lite 渲染（标题、列表、表格、引用、链接、围栏代码、行内代码/强调），会话图片以 data URI 嵌入；TXT 是去掉所有标记的同一内容；PNG 是将 HTML 产物栅格化为一整张长图。文本格式中图片以 `[image]` 标记表示；工具结果、边界标记和压缩替换副本均被排除。当对话框达到 300 行上限时会明确提示——直接保存（`/share txt`、保存 TXT）始终携带完整对话。

## 组合

```yaml
- id: chat-share
  name: '@deepseek-ai/dsh-session-chat-share'
  config:
    autoSaveDir: 'C:/shares'
```

`autoSaveDir` 配置为可选：设置后，Host 会在每个完成的回合后为该 Session 写入一份 TXT。

Web bundle 将该包与 `dsh-host-apiproxy`、`dsh-commands`、`dsh-client-ui-commands` 和 `dsh-client-ui-conversation` 一同挂载。该包将其按钮和对话框贡献到右对齐的 `conversation.session.header.utilities` 列表，并通过 `dsh-client-ui-workspace` 提供的 `sessionRowMenu` 注册表，在每个会话的侧边栏 `...` 菜单中加入 Share 和保存 TXT 行；Trajectory 不提供分享控件。

## 模型体验

### 人工 `/share` 控件

#### 模型看到什么

什么也没有。`/share` 停留在人工命令平面，复制或下载的产物从不进入模型历史。

#### Token 影响

零。命令不创建模型回合，对话框从 `session.history` 页面渲染，不发起 LLM 请求。

#### KV 缓存影响

无。仅记录日志的命令生命周期和浏览器端渲染不会改变派生的请求前缀。

## 已知限制与后续工作

- 对话框从 Session 日志尾部最多读取 300 条可分享消息；更早的消息不在单次片段范围内。
- 分享是复制/下载产物，而非托管链接：接收方打开 Markdown、HTML 或 TXT 文件，不上传任何内容到服务器。
- 脱敏是基于模式的尽力而为，并非保证；分享前请检查产物。
- 消息文本按界面上的渲染结果分享；推理文本与工具结果不包含（工具调用仅在勾选时包含）。
