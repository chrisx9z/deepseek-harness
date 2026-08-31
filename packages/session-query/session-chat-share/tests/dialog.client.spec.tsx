// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { HistoryEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { ChatShareController, type ChatShareState, type HistoryPage } from '../src/client/controller.ts'
import { ChatShareDialog, type ChatShareDialogProps } from '../src/client/Dialog.tsx'
import { en } from '../src/client/locales.ts'

const SID = 'session-chat-share-dialog' as SessionId

function user(seq: number, text: string): HistoryEntry {
  return {
    event: {
      type: 'user/message', seq, time: seq * 1000,
      data: { id: `u-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user-rpc', rpcId: `r-${seq}` } },
      surfaceOp: 'append',
    },
  } as unknown as HistoryEntry
}

function bench(controller = new ChatShareController(async () => ({ events: [], hasMore: false }), async () => true, vi.fn())) {
  const open = vi.fn((sessionId: SessionId) => controller.open(sessionId))
  const setRange = vi.fn((sessionId: SessionId, from: number, to: number) => { controller.setRange(sessionId, from, to) })
  const setFormat = vi.fn((sessionId: SessionId, format: 'markdown' | 'html') => { controller.setFormat(sessionId, format) })
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
  const props = { sessionId: SID, useChatShare, open, setRange, setFormat, copy, download, dismiss, t } as unknown as ChatShareDialogProps
  const view = render(<ChatShareDialog {...props} />)
  return { controller, open, setRange, setFormat, copy, download, dismiss, view }
}

afterEach(cleanup)

describe('ChatShareDialog', () => {
  it('shows the loading state while history is being read', async () => {
    let release!: (page: HistoryPage) => void
    const pending = new Promise<HistoryPage>((resolve) => { release = resolve })
    const controller = new ChatShareController(() => pending, async () => true, vi.fn())
    const b = bench(controller)

    const opening = controller.open(SID)
    expect(await b.view.findByRole('dialog', { name: 'Share chat segment' })).toBeTruthy()
    expect(b.view.getByText('Loading messages…')).toBeTruthy()
    release({ events: [user(1, 'hi')], hasMore: false })
    await opening
  })

  it('lists messages, selects a range, and drives copy and format actions', async () => {
    const controller = new ChatShareController(
      async () => ({ events: [user(1, 'first question'), user(2, 'second question')], hasMore: false }),
      async () => true,
      vi.fn(),
    )
    const b = bench(controller)
    await controller.open(SID)

    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })
    expect(dialog.textContent).toContain('#1')
    expect(dialog.textContent).toContain('first question')

    fireEvent.click(b.view.getByRole('button', { name: /#2/ }))
    await waitFor(() => { expect(b.setRange).toHaveBeenCalledWith(SID, 1, 1) })

    fireEvent.click(b.view.getByLabelText('HTML'))
    await waitFor(() => { expect(b.setFormat).toHaveBeenCalledWith(SID, 'html') })

    fireEvent.click(b.view.getByRole('button', { name: 'Copy' }))
    await waitFor(() => { expect(b.copy).toHaveBeenCalledWith(SID) })
    await waitFor(() => { expect(b.view.getByText('Copied')).toBeTruthy() })

    fireEvent.click(b.view.getByRole('button', { name: 'Download' }))
    await waitFor(() => { expect(b.download).toHaveBeenCalledWith(SID) })
  })

  it('shows history failures and closes through the footer', async () => {
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

  it('reports an empty session without actions', async () => {
    const controller = new ChatShareController(async () => ({ events: [], hasMore: false }), async () => true, vi.fn())
    const b = bench(controller)
    await controller.open(SID)

    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })
    expect(dialog.textContent).toContain('This session has no shareable messages.')
    const copy = b.view.getByRole('button', { name: 'Copy' }) as HTMLButtonElement
    expect(copy.disabled).toBe(true)
  })

  it('keeps the dialog open when state is replaced while a copy settles', async () => {
    let resolveCopy!: (ok: boolean) => void
    const clipboard = vi.fn((_text: string) => new Promise<boolean>((resolve) => { resolveCopy = resolve }))
    const controller = new ChatShareController(async () => ({ events: [user(1, 'a')], hasMore: false }), clipboard, vi.fn())
    const b = bench(controller)
    await controller.open(SID)

    const copying = controller.copy(SID)
    act(() => { resolveCopy(true) })
    await copying
    expect(controller.store.getSnapshot().bySession[SID]).toMatchObject({ open: true, copied: true })
    expect(await b.view.findByText('Copied')).toBeTruthy()
  })
})
