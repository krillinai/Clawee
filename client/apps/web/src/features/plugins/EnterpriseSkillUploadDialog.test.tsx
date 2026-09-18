import { ENTERPRISE_SKILL_PACKAGE_MAX_BYTES } from '@clawee/protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EnterpriseSkillUploadDialog } from './EnterpriseSkillUploadDialog.js';

function renderDialog(onUpload = vi.fn(async () => undefined), onLoadSpaces = vi.fn(async () => ({ spaces: [
  { spaceId: 'readonly', name: '只读空间', description: '', actions: ['read'] as Array<'read' | 'write'> },
  { spaceId: 'writable', name: '团队技能', description: '', actions: ['read', 'write'] as Array<'read' | 'write'> }
] }))) {
  const onClose = vi.fn();
  render(<EnterpriseSkillUploadDialog onUpload={onUpload} onLoadSpaces={onLoadSpaces} onClose={onClose} />);
  return { onUpload, onLoadSpaces, onClose };
}

describe('EnterpriseSkillUploadDialog', () => {
  it('shows only writable spaces and submits a ZIP with version and changelog', async () => {
    const user = userEvent.setup();
    const { onUpload, onClose } = renderDialog();
    await screen.findByRole('option', { name: '团队技能' });
    expect(screen.queryByRole('option', { name: '只读空间' })).not.toBeInTheDocument();
    const file = new File(['ZIP'], 'review.zip', { type: 'application/zip' });
    await user.upload(screen.getByLabelText('ZIP 技能包'), file);
    await user.type(screen.getByLabelText('更新说明'), '更新');
    await user.click(screen.getByRole('button', { name: '上传' }));
    expect(onUpload).toHaveBeenCalledWith({ spaceId: 'writable', version: '1.0.0', changelog: '更新', file });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the dialog open and displays enterprise upload failures', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog(vi.fn(async () => { throw new Error('没有空间写权限'); }));
    await screen.findByRole('option', { name: '团队技能' });
    await user.upload(screen.getByLabelText('ZIP 技能包'), new File(['ZIP'], 'review.zip'));
    await user.click(screen.getByRole('button', { name: '上传' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('没有空间写权限');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables upload when there are no writable spaces and can reload permissions', async () => {
    const onLoadSpaces = vi.fn(async () => ({ spaces: [] }));
    renderDialog(undefined, onLoadSpaces);
    await screen.findByRole('option', { name: '没有可写的技能空间' });
    expect(screen.getByRole('button', { name: '上传' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '刷新空间' }));
    await waitFor(() => expect(onLoadSpaces).toHaveBeenCalledTimes(2));
  });

  it('rejects invalid extensions and oversized packages without sending them', async () => {
    const { onUpload } = renderDialog();
    await screen.findByRole('option', { name: '团队技能' });
    fireEvent.change(screen.getByLabelText('ZIP 技能包'), { target: { files: [new File(['text'], 'review.txt')] } });
    fireEvent.click(screen.getByRole('button', { name: '上传' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ZIP');
    const largeFile = new File(['ZIP'], 'review.zip');
    Object.defineProperty(largeFile, 'size', { value: ENTERPRISE_SKILL_PACKAGE_MAX_BYTES + 1 });
    fireEvent.change(screen.getByLabelText('ZIP 技能包'), { target: { files: [largeFile] } });
    fireEvent.click(screen.getByRole('button', { name: '上传' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('50 MB');
    expect(onUpload).not.toHaveBeenCalled();
  });

  it('blocks closing and duplicate submission while uploading', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const { onUpload, onClose } = renderDialog(vi.fn(() => pending));
    await screen.findByRole('option', { name: '团队技能' });
    fireEvent.change(screen.getByLabelText('ZIP 技能包'), { target: { files: [new File(['ZIP'], 'review.zip')] } });
    fireEvent.click(screen.getByRole('button', { name: '上传' }));
    expect(screen.getByRole('button', { name: '上传中' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onUpload).toHaveBeenCalledOnce();
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
