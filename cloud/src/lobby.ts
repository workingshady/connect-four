import { DurableObject } from "cloudflare:workers";

// One global instance: the site-wide chat plus the "Live now" list of AI matches.

interface LobbyMsg { id: number; at: number; name: string; kind: "human" | "guest" | "claude" | "system"; text: string }
interface LiveRoom { id: string; red: string; yellow: string; moves: number; game: number; score: string; status: string; viewers: number; updated: number }
interface Attachment { name: string; kind: "human" | "guest"; lastChat?: number }

const json = (data: unknown, status = 200) => Response.json(data, { status });
const cleanText = (s: unknown) => (typeof s === "string" ? s : "").replace(/\s+/g, " ").trim().slice(0, 280);
const cleanName = (s: unknown) => (typeof s === "string" ? s : "").replace(/[^\p{L}\p{N} _.\-]/gu, "").trim().slice(0, 20);

export class Lobby extends DurableObject<Env> {
  chat: LobbyMsg[] = [];
  seq = 0;
  rooms = new Map<string, LiveRoom>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.chat = (await ctx.storage.get<LobbyMsg[]>("chat")) ?? [];
      this.seq = this.chat.at(-1)?.id ?? 0;
      for (const r of (await ctx.storage.get<LiveRoom[]>("rooms")) ?? []) this.rooms.set(r.id, r);
    });
  }

  liveRooms() {
    const cutoff = Date.now() - 20 * 60 * 1000; // hide matches idle for 20 minutes
    for (const [id, r] of this.rooms) if (r.updated < cutoff || r.viewers === 0 && r.updated < Date.now() - 90_000) this.rooms.delete(id);
    return [...this.rooms.values()].sort((a, b) => b.updated - a.updated).slice(0, 20);
  }

  send(ws: WebSocket, msg: unknown) {
    try { ws.send(JSON.stringify(msg)); } catch { /* closing */ }
  }
  broadcast(msg: unknown) {
    for (const ws of this.ctx.getWebSockets()) this.send(ws, msg);
  }
  online() {
    return this.ctx.getWebSockets().length;
  }

  async post(name: string, kind: LobbyMsg["kind"], text: string) {
    text = cleanText(text);
    if (!text) return null;
    const msg: LobbyMsg = { id: ++this.seq, at: Date.now(), name, kind, text };
    this.chat.push(msg);
    if (this.chat.length > 120) this.chat.splice(0, this.chat.length - 120);
    await this.ctx.storage.put("chat", this.chat);
    this.broadcast({ type: "chat", msg });
    return msg;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/ws": {
        if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
        let name = cleanName(url.searchParams.get("name")) || `Guest-${Math.floor(Math.random() * 9000 + 1000)}`;
        let kind: Attachment["kind"] = "guest";
        const auth = url.searchParams.get("auth");
        if (auth) {
          // signed-in players get their verified account name
          const lb = this.env.LEADERBOARD.get(this.env.LEADERBOARD.idFromName("global"));
          const res = await lb.fetch("https://lb/me", { method: "POST", body: JSON.stringify({ token: auth }) });
          if (res.ok) { name = ((await res.json()) as { name: string }).name; kind = "human"; }
        }
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({ name, kind } satisfies Attachment);
        this.send(pair[1], { type: "hello", name, kind, chat: this.chat.slice(-60), rooms: this.liveRooms(), online: this.online() });
        this.broadcast({ type: "online", online: this.online() });
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      case "/history":
        return json({ chat: this.chat.slice(-Number(url.searchParams.get("n") || 30)), rooms: this.liveRooms(), online: this.online() });
      case "/post": {
        // internal: Claude posting through MCP
        const b = (await req.json()) as { name?: string; text?: string };
        const msg = await this.post(cleanName(b.name) || "Claude", "claude", String(b.text ?? ""));
        return json({ ok: !!msg, chat: this.chat.slice(-20) });
      }
      case "/room": {
        const r = (await req.json()) as LiveRoom;
        this.rooms.set(r.id, r);
        await this.ctx.storage.put("rooms", this.liveRooms());
        this.broadcast({ type: "rooms", rooms: this.liveRooms() });
        return json({ ok: true });
      }
    }
    return json({ error: "Not found" }, 404);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    const att = ws.deserializeAttachment() as Attachment;
    let msg: { type?: string; text?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "ping") return this.send(ws, { type: "pong", online: this.online() });
    if (msg.type === "chat") {
      const now = Date.now();
      if (att.lastChat && now - att.lastChat < 1000) return this.send(ws, { type: "error", message: "Slow down a little 🙂" });
      ws.serializeAttachment({ ...att, lastChat: now });
      await this.post(att.name, att.kind, String(msg.text ?? ""));
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code, "bye"); } catch { /* closed */ }
    this.broadcast({ type: "online", online: this.online() });
  }
}
