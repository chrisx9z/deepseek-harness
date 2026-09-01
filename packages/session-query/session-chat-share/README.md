# @deepseek-ai/dsh-session-chat-share

English | [中文](README.zh.md)

Web Chat-segment share control: pick a message range and copy it as Markdown or download it as a Markdown/HTML file. The Host half registers the `/share` command; the browser half owns the Header action, the sidebar session-row `...` menu entry, the range-selection modal, the renderers, and the clipboard and download operations. Message history is read through the ordinary `session.history` RPC — no Host endpoint, no persistence changes, and no model involvement.

## Command contract

| Input | Result |
|---|---|
| `/share` | Record a human-command lifecycle; the submitting browser receives the local execution acknowledgment and opens the share dialog for that Session. |
| `/share <args>` | Return an error. The dialog owns range selection; the command accepts no arguments. |

The command is mounted only by the Web bundle. The local `command/executed` acknowledgment opens the dialog only in the browser that submitted it; other tabs still render the durable command row without repeating the browser side effect. The Header button calls the same controller directly.

The dialog lists the Session's shareable messages (append-origin `user/message` and `assistant/message` text) newest-last, lets the user pick an inclusive range with the From/To selects or by clicking message rows, chooses Markdown, HTML, or TXT, previews the rendered artifact, and then copies it to the clipboard or downloads it. The rendered artifacts are plain text — Markdown keeps the message text verbatim under role headers; HTML is a self-contained page with basic rendering (paragraphs and fenced code blocks) that any browser can open; TXT is the same content without any markup. Images are represented by an `[image]` marker; tool calls, tool results, boundary markers, and compaction-replaced copies are excluded.

## Composition

```yaml
- id: chat-share
  name: '@deepseek-ai/dsh-session-chat-share'
```

The Web bundle mounts the package beside `dsh-host-apiproxy`, `dsh-commands`, `dsh-client-ui-commands`, and `dsh-client-ui-conversation`. The package contributes its button and dialog to the right-aligned `conversation.session.header.utilities` list, plus Share and Save TXT rows in each session's sidebar `...` menu through the `sessionRowMenu` registry provided by `dsh-client-ui-workspace`; Trajectory carries no share control.

## Model Experience

### Human `/share` control

#### What the model sees

Nothing. `/share` stays on the human-command plane, and the copied or downloaded artifact never enters model history.

#### Token effect

Zero. The command creates no model turn, and the dialog renders from `session.history` pages without an LLM request.

#### KV Cache effect

None. The log-only command lifecycle and browser-side rendering do not change the derived request prefix.

## Known Limitations and Deferred Work

- The dialog reads up to 300 shareable messages from the tail of the Session log; older messages are out of scope for one snippet.
- Sharing is a copy/download artifact, not a hosted link: the recipient opens the Markdown or HTML file, and nothing is uploaded to a server.
- HTML output is deliberately basic (paragraphs and fenced code blocks); inline markdown such as emphasis and links stays as literal text in the HTML artifact, while the Markdown artifact keeps it verbatim.
- Message text is shared as rendered on the surface; reasoning text and tool activity are not included.
