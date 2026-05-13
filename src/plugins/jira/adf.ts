/**
 * Atlassian Document Format → plain markdown converter.
 *
 * Jira returns rich text in ADF (a tree of typed nodes). For Claude's
 * system prompt we want a plain-ish markdown rendering — preserving
 * structure (lists, code blocks, links) without the JSON ceremony.
 */

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[] | string;
  attrs?: { text?: string; url?: string };
}

export function adfToText(node: unknown): string {
  if (!node) return '';
  if (Array.isArray(node)) {
    return node.map(adfToText).join('');
  }
  if (typeof node !== 'object') return '';

  const n = node as AdfNode;
  const children = Array.isArray(n.content) ? n.content.map(adfToText).join('') : '';

  switch (n.type) {
    case 'text':
      return n.text ?? '';
    case 'paragraph':
      return children + '\n';
    case 'heading':
      return children + '\n';
    case 'bulletList':
    case 'orderedList':
      return children;
    case 'listItem':
      return '- ' + children + '\n';
    case 'codeBlock':
      return '```\n' + children + '```\n';
    case 'blockquote':
      return '> ' + children;
    case 'hardBreak':
      return '\n';
    case 'mention':
      return n.attrs?.text ?? '';
    case 'inlineCard':
    case 'blockCard':
      return n.attrs?.url ?? '';
    default:
      return children;
  }
}
