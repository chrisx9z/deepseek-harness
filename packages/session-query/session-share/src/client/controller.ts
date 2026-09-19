/**
 * Browser state and actions for sharing a selected range of chat messages.
 *
 * Every row comes from one host payload read (`/api/session.share`), so the
 * dialog is independent of what the browser has paged into the transcript and
 * an export covers the whole session even after a reload.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  redactSensitive, renderShareHtml, renderShareMarkdown, renderShareTxt, shareFileName,
  type ShareLabels, type ShareMeta,
} from './render.ts'

/** Output formats the shared artifact can take. */
export type ShareFormat = 'markdown' | 'html' | 'txt' | 'png'

/** One session image referenced by a message; `data` holds inlined base64 when the host sent it. */
export interface ShareImage {
  /** Durable attachment identity (the HTML export keys embedded images by it). */
  readonly attachmentId: string
  readonly mediaType: string
  /** Original display name, when the attachment kept one. */
  readonly name?: string
  /** Canonical base64 bytes, or null when the host did not inline this image. */
  readonly data: string | null
}

/** One shareable row on the ordered chat surface. */
export interface ShareMessage {
  /** Durable event seq the row came from (-1 for a subagent header row). */
  readonly seq: number
  readonly role: 'user' | 'assistant' | 'tool' | 'subagent'
  /** Text blocks joined verbatim; `[image]` when the message carried only images. */
  readonly text: string
  /** Unix epoch milliseconds of the durable event. */
  readonly time: number
  /** Image blocks attached to this message (HTML exports embed them). */
  readonly images?: readonly ShareImage[]
}

/** One message as the host payload carries it. */
export interface SharePayloadMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant' | 'tool' | 'subagent'
  readonly time: number
  readonly text: string
  readonly images: readonly ShareImage[]
  /** Set only on items read from a subagent child conversation. */
  readonly child: { readonly sessionId: string; readonly title: string } | null
}

/** One session's host payload. */
export interface SharePayload {
  readonly sessionId: string
  readonly title: string | null
  readonly cwd: string | null
  readonly messages: readonly SharePayloadMessage[]
}

/** Reads one session's share payload; wired to the host route by the client plugin. */
export type PayloadFetcher = (sessionId: SessionId, signal: AbortSignal) => Promise<SharePayload>

/** Rasterize a detached artifact node to a PNG data URL; wired to `html-to-image`. */
export type PngConverter = (node: HTMLElement) => Promise<string>

/** One Session's share-dialog state. */
export interface ChatShareEntry {
  readonly open: boolean
  /** The host payload is still being read. */
  readonly loading: boolean
  /** Shareable rows in chronological order (newest last), honoring the row options. */
  readonly messages: readonly ShareMessage[]
  /** Inclusive range start index into `messages` (single-select mode). */
  readonly from: number
  /** Inclusive range end index into `messages` (single-select mode). */
  readonly to: number
  /** Multi-select mode: exports the union of `selected` row indices instead of the range. */
  readonly multiMode: boolean
  /** Row indices chosen in multi-select mode (sorted, no duplicates). */
  readonly selected: readonly number[]
  readonly format: ShareFormat
  /** Best-effort redaction applied to every rendered artifact. */
  readonly redact: boolean
  /** Tool-call rows included in the list and artifacts. */
  readonly includeTools: boolean
  /** Subagent descendant conversations appended to the rows. */
  readonly includeSubagents: boolean
  /** Which output action is in flight, if any. */
  readonly busy: 'copy' | 'download' | null
  /** Whether the last copy succeeded (the dialog shows a brief check). */
  readonly copied: boolean
  /** Raw error detail; the dialog maps known codes to localized copy. */
  readonly error: string | null
}

/** Share-dialog states keyed by the Session whose Header owns the dialog. */
export interface ChatShareState {
  bySession: Record<string, ChatShareEntry | undefined>
}

/** Cap on rows the dialog lists, so a huge session cannot stall the modal. */
export const SHARE_MAX_MESSAGES = 300

/** Known controller error codes the dialog localizes; anything else is shown raw. */
export const CHAT_SHARE_ERROR = {
  copyFailed: 'copy-failed',
  downloadFailed: 'download-failed',
} as const

const INITIAL: ChatShareState = { bySession: {} }

/** The share payload route owned by the host half (kept in sync with `SHARE_ROUTE`). */
const SHARE_ROUTE = '/api/session.share'

/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read one session's share payload from the host route.
 * @param sessionId - session whose messages are shared.
 * @param signal - caller cancellation.
 * @returns the parsed payload.
 * @throws when the host route reports a failure.
 */
export async function fetchSharePayload(sessionId: SessionId, signal: AbortSignal): Promise<SharePayload> {
  const url = new URL(SHARE_ROUTE, hostBase())
  url.searchParams.set('sessionId', String(sessionId))
  url.searchParams.set('includeSubagents', 'true')
  const response = await fetch(url, { method: 'GET', signal })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail === '' ? `Share failed: HTTP ${response.status}` : detail)
  }
  return await response.json() as SharePayload
}

/**
 * Hand a Blob to the browser download manager through an object URL.
 * @param blob - artifact bytes.
 * @param filename - browser download filename.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
}

/** Apply best-effort redaction to every row's text. */
function redactRows(rows: readonly ShareMessage[]): ShareMessage[] {
  return rows.map(row => ({ ...row, text: redactSensitive(row.text) }))
}

/** Map the payload's inlined images to the data URIs the HTML export embeds. */
function imageMap(messages: readonly ShareMessage[]): Map<string, string> {
  const images = new Map<string, string>()
  for (const message of messages) {
    for (const image of message.images ?? []) {
      if (image.data !== null && !images.has(image.attachmentId)) {
        images.set(image.attachmentId, `data:${image.mediaType};base64,${image.data}`)
      }
    }
  }
  return images
}

/** Project one payload message onto a dialog row. */
function rowOf(message: SharePayloadMessage): ShareMessage {
  return message.images.length === 0
    ? { seq: message.seq, role: message.role, text: message.text, time: message.time }
    : { seq: message.seq, role: message.role, text: message.text, time: message.time, images: message.images }
}

/**
 * Build the dialog rows for one payload, honoring the row options.
 * @param payload - host payload with parent and subagent items.
 * @param includeTools - keep tool-call rows.
 * @param includeSubagents - keep subagent header and child rows.
 * @returns every shareable row in payload order.
 */
export function shareRows(
  payload: SharePayload,
  includeTools: boolean,
  includeSubagents: boolean,
): ShareMessage[] {
  const rows: ShareMessage[] = []
  for (const message of payload.messages) {
    if (message.role === 'tool' && !includeTools) continue
    if ((message.role === 'subagent' || message.child !== null) && !includeSubagents) continue
    const row = rowOf(message)
    if (row.text.trim() === '') continue
    rows.push(row)
  }
  return rows
}

/** Owns one in-flight payload read per Session and publishes dialog state. */
export class ChatShareController {
  /** uSES-safe state source shared by every Session-scoped contribution. */
  readonly store: SnapshotStore<ChatShareState> = createSnapshotStore(INITIAL)

  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private readonly payloads = new Map<SessionId, SharePayload>()
  private disposed = false

  /**
   * @param fetchPayload - host payload reader.
   * @param clipboard - clipboard writer returning whether the write landed.
   * @param save - browser save operation for the generated artifact Blob.
   * @param labels - optional live artifact vocabulary (follows the UI locale).
   * @param toPng - optional rasterizer for PNG downloads.
   */
  constructor(
    private readonly fetchPayload: PayloadFetcher = fetchSharePayload,
    private readonly clipboard: (text: string) => Promise<boolean> = writeClipboard,
    private readonly save: (blob: Blob, filename: string) => void = saveBlob,
    private readonly labels?: () => ShareLabels,
    private readonly toPng?: PngConverter,
  ) {}

  /**
   * Open (or reopen) one Session's share dialog; concurrent gestures share one read.
   * @param sessionId - Session whose chat segment is shared.
   * @returns after the dialog state settles (open, loaded, or failed).
   */
  open(sessionId: SessionId): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const cached = this.store.getSnapshot().bySession[String(sessionId)]
    if (cached !== undefined && !cached.loading && cached.error === null) {
      this.publish(sessionId, { ...cached, open: true })
      return Promise.resolve()
    }
    const abort = new AbortController()
    const done = this.load(sessionId, abort.signal).finally(() => { this.active.delete(sessionId) })
    this.active.set(sessionId, { abort, done })
    return done
  }

  /**
   * Save the whole chat as one plain-text file, without opening the dialog.
   * @param sessionId - Session whose chat is saved.
   * @param lastN - keep only the newest n rows; the whole chat when absent.
   * @returns after the browser save starts or the failure is published.
   */
  async saveTxt(sessionId: SessionId, lastN?: number): Promise<void> {
    if (this.disposed) return
    const controller = new AbortController()
    try {
      const payload = await this.payloadOf(sessionId, controller.signal)
      const all = shareRows(payload, true, true)
      const rows = lastN === undefined || lastN >= all.length ? all : all.slice(all.length - lastN)
      // A direct save has no dialog to ask, so it applies the dialog default.
      const messages = redactRows(rows)
      const text = renderShareTxt(messages, this.renderOptions())
      const from = Math.max(0, all.length - rows.length)
      this.save(new Blob([text], { type: 'text/plain;charset=utf-8' }),
        shareFileName(String(sessionId), from, Math.max(0, all.length - 1), 'txt'))
    } catch (error: unknown) {
      const entry = this.store.getSnapshot().bySession[String(sessionId)]
      if (entry !== undefined) this.publish(sessionId, { ...entry, error: messageOf(error) })
    }
  }

  /**
   * Close one Session's dialog without cancelling an in-flight read.
   * @param sessionId - Session whose dialog closes.
   */
  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publish(sessionId, { ...current, open: false })
  }

  /**
   * Set the inclusive single-select range.
   * @param sessionId - Session owning the dialog.
   * @param from - start index.
   * @param to - end index.
   */
  setRange(sessionId: SessionId, from: number, to: number): void {
    const current = this.entry(sessionId)
    if (current === undefined) return
    const last = Math.max(0, current.messages.length - 1)
    const start = Math.min(Math.max(0, Math.min(from, to)), last)
    const end = Math.min(Math.max(0, Math.max(from, to)), last)
    this.publish(sessionId, { ...current, from: start, to: end })
  }

  /**
   * Choose the artifact format.
   * @param sessionId - Session owning the dialog.
   * @param format - next format.
   */
  setFormat(sessionId: SessionId, format: ShareFormat): void {
    const current = this.entry(sessionId)
    if (current === undefined || current.format === format) return
    this.publish(sessionId, { ...current, format })
  }

  /**
   * Toggle best-effort redaction.
   * @param sessionId - Session owning the dialog.
   * @param redact - next redaction state.
   */
  setRedact(sessionId: SessionId, redact: boolean): void {
    const current = this.entry(sessionId)
    if (current === undefined || current.redact === redact) return
    this.publish(sessionId, { ...current, redact })
  }

  /**
   * Toggle tool-call rows.
   * @param sessionId - Session owning the dialog.
   * @param includeTools - next tool-row state.
   */
  setIncludeTools(sessionId: SessionId, includeTools: boolean): void {
    const current = this.entry(sessionId)
    if (current === undefined || current.includeTools === includeTools) return
    this.publish(sessionId, this.rebuild(sessionId, current, { includeTools }))
  }

  /**
   * Toggle subagent descendant rows.
   * @param sessionId - Session owning the dialog.
   * @param includeSubagents - next subagent-row state.
   * @returns after the rebuilt rows are published.
   */
  setIncludeSubagents(sessionId: SessionId, includeSubagents: boolean): Promise<void> {
    const current = this.entry(sessionId)
    if (current === undefined || current.includeSubagents === includeSubagents) return Promise.resolve()
    this.publish(sessionId, this.rebuild(sessionId, current, { includeSubagents }))
    return Promise.resolve()
  }

  /**
   * Toggle multi-select mode; leaving it clears the selection.
   * @param sessionId - Session owning the dialog.
   * @param multiMode - next mode.
   */
  setMultiMode(sessionId: SessionId, multiMode: boolean): void {
    const current = this.entry(sessionId)
    if (current === undefined || current.multiMode === multiMode) return
    const selected = multiMode
      ? Array.from({ length: current.messages.length }, (_, index) => index).filter(
        index => index >= current.from && index <= current.to)
      : []
    this.publish(sessionId, { ...current, multiMode, selected })
  }

  /**
   * Replace the multi-select membership.
   * @param sessionId - Session owning the dialog.
   * @param indices - chosen row indices.
   */
  setSelected(sessionId: SessionId, indices: readonly number[]): void {
    const current = this.entry(sessionId)
    if (current === undefined) return
    const last = current.messages.length - 1
    const selected = [...new Set(indices.filter(index => index >= 0 && index <= last))].sort((a, b) => a - b)
    this.publish(sessionId, { ...current, selected })
  }

  /**
   * Copy the selected range in the chosen format.
   * @param sessionId - Session owning the dialog.
   * @returns after the clipboard write settles.
   */
  async copy(sessionId: SessionId): Promise<void> {
    const current = this.entry(sessionId)
    if (current === undefined) return
    this.publish(sessionId, { ...current, busy: 'copy', copied: false, error: null })
    try {
      const messages = this.selection(current)
      const text = current.format === 'html'
        ? renderShareHtml(messages, { ...this.renderOptions(), images: imageMap(messages) })
        : current.format === 'txt'
          ? renderShareTxt(messages, this.renderOptions())
          : renderShareMarkdown(messages, this.renderOptions())
      const ok = await this.clipboard(text)
      const next = this.entry(sessionId)
      if (next === undefined) return
      this.publish(sessionId, ok
        ? { ...next, busy: null, copied: true, error: null }
        : { ...next, busy: null, error: CHAT_SHARE_ERROR.copyFailed })
    } catch (error: unknown) {
      const next = this.entry(sessionId)
      if (next === undefined) return
      this.publish(sessionId, { ...next, busy: null, error: messageOf(error) || CHAT_SHARE_ERROR.copyFailed })
    }
  }

  /**
   * Download the selected range in the chosen format.
   * @param sessionId - Session owning the dialog.
   * @returns after the browser save starts or the failure is published.
   */
  async download(sessionId: SessionId): Promise<void> {
    const current = this.entry(sessionId)
    if (current === undefined) return
    this.publish(sessionId, { ...current, busy: 'download', error: null })
    try {
      const messages = this.selection(current)
      if (current.format === 'png') {
        await this.downloadPng(sessionId, messages, current)
        return
      }
      const options = current.format === 'html'
        ? { ...this.renderOptions(), images: imageMap(messages) }
        : this.renderOptions()
      const content = current.format === 'html'
        ? renderShareHtml(messages, options)
        : current.format === 'txt'
          ? renderShareTxt(messages, options)
          : renderShareMarkdown(messages, options)
      const mime = current.format === 'html'
        ? 'text/html;charset=utf-8'
        : current.format === 'txt' ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8'
      const filename = shareFileName(String(sessionId), current.from, current.to, current.format)
      this.save(new Blob([content], { type: mime }), filename)
      const next = this.entry(sessionId)
      if (next !== undefined) this.publish(sessionId, { ...next, busy: null })
    } catch (error: unknown) {
      const next = this.entry(sessionId)
      if (next !== undefined) {
        this.publish(sessionId, { ...next, busy: null, error: messageOf(error) || CHAT_SHARE_ERROR.downloadFailed })
      }
    }
  }

  /**
   * Abort active reads and reach quiescence.
   * @returns after every active operation settles.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.values()]
    for (const operation of active) operation.abort.abort()
    await Promise.allSettled(active.map(operation => operation.done))
  }

  private async load(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    this.publish(sessionId, {
      open: true,
      loading: true,
      messages: [],
      from: 0,
      to: 0,
      multiMode: false,
      selected: [],
      format: 'markdown',
      redact: true,
      includeTools: false,
      includeSubagents: false,
      busy: null,
      copied: false,
      error: null,
    })
    try {
      const payload = await this.payloadOf(sessionId, signal)
      if (signal.aborted) return
      const rows = this.capRows(shareRows(payload, false, false))
      this.publish(sessionId, {
        open: true,
        loading: false,
        messages: rows,
        from: 0,
        to: Math.max(0, rows.length - 1),
        multiMode: false,
        selected: [],
        format: 'markdown',
        redact: true,
        includeTools: false,
        includeSubagents: false,
        busy: null,
        copied: false,
        error: null,
      })
    } catch (error: unknown) {
      if (signal.aborted) return
      const entry = this.entry(sessionId)
      const base = entry ?? {
        open: true, loading: false, messages: [], from: 0, to: 0, multiMode: false, selected: [],
        format: 'markdown' as ShareFormat, redact: true, includeTools: false, includeSubagents: false,
        busy: null, copied: false, error: null,
      }
      this.publish(sessionId, { ...base, loading: false, error: messageOf(error) })
    }
  }

  private async payloadOf(sessionId: SessionId, signal: AbortSignal): Promise<SharePayload> {
    const cached = this.payloads.get(sessionId)
    if (cached !== undefined) return cached
    const payload = await this.fetchPayload(sessionId, signal)
    this.payloads.set(sessionId, payload)
    return payload
  }

  private rebuild(
    sessionId: SessionId,
    current: ChatShareEntry,
    patch: { includeTools?: boolean; includeSubagents?: boolean },
  ): ChatShareEntry {
    const payload = this.payloads.get(sessionId)
    const includeTools = patch.includeTools ?? current.includeTools
    const includeSubagents = patch.includeSubagents ?? current.includeSubagents
    if (payload === undefined) return { ...current, includeTools, includeSubagents }
    const rows = this.capRows(shareRows(payload, includeTools, includeSubagents))
    return {
      ...current,
      includeTools,
      includeSubagents,
      messages: rows,
      from: 0,
      to: Math.max(0, rows.length - 1),
      multiMode: false,
      selected: [],
    }
  }

  private capRows(rows: readonly ShareMessage[]): ShareMessage[] {
    return rows.length <= SHARE_MAX_MESSAGES ? [...rows] : rows.slice(rows.length - SHARE_MAX_MESSAGES)
  }

  private selection(entry: ChatShareEntry): ShareMessage[] {
    const rows = entry.multiMode
      ? entry.selected.flatMap((index) => {
        const row = entry.messages[index]
        return row === undefined ? [] : [row]
      })
      : entry.messages.slice(entry.from, entry.to + 1)
    return entry.redact ? redactRows(rows) : [...rows]
  }

  private renderOptions(): { labels?: ShareLabels; meta?: ShareMeta } {
    return this.labels === undefined ? {} : { labels: this.labels() }
  }

  private async downloadPng(
    sessionId: SessionId,
    messages: readonly ShareMessage[],
    current: ChatShareEntry,
  ): Promise<void> {
    if (this.toPng === undefined) throw new Error('PNG export is unavailable on this host.')
    const node = document.createElement('div')
    node.style.position = 'fixed'
    node.style.left = '-10000px'
    node.style.top = '0'
    node.style.width = '820px'
    node.innerHTML = renderShareHtml(messages, { ...this.renderOptions(), images: imageMap(messages) })
    document.body.appendChild(node)
    try {
      const dataUrl = await this.toPng(node)
      const filename = shareFileName(String(sessionId), current.from, current.to, 'png')
      this.save(new Blob([dataUrl], { type: 'image/png' }), filename)
      const next = this.entry(sessionId)
      if (next !== undefined) this.publish(sessionId, { ...next, busy: null })
    } finally {
      node.remove()
    }
  }

  private entry(sessionId: SessionId): ChatShareEntry | undefined {
    return this.store.getSnapshot().bySession[String(sessionId)]
  }

  private publish(sessionId: SessionId, entry: ChatShareEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }
}
