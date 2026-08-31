import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import * as SessionChatShare from '../src/index.ts'

describe('/share Web dialog command', () => {
  it('registers one pathless command and removes it with the plugin fiber', async () => {
    let descriptor: CommandDefinition | undefined
    const ctx = new Context()
    ctx.provide('commands', {
      register(next: CommandDefinition) {
        descriptor = next
        return () => { descriptor = undefined }
      },
    } as never)
    const fiber = await ctx.plugin(SessionChatShare)

    expect(descriptor).toMatchObject({
      name: 'share',
      description: 'Share a segment of this chat as Markdown or HTML',
    })
    const invoke = (rawInput: string) => descriptor?.handler({ rawInput } as CommandInvocation)
    await expect(invoke('')).resolves.toEqual({
      kind: 'success', text: 'Chat segment share dialog requested.',
    })
    await expect(invoke(' 5')).resolves.toEqual({
      kind: 'error', text: 'The Web /share command opens the share dialog and does not accept arguments.',
    })

    await fiber.dispose()
    expect(descriptor).toBeUndefined()
  })
})
