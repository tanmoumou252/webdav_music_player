async function hashAdminPass(p) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(p));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function isValidSourceUrl(u) {
  if (typeof u !== "string" || !/^https?:\/\//i.test(u)) return false;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch (e) {
    return false;
  }
}

async function createSession(env) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  await env.MUSIC_KV.put("session_" + token, JSON.stringify({ created: Date.now() }), { expirationTtl: 2592000 });
  return token;
}

async function isSessionValid(env, token) {
  if (!token) return false;
  return (await env.MUSIC_KV.get("session_" + token)) !== null;
}

function sessionCookie(token) {
  return "admin_token=" + token + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000";
}

function clearedSessionCookie() {
  return "admin_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
}

