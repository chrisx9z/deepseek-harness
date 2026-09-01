// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { HistoryEntry } from '@deepseek-ai/dsh-api-remotes/client'
import {
  CHAT_SHARE_ERROR, ChatShareController, SHARE_MAX_MESSAGES, saveBlob,
  type HistoryPage, type HistoryReader,
} from '../src/client/controller.ts'

const SID = 'session-chat-share-controller' as SessionId

function user(seq: number, text: string): HistoryEntry {
  return {
    event: {
      type: 'user/message', seq, time: seq * 1000,
      data: { id: `u-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user-rpc', rpcId: `r-${seq}` } },
      surfaceOp: 'append',
    },
  } as unknown as HistoryEntry
}

function assistant(seq: number, text: string): HistoryEntry {
  return {
    event: {
      type: 'assistant/message', seq, time: seq * 1000,
      data: { turn: 1, step: 1, message: { id: `a-${seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } },
      surfaceOp: 'append',
    },
  } as unknown as HistoryEntry
}

function userWithImage(seq: number, text: string, attachmentId: string): HistoryEntry {
  return {
    event: {
      type: 'user/message', seq, time: seq * 1000,
      data: {
        id: `u-${seq}`, role: 'user',
        content: [
          { type: 'text', text },
          { type: 'image', attachment: { attachmentId, mediaType: 'image/png', name: `${attachmentId}.png` } },
        ],
        source: { kind: 'user-rpc', rpcId: `r-${seq}` },
      },
      surfaceOp: 'append',
    },
  } as unknown as HistoryEntry
}

function toolCall(seq: number, name: string, arguments_: string): HistoryEntry {
  return {
    event: {
      type: 'tool/call', seq, time: seq * 1000,
      data: { turn: 1, step: 1, callId: `c-${seq}`, name, arguments: arguments_ },
    },
  } as unknown as HistoryEntry
}

function singlePageReader(events: HistoryEntry[]): HistoryReader {
  return async () => ({ events, hasMore: false })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ChatShareController', () => {
  it('loads history newest-first and publishes the full chronological range', async () => {
    const reader = vi.fn(async (_sid: SessionId, beforeSeq: number | undefined, _max: number): Promise<HistoryPage> => {
      if (beforeSeq === undefined) return { events: [assistant(6, 'newest')], hasMore: true }
      expect(beforeSeq).toBe(6)
      return { events: [user(1, 'first'), assistant(3, 'middle')], hasMore: false }
    })
    const controller = new ChatShareController(reader, async () => true, vi.fn())

    await controller.open(SID)

    expect(reader).toHaveBeenCalledWith(SID, undefined, 50)
    expect(reader).toHaveBeenCalledWith(SID, 6, 50)
    const entry = controller.store.getSnapshot().bySession[SID]
    expect(entry?.messages.map(message => message.seq)).toEqual([1, 3, 6])
    expect(entry).toMatchObject({ open: true, loading: false, from: 0, to: 2, format: 'markdown' })
  })

  it('reopens without refetching and keeps the selected range', async () => {
    const reader = vi.fn(singlePageReader([user(1, 'a'), assistant(2, 'b')]))
    const controller = new ChatShareController(reader, async () => true, vi.fn())

    await controller.open(SID)
    controller.setRange(SID, 1, 1)
    controller.dismiss(SID)
    expect(controller.store.getSnapshot().bySession[SID]?.open).toBe(false)
    await controller.open(SID)

    expect(reader).toHaveBeenCalledOnce()
    const entry = controller.store.getSnapshot().bySession[SID]
    expect(entry?.open).toBe(true)
    expect([entry?.from, entry?.to]).toEqual([1, 1])
  })

  it('clamps and normalizes reversed range bounds', async () => {
    const controller = new ChatShareController(singlePageReader([user(1, 'a'), assistant(2, 'b'), user(3, 'c')]), async () => true, vi.fn())
    await controller.open(SID)

    controller.setRange(SID, 2, 0)
    expect(controller.store.getSnapshot().bySession[SID]).toMatchObject({ from: 0, to: 2 })
    controller.setRange(SID, -5, 99)
    expect(controller.store.getSnapshot().bySession[SID]).toMatchObject({ from: 0, to: 2 })
    controller.setRange(SID, 1, 1)
    expect(controller.store.getSnapshot().bySession[SID]).toMatchObject({ from: 1, to: 1 })
  })

  it('copies the selected range as Markdown and publishes the success check', async () => {
    const clipboard = vi.fn(async (_text: string) => true)
    const controller = new ChatShareController(
      singlePageReader([user(1, 'question'), assistant(2, '```js\nanswer\n```')]),
      clipboard,
      vi.fn(),
    )
    await controller.open(SID)

    controller.setRange(SID, 0, 0)
    await controller.copy(SID)

    expect(clipboard).toHaveBeenCalledOnce()
    const text = clipboard.mock.calls[0]?.[0] as string
    expect(text).toContain('**User**')
    expect(text).toContain('question')
    expect(text).not.toContain('answer')
    expect(controller.store.getSnapshot().bySession[SID]).toMatchObject({ busy: null, copied: true })
  })

  it('reports a rejected clipboard write', async () => {
    const controller = new ChatShareController(singlePageReader([user(1, 'a')]), async () => false, vi.fn())
    await controller.open(SID)
    await controller.copy(SID)
    expect(controller.store.getSnapshot().bySession[SID]?.error).toBe(CHAT_SHARE_ERROR.copyFailed)
  })

  it('downloads the selected range in the chosen format', async () => {
    const save = vi.fn()
    const controller = new ChatShareController(singlePageReader([user(1, 'a'), assistant(2, 'b')]), async () => true, save)
    await controller.open(SID)

    controller.setRange(SID, 0, 0)
    controller.setFormat(SID, 'html')
    await controller.download(SID)

    expect(save).toHaveBeenCalledOnce()
    const [blob, filename] = save.mock.calls[0] as unknown as [Blob, string]
    expect(blob.type).toBe('text/html;charset=utf-8')
    expect(filename).toMatch(/^dsh-chat-share-session-chat-share-controller-1-1\.html$/)
    expect(controller.store.getSnapshot().bySession[SID]?.busy).toBeNull()

    controller.setRange(SID, 0, 1)
    controller.setFormat(SID, 'markdown')
    await controller.download(SID)
    const [second, secondName] = save.mock.calls[1] as unknown as [Blob, string]
    expect(second.type).toBe('text/markdown;charset=utf-8')
    expect(secondName).toMatch(/\.md$/)
    expect(secondName).toContain('-1-2.')

    controller.setFormat(SID, 'txt')
    await controller.download(SID)
    const [third, thirdName] = save.mock.calls[2] as unknown as [Blob, string]
    expect(third.type).toBe('text/plain;charset=utf-8')
    expect(thirdName).toMatch(/\.txt$/)
    expect(thirdName).toContain('-1-2.')
  })

  it('publishes history failures and raw details', async () => {
    const controller = new ChatShareController(async () => { throw new Error('backend offline') }, async () => true, vi.fn())
    await controller.open(SID)
    expect(controller.store.getSnapshot().bySession[SID]).toMatchObject({
      open: true, loading: false, error: 'backend offline', messages: [],
    })
  })

  it('saves the whole chat as one plain-text file without opening the dialog', async () => {
    const reader = vi.fn(singlePageReader([user(1, 'first'), assistant(2, 'second')]))
    const save = vi.fn()
    const controller = new ChatShareController(reader, async () => true, save)

    await controller.saveTxt(SID)

    expect(reader).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledOnce()
    const [blob, filename] = save.mock.calls[0] as unknown as [Blob, string]
    expect(blob.type).toBe('text/plain;charset=utf-8')
    expect(filename).toBe('dsh-chat-share-session-chat-share-controller-1-2.txt')
    expect(controller.store.getSnapshot().bySession[SID]?.open).not.toBe(true)
  })

  it('joins an in-flight dialog load instead of reading history twice', async () => {
    const reader = vi.fn(singlePageReader([user(1, 'a')]))
    const save = vi.fn()
    const controller = new ChatShareController(reader, async () => true, save)

    const opening = controller.open(SID)
    await controller.saveTxt(SID)
    await opening

    expect(reader).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledOnce()
    const [blob, filename] = save.mock.calls[0] as unknown as [Blob, string]
    expect(blob.type).toBe('text/plain;charset=utf-8')
    expect(filename).toMatch(/\.txt$/)
  })

  it('reuses already-loaded messages for a direct save', async () => {
    const reader = vi.fn(singlePageReader([user(1, 'a')]))
    const save = vi.fn()
    const controller = new ChatShareController(reader, async () => true, save)

    await controller.open(SID)
    await controller.saveTxt(SID)

    expect(reader).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledOnce()
  })

  it('publishes save failures into the entry for the next dialog open', async () => {
    const controller = new ChatShareController(async () => { throw new Error('offline') }, async () => true, vi.fn())

    await controller.saveTxt(SID)

    expect(controller.store.getSnapshot().bySession[SID]).toMatchObject({ error: 'offline' })
  })

  it('caps collected messages at the newest SHARE_MAX_MESSAGES', async () => {
    const events: HistoryEntry[] = []
    for (let seq = 1; seq <= SHARE_MAX_MESSAGES + 40; seq += 1) events.push(user(seq, `m${seq}`))
    const controller = new ChatShareController(singlePageReader(events), async () => true, vi.fn())
    await controller.open(SID)
    const messages = controller.store.getSnapshot().bySession[SID]?.messages ?? []
    expect(messages).toHaveLength(SHARE_MAX_MESSAGES)
    expect(messages[0]?.seq).toBe(41)
    expect(messages.at(-1)?.seq).toBe(SHARE_MAX_MESSAGES + 40)
  })

  it('aborts active loads on disposal and ignores later requests', async () => {
    let release!: (page: HistoryPage) => void
    const pending = new Promise<HistoryPage>((resolve) => { release = resolve })
    const controller = new ChatShareController(() => pending, async () => true, vi.fn())
    const opening = controller.open(SID)

    await controller.dispose()
    await expect(opening).resolves.toBeUndefined()
    release({ events: [user(1, 'late')], hasMore: false })
    await expect(controller.open(SID)).resolves.toBeUndefined()
    expect(controller.store.getSnapshot().bySession[SID]?.error).toBeNull()
  })

  it('redacts sensitive shapes in copied output by default and honors the toggle', async () => {
    const clipboard = vi.fn(async (_text: string) => true)
    const controller = new ChatShareController(
      singlePageReader([user(1, 'key sk-abcdefghijklmnopqrstuvwxyz123456 here')]),
      clipboard,
      vi.fn(),
    )
    await controller.open(SID)
    await controller.copy(SID)
    expect(clipboard.mock.calls[0]?.[0]).toContain('[key]')
    controller.setRedact(SID, false)
    await controller.copy(SID)
    expect(clipboard.mock.calls[1]?.[0]).toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('rebuilds tool rows when the include-tools option toggles', async () => {
    const controller = new ChatShareController(
      singlePageReader([user(1, 'ask'), toolCall(2, 'bash', 'echo hi'), assistant(3, 'done')]),
      async () => true,
      vi.fn(),
    )
    await controller.open(SID)
    expect(controller.store.getSnapshot().bySession[SID]?.messages.map(m => m.role)).toEqual(['user', 'assistant'])

    controller.setIncludeTools(SID, true)
    const withTools = controller.store.getSnapshot().bySession[SID]?.messages ?? []
    expect(withTools.map(m => m.role)).toEqual(['user', 'tool', 'assistant'])
    expect(withTools[1]?.text.startsWith('`bash`')).toBe(true)

    controller.setIncludeTools(SID, false)
    expect(controller.store.getSnapshot().bySession[SID]?.messages.map(m => m.role)).toEqual(['user', 'assistant'])
  })

  it('embeds session images into the HTML download', async () => {
    const attachment = vi.fn(async () => ({ data: 'AAAA', mediaType: 'image/png' }))
    const save = vi.fn()
    const controller = new ChatShareController(
      singlePageReader([userWithImage(1, 'look', 'img-1')]),
      async () => true,
      save,
      attachment,
    )
    await controller.open(SID)
    controller.setFormat(SID, 'html')
    await controller.download(SID)

    expect(attachment).toHaveBeenCalledWith(SID, 'img-1')
    const [blob] = save.mock.calls[0] as unknown as [Blob, string]
    const text = await blob.text()
    expect(text).toContain('data:image/png;base64,AAAA')
  })

  it('adds the artifact header meta (title and model) to downloads', async () => {
    const meta = vi.fn(async () => ({ title: 'My session', model: 'deepseek/deepseek-chat' }))
    const save = vi.fn()
    const controller = new ChatShareController(singlePageReader([user(1, 'a')]), async () => true, save, undefined, meta)
    await controller.open(SID)
    await controller.download(SID)

    expect(meta).toHaveBeenCalledWith(SID)
    const [blob] = save.mock.calls[0] as unknown as [Blob, string]
    const text = await blob.text()
    expect(text).toContain('My session')
    expect(text).toContain('deepseek/deepseek-chat')
  })

  it('follows the live artifact labels (UI locale)', async () => {
    const clipboard = vi.fn(async (_text: string) => true)
    const labels = () => ({
      user: '用户', assistant: '助手', tool: '工具', sharedFrom: '分享自 DeepSeek Harness',
    })
    const controller = new ChatShareController(
      singlePageReader([user(1, '你好')]), clipboard, vi.fn(), undefined, undefined, labels,
    )
    await controller.open(SID)
    await controller.copy(SID)
    expect(clipboard.mock.calls[0]?.[0]).toContain('**用户**')
    expect(clipboard.mock.calls[0]?.[0]).toContain('分享自 DeepSeek Harness')
  })

  it('saves only the newest N messages for /share last N', async () => {
    const save = vi.fn()
    const controller = new ChatShareController(
      singlePageReader([user(1, 'msg-one'), user(2, 'msg-two'), user(3, 'msg-three')]),
      async () => true,
      save,
    )
    await controller.saveTxt(SID, 2)

    const [blob, filename] = save.mock.calls[0] as unknown as [Blob, string]
    expect(filename).toBe('dsh-chat-share-session-chat-share-controller-1-2.txt')
    const text = await blob.text()
    expect(text).toContain('msg-two')
    expect(text).toContain('msg-three')
    expect(text).not.toContain('msg-one')
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
