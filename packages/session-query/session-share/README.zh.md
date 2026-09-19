---
description: "会话分享：/share 命令、Host 分享载荷路由，以及把选定消息范围复制或下载为 Markdown、HTML、TXT 或 PNG 的 Session Header 弹窗。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-share

[English](README.md) | 中文

## 概述

`dsh-session-share` 用于分享会话中选定范围的消息。Session Header 新增 Share 操作，`/share` 命令打开同一个弹窗：选择闭区间或多选并集，选择 Markdown、HTML、TXT 或 PNG，预览 GFM 渲染结果，然后复制或下载。Host 半边把持久事件折叠为 `GET /api/session.share` 上的一份 JSON 载荷，冷读安全并内联被引用的图片，因此无论界面已分页多少内容，导出都覆盖整个会话。先讲配置与用法，再讲实现细节。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 Web bundle 需要让用户分享一段对话时使用本包。它需要 Host 侧的命令注册表与 Connection 的 Fetch 路由载体，以及浏览器侧的 slot 与 locale 席位；Session query 是可选的，只决定载荷能携带多少内容。挂载插件后，点击 Session Header 的 Share 或输入 `/share`；弹窗会把选定范围复制到剪贴板或下载为文件。

兼容性：本包面向 harness `0.1.6-alpha.2` 及更高版本，其中浏览器通过 Session Controller 与会话载荷路由读取会话数据。harness `0.1.0-rc.x` 请改用此前的 `dsh-chat-share` 系列。

### 组合

```yaml
- id: session-share
  name: '@deepseek-ai/dsh-session-share'
  config:
    autoSaveDir: 'C:/shares'
    includeImages: true
```

两个配置键都是可选的：`autoSaveDir` 让 Host 在每个回合结束后为每个 Session 写一个 TXT；`includeImages`（默认 `true`）控制载荷是否把引用的图片以 base64 内联。

### 配置

| Key | Default | Effect |
|---|---|---|
| `autoSaveDir` | unset | Write one plain-text share into this folder after every completed turn. |
| `includeImages` | `true` | Inline referenced images as base64 in the payload; `false` keeps text only and shrinks the response. |

### 命令约定

| Input | Result |
|---|---|
| `/share` | Record a human-command lifecycle; the submitting browser opens the share dialog for that Session. |
| `/share txt` | Save the Session's whole shareable chat as one `.txt` file, without opening the dialog. |
| `/share last <n>` | Save only the newest `<n>` shareable messages as `.txt` (also valid combined: `/share txt last 10`). |
| anything else | Return an error with the accepted forms. |

该命令仅由 Web bundle 挂载。本地 `command/executed` 确认只让提交命令的浏览器打开弹窗（或开始直接保存）；其他标签页仍渲染持久命令行，但不会重复浏览器副作用。Header 按钮直接调用同一个控制器。

### 预期行为

弹窗按时间顺序（最新在最后）列出会话中可分享的消息（追加来源的 `user/message` 与 `assistant/message` 文本），可用 From/To 下拉框或点击消息行选择闭区间范围——也可切换到**多选模式**导出所选行的并集——再选择 Markdown、HTML、TXT 或 PNG，预览渲染结果（GFM），最后复制到剪贴板或下载。选项包括：**脱敏敏感信息**（凭据形态与本地绝对/家目录路径，默认开启）、**包含工具调用**（有界工具调用行，默认关闭）、**包含子代理对话**（子会话以分节标题追加，默认关闭）。生成的产物跟随当前 UI 语言。Markdown 以角色标题保留消息原文；HTML 是自包含页面，具备 GFM-lite 渲染（标题、列表、表格、引用、链接、围栏代码、行内代码/强调），会话图片以 data URI 内嵌；TXT 是同样内容但不含任何标记；PNG 是把 HTML 产物栅格化成长图。文本格式中图片以 `[image]` 标记表示；工具结果、边界标记与压缩替换副本均被排除。弹窗达到 300 行上限时会提示——直接保存（`/share txt`）始终导出完整对话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

### 设计拆分

Host 半边在人工命令平面注册 `/share` 命令，提供 `GET /api/session.share`，并在设置 `autoSaveDir` 时于每个 `turn/end` 为每个 Session 写一个 TXT。浏览器半边负责 Header 操作、弹窗、渲染器、剪贴板与浏览器保存；它从不直接读取会话存储。

### 载荷流程

1. 浏览器每次打开弹窗只请求一份载荷；请求携带 Session id 并总是要求子代理会话，因此弹窗选项可以本地切换行而无需再次往返。
2. Host 通过 `sessionQuery` 观测该会话（活跃会话或冷存储会话），把持久事件折叠为可分享消息，并在载荷要求时追加直接子代理会话。
3. 引用的图片通过附件存储读取并以 base64 内联，每份载荷上限 24 张；读取失败的图片会被丢弃，而不会让整次分享失败。
4. 浏览器按弹窗选项过滤行，用纯渲染器（`render.ts`）渲染所选范围，然后交给剪贴板或浏览器保存。PNG 导出栅格化同一份 HTML 产物。

路由在缺少 `sessionId` 时返回 `400`，会话未知时返回 `404`，读取失败时返回 `500`；被取消的请求以 `499` 结束。

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时，请阅读这些页面。它们从浏览器控件延伸到 Host 路由以及周边的命令与会话接口。

- [dsh-client-connection](../../client/connection/README.zh.md) — 载荷路由注册所在的、经过认证的 Fetch 路由载体。
- [Commands 子系统参考](../../../docs/subsystems/commands.zh.md) — `/share` 注册所在的人工命令注册表。
- [dsh-session-query](../session-query/README.zh.md) — 载荷读取所依赖的冷读观测引擎。
- [dsh-session-log-export](../session-log-export/README.zh.md) — 同族的会话导出包及其下载弹窗。

-----

<a id="model-experience"></a>
## 模型体验

### 用户 `/share` 控制

#### 模型看到什么

Nothing. `/share` stays on the human-command plane, and the copied or downloaded artifact never enters model history.

#### Token 影响

Zero. The command creates no model turn, and the dialog renders from one Host payload route without an LLM request.

#### KV Cache 影响

None. The log-only command lifecycle and browser-side rendering do not change the derived request prefix.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包在哪些情况下不合适或需要额外运维关注。它们是当前的包约束，而不是任务清单。

- **弹窗行数上限** — 弹窗最多列出最新的 300 行可分享消息；更早的消息可通过直接保存获取，直接保存始终导出完整对话。
- **复制或下载，而非托管链接** — 接收方打开 Markdown、HTML、TXT 或 PNG 文件；不上传任何内容到服务器。
- **尽力而为的脱敏** — 凭据与绝对路径模式是启发式匹配，不构成保证；分享前请自行检查产物。
- **仅界面文本** — 推理文本与工具结果不包含在内；工具调用是可选行。
- **没有侧边栏入口** — harness 0.1.6 不再向插件开放会话行菜单注册表，因此 Header 按钮与 `/share` 是两个入口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的设计问题与方向。它明确不具权威性——已发布的行为、限制与已接受的取舍以上文各节、包代码与所链接页面为准。

#### 未来：更细的行级选择与托管产物

弹窗导出连续区间或行的并集。两个方向仍然开放：行级片段（每组消息一个文件），以及位于认证路由之后的托管产物——后者需要决定保留策略，并需要本包目前有意不拥有的 Host 侧存储。

</details>

**运行时不变量：** No runtime invariant companion is published because the command registry owns command lifecycle pairing and the browser half owns range rendering.
