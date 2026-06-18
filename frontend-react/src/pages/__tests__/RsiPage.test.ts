/**
 * Faza 1 — RSI page wire-format tests.
 *
 * The live event feed's only logic that doesn't depend on Tauri's
 * `invoke` / `listen` plumbing is the `parseRsiEngineEvent` helper.
 * This file unit-tests that helper exhaustively so a wire-format
 * drift (e.g. snake_case → camelCase change in the Rust handler) is
 * caught at `vitest` time rather than in production logs.
 */

import { describe, it, expect } from 'vitest';
import { parseRsiEngineEvent } from '@/pages/RsiPage';

describe('parseRsiEngineEvent', () => {
  it('returns null for non-JSON input', () => {
    expect(parseRsiEngineEvent('not json')).toBeNull();
    expect(parseRsiEngineEvent('')).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    expect(parseRsiEngineEvent('"hello"')).toBeNull();
    expect(parseRsiEngineEvent('42')).toBeNull();
    expect(parseRsiEngineEvent('null')).toBeNull();
    expect(parseRsiEngineEvent('[1,2,3]')).toBeNull();
  });

  it('returns null for an rsi_engine_event with an unknown event variant', () => {
    // Rust's handle_rsi_engine_event logs and drops unknown event
    // names; the TS side mirrors that — unknown variants never reach
    // the feed.
    expect(parseRsiEngineEvent(
      JSON.stringify({ type: 'rsi_engine_event', event: 'rate_limited' }),
    )).toBeNull();
  });

  it('returns null for a line whose type is not rsi_engine_event', () => {
    // The agent-output channel carries many line types (chunk/done/
    // tool/...). Only rsi_engine_event lines are ours.
    expect(parseRsiEngineEvent(
      JSON.stringify({ type: 'chunk', id: 'm1', content: 'hi' }),
    )).toBeNull();
    expect(parseRsiEngineEvent(
      JSON.stringify({ type: 'done', id: 'm1', content: '', stopped: false }),
    )).toBeNull();
  });

  it('parses a minimal started event with id only', () => {
    const line = parseRsiEngineEvent(JSON.stringify({
      type: 'rsi_engine_event',
      event: 'started',
      id: '550e8400-e29b-41d4-a716-446655440000',
    }));
    expect(line).toEqual({
      type: 'rsi_engine_event',
      event: 'started',
      id: '550e8400-e29b-41d4-a716-446655440000',
      iteration: undefined,
      bestScore: undefined,
      costSoFarUsd: undefined,
      concurrency: undefined,
      stopReason: undefined,
    });
  });

  it('parses a fully populated started event', () => {
    const line = parseRsiEngineEvent(JSON.stringify({
      type: 'rsi_engine_event',
      event: 'started',
      id: 'req-1',
      iteration: 0,
      bestScore: null,
      costSoFarUsd: 0.0,
      concurrency: 1,
    }));
    expect(line).toEqual({
      type: 'rsi_engine_event',
      event: 'started',
      id: 'req-1',
      iteration: 0,
      bestScore: null,
      costSoFarUsd: 0.0,
      concurrency: 1,
      stopReason: undefined,
    });
  });

  it('parses a stopped event with stopReason', () => {
    const line = parseRsiEngineEvent(JSON.stringify({
      type: 'rsi_engine_event',
      event: 'stopped',
      id: 'req-2',
      iteration: 42,
      bestScore: 73.4,
      costSoFarUsd: 1.23,
      stopReason: 'UserStopped',
    }));
    expect(line?.event).toBe('stopped');
    expect(line?.iteration).toBe(42);
    expect(line?.bestScore).toBeCloseTo(73.4);
    expect(line?.costSoFarUsd).toBeCloseTo(1.23);
    expect(line?.stopReason).toBe('UserStopped');
    expect(line?.concurrency).toBeUndefined();
  });

  it('parses a concurrency_set event (only concurrency present)', () => {
    const line = parseRsiEngineEvent(JSON.stringify({
      type: 'rsi_engine_event',
      event: 'concurrency_set',
      id: 'req-3',
      concurrency: 4,
    }));
    expect(line?.event).toBe('concurrency_set');
    expect(line?.concurrency).toBe(4);
    expect(line?.iteration).toBeUndefined();
  });

  it('parses a progress event (no id — progress lines are not acks)', () => {
    const line = parseRsiEngineEvent(JSON.stringify({
      type: 'rsi_engine_event',
      event: 'progress',
      iteration: 5,
      bestScore: 60.0,
      costSoFarUsd: 0.5,
    }));
    expect(line?.event).toBe('progress');
    expect(line?.id).toBeUndefined();
    expect(line?.iteration).toBe(5);
    expect(line?.bestScore).toBeCloseTo(60.0);
    expect(line?.costSoFarUsd).toBeCloseTo(0.5);
  });

  it('drops fields with the wrong type instead of coercing', () => {
    // Rust guarantees correct types but defensive parsing stops a
    // future Rust regression from silently rendering NaN or
    // "undefined" in the UI.
    const line = parseRsiEngineEvent(JSON.stringify({
      type: 'rsi_engine_event',
      event: 'started',
      id: 42,                       // should be a string
      iteration: '5',               // should be a number
      bestScore: '73.4',            // should be number or null
      costSoFarUsd: true,           // should be a number
      concurrency: null,            // should be a number
      stopReason: 42,               // should be a string
    }));
    expect(line?.id).toBeUndefined();
    expect(line?.iteration).toBeUndefined();
    expect(line?.bestScore).toBeUndefined();
    expect(line?.costSoFarUsd).toBeUndefined();
    expect(line?.concurrency).toBeUndefined();
    expect(line?.stopReason).toBeUndefined();
  });

  it('preserves explicit null for bestScore (engine started with no eval yet)', () => {
    const line = parseRsiEngineEvent(JSON.stringify({
      type: 'rsi_engine_event',
      event: 'started',
      id: 'req-n',
      bestScore: null,
    }));
    expect(line?.bestScore).toBeNull();
  });
});
