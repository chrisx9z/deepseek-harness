# @deepseek-ai/dsh-session-share

[English](README.md) | 中文

## Summary

`dsh-session-share` 用于分享会话中选定范围的消息。Session Header 新增 Share 操作，`/share` 命令打开同一个弹窗：选择闭区间或多选并集，选择 Markdown、HTML、TXT 或 PNG，预览 GFM 渲染结果，然后复制或下载。Host 半边把持久事件折叠为 `GET /api/session.share` 上的一份 JSON 载荷，冷读安全并内联被引用的图片，因此无论界面已分页多少内容，导出都覆盖整个会话。先讲配置与用法，再讲实现细节。

## Compatibility

本包面向 harness `0.1.6-alpha.2` 及更高版本，其中浏览器通过 Session Controller 与会话载荷路由读取会话数据。

## Command contract

| Input | Result |
|---|---|
| `/share` | Record a human-command lifecycle; the submitting browser opens the share dialog for that Session. |
| `/share txt` | Save the Session's whole shareable chat as one `.txt` file, without opening the dialog. |
| `/share last <n>` | Save only the newest `<n>` shareable messages as `.txt` (also valid combined: `/share txt last 10`). |
| anything else | Return an error with the accepted forms. |

该命令仅由 Web bundle 挂载。本地 `command/executed` 确认只让提交命令的浏览器打开弹窗（或开始直接保存）；其他标签页仍渲染持久命令行，但不会重复浏览器副作用。Header 按钮直接调用同一个控制器。

弹窗按时间顺序（最新在最后）列出会话中可分享的消息（追加来源的 `user/message` 与 `assistant/message` 文本），可用 From/To 下拉框或点击消息行选择闭区间范围——也可切换到**多选模式**导出所选行的并集——再选择 Markdown、HTML、TXT 或 PNG，预览渲染结果（GFM），最后复制到剪贴板或下载。选项包括：**脱敏敏感信息**（凭据形态与本地绝对/家目录路径，默认开启）、**包含工具调用**（有界工具调用行，默认关闭）、**包含子代理对话**（子会话以分节标题追加，默认关闭）。生成的产物跟随当前 UI 语言。Markdown 以角色标题保留消息原文；HTML 是自包含页面，具备 GFM-lite 渲染（标题、列表、表格、引用、链接、围栏代码、行内代码/强调），会话图片以 data URI 内嵌；TXT 是同样内容但不含任何标记；PNG 是把 HTML 产物栅格化成长图。文本格式中图片以 `[image]` 标记表示；工具结果、边界标记与压缩替换副本均被排除。弹窗达到 300 行上限时会提示——直接保存（`/share txt`）始终导出完整对话。

## Composition

```yaml
- id: session-share
  name: '@deepseek-ai/dsh-session-share'
  config:
    autoSaveDir: 'C:/shares'
    includeImages: true
```

两个配置键都是可选的：`autoSaveDir` 让 Host 在每个回合结束后为每个 Session 写一个 TXT；`includeImages`（默认 `true`）控制载荷是否把引用的图片以 base64 内联。

Web bundle 将本包与 `dsh-commands`、`dsh-session-query`、`dsh-client-ui-commands`、`dsh-client-ui-conversation` 一起挂载。本包把按钮与弹窗贡献到右对齐的 `conversation.session.header.utilities` 列表；Trajectory 不含分享控件。Host 半边在浏览器传输上提供 `GET /api/session.share?sessionId=<id>&includeSubagents=<bool>`，返回一份 `{sessionId, title, cwd, messages}` JSON 载荷。

## Model Experience

### Human `/share` control

#### What the model sees

Nothing. `/share` stays on the human-command plane, and the copied or downloaded artifact never enters model history.

#### Token effect

Zero. The command creates no model turn, and the dialog renders from one Host payload route without an LLM request.

#### KV Cache effect

None. The log-only command lifecycle and browser-side rendering do not change the derived request prefix.

## Known Limitations and Deferred Work

- 弹窗最多列出最新的 300 行可分享消息；更早的消息可通过直接保存获取，直接保存始终导出完整对话。
- 分享是复制/下载产物，而非托管链接：接收方打开 Markdown、HTML、TXT 或 PNG 文件，不上传任何内容到服务器。
- 脱敏是尽力而为的模式匹配，不构成保证；分享前请自行检查产物。
- 消息文本按界面呈现分享；推理文本与工具结果不包含在内（仅工具调用，需显式开启）。
- 早期 harness 版本中的侧边栏会话行 `...` 菜单已不存在，因此 Header 按钮与 `/share` 是两个入口。

No runtime invariant companion is published because the command registry owns command lifecycle pairing and the browser half owns range rendering.
