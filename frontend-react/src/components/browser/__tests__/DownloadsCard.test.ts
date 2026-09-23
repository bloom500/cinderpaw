import { describe, it, expect } from 'vitest';
import { folderOf } from '../DownloadsCard';

describe('folderOf', () => {
  it('finds the folder of a Windows path', () => {
    expect(folderOf('C:\\Users\\D\\Downloads\\Feral_2026.8.11_x64-setup (1).exe')).toBe('C:\\Users\\D\\Downloads');
  });

  it('finds the folder of a macOS or Linux path', () => {
    expect(folderOf('/home/d/Downloads/a.zip')).toBe('/home/d/Downloads');
  });
});
