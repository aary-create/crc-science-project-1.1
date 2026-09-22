// A small per-server-instance cache for upstream responses. Used instead of
// Next's fetch cache on purpose: Next keeps serving a stale copy when a
// refresh fails, which would make a dead alert feed look "connected". Here a
// failed refresh is a failure — the caller reports it honestly — and a
// success is reused for `ttlMs` so the government feeds aren't hit on every
// page view. Concurrent callers share one in-flight request.

type Entry = { at: number; value: unknown };
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
const MAX = 500;

export async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<{ value: T; at: number }> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { value: hit.value as T, at: hit.at };
  let p = inflight.get(key);
  if (!p) {
    p = fn()
      .then((value) => {
        const e = { at: Date.now(), value };
        store.delete(key);
        store.set(key, e);
        if (store.size > MAX) store.delete(store.keys().next().value!);
        return e;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const e = await p;
  return { value: e.value as T, at: e.at };
}
