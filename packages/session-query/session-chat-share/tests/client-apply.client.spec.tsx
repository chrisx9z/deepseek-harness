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

const SID = 'session-chat-share-apply' as SessionId

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

/**
 * Complete the DOM seams `html-to-image` needs in jsdom: the SVG element probe,
 * an `Image` that decodes a data URL, and a canvas that yields a PNG data URL.
 */
function stubRasterizer(): { readonly toDataURL: ReturnType<typeof vi.fn> } {
  // `html-to-image` only probes that SVGImageElement exists; an empty constructor
  // is all the jsdom seam needs.
  const SvgImageElementStub = function SvgImageElementStub(): void {}
  class ImageStub {
    onload: (() => void) | null = null
    width = 1
    height = 1
    #src = ''
    get src(): string { return this.#src }
    set src(value: string) {
      this.#src = value
      setTimeout(() => { this.onload?.() }, 0)
    }
    decode(): Promise<void> { return Promise.resolve() }
  }
  vi.stubGlobal('SVGImageElement', SvgImageElementStub)
  vi.stubGlobal('Image', ImageStub)

  const toDataURL = vi.fn(() => 'data:image/png;base64,QUJD')
  const context2d = new Proxy({}, { get: () => () => undefined, set: () => true })
  // oxlint-disable-next-line typescript/no-deprecated -- the spy must wrap the real jsdom factory to keep other elements intact
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
    const element = createElement(tag, options)
    if (tag === 'canvas') {
      Object.assign(element, { getContext: () => context2d, toDataURL, width: 1, height: 1 })
    }
    return element
  })
  return { toDataURL }
}

describe('session-chat-share browser plugin', () => {
  it('provides one controller and one Header contribution, removed on disposal', async () => {
    const b = await bench()

    expect(inject).toEqual(['slots', 'locale'])
    expect(b.ctx.chatShare.store.getSnapshot()).toEqual({ bySession: {} })
    expect(b.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    const entries = b.slots.entries('conversation.session.header.utilities')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.component).toBe(ChatShareHeaderAction)
    expect(entries[0]?.options).toMatchObject({ id: 'session-chat-share' })
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

  it('wires copy through the injected face', async () => {
    const b = await bench()
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    const injected = (entry?.inject as unknown as () => ChatShareDialogInjected)()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await injected.open(SID)

    await injected.copy(SID)

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText.mock.calls[0]?.[0]).toContain('**User**')
    expect(writeText.mock.calls[0]?.[0]).toContain('one')
    Reflect.deleteProperty(navigator, 'clipboard')
    await b.fiber.dispose()
  })

  it('rasterizes a PNG download through the wired html-to-image converter', async () => {
    const raster = stubRasterizer()
    const b = await bench()
    const downloads = captureDownloads()
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    const injected = (entry?.inject as unknown as () => ChatShareDialogInjected)()
    await injected.open(SID)

    injected.setFormat(SID, 'png')
    await injected.download(SID)

    const blob = downloads.createObjectURL.mock.calls[0]?.[0]
    expect(blob?.type).toBe('image/png')
    expect((downloads.click.mock.instances[0] as HTMLAnchorElement).download)
      .toBe(`dsh-session-chat-share-${SID}-1-3.png`)
    // The browser half hands the detached artifact node to the real converter.
    const rendered = raster.toDataURL.mock.instances[0] as HTMLCanvasElement
    expect(rendered).toBeInstanceOf(HTMLCanvasElement)
    expect(b.ctx.chatShare.store.getSnapshot().bySession[SID]?.error).toBeNull()
    await b.fiber.dispose()
  }, 20_000)

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

  it('ignores a command result whose token is not a share intent', async () => {
    const b = await bench()

    b.ctx.emit('command/executed', SID, 'share', { kind: 'success', text: 'something-else' })
    await Promise.resolve()

    expect(b.fetchMock).not.toHaveBeenCalled()
    expect(b.ctx.chatShare.store.getSnapshot().bySession[SID]).toBeUndefined()
    await b.fiber.dispose()
  })

  it('saves the whole chat with the newest-N window for a bare txt intent', async () => {
    const b = await bench()
    const downloads = captureDownloads()

    b.ctx.emit('command/executed', SID, 'share', { kind: 'success', text: 'share:txt' })
    await vi.waitFor(() => { expect(downloads.createObjectURL).toHaveBeenCalledOnce() })

    const anchor = downloads.click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe(`dsh-session-chat-share-${SID}-1-3.txt`)
    const text = await downloads.createObjectURL.mock.calls[0]?.[0]?.text()
    expect(text).toContain('one')
    expect(text).toContain('three')
    await b.fiber.dispose()
  })

  it('saves the chat as TXT for a share:txt execution and honors a last N window', async () => {
    const b = await bench()
    const downloads = captureDownloads()

    b.ctx.emit('command/executed', SID, 'share', { kind: 'success', text: 'share:txt:2' })
    await vi.waitFor(() => { expect(downloads.createObjectURL).toHaveBeenCalledOnce() })
    const anchor = downloads.click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe(`dsh-session-chat-share-${SID}-2-3.txt`)
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
