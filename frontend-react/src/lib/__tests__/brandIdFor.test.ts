import { describe, it, expect } from 'vitest';
import { brandIdFor } from '../brandLogos';

describe('brandIdFor', () => {
  it('finds a service added by its link through its name or address', () => {
    expect(brandIdFor('custom-mcp-notion-com', 'Notion')).toBe('notion');
    expect(brandIdFor('custom-mcp-notion-com', 'my workspace')).toBe('notion');
  });
  it('keeps a catalog or connector id that has a logo', () => {
    expect(brandIdFor('discord', 'Discord')).toBe('discord');
  });
  it('gives nothing when no logo matches, so the tile shows the initial', () => {
    expect(brandIdFor('custom-mcp-deepwiki-com', 'DeepWiki')).toBe('');
  });
});
