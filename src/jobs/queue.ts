type Listener = () => void;

/**
 * Runs async jobs with a concurrency limit. Jobs are keyed by scope
 * ("project:C123", "adhoc", ...): asking for a job that's already queued or
 * running returns the same promise instead of starting a second one.
 */
export class JobQueue {
  private jobs = new Map<string, Promise<unknown>>();
  private waiting: (() => void)[] = [];
  private active = 0;
  private listeners = new Set<Listener>();
  private snapshot: string[] = [];

  constructor(private limit = 3) {}

  /**
   * `limited: false` dedupes without taking a slot, for jobs that only wait on
   * other jobs (taking a slot there could deadlock the queue).
   */
  run<T>(key: string, fn: () => Promise<T>, limited = true): Promise<T> {
    const existing = this.jobs.get(key);
    if (existing) return existing as Promise<T>;
    const job = (async () => {
      if (!limited) return fn();
      await this.acquire();
      try {
        return await fn();
      } finally {
        this.release();
      }
    })().finally(() => {
      this.jobs.delete(key);
      this.emit();
    });
    this.jobs.set(key, job);
    this.emit();
    return job;
  }

  has(key: string): boolean {
    return this.jobs.has(key);
  }

  /** Keys of queued and running jobs. Stable between changes, for useSyncExternalStore. */
  keys = (): string[] => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    this.snapshot = [...this.jobs.keys()];
    this.listeners.forEach((l) => l());
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
