import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import * as SessionChatShare from '../src/index.ts'
import {
  SHARE_ROUTE, hostRenderTxt, inject, name, parseShareInvocation, shareMessagesFromEvents,
  shareRouteResponse, type SessionChatShareConfig,
} from '../src/index.ts'

/** One durable session event as the fold reads it (the module keeps the type private). */
type ShareEvent = Parameters<typeof shareMessagesFromEvents>[0][number]
/** One persisted content block inside a message event. */
type ShareBlock = NonNullable<NonNullable<ShareEvent['data']>['content']>[number]

function textBlock(text: string): ShareBlock {
  return { type: 'text', text }
}

function imageBlock(attachmentId: string, mediaType?: string, name?: string): ShareBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId,
      ...(mediaType === undefined ? {} : { mediaType }),
      ...(name === undefined ? {} : { name }),
    },
  }
}

function userEvent(seq: number, content: readonly ShareBlock[], time = seq * 1000): ShareEvent {
  return { type: 'user/message', seq, time, surfaceOp: 'append', data: { content } }
}

function userText(seq: number, text: string): ShareEvent {
  return userEvent(seq, [textBlock(text)])
}

function assistantEvent(seq: number, content: readonly ShareBlock[], time = seq * 1000): ShareEvent {
  return { type: 'assistant/message', seq, time, surfaceOp: 'append', data: { message: { content } } }
}

function assistantText(seq: number, text: string): ShareEvent {
  return assistantEvent(seq, [textBlock(text)])
}

function toolEvent(seq: number, name: string | undefined, arguments_: string): ShareEvent {
  return {
    type: 'tool/call', seq, time: seq * 1000,
    ...(seq % 2 === 1 ? { surfaceOp: 'append' } : {}),
    data: { ...(name === undefined ? {} : { name }), arguments: arguments_ },
  }
}

/** One observation lease whose disposal is observable. */
function observationOf(
  events: readonly ShareEvent[],
  header: { readonly cwd?: string; readonly title?: string } = {},
) {
  const dispose = vi.fn()
  return { header, events, [Symbol.dispose]: dispose, dispose }
}

/** A host context carrying only the services one route call should read. */
function hostCtx(services: {
  readonly sessionQuery?: unknown
  readonly subagents?: unknown
  readonly attachments?: unknown
} = {}): Context {
  const ctx = new Context()
  if (services.sessionQuery !== undefined) ctx.provide('sessionQuery', services.sessionQuery as never)
  if (services.subagents !== undefined) ctx.provide('subagents', services.subagents as never)
  if (services.attachments !== undefined) ctx.provide('attachments', services.attachments as never)
  return ctx
}

/** One route registration as the connection double captures it. */
interface CapturedRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Mount the plugin over a real Context with the command plane and transport doubled. */
async function mount(config?: SessionChatShareConfig) {
  let descriptor: CommandDefinition | undefined
  const routes: CapturedRoute[] = []
  const ctx = new Context()
  ctx.provide('commands', {
    register(next: CommandDefinition) {
      descriptor = next
      return () => { descriptor = undefined }
    },
  } as never)
  ctx.provide('connection', {
    fetch: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => Promise.resolve()
      },
    },
  } as never)
  const fiber = await ctx.plugin(SessionChatShare, config)
  return { ctx, routes, fiber, command: () => descriptor }
}

let roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-session-share-'))
  roots.push(dir)
  return dir
}

describe('/share host plugin', () => {
  it('registers one command and one GET payload route, and removes the command with its fiber', async () => {
    const mounted = await mount()

    expect(name).toBe('session-share')
    expect(inject).toEqual(['commands', 'connection'])
    expect(mounted.command()).toMatchObject({
      name: 'share',
      description: 'Share a segment of this chat as Markdown, HTML, or plain text',
    })
    expect(mounted.routes).toHaveLength(1)
    expect(mounted.routes[0]).toMatchObject({ path: SHARE_ROUTE, methods: ['GET'], requestBody: 'buffered' })

    await mounted.fiber.dispose()
    expect(mounted.command()).toBeUndefined()
  })

  it('resolves the browser intent through the registered handler', async () => {
    const mounted = await mount()
    const invoke = (rawInput: string) => mounted.command()?.handler({ rawInput } as CommandInvocation)

    await expect(invoke('')).resolves.toEqual({ kind: 'success', text: 'share' })
    await expect(invoke('txt')).resolves.toEqual({ kind: 'success', text: 'share:txt' })
    await expect(invoke('txt last 3')).resolves.toEqual({ kind: 'success', text: 'share:txt:3' })
    await expect(invoke('last 3')).resolves.toEqual({ kind: 'success', text: 'share:txt:3' })
    await expect(invoke('nope')).resolves.toMatchObject({ kind: 'error' })
    await mounted.fiber.dispose()
  })

  it('serves the payload through the registered connection route', async () => {
    const mounted = await mount()
    mounted.ctx.provide('sessionQuery', {
      observeSession: async () => observationOf([userText(1, 'through the route')], { title: 'Fixture' }),
    } as never)

    const route = mounted.routes[0]
    if (route === undefined) throw new Error('/share registered no route')
    const response = await route.fetch(new Request(`http://host${SHARE_ROUTE}?sessionId=s1`))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      sessionId: 's1',
      title: 'Fixture',
      messages: [{ seq: 1, role: 'user', text: 'through the route' }],
    })
    expect((await route.fetch(new Request(`http://host${SHARE_ROUTE}`))).status).toBe(400)
    await mounted.fiber.dispose()
  })

  it('writes one plain-text file per completed turn when autoSaveDir is configured', async () => {
    const dir = await tempDir()
    const mounted = await mount({ autoSaveDir: dir })
    const observed = observationOf([userText(1, 'saved message')], { title: 'Fixture' })
    mounted.ctx.provide('sessionQuery', { observeSession: async () => observed } as never)

    mounted.ctx.emit('session/event', { id: 'session-1' } as never, { type: 'turn/end' } as never)

    await expect.poll(async () => readFile(join(dir, 'session-1.txt'), 'utf8')).toContain('saved message')
    expect(observed.dispose).toHaveBeenCalledOnce()
    await mounted.fiber.dispose()
  })

  it('ignores turns outside the export and turns that are still running', async () => {
    const dir = await tempDir()
    const mounted = await mount({ autoSaveDir: dir })
    const observeSession = vi.fn(async () => observationOf([userText(1, 'ignored')]))
    mounted.ctx.provide('sessionQuery', { observeSession } as never)

    mounted.ctx.emit('session/event', { id: 'session-1' } as never, { type: 'turn/start' } as never)
    mounted.ctx.emit('session/event', { id: 'session-1' } as never, { type: 'assistant/message' } as never)
    await Promise.resolve()

    expect(observeSession).not.toHaveBeenCalled()
    expect(await readdir(dir)).toEqual([])
    await mounted.fiber.dispose()
  })

  it('logs an auto-save failure and writes no file', async () => {
    const dir = await tempDir()
    const mounted = await mount({ autoSaveDir: dir })
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)
    mounted.ctx.provide('sessionQuery', {
      observeSession: async () => { throw new Error('history offline') },
    } as never)

    mounted.ctx.emit('session/event', { id: 'session-1' } as never, { type: 'turn/end' } as never)

    await expect.poll(() => warn.mock.calls.length).toBe(1)
    expect(warn.mock.calls[0]?.[0]).toBe('session-share: auto-save failed: history offline')
    expect(await readdir(dir)).toEqual([])
    await mounted.fiber.dispose()
  })

  it('logs a non-Error auto-save failure with its string form', async () => {
    const dir = await tempDir()
    const mounted = await mount({ autoSaveDir: dir })
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)
    mounted.ctx.provide('sessionQuery', {
      observeSession: async () => { throw 'history offline' },
    } as never)

    mounted.ctx.emit('session/event', { id: 'session-1' } as never, { type: 'turn/end' } as never)

    await expect.poll(() => warn.mock.calls.length).toBe(1)
    expect(warn.mock.calls[0]?.[0]).toBe('session-share: auto-save failed: history offline')
    await mounted.fiber.dispose()
  })

  it('treats a blank autoSaveDir as no auto-save listener', async () => {
    const mounted = await mount({ autoSaveDir: '   ' })

    mounted.ctx.emit('session/event', { id: 'session-1' } as never, { type: 'turn/end' } as never)
    await Promise.resolve()

    expect(mounted.routes).toHaveLength(1)
    expect(mounted.command()).toMatchObject({ name: 'share' })
    await mounted.fiber.dispose()
  })

  it('writes nothing on a completed turn without a session reader', async () => {
    const dir = await tempDir()
    const mounted = await mount({ autoSaveDir: dir })
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)

    mounted.ctx.emit('session/event', { id: 'session-2' } as never, { type: 'turn/end' } as never)
    await Promise.resolve()

    expect(warn).not.toHaveBeenCalled()
    expect(await readdir(dir)).toEqual([])
    await mounted.fiber.dispose()
  })
})

describe('parseShareInvocation', () => {
  it('opens the dialog by default and rejects unknown tokens', () => {
    expect(parseShareInvocation('')).toEqual({ kind: 'success', text: 'share' })
    expect(parseShareInvocation('  ')).toEqual({ kind: 'success', text: 'share' })
    expect(parseShareInvocation('output.md').kind).toBe('error')
    expect(parseShareInvocation('TXT').kind).toBe('error')
  })

  it('accepts txt and last <n> in any order', () => {
    expect(parseShareInvocation('txt')).toEqual({ kind: 'success', text: 'share:txt' })
    expect(parseShareInvocation('last 10')).toEqual({ kind: 'success', text: 'share:txt:10' })
    expect(parseShareInvocation('txt last 5')).toEqual({ kind: 'success', text: 'share:txt:5' })
    expect(parseShareInvocation('last 5 txt')).toEqual({ kind: 'success', text: 'share:txt:5' })
    expect(parseShareInvocation('  txt   last   7  ')).toEqual({ kind: 'success', text: 'share:txt:7' })
  })

  it('rejects a missing or non-positive count', () => {
    expect(parseShareInvocation('last').kind).toBe('error')
    expect(parseShareInvocation('last 0').kind).toBe('error')
    expect(parseShareInvocation('last -3').kind).toBe('error')
    expect(parseShareInvocation('last 2.5').kind).toBe('error')
    expect(parseShareInvocation('last many').kind).toBe('error')
  })
})

describe('shareMessagesFromEvents', () => {
  it('folds append-origin user and assistant messages in log order', () => {
    expect(shareMessagesFromEvents([userText(1, 'hello'), assistantText(2, 'hi')])).toEqual([
      { seq: 1, role: 'user', time: 1000, text: 'hello', images: [], child: null },
      { seq: 2, role: 'assistant', time: 2000, text: 'hi', images: [], child: null },
    ])
  })

  it('joins text blocks and keeps image references until the bytes are inlined', () => {
    const events = [userEvent(1, [
      textBlock('a'),
      imageBlock('img-1', 'image/png', 'shot.png'),
      textBlock('b'),
    ])]

    expect(shareMessagesFromEvents(events)).toEqual([
      {
        seq: 1, role: 'user', time: 1000, text: 'a\nb', child: null,
        images: [{ attachmentId: 'img-1', mediaType: 'image/png', name: 'shot.png', data: null }],
      },
    ])
  })

  it('marks image-only messages and defaults a missing media type', () => {
    expect(shareMessagesFromEvents([userEvent(2, [imageBlock('img-2')])])).toEqual([
      {
        seq: 2, role: 'user', time: 2000, text: '[image]', child: null,
        images: [{ attachmentId: 'img-2', mediaType: 'image/png', data: null }],
      },
    ])
  })

  it('drops tool results, boundary markers, surface-replacing copies, and empty messages', () => {
    const events: ShareEvent[] = [
      { type: 'turn/start', seq: 1, time: 1 },
      userEvent(2, [textBlock('kept')]),
      { ...userEvent(3, [textBlock('replaced')]), surfaceOp: { op: 'replace', start: 0, end: 0 } },
      { type: 'tool/result', seq: 4, time: 4, surfaceOp: 'append' },
      userEvent(5, [{ type: 'tool-call' }]),
      userEvent(6, []),
      userEvent(7, [{ type: 'image' }]),
    ]

    expect(shareMessagesFromEvents(events)).toEqual([
      { seq: 2, role: 'user', time: 2000, text: 'kept', images: [], child: null },
      // An image block with no attachment keeps its marker but carries no image.
      { seq: 7, role: 'user', time: 7000, text: '[image]', images: [], child: null },
    ])
  })

  it('defaults a missing seq and time to zero', () => {
    expect(shareMessagesFromEvents([{ type: 'user/message', data: { content: [textBlock('bare')] } }])).toEqual([
      { seq: 0, role: 'user', time: 0, text: 'bare', images: [], child: null },
    ])
  })

  it('renders tool calls with bounded arguments', () => {
    const long = 'x'.repeat(900)
    const messages = shareMessagesFromEvents([
      toolEvent(1, 'bash', 'echo hi'),
      toolEvent(2, 'read', ''),
      toolEvent(3, undefined, long),
    ])

    expect(messages.map(message => message.role)).toEqual(['tool', 'tool', 'tool'])
    expect(messages[0]?.text).toBe('`bash`\n\n```json\necho hi\n```')
    expect(messages[1]?.text).toBe('`read`')
    expect(messages[2]?.text.startsWith('`tool`')).toBe(true)
    expect(messages[2]?.text.length).toBeLessThan(long.length + 20)
    expect(messages[2]?.text.endsWith('…\n```')).toBe(true)
    expect(messages.every(message => message.images.length === 0 && message.child === null)).toBe(true)
  })
})

describe('hostRenderTxt', () => {
  it('renders the header alone for an empty chat', () => {
    expect(hostRenderTxt([])).toBe('Shared from DeepSeek Harness\n')
  })

  it('renders one plain-text block per role with no markup', () => {
    const text = hostRenderTxt([userText(1, 'question'), toolEvent(2, 'bash', 'echo hi'), assistantText(3, 'answer')])

    expect(text.startsWith('Shared from DeepSeek Harness\n')).toBe(true)
    expect(text).toContain('User · ')
    expect(text).toContain('Tool · ')
    expect(text).toContain('Assistant · ')
    expect(text).toContain('question')
    expect(text).toContain('`bash`')
    expect(text).toContain('answer')
    expect(text).not.toContain('**User**')
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('shareRouteResponse', () => {
  it('rejects a request without a session id', async () => {
    const response = await shareRouteResponse(hostCtx(), {}, new Request(`http://host${SHARE_ROUTE}`))

    expect(response.status).toBe(400)
    expect(await response.text()).toBe('missing sessionId query parameter')
  })

  it('serves the session payload, inlining image bytes as base64', async () => {
    const observed = observationOf([
      userEvent(1, [textBlock('look'), imageBlock('img-1', 'image/png', 'shot.png')]),
      assistantText(2, 'seen'),
    ], { title: 'Fixture', cwd: '/workspace' })
    const observeSession = vi.fn(async (
      _sessionId: string,
      _options: { readonly signal: AbortSignal; readonly projectionMode: string },
    ) => observed)
    const readImage = vi.fn(async () => ({ data: 'AAAA', mediaType: 'image/jpeg' }))
    const ctx = hostCtx({ sessionQuery: { observeSession }, attachments: { readImage } })

    const response = await shareRouteResponse(ctx, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      sessionId: 's1',
      title: 'Fixture',
      cwd: '/workspace',
      messages: [
        {
          seq: 1, role: 'user', time: 1000, text: 'look', child: null,
          images: [{ attachmentId: 'img-1', mediaType: 'image/jpeg', name: 'shot.png', data: 'AAAA' }],
        },
        { seq: 2, role: 'assistant', time: 2000, text: 'seen', images: [], child: null },
      ],
    })
    expect(observeSession).toHaveBeenCalledWith('s1', expect.objectContaining({ projectionMode: 'none' }))
    expect(observeSession.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
    expect(readImage).toHaveBeenCalledWith(
      { attachmentId: 'img-1', mediaType: 'image/png' },
      expect.any(AbortSignal),
    )
    expect(observed.dispose).toHaveBeenCalledOnce()
  })

  it('drops images it cannot read instead of failing the share', async () => {
    const readImage = vi.fn(async (ref: { readonly attachmentId: string }) => {
      if (ref.attachmentId === 'img-broken') throw new Error('attachment missing')
      if (ref.attachmentId === 'img-empty') return { data: '' }
      return { data: 'AAAA' }
    })
    const ctx = hostCtx({
      sessionQuery: {
        observeSession: async () => observationOf([userEvent(1, [
          imageBlock('img-broken'),
          imageBlock('img-empty'),
          imageBlock('img-ok'),
        ])]),
      },
      attachments: { readImage },
    })

    const response = await shareRouteResponse(ctx, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1`))

    const payload = await response.json() as { readonly messages: readonly { readonly images: readonly unknown[] }[] }
    expect(payload.messages[0]?.images).toEqual([
      { attachmentId: 'img-ok', mediaType: 'image/png', data: 'AAAA' },
    ])
    expect(readImage).toHaveBeenCalledTimes(3)
  })

  it('empties images when the deployment has no attachment store or the payload opts out', async () => {
    type ImagePayload = { readonly messages: readonly { readonly images: readonly unknown[] }[] }
    const events = [userEvent(1, [imageBlock('img-1')])]
    const bare = hostCtx({ sessionQuery: { observeSession: async () => observationOf(events) } })

    const bareResponse = await shareRouteResponse(bare, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1`))
    expect((await bareResponse.json() as ImagePayload).messages[0]?.images).toEqual([])

    const readImage = vi.fn(async () => ({ data: 'AAAA' }))
    const optedOut = hostCtx({
      sessionQuery: { observeSession: async () => observationOf(events) },
      attachments: { readImage },
    })

    const optedOutResponse = await shareRouteResponse(
      optedOut, { includeImages: false }, new Request(`http://host${SHARE_ROUTE}?sessionId=s1`))
    expect((await optedOutResponse.json() as ImagePayload).messages[0]?.images).toEqual([])
    expect(readImage).not.toHaveBeenCalled()
  })

  it('caps inlined images at the payload budget', async () => {
    const blocks = Array.from({ length: 30 }, (_value, index) => imageBlock(`img-${index}`))
    const readImage = vi.fn(async () => ({ data: 'AAAA' }))
    const ctx = hostCtx({
      sessionQuery: { observeSession: async () => observationOf([userEvent(1, blocks), userEvent(2, blocks)]) },
      attachments: { readImage },
    })

    const response = await shareRouteResponse(ctx, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1`))

    const payload = await response.json() as { readonly messages: readonly { readonly images: readonly unknown[] }[] }
    expect(payload.messages[0]?.images).toHaveLength(24)
    expect(payload.messages[1]?.images).toHaveLength(0)
    // One read per distinct attachment within the budget, and none after it is spent.
    expect(readImage).toHaveBeenCalledTimes(24)
  })

  it('appends direct child conversations when the request asks for them', async () => {
    const parent = observationOf([userText(1, 'parent question')], { title: 'Parent', cwd: '/workspace' })
    const child = observationOf([assistantText(1, 'child answer')], { title: 'Child' })
    const observeSession = vi.fn(async (sessionId: string) => sessionId === 's1' ? parent : child)
    const listChildren = vi.fn(async () => [
      { kind: 'child', id: 'child-1', label: 'Helper' },
      { kind: 'child', id: 'child-2' },
      { kind: 'sibling', id: 'child-3', label: 'Skipped' },
      { kind: 'child', label: 'No id' },
    ])
    const ctx = hostCtx({ sessionQuery: { observeSession }, subagents: { listChildren } })

    const response = await shareRouteResponse(
      ctx, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1&includeSubagents=true`))

    expect(await response.json()).toEqual({
      sessionId: 's1',
      title: 'Parent',
      cwd: '/workspace',
      messages: [
        { seq: 1, role: 'user', time: 1000, text: 'parent question', images: [], child: null },
        { seq: -1, role: 'subagent', time: 0, text: 'Helper', images: [], child: null },
        {
          seq: 1, role: 'assistant', time: 1000, text: 'child answer', images: [],
          child: { sessionId: 'child-1', title: 'Helper' },
        },
        { seq: -1, role: 'subagent', time: 0, text: 'child-2', images: [], child: null },
        { seq: 1, role: 'assistant', time: 1000, text: 'child answer', images: [], child: { sessionId: 'child-2', title: 'child-2' } },
      ],
    })
    expect(listChildren).toHaveBeenCalledWith('s1', expect.any(AbortSignal))
    expect(observeSession).toHaveBeenCalledWith('child-1', expect.objectContaining({ projectionMode: 'none' }))
    expect(parent.dispose).toHaveBeenCalledOnce()
    expect(child.dispose).toHaveBeenCalledTimes(2)
  })

  it('reads no children unless the request asks, and keeps a header when a child cannot be read', async () => {
    const listChildren = vi.fn(async () => [{ kind: 'child', id: 'child-1', label: 'Helper' }])
    const ctx = hostCtx({
      sessionQuery: {
        observeSession: async (sessionId: string) => {
          if (sessionId !== 's1') throw new Error('child conversation is not found')
          return observationOf([userText(1, 'parent')])
        },
      },
      subagents: { listChildren },
    })

    const plain = await shareRouteResponse(ctx, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1`))
    expect(plain.status).toBe(200)
    expect(await plain.json()).toMatchObject({ messages: [{ role: 'user' }] })
    expect(listChildren).not.toHaveBeenCalled()

    const withChildren = await shareRouteResponse(
      ctx, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1&includeSubagents=true`))
    expect(await withChildren.json()).toMatchObject({
      messages: [{ role: 'user' }, { role: 'subagent', text: 'Helper' }],
    })
  })

  it('reports no children when the child registry or the listing fails', async () => {
    const events = [userText(1, 'parent')]
    const withoutService = hostCtx({ sessionQuery: { observeSession: async () => observationOf(events) } })
    const noService = await shareRouteResponse(
      withoutService, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1&includeSubagents=true`))
    expect(await noService.json()).toMatchObject({ messages: [{ role: 'user' }] })

    const failingListing = hostCtx({
      sessionQuery: { observeSession: async () => observationOf(events) },
      subagents: { listChildren: async () => { throw new Error('registry offline') } },
    })
    const failed = await shareRouteResponse(
      failingListing, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1&includeSubagents=true`))
    expect(failed.status).toBe(200)
    expect(await failed.json()).toMatchObject({ messages: [{ role: 'user' }] })
  })

  it('maps a missing session to 404 and any other reader failure to 500', async () => {
    const missing = hostCtx({
      sessionQuery: { observeSession: async () => { throw new Error('Session session-9 not found') } },
    })
    const notFound = await shareRouteResponse(missing, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=session-9`))
    expect(notFound.status).toBe(404)
    expect(await notFound.text()).toBe('chat share could not read the session: Session session-9 not found')

    const broken = hostCtx({
      sessionQuery: { observeSession: async () => { throw new Error('storage offline') } },
    })
    const failure = await shareRouteResponse(broken, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1`))
    expect(failure.status).toBe(500)
    expect(await failure.text()).toBe('chat share could not read the session: storage offline')
  })

  it('reports a non-Error reader rejection with its string form', async () => {
    const ctx = hostCtx({ sessionQuery: { observeSession: async () => { throw 'unreadable' } } })

    const response = await shareRouteResponse(ctx, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1`))

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('chat share could not read the session: unreadable')
  })

  it('names the missing session reader instead of failing obscurely', async () => {
    const response = await shareRouteResponse(hostCtx(), {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1`))

    expect(response.status).toBe(500)
    expect(await response.text())
      .toBe('chat share could not read the session: session-share: the sessionQuery service is not mounted')
  })

  it('reports 499 when the request was aborted while the session was being read', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = hostCtx({
      sessionQuery: { observeSession: async () => { throw new Error('aborted') } },
    })

    const response = await shareRouteResponse(
      ctx, {}, new Request(`http://host${SHARE_ROUTE}?sessionId=s1`, { signal: controller.signal }))

    expect(response.status).toBe(499)
    expect(await response.text()).toBe('share aborted')
  })
})
