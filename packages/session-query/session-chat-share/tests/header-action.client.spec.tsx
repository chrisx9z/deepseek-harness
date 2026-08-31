// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { HistoryEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { ChatShareController, type ChatShareState, type HistoryPage } from '../src/client/controller.ts'
import { ChatShareHeaderAction } from '../src/client/HeaderAction.tsx'
import type { ChatShareDialogProps } from '../src/client/Dialog.tsx'
import { en } from '../src/client/locales.ts'

const SID = 'session-chat-share-header' as SessionId

function user(seq: number, text: string): HistoryEntry {
  return {
    event: {
      type: 'user/message', seq, time: seq * 1000,
      data: { id: `u-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user-rpc', rpcId: `r-${seq}` } },
      surfaceOp: 'append',
    },
  } as unknown as HistoryEntry
}

function bindChatShare(controller: ChatShareController) {
  return function useChatShare<T>(selector: (state: ChatShareState) => T): T {
    return useSyncExternalStore(
      listener => controller.store.subscribe(listener),
      () => selector(controller.store.getSnapshot()),
    )
  }
}

function bench() {
  const controller = new ChatShareController(async () => ({ events: [], hasMore: false }), async () => true, vi.fn())
  const open = vi.fn((sessionId: SessionId) => controller.open(sessionId))
  const props = {
    sessionId: SID,
    useChatShare: bindChatShare(controller),
    open,
    setRange: vi.fn(),
    setFormat: vi.fn(),
    copy: vi.fn(),
    download: vi.fn(),
    dismiss: vi.fn(),
    t: (key: keyof typeof en): string => en[key],
  } as unknown as ChatShareDialogProps
  const view = render(<ChatShareHeaderAction {...props} />)
  return { controller, open, view }
}

afterEach(cleanup)

describe('Chat share Header action', () => {
  it('renders the Share capsule and opens the dialog through the controller', async () => {
    const b = bench()
    const button = b.view.getByRole('button', { name: 'Share' })
    expect(button.querySelector('svg')).not.toBeNull()
    fireEvent.click(button)
    await waitFor(() => { expect(b.open).toHaveBeenCalledWith(SID) })
    expect(await b.view.findByRole('dialog', { name: 'Share chat segment' })).toBeTruthy()
  })

  it('disables the capsule while the dialog loads history', async () => {
    const b = bench()
    let release!: (page: HistoryPage) => void
    const pending = new Promise<HistoryPage>((resolve) => { release = resolve })
    const controller = new ChatShareController(() => pending, async () => true, vi.fn())
    b.view.rerender(<ChatShareHeaderAction {...({
      sessionId: SID,
      useChatShare: bindChatShare(controller),
      open: (sessionId: SessionId) => controller.open(sessionId),
      setRange: vi.fn(),
      setFormat: vi.fn(),
      copy: vi.fn(),
      download: vi.fn(),
      dismiss: vi.fn(),
      t: (key: keyof typeof en): string => en[key],
    } as unknown as ChatShareDialogProps)} />)

    const opening = controller.open(SID)
    const button = b.view.getByRole('button', { name: 'Share' })
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('true') })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    release({ events: [user(1, 'hi')], hasMore: false })
    await opening
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('false') })
  })
})
