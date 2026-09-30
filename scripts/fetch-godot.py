#!/usr/bin/env python3
"""Install Godot 4.7.2 (portable) and ONLY its web export templates.

The official template archive is 1.28 GB for every platform; the web
templates the campfire game needs are a small part of it, read out of the
remote zip with HTTP range requests. Prints `CINDERPAW_GODOT=<path>` so CI can
append it to $GITHUB_ENV.

usage: python scripts/fetch-godot.py [install-dir]    (default: .tools/godot)
"""
import io
import os
import platform
import stat
import sys
import urllib.request
import zipfile

VERSION = '4.7.2'
BASE = f'https://github.com/godotengine/godot/releases/download/{VERSION}-stable/'
EDITOR = {
    'Linux': (f'Godot_v{VERSION}-stable_linux.x86_64.zip', f'Godot_v{VERSION}-stable_linux.x86_64'),
    'Windows': (f'Godot_v{VERSION}-stable_win64.exe.zip', f'Godot_v{VERSION}-stable_win64_console.exe'),
}
TEMPLATES = f'Godot_v{VERSION}-stable_export_templates.tpz'


class RemoteFile(io.RawIOBase):
    """A seekable read-only view of a URL, one HTTP range request per read."""

    def __init__(self, url):
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD')) as r:
            self.url, self.size = r.url, int(r.headers['Content-Length'])
        self.pos = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def readinto(self, buf):
        if self.pos >= self.size or len(buf) == 0:
            return 0
        end = min(self.size, self.pos + len(buf)) - 1
        with urllib.request.urlopen(urllib.request.Request(self.url, headers={'Range': f'bytes={self.pos}-{end}'})) as r:
            data = r.read()
        buf[:len(data)] = data
        self.pos += len(data)
        return len(data)


def main():
    dest = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join('.tools', 'godot'))
    system = platform.system()
    if system not in EDITOR:
        sys.exit(f'fetch-godot: no editor download is wired for {system}; install Godot {VERSION} and set CINDERPAW_GODOT.')
    os.makedirs(dest, exist_ok=True)
    archive, binary = EDITOR[system]
    exe = os.path.join(dest, binary)
    if not os.path.exists(exe):
        with urllib.request.urlopen(BASE + archive) as r:
            zipfile.ZipFile(io.BytesIO(r.read())).extractall(dest)
        os.chmod(exe, os.stat(exe).st_mode | stat.S_IEXEC)
    open(os.path.join(dest, '._sc_'), 'a').close()  # self-contained: templates live beside the editor
    tdir = os.path.join(dest, 'editor_data', 'export_templates', f'{VERSION}.stable')
    if not os.path.exists(os.path.join(tdir, 'web_nothreads_release.zip')):
        os.makedirs(tdir, exist_ok=True)
        z = zipfile.ZipFile(io.BufferedReader(RemoteFile(BASE + TEMPLATES), buffer_size=1 << 20))
        for name in z.namelist():
            if 'web_nothreads' in name or name.endswith('version.txt'):
                with z.open(name) as src, open(os.path.join(tdir, os.path.basename(name)), 'wb') as out:
                    out.write(src.read())
    print(f'CINDERPAW_GODOT={exe}')


if __name__ == '__main__':
    main()
