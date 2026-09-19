import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-session-share',
  ['lib/types/index.js'],
  { hostPhase: true },
)
