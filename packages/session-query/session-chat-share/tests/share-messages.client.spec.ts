import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { buildShareMessages, shareMessageParts } from '../src/client/controller.ts'

function user(seq: number, content: unknown[], time = seq * 1000): HistoryEntry {
  return {
    event: {
      type: 'user/message', seq, time,
      data: { id: `u-${seq}`, role: 'user', content, source: { kind: 'user-rpc', rpcId: `r-${seq}` } },
      surfaceOp: 'append',
    },
  } as unknown as HistoryEntry
}

function assistant(seq: number, content: unknown[], time = seq * 1000): HistoryEntry {
  return {
    event: {
      type: 'assistant/message', seq, time,
      data: { turn: 1, step: 1, message: { id: `a-${seq}`, role: 'assistant', content, source: { kind: 'model' } } },
      surfaceOp: 'append',
    },
  } as unknown as HistoryEntry
}

function toolCall(seq: number, name: string, arguments_: string, time = seq * 1000): HistoryEntry {
  return {
    event: {
      type: 'tool/call', seq, time,
      data: { turn: 1, step: 1, callId: `c-${seq}`, name, arguments: arguments_ },
    },
  } as unknown as HistoryEntry
}

describe('shareMessageParts', () => {
  it('joins text blocks verbatim and collects image refs', () => {
    const { text, images } = shareMessageParts([
      { type: 'text', text: 'a' },
      { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', name: 'shot.png' } },
      { type: 'text', text: 'b' },
    ])
    expect(text).toBe('a\nb')
    expect(images).toEqual([{ attachmentId: 'img-1', mediaType: 'image/png', name: 'shot.png' }])
  })

  it('marks image-only messages and returns empty for nothing shareable', () => {
    expect(shareMessageParts([{ type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png' } }]))
      .toEqual({ text: '[image]', images: [{ attachmentId: 'img-1', mediaType: 'image/png' }] })
    expect(shareMessageParts([{ type: 'tool-call' }])).toEqual({ text: '', images: [] })
    expect(shareMessageParts([])).toEqual({ text: '', images: [] })
  })
})

describe('buildShareMessages', () => {
  it('folds append-origin user and assistant messages in order', () => {
    const entries = [
      user(1, [{ type: 'text', text: 'hello' }]),
      assistant(2, [{ type: 'text', text: 'hi' }]),
    ]
    expect(buildShareMessages(entries)).toEqual([
      { seq: 1, role: 'user', text: 'hello', time: 1000 },
      { seq: 2, role: 'assistant', text: 'hi', time: 2000 },
    ])
  })

  it('drops tool results, boundary markers, and surface-replacing copies', () => {
    const entries = [
      { event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } },
      user(2, [{ type: 'text', text: 'kept' }]),
      {
        event: {
          type: 'user/message', seq: 3, time: 3,
          data: { id: 'u-3', role: 'user', content: [{ type: 'text', text: 'replaced' }], source: { kind: 'user-rpc', rpcId: 'r-3' } },
          surfaceOp: { op: 'replace', start: 0, end: 0 },
        },
      } as unknown as HistoryEntry,
      {
        event: {
          type: 'tool/result', seq: 4, time: 4,
          data: { turn: 1, step: 1, message: { id: 't-4', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c', content: [] }], source: { kind: 'tool', toolName: 'bash' } } },
          surfaceOp: 'append',
        },
      } as unknown as HistoryEntry,
    ] as unknown as HistoryEntry[]
    expect(buildShareMessages(entries)).toEqual([
      { seq: 2, role: 'user', text: 'kept', time: 2000 },
    ])
  })

  it('drops messages with no shareable text', () => {
    const entries = [
      user(1, [{ type: 'tool-call', name: 'x' }]),
      assistant(2, []),
      user(3, [{ type: 'image', attachment: { attachmentId: 'img-3', mediaType: 'image/png' } }]),
    ]
    expect(buildShareMessages(entries)).toEqual([
      {
        seq: 3, role: 'user', text: '[image]', time: 3000,
        images: [{ attachmentId: 'img-3', mediaType: 'image/png' }],
      },
    ])
  })

  it('includes bounded tool-call rows only when opted in', () => {
    const long = 'x'.repeat(900)
    const entries = [assistant(1, [{ type: 'text', text: 'ok' }]), toolCall(2, 'bash', long)]
    expect(buildShareMessages(entries)).toEqual([
      { seq: 1, role: 'assistant', text: 'ok', time: 1000 },
    ])
    const withTools = buildShareMessages(entries, { includeTools: true })
    expect(withTools).toHaveLength(2)
    const toolRow = withTools[1]
    expect(toolRow?.role).toBe('tool')
    expect(toolRow?.text.startsWith('`bash`')).toBe(true)
    expect(toolRow?.text.length).toBeLessThan(long.length + 20)
    expect(toolRow?.text.endsWith('…')).toBe(true)
  })
})
