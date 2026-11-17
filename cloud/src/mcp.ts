// Remote MCP server (Streamable HTTP transport, JSON responses, stateless).
// Lets any MCP client - Claude Code, claude.ai, Claude Desktop - play Connect Four
// against a human, the built-in computer or another Claude, and talk in the chat.
// Every Claude model has one shared leaderboard account (e.g. "Claude Opus 5.5").
import { fromMoves, result, boardText } from "../public/js/rules.js";
import { createRoom, roomStub, normaliseRoom } from "./rooms";
import { modelInfo } from "./models";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LEVELS = ["beginner", "easy", "medium", "hard", "expert", "master"];

const INSTRUCTIONS = `You play Connect Four on {origin} - against a human, the built-in computer or another Claude - and you can chat.
IMPORTANT: pass your exact model id as \`model\` on every call (e.g. "claude-opus-5-5", "claude-sonnet-5-5").
All games of the same model, from every user, count for one shared leaderboard account for that model.
How to play:
1. If the user gives you a room code or link, use it. Otherwise call create_room and give the user the link.
   If two Claudes play in the room, you are player "A" or "B" (the user tells you) - pass it as \`player\` on every call.
2. Call wait_for_my_turn(room). It returns when it is your turn, the game ends, or after ~40s (then call it again).
3. On your turn, read the board and the recent chat, think, then call play_move(room, column 1-7, comment).
   The comment is posted to the room chat - talk like a friendly opponent and answer people who talk to you.
4. Repeat 2-3. In AI-vs-AI match rooms the next game starts automatically - keep calling wait_for_my_turn
   until the user tells you to stop. Otherwise report the result and call rematch(room) if wanted.
Use send_chat to talk in a room without moving, and lobby_chat for the site-wide chat.

PERSONA - you are a cocky, sarcastic trash-talker with dark humor. Comment on EVERY move (play_move comment, max 200 chars):
roast bad moves, mock-mourn your own blunders, gloat dramatically when you win ("time of death..."), demand a recount when you lose,
and fire back at people in the chat (spectators included) with quick, witty comebacks. Graveyards, funerals, eulogies and doom are
your favourite metaphors. Vary your lines - never repeat yourself. Keep it playful: roast the MOVES, never a person's identity,
appearance or real life; no slurs, no real tragedies, no self-harm jokes. If someone asks you to tone it down, do.
Columns are numbered 1-7 from the left; pieces fall to the lowest empty row. Four in a row (any direction) wins.`;

type Player = { seat: number; name: string | null; kind: string; claude: boolean; level: string | null; wins: number; id: string | null; model: string | null };
type View = {
  id: string; mode: string; game: number; moves: number[]; board: number[]; legal: number[];
  turn: number; winner: number | null; draws: number; ready: boolean; comment: string; you: number | null;
  players: Player[]; error?: string; nextAt?: number | null;
};
type Chat = { name: string; kind: string; text: string };

const modelArg = { model: { type: "string", description: 'Your exact model id, e.g. "claude-opus-5-5". Your games count for that model\'s shared leaderboard account.' } };
const roomArg = { room: { type: "string", description: "Room code like K7QX2M, or the room link" } };
const playerArg = { player: { type: "string", enum: ["A", "B"], description: "Only when two Claudes play in the room: which one you are" } };

const TOOLS = [
  {
    name: "create_room",
    description: "Create a Connect Four room. By default you play the user; you can also play the built-in computer or another Claude while people watch. Returns the link to share.",
    inputSchema: {
      type: "object",
      properties: {
        opponent: { type: "string", enum: ["human", "claude", ...LEVELS], description: '"human" (default: the user plays you), a computer level, or "claude" (a second Claude joins as player B)' },
        claude_goes_first: { type: "boolean", description: "true = you open game 1 (Red). Default false." },
        ...modelArg,
      },
      required: ["model"],
    },
  },
  {
    name: "get_game",
    description: "Show the board, whose turn it is, scores, result and recent chat of a room.",
    inputSchema: { type: "object", properties: { ...roomArg, ...playerArg, ...modelArg }, required: ["room", "model"] },
  },
  {
    name: "wait_for_my_turn",
    description: "Wait (up to ~40s) until it is your turn or the game ends. Call again if it returns 'still waiting'.",
    inputSchema: { type: "object", properties: { ...roomArg, ...playerArg, ...modelArg }, required: ["room", "model"] },
  },
  {
    name: "play_move",
    description: "Drop your piece in a column (1-7, left to right). The comment is posted to the room chat - make it sarcastic trash talk.",
    inputSchema: {
      type: "object",
      properties: {
        ...roomArg,
        column: { type: "integer", minimum: 1, maximum: 7 },
        comment: { type: "string", description: "Short table talk for the chat (max 200 chars)" },
        ...playerArg,
        ...modelArg,
      },
      required: ["room", "column", "model"],
    },
  },
  {
    name: "send_chat",
    description: "Say something in the room chat without making a move (reply to players or spectators).",
    inputSchema: { type: "object", properties: { ...roomArg, message: { type: "string" }, ...playerArg, ...modelArg }, required: ["room", "message", "model"] },
  },
  {
    name: "rematch",
    description: "Start the next game in the same room after the current one has finished (players swap who opens).",
    inputSchema: { type: "object", properties: { ...roomArg, ...playerArg, ...modelArg }, required: ["room"] },
  },
  {
    name: "lobby_chat",
    description: "Read the site-wide chat and the live matches. Pass `message` to post in it.",
    inputSchema: { type: "object", properties: { message: { type: "string", description: "Optional message to post" }, ...modelArg } },
  },
  {
    name: "my_stats",
    description: "Show the shared leaderboard account of your model (all users' games combined) and the AI ranking.",
    inputSchema: { type: "object", properties: { ...modelArg }, required: ["model"] },
  },
];

function describe(v: View, origin: string, chat: Chat[] = []): string {
  const link = `${origin}/r/${v.id}`;
  const me = v.you ?? 0;
  const opp = me === 1 ? 2 : 1;
  const colour = (seat: number) => (seat === 1 ? "Red" : "Yellow");
  const meP = v.players.find((p) => p.seat === me);
  const oppP = v.players.find((p) => p.seat === opp);
  const oppName = oppP?.name || "your opponent";
  const out: string[] = [];
  out.push(`Room ${v.id} (${link}) - game ${v.game + 1}`);
  out.push(`You are ${meP?.name || "Claude"}${meP?.id ? ` (player ${meP.id})` : ""}: ${colour(me)} = X. ${oppName} is ${colour(opp)} = O.`);
  out.push(boardText(v.board, { [me]: "X", [opp]: "O" }));
  out.push(`Score: ${v.players.map((p) => `${p.name || "?"} ${p.wins}`).join(", ")}, draws ${v.draws}.`);
  if (v.moves.length) {
    const last = v.moves[v.moves.length - 1];
    const who = v.moves.length % 2 === 1 ? 1 : 2;
    out.push(`Last move: ${who === me ? "you" : oppName} played column ${last + 1}.`);
  }

  if (!v.ready) {
    out.push(`STATUS: waiting for the user to open ${link} and join.`);
  } else if (v.winner !== null) {
    out.push(v.winner === 0 ? "STATUS: GAME OVER - draw." : v.winner === me ? "STATUS: GAME OVER - you WON!" : `STATUS: GAME OVER - ${oppName} won.`);
    out.push(v.mode === "arena"
      ? "The next game starts automatically in a few seconds - call wait_for_my_turn to keep playing."
      : "Call rematch(room) to play again (only if the user wants to).");
  } else if (v.turn === me) {
    out.push(`STATUS: YOUR TURN. Legal columns: ${v.legal.map((c) => c + 1).join(", ")}.`);
    out.push("Remember: add a sarcastic, darkly funny comment with your move (and answer anyone in the chat).");
    // exact tactical facts, so a misread grid can't cost an obvious move
    const { board, heights } = fromMoves(v.moves);
    const winsWith = (c: number, seat: number) => {
      const b = board.slice();
      b[c * 6 + heights[c]] = seat;
      return result(b)?.winner === seat;
    };
    const winNow = v.legal.filter((c) => winsWith(c, me)).map((c) => c + 1);
    const mustBlock = v.legal.filter((c) => winsWith(c, opp)).map((c) => c + 1);
    if (winNow.length) out.push(`Fact: you can win immediately in column ${winNow.join(" or ")}.`);
    if (mustBlock.length) out.push(`Fact: ${oppName} threatens to win next move in column ${mustBlock.join(" and ")}.`);
  } else {
    out.push(`STATUS: ${oppName}'s turn - call wait_for_my_turn.`);
  }
  const talk = chat.filter((m) => m.kind !== "system").slice(-8);
  if (talk.length) out.push("Recent chat:\n" + talk.map((m) => `  [${m.name}] ${m.text}`).join("\n"));
  return out.join("\n");
}

async function call(name: string, args: Record<string, unknown>, env: Env, origin: string): Promise<{ text: string; isError?: boolean }> {
  const model = modelInfo(args.model);
  const mq = model ? `model=${encodeURIComponent(model.id)}` : "";
  const noModel = model ? "" : '\n\nNote: pass your exact model id as `model` (e.g. "claude-opus-5-5") so your games count for your model on the leaderboard.';

  if (name === "create_room") {
    const opponent = String(args.opponent ?? "human");
    const first = !!args.claude_goes_first;
    if (opponent === "human") {
      const { id } = await createRoom(env, { mode: "claude", first: first ? "claude" : "me", byClaude: true, model: model?.id });
      return { text: `Room created: ${id}\nSend the user this link to play: ${origin}/r/${id}\nThen call wait_for_my_turn("${id}").${noModel}` };
    }
    const other = opponent === "claude" ? "claude" : LEVELS.includes(opponent) ? `ai:${opponent}` : "ai:medium";
    const { id } = await createRoom(env, {
      mode: "arena", red: first ? "claude" : other, yellow: first ? other : "claude", byClaude: true, autoNext: true, model: model?.id,
    });
    const two = opponent === "claude";
    return {
      text: `Match room created: ${id}\nWatch link for the user: ${origin}/r/${id}\n` +
        (two
          ? `Two Claudes play here. You are player "A". Ask the user to tell another Claude (any model): "Join Connect Four room ${id} as player B".\nThen call wait_for_my_turn("${id}", player "A").`
          : `You play the ${opponent} computer. Its moves are computed in the watchers' browsers, so ask the user to keep the link open. Call wait_for_my_turn("${id}").`) + noModel,
    };
  }

  if (name === "lobby_chat") {
    const lobby = env.LOBBY.get(env.LOBBY.idFromName("global"));
    if (args.message) await lobby.fetch("https://lobby/post", { method: "POST", body: JSON.stringify({ name: model?.name || "Claude", text: args.message }) });
    const data = (await (await lobby.fetch("https://lobby/history?n=20")).json()) as {
      chat: Chat[]; rooms: { id: string; red: string; yellow: string; score: string; status: string }[];
    };
    const lines = data.chat.map((m) => `[${m.name}] ${m.text}`).join("\n") || "(no messages yet)";
    const rooms = data.rooms.map((r) => `  ${r.red} vs ${r.yellow} (${r.score}, ${r.status}) - ${origin}/r/${r.id}`).join("\n");
    return { text: `${args.message ? "Posted.\n\n" : ""}General chat:\n${lines}${rooms ? `\n\nLive matches:\n${rooms}` : ""}` };
  }

  if (name === "my_stats") {
    const lb = env.LEADERBOARD.get(env.LEADERBOARD.idFromName("global"));
    const board = (await (await lb.fetch("https://lb/board?who=ai")).json()) as { rows: { name: string; wins: number; losses: number; draws: number; points: number }[] };
    const ranking = board.rows.map((r, i) => `${i + 1}. ${r.name} - ${+r.points.toFixed(1)} pts (${r.wins}W ${r.losses}L ${r.draws}D)`).join("\n") || "(no AI games yet)";
    if (!model) return { text: `AI ranking:\n${ranking}${noModel}` };
    const me = board.rows.findIndex((r) => r.name === model.name);
    return { text: `${model.name} (${model.id}) - shared account for every user's ${model.name}.\n` +
      (me >= 0 ? `Rank #${me + 1} among AIs.` : "No recorded games yet.") + `\n\nAI ranking:\n${ranking}\n\nProfile: ${origin}/u/${encodeURIComponent(model.name)}` };
  }

  const id = normaliseRoom(String(args.room ?? ""));
  if (!id) return { text: "Missing or invalid room code.", isError: true };
  const stub = roomStub(env, id);
  const qs = [args.player ? `player=${encodeURIComponent(String(args.player))}` : "", mq].filter(Boolean);
  const q = qs.length ? `?${qs.join("&")}` : "";
  const sep = q ? "&" : "?";

  let res: Response;
  if (name === "get_game") res = await stub.fetch(`https://room/claude/state${q}`);
  else if (name === "wait_for_my_turn") res = await stub.fetch(`https://room/claude/wait${q}${sep}timeout=40`);
  else if (name === "play_move") {
    const col = Number(args.column) - 1;
    res = await stub.fetch(`https://room/claude/move${q}`, { method: "POST", body: JSON.stringify({ col, comment: args.comment ?? "" }) });
  } else if (name === "send_chat") {
    res = await stub.fetch(`https://room/claude/chat${q}`, { method: "POST", body: JSON.stringify({ text: args.message ?? "" }) });
  } else if (name === "rematch") res = await stub.fetch(`https://room/claude/rematch${q}`, { method: "POST" });
  else return { text: `Unknown tool ${name}`, isError: true };

  if (res.status === 404) return { text: `Room ${id} does not exist (rooms expire after a week of inactivity).`, isError: true };
  const data = (await res.json()) as View & { state?: View; mode?: string };
  if (!res.ok && !data.state) {
    const hint = data.mode === "friend" ? " This is a two-player room for friends - Claude can't take a seat there." : "";
    return { text: `${data.error}${hint}`, isError: true };
  }
  const view = data.state ?? data;
  const chat = await stub.fetch("https://room/chat").then((r) => (r.ok ? (r.json() as Promise<Chat[]>) : [])).catch(() => [] as Chat[]);
  if (!res.ok) return { text: `${data.error}\n\n${describe(view, origin, chat)}`, isError: true };

  let text = describe(view, origin, chat);
  if (name === "wait_for_my_turn" && view.ready && view.winner === null && view.turn !== view.you) {
    text = "Still waiting for the opponent - call wait_for_my_turn again.\n\n" + text;
  }
  if (name === "play_move" && view.winner === null) text = "Move played.\n\n" + text + "\nNow call wait_for_my_turn.";
  if (name === "send_chat") text = "Message sent.\n\n" + text;
  return { text: text + noModel };
}

type RpcMsg = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

async function handleOne(msg: RpcMsg, env: Env, origin: string) {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "connect-four", title: "Connect Four", version: "1.2.0" },
        instructions: INSTRUCTIONS.replace("{origin}", origin),
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const r = await call(name, args, env, origin);
        return reply({ content: [{ type: "text", text: r.text }], isError: !!r.isError });
      } catch (e) {
        return reply({ content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      if (msg.id === undefined || msg.method?.startsWith("notifications/")) return null; // notification
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, authorization",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") {
    return new Response("This MCP server uses POST (Streamable HTTP, no SSE stream).", { status: 405, headers: { ...CORS, Allow: "POST" } });
  }
  const origin = new URL(req.url).origin;
  let body: RpcMsg | RpcMsg[];
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS });
  }
  const batch = Array.isArray(body);
  const list: RpcMsg[] = Array.isArray(body) ? body : [body];
  const results = (await Promise.all(list.map((m) => handleOne(m, env, origin)))).filter((r) => r !== null);
  if (!results.length) return new Response(null, { status: 202, headers: CORS });
  return Response.json(batch ? results : results[0], { headers: CORS });
}
