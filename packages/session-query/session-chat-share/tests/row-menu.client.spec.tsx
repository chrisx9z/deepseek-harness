// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { IconDownloadOutline16, IconShareOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { chatShareRowMenuActions, type ChatShareMenuLabels } from '../src/client/row-menu.tsx'

afterEach(cleanup)

const sid = (id: string) => id as SessionId

/** Render one node and return its serialized output (icon identity comparison). */
function html(node: ReactNode): string {
  return render(<>{node}</>).container.innerHTML
}

describe('chatShareRowMenuActions', () => {
  it('builds the two contributions with their ids, order, icons, and live label readers', () => {
    const labels = { share: 'Share chat', saveTxt: 'Save as TXT' }
    const read = vi.fn(() => labels)
    const actions = chatShareRowMenuActions(vi.fn(), vi.fn(), read)

    expect(actions.map(action => action.id)).toEqual(['chat-share', 'chat-share-save-txt'])
    expect(actions.map(action => action.order)).toEqual([10, 20])
    // Every label is a thunk: the browser re-reads it on each render so the row
    // follows a locale switch without re-registering.
    expect(actions.map(action => typeof action.label)).toEqual(['function', 'function'])
    expect((actions[0]!.label as () => string)()).toBe('Share chat')
    expect((actions[1]!.label as () => string)()).toBe('Save as TXT')
    expect(read).toHaveBeenCalledTimes(2)

    // The reader is consulted per label read, never cached at build time.
    labels.share = '分享会话'
    labels.saveTxt = '保存 TXT'
    expect((actions[0]!.label as () => string)()).toBe('分享会话')
    expect((actions[1]!.label as () => string)()).toBe('保存 TXT')
  })

  it('renders the share and download icons in the contributions', () => {
    const actions = chatShareRowMenuActions(vi.fn(), vi.fn(), () => ({ share: 's', saveTxt: 't' }))

    expect(html(actions[0]!.icon)).toBe(html(<IconShareOutline16 size={16} />))
    expect(html(actions[1]!.icon)).toBe(html(<IconDownloadOutline16 size={16} />))
    // Distinct glyphs: the two rows are visually distinguishable.
    expect(html(actions[0]!.icon)).not.toBe(html(actions[1]!.icon))
  })

  it('delegates run to open and saveTxt with the Session id, without a dialog decision of its own', async () => {
    const open = vi.fn()
    const saveTxt = vi.fn()
    const actions = chatShareRowMenuActions(open, saveTxt, () => ({ share: 's', saveTxt: 't' }))
    const sessionId = sid('session-chat-share-row-menu')

    await actions[0]!.run(sessionId)
    expect(open).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(saveTxt).not.toHaveBeenCalled()

    await actions[1]!.run(sessionId)
    expect(saveTxt).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(open).toHaveBeenCalledOnce()

    // A different Session id travels unchanged to each action.
    await actions[0]!.run(sid('other-session'))
    expect(open).toHaveBeenLastCalledWith(sid('other-session'))
  })

  it('reads the labels object the caller supplied at call time', () => {
    let labels: ChatShareMenuLabels = { share: 'First', saveTxt: 'First txt' }
    const actions = chatShareRowMenuActions(vi.fn(), vi.fn(), () => labels)
    expect((actions[0]!.label as () => string)()).toBe('First')
    labels = { share: 'Second', saveTxt: 'Second txt' }
    expect((actions[0]!.label as () => string)()).toBe('Second')
    expect((actions[1]!.label as () => string)()).toBe('Second txt')
  })
})
