import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnterpriseSkillParticipantAvatar } from './EnterpriseSkillParticipantAvatar.js';

afterEach(() => vi.unstubAllGlobals());

describe('EnterpriseSkillParticipantAvatar', () => {
  it('loads protected avatars and releases the object URL on unmount', async () => {
    const createObjectURL = vi.fn(() => 'blob:participant-avatar');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
    const loadAvatar = vi.fn(async () => new Response('image', { headers: { 'Content-Type': 'image/png' } }));
    const view = render(<EnterpriseSkillParticipantAvatar skillId="skill-1" userId="user-1" name="张三" src="/protected-avatar" onLoadAvatar={loadAvatar} />);
    await waitFor(() => expect(screen.getByRole('img', { name: '张三' })).toHaveAttribute('src', 'blob:participant-avatar'));
    expect(loadAvatar).toHaveBeenCalledWith('skill-1', 'user-1');
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:participant-avatar');
  });

  it('keeps the initial avatar when the avatar service is unavailable', async () => {
    const loadAvatar = vi.fn(async () => new Response(null, { status: 404 }));
    render(<EnterpriseSkillParticipantAvatar skillId="skill-1" userId="user-1" name="张三" src="/protected-avatar" onLoadAvatar={loadAvatar} />);
    await waitFor(() => expect(loadAvatar).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('张三')).toHaveTextContent('张');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
