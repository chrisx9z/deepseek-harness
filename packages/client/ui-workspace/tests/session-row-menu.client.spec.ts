import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  createSessionRowMenuService, type SessionRowMenuAction,
} from '../src/client/session-row-menu.ts'

const sid = (id: string) => id as SessionId

/** One contribution with the fields under test overridden. */
function action(id: string, overrides: Partial<SessionRowMenuAction> = {}): SessionRowMenuAction {
  return { id, label: id, run: vi.fn(), ...overrides }
}

describe('createSessionRowMenuService', () => {
  it('starts empty and freezes its snapshot', () => {
    const service = createSessionRowMenuService()
    const snapshot = service.getSnapshot()
    expect(snapshot).toEqual([])
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('registers a contribution and returns a disposer that removes it', () => {
    const service = createSessionRowMenuService()
    const registered = action('chat-share', { label: 'Share', order: 10 })
    const dispose = service.register(registered)

    expect(service.getSnapshot()).toEqual([registered])

    dispose()
    expect(service.getSnapshot()).toEqual([])
  })

  it('throws on a duplicate id and leaves the first registration in place', () => {
    const service = createSessionRowMenuService()
    const first = action('chat-share', { label: 'First' })
    service.register(first)

    expect(() => service.register(action('chat-share', { label: 'Second' }))).toThrow(
      'session row menu action "chat-share" is already registered',
    )
    expect(service.getSnapshot()).toEqual([first])
  })

  it('allows re-registering an id once its disposer released it', () => {
    const service = createSessionRowMenuService()
    const dispose = service.register(action('chat-share', { label: 'Old' }))
    dispose()
    const replacement = action('chat-share', { label: 'New' })
    service.register(replacement)

    expect(service.getSnapshot()).toEqual([replacement])
  })

  it('orders by explicit order, defaulting a missing one to 100, then by id', () => {
    const service = createSessionRowMenuService()
    service.register(action('late', { order: 200 }))
    service.register(action('early', { order: 10 }))
    // No order: the 100 default, and ids break the tie alphabetically.
    service.register(action('beta'))
    service.register(action('alpha'))
    service.register(action('exact', { order: 100 }))

    expect(service.getSnapshot().map(entry => entry.id)).toEqual([
      'early', 'alpha', 'beta', 'exact', 'late',
    ])
  })

  it('keeps the snapshot identity while nothing changes and replaces it on a change', () => {
    const service = createSessionRowMenuService()
    const empty = service.getSnapshot()
    expect(service.getSnapshot()).toBe(empty)

    const dispose = service.register(action('chat-share'))
    const withRow = service.getSnapshot()
    expect(withRow).not.toBe(empty)
    expect(Object.isFrozen(withRow)).toBe(true)
    // A read that changes nothing returns the very same frozen array, so the
    // browser's whole-array selector settles instead of re-rendering.
    expect(service.getSnapshot()).toBe(withRow)

    dispose()
    const afterDispose = service.getSnapshot()
    expect(afterDispose).not.toBe(withRow)
    expect(afterDispose).toEqual([])
  })

  it('does not mutate a previously handed-out snapshot', () => {
    const service = createSessionRowMenuService()
    const before = service.getSnapshot()
    service.register(action('chat-share'))
    expect(before).toEqual([])
  })

  it('notifies every subscriber on register and on dispose, and stops after unsubscribe', () => {
    const service = createSessionRowMenuService()
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = service.subscribe(first)
    service.subscribe(second)

    expect(first).not.toHaveBeenCalled()
    const dispose = service.register(action('chat-share'))
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()

    dispose()
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)

    unsubscribeFirst()
    service.register(action('chat-share-save-txt'))
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(3)
  })

  it('ignores a repeated dispose and leaves later registrations alone', () => {
    const service = createSessionRowMenuService()
    const dispose = service.register(action('chat-share'))
    dispose()

    const listener = vi.fn()
    service.subscribe(listener)
    dispose()
    dispose()
    expect(listener).not.toHaveBeenCalled()
    expect(service.getSnapshot()).toEqual([])

    const kept = action('chat-share-save-txt')
    service.register(kept)
    // The stale disposer belongs to the released id only: it cannot remove the
    // contribution that took a different id afterwards.
    dispose()
    expect(service.getSnapshot()).toEqual([kept])
  })

  it('runs the contribution for the Session id handed in', async () => {
    const service = createSessionRowMenuService()
    const run = vi.fn()
    service.register(action('chat-share', { run }))

    await service.getSnapshot()[0]!.run(sid('session-one'))
    expect(run).toHaveBeenCalledWith(sid('session-one'))
  })
})
