import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { chatShareRowMenuAction } from '../src/client/row-menu.ts'

const SID = 'session-chat-share-row-menu' as SessionId

describe('chatShareRowMenuAction', () => {
  it('carries the stable id, label accessor, and icon', () => {
    const open = vi.fn(async () => {})
    const action = chatShareRowMenuAction(open, () => 'Share')

    expect(action.id).toBe('chat-share')
    expect(action.order).toBe(10)
    expect(typeof action.label).toBe('function')
    expect((action.label as () => string)()).toBe('Share')
    expect(action.icon).not.toBeNull()
  })

  it('opens the share dialog for the row session', () => {
    const open = vi.fn(async () => {})
    const action = chatShareRowMenuAction(open, () => 'Share')

    action.run(String(SID))

    expect(open).toHaveBeenCalledWith(SID)
  })
})
