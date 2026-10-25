function eoMangleKey(key) {
  const mangled = String(key).replace(/[^A-Za-z0-9]|_/g, (ch) => "_x" + ch.charCodeAt(0).toString(16).padStart(2, "0") + "_");
  if (mangled.length > 512) throw new Error("EO KV key too long after mangling: " + mangled.length);
  return mangled;
}

function eoDemangleKey(key) {
  return String(key).replace(/_x([0-9a-f]{2})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function eoWrapKV(raw) {
  return {
    async put(key, value, opts) {
      const ttl = opts && typeof opts.expirationTtl === "number" && opts.expirationTtl > 0 ? opts.expirationTtl : 0;
      const envelope = JSON.stringify({ w: 1, k: eoMangleKey(key), e: ttl > 0 ? Date.now() + ttl * 1000 : 0, v: String(value) });
      await raw.put(eoMangleKey(key), envelope);
    },
    async get(key, t) {
      const wantJson = t === "json" || (t && typeof t === "object" && t.type === "json");
      const stored = await raw.get(eoMangleKey(key), { type: "text" });
      if (stored === null || stored === undefined) return null;
      let parsed;
      try {
        parsed = JSON.parse(stored);
      } catch (e) {
        parsed = null;
      }
      const isEnvelope = parsed && parsed.w === 1 && typeof parsed.v === "string" && typeof parsed.e === "number" && parsed.k === eoMangleKey(key);
      if (isEnvelope) {
        if (parsed.e > 0 && Date.now() > parsed.e) {
          return null;
        }
        if (!wantJson) return parsed.v;
        try {
          return JSON.parse(parsed.v);
        } catch (e) {
          return null;
        }
      }
      if (!wantJson) return stored;
      try {
        return JSON.parse(stored);
      } catch (e) {
        return null;
      }
    },
    async delete(key) {
      await raw.delete(eoMangleKey(key));
    },
    async list(opts) {
      const prefix = opts && typeof opts.prefix === "string" ? opts.prefix : "";
      const req = { prefix: eoMangleKey(prefix) };
      if (opts && typeof opts.limit === "number" && opts.limit > 0) req.limit = opts.limit;
      if (opts && typeof opts.cursor === "string" && opts.cursor) req.cursor = opts.cursor;
      const result = await raw.list(req);
      return {
        keys: (result.keys || []).map((k) => ({ name: eoDemangleKey(k.key) })),
        list_complete: result.complete !== false,
        cursor: result.cursor || undefined
      };
    }
  };
}

if (!(globalThis.fetch && globalThis.fetch.__eoWrapped)) {
  const eoNativeFetch = globalThis.fetch;
  const eoWrappedFetch = function (input, init) {
    const sig = init && init.signal;
    if (!sig) return eoNativeFetch.call(globalThis, input, init);
    let done = false;
    let rejectAbort = null;
    const onAbort = () => {
      if (done) return;
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      if (rejectAbort) rejectAbort(err);
    };
    const detach = () => {
      try { sig.removeEventListener("abort", onAbort); } catch (e) {}
    };
    const nativeP = eoNativeFetch.call(globalThis, input, init);
    nativeP.then(() => { done = true; detach(); }, () => { done = true; detach(); });
    nativeP.catch(() => {});
    return Promise.race([
      nativeP,
      new Promise((resolve, reject) => {
        rejectAbort = reject;
        if (sig.aborted) {
          onAbort();
          return;
        }
        sig.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  };
  eoWrappedFetch.__eoWrapped = true;
  globalThis.fetch = eoWrappedFetch;
}

function buildEnv(context) {
  const raw = (context.env && context.env.MUSIC_KV) || globalThis.MUSIC_KV;
  const env = Object.assign({}, context.env);
  if (raw) env.MUSIC_KV = eoWrapKV(raw);
  return env;
}
