import { describe, expect, it } from 'vitest';
import { keysFor, platform } from '../siteKeys';

describe('keys per system', () => {
  it('reads the system from the user agent, Windows by default', () => {
    expect(platform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)')).toBe('mac');
    expect(platform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(platform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(platform('Mozilla/5.0 (linux) AppleWebKit jsdom')).toBe('windows');
  });

  it('a Mac browser changes tabs with Control+Tab, never Cmd+Tab (that switches apps)', () => {
    const mac = keysFor('Reble - YouTube - Google Chrome', 'mac').commands;
    expect(mac.next_tab!.keys).toBe('{control+tab}');
    expect(mac.back!.keys).toBe('{cmd+[}');
    expect(mac.new_tab!.keys).toBe('{ctrl+t}');
    expect(mac.media_next!.keys).toBe('{shift+n}');
    expect(keysFor('Reble - YouTube - Brave', 'windows').commands.next_tab!.keys).toBe('{ctrl+tab}');
  });

  it('apps get the window keys of their own system', () => {
    expect(keysFor('Untitled - Notes', 'mac').commands.quit_app!.keys).toBe('{cmd+q}');
    expect(keysFor('Untitled - Notes', 'mac').commands.redo!.keys).toBe('{cmd+shift+z}');
    expect(keysFor('Document - gedit', 'linux').commands.minimize!.keys).toBe('{win+h}');
    expect(keysFor('Document - gedit', 'linux').commands.file_explorer).toBeUndefined();
    expect(keysFor('Document - Notepad', 'windows').commands.file_explorer!.keys).toBe('{win+e}');
  });
});
