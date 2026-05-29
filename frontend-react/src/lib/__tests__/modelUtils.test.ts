import { describe, it, expect } from 'vitest';
import {
  QUANT_RANK, quantQualityRank, extractQuant, cleanModelName,
  quantToQuality, quantToBadge, sizeGb,
  stripFrontmatter, compatLevel, pickFittedFile, globalFittedQuant,
} from '@/lib/modelUtils';
import type { SystemInfo, HfFile } from '@/lib/tauri';

const sys = (vram: number, ram: number): SystemInfo => ({
  os: 'windows', cpu: 'test', cores: 8,
  ram_total_mb: ram, ram_used_mb: 1024,
  gpu_name: 'Test GPU', vram_total_mb: vram, vram_used_mb: 0,
  supports_vulkan: true,
});

const file = (name: string, size: number): HfFile => ({ rfilename: name, size });

describe('extractQuant', () => {
  it('extracts Q4_K_M from filename', () => {
    expect(extractQuant('model.Q4_K_M.gguf')).toBe('Q4_K_M');
  });
  it('extracts F16', () => {
    expect(extractQuant('model.F16.gguf')).toBe('F16');
  });
  it('returns — for unknown', () => {
    expect(extractQuant('model.gguf')).toBe('—');
  });
});

describe('cleanModelName', () => {
  it('strips .gguf and quant suffix, title-cases result', () => {
    expect(cleanModelName('llama-3.1-8b.Q4_K_M.gguf')).toBe('Llama 3.1 8b');
  });
  it('handles underscore separators', () => {
    expect(cleanModelName('my_model_name.gguf')).toBe('My Model Name');
  });
  it('no double spaces', () => {
    expect(cleanModelName('a--b.gguf')).not.toMatch(/  /);
  });
});

describe('quantToQuality', () => {
  it('Q4_K_M → Balanced quality', () => {
    expect(quantToQuality('Q4_K_M')).toBe('Balanced quality');
  });
  it('Q8_0 → Best quality', () => {
    expect(quantToQuality('Q8_0')).toBe('Best quality');
  });
  it('F16 → Full precision', () => {
    expect(quantToQuality('F16')).toBe('Full precision');
  });
  it('unknown → Standard', () => {
    expect(quantToQuality('UNKNOWN')).toBe('Standard');
  });
  it('case insensitive', () => {
    expect(quantToQuality('q4_k_m')).toBe('Balanced quality');
  });
});

describe('quantToBadge', () => {
  it('F16 → full variant', () => {
    expect(quantToBadge('F16')).toEqual({ label: 'Full', variant: 'full' });
  });
  it('Q8_0 → high variant', () => {
    expect(quantToBadge('Q8_0')).toEqual({ label: 'High', variant: 'high' });
  });
  it('Q4_K_M → balanced variant', () => {
    expect(quantToBadge('Q4_K_M')).toEqual({ label: 'Balanced', variant: 'balanced' });
  });
  it('Q2_K → small variant', () => {
    expect(quantToBadge('Q2_K')).toEqual({ label: 'Small', variant: 'small' });
  });
  it('IQ1_M → tiny variant', () => {
    expect(quantToBadge('IQ1_M')).toEqual({ label: 'Tiny', variant: 'tiny' });
  });
  it('case insensitive', () => {
    expect(quantToBadge('f16').variant).toBe('full');
  });
});

describe('quantQualityRank', () => {
  it('uses QUANT_RANK map', () => {
    expect(QUANT_RANK['q4_k_m']).toBe(55);
    expect(QUANT_RANK['f16']).toBe(100);
  });
  it('Q4_K_M rank > Q4_0 rank', () => {
    expect(quantQualityRank('model.Q4_K_M.gguf')).toBeGreaterThan(quantQualityRank('model.Q4_0.gguf'));
  });
  it('Q8_0 rank > Q6_K rank', () => {
    expect(quantQualityRank('model.Q8_0.gguf')).toBeGreaterThan(quantQualityRank('model.Q6_K.gguf'));
  });
  it('F16 = 100', () => {
    expect(quantQualityRank('model.F16.gguf')).toBe(100);
  });
  it('unknown defaults to 35', () => {
    expect(quantQualityRank('model.UNKNOWN.gguf')).toBe(35);
  });
});

describe('sizeGb', () => {
  it('< 1 GB returns MB', () => {
    expect(sizeGb(512 * 1024 * 1024)).toMatch(/MB/);
  });
  it('>= 1 GB returns GB with 1 decimal', () => {
    expect(sizeGb(4.7 * 1024 * 1024 * 1024)).toMatch(/4\.7 GB/);
  });
});

describe('stripFrontmatter', () => {
  it('strips YAML frontmatter', () => {
    const md = '---\ntitle: test\n---\n\n# Hello';
    expect(stripFrontmatter(md)).toBe('# Hello');
  });
  it('no-op if no frontmatter', () => {
    expect(stripFrontmatter('# Hello')).toBe('# Hello');
  });
  it('preserves content after frontmatter', () => {
    const md = '---\nfoo: bar\n---\ncontent here';
    expect(stripFrontmatter(md)).toBe('content here');
  });
});

describe('compatLevel', () => {
  it('fits when file <= 70% of vram', () => {
    expect(compatLevel(2 * 1024 * 1024 * 1024, sys(4096, 32768))).toBe('fits');
  });
  it('slow when file > 70% but <= 100% of vram', () => {
    expect(compatLevel(3.5 * 1024 * 1024 * 1024, sys(4096, 32768))).toBe('slow');
  });
  it('no when file exceeds vram', () => {
    expect(compatLevel(6 * 1024 * 1024 * 1024, sys(4096, 32768))).toBe('no');
  });
  it('returns null when sys is null', () => {
    expect(compatLevel(1024, null)).toBeNull();
  });
});

describe('pickFittedFile', () => {
  it('returns null for empty array', () => {
    expect(pickFittedFile([], sys(8192, 32768))).toBeNull();
  });
  it('returns highest-rank file that fits comfortably', () => {
    const files = [
      file('model.Q4_K_M.gguf', 4 * 1024 * 1024 * 1024),
      file('model.Q8_0.gguf',   8 * 1024 * 1024 * 1024),
    ];
    const result = pickFittedFile(files, sys(16384, 32768));
    expect(result?.rfilename).toBe('model.Q8_0.gguf');
  });
  it('falls back to smallest slow file when nothing fits comfortably', () => {
    const files = [
      file('model.Q4_K_M.gguf', 3 * 1024 * 1024 * 1024),
      file('model.Q8_0.gguf',   7 * 1024 * 1024 * 1024),
    ];
    const result = pickFittedFile(files, sys(4096, 32768));
    expect(result?.rfilename).toBe('model.Q4_K_M.gguf');
  });
});

describe('globalFittedQuant', () => {
  it('8192 MB VRAM → Q4_K_M', () => {
    expect(globalFittedQuant(sys(8192, 32768))).toBe('Q4_K_M');
  });
  it('32768 MB VRAM → Q8_0', () => {
    expect(globalFittedQuant(sys(32768, 65536))).toBe('Q8_0');
  });
  it('null sys → Q4_K_M (8192 default)', () => {
    expect(globalFittedQuant(null)).toBe('Q4_K_M');
  });
});
