import { useMemo } from 'react';

/**
 * Formatted JSON preview. Escapes inside strings (\n, \", \\) are shown as the
 * characters they stand for, and continuation lines keep the line's indent,
 * so long text values read as paragraphs.
 */
export function JsonViewer(props: { content: string }) {
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, text: formatJson(JSON.stringify(JSON.parse(props.content), null, 2)) };
    } catch {
      return { ok: false as const, text: props.content };
    }
  }, [props.content]);

  return (
    <>
      {parsed.ok ? null : <p className="file-preview-note">JSON 解析失败，以下保留原始内容。</p>}
      <pre>{parsed.text}</pre>
    </>
  );
}

function formatJson(formatted: string): string {
  return formatted.split('\n').map(line => {
    const indent = `${/^\s*/.exec(line)?.[0] ?? ''}  `;
    return line.replace(/"(?:[^"\\]|\\.)*"/g, literal => literal.replace(/\\(.)/g, (escape, char: string) => {
      if (char === 'n') return `\n${indent}`;
      if (char === '"' || char === '\\') return char;
      return escape;
    }));
  }).join('\n');
}
