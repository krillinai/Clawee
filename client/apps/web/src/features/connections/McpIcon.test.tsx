import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { McpIcon } from './McpIcon.js';

describe('McpIcon', () => {
  it('creates a desktop-control icon specifically for computer-use', () => {
    const { container } = render(<McpIcon name="computer-use" />);
    const icon = container.querySelector('[data-mcp-icon]');

    expect(icon).toHaveAttribute('data-mcp-icon', 'computer-use');
    expect(icon).toHaveAttribute('data-tone', 'coral');
    expect(icon).toHaveAttribute('data-kind', 'computer-use');
    expect(container.querySelector('.mcp-icon__computer-screen'))
      .toBeInTheDocument();
    expect(container.querySelector('.mcp-icon__computer-pointer'))
      .toBeInTheDocument();
  });

  it('creates an executable-code icon specifically for node_repl', () => {
    const { container } = render(<McpIcon name="node_repl" />);
    const icon = container.querySelector('[data-mcp-icon]');

    expect(icon).toHaveAttribute('data-mcp-icon', 'node-repl');
    expect(icon).toHaveAttribute('data-tone', 'green');
    expect(icon).toHaveAttribute('data-kind', 'node-repl');
    expect(container.querySelector('.mcp-icon__node-mark'))
      .toHaveTextContent('>_');
  });

  it('uses a semantic glyph and tone for known connectors', () => {
    const { container } = render(<McpIcon name="GitHub" />);
    const icon = container.querySelector('[data-mcp-icon]');

    expect(icon).toHaveAttribute('data-mcp-icon', 'source');
    expect(icon).toHaveAttribute('data-tone', 'violet');
  });

  it('uses connector details when the name has no semantic match', () => {
    const { container } = render(
      <McpIcon name="Local tools" detail="filesystem · stdio" size="compact" />
    );

    const icon = container.querySelector('[data-mcp-icon]');
    expect(icon).toHaveAttribute('data-mcp-icon', 'files');
    expect(icon).toHaveClass('mcp-icon--compact');
  });

  it('keeps the fallback color stable for the same connector name', () => {
    const { container } = render(
      <>
        <McpIcon name="Acme connector" />
        <McpIcon name="Acme connector" />
      </>
    );
    const icons = container.querySelectorAll('[data-mcp-icon]');

    expect(icons[0]).toHaveAttribute('data-mcp-icon', 'plug');
    expect(icons[0]?.getAttribute('data-tone')).toBe(
      icons[1]?.getAttribute('data-tone')
    );
  });
});
