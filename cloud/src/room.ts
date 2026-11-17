import { DurableObject } from "cloudflare:workers";
// Same rules file the browser uses.
import { fromMoves, legalColumns, result } from "../public/js/rules.js";

export type Mode = "friend" | "claude";

interface Player {
  token: string;
  name: string;
  claude?: boolean;
  wins: number;
  account?: string;            // leaderboard account key when signed in
}

interface RoomState {
  id: string;
  mode: Mode;
  players: Player[];           // players[game % 2] is Red (moves first) in each game
  joinerFirst: boolean;        // does the next human to arrive take the first seat (Red in game 1)?
  game: number;
  moves: number[];
  winner: number | null;       // seat 1 | 2, 0 = draw, null = in progress
  line: number[][] | null;
  draws: number;
  rematch: string[];           // tokens that asked for a rematch
  comment: string;             // Claude's latest table talk
  created: number;
  updated: number;
}

const CLAUDE = "claude";
const EMOJIS = ["👍", "😂", "😮", "😡", "🔥", "🎉", "🤔", "👋"];
const TTL = 7 * 24 * 3600 * 1000; // rooms vanish after a week without activity

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const newToken = () => crypto.randomUUID().replace(/-/g, "");
const cleanName = (s: unknown, fallback: string) =>
  (typeof s === "string" ? s : "").replace(/[^\p{L}\p{N} _.\-]/gu, "").trim().slice(0, 20) || fallback;

export class Room extends DurableObject<Env> {
  s: RoomState | null = null;
  waiters: Array<() => void> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<RoomState>("s")) ?? null;
    });
  }

  // ------------------------------------------------------------ helpers
  seatOf(token: string): number | null {
    const s = this.s!;
    const i = s.players.findIndex((p) => p.token === token);
    if (i < 0) return null;
    return i === s.game % 2 ? 1 : 2;
  }
  playerAt(seat: number): Player | undefined {
    const s = this.s!;
    return s.players[seat === 1 ? s.game % 2 : (s.game + 1) % 2];
  }
  turn(): number {
    return this.s!.moves.length % 2 === 0 ? 1 : 2;
  }
  ready(): boolean {
    return this.s!.players.length === 2;
  }

  view(token: string | null) {
    const s = this.s!;
    const { board, heights } = fromMoves(s.moves);
    const online = new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as { token: string }).token));
    return {
      id: s.id,
      mode: s.mode,
      game: s.game,
      moves: s.moves,
      board,
      legal: legalColumns(heights),
      turn: this.turn(),
      winner: s.winner,
      line: s.line,
      draws: s.draws,
      ready: this.ready(),
      comment: s.comment,
      rematch: s.rematch.map((t) => this.seatOf(t)),
      you: token ? this.seatOf(token) : null,
      players: [1, 2].map((seat) => {
        const p = this.playerAt(seat);
        return p
          ? { seat, name: p.name, claude: !!p.claude, wins: p.wins, online: !!p.claude || online.has(p.token) }
          : { seat, name: null, claude: false, wins: 0, online: false };
      }),
    };
  }

  async save() {
    const s = this.s!;
    s.updated = Date.now();
    await this.ctx.storage.put("s", s);
    await this.ctx.storage.setAlarm(Date.now() + TTL);
    for (const ws of this.ctx.getWebSockets()) {
      const { token } = ws.deserializeAttachment() as { token: string };
      try {
        ws.send(JSON.stringify({ type: "state", state: this.view(token) }));
      } catch { /* socket closing */ }
    }
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch { /* ignore */ }
    }
  }

  move(token: string, col: number, comment?: string): string | null {
    const s = this.s!;
    if (!this.ready()) return "Waiting for the second player to join.";
    if (s.winner !== null) return "The game is over. Ask for a rematch to play again.";
    const seat = this.seatOf(token);
    if (seat === null) return "You are not a player in this room.";
    if (seat !== this.turn()) return "It is not your turn.";
    const { heights } = fromMoves(s.moves);
    if (!Number.isInteger(col) || col < 0 || col > 6 || heights[col] >= 6) return "That column is full or does not exist.";
    s.moves.push(col);
    if (token === CLAUDE) s.comment = (comment || "").slice(0, 200);
    const r = result(fromMoves(s.moves).board);
    if (r) {
      s.winner = r.winner;
      s.line = r.line;
      if (r.winner === 0) s.draws++;
      else this.playerAt(r.winner)!.wins++;
    }
    return null;
  }

  rematch(token: string): boolean {
    const s = this.s!;
    if (s.winner === null || this.seatOf(token) === null) return false;
    if (!s.rematch.includes(token)) s.rematch.push(token);
    // vs Claude either side can restart; friends both have to agree
    if (s.mode === "claude" || s.players.every((p) => s.rematch.includes(p.token))) {
      s.game++;           // seats swap: the other player opens the next game
      s.moves = [];
      s.winner = null;
      s.line = null;
      s.rematch = [];
      s.comment = "";
    }
    return true;
  }

  // ------------------------------------------------------------ HTTP API (from the Worker)
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/init" && req.method === "POST") {
      if (this.s) return json({ error: "exists" }, 409);
      const body = (await req.json()) as { id: string; mode: Mode; first: string; name?: string; byClaude?: boolean; auth?: string };
      const mode: Mode = body.mode === "claude" ? "claude" : "friend";
      // `first` names who opens game 1: "me" (room creator), "them" (friend / Claude) or "random".
      // In claude rooms "me" is always the human, even when Claude created the room.
      const flip = Math.random() < 0.5;
      const humanFirst = body.first === "random" ? flip : body.first !== "them" && body.first !== "claude";
      const joinerFirst = mode === "claude" ? humanFirst : !humanFirst;
      this.s = {
        id: body.id, mode, players: [], joinerFirst, game: 0, moves: [], winner: null, line: null,
        draws: 0, rematch: [], comment: "", created: Date.now(), updated: Date.now(),
      };
      let token: string | null = null;
      if (mode === "claude") this.s.players.push({ token: CLAUDE, name: "Claude", claude: true, wins: 0 });
      if (!body.byClaude) {
        token = newToken();
        this.addHuman(token, cleanName(body.name, mode === "claude" ? "You" : "Player 1"));
        await this.linkAccount(token, body.auth);
      }
      await this.save();
      return json({ id: body.id, token });
    }

    if (!this.s) return json({ error: "Room not found" }, 404);

    if (path === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
      let token = url.searchParams.get("token") || "";
      let joined = false;
      if (!this.s.players.some((p) => p.token === token)) {
        token = "";
        if (this.s.players.length < 2) {
          token = newToken();
          this.addHuman(token, cleanName(url.searchParams.get("name"), this.s.mode === "claude" ? "You" : "Player 2"));
          joined = true;
        }
      }
      if (token) {
        const p = this.s.players.find((p) => p.token === token)!;
        const before = p.account;
        await this.linkAccount(token, url.searchParams.get("auth") || undefined);
        if (p.account !== before) joined = true; // re-broadcast the new name
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ token });
      pair[1].send(JSON.stringify({ type: "welcome", token: token || null }));
      if (joined) await this.save();
      else pair[1].send(JSON.stringify({ type: "state", state: this.view(token) }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (path === "/state") return json(this.view(url.searchParams.get("token")));

    // ---- Claude (MCP) endpoints
    if (path === "/claude/wait") {
      const timeout = Math.min(Number(url.searchParams.get("timeout")) || 40, 50) * 1000;
      const done = () => this.s!.mode !== "claude" || this.s!.winner !== null || (this.ready() && this.turn() === this.seatOf(CLAUDE));
      if (!done()) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, timeout);
          const check = () => {
            if (done()) { clearTimeout(t); resolve(); } else this.waiters.push(check);
          };
          this.waiters.push(check);
        });
      }
      return json(this.view(CLAUDE));
    }
    if (path === "/claude/move" && req.method === "POST") {
      if (this.s.mode !== "claude") return json({ error: "This is not a Claude room." }, 400);
      const { col, comment } = (await req.json()) as { col: number; comment?: string };
      const err = this.move(CLAUDE, col, comment);
      if (err) return json({ error: err, state: this.view(CLAUDE) }, 400);
      await this.save();
      await this.recordIfOver();
      return json(this.view(CLAUDE));
    }
    if (path === "/claude/rematch" && req.method === "POST") {
      if (this.s.mode !== "claude") return json({ error: "This is not a Claude room." }, 400);
      if (!this.rematch(CLAUDE)) return json({ error: "The current game is still in progress." }, 400);
      await this.save();
      return json(this.view(CLAUDE));
    }
    return json({ error: "Not found" }, 404);
  }

  leaderboard() {
    return this.env.LEADERBOARD.get(this.env.LEADERBOARD.idFromName("global"));
  }

  /** Attach a signed-in leaderboard account (session token) to a room player. */
  async linkAccount(token: string, auth?: string) {
    if (!auth) return;
    const res = await this.leaderboard().fetch("https://lb/me", { method: "POST", body: JSON.stringify({ token: auth }) });
    if (!res.ok) return;
    const { name, key } = (await res.json()) as { name: string; key: string };
    const p = this.s!.players.find((p) => p.token === token);
    if (p) { p.account = key; p.name = name; }
  }

  /** After a finished game, store the result for every signed-in human. */
  async recordIfOver() {
    const s = this.s!;
    if (s.winner === null) return;
    for (const p of s.players) {
      if (!p.account) continue;
      const seat = this.seatOf(p.token);
      const other = s.players.find((q) => q !== p);
      const outcome = s.winner === 0 ? "draw" : s.winner === seat ? "win" : "loss";
      await this.leaderboard().fetch("https://lb/record", {
        method: "POST",
        body: JSON.stringify({
          key: p.account, mode: s.mode, outcome, moves: s.moves.length,
          opponent: other?.name || "?", gid: `${s.id}:${s.game}:${p.account}`,
        }),
      });
    }
  }

  /** players[0] is Red in game 1, so a player who should start goes to the front. */
  addHuman(token: string, name: string) {
    const s = this.s!;
    const p: Player = { token, name, wins: 0 };
    if (s.joinerFirst) s.players.unshift(p); else s.players.push(p);
  }

  // ------------------------------------------------------------ WebSocket (hibernation API)
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (!this.s || typeof raw !== "string") return;
    const { token } = ws.deserializeAttachment() as { token: string };
    let msg: { type?: string; col?: number; name?: string; e?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
    if (!token) return; // spectators can only watch
    if (msg.type === "move") {
      const err = this.move(token, Number(msg.col));
      if (err) return ws.send(JSON.stringify({ type: "error", message: err }));
      await this.save();
      await this.recordIfOver();
    } else if (msg.type === "rematch") {
      if (this.rematch(token)) await this.save();
    } else if (msg.type === "name") {
      const p = this.s.players.find((p) => p.token === token);
      if (p) { p.name = cleanName(msg.name, p.name); await this.save(); }
    } else if (msg.type === "emoji" && EMOJIS.includes(msg.e || "")) {
      this.broadcast({ type: "emoji", seat: this.seatOf(token), e: msg.e });
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code, "bye"); } catch { /* already closed */ }
    if (this.s) await this.save(); // refresh online dots
  }

  async alarm() {
    if (this.s && Date.now() - this.s.updated >= TTL - 60_000) {
      await this.ctx.storage.deleteAll();
      this.s = null;
    }
  }
}
