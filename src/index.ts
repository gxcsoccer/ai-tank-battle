import { currentUser, encodeUserHeader, handleAuth, USER_HEADER } from "./auth";

export { GameRoom } from "./room";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // /ws/<ROOM> -> the room's Durable Object (one instance per room code)
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9_-]{1,16})$/);
    if (m) {
      // Google sign-in is required to play. Reject cross-site handshakes too, since
      // browsers attach cookies to WebSocket upgrades.
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403 });
      const user = await currentUser(request, env);
      if (!user) return new Response("Login required", { status: 401 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1].toUpperCase()));
      // Only the Worker can reach the DO, and it overwrites whatever the client sent.
      const headers = new Headers(request.headers);
      headers.set(USER_HEADER, encodeUserHeader(user));
      return stub.fetch(new Request(request, { headers }));
    }

    const auth = await handleAuth(request, env);
    if (auth) return auth;

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, brainModel: env.BRAIN_MODEL, castModel: env.CAST_MODEL });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
