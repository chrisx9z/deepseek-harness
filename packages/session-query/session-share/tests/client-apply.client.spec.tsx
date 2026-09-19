// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ChatShareHeaderAction } from '../src/client/HeaderAction.tsx'
import type { ChatShareDialogInjected } from '../src/client/Dialog.tsx'
import { NS } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

const SID = 'session-share-apply' as SessionId

/** Three shareable rows, so a `last N` window is distinguishable from the whole chat. */
const PAYLOAD = {
  sessionId: String(SID),
  title: 'Fixture session',
  cwd: '/workspace',
  messages: [
    { seq: 1, role: 'user', time: 1000, text: 'one', images: [], child: null },
    { seq: 2, role: 'assistant', time: 2000, text: 'two', images: [], child: null },
    { seq: 3, role: 'user', time: 3000, text: 'three', images: [], child: null },
  ],
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

/** Mount the browser half over the real slot registry and locale runtime. */
async function bench() {
  const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({
    ok: true,
    json: async () => PAYLOAD,
  }))
  vi.stubGlobal('fetch', fetchMock)
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declaration = declare(slots)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, declaration, fiber, fetchMock }
}

/** Observe browser downloads: object URLs capture the artifact Blob. */
function captureDownloads() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:fixture')
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return { createObjectURL, click }
}

describe('session-share browser plugin', () => {
  it('provides one controller and one Header contribution, removed on disposal', async () => {
    const b = await bench()

    expect(inject).toEqual(['slots', 'locale'])
    expect(b.ctx.chatShare.store.getSnapshot()).toEqual({ bySession: {} })
    expect(b.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    const entries = b.slots.entries('conversation.session.header.utilities')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.component).toBe(ChatShareHeaderAction)
    expect(entries[0]?.options).toMatchObject({ id: 'session-share' })
    expect(entries[0]?.locale).toBe(NS)

    await b.fiber.dispose()
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
  })

  it('wires the injected face to the controller for every dialog action', async () => {
    const b = await bench()
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    const injected = (entry?.inject as unknown as () => ChatShareDialogInjected)()

    await injected.open(SID)
    expect(b.ctx.chatShare.store.getSnapshot().bySession[SID]).toMatchObject({
      open: true, loading: false, from: 0, to: 2,
    })

    // Row options rebuild the list, so they are applied before the range is chosen.
    injected.setRedact(SID, false)
    injected.setIncludeTools(SID, true)
    await injected.setIncludeSubagents(SID, true)
    injected.setRange(SID, 1, 1)
    injected.setFormat(SID, 'txt')
    injected.setMultiMode(SID, true)
    injected.setSelected(SID, [2])
    expect(b.ctx.chatShare.store.getSnapshot().bySession[SID]).toMatchObject({
      from: 1, to: 1, format: 'txt', redact: false, includeTools: true,
      includeSubagents: true, multiMode: true, selected: [2],
    })

    injected.dismiss(SID)
    expect(b.ctx.chatShare.store.getSnapshot().bySession[SID]?.open).toBe(false)
    await b.fiber.dispose()
  })

  it('renders artifacts with the live locale labels', async () => {
    const b = await bench()
    const downloads = captureDownloads()
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    const injected = (entry?.inject as unknown as () => ChatShareDialogInjected)()
    await injected.open(SID)

    b.ctx.locale.setLocale('zh')
    await injected.download(SID)

    const blob = downloads.createObjectURL.mock.calls[0]?.[0]
    expect(blob).toBeDefined()
    const markdown = await blob?.text()
    expect(markdown).toContain('**用户**')
    expect(markdown).toContain('分享自 DeepSeek Harness')
    await b.fiber.dispose()
  })

  it('opens the dialog for a share execution acknowledged by this browser client', async () => {
    const b = await bench()

    b.ctx.emit('command/executed', SID, 'plan', { kind: 'success', text: 'share' })
    b.ctx.emit('command/executed', SID, 'share', { kind: 'error', text: 'share' })
    expect(b.fetchMock).not.toHaveBeenCalled()

    b.ctx.emit('command/executed', SID, 'share', { kind: 'success', text: 'share' })
    await vi.waitFor(() => {
      expect(b.fetchMock).toHaveBeenCalledOnce()
      expect(b.ctx.chatShare.store.getSnapshot().bySession[SID]).toMatchObject({ open: true, loading: false })
    })

    // A result without a token still opens the dialog.
    b.ctx.chatShare.dismiss(SID)
    b.ctx.emit('command/executed', SID, 'share', { kind: 'success' })
    await vi.waitFor(() => { expect(b.ctx.chatShare.store.getSnapshot().bySession[SID]?.open).toBe(true) })
    expect(b.fetchMock).toHaveBeenCalledOnce()
    await b.fiber.dispose()
  })

  it('saves the chat as TXT for a share:txt execution and honors a last N window', async () => {
    const b = await bench()
    const downloads = captureDownloads()

    b.ctx.emit('command/executed', SID, 'share', { kind: 'success', text: 'share:txt:2' })
    await vi.waitFor(() => { expect(downloads.createObjectURL).toHaveBeenCalledOnce() })
    const anchor = downloads.click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe(`dsh-session-share-${SID}-2-3.txt`)
    const windowed = await downloads.createObjectURL.mock.calls[0]?.[0]?.text()
    expect(windowed).toContain('three')
    expect(windowed).not.toContain('one')

    // An unparsable count falls back to the whole chat, and no dialog opens.
    b.ctx.emit('command/executed', SID, 'share', { kind: 'success', text: 'share:txt:many' })
    await vi.waitFor(() => { expect(downloads.createObjectURL).toHaveBeenCalledTimes(2) })
    expect(await downloads.createObjectURL.mock.calls[1]?.[0]?.text()).toContain('one')
    expect(b.ctx.chatShare.store.getSnapshot().bySession[SID]).toBeUndefined()
    await b.fiber.dispose()
  })
})
