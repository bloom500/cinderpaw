import { describe, expect, it } from 'vitest';
import { describeFrame, frameStats } from '../frameLog';

describe('describeFrame', () => {
  it('names the script that held the frame longest', () => {
    const line = describeFrame({
      duration: 312.4, blockingDuration: 262, scripts: [
        { duration: 20, invoker: 'a', sourceFunctionName: 'small', sourceURL: 'x/a.js' },
        { duration: 240, invoker: 'FrameRequestCallback', sourceFunctionName: 'tick', sourceURL: 'http://x/assets/MoltenOrb.js' },
      ],
    } as never);
    expect(line).toBe('frame=312ms blocking=262ms top=240ms FrameRequestCallback tick@MoltenOrb.js');
  });

  it('says so when no script is to blame', () => {
    expect(describeFrame({ duration: 200, blockingDuration: 0, scripts: [] } as never))
      .toBe('frame=200ms blocking=0ms top=none (style/layout/paint)');
  });
});

describe('frameStats, the lab meter summary', () => {
  it('reads a mostly smooth gesture with one hitch', () => {
    const s = frameStats([...Array(19).fill(16.6), 80], 1);
    expect(s).toEqual({ frames: 20, p50: 16.6, p95: 80, longest: 80, smooth: 95, blocked50: 1 });
  });

  it('says nothing was measured instead of inventing numbers', () => {
    expect(frameStats([])).toEqual({ frames: 0, p50: 0, p95: 0, longest: 0, smooth: 0, blocked50: 0 });
  });
});
