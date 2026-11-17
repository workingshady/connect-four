import { handleMcp } from "./mcp";
import { createRoom, roomStub } from "./rooms";

export { Room } from "./room";
export { Leaderboard } from "./leaderboard";
import { fromMoves, result } from "../public/js/rules.js";
import { LEVEL_POINTS } from "./leaderboard";

const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/mcp" || path === "/mcp/") return handleMcp(req, env);

    if (path === "/api/rooms" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { mode?: string; first?: string; name?: string };
      const room = await createRoom(env, {
        mode: body.mode === "claude" ? "claude" : "friend", first: body.first, name: body.name, auth: bearer(req) || undefined,
      });
      return Response.json(room);
    }

    const m = path.match(/^\/api\/rooms\/([A-Za-z0-9]{6})(\/ws)?$/);
    if (m) {
      const id = m[1].toUpperCase();
      const stub = roomStub(env, id);
      if (m[2]) return stub.fetch(`https://room/ws${url.search}`, req);
      return stub.fetch(`https://room/state${url.search}`);
    }

    // ---- accounts & leaderboard
    const lb = env.LEADERBOARD.get(env.LEADERBOARD.idFromName("global"));
    const post = (p: string, data: unknown) => lb.fetch(`https://lb${p}`, { method: "POST", body: JSON.stringify(data) });
    if (path === "/api/auth" && req.method === "POST") return post("/auth", await req.json().catch(() => ({})));
    if (path === "/api/auth/check" && req.method === "POST") return post("/check", await req.json().catch(() => ({})));
    if (path === "/api/me") return post("/me", { token: bearer(req) });
    if (path === "/api/logout" && req.method === "POST") return post("/logout", { token: bearer(req) });
    if (path === "/api/leaderboard") return lb.fetch(`https://lb/board${url.search}`);
    if (path === "/api/stats") return lb.fetch("https://lb/stats");
    const pm = path.match(/^\/api\/players\/(.+)$/);
    if (pm) return lb.fetch(`https://lb/player?name=${encodeURIComponent(decodeURIComponent(pm[1]))}`);

    if (path === "/api/results" && req.method === "POST") {
      // Games vs the browser AI: replay the moves to check the claimed result.
      const b = (await req.json().catch(() => ({}))) as { gid?: string; level?: string; moves?: number[]; seat?: number };
      const moves = Array.isArray(b.moves) ? b.moves : [];
      if (!(String(b.level) in LEVEL_POINTS) || (b.seat !== 1 && b.seat !== 2) || moves.length < 7 || moves.length > 42)
        return Response.json({ error: "Invalid game" }, { status: 400 });
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const { board, heights } = fromMoves(moves.slice(0, i));
        if (!Number.isInteger(m) || m < 0 || m > 6 || heights[m] >= 6 || result(board)) {
          return Response.json({ error: "Invalid move sequence" }, { status: 400 });
        }
      }
      const r = result(fromMoves(moves).board);
      if (!r) return Response.json({ error: "Game not finished" }, { status: 400 });
      const outcome = r.winner === 0 ? "draw" : r.winner === b.seat ? "win" : "loss";
      return post("/record", {
        token: bearer(req), mode: "ai", level: b.level, outcome, moves: moves.length,
        opponent: `AI (${b.level})`, gid: String(b.gid || crypto.randomUUID()).slice(0, 64),
      });
    }

    if (path.startsWith("/api/")) return Response.json({ error: "Not found" }, { status: 404 });
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
