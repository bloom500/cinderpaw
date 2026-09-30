/**
 * ToolsMenu — the switches are the settings the chat send path reads, and
 * every switch that is on is also a chip that turns it off.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolsMenu } from '../ToolsMenu';
import { useUI } from '@/stores/ui';
import { useModel } from '@/stores/model';

function useCloudModel(modelId: string) {
  useModel.setState({ cloudModel: { modelId } as never, loaded: null });
}

beforeEach(() => {
  useUI.setState({ reasoningMode: 'auto', enabledTools: [] });
  useCloudModel('gpt-4o');
});

describe('ToolsMenu', () => {
  it('shows no chip while every switch is at its default', () => {
    render(<ToolsMenu />);
    expect(screen.queryByRole('button', { name: /^Turn off/ })).toBeNull();
  });

  it('turns a tool on from the menu and shows it as a chip', async () => {
    render(<ToolsMenu />);
    await userEvent.click(screen.getByRole('button', { name: 'Tools and modes' }));
    await userEvent.click(screen.getByRole('switch', { name: /Web search/ }));

    expect(useUI.getState().enabledTools).toEqual(['web_search']);
    expect(screen.getByRole('button', { name: 'Turn off Web search' })).toBeTruthy();
  });

  it('turns a tool off from its chip', async () => {
    useUI.setState({ enabledTools: ['web_search', 'code_execute'] });
    render(<ToolsMenu />);
    await userEvent.click(screen.getByRole('button', { name: 'Turn off Web search' }));

    expect(useUI.getState().enabledTools).toEqual(['code_execute']);
    expect(screen.queryByRole('button', { name: 'Turn off Web search' })).toBeNull();
  });

  it('hides Think for a model that cannot think', async () => {
    render(<ToolsMenu />);
    await userEvent.click(screen.getByRole('button', { name: 'Tools and modes' }));
    expect(screen.queryByRole('switch', { name: /Think/ })).toBeNull();
  });

  it('shows Think on for a model that thinks, and off means reasoningMode off', async () => {
    useCloudModel('deepseek-r1');
    render(<ToolsMenu />);
    expect(screen.getByRole('button', { name: 'Turn off Think' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Tools and modes' }));
    const think = screen.getByRole('switch', { name: /Think/ });
    expect(think.getAttribute('aria-checked')).toBe('true');

    await userEvent.click(think);
    expect(useUI.getState().reasoningMode).toBe('off');
    expect(screen.queryByRole('button', { name: 'Turn off Think' })).toBeNull();

    await userEvent.click(screen.getByRole('switch', { name: /Think/ }));
    expect(useUI.getState().reasoningMode).toBe('auto');
  });
});
