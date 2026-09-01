import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { chatShareRowMenuAction, chatShareSaveTxtMenuAction } from '../src/client/row-menu.ts'

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

describe('chatShareSaveTxtMenuAction', () => {
  it('carries the stable id, label accessor, and icon', () => {
    const saveTxt = vi.fn(async () => {})
    const action = chatShareSaveTxtMenuAction(saveTxt, () => 'Save TXT')

    expect(action.id).toBe('chat-share-save-txt')
    expect(action.order).toBe(20)
    expect((action.label as () => string)()).toBe('Save TXT')
    expect(action.icon).not.toBeNull()
  })

  it('saves the row session chat as plain text', () => {
    const saveTxt = vi.fn(async () => {})
    const action = chatShareSaveTxtMenuAction(saveTxt, () => 'Save TXT')

    action.run(String(SID))

    expect(saveTxt).toHaveBeenCalledWith(SID)
  })
})
