/** Session-row `...` menu contribution registry (client half). */

import type { SessionRowMenuAction, SessionRowMenuService } from './contract/slots.ts'

/**
 * Create the registry provided as `ctx.sessionRowMenu`. Registrations happen
 * at plugin-apply time; rows read `actions()` per render, so a label function
 * stays current across locale switches.
 * @returns the service handle.
 */
export function createSessionRowMenuService(): SessionRowMenuService {
  const actions: SessionRowMenuAction[] = []
  return {
    register(action) {
      actions.push(action)
      return () => {
        const index = actions.indexOf(action)
        if (index !== -1) actions.splice(index, 1)
      }
    },
    actions() {
      return [...actions].sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    },
  }
}
