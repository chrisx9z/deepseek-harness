# @deepseek-ai/dsh-session-chat-share

[English](README.md) | 中文

Web 聊天片段分享控件：在 Session Header 对话框中选择消息范围，以 Markdown 复制，或下载为 Markdown/HTML 文件。Host 半区注册 `/share` 命令；浏览器半区负责 Header 操作、范围选择模态框、渲染器以及剪贴板和下载操作。消息历史通过常规的 `session.history` RPC 读取——不新增 Host 端点、不改动持久化，也不涉及模型。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/share` | 记录一次人工命令生命周期；提交的浏览器收到本地执行确认后，为该 Session 打开分享对话框。 |
| `/share <参数>` | 返回错误。范围选择由对话框负责，命令不接受参数。 |

命令仅由 Web bundle 挂载。本地 `command/executed` 确认只在提交命令的浏览器中打开对话框；其他标签页仍渲染持久的命令行，但不重复浏览器的副作用。Header 按钮直接调用同一个控制器。

对话框按最新在前列出会话中可分享的消息（追加来源的 `user/message` 与 `assistant/message` 文本），用户可通过 From/To 下拉框或点击消息行选择闭区间范围，选择 Markdown 或 HTML，预览渲染结果，然后复制到剪贴板或下载。渲染产物是纯文本——Markdown 在角色标题下原样保留消息文本；HTML 是自包含页面，提供基础渲染（段落和围栏代码块），任何浏览器都能打开。图片以 `[image]` 标记表示；工具调用、工具结果、边界标记和压缩替换副本均被排除。

## 组合

```yaml
- id: chat-share
  name: '@deepseek-ai/dsh-session-chat-share'
```

Web bundle 将该包与 `dsh-host-apiproxy`、`dsh-commands`、`dsh-client-ui-commands` 和 `dsh-client-ui-conversation` 一同挂载。该包将其按钮和对话框贡献到右对齐的 `conversation.session.header.utilities` 列表，与 `conversation.session.header.actions` 中标题旁的 mode、Subagent 和 Task 条目相互独立；Trajectory 不提供分享控件。

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
- 分享是复制/下载产物，而非托管链接：接收方打开 Markdown 或 HTML 文件，不上传任何内容到服务器。
- HTML 输出刻意保持基础（段落和围栏代码块）；强调、链接等行内 Markdown 在 HTML 产物中保留为字面文本，而 Markdown 产物则原样保留。
- 消息文本按界面上的渲染结果分享；推理文本和工具活动不包含在内。
