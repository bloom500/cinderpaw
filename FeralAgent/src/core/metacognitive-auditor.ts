/**
 * Metacognitive Auditor Module.
 *
 * Monitors search score progression and detects stagnation. When scores fail to
 * improve after `stagnationThreshold` consecutive evaluations, triggers an assumption reset event.
 */

export interface AuditorConfig {
  stagnationThreshold?: number; // Default: 3
  improvementDelta?: number; // Default: 0.01
}

export type ResetListener = (reason: string, score: number) => void;

export class MetacognitiveAuditor {
  private threshold: number;
  private minDelta: number;
  private bestScore: number = -Infinity;
  private consecutiveStagnantRuns: number = 0;
  private resetTriggeredCount: number = 0;
  private listeners: ResetListener[] = [];

  constructor(config: AuditorConfig = {}) {
    this.threshold = config.stagnationThreshold ?? 3;
    this.minDelta = config.improvementDelta ?? 0.01;
  }

  public onReset(listener: ResetListener): void {
    this.listeners.push(listener);
  }

  public evaluateIterationScore(score: number): boolean {
    if (score > this.bestScore + this.minDelta) {
      this.bestScore = score;
      this.consecutiveStagnantRuns = 0;
      return false; // Progressing normally
    }

    this.consecutiveStagnantRuns++;

    if (this.consecutiveStagnantRuns >= this.threshold) {
      this.triggerReset("stagnation", score);
      return true; // Stagnation detected & reset triggered
    }

    return false;
  }

  public triggerReset(reason: string = "manual", currentScore: number = 0): void {
    this.resetTriggeredCount++;
    this.consecutiveStagnantRuns = 0;
    for (const listener of this.listeners) {
      listener(reason, currentScore);
    }
  }

  public getStats() {
    return {
      bestScore: this.bestScore,
      consecutiveStagnantRuns: this.consecutiveStagnantRuns,
      resetTriggeredCount: this.resetTriggeredCount,
    };
  }

  public reset(): void {
    this.bestScore = -Infinity;
    this.consecutiveStagnantRuns = 0;
    this.resetTriggeredCount = 0;
  }
}
