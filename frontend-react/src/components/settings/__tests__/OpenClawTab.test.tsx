import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpenClawTab } from '@/components/settings/OpenClawTab';
import { tauri, type OpenClawStatusResult } from '@/lib/tauri';

vi.mock('@/lib/tauri', () => ({
  tauri: {
    openclaw: {
      detect:      vi.fn(),
      status:      vi.fn(),
      openDocs:    vi.fn(),
      testMessage: vi.fn(),
    },
  },
}));

const mockStatus      = vi.mocked(tauri.openclaw.status);
const mockOpenDocs    = vi.mocked(tauri.openclaw.openDocs);
const mockTestMessage = vi.mocked(tauri.openclaw.testMessage);

function makeReady(overrides: Partial<OpenClawStatusResult> = {}): OpenClawStatusResult {
  return {
    installed: false,
    binary_path: null,
    version: null,
    gateway_running: false,
    health_ok: false,
    health_summary: null,
    diagnostics: [],
    recommended_action: 'Install OpenClaw to enable agent capabilities.',
    capabilities: [],
    gateway_endpoint: null,
    ...overrides,
  };
}

describe('OpenClawTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatus.mockResolvedValue(makeReady());
    mockOpenDocs.mockResolvedValue(undefined);
    mockTestMessage.mockResolvedValue({
      kind: 'ok', response_text: null, error_message: null, endpoint_tried: null,
    });
  });

  it('auto-refreshes on mount and shows the not-installed empty state', async () => {
    render(<OpenClawTab />);
    expect(mockStatus).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText(/Feral could not find an openclaw binary/i)).toBeInTheDocument();
    });
  });

  it('shows the installed/healthy pill when status is fully green', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true,
      binary_path: '/usr/local/bin/openclaw',
      version: 'openclaw 1.2.3',
      gateway_running: true,
      health_ok: true,
      health_summary: 'ok · 3 agents',
      recommended_action: 'OpenClaw is installed, the gateway is running, and health checks pass.',
    }));

    render(<OpenClawTab />);
    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument();
    });
    expect(screen.getByText('openclaw 1.2.3')).toBeInTheDocument();
    expect(screen.getByText('/usr/local/bin/openclaw')).toBeInTheDocument();
    expect(screen.getByText(/gateway is running, and health checks pass/)).toBeInTheDocument();
  });

  it('shows the gateway-up-but-unhealthy pill when health fails', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true,
      binary_path: 'C:\\Program Files\\openclaw\\openclaw.exe',
      version: 'openclaw 0.9.0',
      gateway_running: true,
      health_ok: false,
      recommended_action: 'OpenClaw gateway is up but health checks are failing.',
    }));

    render(<OpenClawTab />);
    await waitFor(() => {
      expect(screen.getByText('Gateway up · health failing')).toBeInTheDocument();
    });
    expect(screen.getByText(/health checks are failing/)).toBeInTheDocument();
  });

  it('clicking Refresh re-runs the status command', async () => {
    render(<OpenClawTab />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: /refresh status/i }));
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(2));
  });

  it('Open install docs button calls openclaw.openDocs', async () => {
    render(<OpenClawTab />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: /open install docs/i }));
    await waitFor(() => expect(mockOpenDocs).toHaveBeenCalledTimes(1));
  });

  it('shows an error pill if the status call rejects', async () => {
    mockStatus.mockRejectedValue(new Error('boom'));
    render(<OpenClawTab />);
    await waitFor(() => {
      expect(screen.getByText('Check failed')).toBeInTheDocument();
    });
    expect(screen.getByText(/Error: boom/i)).toBeInTheDocument();
  });

  it('shows redacted diagnostics when present', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true,
      binary_path: '/usr/bin/openclaw',
      version: 'openclaw 1.0.0',
      diagnostics: [
        {
          command: 'openclaw status --all',
          ok: true,
          exit_code: 0,
          stdout_redacted: 'all good\nAuthorization: Bearer <redacted>',
          stderr_redacted: '',
          error: null,
        },
      ],
    }));

    render(<OpenClawTab />);
    // Wait for the status to load and the diagnostics section to appear.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /diagnostics/i })).toBeInTheDocument();
    });
    // Expand the diagnostics collapsible.
    await userEvent.click(screen.getByRole('button', { name: /diagnostics/i }));
    expect(screen.getByText('$ openclaw status --all')).toBeInTheDocument();
    expect(screen.getByText(/all good/)).toBeInTheDocument();
    // The secret must never reach the UI.
    expect(screen.queryByText(/Bearer\s+[A-Za-z0-9]/)).not.toBeInTheDocument();
  });

  // ── capabilities card ────────────────────────────────────────────────────

  it('shows capability badges when gateway and health are green', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true,
      gateway_running: true,
      health_ok: true,
      capabilities: ['gateway', 'health_check'],
    }));
    render(<OpenClawTab />);
    await waitFor(() => {
      expect(screen.getByText('gateway')).toBeInTheDocument();
      expect(screen.getByText('health_check')).toBeInTheDocument();
    });
  });

  it('shows no-capabilities message when nothing is confirmed', async () => {
    mockStatus.mockResolvedValue(makeReady({ capabilities: [] }));
    render(<OpenClawTab />);
    await waitFor(() => {
      expect(screen.getByText(/no capabilities confirmed/i)).toBeInTheDocument();
    });
  });

  it('shows gateway endpoint when present', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true,
      gateway_running: true,
      health_ok: true,
      capabilities: ['gateway'],
      gateway_endpoint: 'http://localhost:8888',
    }));
    render(<OpenClawTab />);
    await waitFor(() => {
      expect(screen.getByText('http://localhost:8888')).toBeInTheDocument();
    });
  });

  it('shows not-yet-enabled routing disclaimer regardless of connection state', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true,
      gateway_running: true,
      health_ok: true,
      capabilities: ['gateway', 'health_check'],
    }));
    render(<OpenClawTab />);
    await waitFor(() => {
      expect(screen.getByText(/routing.*not yet enabled|not yet enabled.*routing/i)).toBeInTheDocument();
    });
  });

  // ── test message panel ───────────────────────────────────────────────────

  it('Send test message button is disabled when capabilities are empty', async () => {
    mockStatus.mockResolvedValue(makeReady({ capabilities: [] }));
    render(<OpenClawTab />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    const btn = screen.getByRole('button', { name: /send test message/i });
    expect(btn).toBeDisabled();
  });

  it('Send test message button is disabled when only gateway capability is present', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true, gateway_running: true,
      capabilities: ['gateway'], gateway_endpoint: 'http://localhost:8888',
    }));
    render(<OpenClawTab />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /send test message/i })).toBeDisabled();
  });

  it('Send test message button is enabled when both capabilities are present', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true, gateway_running: true, health_ok: true,
      capabilities: ['gateway', 'health_check'],
      gateway_endpoint: 'http://localhost:8888',
    }));
    render(<OpenClawTab />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /send test message/i })).not.toBeDisabled();
  });

  it('shows success response after testMessage returns ok', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true, gateway_running: true, health_ok: true,
      capabilities: ['gateway', 'health_check'],
      gateway_endpoint: 'http://localhost:8888',
    }));
    mockTestMessage.mockResolvedValue({
      kind: 'ok',
      response_text: 'Connection confirmed!',
      error_message: null,
      endpoint_tried: 'http://localhost:8888/v1/chat/completions',
    });

    render(<OpenClawTab />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: /send test message/i }));

    await waitFor(() => {
      expect(screen.getByText('Connection confirmed!')).toBeInTheDocument();
    });
  });

  it('shows unsupported state when testMessage kind is unsupported', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true, gateway_running: true, health_ok: true,
      capabilities: ['gateway', 'health_check'],
      gateway_endpoint: 'http://localhost:8888',
    }));
    mockTestMessage.mockResolvedValue({
      kind: 'unsupported',
      response_text: null,
      error_message: 'No compatible API path found.',
      endpoint_tried: 'http://localhost:8888',
    });

    render(<OpenClawTab />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: /send test message/i }));

    await waitFor(() => {
      expect(screen.getByText(/no compatible api path found/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/unsupported/i)).toBeInTheDocument();
  });

  it('shows error state when testMessage kind is error', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true, gateway_running: true, health_ok: true,
      capabilities: ['gateway', 'health_check'],
      gateway_endpoint: 'http://localhost:8888',
    }));
    mockTestMessage.mockResolvedValue({
      kind: 'error',
      response_text: null,
      error_message: 'Connection refused.',
      endpoint_tried: 'http://localhost:8888/v1/chat/completions',
    });

    render(<OpenClawTab />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: /send test message/i }));

    await waitFor(() => {
      expect(screen.getByText(/connection refused/i)).toBeInTheDocument();
    });
  });

  it('docs-open failure shows an inline error without clearing the status cards', async () => {
    mockStatus.mockResolvedValue(makeReady({
      installed: true,
      binary_path: '/usr/local/bin/openclaw',
      version: 'openclaw 1.2.3',
      gateway_running: true,
      health_ok: true,
      health_summary: null,
      recommended_action: 'All good.',
    }));
    mockOpenDocs.mockRejectedValue(new Error('xdg-open not found'));

    render(<OpenClawTab />);

    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /open install docs/i }));

    await waitFor(() => {
      expect(screen.getByText(/xdg-open not found/i)).toBeInTheDocument();
    });

    // Status pill must NOT flip to "Check failed"
    expect(screen.queryByText('Check failed')).not.toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    // Status card content must still be visible (not wiped to Skeleton)
    expect(screen.getByText('openclaw 1.2.3')).toBeInTheDocument();
  });
});
