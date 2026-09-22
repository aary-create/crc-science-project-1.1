import { kvGet, kvSet } from "./store";

// Caches each alert's AI explanation on-device, keyed by alert id and
// language, for 5 days — the same retention as the rest of the local history.
// A given alert's explanation is fetched from the API at most once per
// device; every view after that, online or offline, reads this cache.
const KEY = "ss:aiExplain";
const RETAIN_MS = 5 * 24 * 60 * 60 * 1000;

type Cache = Record<string, { text: string; timestamp: string }>;

async function read(): Promise<Cache> {
  const raw = await kvGet<Cache>(KEY);
  return raw && typeof raw === "object" ? raw : {};
}

function prune(cache: Cache): Cache {
  const cutoff = Date.now() - RETAIN_MS;
  const out: Cache = {};
  for (const [id, entry] of Object.entries(cache)) {
    if (new Date(entry.timestamp).getTime() >= cutoff) out[id] = entry;
  }
  return out;
}

export async function getCachedExplanation(alertId: string, lang: string): Promise<string | null> {
  return prune(await read())[`${alertId}|${lang}`]?.text ?? null;
}

export async function cacheExplanation(alertId: string, lang: string, text: string) {
  const cache = prune(await read());
  cache[`${alertId}|${lang}`] = { text, timestamp: new Date().toISOString() };
  await kvSet(KEY, cache);
}
