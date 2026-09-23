import { describe, expect, it } from 'vitest';
import { describeFrame } from '../frameLog';

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
