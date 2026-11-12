// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Markdown, parseMarkdown } from './markdown.js';

let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(async () => {
  if (root) {
    const node = root;
    await act(async () => node.unmount());
    root = null;
  }
});

async function render(text: string, emptyLabel?: string): Promise<HTMLElement> {
  const container = document.getElementById('root') as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root?.render(<Markdown text={text} {...(emptyLabel ? { emptyLabel } : {})} />);
  });
  return container;
}

describe('safe Markdown', () => {
  it('renders fenced code with its language label and exact content', async () => {
    const container = await render('Before\n\n```ts\nconst value = 1 < 2;\n```\n\nAfter');
    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe('const value = 1 < 2;');
    expect(container.querySelector('figcaption')?.textContent).toBe('ts');
    expect(container.textContent).toContain('Before');
    expect(container.textContent).toContain('After');
  });

  it('never interprets raw HTML from model output', async () => {
    const container = await render('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain('<script>alert(2)</script>');
  });

  it('renders links as inert text instead of anchors', async () => {
    const container = await render('Read [the docs](https://example.com/help) for detail.');
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
    expect(container.textContent).toContain('the docs');
    expect(container.textContent).toContain('https://example.com/help');
  });

  it('cannot produce a javascript: link', async () => {
    const container = await render('[click](javascript:alert(1))');
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
  });

  it('supports inline code, bold and italic without HTML', async () => {
    const container = await render('Use `mona:studio-get` and **never** *guess*.');
    expect(container.querySelector('code')?.textContent).toBe('mona:studio-get');
    expect(container.querySelector('strong')?.textContent).toBe('never');
    expect(container.querySelector('em')?.textContent).toBe('guess');
  });

  it('renders ordered and unordered lists as real lists', async () => {
    const container = await render('- one\n- two\n\n1. first\n2. second');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('reports an empty body instead of inventing content', async () => {
    const container = await render('', 'No output was reported.');
    expect(container.textContent).toBe('No output was reported.');
  });

  it('parses a large body without dropping or reordering it', () => {
    const paragraph = 'Model output '.repeat(2_000);
    const blocks = parseMarkdown(`${paragraph}\n\n## Summary\n\n- a\n- b`);
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'heading', 'list']);
    const first = blocks[0];
    expect(first?.kind === 'paragraph' ? first.lines.join('\n') : '').toBe(paragraph);
  });
});
