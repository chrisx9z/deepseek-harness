import { describe, expect, it, vi } from 'vitest'
import { createSessionRowMenuService } from '../src/client/session-row-menu.ts'

describe('sessionRowMenu registry', () => {
  it('lists registered actions in order and disposes them', () => {
    const service = createSessionRowMenuService()
    const first = { id: 'a', label: 'A', order: 2, run: vi.fn() }
    const second = { id: 'b', label: 'B', order: 1, run: vi.fn() }

    const disposeFirst = service.register(first)
    service.register(second)

    expect(service.actions().map(action => action.id)).toEqual(['b', 'a'])
    disposeFirst()
    expect(service.actions().map(action => action.id)).toEqual(['b'])
  })

  it('defaults unset orders to zero and tolerates duplicate disposal', () => {
    const service = createSessionRowMenuService()
    const plain = { id: 'p', label: 'P', run: vi.fn() }
    const dispose = service.register(plain)

    expect(service.actions()).toEqual([plain])
    dispose()
    dispose()
    expect(service.actions()).toEqual([])
  })
})
