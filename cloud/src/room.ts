import { DurableObject } from "cloudflare:workers";
// Same rules file the browser uses.
import { fromMoves, legalColumns, result } from "../public/js/rules.js";
import { modelInfo } from "./models";

export type Mode = "friend" | "claude" | "arena";
type Kind = "human" | "claude" | "ai";

interface Player {
  token: string;
  name: string;
  kind: Kind;
  level?: string;              // computer players
  model?: string;              // Claude players: canonical model id (shared leaderboard account)
  wins: number;
  account?: string;            // leaderboard account key when signed in
}

export interface ChatMsg {
  id: number;
  at: number;
  name: string;
  kind: Kind | "system" | "spectator";
  seat: number | null;
  text: string;
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
  chat: ChatMsg[];
  chatSeq: number;
  host: string | null;         // arena: creator's viewer token (preferred AI driver)
  speed: "fast" | "normal" | "slow";
  autoNext: boolean;
  nextAt: number | null;       // arena: when the next game auto-starts
  created: number;
  updated: number;
}

interface Attachment { token: string; name: string; lastChat?: number }

const EMOJIS = ["👍", "😂", "😮", "😡", "🔥", "🎉", "🤔", "👋"];
const TTL = 7 * 24 * 3600 * 1000;   // rooms vanish after a week without activity
const LEVELS = ["beginner", "easy", "medium", "hard", "expert", "master"];
const LEVEL_NAMES: Record<string, string> = {
  beginner: "Beginner", easy: "Easy", medium: "Medium", hard: "Hard", expert: "Expert", master: "Master",
};
const NEXT_DELAY = { fast: 4000, normal: 7000, slow: 10000 };

// Short lines the computer players drop into the chat, so a match feels like real opponents.
const BANTER = {
  hello: ["Good luck! 🍀", "Let's play.", "Ready when you are.", "May the best player win."],
  block: ["Blocked! 🧱", "Not so fast.", "I saw that coming 👀", "Nice try."],
  threat: ["Your move… 😏", "Watch out.", "Something's brewing.", "Hmm, interesting."],
  idle: ["Hmm…", "Thinking…", "Okay.", "Bold move.", "🤔", "Let's see."],
  win: ["Four in a row! 🎉", "GG! 🏆", "That's game.", "Got you!"],
  lose: ["GG, well played 👏", "You got me.", "Rematch?", "Nicely done."],
  draw: ["A draw - well fought.", "Nobody wins this time 🤝"],
};
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const newToken = () => crypto.randomUUID().replace(/-/g, "");
export const cleanName = (s: unknown, fallback: string) =>
  (typeof s === "string" ? s : "").replace(/[^\p{L}\p{N} _.\-]/gu, "").trim().slice(0, 20) || fallback;
const cleanText = (s: unknown) => (typeof s === "string" ? s : "").replace(/\s+/g, " ").trim().slice(0, 280);

function seatSpec(spec: unknown, claudeTag: string): Player {
  const s = String(spec ?? "");
  if (s === "claude") return { token: claudeTag, name: claudeTag === "claude" ? "Claude" : `Claude ${claudeTag.slice(-1)}`, kind: "claude", wins: 0 };
  const level = LEVELS.includes(s.replace(/^ai:/, "")) ? s.replace(/^ai:/, "") : "medium";
  return { token: `ai-${newToken().slice(0, 8)}`, name: `AI · ${LEVEL_NAMES[level]}`, kind: "ai", level, wins: 0 };
}

export class Room extends DurableObject<Env> {
  s: RoomState | null = null;
  waiters: Array<() => void> = [];
  pendingAI: { game: number; ply: number; at: number; ws: WebSocket } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<RoomState>("s")) ?? null;
      if (this.s) {
        // rooms created before chat/arena existed
        this.s.chat ??= []; this.s.chatSeq ??= 0; this.s.host ??= null;
        this.s.speed ??= "normal"; this.s.autoNext ??= false; this.s.nextAt ??= null;
        for (const p of this.s.players as (Player & { claude?: boolean })[]) p.kind ??= p.claude ? "claude" : "human";
      }
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
  /** Which Claude token an MCP call acts as (`player` = "A" / "B" when two Claudes play). */
  claudeToken(player?: string | null): string | null {
    const claudes = this.s!.players.filter((p) => p.kind === "claude");
    if (!claudes.length) return null;
    const want = player ? `claude-${player.toUpperCase()}` : null;
    return (want && claudes.find((p) => p.token === want)?.token) || (claudes.length === 1 ? claudes[0].token : null);
  }

  view(token: string | null) {
    const s = this.s!;
    const { board, heights } = fromMoves(s.moves);
    const online = new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Attachment).token));
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
      host: !!token && token === s.host,
      speed: s.speed,
      autoNext: s.autoNext,
      nextAt: s.nextAt,
      viewers: this.ctx.getWebSockets().length,
      players: [1, 2].map((seat) => {
        const p = this.playerAt(seat);
        return p
          ? { seat, name: p.name, kind: p.kind, claude: p.kind === "claude", level: p.level ?? null, model: p.model ?? null, wins: p.wins,
              id: p.kind === "claude" ? p.token.replace(/^claude-?/, "") || null : null,
              online: p.kind !== "human" || online.has(p.token) }
          : { seat, name: null, kind: "human", claude: false, level: null, model: null, wins: 0, id: null, online: false };
      }),
    };
  }

  async save() {
    const s = this.s!;
    s.updated = Date.now();
    await this.ctx.storage.put("s", s);
    await this.scheduleAlarm();
    for (const ws of this.ctx.getWebSockets()) {
      const { token } = ws.deserializeAttachment() as Attachment;
      try {
        ws.send(JSON.stringify({ type: "state", state: this.view(token) }));
      } catch { /* socket closing */ }
    }
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
    this.driveAI();
    if (s.mode === "arena") await this.announce();
  }

  async scheduleAlarm() {
    const s = this.s!;
    const ttl = s.updated + TTL;
    await this.ctx.storage.setAlarm(s.nextAt ? Math.min(s.nextAt, ttl) : ttl);
  }

  broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch { /* ignore */ }
    }
  }

  /** Add a chat line (persisted with the next save, broadcast now). */
  say(name: string, kind: ChatMsg["kind"], seat: number | null, text: string) {
    const s = this.s!;
    text = cleanText(text);
    if (!text) return;
    const msg: ChatMsg = { id: ++s.chatSeq, at: Date.now(), name, kind, seat, text };
    s.chat.push(msg);
    if (s.chat.length > 80) s.chat.splice(0, s.chat.length - 80);
    this.broadcast({ type: "chat", msg });
  }

  move(token: string, col: number, comment?: string): string | null {
    const s = this.s!;
    if (!this.ready()) return "Waiting for the second player to join.";
    if (s.winner !== null) return "The game is over. Ask for a rematch to play again.";
    const seat = this.seatOf(token);
    if (seat === null) return "You are not a player in this room.";
    if (seat !== this.turn()) return "It is not your turn.";
    const before = fromMoves(s.moves);
    if (!Number.isInteger(col) || col < 0 || col > 6 || before.heights[col] >= 6) return "That column is full or does not exist.";
    const player = this.playerAt(seat)!;
    // would the opponent have won here? (for the computer's banter)
    const blocked = (() => {
      const b = before.board.slice();
      b[col * 6 + before.heights[col]] = 3 - seat;
      return result(b)?.winner === 3 - seat;
    })();

    s.moves.push(col);
    if (player.kind === "claude" && comment !== undefined) {
      s.comment = cleanText(comment).slice(0, 200);
      if (s.comment) this.say(player.name, "claude", seat, s.comment);
    }
    const r = result(fromMoves(s.moves).board);
    if (r) {
      s.winner = r.winner;
      s.line = r.line;
      if (r.winner === 0) s.draws++;
      else this.playerAt(r.winner)!.wins++;
      this.say("Room", "system", null, r.winner === 0 ? "It's a draw." : `${this.playerAt(r.winner)!.name} wins game ${s.game + 1}! (${s.moves.length} moves)`);
      for (const seatN of [1, 2]) {
        const p = this.playerAt(seatN)!;
        if (p.kind !== "ai") continue;
        if (Math.random() < 0.85) this.say(p.name, "ai", seatN, pick(r.winner === 0 ? BANTER.draw : r.winner === seatN ? BANTER.win : BANTER.lose));
      }
      if (s.mode === "arena" && s.autoNext) s.nextAt = Date.now() + NEXT_DELAY[s.speed];
    } else if (player.kind === "ai") {
      const { board, heights } = fromMoves(s.moves);
      const threat = legalColumns(heights).some((c) => {
        const b = board.slice();
        b[c * 6 + heights[c]] = seat;
        return result(b)?.winner === seat;
      });
      if (s.moves.length <= 2) this.say(player.name, "ai", seat, pick(BANTER.hello));
      else if (blocked && Math.random() < 0.7) this.say(player.name, "ai", seat, pick(BANTER.block));
      else if (threat && Math.random() < 0.5) this.say(player.name, "ai", seat, pick(BANTER.threat));
      else if (Math.random() < 0.08) this.say(player.name, "ai", seat, pick(BANTER.idle));
    }
    return null;
  }

  nextGame() {
    const s = this.s!;
    s.game++;           // seats swap: the other player opens the next game
    s.moves = [];
    s.winner = null;
    s.line = null;
    s.rematch = [];
    s.comment = "";
    s.nextAt = null;
    this.say("Room", "system", null, `Game ${s.game + 1} - ${this.playerAt(1)!.name} opens as Red.`);
  }

  rematch(token: string): boolean {
    const s = this.s!;
    if (s.winner === null) return false;
    if (s.mode === "arena") { this.nextGame(); return true; }       // anyone watching may start the next one
    if (this.seatOf(token) === null) return false;
    if (!s.rematch.includes(token)) s.rematch.push(token);
    // vs Claude either side can restart; friends both have to agree
    if (s.mode === "claude" || s.players.every((p) => s.rematch.includes(p.token))) this.nextGame();
    return true;
  }

  /** Arena: ask one connected browser to compute the computer's move. */
  driveAI() {
    const s = this.s;
    if (!s || s.winner !== null || !this.ready()) return;
    const p = this.playerAt(this.turn());
    if (p?.kind !== "ai") return;
    const ply = s.moves.length;
    const pend = this.pendingAI;
    const sockets = this.ctx.getWebSockets();
    if (pend && pend.game === s.game && pend.ply === ply && Date.now() - pend.at < 12000 && sockets.includes(pend.ws)) return;
    if (!sockets.length) return; // nobody watching: the match pauses
    const hostWs = sockets.find((w) => (w.deserializeAttachment() as Attachment).token === s.host);
    const others = sockets.filter((w) => w !== pend?.ws);
    const ws = hostWs && hostWs !== pend?.ws ? hostWs : others.length ? pick(others) : sockets[0];
    try {
      ws.send(JSON.stringify({ type: "compute", game: s.game, ply, moves: s.moves, level: p.level, speed: s.speed }));
      this.pendingAI = { game: s.game, ply, at: Date.now(), ws };
    } catch { /* try again on the next ping */ }
  }

  /** Arena rooms show up in the lobby's "Live now" list. */
  async announce() {
    const s = this.s!;
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName("global"));
    const red = this.playerAt(1)!, yellow = this.playerAt(2)!;
    await lobby.fetch("https://lobby/room", {
      method: "POST",
      body: JSON.stringify({
        id: s.id, red: red.name, yellow: yellow.name, moves: s.moves.length, game: s.game + 1,
        score: `${s.players[0].wins}-${s.players[1].wins}`, status: s.winner === null ? "live" : "finished",
        viewers: this.ctx.getWebSockets().length, updated: Date.now(),
      }),
    }).catch(() => {});
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

  /** Leaderboard identity of a player: signed-in human, Claude model or computer level. */
  identity(p: Player): { key: string; bot?: { name: string; kind: string } } | null {
    if (p.kind === "human") return p.account ? { key: p.account } : null;
    if (p.kind === "claude") {
      const m = modelInfo(p.model);
      return m ? { key: m.key, bot: { name: m.name, kind: "claude" } } : null;
    }
    const lvl = p.level || "medium";
    return { key: `ai:${lvl}`, bot: { name: `AI · ${LEVEL_NAMES[lvl]}`, kind: "ai" } };
  }

  /** After a finished game, store the result for every participant with a leaderboard identity. */
  async recordIfOver() {
    const s = this.s!;
    if (s.winner === null) return;
    for (const p of s.players) {
      const id = this.identity(p);
      if (!id) continue;
      const seat = this.seatOf(p.token);
      const other = s.players.find((q) => q !== p)!;
      const outcome = s.winner === 0 ? "draw" : s.winner === seat ? "win" : "loss";
      // results are stored by opponent type
      const mode = other.kind === "ai" ? "ai" : other.kind === "claude" ? "claude" : p.kind === "human" ? "friend" : "human";
      await this.leaderboard().fetch("https://lb/record", {
        method: "POST",
        body: JSON.stringify({
          key: id.key, bot: id.bot, mode, level: other.kind === "ai" ? other.level : "", outcome, moves: s.moves.length,
          opponent: other.name || "?", gid: `${s.id}:${s.game}:${id.key}:${seat}`,
        }),
      });
    }
  }

  /** MCP calls tell us which Claude model sits in a seat. */
  setModel(token: string, raw: string | null | undefined): boolean {
    const m = modelInfo(raw);
    const p = this.s!.players.find((p) => p.token === token);
    if (!m || !p || p.model === m.id) return false;
    p.model = m.id;
    p.name = token.startsWith("claude-") ? `${m.name} (${token.slice(-1)})` : m.name;
    return true;
  }

  /** players[0] is Red in game 1, so a player who should start goes to the front. */
  addHuman(token: string, name: string) {
    const s = this.s!;
    const p: Player = { token, name, kind: "human", wins: 0 };
    if (s.joinerFirst) s.players.unshift(p); else s.players.push(p);
  }

  // ------------------------------------------------------------ HTTP API (from the Worker)
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/init" && req.method === "POST") {
      if (this.s) return json({ error: "exists" }, 409);
      const body = (await req.json()) as {
        id: string; mode: Mode; first: string; name?: string; byClaude?: boolean; auth?: string;
        red?: string; yellow?: string; speed?: string; autoNext?: boolean; model?: string;
      };
      const mode: Mode = body.mode === "claude" || body.mode === "arena" ? body.mode : "friend";
      // `first` names who opens game 1: "me" (room creator), "them" (friend / Claude) or "random".
      const flip = Math.random() < 0.5;
      const humanFirst = body.first === "random" ? flip : body.first !== "them" && body.first !== "claude";
      const joinerFirst = mode === "claude" ? humanFirst : !humanFirst;
      this.s = {
        id: body.id, mode, players: [], joinerFirst, game: 0, moves: [], winner: null, line: null,
        draws: 0, rematch: [], comment: "", chat: [], chatSeq: 0, host: null,
        speed: body.speed === "fast" || body.speed === "slow" ? body.speed : "normal",
        autoNext: mode === "arena" && body.autoNext !== false, nextAt: null,
        created: Date.now(), updated: Date.now(),
      };
      let token: string | null = null;
      if (mode === "arena") {
        const bothClaude = body.red === "claude" && body.yellow === "claude";
        this.s.players.push(seatSpec(body.red, bothClaude ? "claude-A" : "claude"));
        this.s.players.push(seatSpec(body.yellow, bothClaude ? "claude-B" : "claude"));
        if (!body.byClaude) { token = newToken(); this.s.host = token; }
        this.say("Room", "system", null, `Match: ${this.s.players[0].name} (Red) vs ${this.s.players[1].name} (Yellow).`);
      } else {
        if (mode === "claude") this.s.players.push({ token: "claude", name: "Claude", kind: "claude", wins: 0 });
        if (!body.byClaude) {
          token = newToken();
          this.addHuman(token, cleanName(body.name, mode === "claude" ? "You" : "Player 1"));
          await this.linkAccount(token, body.auth);
        }
      }
      // the Claude that created the room through MCP takes the first Claude seat
      const firstClaude = this.s.players.find((p) => p.kind === "claude");
      if (firstClaude && body.model) this.setModel(firstClaude.token, body.model);
      await this.save();
      return json({ id: body.id, token });
    }

    if (!this.s) return json({ error: "Room not found" }, 404);

    if (path === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
      let token = url.searchParams.get("token") || "";
      const name = cleanName(url.searchParams.get("name"), "Guest");
      let joined = false;
      const known = this.s.players.some((p) => p.token === token) || (token && token === this.s.host);
      if (!known) {
        token = "";
        if (this.s.mode !== "arena" && this.s.players.length < 2) {
          token = newToken();
          this.addHuman(token, cleanName(url.searchParams.get("name"), this.s.mode === "claude" ? "You" : "Player 2"));
          joined = true;
          this.say("Room", "system", null, `${this.s.players.find((p) => p.token === token)!.name} joined.`);
        }
      }
      if (token && token !== this.s.host) {
        const p = this.s.players.find((p) => p.token === token)!;
        const before = p.account;
        await this.linkAccount(token, url.searchParams.get("auth") || undefined);
        if (p.account !== before) joined = true; // re-broadcast the new name
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ token, name } satisfies Attachment);
      pair[1].send(JSON.stringify({ type: "welcome", token: token || null }));
      pair[1].send(JSON.stringify({ type: "chat_history", chat: this.s.chat }));
      if (joined) await this.save();
      else {
        pair[1].send(JSON.stringify({ type: "state", state: this.view(token) }));
        this.driveAI();
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (path === "/state") return json(this.view(url.searchParams.get("token")));
    if (path === "/chat") return json(this.s.chat.slice(-20));

    // ---- Claude (MCP) endpoints; ?player=A|B picks the Claude when two Claudes play
    if (path.startsWith("/claude/")) {
      const ct = this.claudeToken(url.searchParams.get("player"));
      if (!ct) {
        const two = this.s.players.filter((p) => p.kind === "claude").length === 2;
        return json({ error: two ? 'Two Claudes play in this room - pass player "A" or "B".' : "There is no Claude seat in this room.", mode: this.s.mode }, 400);
      }
      if (this.setModel(ct, url.searchParams.get("model"))) await this.save();
      if (path === "/claude/state") return json(this.view(ct));
      if (path === "/claude/wait") {
        const timeout = Math.min(Number(url.searchParams.get("timeout")) || 40, 50) * 1000;
        const done = () => this.s!.winner !== null || (this.ready() && this.turn() === this.seatOf(ct));
        if (!done()) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, timeout);
            const check = () => {
              if (done()) { clearTimeout(t); resolve(); } else this.waiters.push(check);
            };
            this.waiters.push(check);
          });
        }
        return json(this.view(ct));
      }
      if (path === "/claude/move" && req.method === "POST") {
        const { col, comment } = (await req.json()) as { col: number; comment?: string };
        const err = this.move(ct, col, comment ?? "");
        if (err) return json({ error: err, state: this.view(ct) }, 400);
        await this.save();
        await this.recordIfOver();
        return json(this.view(ct));
      }
      if (path === "/claude/chat" && req.method === "POST") {
        const { text } = (await req.json()) as { text: string };
        const p = this.s.players.find((p) => p.token === ct)!;
        this.say(p.name, "claude", this.seatOf(ct), text);
        await this.save();
        return json(this.view(ct));
      }
      if (path === "/claude/rematch" && req.method === "POST") {
        if (!this.rematch(ct)) return json({ error: "The current game is still in progress." }, 400);
        await this.save();
        return json(this.view(ct));
      }
    }
    return json({ error: "Not found" }, 404);
  }

  // ------------------------------------------------------------ WebSocket (hibernation API)
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (!this.s || typeof raw !== "string") return;
    const att = ws.deserializeAttachment() as Attachment;
    const { token } = att;
    let msg: { type?: string; col?: number; name?: string; e?: string; text?: string; game?: number; ply?: number; speed?: string; autoNext?: boolean };
    try { msg = JSON.parse(raw); } catch { return; }
    const s = this.s;

    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); this.driveAI(); return; }

    if (msg.type === "chat") {
      const now = Date.now();
      if (att.lastChat && now - att.lastChat < 800) return; // simple flood guard
      ws.serializeAttachment({ ...att, lastChat: now });
      const p = s.players.find((p) => p.token === token);
      this.say(p ? p.name : `${att.name} 👀`, p ? "human" : "spectator", p ? this.seatOf(token) : null, String(msg.text ?? ""));
      await this.ctx.storage.put("s", s);
      return;
    }

    // computer move computed by a viewer's browser (arena)
    if (msg.type === "ai_move") {
      const seat = this.turn();
      const p = this.playerAt(seat);
      if (s.mode !== "arena" || p?.kind !== "ai" || msg.game !== s.game || msg.ply !== s.moves.length) return;
      this.pendingAI = null;
      if (this.move(p.token, Number(msg.col))) return;
      await this.save();
      await this.recordIfOver();
      return;
    }

    if (msg.type === "rematch") {
      if (this.rematch(token)) await this.save();
      return;
    }
    if (msg.type === "settings" && s.mode === "arena") {
      if (msg.speed === "fast" || msg.speed === "normal" || msg.speed === "slow") s.speed = msg.speed;
      if (typeof msg.autoNext === "boolean") {
        s.autoNext = msg.autoNext;
        if (!s.autoNext) s.nextAt = null;
        else if (s.winner !== null && !s.nextAt) s.nextAt = Date.now() + NEXT_DELAY[s.speed];
      }
      await this.save();
      return;
    }

    if (!token || token === s.host) return; // spectators can't move / rename / react
    if (msg.type === "move") {
      const err = this.move(token, Number(msg.col));
      if (err) return ws.send(JSON.stringify({ type: "error", message: err }));
      await this.save();
      await this.recordIfOver();
    } else if (msg.type === "name") {
      const p = s.players.find((p) => p.token === token);
      if (p) { p.name = cleanName(msg.name, p.name); await this.save(); }
    } else if (msg.type === "emoji" && EMOJIS.includes(msg.e || "")) {
      this.broadcast({ type: "emoji", seat: this.seatOf(token), e: msg.e });
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code, "bye"); } catch { /* already closed */ }
    if (this.pendingAI?.ws === ws) this.pendingAI = null;
    if (this.s) await this.save(); // refresh online dots, re-assign the AI driver
  }

  async alarm() {
    const s = this.s;
    if (!s) return;
    if (s.nextAt && Date.now() >= s.nextAt - 50 && s.winner !== null) {
      this.nextGame();
      await this.save();
      return;
    }
    if (Date.now() - s.updated >= TTL - 60_000) {
      await this.ctx.storage.deleteAll();
      this.s = null;
      return;
    }
    await this.scheduleAlarm();
  }
}
