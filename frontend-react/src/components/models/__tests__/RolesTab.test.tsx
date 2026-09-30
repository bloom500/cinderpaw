import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RolesTab } from '../RolesTab';
import { tauri } from '@/lib/tauri';
import { useModel } from '@/stores/model';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const OPENROUTER = { id: 'openrouter', name: 'OpenRouter', enabled: true, has_api_key: true, default_model: 'z-ai/glm-5.3-flash' };

beforeEach(() => {
  useModel.setState({ roles: {} });
  vi.spyOn(tauri.models, 'list').mockResolvedValue([] as never);
});

describe('Models > Roles', () => {
  it('a provider picked for a role starts on its default model, and the id can be changed', async () => {
    vi.spyOn(tauri.raw, 'getByokSettings').mockResolvedValue([OPENROUTER] as never);
    render(<RolesTab onCloud={() => {}} onBrowse={() => {}} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Deep model' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'OpenRouter' }));
    expect(useModel.getState().roles.deep).toEqual({ kind: 'cloud', providerId: 'openrouter', providerName: 'OpenRouter', modelId: 'z-ai/glm-5.3-flash' });

    const id = screen.getByLabelText('Deep model id');
    await userEvent.clear(id);
    await userEvent.type(id, 'anthropic/claude-opus');
    expect(useModel.getState().roles.deep).toMatchObject({ modelId: 'anthropic/claude-opus' });
  });

  it('with no key and no download, says what a role needs instead of four empty pickers', async () => {
    vi.spyOn(tauri.raw, 'getByokSettings').mockResolvedValue([] as never);
    render(<RolesTab onCloud={() => {}} onBrowse={() => {}} />);
    expect(await screen.findByText(/A role needs a model/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Primary model' })).toBeNull();
  });
});
