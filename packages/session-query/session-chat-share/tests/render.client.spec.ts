import { describe, expect, it } from 'vitest'
import type { ShareMessage } from '../src/client/controller.ts'
import {
  escapeHtml, formatShareTime, redactSensitive, renderGfmHtml, renderShareHtml, renderShareMarkdown, renderShareTxt,
  shareFileName, type ShareLabels,
} from '../src/client/render.ts'

const MESSAGES: ShareMessage[] = [
  { seq: 1, role: 'user', text: 'What is 2 + 2?', time: 1_700_000_000_000 },
  { seq: 2, role: 'assistant', text: '```js\nconst answer = 4\n```\n\nIt is **four**.', time: 1_700_000_060_000 },
]

const ZH: ShareLabels = {
  user: '用户', assistant: '助手', tool: '工具', subagent: '子代理', sharedFrom: '分享自 DeepSeek Harness',
}

describe('renderShareMarkdown', () => {
  it('emits role headers, timestamps, and verbatim text', () => {
    const markdown = renderShareMarkdown(MESSAGES)
    expect(markdown).toContain('Shared from DeepSeek Harness')
    expect(markdown).toContain('**User** · ')
    expect(markdown).toContain('**Assistant** · ')
    expect(markdown).toContain('What is 2 + 2?')
    expect(markdown).toContain('```js\nconst answer = 4\n```')
    expect(markdown.endsWith('\n')).toBe(true)
  })

  it('honors localized labels and the artifact header meta', () => {
    const markdown = renderShareMarkdown(MESSAGES, {
      labels: ZH,
      meta: { title: 'My session', model: 'deepseek/deepseek-chat' },
    })
    expect(markdown.startsWith('# My session')).toBe(true)
    expect(markdown).toContain('Model: deepseek/deepseek-chat')
    expect(markdown).toContain('**用户** · ')
    expect(markdown).toContain('分享自 DeepSeek Harness')
  })
})

describe('renderShareTxt', () => {
  it('emits plain-text role headers, timestamps, and verbatim text', () => {
    const text = renderShareTxt(MESSAGES)
    expect(text.startsWith('Shared from DeepSeek Harness')).toBe(true)
    expect(text).toContain('User · ')
    expect(text).toContain('Assistant · ')
    expect(text).toContain('What is 2 + 2?')
    expect(text).toContain('```js\nconst answer = 4\n```')
    expect(text).not.toContain('**User**')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('drops the markdown heading marker from the title line', () => {
    const text = renderShareTxt(MESSAGES, { meta: { title: 'My session' } })
    expect(text.startsWith('My session\n')).toBe(true)
    expect(text.startsWith('# My session')).toBe(false)
  })
})

describe('escapeHtml and renderGfmHtml', () => {
  it('escapes markup and preserves fenced code blocks with language classes', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;')
    const html = renderGfmHtml('before\n\n```ts\nconst x: string = "<a>"\n```\n\nafter')
    expect(html).toContain('<p>before</p>')
    expect(html).toContain('<pre><code class="language-ts">const x: string = &quot;&lt;a&gt;&quot;</code></pre>')
    expect(html).toContain('<p>after</p>')
  })

  it('renders paragraphs, line breaks, headings, lists, blockquotes, and tables', () => {
    const html = renderGfmHtml([
      'one\ntwo',
      '',
      '## Heading',
      '',
      '- first',
      '- second',
      '',
      '1. one',
      '2. two',
      '',
      '> quoted',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'))
    expect(html).toContain('<p>one<br />two</p>')
    expect(html).toContain('<h2>Heading</h2>')
    expect(html).toContain('<ul><li>first</li><li>second</li></ul>')
    expect(html).toContain('<ol><li>one</li><li>two</li></ol>')
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>')
    expect(html).toContain('<table><thead><tr><th>a</th><th>b</th></tr></thead>')
    expect(html).toContain('<tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
  })

  it('renders inline code, bold, italic, and links without hotlinking images', () => {
    const html = renderGfmHtml('Run `npm test` with **care** and *focus*: [docs](https://example.com) ![alt](https://x/y.png)')
    expect(html).toContain('<code>npm test</code>')
    expect(html).toContain('<strong>care</strong>')
    expect(html).toContain('<em>focus</em>')
    expect(html).toContain('<a href="https://example.com" rel="noreferrer">docs</a>')
    expect(html).not.toContain('https://x/y.png')
    expect(html).toContain('[alt]')
  })

  it('treats an unterminated fence as a code block to the end of the text', () => {
    const html = renderGfmHtml('```js\nconst x = 1')
    expect(html).toContain('<pre><code class="language-js">const x = 1</code></pre>')
  })

  it('keeps a language-less fence bare and caps every heading level', () => {
    const bare = renderGfmHtml('```\nplain\n```')
    expect(bare).toContain('<pre><code>plain</code></pre>')
    expect(bare).not.toContain('class="language-')

    const headings = renderGfmHtml([
      '# one', '## two', '### three', '#### four', '##### five', '###### six',
    ].join('\n\n'))
    expect(headings).toContain('<h1>one</h1>')
    expect(headings).toContain('<h2>two</h2>')
    expect(headings).toContain('<h3>three</h3>')
    expect(headings).toContain('<h4>four</h4>')
    expect(headings).toContain('<h5>five</h5>')
    expect(headings).toContain('<h6>six</h6>')
  })

  it('keeps inline code that looks like a substitution token verbatim', () => {
    const html = renderGfmHtml('value `\u00009\u0000` stays')

    expect(html).toContain('<code>\u00009\u0000</code>')
  })
})

describe('renderShareHtml', () => {
  it('produces a self-contained page with role headers, code blocks, and meta', () => {
    const html = renderShareHtml(MESSAGES, {
      meta: { title: 'My session', model: 'deepseek/deepseek-chat' },
    })
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('<title>Chat segment</title>')
    expect(html).toContain('<h1>My session</h1>')
    expect(html).toContain('Model: deepseek/deepseek-chat')
    expect(html).toContain('<p class="meta">Shared from DeepSeek Harness</p>')
    expect(html).toContain('>User · ')
    expect(html).toContain('>Assistant · ')
    expect(html).toContain('<pre><code class="language-js">const answer = 4</code></pre>')
    expect(html).toContain('<strong>four</strong>')
  })

  it('embeds resolved images as data URIs and keeps markers for missing ones', () => {
    const withImage: ShareMessage[] = [
      {
        seq: 1, role: 'user', text: 'look', time: 1,
        images: [{ attachmentId: 'img-1', mediaType: 'image/png', name: 'shot.png', data: 'AAAA' }],
      },
    ]
    const missing: ShareMessage[] = [
      {
        seq: 2, role: 'user', text: '', time: 2,
        images: [{ attachmentId: 'img-2', mediaType: 'image/png', name: 'gone.png', data: null }],
      },
    ]
    const embedded = renderShareHtml(withImage, {
      images: new Map([['img-1', 'data:image/png;base64,AAAA']]),
    })
    expect(embedded).toContain('<img src="data:image/png;base64,AAAA" alt="shot.png"')
    expect(embedded).not.toContain('[image]')
    const placeholder = renderShareHtml(missing)
    expect(placeholder).toContain('[gone.png]')
  })

  it('honors localized labels', () => {
    const html = renderShareHtml(MESSAGES, { labels: ZH })
    expect(html).toContain('>用户 · ')
    expect(html).toContain('分享自 DeepSeek Harness')
  })

  it('names an anonymous unresolved image with the shared-from label', () => {
    const anonymous: ShareMessage[] = [
      {
        seq: 1, role: 'user', text: '', time: 1,
        images: [{ attachmentId: 'img-1', mediaType: 'image/png', data: null }],
      },
    ]

    expect(renderShareHtml(anonymous)).toContain('[Shared from DeepSeek Harness]')
  })
})

describe('redactSensitive', () => {
  it('masks credential shapes and local absolute/home paths', () => {
    expect(redactSensitive('key sk-abcdefghijklmnopqrstuvwxyz123456 end')).toContain('[key]')
    expect(redactSensitive('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij').startsWith('[key]')).toBe(true)
    expect(redactSensitive('at C:\\Users\\ADMIN\\Documents\\code.ts and /Users/bob/projects/a and ~/notes.txt'))
      .toContain('[path]')
    expect(redactSensitive('at ~/notes.txt')).toBe('at [path]')
    expect(redactSensitive('~5 minutes')).toBe('~5 minutes')
    expect(redactSensitive('plain text')).toBe('plain text')
  })
})

describe('formatShareTime and shareFileName', () => {
  it('formats a fixed timestamp deterministically enough to embed', () => {
    expect(formatShareTime(1_700_000_000_000)).not.toBe('')
  })

  it('sanitizes the session id into the filename', () => {
    expect(shareFileName('a/b:c', 0, 2, 'markdown')).toBe('dsh-session-chat-share-a_b_c-1-3.md')
    expect(shareFileName('a', 3, 3, 'html')).toBe('dsh-session-chat-share-a-4-4.html')
    expect(shareFileName('a', 3, 3, 'txt')).toBe('dsh-session-chat-share-a-4-4.txt')
  })
})
