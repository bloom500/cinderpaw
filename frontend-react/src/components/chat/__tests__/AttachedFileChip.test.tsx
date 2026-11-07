import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AttachedFileChip } from '../AttachedFileChip';

describe('a photo or video in the composer', () => {
  it('a photo shows itself, not its name', () => {
    render(<AttachedFileChip file={{ name: 'cat.png', path: 'C:/cat.png', content: null, kind: 'image', dataUrl: 'data:image/png;base64,AA==' }} onRemove={() => {}} />);
    expect(screen.getByRole('img', { name: 'cat.png' })).toHaveAttribute('src', 'data:image/png;base64,AA==');
  });

  it('a video shows its first frame and can be removed', () => {
    const onRemove = vi.fn();
    const { container } = render(<AttachedFileChip file={{ name: 'demo.mp4', path: 'C:/demo.mp4', content: null, kind: 'binary', videoUrl: 'http://asset.localhost/demo' }} onRemove={onRemove} />);
    expect(container.querySelector('video')?.getAttribute('src')).toBe('http://asset.localhost/demo#t=0.1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove demo.mp4' }));
    expect(onRemove).toHaveBeenCalled();
  });

  it('a video the webview cannot decode falls back to its name', () => {
    const { container } = render(<AttachedFileChip file={{ name: 'demo.mov', path: 'C:/demo.mov', content: null, kind: 'binary', videoUrl: 'http://asset.localhost/demo' }} onRemove={() => {}} />);
    fireEvent.error(container.querySelector('video')!);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText('demo.mov')).toBeInTheDocument();
  });
});
