# @deepseek-ai/dsh-session-share

English | [中文](README.zh.md)

## Summary

`dsh-session-share` shares a chosen range of a session's messages. The Session Header gains a Share action and the `/share` command opens the same dialog: pick an inclusive range or a multi-select union, choose Markdown, HTML, TXT, or PNG, preview the GFM rendering, then copy or download it. The Host half folds durable events into one JSON payload served at `GET /api/session.share`, read cold-safely with referenced images inlined, so an export covers the whole session regardless of what the transcript has paged. Setup and usage come first; implementation details follow.

## Compatibility

This package targets harness `0.1.6-alpha.2` and later, where the browser reads Session data through the Session Controller and session payload routes.

## Command contract

| Input | Result |
|---|---|
| `/share` | Record a human-command lifecycle; the submitting browser opens the share dialog for that Session. |
| `/share txt` | Save the Session's whole shareable chat as one `.txt` file, without opening the dialog. |
| `/share last <n>` | Save only the newest `<n>` shareable messages as `.txt` (also valid combined: `/share txt last 10`). |
| anything else | Return an error with the accepted forms. |

The command is mounted only by the Web bundle. The local `command/executed` acknowledgment opens the dialog (or starts the direct save) only in the browser that submitted it; other tabs still render the durable command row without repeating the browser side effect. The Header button calls the same controller directly.

The dialog lists the Session's shareable messages (append-origin `user/message` and `assistant/message` text) newest-last, lets the user pick an inclusive range with the From/To selects or by clicking message rows — or switch to **multi-select mode** to export the union of chosen rows — chooses Markdown, HTML, TXT, or PNG, previews the rendered artifact (GFM), and then copies it to the clipboard or downloads it. Options: **redact sensitive info** (credential shapes and local absolute/home paths, on by default), **include tool calls** (bounded tool-call rows, off by default), and **include subagent conversations** (child sessions appended with section headers, off by default). The rendered artifacts follow the active UI locale. Markdown keeps the message text verbatim under role headers; HTML is a self-contained page with GFM-lite rendering (headings, lists, tables, blockquotes, links, fenced code, inline code/emphasis) and session images embedded as data URIs; TXT is the same content without any markup; PNG is the HTML artifact rasterized as one long image. Images are represented by an `[image]` marker in text formats; tool results, boundary markers, and compaction-replaced copies are excluded. When the dialog hits its 300-row cap it says so — direct saves (`/share txt`) always carry the whole chat.

## Composition

```yaml
- id: session-share
  name: '@deepseek-ai/dsh-session-share'
  config:
    autoSaveDir: 'C:/shares'
    includeImages: true
```

Both config keys are optional: `autoSaveDir` makes the Host write one TXT per Session after every completed turn, and `includeImages` (default `true`) controls whether the payload inlines referenced images as base64.

The Web bundle mounts the package beside `dsh-commands`, `dsh-session-query`, `dsh-client-ui-commands`, and `dsh-client-ui-conversation`. The package contributes its button and dialog to the right-aligned `conversation.session.header.utilities` list; Trajectory carries no share control. The Host half serves `GET /api/session.share?sessionId=<id>&includeSubagents=<bool>` on the browser transport, which answers one JSON payload of `{sessionId, title, cwd, messages}`.

## Model Experience

### Human `/share` control

#### What the model sees

Nothing. `/share` stays on the human-command plane, and the copied or downloaded artifact never enters model history.

#### Token effect

Zero. The command creates no model turn, and the dialog renders from one Host payload route without an LLM request.

#### KV Cache effect

None. The log-only command lifecycle and browser-side rendering do not change the derived request prefix.

## Known Limitations and Deferred Work

- The dialog lists at most the newest 300 shareable rows; older messages stay reachable through direct saves, which always export the whole chat.
- Sharing is a copy/download artifact, not a hosted link: the recipient opens the Markdown, HTML, TXT, or PNG file, and nothing is uploaded to a server.
- Redaction is best-effort pattern matching, not a guarantee; review the artifact before sharing it.
- Message text is shared as rendered on the surface; reasoning text and tool results are not included (tool calls only, opt-in).
- The sidebar session-row `...` menu from earlier harness versions no longer exists, so the Header button and `/share` are the two entry points.

No runtime invariant companion is published because the command registry owns command lifecycle pairing and the browser half owns range rendering.
