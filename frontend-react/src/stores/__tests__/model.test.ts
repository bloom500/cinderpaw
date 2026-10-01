import { describe, it, expect, beforeEach, vi } from 'vitest';

// The store imports the Tauri bridge at module scope; the bridge pulls in
// @tauri-apps/api, which does not exist under jsdom.
vi.mock('@/lib/tauri', () => ({
  tauri: {
    models: { loaded: vi.fn(), startLoad: vi.fn(), unload: vi.fn() },
  },
  events: { modelLoadProgressEvent: { listen: vi.fn() } },
}));

import { useModel, type CloudModel } from '@/stores/model';
import type { RoleModel } from '@/lib/modelRoles';

const cloud = (providerId: string, modelId: string, providerName = 'OpenRouter'): RoleModel =>
  ({ kind: 'cloud', providerId, providerName, modelId });

const chat = (providerId: string, modelId: string): CloudModel =>
  ({ providerId, providerName: 'OpenRouter', modelId });

const reset = () =>
  useModel.setState({ roles: {}, cloudModel: null, loaded: null });

describe('followProviderDefault', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it('moves a role that was showing the old default to the new one', () => {
    // This is the whole point of the change: the user edits the default on the
    // Cloud card and Roles comes with it, instead of being edited twice.
    useModel.setState({ roles: { deep: cloud('openrouter', 'old/model') } });
    useModel.getState().followProviderDefault('openrouter', 'old/model', 'new/model');
    expect(useModel.getState().roles.deep).toEqual(cloud('openrouter', 'new/model'));
  });

  it('leaves a role pointing at a different model of that provider alone', () => {
    // Typed by hand into the Roles model field: a deliberate second choice on
    // the same provider, and the reason the rule matches on the OLD default
    // rather than on the provider id alone.
    useModel.setState({ roles: { deep: cloud('openrouter', 'openrouter/pinned') } });
    useModel.getState().followProviderDefault('openrouter', 'old/model', 'new/model');
    expect(useModel.getState().roles.deep).toEqual(cloud('openrouter', 'openrouter/pinned'));
  });

  it('leaves roles belonging to another provider alone', () => {
    useModel.setState({ roles: { fast: cloud('groq', 'old/model') } });
    useModel.getState().followProviderDefault('openrouter', 'old/model', 'new/model');
    expect(useModel.getState().roles.fast).toEqual(cloud('groq', 'old/model'));
  });

  it('moves the model the chat is answering with when it was mirroring too', () => {
    // Same rule, third place it applies: the picker sets the chat model from
    // the default, so it was mirroring and keeps mirroring.
    useModel.setState({ cloudModel: chat('openrouter', 'old/model') });
    useModel.getState().followProviderDefault('openrouter', 'old/model', 'new/model');
    expect(useModel.getState().cloudModel).toEqual(chat('openrouter', 'new/model'));
  });

  it('does not touch the chat when it is on a different model', () => {
    useModel.setState({ cloudModel: chat('openrouter', 'openrouter/chosen-elsewhere') });
    useModel.getState().followProviderDefault('openrouter', 'old/model', 'new/model');
    expect(useModel.getState().cloudModel).toEqual(chat('openrouter', 'openrouter/chosen-elsewhere'));
  });

  it('moves nothing when the default did not actually change', () => {
    useModel.setState({
      roles: { deep: cloud('openrouter', 'same/model') },
      cloudModel: chat('openrouter', 'same/model'),
    });
    useModel.getState().followProviderDefault('openrouter', 'same/model', 'same/model');
    expect(useModel.getState().roles.deep).toEqual(cloud('openrouter', 'same/model'));
    expect(useModel.getState().cloudModel).toEqual(chat('openrouter', 'same/model'));
  });

  it('moves nothing when the provider had no default to begin with', () => {
    // Nothing can have been seeded from a default that was never set, so a
    // save that fills one in does not drag hand-typed values along with it.
    useModel.setState({
      roles: { deep: cloud('openrouter', 'openrouter/pinned') },
      cloudModel: chat('openrouter', 'openrouter/pinned'),
    });
    useModel.getState().followProviderDefault('openrouter', null, 'new/model');
    expect(useModel.getState().roles.deep).toEqual(cloud('openrouter', 'openrouter/pinned'));
    expect(useModel.getState().cloudModel).toEqual(chat('openrouter', 'openrouter/pinned'));
  });

  it('moves nothing when the save carries no model at all', () => {
    // Saving only an API key sends defaultModel: null. Roles must survive it.
    useModel.setState({
      roles: { deep: cloud('openrouter', 'old/model') },
      cloudModel: chat('openrouter', 'old/model'),
    });
    useModel.getState().followProviderDefault('openrouter', 'old/model', null);
    expect(useModel.getState().roles.deep).toEqual(cloud('openrouter', 'old/model'));
    expect(useModel.getState().cloudModel).toEqual(chat('openrouter', 'old/model'));
  });
});
