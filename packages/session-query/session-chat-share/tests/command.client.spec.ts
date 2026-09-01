import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import * as SessionChatShare from '../src/index.ts'
import { parseShareInvocation } from '../src/index.ts'

describe('/share Web dialog command', () => {
  it('registers one command and removes it with the plugin fiber', async () => {
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
      description: 'Share a segment of this chat as Markdown, HTML, or plain text',
    })

    await fiber.dispose()
    expect(descriptor).toBeUndefined()
  })
})

describe('parseShareInvocation', () => {
  it('opens the dialog by default and rejects unknown tokens', () => {
    expect(parseShareInvocation('')).toEqual({ kind: 'success', text: 'share' })
    expect(parseShareInvocation('  ')).toEqual({ kind: 'success', text: 'share' })
    expect(parseShareInvocation('output.md').kind).toBe('error')
  })

  it('accepts txt and last <n> in any order', () => {
    expect(parseShareInvocation('txt')).toEqual({ kind: 'success', text: 'share:txt' })
    expect(parseShareInvocation('last 10')).toEqual({ kind: 'success', text: 'share:txt:10' })
    expect(parseShareInvocation('txt last 5')).toEqual({ kind: 'success', text: 'share:txt:5' })
    expect(parseShareInvocation('last 5 txt')).toEqual({ kind: 'success', text: 'share:txt:5' })
  })

  it('rejects a missing or non-positive count', () => {
    expect(parseShareInvocation('last').kind).toBe('error')
    expect(parseShareInvocation('last 0').kind).toBe('error')
    expect(parseShareInvocation('last -3').kind).toBe('error')
    expect(parseShareInvocation('last 2.5').kind).toBe('error')
  })

  it('executes through the registered handler', async () => {
    let descriptor: CommandDefinition | undefined
    const ctx = new Context()
    ctx.provide('commands', {
      register(next: CommandDefinition) {
        descriptor = next
        return () => { descriptor = undefined }
      },
    } as never)
    await ctx.plugin(SessionChatShare)
    const invoke = (rawInput: string) => descriptor?.handler({ rawInput } as CommandInvocation)
    await expect(invoke('txt')).resolves.toEqual({ kind: 'success', text: 'share:txt' })
    await expect(invoke('last 3')).resolves.toEqual({ kind: 'success', text: 'share:txt:3' })
    await expect(invoke('')).resolves.toEqual({ kind: 'success', text: 'share' })
  })
})
