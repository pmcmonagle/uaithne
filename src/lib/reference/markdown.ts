// Renders reference markdown. Raw HTML is shown as text, not run, and each
// code block gets Try / Insert buttons that name it by index into the
// returned `code` list.

import { Marked } from 'marked';

import type { RefEntry } from './index.svelte';

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function codeBlockHtml(code: string, index: number, playing: boolean) {
  const play = playing
    ? `<button class="stop" data-stop="${index}" title="Stop this example">■ Stop</button>`
    : `<button data-try="${index}" title="Play this in its engine">Try</button>`;
  return (
    `<div class="example${playing ? ' playing' : ''}"><pre><code>${escape(code)}</code></pre>` +
    `<div class="example-actions">${play}<button data-insert="${index}" title="Insert at the cursor">Insert</button></div></div>`
  );
}

/**
 * The entry's description and examples as HTML, and the code of each block.
 * The block at `playing` (if any) gets a Stop button in place of Try.
 */
export function entryHtml(entry: RefEntry, playing: number | null = null): { html: string; code: string[] } {
  const code: string[] = [];
  const block = (text: string) => {
    code.push(text.trimEnd());
    return codeBlockHtml(text.trimEnd(), code.length - 1, code.length - 1 === playing);
  };
  const marked = new Marked({
    gfm: true,
    renderer: {
      code: ({ text }) => block(text),
      html: ({ text }) => escape(text),
      // Links point at pages of the original docs; show them as text.
      link({ tokens }) {
        return this.parser.parseInline(tokens);
      },
      image: ({ text }) => escape(text),
    },
  });
  const description = entry.description ? (marked.parse(entry.description, { async: false }) as string) : '';
  return { html: description + entry.examples.map(block).join(''), code };
}
