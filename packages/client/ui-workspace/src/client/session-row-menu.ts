/**
 * Contribution registry for extra Session row-menu actions.
 *
 * The browsing region owns the Session row menu and its three core verbs
 * (rename, fork, archive). A feature package — chat-segment share, for
 * example — contributes further rows through this service: it registers one
 * action per row and the browser appends them after the core verbs, in
 * `order` sequence. Registrations are fiber-scoped by their registrant, and
 * the snapshot identity only changes when the set does, so the menu's
 * selector hook settles on real changes.
 * @module
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReactNode } from 'react'

/** Default sort key for a contribution that does not name one. */
const DEFAULT_ORDER = 100

/** One contributed Session row-menu action. */
export interface SessionRowMenuAction {
  /** Stable identity; registering the same id twice is an error. */
  readonly id: string
  /** Menu label; a function is read on every render so it follows the UI locale. */
  readonly label: string | (() => string)
  /** Optional menu glyph, rendered in the menu's 16px icon slot. */
  readonly icon?: ReactNode
  /** Sort key among contributions; lower comes first. @default 100 */
  readonly order?: number
  /** Run the action for one Session; the menu has already closed when it runs. */
  readonly run: (sessionId: SessionId) => void | Promise<void>
}

/** Read-side surface of the registry, as the browsing region consumes it. */
export type SessionRowMenuView = HostObservable<readonly SessionRowMenuAction[]>

/** The registry a feature package writes to. */
export interface SessionRowMenuService extends SessionRowMenuView {
  /**
   * Add one row contribution.
   * @param action - the action, its label, and its ordering.
   * @returns the disposer removing the contribution.
   * @throws when the same id is already registered.
   */
  register(action: SessionRowMenuAction): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session row-menu contributions owned by their registrant's fiber. */
    sessionRowMenu: SessionRowMenuService
  }
}

/** Stable ordering: explicit keys first, then id, so equal keys never shuffle. */
function byOrder(left: SessionRowMenuAction, right: SessionRowMenuAction): number {
  const delta = (left.order ?? DEFAULT_ORDER) - (right.order ?? DEFAULT_ORDER)
  return delta !== 0 ? delta : left.id.localeCompare(right.id)
}

/**
 * Create an empty Session row-menu registry.
 * @returns the service the browsing region provides and features register on.
 */
export function createSessionRowMenuService(): SessionRowMenuService {
  const registrations = new Map<string, SessionRowMenuAction>()
  const listeners = new Set<() => void>()
  let snapshot: readonly SessionRowMenuAction[] = Object.freeze([])

  const publish = (): void => {
    snapshot = Object.freeze([...registrations.values()].sort(byOrder))
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    register: (action) => {
      if (registrations.has(action.id)) {
        throw new Error(`session row menu action ${JSON.stringify(action.id)} is already registered`)
      }
      registrations.set(action.id, action)
      publish()
      let active = true
      return () => {
        if (!active) return
        active = false
        registrations.delete(action.id)
        publish()
      }
    },
  }
}
