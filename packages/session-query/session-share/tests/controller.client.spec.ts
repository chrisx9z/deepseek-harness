// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  CHAT_SHARE_ERROR, ChatShareController, SHARE_MAX_MESSAGES, fetchSharePayload, saveBlob, shareRows,
  type ShareImage, type SharePayload, type SharePayloadMessage,
} from '../src/client/controller.ts'

const SID = 'session-share-controller' as SessionId

/** The published entry for the fixture Session. */
function entry(controller: ChatShareController) {
  return controller.store.getSnapshot().bySession[String(SID)]
}

function user(seq: number, text: string, extra: Partial<SharePayloadMessage> = {}): SharePayloadMessage {
  return { seq, role: 'user', time: seq * 1000, text, images: [], child: null, ...extra }
}

function assistant(seq: number, text: string, extra: Partial<SharePayloadMessage> = {}): SharePayloadMessage {
  return { seq, role: 'assistant', time: seq * 1000, text, images: [], child: null, ...extra }
}

function tool(seq: number, name: string, arguments_: string): SharePayloadMessage {
  const text = arguments_ === '' ? `\`${name}\`` : `\`${name}\`\n\n\`\`\`json\n${arguments_}\n\`\`\``
  return { seq, role: 'tool', time: seq * 1000, text, images: [], child: null }
}

/** The header row the host emits before one child conversation (`seq: -1`, untagged). */
function subagentHeader(title: string): SharePayloadMessage {
  return { seq: -1, role: 'subagent', time: 0, text: title, images: [], child: null }
}

/** One message read from a child conversation: the payload tags it with its owner. */
function childOf(message: SharePayloadMessage, title = 'Helper'): SharePayloadMessage {
  return { ...message, child: { sessionId: 'child-1', title } }
}

function imageOf(attachmentId: string, data: string | null, name?: string): ShareImage {
  return { attachmentId, mediaType: 'image/png', ...(name === undefined ? {} : { name }), data }
}

function payloadOf(messages: readonly SharePayloadMessage[], overrides: Partial<SharePayload> = {}): SharePayload {
  return { sessionId: String(SID), title: 'Fixture session', cwd: '/workspace', messages, ...overrides }
}

/** A payload reader double: the host route is the only thing it stands in for. */
function fetcherOf(payload: SharePayload) {
  return vi.fn(async (_sessionId: SessionId, _signal: AbortSignal) => payload)
}

/** A payload reader that rejects as soon as its signal aborts, like a real request. */
function abortableFetcher() {
  const deferred = Promise.withResolvers<SharePayload>()
  const fetchPayload = vi.fn((_sessionId: SessionId, signal: AbortSignal) => {
    signal.addEventListener('abort', () => { deferred.reject(new Error('aborted')) }, { once: true })
    return deferred.promise
  })
  return { fetchPayload, deferred }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ChatShareController payload loading', () => {
  it('reads one payload on open and publishes the whole range by default', async () => {
    const fetchPayload = fetcherOf(payloadOf([user(1, 'first'), assistant(2, 'second')]))
    const controller = new ChatShareController(fetchPayload, async () => true, vi.fn())

    await controller.open(SID)

    expect(fetchPayload).toHaveBeenCalledOnce()
    expect(fetchPayload.mock.calls[0]?.[0]).toBe(SID)
    expect(fetchPayload.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
    expect(entry(controller)).toMatchObject({
      open: true, loading: false, from: 0, to: 1, multiMode: false, selected: [],
      format: 'markdown', redact: true, includeTools: false, includeSubagents: false,
      busy: null, copied: false, error: null,
    })
    expect(entry(controller)?.messages.map(message => message.seq)).toEqual([1, 2])
  })

  it('publishes the loading state while the payload is in flight', async () => {
    const deferred = Promise.withResolvers<SharePayload>()
    const controller = new ChatShareController(() => deferred.promise, async () => true, vi.fn())

    const opening = controller.open(SID)
    expect(entry(controller)).toMatchObject({ open: true, loading: true, messages: [], from: 0, to: 0 })

    deferred.resolve(payloadOf([user(1, 'a')]))
    await opening
    expect(entry(controller)).toMatchObject({ loading: false, from: 0, to: 0 })
  })

  it('joins a concurrent open instead of reading the payload twice', async () => {
    const deferred = Promise.withResolvers<SharePayload>()
    const fetchPayload = vi.fn(() => deferred.promise)
    const controller = new ChatShareController(fetchPayload, async () => true, vi.fn())

    const first = controller.open(SID)
    const second = controller.open(SID)
    deferred.resolve(payloadOf([user(1, 'a')]))
    await Promise.all([first, second])

    expect(fetchPayload).toHaveBeenCalledOnce()
  })

  it('reopens the cached payload without refetching and keeps the range', async () => {
    const fetchPayload = fetcherOf(payloadOf([user(1, 'a'), assistant(2, 'b')]))
    const controller = new ChatShareController(fetchPayload, async () => true, vi.fn())
    await controller.open(SID)
    controller.setRange(SID, 1, 1)
    controller.dismiss(SID)
    expect(entry(controller)?.open).toBe(false)

    await controller.open(SID)

    expect(fetchPayload).toHaveBeenCalledOnce()
    expect(entry(controller)).toMatchObject({ open: true, loading: false, from: 1, to: 1 })
  })

  it('publishes a reader failure with its raw detail', async () => {
    const controller = new ChatShareController(async () => { throw new Error('backend offline') }, async () => true, vi.fn())

    await controller.open(SID)

    expect(entry(controller)).toMatchObject({ open: true, loading: false, error: 'backend offline', messages: [] })
  })

  it('retries a failed read on the next open instead of staying in the error state', async () => {
    const payload = payloadOf([user(1, 'recovered')])
    let attempts = 0
    const fetchPayload = vi.fn(async (_sessionId: SessionId, _signal: AbortSignal) => {
      attempts += 1
      if (attempts === 1) throw new Error('offline')
      return payload
    })
    const controller = new ChatShareController(fetchPayload, async () => true, vi.fn())

    await controller.open(SID)
    expect(entry(controller)).toMatchObject({ error: 'offline', messages: [] })

    await controller.open(SID)

    expect(fetchPayload).toHaveBeenCalledTimes(2)
    expect(entry(controller)).toMatchObject({ open: true, loading: false, error: null })
    expect(entry(controller)?.messages.map(message => message.seq)).toEqual([1])

    // The recovered read is cached again, so a reopen does not read a third time.
    controller.dismiss(SID)
    await controller.open(SID)
    expect(fetchPayload).toHaveBeenCalledTimes(2)
  })

  it('republishes a failed load over an externally cleared store', async () => {
    const deferred = Promise.withResolvers<SharePayload>()
    const controller = new ChatShareController(() => deferred.promise, async () => true, vi.fn())

    const opening = controller.open(SID)
    controller.store.set({ bySession: {} })
    deferred.reject(new Error('late failure'))
    await opening

    expect(entry(controller)).toMatchObject({ open: true, loading: false, error: 'late failure', messages: [] })
  })

  it('ignores dialog actions before any payload is loaded', async () => {
    const clipboard = vi.fn(async (_text: string) => true)
    const save = vi.fn()
    const fetchPayload = fetcherOf(payloadOf([]))
    const controller = new ChatShareController(fetchPayload, clipboard, save)

    controller.setRange(SID, 0, 1)
    controller.setFormat(SID, 'html')
    controller.setRedact(SID, false)
    controller.setIncludeTools(SID, true)
    await controller.setIncludeSubagents(SID, true)
    controller.setMultiMode(SID, true)
    controller.setSelected(SID, [1])
    controller.dismiss(SID)
    await controller.copy(SID)
    await controller.download(SID)

    expect(entry(controller)).toBeUndefined()
    expect(fetchPayload).not.toHaveBeenCalled()
    expect(clipboard).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
})

describe('ChatShareController range, format, and options', () => {
  it('clamps and normalizes reversed range bounds', async () => {
    const controller = new ChatShareController(
      fetcherOf(payloadOf([user(1, 'a'), assistant(2, 'b'), user(3, 'c')])), async () => true, vi.fn())
    await controller.open(SID)

    controller.setRange(SID, 2, 0)
    expect(entry(controller)).toMatchObject({ from: 0, to: 2 })
    controller.setRange(SID, -5, 99)
    expect(entry(controller)).toMatchObject({ from: 0, to: 2 })
    controller.setRange(SID, 1, 1)
    expect(entry(controller)).toMatchObject({ from: 1, to: 1 })
  })

  it('chooses the artifact format and ignores a redundant choice', async () => {
    const controller = new ChatShareController(fetcherOf(payloadOf([user(1, 'a')])), async () => true, vi.fn())
    await controller.open(SID)

    controller.setFormat(SID, 'html')
    expect(entry(controller)?.format).toBe('html')
    const settled = entry(controller)
    controller.setFormat(SID, 'html')
    expect(entry(controller)).toBe(settled)

    controller.setFormat(SID, 'png')
    controller.setFormat(SID, 'txt')
    controller.setFormat(SID, 'markdown')
    expect(entry(controller)?.format).toBe('markdown')
  })

  it('rebuilds the rows when tool-call rows are toggled', async () => {
    const controller = new ChatShareController(
      fetcherOf(payloadOf([user(1, 'ask'), tool(2, 'bash', 'echo hi'), assistant(3, 'done')])),
      async () => true,
      vi.fn(),
    )
    await controller.open(SID)
    expect(entry(controller)?.messages.map(message => message.role)).toEqual(['user', 'assistant'])

    controller.setRange(SID, 1, 1)
    controller.setMultiMode(SID, true)
    controller.setIncludeTools(SID, true)

    const withTools = entry(controller)?.messages ?? []
    expect(withTools.map(message => message.role)).toEqual(['user', 'tool', 'assistant'])
    expect(withTools[1]?.text.startsWith('`bash`')).toBe(true)
    // A row-option change rebuilds the range around the new list.
    expect(entry(controller)).toMatchObject({ from: 0, to: 2, multiMode: false, selected: [] })

    const settled = entry(controller)
    controller.setIncludeTools(SID, true)
    expect(entry(controller)).toBe(settled)

    controller.setIncludeTools(SID, false)
    expect(entry(controller)?.messages.map(message => message.role)).toEqual(['user', 'assistant'])
  })

  it('remembers row options chosen while the payload is still loading', async () => {
    const deferred = Promise.withResolvers<SharePayload>()
    const controller = new ChatShareController(() => deferred.promise, async () => true, vi.fn())

    const opening = controller.open(SID)
    controller.setIncludeTools(SID, true)
    await controller.setIncludeSubagents(SID, true)
    expect(entry(controller)).toMatchObject({ includeTools: true, includeSubagents: true, messages: [] })

    deferred.resolve(payloadOf([user(1, 'a')]))
    await opening
    expect(entry(controller)?.messages.map(message => message.seq)).toEqual([1])
  })

  it('appends subagent rows only when opted in', async () => {
    const controller = new ChatShareController(
      fetcherOf(payloadOf([
        user(1, 'parent'),
        subagentHeader('Helper'),
        childOf(user(99, 'child message')),
        childOf(tool(100, 'bash', 'ls')),
      ])),
      async () => true,
      vi.fn(),
    )
    await controller.open(SID)
    expect(entry(controller)?.messages.map(message => message.role)).toEqual(['user'])

    await controller.setIncludeSubagents(SID, true)
    const rows = entry(controller)?.messages ?? []
    expect(rows.map(message => message.role)).toEqual(['user', 'subagent', 'user'])
    expect(rows[1]).toMatchObject({ seq: -1, role: 'subagent', text: 'Helper', time: 0 })
    expect(rows[2]?.text).toBe('child message')

    const settled = entry(controller)
    await controller.setIncludeSubagents(SID, true)
    expect(entry(controller)).toBe(settled)

    // Child tool rows still follow the tool-row option.
    controller.setIncludeTools(SID, true)
    expect(entry(controller)?.messages.map(message => message.role)).toEqual(['user', 'subagent', 'user', 'tool'])

    // Dropping the child conversations drops their tool rows with them.
    await controller.setIncludeSubagents(SID, false)
    expect(entry(controller)?.messages.map(message => message.role)).toEqual(['user'])
  })
})

describe('ChatShareController copy and download', () => {
  it('copies the selected range as Markdown by default', async () => {
    const clipboard = vi.fn(async (_text: string) => true)
    const controller = new ChatShareController(
      fetcherOf(payloadOf([user(1, 'question'), assistant(2, '```js\nanswer\n```')])), clipboard, vi.fn())
    await controller.open(SID)

    controller.setRange(SID, 0, 0)
    await controller.copy(SID)

    expect(clipboard).toHaveBeenCalledOnce()
    const text = clipboard.mock.calls[0]?.[0] as string
    expect(text).toContain('**User**')
    expect(text).toContain('question')
    expect(text).not.toContain('answer')
    expect(entry(controller)).toMatchObject({ busy: null, copied: true, error: null })
  })

  it('marks the entry busy while the clipboard write is in flight', async () => {
    const clipboard = vi.fn(async (_text: string) => {
      expect(entry(controller)?.busy).toBe('copy')
      return true
    })
    const controller = new ChatShareController(fetcherOf(payloadOf([user(1, 'a')])), clipboard, vi.fn())
    await controller.open(SID)

    await controller.copy(SID)

    expect(clipboard).toHaveBeenCalledOnce()
  })

  it('copies HTML and TXT through the matching renderer', async () => {
    const clipboard = vi.fn(async (_text: string) => true)
    const controller = new ChatShareController(fetcherOf(payloadOf([user(1, 'hello')])), clipboard, vi.fn())
    await controller.open(SID)

    controller.setFormat(SID, 'html')
    await controller.copy(SID)
    const html = clipboard.mock.calls[0]?.[0] as string
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('>User · ')
    expect(html).toContain('hello')

    controller.setFormat(SID, 'txt')
    await controller.copy(SID)
    const txt = clipboard.mock.calls[1]?.[0] as string
    expect(txt).toContain('User · ')
    expect(txt).not.toContain('<section')
    expect(txt).toContain('hello')
  })

  it('reports a rejected clipboard write as the copy failure code', async () => {
    const controller = new ChatShareController(fetcherOf(payloadOf([user(1, 'a')])), async () => false, vi.fn())
    await controller.open(SID)

    await controller.copy(SID)

    expect(entry(controller)).toMatchObject({ busy: null, copied: false, error: CHAT_SHARE_ERROR.copyFailed })
  })

  it('keeps a thrown clipboard detail and falls back when it is empty', async () => {
    const failing = new ChatShareController(
      fetcherOf(payloadOf([user(1, 'a')])), async () => { throw new Error('denied') }, vi.fn())
    await failing.open(SID)
    await failing.copy(SID)
    expect(entry(failing)?.error).toBe('denied')

    const empty = new ChatShareController(
      fetcherOf(payloadOf([user(1, 'a')])), async () => { throw new Error('') }, vi.fn())
    await empty.open(SID)
    await empty.copy(SID)
    expect(entry(empty)?.error).toBe(CHAT_SHARE_ERROR.copyFailed)
  })

  it('drops a copy result whose entry was cleared mid-flight', async () => {
    const deferred = Promise.withResolvers<boolean>()
    const controller = new ChatShareController(fetcherOf(payloadOf([user(1, 'a')])), () => deferred.promise, vi.fn())
    await controller.open(SID)

    const copying = controller.copy(SID)
    controller.store.set({ bySession: {} })
    deferred.resolve(true)
    await copying

    expect(entry(controller)).toBeUndefined()
  })

  it('downloads the selected range in each text format', async () => {
    const save = vi.fn()
    const controller = new ChatShareController(
      fetcherOf(payloadOf([user(1, 'a'), assistant(2, 'b')])), async () => true, save)
    await controller.open(SID)
    controller.setRange(SID, 0, 0)

    controller.setFormat(SID, 'html')
    await controller.download(SID)
    const [html, htmlName] = save.mock.calls[0] as unknown as [Blob, string]
    expect(html.type).toBe('text/html;charset=utf-8')
    expect(htmlName).toBe('dsh-session-share-session-share-controller-1-1.html')
    expect(await html.text()).toContain('<!doctype html>')
    expect(entry(controller)?.busy).toBeNull()

    controller.setRange(SID, 0, 1)
    controller.setFormat(SID, 'markdown')
    await controller.download(SID)
    const [markdown, markdownName] = save.mock.calls[1] as unknown as [Blob, string]
    expect(markdown.type).toBe('text/markdown;charset=utf-8')
    expect(markdownName).toBe('dsh-session-share-session-share-controller-1-2.md')
    expect(await markdown.text()).toContain('**User**')

    controller.setFormat(SID, 'txt')
    await controller.download(SID)
    const [txt, txtName] = save.mock.calls[2] as unknown as [Blob, string]
    expect(txt.type).toBe('text/plain;charset=utf-8')
    expect(txtName).toBe('dsh-session-share-session-share-controller-1-2.txt')
    expect(await txt.text()).toContain('User · ')
  })

  it('downloads PNG through the injected rasterizer and detaches the artifact node', async () => {
    const toPng = vi.fn(async (_node: HTMLElement) => 'data:image/png;base64,QUJD')
    const save = vi.fn()
    const controller = new ChatShareController(
      fetcherOf(payloadOf([user(1, 'hello')])), async () => true, save, undefined, toPng)
    await controller.open(SID)

    controller.setFormat(SID, 'png')
    await controller.download(SID)

    expect(toPng).toHaveBeenCalledOnce()
    const node = toPng.mock.calls[0]?.[0] as HTMLElement
    expect(node.innerHTML).toContain('hello')
    expect(node.isConnected).toBe(false)
    const [blob, filename] = save.mock.calls[0] as unknown as [Blob, string]
    expect(blob.type).toBe('image/png')
    expect(filename).toBe('dsh-session-share-session-share-controller-1-1.png')
  })

  it('reports PNG export as unavailable without a rasterizer', async () => {
    const save = vi.fn()
    const controller = new ChatShareController(fetcherOf(payloadOf([user(1, 'a')])), async () => true, save)
    await controller.open(SID)

    controller.setFormat(SID, 'png')
    await controller.download(SID)

    expect(save).not.toHaveBeenCalled()
    expect(entry(controller)).toMatchObject({ busy: null, error: 'PNG export is unavailable on this host.' })
  })

  it('publishes a rasterizer failure and still detaches the artifact node', async () => {
    let captured: HTMLElement | undefined
    const toPng = vi.fn(async (node: HTMLElement) => {
      captured = node
      throw new Error('raster failed')
    })
    const controller = new ChatShareController(
      fetcherOf(payloadOf([user(1, 'a')])), async () => true, vi.fn(), undefined, toPng)
    await controller.open(SID)

    controller.setFormat(SID, 'png')
    await controller.download(SID)

    expect(entry(controller)).toMatchObject({ busy: null, error: 'raster failed' })
    expect(captured?.isConnected).toBe(false)
  })

  it('publishes a save failure with its raw detail', async () => {
    const save = vi.fn(() => { throw new Error('disk full') })
    const controller = new ChatShareController(fetcherOf(payloadOf([user(1, 'a')])), async () => true, save)
    await controller.open(SID)

    await controller.download(SID)

    expect(entry(controller)).toMatchObject({ busy: null, error: 'disk full' })
  })

  it('drops a download result whose entry was cleared mid-save', async () => {
    const save = vi.fn(() => { controller.store.set({ bySession: {} }) })
    const controller = new ChatShareController(fetcherOf(payloadOf([user(1, 'a')])), async () => true, save)
    await controller.open(SID)

    await controller.download(SID)

    expect(save).toHaveBeenCalledOnce()
    expect(entry(controller)).toBeUndefined()
  })

  it('redacts credentials by default and honors the toggle', async () => {
    const clipboard = vi.fn(async (_text: string) => true)
    const controller = new ChatShareController(
      fetcherOf(payloadOf([user(1, 'key sk-abcdefghijklmnopqrstuvwxyz123456 here')])), clipboard, vi.fn())
    await controller.open(SID)

    await controller.copy(SID)
    expect(clipboard.mock.calls[0]?.[0]).toContain('[key]')

    controller.setRedact(SID, false)
    await controller.copy(SID)
    expect(clipboard.mock.calls[1]?.[0]).toContain('sk-abcdefghijklmnopqrstuvwxyz123456')

    const settled = entry(controller)
    controller.setRedact(SID, false)
    expect(entry(controller)).toBe(settled)
  })

  it('renders artifacts with the live locale labels', async () => {
    const clipboard = vi.fn(async (_text: string) => true)
    const labels = () => ({
      user: '用户', assistant: '助手', tool: '工具', subagent: '子代理', sharedFrom: '分享自 DeepSeek Harness',
    })
    const controller = new ChatShareController(fetcherOf(payloadOf([user(1, '你好')])), clipboard, vi.fn(), labels)
    await controller.open(SID)

    await controller.copy(SID)

    expect(clipboard.mock.calls[0]?.[0]).toContain('**用户**')
    expect(clipboard.mock.calls[0]?.[0]).toContain('分享自 DeepSeek Harness')
  })

  it('embeds inlined payload images into the HTML artifact', async () => {
    const save = vi.fn()
    const controller = new ChatShareController(
      fetcherOf(payloadOf([
        user(1, 'look', { images: [imageOf('img-1', 'AAAA', 'shot.png')] }),
        assistant(2, 'again', { images: [imageOf('img-1', 'CCCC'), imageOf('img-2', null, 'gone.png')] }),
      ])),
      async () => true,
      save,
    )
    await controller.open(SID)

    controller.setFormat(SID, 'html')
    await controller.download(SID)

    const [blob] = save.mock.calls[0] as unknown as [Blob, string]
    const html = await blob.text()
    // The first inlined resolution of an attachment wins; a null-data image keeps its marker.
    expect(html.match(/data:image\/png;base64,AAAA/g)).toHaveLength(2)
    expect(html).not.toContain('data:image/png;base64,CCCC')
    expect(html).toContain('[gone.png]')
  })
})

describe('ChatShareController multi-select', () => {
  it('exports the union of chosen rows and clears the selection on exit', async () => {
    const clipboard = vi.fn(async (_text: string) => true)
    const controller = new ChatShareController(
      fetcherOf(payloadOf([user(1, 'one'), user(2, 'two'), user(3, 'three')])), clipboard, vi.fn())
    await controller.open(SID)

    controller.setRange(SID, 1, 2)
    controller.setMultiMode(SID, true)
    expect(entry(controller)).toMatchObject({ multiMode: true, selected: [1, 2] })

    const settled = entry(controller)
    controller.setMultiMode(SID, true)
    expect(entry(controller)).toBe(settled)

    controller.setSelected(SID, [2, 0, 2, -1, 9])
    expect(entry(controller)?.selected).toEqual([0, 2])

    await controller.copy(SID)
    const union = clipboard.mock.calls[0]?.[0] as string
    expect(union).toContain('one')
    expect(union).toContain('three')
    expect(union).not.toContain('two')

    controller.setMultiMode(SID, false)
    expect(entry(controller)).toMatchObject({ multiMode: false, selected: [] })
    await controller.copy(SID)
    const ranged = clipboard.mock.calls[1]?.[0] as string
    expect(ranged).toContain('two')
    expect(ranged).toContain('three')
    expect(ranged).not.toContain('one')
  })
})

describe('ChatShareController text export', () => {
  it('saves the whole chat as plain text without opening the dialog', async () => {
    const save = vi.fn()
    const controller = new ChatShareController(
      fetcherOf(payloadOf([user(1, 'first'), assistant(2, 'second')])), async () => true, save)

    await controller.saveTxt(SID)

    expect(save).toHaveBeenCalledOnce()
    const [blob, filename] = save.mock.calls[0] as unknown as [Blob, string]
    expect(blob.type).toBe('text/plain;charset=utf-8')
    expect(filename).toBe('dsh-session-share-session-share-controller-1-2.txt')
    expect(await blob.text()).toContain('Shared from DeepSeek Harness')
    expect(entry(controller)).toBeUndefined()
  })

  it('exports tool and subagent rows regardless of the dialog options, with redaction applied', async () => {
    const save = vi.fn()
    const controller = new ChatShareController(
      fetcherOf(payloadOf([
        user(1, 'key sk-abcdefghijklmnopqrstuvwxyz123456'),
        tool(2, 'bash', 'echo hi'),
        subagentHeader('Helper'),
        childOf(user(99, 'child message')),
      ])),
      async () => true,
      save,
    )

    await controller.saveTxt(SID)

    const [blob] = save.mock.calls[0] as unknown as [Blob, string]
    const text = await blob.text()
    expect(text).toContain('[key]')
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
    expect(text).toContain('`bash`')
    expect(text).toContain('Helper')
    expect(text).toContain('child message')
  })

  it('shows only the newest SHARE_MAX_MESSAGES rows while a direct save carries the whole chat', async () => {
    const messages: SharePayloadMessage[] = []
    for (let seq = 1; seq <= SHARE_MAX_MESSAGES + 40; seq += 1) messages.push(user(seq, `message-${seq}`))
    const fetchPayload = fetcherOf(payloadOf(messages))
    const save = vi.fn()
    const controller = new ChatShareController(fetchPayload, async () => true, save)

    await controller.open(SID)
    const rows = entry(controller)?.messages ?? []
    expect(rows).toHaveLength(SHARE_MAX_MESSAGES)
    expect(rows[0]?.seq).toBe(41)
    expect(rows.at(-1)?.seq).toBe(SHARE_MAX_MESSAGES + 40)

    await controller.saveTxt(SID)
    const [whole, wholeName] = save.mock.calls[0] as unknown as [Blob, string]
    expect(wholeName).toBe(`dsh-session-share-session-share-controller-1-${SHARE_MAX_MESSAGES + 40}.txt`)
    const wholeText = await whole.text()
    expect(wholeText).toContain('message-1\n')
    expect(wholeText).toContain(`message-${SHARE_MAX_MESSAGES + 40}\n`)

    await controller.saveTxt(SID, 3)
    const [tail, tailName] = save.mock.calls[1] as unknown as [Blob, string]
    expect(tailName).toBe(`dsh-session-share-session-share-controller-${SHARE_MAX_MESSAGES + 38}-${SHARE_MAX_MESSAGES + 40}.txt`)
    const tailText = await tail.text()
    expect(tailText).toContain(`message-${SHARE_MAX_MESSAGES + 40}\n`)
    expect(tailText).not.toContain(`message-${SHARE_MAX_MESSAGES + 37}\n`)

    // A count at or beyond the row count keeps the whole chat.
    await controller.saveTxt(SID, SHARE_MAX_MESSAGES + 40)
    const [, cappedName] = save.mock.calls[2] as unknown as [Blob, string]
    expect(cappedName).toBe(wholeName)

    expect(fetchPayload).toHaveBeenCalledOnce()
  })

  it('publishes a direct-save failure into the entry for the next dialog open', async () => {
    const save = vi.fn(() => { throw new Error('disk full') })
    const controller = new ChatShareController(fetcherOf(payloadOf([user(1, 'a')])), async () => true, save)
    await controller.open(SID)

    await controller.saveTxt(SID)

    expect(entry(controller)).toMatchObject({ open: true, error: 'disk full' })
  })

  it('drops a direct-save failure when no dialog entry exists', async () => {
    const controller = new ChatShareController(async () => { throw new Error('offline') }, async () => true, vi.fn())

    await controller.saveTxt(SID)

    expect(entry(controller)).toBeUndefined()
  })
})

describe('ChatShareController disposal', () => {
  it('aborts an in-flight read on disposal and ignores later requests', async () => {
    const { fetchPayload } = abortableFetcher()
    const save = vi.fn()
    const controller = new ChatShareController(fetchPayload, async () => true, save)

    const opening = controller.open(SID)
    await controller.dispose()
    await expect(opening).resolves.toBeUndefined()

    expect(fetchPayload).toHaveBeenCalledOnce()
    const signal = fetchPayload.mock.calls[0]?.[1]
    expect(signal?.aborted).toBe(true)
    expect(entry(controller)).toMatchObject({ open: true, loading: true, messages: [], error: null })

    await expect(controller.open(SID)).resolves.toBeUndefined()
    await controller.saveTxt(SID)
    expect(fetchPayload).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
  })

  it('discards a payload that arrives after disposal aborted the read', async () => {
    const deferred = Promise.withResolvers<SharePayload>()
    const controller = new ChatShareController(() => deferred.promise, async () => true, vi.fn())

    const opening = controller.open(SID)
    const disposing = controller.dispose()
    deferred.resolve(payloadOf([user(1, 'late')]))
    await disposing
    await opening

    expect(entry(controller)).toMatchObject({ open: true, loading: true, messages: [], error: null })
  })
})

describe('shareRows', () => {
  it('filters tool and subagent rows by the row options', () => {
    const payload = payloadOf([
      user(1, 'parent'),
      tool(2, 'bash', 'echo hi'),
      subagentHeader('Helper'),
      childOf(assistant(99, 'child answer')),
    ])

    expect(shareRows(payload, false, false).map(row => row.role)).toEqual(['user'])
    expect(shareRows(payload, true, false).map(row => row.role)).toEqual(['user', 'tool'])
    expect(shareRows(payload, false, true).map(row => row.role)).toEqual(['user', 'subagent', 'assistant'])
    expect(shareRows(payload, true, true).map(row => row.role)).toEqual(['user', 'tool', 'subagent', 'assistant'])
  })

  it('drops rows with no shareable text and keeps image metadata', () => {
    const payload = payloadOf([
      user(1, '   '),
      subagentHeader('  '),
      user(2, 'look', { images: [imageOf('img-1', 'AAAA', 'shot.png')] }),
    ])

    const rows = shareRows(payload, true, true)

    expect(rows.map(row => row.seq)).toEqual([2])
    expect(rows[0]?.images).toEqual([imageOf('img-1', 'AAAA', 'shot.png')])
  })
})

describe('fetchSharePayload', () => {
  it('reads the host route with the session id and the subagent flag', async () => {
    const payload = payloadOf([user(1, 'a')])
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({ ok: true, json: async () => payload }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSharePayload(SID, new AbortController().signal)).resolves.toEqual(payload)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.pathname).toBe('/api/session.share')
    expect(url.searchParams.get('sessionId')).toBe(SID)
    expect(url.searchParams.get('includeSubagents')).toBe('true')
    expect(init.method).toBe('GET')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('falls back to the connection carrier host for a null origin', async () => {
    vi.stubGlobal('location', { origin: 'null' })
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({
      ok: true, json: async () => payloadOf([]),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchSharePayload(SID, new AbortController().signal)

    expect((fetchMock.mock.calls[0]?.[0] as URL).origin).toBe('http://dsh.internal')
  })

  it('surfaces the host detail and the fallback status text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 404, text: async () => 'chat share could not read the session: session not found',
    })))
    await expect(fetchSharePayload(SID, new AbortController().signal)).rejects.toThrow('session not found')

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, text: async () => { throw new Error('body unavailable') },
    })))
    await expect(fetchSharePayload(SID, new AbortController().signal)).rejects.toThrow('Share failed: HTTP 500')
  })
})

describe('saveBlob', () => {
  it('hands the Blob to a download anchor through an object URL', () => {
    vi.useFakeTimers()
    const createObjectURL = vi.fn(() => 'blob:fixture')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    saveBlob(new Blob(['x'], { type: 'text/markdown' }), 'snippet.md')

    expect(click).toHaveBeenCalledOnce()
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.href).toBe('blob:fixture')
    expect(anchor.download).toBe('snippet.md')
    vi.advanceTimersByTime(10_001)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fixture')
    vi.useRealTimers()
  })
})
