// Remote MCP server (Streamable HTTP transport, JSON responses, stateless).
// Lets any MCP client - Claude Code, claude.ai, Claude Desktop - play Connect Four
// against a human in a room on this site.
import { fromMoves, result, boardText } from "../public/js/rules.js";
import { createRoom, roomStub, normaliseRoom } from "./rooms";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `You are playing Connect Four against a human on ${"{origin}"}.
How to play:
1. If the user gives you a room code or link, use it. Otherwise call create_room and send the user the link.
2. Call wait_for_my_turn(room). It returns when it is your turn, the game ends, or after ~40s (then just call it again).
3. On your turn, think about the board, then call play_move(room, column 1-7, comment). Keep comments short and friendly.
4. Repeat 2-3. When the game ends, report the result; call rematch(room) if the user wants another game.
Columns are numbered 1-7 from the left; pieces fall to the lowest empty row. Four in a row (any direction) wins.`;

type View = {
  id: string; mode: string; game: number; moves: number[]; board: number[]; legal: number[];
  turn: number; winner: number | null; draws: number; ready: boolean; comment: string; you: number | null;
  players: { seat: number; name: string | null; claude: boolean; wins: number; online: boolean }[];
  error?: string;
};

const TOOLS = [
  {
    name: "create_room",
    description: "Create a new Connect Four room where you (Claude) play against the user. Returns a link the user opens in their browser to play.",
    inputSchema: {
      type: "object",
      properties: { claude_goes_first: { type: "boolean", description: "true = you open game 1 (Red). Default false: the user starts." } },
    },
  },
  {
    name: "get_game",
    description: "Show the current board, whose turn it is, scores and the result of a Claude room.",
    inputSchema: { type: "object", properties: { room: { type: "string", description: "Room code like K7QX2M, or the room link" } }, required: ["room"] },
  },
  {
    name: "wait_for_my_turn",
    description: "Wait (up to ~40s) until it is your turn, the game ends, or the opponent joins. Call again if it returns 'still waiting'.",
    inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
  },
  {
    name: "play_move",
    description: "Drop your piece in a column (1-7, left to right). Optionally include a short comment that the user sees next to the board.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string" },
        column: { type: "integer", minimum: 1, maximum: 7 },
        comment: { type: "string", description: "Short table talk shown to the user (max 200 chars)" },
      },
      required: ["room", "column"],
    },
  },
  {
    name: "rematch",
    description: "Start a new game in the same room after the current one has finished (players swap who opens).",
    inputSchema: { type: "object", properties: { room: { type: "string" } }, required: ["room"] },
  },
];

function describe(v: View, origin: string): string {
  const link = `${origin}/r/${v.id}`;
  const me = v.you ?? 0;
  const opp = me === 1 ? 2 : 1;
  const colour = (seat: number) => (seat === 1 ? "Red" : "Yellow");
  const oppName = v.players.find((p) => p.seat === opp)?.name || "your opponent";
  const out: string[] = [];
  out.push(`Room ${v.id} (${link}) - game ${v.game + 1}`);
  out.push(`You are ${colour(me)} = X. ${oppName} is ${colour(opp)} = O.`);
  out.push(boardText(v.board, { [me]: "X", [opp]: "O" }));

  const score = v.players.map((p) => `${p.claude ? "You" : p.name || "?"} ${p.wins}`).join(", ");
  out.push(`Score: ${score}, draws ${v.draws}.`);
  if (v.moves.length) {
    const last = v.moves[v.moves.length - 1];
    const who = v.moves.length % 2 === 1 ? 1 : 2;
    out.push(`Last move: ${who === me ? "you" : oppName} played column ${last + 1}.`);
  }

  if (!v.ready) {
    out.push(`STATUS: waiting for the user to open ${link} and join.`);
  } else if (v.winner !== null) {
    out.push(v.winner === 0 ? "STATUS: GAME OVER - draw." : v.winner === me ? "STATUS: GAME OVER - you WON!" : `STATUS: GAME OVER - ${oppName} won.`);
    out.push("Call rematch(room) to play again (only if the user wants to).");
  } else if (v.turn === me) {
    out.push(`STATUS: YOUR TURN. Legal columns: ${v.legal.map((c) => c + 1).join(", ")}.`);
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
  return out.join("\n");
}

async function call(name: string, args: Record<string, unknown>, env: Env, origin: string): Promise<{ text: string; isError?: boolean }> {
  if (name === "create_room") {
    const { id } = await createRoom(env, { mode: "claude", first: args.claude_goes_first ? "claude" : "me", byClaude: true });
    return {
      text: `Room created: ${id}\nSend the user this link to play: ${origin}/r/${id}\n` +
        `Then call wait_for_my_turn("${id}").`,
    };
  }
  const id = normaliseRoom(String(args.room ?? ""));
  if (!id) return { text: "Missing or invalid room code.", isError: true };
  const stub = roomStub(env, id);

  let res: Response;
  if (name === "get_game") res = await stub.fetch("https://room/state?token=claude");
  else if (name === "wait_for_my_turn") res = await stub.fetch("https://room/claude/wait?timeout=40");
  else if (name === "play_move") {
    const col = Number(args.column) - 1;
    res = await stub.fetch("https://room/claude/move", { method: "POST", body: JSON.stringify({ col, comment: args.comment ?? "" }) });
  } else if (name === "rematch") res = await stub.fetch("https://room/claude/rematch", { method: "POST" });
  else return { text: `Unknown tool ${name}`, isError: true };

  const data = (await res.json()) as View & { state?: View };
  if (res.status === 404) return { text: `Room ${id} does not exist (rooms expire after a week of inactivity).`, isError: true };
  const view = data.state ?? data;
  if (view.mode && view.mode !== "claude") return { text: `Room ${id} is a two-player room for friends, not a Claude room.`, isError: true };
  if (!res.ok) return { text: `${data.error}\n\n${data.state ? describe(data.state, origin) : ""}`.trim(), isError: true };

  let text = describe(view, origin);
  if (name === "wait_for_my_turn" && view.ready && view.winner === null && view.turn !== view.you) {
    text = "Still waiting for the opponent - call wait_for_my_turn again.\n\n" + text;
  }
  if (name === "play_move" && view.winner === null) text = "Move played.\n\n" + text + "\nNow call wait_for_my_turn.";
  return { text };
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
        serverInfo: { name: "connect-four", title: "Connect Four", version: "1.0.0" },
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
