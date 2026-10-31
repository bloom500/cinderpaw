import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { WhatsappPairCard } from '../WhatsappPairCard';
import { tauri } from '@/lib/tauri';

vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<typeof import('@/lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, connectors: { whatsappQr: vi.fn(), list: vi.fn() } } };
});

const qr = tauri.connectors.whatsappQr as unknown as ReturnType<typeof vi.fn>;
const list = tauri.connectors.list as unknown as ReturnType<typeof vi.fn>;
const wa = (over: object) => [{ id: 'whatsapp', enabled: true, linked: false, ...over }];
const mount = () => render(<MemoryRouter><WhatsappPairCard /></MemoryRouter>);
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('WhatsappPairCard', () => {
  it('shows the code with the steps, then says linked once the phone scanned it', async () => {
    vi.useFakeTimers();
    qr.mockResolvedValue({ qr: '2@x', ascii: '', svg: '<svg/>', ts: Date.now() });
    list.mockResolvedValue(wa({}));
    mount();
    await wait(0);
    expect(screen.getByAltText('WhatsApp link code')).toBeTruthy();
    expect(screen.getByText(/Linked devices, Link a device/)).toBeTruthy();
    qr.mockResolvedValue(null);
    list.mockResolvedValue(wa({ linked: true }));
    await wait(3000);
    expect(screen.getByText(/Your phone is linked/)).toBeTruthy();
  });

  it('says why when no code ever arrives, and where to retry', async () => {
    vi.useFakeTimers();
    qr.mockResolvedValue(null);
    list.mockResolvedValue(wa({}));
    mount();
    await wait(0);
    expect(screen.getByText(/Getting your WhatsApp code ready/)).toBeTruthy();
    await wait(3000 * 11);
    expect(screen.getByText(/No code is arriving/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings, Accounts' }).getAttribute('href')).toBe('/settings?cat=accounts');
  });

  it('draws nothing once WhatsApp is off', async () => {
    vi.useFakeTimers();
    qr.mockResolvedValue(null);
    list.mockResolvedValue(wa({ enabled: false }));
    const { container } = mount();
    await wait(0);
    expect(container.textContent).toBe('');
  });
});
