// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChatShareController, type ChatShareState, type SharePayload, type SharePayloadMessage } from '../src/client/controller.ts'
import { ChatShareHeaderAction } from '../src/client/HeaderAction.tsx'
import type { ChatShareDialogProps } from '../src/client/Dialog.tsx'
import { en } from '../src/client/locales.ts'

const SID = 'session-share-header' as SessionId

function message(seq: number, text: string): SharePayloadMessage {
  return { seq, role: 'user', time: seq * 1000, text, images: [], child: null }
}

function payloadOf(messages: readonly SharePayloadMessage[]): SharePayload {
  return { sessionId: String(SID), title: 'Fixture session', cwd: '/workspace', messages }
}

function bindChatShare(controller: ChatShareController) {
  return function useChatShare<T>(selector: (state: ChatShareState) => T): T {
    return useSyncExternalStore(
      listener => controller.store.subscribe(listener),
      () => selector(controller.store.getSnapshot()),
    )
  }
}

function bench(controller = new ChatShareController(
  async () => payloadOf([message(1, 'header row')]), async () => true, vi.fn())) {
  const open = vi.fn((sessionId: SessionId) => controller.open(sessionId))
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  const props = {
    sessionId: SID,
    useChatShare: bindChatShare(controller),
    open,
    setRange: vi.fn(),
    setFormat: vi.fn(),
    setRedact: vi.fn(),
    setIncludeTools: vi.fn(),
    setIncludeSubagents: vi.fn(),
    setMultiMode: vi.fn(),
    setSelected: vi.fn(),
    copy: vi.fn(),
    download: vi.fn(),
    dismiss,
    t: (key: keyof typeof en): string => en[key],
  } as unknown as ChatShareDialogProps
  const view = render(<ChatShareHeaderAction {...props} />)
  return { controller, open, dismiss, view }
}

afterEach(cleanup)

describe('Chat share Header action', () => {
  it('renders the Share capsule and opens the dialog through the controller', async () => {
    const b = bench()
    const button = b.view.getByRole('button', { name: 'Share' })
    expect(button.querySelector('svg')).not.toBeNull()

    fireEvent.click(button)

    await waitFor(() => { expect(b.open).toHaveBeenCalledWith(SID) })
    const dialog = await b.view.findByRole('dialog', { name: 'Share chat segment' })
    expect(dialog.textContent).toContain('header row')
  })

  it('closes the dialog through its own action and reopens it from the capsule', async () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: 'Share' }))
    await b.view.findByRole('dialog', { name: 'Share chat segment' })

    const close = b.view.getAllByRole('button', { name: 'Close' }).at(-1)
    if (close === undefined) throw new Error('Chat share dialog has no footer action')
    fireEvent.click(close)

    await waitFor(() => { expect(b.dismiss).toHaveBeenCalledWith(SID) })
    await waitFor(() => { expect(b.view.queryByRole('dialog')).toBeNull() })

    fireEvent.click(b.view.getByRole('button', { name: 'Share' }))
    expect(await b.view.findByRole('dialog', { name: 'Share chat segment' })).toBeTruthy()
    expect(b.open).toHaveBeenCalledTimes(2)
  })

  it('disables the capsule while the dialog loads the payload', async () => {
    const deferred = Promise.withResolvers<SharePayload>()
    const controller = new ChatShareController(() => deferred.promise, async () => true, vi.fn())
    const b = bench(controller)

    const opening = controller.open(SID)
    const button = b.view.getByRole('button', { name: 'Share' })
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('true') })
    expect((button as HTMLButtonElement).disabled).toBe(true)

    deferred.resolve(payloadOf([message(1, 'hi')]))
    await opening
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('false') })
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })
})
