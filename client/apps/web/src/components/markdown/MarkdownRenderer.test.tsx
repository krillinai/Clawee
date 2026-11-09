import type { MouseEvent } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { extractWorkspaceFilePaths } from './markdown-inline.js';

describe('MarkdownRenderer', () => {
  it('中文空格绝对路径与 ZIP 成果链接交给现有工作区回调，不打开外部页面', async () => {
    const user = userEvent.setup();
    const onLinkClick = vi.fn((_href: string, event: MouseEvent<HTMLAnchorElement>) => event.preventDefault());
    render(<MarkdownRenderer variant="assistant" linkifyWorkspaceFiles onLinkClick={onLinkClick}
      text={'[报告](/srv/任务 工作区/中文 报告.txt) [压缩包](outputs/成果.zip)'} />);

    await user.click(screen.getByRole('link', { name: '报告' }));
    await user.click(screen.getByRole('link', { name: '压缩包' }));

    expect(onLinkClick.mock.calls.map(call => call[0])).toEqual(['/srv/任务 工作区/中文 报告.txt', 'outputs/成果.zip']);
    expect(screen.getByRole('link', { name: '报告' })).not.toHaveAttribute('target');
    expect(extractWorkspaceFilePaths('[压缩包](outputs/成果.zip)')).toEqual(['outputs/成果.zip']);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
  });

  it('renders assistant markdown blocks and inline formatting', () => {
    render(
      <MarkdownRenderer
        variant="assistant"
        text={[
          '# 天气结论',
          '',
          '今天是 **29°C**，适合 `轻量户外活动`。',
          '',
          '- 带伞',
          '- [x] 查看空气质量',
          '',
          '> 下午可能转阴',
          '',
          '| 时间 | 温度 |',
          '| --- | ---: |',
          '| 上午 | 27 |',
          '| 下午 | 29 |',
        ].join('\n')}
      />
    );

    expect(screen.getByRole('heading', { name: '天气结论', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('29°C')).toHaveProperty('tagName', 'STRONG');
    expect(screen.getByText('轻量户外活动')).toHaveProperty('tagName', 'CODE');
    expect(screen.getByText('带伞')).toBeInTheDocument();
    expect(screen.getByText('查看空气质量')).toBeInTheDocument();
    expect(screen.getByText('下午可能转阴')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('removes private citation markers without exposing internal source ids', () => {
    render(
      <MarkdownRenderer
        variant="assistant"
        text={[
          '天气数据已确认。 \uE200cite\uE202turn0forecast0\uE201',
          '',
          '页面已经完成。\uE200cite\uE202turn3search0\uE202turn3search1\uE201'
        ].join('\n')}
      />
    );

    expect(screen.getByText('天气数据已确认。')).toBeInTheDocument();
    expect(screen.getByText('页面已经完成。')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('turn0forecast0');
    expect(document.body).not.toHaveTextContent('turn3search0');
    expect(document.body).not.toHaveTextContent('\uE200');
    expect(document.body).not.toHaveTextContent('\uE201');
    expect(document.body).not.toHaveTextContent('\uE202');
  });

  it('renders fenced code without syntax highlighting or innerHTML', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<MarkdownRenderer variant="assistant" text={'```ts\nconst value = 1;\n```'} />);

    expect(screen.getByText('ts')).toBeInTheDocument();
    expect(screen.getByText('const value = 1;')).toBeInTheDocument();
    expect(document.querySelector('.md-code-highlighted')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '复制' }));

    expect(writeText).toHaveBeenCalledWith('const value = 1;');
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument();
  });

  it('collapses long code at a complete line boundary and expands all content', async () => {
    const user = userEvent.setup();
    const body = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
    const { container } = render(
      <MarkdownRenderer variant="assistant" text={`\`\`\`text\n${body}\n\`\`\``} />
    );
    const code = container.querySelector('.md-code code');

    expect(code?.textContent).toBe([
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      '…',
    ].join('\n'));

    await user.click(screen.getByRole('button', { name: '展开代码' }));

    expect(code?.textContent).toBe(body);
    expect(screen.getByRole('button', { name: '收起代码' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('falls back when clipboard copy fails', async () => {
    const user = userEvent.setup();
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    });

    render(<MarkdownRenderer variant="assistant" text={'```txt\nhello\n```'} />);

    await user.click(screen.getByRole('button', { name: '复制' }));

    expect(screen.getByRole('button', { name: '复制失败' })).toBeInTheDocument();
  });

  it('does not render unsafe links as anchors', () => {
    render(
      <MarkdownRenderer
        variant="assistant"
        text={'[bad](javascript:alert(1)) [data](data:text/html,x) [file](file:///tmp/a) [vb](vbscript:msgbox(1))'}
      />
    );

    expect(screen.getByText('bad')).toBeInTheDocument();
    expect(screen.getByText('data')).toBeInTheDocument();
    expect(screen.getByText('file')).toBeInTheDocument();
    expect(screen.getByText('vb')).toBeInTheDocument();
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('renders safe links and routes relative links through onLinkClick', async () => {
    const onLinkClick = vi.fn((href: string, event: MouseEvent<HTMLAnchorElement>) => {
      if (href === 'docs/readme.md') event.preventDefault();
    });
    const user = userEvent.setup();

    render(
      <MarkdownRenderer
        variant="assistant"
        text={'[OpenAI](https://openai.com) [local](docs/readme.md) https://example.com/path.'}
        onLinkClick={onLinkClick}
      />
    );

    expect(screen.getByRole('link', { name: 'OpenAI' })).toHaveAttribute('href', 'https://openai.com');
    expect(screen.getByRole('link', { name: 'local' })).toHaveAttribute('href', 'docs/readme.md');
    expect(screen.getByRole('link', { name: 'https://example.com/path' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'local' }));

    expect(onLinkClick).toHaveBeenCalledWith('docs/readme.md', expect.any(Object));
  });

  it('shows the cited site favicon without a referrer and falls back to a globe', () => {
    const { container } = render(
      <MarkdownRenderer variant="assistant" text={'据 [CNBC](https://www.cnbc.com/2026/10/13/ai.html) 报道，联系 [编辑部](mailto:news@example.com)。'} />
    );

    const link = screen.getByRole('link', { name: 'CNBC' });
    const icon = link.querySelector('img.md-link-site-icon')!;
    expect(icon).toHaveAttribute('src', 'https://www.cnbc.com/favicon.ico');
    expect(icon).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.getByRole('link', { name: '编辑部' }).querySelector('.md-link-site-icon')).toBeNull();

    fireEvent.error(icon);
    expect(link.querySelector('img')).toBeNull();
    expect(link.querySelector('svg.md-link-site-icon.is-fallback')).not.toBeNull();
    expect(container.querySelectorAll('.md-link-site-icon')).toHaveLength(1);
  });

  it('keeps user messages free of labelled-link favicons', () => {
    render(<MarkdownRenderer variant="user" text={'[CNBC](https://www.cnbc.com/ai)'} />);
    expect(screen.getByRole('link', { name: 'CNBC' }).querySelector('.md-link-site-icon')).toBeNull();
  });

  it('shows html and image syntax as text without creating DOM nodes or images', () => {
    render(<MarkdownRenderer variant="assistant" text={'<script>alert(1)</script>\n\n![alt text](https://example.com/a.png)'} />);

    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.getByText(/alt text/)).toBeInTheDocument();
    expect(document.querySelector('script')).not.toBeInTheDocument();
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders a collapsible reference section with markdown and working code copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { container } = render(<MarkdownRenderer text={[
      '工作总结。',
      '<details>',
      '<summary>**记录定位**（collector_id / session_id / turn_id）</summary>',
      '',
      '```text',
      '[1] collector_test / thread_test / run_test',
      '```',
      '',
      '</details>',
      '后续说明。'
    ].join('\n')} />);
    const details = container.querySelector('details');
    const summary = container.querySelector('summary')!;

    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute('open');
    expect(summary.querySelector('strong')).toHaveTextContent('记录定位');
    expect(container).not.toHaveTextContent('<details>');
    expect(screen.getByText('后续说明。')).toBeInTheDocument();

    await user.click(summary);
    expect(details).toHaveAttribute('open');
    await user.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith('[1] collector_test / thread_test / run_test');
    await user.click(summary);
    expect(details).not.toHaveAttribute('open');
  });

  it('keeps nested details and closing tags inside code in their own sections', () => {
    const { container } = render(<MarkdownRenderer text={[
      '<details open>',
      '<summary>外层</summary>',
      '```html',
      '</details>',
      '<details>',
      '```',
      '<details>',
      '<summary>内层</summary>',
      '- 测试项',
      '</details>',
      '</details>',
      '正文结束。'
    ].join('\n')} />);

    expect(container.querySelectorAll('details')).toHaveLength(2);
    expect(container.querySelector('details')).toHaveAttribute('open');
    expect(container.querySelector('details details li')).toHaveTextContent('测试项');
    expect(container.querySelector('code')?.textContent).toBe('</details>\n<details>');
    expect(screen.getByText('正文结束。').closest('details')).toBeNull();
  });

  it('renders streamed details before the closing tag arrives', () => {
    const { container, rerender } = render(<MarkdownRenderer text={'<details>\n<summary>记录定位</summary>\n\n第一条记录'} />);
    expect(container.querySelector('details .md-p')).toHaveTextContent('第一条记录');
    const details = container.querySelector('details')!;
    fireEvent.click(container.querySelector('summary')!);

    rerender(<MarkdownRenderer text={'<details>\n<summary>记录定位</summary>\n\n第一条记录\n\n第二条记录\n</details>'} />);
    expect(details).toHaveAttribute('open');
    expect(details).toHaveTextContent('第二条记录');
  });

  it('does not interpret arbitrary HTML or event attributes in details', () => {
    const { container } = render(<MarkdownRenderer text={[
      '<details open>',
      '<summary><img src=x onerror=alert(1)>记录</summary>',
      '<script>alert(1)</script>',
      '</details>',
      '',
      '<details ontoggle="alert(1)">',
      '<summary>不支持的属性</summary>',
      '正文',
      '</details>'
    ].join('\n')} />);

    expect(container.querySelectorAll('details')).toHaveLength(1);
    expect(container.querySelector('details')).not.toHaveAttribute('ontoggle');
    expect(container.querySelector('img, script')).toBeNull();
    expect(container).toHaveTextContent('<details ontoggle="alert(1)">');
  });

  it.each(['user', 'code'] as const)('keeps details syntax literal in %s content', variant => {
    const source = '<details>\n<summary>记录定位</summary>\n\n正文\n</details>';
    const { container } = render(<MarkdownRenderer
      variant={variant === 'user' ? 'user' : 'assistant'}
      text={variant === 'code' ? `\`\`\`html\n${source}\n\`\`\`` : source}
    />);

    expect(container.querySelector('details, summary')).toBeNull();
    expect(container).toHaveTextContent('<details>');
    expect(container).toHaveTextContent('<summary>记录定位</summary>');
  });

  it('keeps user variant conservative', () => {
    render(<MarkdownRenderer variant="user" text={'# 不是标题\n1. 不是列表\n*不是斜体*\n`是代码`'} />);

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText('# 不是标题')).toBeInTheDocument();
    expect(screen.getByText('1. 不是列表')).toBeInTheDocument();
    expect(screen.getByText('*不是斜体*')).toBeInTheDocument();
    expect(screen.getByText('是代码')).toHaveProperty('tagName', 'CODE');
  });

  it('marks skill references in user messages without changing surrounding text', () => {
    render(
      <MarkdownRenderer
        variant="user"
        text="使用 $zhiyu-brainstorm 分析需求，再继续执行。"
      />
    );

    const skill = screen.getByText('Zhiyu Brainstorm').closest('.md-skill-reference');
    expect(skill).toBeInTheDocument();
    expect(skill).toHaveAttribute(
      'title',
      'Skill：zhiyu-brainstorm'
    );
    expect(screen.getByText(/分析需求，再继续执行/)).toBeInTheDocument();
  });

  it('keeps dollar amounts literal in user messages', () => {
    const { container } = render(
      <MarkdownRenderer variant="user" text="44:33 Raising $300M in Six Months" />
    );

    expect(container).toHaveTextContent('44:33 Raising $300M in Six Months');
    expect(container.querySelector('.md-skill-reference')).not.toBeInTheDocument();
  });

  it('formats skill acronyms as readable labels', () => {
    render(<MarkdownRenderer variant="user" text="$seo-audit https://www.workbuddy.cn/" />);

    expect(screen.getByText('SEO Audit')).toBeInTheDocument();
    expect(screen.queryByText('$seo-audit')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'https://www.workbuddy.cn/' });
    expect(link).toHaveAttribute(
      'href',
      'https://www.workbuddy.cn/'
    );
    expect(link.querySelector('img')).toHaveAttribute(
      'src',
      '/site-icons/workbuddy.svg'
    );
  });

  it('extracts unique workspace files for final artifact cards', () => {
    expect(extractWorkspaceFilePaths(
      '打开 reports/aso-audit.html，也可以查看 `reports/aso-audit.html` 和 data/score.xlsx。'
    )).toEqual(['reports/aso-audit.html', 'data/score.xlsx']);
  });

  it('prefers a Windows absolute path over a repeated basename', () => {
    const path = String.raw`C:\Users\example\Documents\Clawee\Default Project\AI-Agent-内容整理.md`;
    expect(extractWorkspaceFilePaths(`文件：\`AI-Agent-内容整理.md\`\n位置：\`${path}\``)).toEqual([path]);
    expect(extractWorkspaceFilePaths(`[笔记](<${path}>)`)).toEqual([path]);
  });

  it('keeps a relative root file distinct from a same-named file in a subdirectory', () => {
    expect(extractWorkspaceFilePaths('报告：report.md 和 docs/report.md')).toEqual(['report.md', 'docs/report.md']);
  });

  it('opens angle-wrapped Windows file links through the workspace callback', async () => {
    const path = 'C:/Users/example/Documents/Clawee/Default Project/AI-Agent-内容整理.md';
    const onLinkClick = vi.fn((_href: string, event: MouseEvent<HTMLAnchorElement>) => event.preventDefault());
    render(<MarkdownRenderer linkifyWorkspaceFiles onLinkClick={onLinkClick}
      text={`[Markdown 笔记](<${path}>)`} />);

    const link = screen.getByRole('link', { name: 'Markdown 笔记' });
    expect(link).toHaveAttribute('href', path);
    await userEvent.setup().click(link);
    expect(onLinkClick).toHaveBeenCalledWith(path, expect.any(Object));
  });

  it.each([
    "/Users/example/Documents/AI项目/Example's AI projects/MokaHelper/reports/面试报告.html",
    "reports/Melissa's interview.md",
    '/Users/example/Documents/Clawee/Default Project/outputs/image-generator/demo-ai-wordmark-test-02.png',
    '/Users/test/Documents/Clawee/默认 项目/输出 图片/玫瑰 标志.png',
    'outputs/中文 目录/中文 图片.png'
  ])('完整提取行内代码文件路径：%s', path => {
    expect(extractWorkspaceFilePaths(`已生成：\`${path}\``)).toEqual([path]);
  });

  it.each([false, true])('含单引号的报告链接保留完整路径并可点击（尖括号：%s）', async angleWrapped => {
    const path = "/Users/example/Documents/AI项目/Example's AI projects/MokaHelper/reports/面试报告.md";
    const onLinkClick = vi.fn((_href: string, event: MouseEvent<HTMLAnchorElement>) => event.preventDefault());
    const target = angleWrapped ? `<${path}>` : path;
    const text = `备用 Markdown 版本：[打开 Markdown 报告](${target})\n\n\`${path}\``;
    expect(extractWorkspaceFilePaths(text)).toEqual([path]);
    render(<MarkdownRenderer text={text} linkifyWorkspaceFiles onLinkClick={onLinkClick} />);
    const link = screen.getByRole('link', { name: '打开 Markdown 报告' });
    expect(link).toHaveAttribute('href', path);
    await userEvent.setup().click(link);
    expect(onLinkClick).toHaveBeenCalledWith(path, expect.any(Object));
  });

  it('Markdown 链接与行内代码引用同一空格路径时只生成一个成果', () => {
    const path = '/Users/test/Documents/Clawee/Default Project/outputs/玫瑰 标志.png';
    expect(extractWorkspaceFilePaths(
      `\`${path}\` [玫瑰 标志.png](${path}) \`${path}\``
    )).toEqual([path]);
    expect(extractWorkspaceFilePaths(
      `[玫瑰 标志.png](${path}) \`${path}\``
    )).toEqual([path]);
  });

  it('非文件行内代码保留内部路径提取行为，普通文本不吞入说明文字', () => {
    expect(extractWorkspaceFilePaths(
      '打开 outputs/report.png，`const file = "reports/report.pdf"`，`const value = 1`，'
      + '[外部图片](https://example.com/image.png)'
    )).toEqual(['outputs/report.png', 'reports/report.pdf']);
  });

  it('extracts the target of a markdown file link instead of its filename label', () => {
    expect(extractWorkspaceFilePaths(
      '| [`clawee-user-guide.pdf`](/workspace/output/pdf/clawee-user-guide.pdf:1) | PDF |'
    )).toEqual(['/workspace/output/pdf/clawee-user-guide.pdf']);
  });

  it('extracts local images from markdown image syntax', () => {
    expect(extractWorkspaceFilePaths(
      '![杨泗港大桥](/workspace/Default%20Project/outputs/bridge.png) ![原图](/workspace/Default Project/outputs/other.png)'
    )).toEqual([
      '/workspace/Default%20Project/outputs/bridge.png',
      '/workspace/Default Project/outputs/other.png'
    ]);
  });

  it('deduplicates file link targets without merging distinct same-name files', () => {
    expect(extractWorkspaceFilePaths(
      '[report.pdf](draft/report.pdf) [report.pdf](final/report.pdf:2:3) `final/report.pdf`'
    )).toEqual(['draft/report.pdf', 'final/report.pdf']);
  });

  it('does not treat filenames in external link labels as workspace files', () => {
    expect(extractWorkspaceFilePaths(
      '[guide.pdf](https://example.com/guide.pdf) [guide.pdf](#guide)'
    )).toEqual([]);
  });

  it('does not throw on nested or multiline emphasis', () => {
    render(<MarkdownRenderer variant="assistant" text={'**a *b* c**\n\n**第一行\n第二行**'} />);

    expect(screen.getByText(/a/)).toBeInTheDocument();
    expect(screen.getByText(/第一行/)).toBeInTheDocument();
  });
});
