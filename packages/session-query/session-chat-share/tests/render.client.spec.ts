import { describe, expect, it } from 'vitest'
import type { ShareMessage } from '../src/client/controller.ts'
import {
  escapeHtml, formatShareTime, renderRichText, renderShareHtml, renderShareMarkdown, shareFileName,
} from '../src/client/render.ts'

const MESSAGES: ShareMessage[] = [
  { seq: 1, role: 'user', text: 'What is 2 + 2?', time: 1_700_000_000_000 },
  { seq: 2, role: 'assistant', text: '```js\nconst answer = 4\n```\n\nIt is **four**.', time: 1_700_000_060_000 },
]

describe('renderShareMarkdown', () => {
  it('emits role headers, timestamps, and verbatim text', () => {
    const markdown = renderShareMarkdown(MESSAGES)
    expect(markdown).toContain('> Shared from DeepSeek Harness')
    expect(markdown).toContain('**User** · ')
    expect(markdown).toContain('**Assistant** · ')
    expect(markdown).toContain('What is 2 + 2?')
    expect(markdown).toContain('```js\nconst answer = 4\n```')
    expect(markdown.endsWith('\n')).toBe(true)
  })
})

describe('escapeHtml and renderRichText', () => {
  it('escapes markup and preserves fenced code blocks', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;')
    const html = renderRichText('before\n\n```ts\nconst x: string = "<a>"\n```\n\nafter')
    expect(html).toContain('<p>before</p>')
    expect(html).toContain('<pre><code>const x: string = &quot;&lt;a&gt;&quot;</code></pre>')
    expect(html).toContain('<p>after</p>')
  })

  it('renders paragraphs and line breaks for plain text', () => {
    const html = renderRichText('one\ntwo\n\nthree')
    expect(html).toContain('<p>one<br />two</p>')
    expect(html).toContain('<p>three</p>')
  })

  it('treats an unterminated fence as plain text', () => {
    const html = renderRichText('```js\nconst x = 1')
    expect(html).toContain('<p>```js<br />const x = 1</p>')
  })
})

describe('renderShareHtml', () => {
  it('produces a self-contained page with role headers and code blocks', () => {
    const html = renderShareHtml(MESSAGES)
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('<title>Chat segment</title>')
    expect(html).toContain('<p class="meta">Shared from DeepSeek Harness</p>')
    expect(html).toContain('>User · ')
    expect(html).toContain('>Assistant · ')
    expect(html).toContain('<pre><code>const answer = 4</code></pre>')
    expect(html).toContain('It is **four**.')
  })
})

describe('formatShareTime and shareFileName', () => {
  it('formats a fixed timestamp deterministically enough to embed', () => {
    expect(formatShareTime(1_700_000_000_000)).not.toBe('')
  })

  it('sanitizes the session id into the filename', () => {
    expect(shareFileName('a/b:c', 0, 2, 'markdown')).toBe('dsh-chat-share-a_b_c-1-3.md')
    expect(shareFileName('a', 3, 3, 'html')).toBe('dsh-chat-share-a-4-4.html')
  })
})
