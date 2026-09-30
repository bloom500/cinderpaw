import { describe, it, expect } from 'vitest';
import { decode, encode, sparkKindForTool } from '../emberBridge';

describe('emberBridge', () => {
  it('sorts tools into spark kinds', () => {
    expect(sparkKindForTool('web_search')).toBe('search');
    expect(sparkKindForTool('read_url')).toBe('search');
    expect(sparkKindForTool('read_file')).toBe('read');
    expect(sparkKindForTool('grep')).toBe('read');
    expect(sparkKindForTool('shell_exec')).toBe('build');
    expect(sparkKindForTool('code-quality:run_tests')).toBe('build');
    expect(sparkKindForTool('calculator')).toBe('other');
    expect(sparkKindForTool('some_future_tool')).toBe('other');
  });

  it('decodes only what the game may say', () => {
    expect(decode('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(decode('{"type":"close"}')).toEqual({ type: 'close' });
    expect(decode('{"type":"score","value":12.6}')).toEqual({ type: 'score', value: 13 });
    expect(decode('{"type":"score","value":-4}')).toEqual({ type: 'score', value: 0 });
    expect(decode('{"type":"score","value":"lots"}')).toBeNull();
    expect(decode('{"type":"spark","kind":"read"}')).toBeNull();
    expect(decode('not json')).toBeNull();
    expect(decode({ type: 'ready' })).toBeNull();
  });

  it('encodes JSON text', () => {
    expect(JSON.parse(encode({ type: 'spark', kind: 'read' }))).toEqual({ type: 'spark', kind: 'read' });
  });
});
