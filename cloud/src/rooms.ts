// Room code helpers shared by the HTTP API and the MCP server.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L confusion

export function normaliseRoom(input: string): string | null {
  const code = input.trim().split("/").filter(Boolean).pop()?.toUpperCase() ?? "";
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

export function roomStub(env: Env, id: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(id));
}

export async function createRoom(env: Env, opts: { mode: string; first?: string; name?: string; byClaude?: boolean; auth?: string }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const id = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
    const res = await roomStub(env, id).fetch("https://room/init", {
      method: "POST",
      body: JSON.stringify({ id, ...opts }),
    });
    if (res.status === 409) continue; // code already taken
    return (await res.json()) as { id: string; token: string | null };
  }
  throw new Error("Could not allocate a room code");
}
