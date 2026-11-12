import type { ReactNode } from 'react';

/**
 * A deliberately small Markdown renderer for model output.
 *
 * It never trusts the text: every block and every inline run is escaped by
 * React (text nodes only), raw HTML is not interpreted, and links are rendered
 * as inert text plus the address rather than as anchors. There is no `href`, so
 * model output cannot navigate the app, open a privileged page, or invoke IPC.
 */

export type MarkdownProps = {
  text: string;
  /** Shown when the text is empty; never invented content. */
  emptyLabel?: string;
};

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'rule' };

const FENCE = /^\s*```([A-Za-z0-9_+#.-]{0,24})\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    const fence = FENCE.exec(line);
    if (fence) {
      const language = fence[1] ?? '';
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', language, code: code.join('\n') });
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? '')) {
        quote.push(QUOTE.exec(lines[index] ?? '')?.[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: quote });
      continue;
    }

    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      const ordered = OL_ITEM.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = ordered ? OL_ITEM.exec(current) : UL_ITEM.exec(current);
        if (!match) break;
        items.push(match[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        !current.trim() ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        RULE.test(current) ||
        QUOTE.test(current) ||
        UL_ITEM.test(current) ||
        OL_ITEM.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }
  return blocks;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]*\]\([^)\s]*\))|(<https?:\/\/[^>\s]+>)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  let index = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${index}`;
    index += 1;
    if (token.startsWith('`')) {
      nodes.push(
        <code className="mona-md-code" key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const close = token.indexOf('](');
      const label = token.slice(1, close);
      const target = token.slice(close + 2, -1);
      nodes.push(
        <span className="mona-md-link" key={key}>
          {label} <span className="mona-md-url">({target})</span>
        </span>,
      );
    } else if (token.startsWith('<')) {
      nodes.push(
        <span className="mona-md-url" key={key}>
          {token.slice(1, -1)}
        </span>,
      );
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function Markdown({ text, emptyLabel }: MarkdownProps): React.JSX.Element {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) {
    return <p className="mona-muted">{emptyLabel ?? 'No content was reported.'}</p>;
  }
  return (
    <div className="mona-markdown">
      {blocks.map((block, position) => {
        const key = `b${position}`;
        switch (block.kind) {
          case 'code':
            return (
              <figure className="mona-md-codeblock" key={key}>
                <figcaption>{block.language ? block.language : 'code'}</figcaption>
                <pre>
                  <code>{block.code}</code>
                </pre>
              </figure>
            );
          case 'heading': {
            const Tag = block.level <= 2 ? 'h3' : 'h4';
            return <Tag key={key}>{inline(block.text, key)}</Tag>;
          }
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-l${itemIndex}`}>{inline(item, `${key}-l${itemIndex}`)}</li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return <blockquote key={key}>{inline(block.lines.join('\n'), key)}</blockquote>;
          case 'rule':
            return <hr key={key} />;
          case 'paragraph':
          default:
            return <p key={key}>{inline(block.lines.join('\n'), key)}</p>;
        }
      })}
    </div>
  );
}
