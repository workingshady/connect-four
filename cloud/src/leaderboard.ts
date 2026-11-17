import { DurableObject } from "cloudflare:workers";

// One global instance (idFromName("global")) with SQLite storage:
// accounts (name + hashed passcode), sessions and every recorded game.

export const LEVEL_POINTS: Record<string, number> = {
  beginner: 1, easy: 2, medium: 3, hard: 5, expert: 8, master: 13,
};
export const MODE_POINTS: Record<string, number> = { claude: 8, friend: 5, human: 8 };
// results are stored by OPPONENT type: ai (with level), claude, friend (human vs human), human (bot vs human)
const MODES = ["ai", "claude", "friend", "human"];
const OUTCOMES = ["win", "loss", "draw"];

const json = (data: unknown, status = 200) => Response.json(data, { status });
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hashPass(passcode: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 20000 }, key, 256);
  return hex(bits);
}

function points(mode: string, level: string, outcome: string) {
  const w = mode === "ai" ? LEVEL_POINTS[level] ?? 0 : MODE_POINTS[mode] ?? 0;
  return outcome === "win" ? w : outcome === "draw" ? w / 2 : 0;
}

export class Leaderboard extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS players (key TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, key TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, gid TEXT UNIQUE, key TEXT NOT NULL, mode TEXT NOT NULL, level TEXT NOT NULL,
        outcome TEXT NOT NULL, moves INTEGER NOT NULL, opponent TEXT NOT NULL, points REAL NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS results_key ON results(key, created);
      CREATE INDEX IF NOT EXISTS results_mode ON results(mode, level);
    `);
    // v2: bot accounts (Claude models, computer levels) live next to humans
    const cols = this.sql.exec("PRAGMA table_info(players)").toArray().map((c) => c.name);
    if (!cols.includes("kind")) this.sql.exec("ALTER TABLE players ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'");
  }

  keyFor(name: string) {
    return name.trim().toLowerCase();
  }

  sessionKey(token: string | null): string | null {
    if (!token) return null;
    const row = this.sql.exec("SELECT key FROM sessions WHERE token = ?", token).toArray()[0];
    return (row?.key as string) ?? null;
  }

  displayName(key: string) {
    return (this.sql.exec("SELECT name FROM players WHERE key = ?", key).toArray()[0]?.name as string) ?? key;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

    switch (url.pathname) {
      case "/check": {
        const exists = this.sql.exec("SELECT 1 FROM players WHERE key = ?", this.keyFor(String(body.name ?? ""))).toArray().length > 0;
        return json({ exists });
      }

      case "/auth": {
        const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
        const passcode = String(body.passcode ?? "");
        if (!/^[\p{L}\p{N} _.\-]{3,20}$/u.test(name)) return json({ error: "Name must be 3-20 letters, numbers, spaces, _ . -" }, 400);
        if (passcode.length < 4 || passcode.length > 32) return json({ error: "Passcode must be 4-32 characters" }, 400);
        const key = this.keyFor(name);
        const row = this.sql.exec("SELECT name, salt, hash FROM players WHERE key = ?", key).toArray()[0];
        let created = false;
        if (!row) {
          if (/^(claude|ai\b|ai ·|model:)/.test(key)) return json({ error: "Names starting with Claude or AI are reserved for the bots" }, 400);
          const salt = crypto.randomUUID();
          this.sql.exec("INSERT INTO players (key, name, salt, hash, created) VALUES (?, ?, ?, ?, ?)",
            key, name, salt, await hashPass(passcode, salt), Date.now());
          created = true;
        } else if ((await hashPass(passcode, row.salt as string)) !== row.hash) {
          return json({ error: "Wrong passcode for this name" }, 401);
        }
        const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        this.sql.exec("INSERT INTO sessions (token, key, created) VALUES (?, ?, ?)", token, key, Date.now());
        return json({ token, name: this.displayName(key), created });
      }

      case "/me": {
        const key = this.sessionKey(String(body.token ?? ""));
        return key ? json({ name: this.displayName(key), key }) : json({ error: "Not signed in" }, 401);
      }

      case "/logout": {
        this.sql.exec("DELETE FROM sessions WHERE token = ?", String(body.token ?? ""));
        return json({ ok: true });
      }

      case "/record": {
        // Internal: called by the Worker / Room after validating the game.
        const key = body.key ? String(body.key) : this.sessionKey(String(body.token ?? ""));
        if (!key) return json({ error: "Not signed in" }, 401);
        const bot = body.bot as { name?: string; kind?: string } | undefined;
        if (bot?.name && (bot.kind === "claude" || bot.kind === "ai")) {
          // shared bot account: created on first game, display name kept up to date
          this.sql.exec(
            "INSERT INTO players (key, name, salt, hash, created, kind) VALUES (?, ?, '', '', ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name",
            key, String(bot.name).slice(0, 40), Date.now(), bot.kind);
        }
        const mode = String(body.mode), level = String(body.level ?? ""), outcome = String(body.outcome);
        if (!MODES.includes(mode) || !OUTCOMES.includes(outcome)) return json({ error: "Bad result" }, 400);
        if (mode === "ai" && !(level in LEVEL_POINTS)) return json({ error: "Bad level" }, 400);
        const pts = points(mode, level, outcome);
        this.sql.exec(
          "INSERT OR IGNORE INTO results (gid, key, mode, level, outcome, moves, opponent, points, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          String(body.gid ?? crypto.randomUUID()), key, mode, mode === "ai" ? level : mode, outcome,
          Number(body.moves) || 0, String(body.opponent ?? "").slice(0, 40), pts, Date.now());
        const recorded = Number(this.sql.exec("SELECT changes() AS n").one().n) > 0;
        return json({ ok: true, recorded, points: recorded ? pts : 0 });
      }

      case "/board": {
        const mode = url.searchParams.get("mode") || "all";
        const who = url.searchParams.get("who") === "ai" ? "ai" : "humans";
        const level = url.searchParams.get("level") || "";
        const days = Number(url.searchParams.get("days")) || 0;
        const where: string[] = [who === "ai" ? "p.kind IN ('claude', 'ai')" : "p.kind = 'human'"];
        const args: (string | number)[] = [];
        if (mode !== "all") { where.push("mode = ?"); args.push(mode); }
        if (mode === "ai" && level) { where.push("level = ?"); args.push(level); }
        if (days) { where.push("created >= ?"); args.push(Date.now() - days * 86400000); }
        const rows = this.sql.exec(`
          SELECT p.name AS name, p.kind AS kind, p.key AS key,
                 SUM(outcome = 'win') AS wins, SUM(outcome = 'loss') AS losses, SUM(outcome = 'draw') AS draws,
                 COUNT(*) AS games, SUM(r.points) AS points, MAX(r.created) AS last
          FROM results r JOIN players p ON p.key = r.key
          WHERE ${where.join(" AND ")}
          GROUP BY r.key ORDER BY points DESC, wins DESC, games ASC LIMIT 100`, ...args).toArray();
        return json({ rows });
      }

      case "/player": {
        const asked = this.keyFor(url.searchParams.get("name") || "");
        const p = this.sql.exec("SELECT key, name, created, kind FROM players WHERE key = ? OR lower(name) = ? ORDER BY key = ? DESC LIMIT 1", asked, asked, asked).toArray()[0];
        if (!p) return json({ error: "No such player" }, 404);
        const key = p.key as string;
        const breakdown = this.sql.exec(`
          SELECT mode, level, SUM(outcome='win') AS wins, SUM(outcome='loss') AS losses, SUM(outcome='draw') AS draws, SUM(points) AS points
          FROM results WHERE key = ? GROUP BY mode, level`, key).toArray();
        const recent = this.sql.exec(
          "SELECT mode, level, outcome, moves, opponent, points, created FROM results WHERE key = ? ORDER BY created DESC LIMIT 15", key).toArray();
        const since = Date.now() - 29 * 86400000;
        const daily = this.sql.exec(`
          SELECT CAST((created - ?) / 86400000 AS INTEGER) AS day, SUM(outcome='win') AS wins, COUNT(*) AS games
          FROM results WHERE key = ? AND created >= ? GROUP BY day`, since - (since % 86400000), key, since - (since % 86400000)).toArray();
        const sameKind = p.kind === "human" ? "kind = 'human'" : "kind IN ('claude', 'ai')";
        const rank = this.sql.exec(`
          SELECT COUNT(*) + 1 AS rank FROM (
            SELECT SUM(r.points) AS pts FROM results r JOIN players q ON q.key = r.key WHERE q.${sameKind} GROUP BY r.key)
          WHERE pts > (SELECT COALESCE(SUM(points), 0) FROM results WHERE key = ?)`, key).one().rank;
        return json({ name: p.name, kind: p.kind, model: key.startsWith("model:") ? key.slice(6) : null, created: p.created, breakdown, recent, daily, rank });
      }

      case "/stats": {
        // humans' results by opponent, and every bot's overall record
        const byMode = this.sql.exec(`
          SELECT mode, level, COUNT(*) AS games, SUM(outcome='win') AS wins, SUM(outcome='loss') AS losses, SUM(outcome='draw') AS draws
          FROM results r JOIN players p ON p.key = r.key WHERE p.kind = 'human' GROUP BY mode, level`).toArray();
        const bots = this.sql.exec(`
          SELECT p.name AS name, p.kind AS kind, COUNT(*) AS games, SUM(outcome='win') AS wins, SUM(outcome='loss') AS losses, SUM(outcome='draw') AS draws
          FROM results r JOIN players p ON p.key = r.key WHERE p.kind IN ('claude', 'ai') GROUP BY r.key ORDER BY SUM(r.points) DESC`).toArray();
        const players = this.sql.exec("SELECT COUNT(*) AS n FROM players WHERE kind = 'human'").one().n;
        const aiGames = this.sql.exec("SELECT COUNT(*) AS n FROM results r JOIN players p ON p.key = r.key WHERE p.kind IN ('claude', 'ai')").one().n;
        return json({ byMode, bots, players, aiGames });
      }
    }
    return json({ error: "Not found" }, 404);
  }
}
