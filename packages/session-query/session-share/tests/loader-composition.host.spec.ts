import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionChatShare from '@deepseek-ai/dsh-session-share'

/** One browser transport registration as the connection double captures it. */
interface CapturedRoute {
  readonly path: string
  readonly methods: readonly string[]
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('session-share real Loader composition', () => {
  it('discovers and executes /share through the assembled command plane', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-session-share-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@deepseek-ai/dsh-session-share'",
      '',
    ].join('\n'))

    const routes: CapturedRoute[] = []
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    context.provide('connection', {
      fetch: {
        register(route: CapturedRoute) {
          routes.push(route)
          return () => Promise.resolve()
        },
      },
    } as never)
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@deepseek-ai/dsh-session-share', SessionChatShare],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const session = (context.get('sessions') as unknown as SessionStore)
      .create(SessionId('loader-session-share'), { meta: { createdAt: 1 } })
    const agent = { session, status: 'idle', options: {} } as unknown as Agent
    expect(context.commands.list(agent)).toContainEqual({
      name: 'share', description: 'Share a segment of this chat as Markdown, HTML, or plain text',
    })
    expect(routes.map(route => route.path)).toEqual([SessionChatShare.SHARE_ROUTE])
    expect(routes[0]?.methods).toEqual(['GET'])
    const execution = await context.commands.execute(agent, '/share', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'share' })
    const txt = await context.commands.execute(agent, '/share txt last 3', [], new AbortController().signal)
    expect(txt?.result).toEqual({ kind: 'success', text: 'share:txt:3' })
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['command/run', 'command/done', 'command/run', 'command/done'])
    expect(session.deriveMessages()).toEqual([])
  })
})
