// Translation limits per user or IP (docs/SPEC.md §8.4): validation runs on
// our CPU, so at most a few translations at once and a cap per window.

export class TranslationLimits {
  private readonly running = new Map<string, number>();
  private readonly recent = new Map<string, number[]>();
  private readonly maxConcurrent: number;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(maxConcurrent: number, maxPerWindow: number, windowMs = 10 * 60_000, now = Date.now) {
    this.maxConcurrent = maxConcurrent;
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** A release function, or why the request must wait. */
  acquire(who: string): { release: () => void } | { refused: "busy" | "rate_limited" } {
    const now = this.now();
    const times = (this.recent.get(who) ?? []).filter((t) => now - t < this.windowMs);
    if (times.length >= this.maxPerWindow) {
      this.recent.set(who, times);
      return { refused: "rate_limited" };
    }
    const running = this.running.get(who) ?? 0;
    if (running >= this.maxConcurrent) return { refused: "busy" };
    times.push(now);
    this.recent.set(who, times);
    this.running.set(who, running + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const n = (this.running.get(who) ?? 1) - 1;
        if (n <= 0) this.running.delete(who);
        else this.running.set(who, n);
      },
    };
  }
}
