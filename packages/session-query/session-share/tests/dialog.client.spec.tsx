// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  CHAT_SHARE_ERROR, ChatShareController, SHARE_MAX_MESSAGES,
  type ChatShareState, type ShareFormat, type SharePayload, type SharePayloadMessage,
} from '../src/client/controller.ts'
import { ChatShareDialog, type ChatShareDialogProps } from '../src/client/Dialog.tsx'
import { en } from '../src/client/locales.ts'

const SID = 'session-share-dialog' as SessionId

function message(
  seq: number,
  role: SharePayloadMessage['role'],
  text: string,
  extra: Partial<SharePayloadMessage> = {},
): SharePayloadMessage {
  return { seq, role, time: seq * 1000, text, images: [], child: null, ...extra }
}

function payloadOf(messages: readonly SharePayloadMessage[], overrides: Partial<SharePayload> = {}): SharePayload {
  return { sessionId: String(SID), title: 'Fixture session', cwd: '/workspace', messages, ...overrides }
}

/** The dialog bench: a real controller, its real store, and the Header-style wiring. */
function bench(controller = new ChatShareController(
  async () => payloadOf([message(1, 'user', 'first question'), message(2, 'user', 'second question')]),
  async () => true,
  vi.fn(),
)) {
  const open = vi.fn((sessionId: SessionId) => controller.open(sessionId))
  const setRange = vi.fn((sessionId: SessionId, from: number, to: number) => { controller.setRange(sessionId, from, to) })
  const setFormat = vi.fn((sessionId: SessionId, format: ShareFormat) => { controller.setFormat(sessionId, format) })
  const setRedact = vi.fn((sessionId: SessionId, redact: boolean) => { controller.setRedact(sessionId, redact) })
  const setIncludeTools = vi.fn((sessionId: SessionId, includeTools: boolean) => {
    controller.setIncludeTools(sessionId, includeTools)
  })
  const setIncludeSubagents = vi.fn((sessionId: SessionId, includeSubagents: boolean) =>
    controller.setIncludeSubagents(sessionId, includeSubagents))
  const setMultiMode = vi.fn((sessionId: SessionId, multiMode: boolean) => { controller.setMultiMode(sessionId, multiMode) })
  const setSelected = vi.fn((sessionId: SessionId, indices: readonly number[]) => { controller.setSelected(sessionId, indices) })
  const copy = vi.fn((sessionId: SessionId) => controller.copy(sessionId))
  const download = vi.fn((sessionId: SessionId) => controller.download(sessionId))
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  function useChatShare<T>(selector: (state: ChatShareState) => T): T {
    return useSyncExternalStore(
      listener => controller.store.subscribe(listener),
      () => selector(controller.store.getSnapshot()),
    )
  }
  const t = (key: keyof typeof en): string => en[key]
  const props = {
    sessionId: SID, useChatShare, open, setRange, setFormat, setRedact, setIncludeTools,
    setIncludeSubagents, setMultiMode, setSelected, copy, download, dismiss, t,
  } as unknown as ChatShareDialogProps
  const view = render(<ChatShareDialog {...props} />)
  return {
    controller, open, setRange, setFormat, setRedact, setIncludeTools, setIncludeSubagents,
    setMultiMode, setSelected, copy, download, dismiss, view,
  }
}

afterEach(cleanup)

describe('ChatShareDialog', () => {
  it('shows the loading state while the payload is being read', async () => {
    const deferred = Promise.withResolvers<SharePayload>()
    const controller = new ChatShareController(() => deferred.promise, async () => true, vi.fn())
    const b = bench(controller)

    const opening = controller.open(SID)
    expect(await b.view.findByRole('dialog', { name: 'Share chat segment' })).toBeTruthy()
    expect(b.view.getByText('Loading messages…')).toBeTruthy()

    deferred.resolve(payloadOf([message(1, 'user', 'hi')]))
    await opening
    expect(b.view.queryByText('Loading messages…')).toBeNull()
    expect(await b.view.findByRole('button', { name: /#1/ })).toBeTruthy()
  })

  it('lists messages, selects a range, and drives copy and format actions', async () => {
    const b = bench()
    await b.controller.open(SID)

    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })
    expect(dialog.textContent).toContain('#1')
    expect(dialog.textContent).toContain('first question')

    fireEvent.click(b.view.getByRole('button', { name: /#2/ }))
    await waitFor(() => { expect(b.setRange).toHaveBeenCalledWith(SID, 1, 1) })

    fireEvent.click(b.view.getByLabelText('HTML'))
    await waitFor(() => { expect(b.setFormat).toHaveBeenCalledWith(SID, 'html') })

    fireEvent.click(b.view.getByLabelText('TXT'))
    await waitFor(() => { expect(b.setFormat).toHaveBeenCalledWith(SID, 'txt') })

    fireEvent.click(b.view.getByRole('button', { name: 'Copy' }))
    await waitFor(() => { expect(b.copy).toHaveBeenCalledWith(SID) })
    await waitFor(() => { expect(b.view.getByText('Copied')).toBeTruthy() })

    fireEvent.click(b.view.getByRole('button', { name: 'Download' }))
    await waitFor(() => { expect(b.download).toHaveBeenCalledWith(SID) })
  })

  it('toggles redaction and tool-call options through the checkboxes', async () => {
    const b = bench()
    await b.controller.open(SID)

    const redact = b.view.getByLabelText('Redact sensitive info') as HTMLInputElement
    expect(redact.checked).toBe(true)
    fireEvent.click(redact)
    await waitFor(() => { expect(b.setRedact).toHaveBeenCalledWith(SID, false) })

    const tools = b.view.getByLabelText('Include tool calls') as HTMLInputElement
    expect(tools.checked).toBe(false)
    fireEvent.click(tools)
    await waitFor(() => { expect(b.setIncludeTools).toHaveBeenCalledWith(SID, true) })
  })

  it('drives the PNG format, multi-select, and subagent options', async () => {
    const b = bench()
    await b.controller.open(SID)

    fireEvent.click(b.view.getByLabelText('PNG'))
    await waitFor(() => { expect(b.setFormat).toHaveBeenCalledWith(SID, 'png') })

    fireEvent.click(b.view.getByLabelText('Include subagent conversations'))
    await waitFor(() => { expect(b.setIncludeSubagents).toHaveBeenCalledWith(SID, true) })

    fireEvent.click(b.view.getByLabelText('Multi-select mode'))
    await waitFor(() => { expect(b.setMultiMode).toHaveBeenCalledWith(SID, true) })
  })

  it('multi-select rows toggle membership through clicks', async () => {
    const b = bench()
    await b.controller.open(SID)
    // The whole list is seeded into the selection; clicking a row removes it.
    act(() => { b.controller.setMultiMode(SID, true) })

    fireEvent.click(b.view.getByRole('button', { name: /#1/ }))
    await waitFor(() => { expect(b.setSelected).toHaveBeenCalledWith(SID, [1]) })
  })

  it('renders the range preview with localized role headers and code chrome', async () => {
    const controller = new ChatShareController(
      async () => payloadOf([message(1, 'user', '```js\nconst answer = 4\n```')]),
      async () => true,
      vi.fn(),
    )
    const b = bench(controller)
    await controller.open(SID)

    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })
    expect(dialog.textContent).toContain('Preview')
    expect(dialog.textContent).toContain('User · ')
    expect(dialog.textContent).toContain('const answer = 4')
    // The preview's fenced block carries the localized copy affordance beside the footer Copy.
    await waitFor(() => { expect(b.view.getAllByRole('button', { name: 'Copy' })).toHaveLength(2) })
  })

  it('labels subagent rows with the localized role', async () => {
    const controller = new ChatShareController(
      async () => payloadOf([
        message(1, 'user', 'parent question'),
        message(-1, 'subagent', 'Helper'),
        message(99, 'user', 'child answer', { child: { sessionId: 'child-1', title: 'Helper' } }),
      ]),
      async () => true,
      vi.fn(),
    )
    const b = bench(controller)
    await controller.open(SID)
    act(() => { void controller.setIncludeSubagents(SID, true) })

    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })
    await waitFor(() => { expect(dialog.textContent).toContain('Subagent') })
    expect(dialog.textContent).toContain('Helper')
  })

  it('closes through the mask overlay', async () => {
    const b = bench()
    await b.controller.open(SID)
    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })

    const mask = dialog.parentElement?.firstElementChild
    if (mask === null || mask === undefined) throw new Error('Chat share modal has no mask overlay')
    fireEvent.click(mask)

    await waitFor(() => { expect(b.dismiss).toHaveBeenCalledWith(SID) })
  })

  it('returns the format to Markdown through its radio', async () => {
    const b = bench()
    await b.controller.open(SID)

    fireEvent.click(b.view.getByLabelText('HTML'))
    await waitFor(() => { expect(b.setFormat).toHaveBeenCalledWith(SID, 'html') })
    fireEvent.click(b.view.getByLabelText('Markdown'))
    await waitFor(() => { expect(b.setFormat).toHaveBeenCalledWith(SID, 'markdown') })
  })

  it('previews a blank first line as an empty option label', async () => {
    const controller = new ChatShareController(
      async () => payloadOf([message(1, 'user', '\nsecond line')]),
      async () => true,
      vi.fn(),
    )
    const b = bench(controller)
    await controller.open(SID)

    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })
    expect(dialog.textContent).toContain('#1')
    // The label's preview is the trimmed first line, which is empty here.
    expect(b.view.getByLabelText('From').textContent).toContain('#1 User · ')
  })

  it('shows payload failures and closes through the footer', async () => {
    const controller = new ChatShareController(async () => { throw new Error('offline') }, async () => true, vi.fn())
    const b = bench(controller)
    await controller.open(SID)

    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })
    expect(dialog.textContent).toContain('Could not load messages.')
    expect(dialog.textContent).toContain('offline')
    const close = b.view.getAllByRole('button', { name: 'Close' }).at(-1)
    if (close === undefined) throw new Error('Chat share dialog has no footer action')
    fireEvent.click(close)
    await waitFor(() => { expect(b.dismiss).toHaveBeenCalledWith(SID) })
  })

  it('localizes the controller error codes and keeps raw detail', async () => {
    const b = bench()
    const withError = (error: string | null) => ({
      bySession: {
        [SID]: {
          open: true, loading: false, messages: [], from: 0, to: 0, multiMode: false, selected: [],
          format: 'markdown' as ShareFormat, redact: true, includeTools: false, includeSubagents: false,
          busy: null, copied: false, error,
        },
      },
    })

    act(() => { b.controller.store.set(withError(CHAT_SHARE_ERROR.copyFailed)) })
    expect((await b.view.findByRole('dialog', { name: 'Share chat segment' })).textContent).toContain('Copy failed.')

    act(() => { b.controller.store.set(withError(CHAT_SHARE_ERROR.downloadFailed)) })
    await waitFor(() => { expect(b.view.getByText('Download failed.')).toBeTruthy() })

    act(() => { b.controller.store.set(withError('')) })
    await waitFor(() => { expect(b.view.getByText('Could not load messages.')).toBeTruthy() })

    act(() => { b.controller.store.set(withError('reader exploded')) })
    await waitFor(() => { expect(b.view.getByText('Could not load messages. reader exploded')).toBeTruthy() })
  })

  it('reports an empty session without actions', async () => {
    const controller = new ChatShareController(async () => payloadOf([]), async () => true, vi.fn())
    const b = bench(controller)
    await controller.open(SID)

    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })
    expect(dialog.textContent).toContain('This session has no shareable messages.')
    const copy = b.view.getByRole('button', { name: 'Copy' }) as HTMLButtonElement
    expect(copy.disabled).toBe(true)
  })

  it('notes the row cap once the dialog holds the newest SHARE_MAX_MESSAGES rows', async () => {
    const messages = Array.from({ length: SHARE_MAX_MESSAGES }, (_value, index) => message(index + 1, 'user', `row ${index + 1}`))
    const controller = new ChatShareController(async () => payloadOf(messages), async () => true, vi.fn())
    const b = bench(controller)
    await controller.open(SID)

    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })
    expect(dialog.textContent).toContain('Showing the newest 300 messages')
    expect(b.controller.store.getSnapshot().bySession[SID]?.messages).toHaveLength(SHARE_MAX_MESSAGES)
  })

  it('drives the range controls, extends the range from the row list, and labels every role', async () => {
    const long = `first line ${'x'.repeat(60)}\nsecond line`
    const controller = new ChatShareController(
      async () => payloadOf([
        message(1, 'user', 'one'),
        message(2, 'assistant', 'two'),
        message(3, 'tool', '`bash`\n\n```json\necho hi\n```'),
        message(4, 'user', long),
      ]),
      async () => true,
      vi.fn(),
    )
    const b = bench(controller)
    await controller.open(SID)
    act(() => { controller.setIncludeTools(SID, true) })

    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })
    expect(dialog.textContent).toContain('Assistant')
    expect(dialog.textContent).toContain('Tool')
    // A long first line is trimmed into the option label.
    expect((b.view.getByLabelText('From') as HTMLSelectElement).textContent).toContain('…')

    fireEvent.change(b.view.getByLabelText('From'), { target: { value: '1' } })
    await waitFor(() => { expect(b.setRange).toHaveBeenCalledWith(SID, 1, 3) })
    fireEvent.change(b.view.getByLabelText('To'), { target: { value: '1' } })
    await waitFor(() => { expect(b.setRange).toHaveBeenCalledWith(SID, 1, 1) })

    // Clicking below `from` and above `to` extends the range instead of collapsing it.
    act(() => { controller.setRange(SID, 1, 1) })
    fireEvent.click(b.view.getByRole('button', { name: /#1/ }))
    await waitFor(() => { expect(b.setRange).toHaveBeenCalledWith(SID, 0, 1) })
    fireEvent.click(b.view.getByRole('button', { name: /#4/ }))
    await waitFor(() => { expect(b.setRange).toHaveBeenCalledWith(SID, 0, 3) })
  })

  it('adds a row to the multi-selection when an unselected row is clicked', async () => {
    const b = bench()
    await b.controller.open(SID)
    act(() => { b.controller.setRange(SID, 0, 0) })
    act(() => { b.controller.setMultiMode(SID, true) })
    expect(b.controller.store.getSnapshot().bySession[SID]?.selected).toEqual([0])

    fireEvent.click(b.view.getByRole('button', { name: /#2/ }))

    await waitFor(() => { expect(b.setSelected).toHaveBeenCalledWith(SID, [0, 1]) })
  })

  it('flashes the copy confirmation and clears it after the confirmation window', async () => {
    vi.useFakeTimers()
    try {
      const b = bench()
      await act(async () => { await b.controller.open(SID) })

      fireEvent.click(b.view.getByRole('button', { name: 'Copy' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(b.view.getByText('Copied')).toBeTruthy()

      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(b.view.queryByText('Copied')).toBeNull()
      expect(b.view.getByRole('button', { name: 'Copy' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the dialog open when state is replaced while a copy settles', async () => {
    const deferred = Promise.withResolvers<boolean>()
    const clipboard = vi.fn((_text: string) => deferred.promise)
    const controller = new ChatShareController(
      async () => payloadOf([message(1, 'user', 'a')]), clipboard, vi.fn())
    const b = bench(controller)
    await controller.open(SID)

    const copying = controller.copy(SID)
    await waitFor(() => { expect(clipboard).toHaveBeenCalled() })
    act(() => { deferred.resolve(true) })
    await copying
    expect(controller.store.getSnapshot().bySession[SID]).toMatchObject({ open: true, copied: true })
    expect(await b.view.findByText('Copied')).toBeTruthy()
  })
})
