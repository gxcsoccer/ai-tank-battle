/**
 * Google sign-in (OAuth 2.0 authorization code flow + PKCE).
 *
 * The session is a stateless HMAC-signed cookie, so no KV/D1 is needed. Signing
 * in is required to play; without GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET the
 * routes report `enabled: false` and nobody can join a room.
 */

export interface User {
  sub: string; // Google account id (never sent to other players)
  name: string;
  email: string;
  picture: string;
}

interface AuthEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
}

const SESSION_COOKIE = "tk_session";
const STATE_COOKIE = "tk_oauth";
const SESSION_TTL = 30 * 24 * 3600; // seconds
const STATE_TTL = 600;
/** Header the Worker uses to pass the verified user to the room Durable Object. */
export const USER_HEADER = "X-Tank-User";

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

const config = (env: unknown) => {
  const e = env as AuthEnv;
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) return null;
  return {
    clientId: e.GOOGLE_CLIENT_ID,
    clientSecret: e.GOOGLE_CLIENT_SECRET,
    // Fall back to a key derived from the client secret so local setup needs only two values.
    key: e.SESSION_SECRET || `tank-session:${e.GOOGLE_CLIENT_SECRET}`,
  };
};

// ---- signed cookie values ------------------------------------------------------

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data))));
}

async function seal(key: string, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(key, body)}`;
}

async function unseal<T extends { exp: number }>(key: string, value: string | undefined): Promise<T | null> {
  if (!value) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  const expected = await hmac(key, body);
  // Length check first, then constant-time compare.
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  try {
    const data = JSON.parse(dec.decode(unb64url(body))) as T;
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function cookie(url: URL, name: string, value: string, maxAge: number, path = "/"): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/** Only allow same-site relative redirects. */
const safeNext = (next: string | null) => (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/");

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
};

// ---- public API ------------------------------------------------------------

export async function currentUser(req: Request, env: unknown): Promise<User | null> {
  const cfg = config(env);
  if (!cfg) return null;
  const s = await unseal<User & { exp: number }>(cfg.key, getCookie(req, SESSION_COOKIE));
  return s ? { sub: s.sub, name: s.name, email: s.email, picture: s.picture } : null;
}

/** Handles /auth/* and /api/me. Returns null for any other path. */
export async function handleAuth(req: Request, env: unknown): Promise<Response | null> {
  const url = new URL(req.url);
  const cfg = config(env);

  if (url.pathname === "/api/me") {
    const user = await currentUser(req, env);
    return Response.json(
      { enabled: !!cfg, user: user && { name: user.name, email: user.email, picture: user.picture } },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (url.pathname === "/auth/logout") {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    return new Response(null, { status: 204, headers: { "Set-Cookie": cookie(url, SESSION_COOKIE, "", 0) } });
  }

  if (url.pathname === "/auth/google") {
    if (!cfg) return redirect("/?login_error=disabled");
    const state = randomToken(16);
    const verifier = randomToken(32);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
    const sealed = await seal(cfg.key, { state, verifier, next: safeNext(url.searchParams.get("next")), exp: Date.now() / 1000 + STATE_TTL });
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: `${url.origin}/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return redirect(auth.toString(), [cookie(url, STATE_COOKIE, sealed, STATE_TTL, "/auth")]);
  }

  if (url.pathname === "/auth/google/callback") {
    if (!cfg) return redirect("/?login_error=disabled");
    const clearState = cookie(url, STATE_COOKIE, "", 0, "/auth");
    const saved = await unseal<{ state: string; verifier: string; next: string; exp: number }>(cfg.key, getCookie(req, STATE_COOKIE));
    const fail = (reason: string) => {
      const back = new URL(saved?.next ?? "/", url.origin);
      back.searchParams.set("login_error", reason);
      return redirect(back.pathname + back.search, [clearState]);
    };
    if (url.searchParams.get("error")) return fail(url.searchParams.get("error") === "access_denied" ? "denied" : "google");
    const code = url.searchParams.get("code");
    if (!saved || !code || url.searchParams.get("state") !== saved.state) return fail("state");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: `${url.origin}/auth/google/callback`,
        grant_type: "authorization_code",
        code_verifier: saved.verifier,
      }),
    });
    if (!tokenRes.ok) {
      console.error("google token exchange failed", tokenRes.status, await tokenRes.text());
      return fail("token");
    }
    const { id_token } = (await tokenRes.json()) as { id_token?: string };
    // The ID token came straight from Google's token endpoint over TLS, so per
    // OpenID Connect §3.1.3.7 we may skip signature checks; still verify claims.
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(dec.decode(unb64url(String(id_token).split(".")[1])));
    } catch {
      return fail("token");
    }
    const now = Date.now() / 1000;
    if (
      !["accounts.google.com", "https://accounts.google.com"].includes(String(claims.iss)) ||
      claims.aud !== cfg.clientId ||
      Number(claims.exp) < now ||
      typeof claims.sub !== "string"
    ) {
      return fail("token");
    }
    const user: User = {
      sub: claims.sub,
      name: String(claims.name ?? claims.given_name ?? claims.email ?? "").slice(0, 40),
      email: String(claims.email ?? ""),
      picture: String(claims.picture ?? ""),
    };
    const session = await seal(cfg.key, { ...user, exp: now + SESSION_TTL });
    return redirect(saved.next, [clearState, cookie(url, SESSION_COOKIE, session, SESSION_TTL)]);
  }

  return null;
}

/** Encodes the verified user for the room DO (only public-safe fields plus the stable id). */
export const encodeUserHeader = (u: User) => b64url(enc.encode(JSON.stringify({ sub: u.sub, name: u.name, picture: u.picture })));

export function decodeUserHeader(v: string | null): Pick<User, "sub" | "name" | "picture"> | null {
  if (!v) return null;
  try {
    const u = JSON.parse(dec.decode(unb64url(v)));
    return typeof u.sub === "string" ? { sub: u.sub, name: String(u.name ?? ""), picture: String(u.picture ?? "") } : null;
  } catch {
    return null;
  }
}
