/**
 * concurrency.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared worker-pool primitive with a hard kill-switch.
 *
 * Why this exists: AbortSignal.timeout() does not reliably propagate through
 * undici when going through the Decodo residential proxy. Observed behavior:
 * a fetch will occasionally hang forever past its declared timeout, the
 * abort never fires, and the worker slot is permanently consumed. With
 * concurrency=4, four such hangs deadlock the entire pool and the process
 * sits idle until the operator notices.
 *
 * The fix is an outer Promise.race against a setTimeout-driven kill timer
 * that does not depend on the fetch itself cooperating. The hung fetch is
 * orphaned (it'll resolve or fail eventually and its result is dropped),
 * but the worker continues.
 */

export interface RunPoolOpts {
  /** Worker concurrency. Capped at items.length. */
  concurrency: number;
  /** Hard timeout per item in ms. Worker rejects with `RunPoolTimeoutError`. */
  hardTimeoutMs: number;
  /** Sleep between successive items per worker, ms (politeness). */
  delayBetweenMs?: number;
}

export class RunPoolTimeoutError extends Error {
  constructor(public readonly itemIndex: number, public readonly limitMs: number) {
    super(`worker hard-timeout after ${limitMs}ms (item index ${itemIndex})`);
    this.name = "RunPoolTimeoutError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wrap a promise in an outer hard timeout. The original promise is NOT
 * aborted — it's left to resolve/reject on its own (orphaned) — but the
 * caller gets control back at `limitMs`.
 */
export function withHardTimeout<T>(
  p: Promise<T>,
  limitMs: number,
  itemIndex: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const killer = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RunPoolTimeoutError(itemIndex, limitMs)),
      limitMs,
    );
  });
  return Promise.race([p, killer]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Run `worker` over `items` with bounded concurrency and a per-item hard
 * timeout. The worker callback receives the item plus its original index
 * for logging. A timeout in the worker is surfaced to the worker callback
 * itself only if the worker chose to wrap; the runPool's job is to ensure
 * a single hung item cannot starve the pool.
 *
 * Worker exceptions (including the hard-timeout) are swallowed at this
 * layer and logged to stderr. Each worker is responsible for its own
 * accounting — runPool returns void.
 */
export async function runPool<T>(
  items: T[],
  opts: RunPoolOpts,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const { concurrency, hardTimeoutMs, delayBetweenMs = 0 } = opts;
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        try {
          await withHardTimeout(worker(items[idx], idx), hardTimeoutMs, idx);
        } catch (e) {
          // Item-level failure must not kill the pool. Log + continue.
          console.error(`[runPool] item ${idx} failed:`, (e as Error).message);
        }
        if (delayBetweenMs > 0) await sleep(delayBetweenMs);
      }
    },
  );
  await Promise.all(runners);
}
