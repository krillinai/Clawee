import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CreateProjectDialog } from './CreateProjectDialog.js';

describe('CreateProjectDialog', () => {
  it('creates a managed project when no source folder is selected', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => true);
    const onClose = vi.fn();

    render(
      <CreateProjectDialog
        open
        onClose={onClose}
        onSelectSourceDirectory={vi.fn(async () => null)}
        onCreate={onCreate}
      />
    );

    expect(screen.getByText('源文件夹')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加源文件夹' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建项目' })).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: '项目名称' }), '产品官网');
    await user.click(screen.getByRole('button', { name: '创建项目' }));

    expect(onCreate).toHaveBeenCalledWith('产品官网');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses a selected existing folder as the project source', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => true);
    const onSelectSourceDirectory = vi.fn(
      async () => '/Users/test/Documents/product-site'
    );

    render(
      <CreateProjectDialog
        open
        onClose={vi.fn()}
        onSelectSourceDirectory={onSelectSourceDirectory}
        onCreate={onCreate}
      />
    );

    await user.click(screen.getByRole('button', { name: '添加源文件夹' }));

    expect(await screen.findByText('product-site')).toBeInTheDocument();
    expect(screen.getByText('/Users/test/Documents/product-site')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: '项目名称' }), '产品官网');
    await user.click(screen.getByRole('button', { name: '创建项目' }));

    expect(onSelectSourceDirectory).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(
      '产品官网',
      '/Users/test/Documents/product-site'
    );
  });
});
