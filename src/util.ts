/**
 * Small dependency-free utilities shared across the provider.
 *
 * We deliberately avoid `p-limit` (ESM-only in current majors, awkward from a
 * CommonJS build) and ship a tiny bounded-concurrency mapper instead.
 */

/**
 * Map over `items` running at most `concurrency` tasks at once, preserving
 * input order in the results. The first rejection aborts the pool: in-flight
 * tasks are allowed to settle but no new tasks start, and the rejection is
 * rethrown. Callers that need per-item outcomes should have their `fn` catch
 * and return a result object instead of throwing.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let aborted = false;

  async function worker(): Promise<void> {
    while (!aborted) {
      const current = nextIndex++;
      if (current >= items.length) return;
      try {
        results[current] = await fn(items[current] as T, current);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/** Strip leading and trailing slashes from a string. */
export function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Collapse runs of slashes and remove leading/trailing ones. */
export function normalizeSlashes(value: string): string {
  return trimSlashes(value.replace(/\/{2,}/g, '/'));
}

/** Join path-ish segments with single slashes, ignoring empty parts. */
export function joinKey(...parts: Array<string | undefined>): string {
  return parts
    .filter((p): p is string => Boolean(p && p.length))
    .map((p) => trimSlashes(p))
    .filter((p) => p.length)
    .join('/');
}
