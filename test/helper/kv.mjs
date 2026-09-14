const isPlainString = (v) => typeof v === "string";

export function createKV(seed = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(seed)) {
    store.set(k, isPlainString(v) ? v : JSON.stringify(v));
  }

  const parseIf = (raw, opts) => {
    if (raw == null) return null;
    const want = opts === "json" || (opts && opts.type === "json");
    if (!want) return raw;
    try { return JSON.parse(raw); } catch { return null; }
  };

  const kv = {
    __store: store,
    __puts: [],
    async get(key, opts) {
      if (!store.has(key)) return null;
      return parseIf(store.get(key), opts);
    },
    async put(key, value, opts) {
      kv.__puts.push({ key, value, opts: opts ? JSON.parse(JSON.stringify(opts)) : undefined });
      store.set(key, isPlainString(value) ? value : String(value));
    },
    async delete(key) { store.delete(key); },
    async list(opts = {}) {
      const prefix = (opts && opts.prefix) || "";
      const keys = [];
      for (const name of store.keys()) {
        if (name.startsWith(prefix)) keys.push({ name });
      }
      return { keys, list_complete: true, cursor: undefined };
    },
  };
  return kv;
}

export function makeEnv(seedKV) {
  const env = {};
  if (seedKV === null || seedKV === undefined) return env;
  env.MUSIC_KV = createKV(seedKV);
  return env;
}