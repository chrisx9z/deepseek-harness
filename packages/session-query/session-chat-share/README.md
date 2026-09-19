---
description: "Session share: the /share command, the Host share-payload route, and the Session-header dialog that copies or downloads a chosen message range as Markdown, HTML, TXT, or PNG."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-chat-share

English | [中文](README.zh.md)

## Summary

`dsh-session-chat-share` shares a chosen range of a session's messages. The Session Header gains a Share action and the `/share` command opens the same dialog: pick an inclusive range or a multi-select union, choose Markdown, HTML, TXT, or PNG, preview the GFM rendering, then copy or download it. The Host half folds durable events into one JSON payload served at `GET /api/session.share`, read cold-safely with referenced images inlined, so an export covers the whole session regardless of what the transcript has paged. Setup and usage come first; implementation details follow.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when the Web bundle should let users share part of a conversation. It requires the command registry and the Connection Fetch-route carrier on the Host, plus the browser slot and locale seats; Session query is optional and only widens what the payload can carry. Mount the plugin, then press Share in the Session Header or type `/share`; the dialog copies the chosen range to the clipboard or downloads it as a file.

Compatibility: this package targets harness `0.1.6-alpha.2` and later, where the browser reads Session data through the Session Controller and session payload routes. Harness `0.1.0-rc.x` needs the previous `dsh-chat-share` line instead.

### Composition

```yaml
- id: session-chat-share
  name: '@deepseek-ai/dsh-session-chat-share'
  config:
    autoSaveDir: 'C:/shares'
    includeImages: true
```

Both config keys are optional: `autoSaveDir` makes the Host write one TXT per Session after every completed turn, and `includeImages` (default `true`) controls whether the payload inlines referenced images as base64.

### Configuration

| Key | Default | Effect |
|---|---|---|
| `autoSaveDir` | unset | Write one plain-text share into this folder after every completed turn. |
| `includeImages` | `true` | Inline referenced images as base64 in the payload; `false` keeps text only and shrinks the response. |

### Command contract

| Input | Result |
|---|---|
| `/share` | Record a human-command lifecycle; the submitting browser opens the share dialog for that Session. |
| `/share txt` | Save the Session's whole shareable chat as one `.txt` file, without opening the dialog. |
| `/share last <n>` | Save only the newest `<n>` shareable messages as `.txt` (also valid combined: `/share txt last 10`). |
| anything else | Return an error with the accepted forms. |

The command is mounted only by the Web bundle. The local `command/executed` acknowledgment opens the dialog (or starts the direct save) only in the browser that submitted it; other tabs still render the durable command row without repeating the browser side effect. The Header button calls the same controller directly.

### What to expect

The dialog lists the Session's shareable messages (append-origin `user/message` and `assistant/message` text) newest-last, lets the user pick an inclusive range with the From/To selects or by clicking message rows — or switch to **multi-select mode** to export the union of chosen rows — chooses Markdown, HTML, TXT, or PNG, previews the rendered artifact (GFM), and then copies it to the clipboard or downloads it. Options: **redact sensitive info** (credential shapes and local absolute/home paths, on by default), **include tool calls** (bounded tool-call rows, off by default), and **include subagent conversations** (child sessions appended with section headers, off by default). The rendered artifacts follow the active UI locale. Markdown keeps the message text verbatim under role headers; HTML is a self-contained page with GFM-lite rendering (headings, lists, tables, blockquotes, links, fenced code, inline code/emphasis) and session images embedded as data URIs; TXT is the same content without any markup; PNG is the HTML artifact rasterized as one long image. Images are represented by an `[image]` marker in text formats; tool results, boundary markers, and compaction-replaced copies are excluded. When the dialog hits its 300-row cap it says so — direct saves (`/share txt`) always carry the whole chat.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design split

The Host half registers the `/share` command on the human-command plane, serves `GET /api/session.share`, and — when `autoSaveDir` is set — writes one TXT per Session at every `turn/end`. The browser half owns the Header action, the modal, the renderers, the clipboard, and the browser save; it never reads Session storage directly.

### Payload flow

1. The browser asks for one payload per dialog open; the request carries the Session id and always asks for subagent children, so the dialog options can toggle rows without a second round trip.
2. The Host observes the Session through `sessionQuery` (a live Session or a cold stored one), folds its durable events into shareable messages, and appends direct subagent children when the payload asks for them.
3. Referenced images are read through the attachment store and inlined as base64, bounded to 24 images per payload; an image that cannot be read is dropped instead of failing the share.
4. The browser filters the rows by the dialog options, renders the chosen range with pure renderers (`render.ts`), and hands the result to the clipboard or to a browser save. PNG export rasterizes the same HTML artifact.

The route answers `400` without a `sessionId`, `404` when the Session is unknown, and `500` when the read fails; an aborted request ends as `499`.

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the browser control to the Host route and the surrounding command and session surfaces.

- [dsh-client-connection](../../client/connection/README.md) — the authenticated Fetch-route carrier the payload route registers on.
- [Commands subsystem reference](../../../docs/subsystems/commands.md) — the human-command registry `/share` registers on.
- [dsh-session-query](../session-query/README.md) — the cold-safe observation engine the payload reads through.
- [dsh-session-log-export](../session-log-export/README.md) — the sibling Session export package and its download dialog.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/share` control

#### What the model sees

Nothing. `/share` stays on the human-command plane, and the copied or downloaded artifact never enters model history.

#### Token effect

Zero. The command creates no model turn, and the dialog renders from one Host payload route without an LLM request.

#### KV Cache effect

None. The log-only command lifecycle and browser-side rendering do not change the derived request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Dialog row cap** — the dialog lists at most the newest 300 shareable rows; older messages stay reachable through direct saves, which always export the whole chat.
- **Copy or download, not a hosted link** — the recipient opens the Markdown, HTML, TXT, or PNG file; nothing is uploaded to a server.
- **Best-effort redaction** — credential and absolute-path patterns are matched heuristically, not guaranteed; review the artifact before sharing it.
- **Surface text only** — reasoning text and tool results are not included; tool calls are opt-in rows.
- **No sidebar entry point** — harness 0.1.6 exposes no session-row menu registry to plugins, so the Header button and `/share` are the two entry points.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked pages.

#### Future: richer per-row selection and hosted artifacts

The dialog exports a contiguous range or a union of rows. Two directions stay open: per-row artifact fragments (one file per message group) and a hosted artifact behind an authenticated route, which would need a retention decision and a Host-side store that this package deliberately does not own today.

</details>

**Runtime invariant:** No runtime invariant companion is published because the command registry owns command lifecycle pairing and the browser half owns range rendering.
