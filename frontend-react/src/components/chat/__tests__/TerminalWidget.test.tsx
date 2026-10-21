import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Widget } from '../CallToolScreen';
import { finishActivity, startActivity } from '@/hooks/useLiveToolActivity';

// The UX lab ran `cmd /c echo hello` (19 Oct) and the card showed the command
// and nothing under it. This is the exact result shell_exec sends back.
describe('terminal widget', () => {
  it('shows what the command printed', () => {
    const a = finishActivity(startActivity('shell_exec', { argv: ['cmd', '/c', 'echo', 'hello'] }), {
      ok: true,
      content: '$ cmd /c echo hello\n  (cwd: C:\\Users\\Ana\\Documents)\n[exit 0, 31ms]\nhello\r\n',
    });
    const { container } = render(<Widget activity={a} flat />);
    expect(container.textContent).toContain('hello');
    expect(container.textContent).not.toContain('[exit 0');
  });

  it('a failed command shows why, not its own header', () => {
    const a = finishActivity(startActivity('shell_exec', { argv: ['cmd', '/c', 'dir', 'nope'] }), {
      ok: false,
      content: '$ cmd /c dir nope\n  (cwd: C:\\Users\\Ana\\Documents\\a-long-project-folder-name)\n[exit 1, 20ms]\n[stderr]\nFile Not Found\r\n',
    });
    expect(a.error).toContain('File Not Found');
  });
});
