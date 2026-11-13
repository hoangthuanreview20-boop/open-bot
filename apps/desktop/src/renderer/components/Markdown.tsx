import { useMemo } from 'react';
import { highlightCode, parseMarkdown, type MdBlock, type MdInline } from './markdownParser';

/**
 * Renders an assistant message as Markdown (UI-1, v0.59).
 *
 * Safety comes from construction, not from a sanitizer pass: the AST
 * from markdownParser.ts only ever carries plain strings, and every string
 * lands in a React text node or a vetted attribute (`href`/`src` already
 * restricted to safe schemes by the parser). There is no raw-HTML
 * injection in this file or anywhere in the renderer.
 */

function InlineNodes({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.kind) {
          case 'text':
            return <span key={i}>{node.text}</span>;
          case 'strong':
            return (
              <strong key={i}>
                <InlineNodes nodes={node.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <InlineNodes nodes={node.children} />
              </em>
            );
          case 'del':
            return (
              <del key={i}>
                <InlineNodes nodes={node.children} />
              </del>
            );
          case 'code':
            return (
              <code key={i} className="md-inline-code">
                {node.text}
              </code>
            );
          case 'br':
            return <br key={i} />;
          case 'link':
            return (
              <a
                key={i}
                href={node.href}
                target="_blank"
                rel="noreferrer noopener"
                title={node.title ?? undefined}
              >
                <InlineNodes nodes={node.children} />
              </a>
            );
          case 'image':
            return <img key={i} src={node.src} alt={node.alt} loading="lazy" className="md-img" />;
          default:
            return null;
        }
      })}
    </>
  );
}

function BlockNodes({ blocks }: { blocks: MdBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </>
  );
}

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case 'heading': {
      const cls = block.depth === 1 ? 'md-h1' : block.depth === 2 ? 'md-h2' : 'md-h3';
      if (block.depth === 1) {
        return (
          <h3 className={cls}>
            <InlineNodes nodes={block.children} />
          </h3>
        );
      }
      if (block.depth === 2) {
        return (
          <h4 className={cls}>
            <InlineNodes nodes={block.children} />
          </h4>
        );
      }
      return (
        <h5 className={cls}>
          <InlineNodes nodes={block.children} />
        </h5>
      );
    }
    case 'paragraph':
      return (
        <p className="md-p">
          <InlineNodes nodes={block.children} />
        </p>
      );
    case 'code': {
      const spans = highlightCode(block.text);
      return (
        <div className="md-code">
          <div className="md-code-head">{block.lang || 'code'}</div>
          <pre>
            <code>
              {spans.map((span, i) =>
                span.cls ? (
                  <span key={i} className={`tok-${span.cls}`}>
                    {span.text}
                  </span>
                ) : (
                  <span key={i}>{span.text}</span>
                ),
              )}
            </code>
          </pre>
        </div>
      );
    }
    case 'list': {
      const items = block.items.map((itemBlocks, i) => (
        <li key={i}>
          {itemBlocks.length === 1 && itemBlocks[0].kind === 'paragraph' ? (
            <InlineNodes nodes={itemBlocks[0].children} />
          ) : (
            <BlockNodes blocks={itemBlocks} />
          )}
        </li>
      ));
      return block.ordered ? (
        <ol className="md-list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="md-list">{items}</ul>
      );
    }
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                    <InlineNodes nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ textAlign: block.align[c] ?? undefined }}>
                      <InlineNodes nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'blockquote':
      return (
        <blockquote className="md-quote">
          <BlockNodes blocks={block.children} />
        </blockquote>
      );
    case 'hr':
      return <hr className="md-hr" />;
    default:
      return null;
  }
}

export default function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return null;
  return (
    <div className="md">
      <BlockNodes blocks={blocks} />
    </div>
  );
}
