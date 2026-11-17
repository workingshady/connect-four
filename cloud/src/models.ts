// Claude model ids -> one shared leaderboard identity per model.
// "claude-opus-5-5", "claude-opus-5-5-20261001" and "Claude-Opus-5-5[1m]" all map to
// key "model:claude-opus-5-5", name "Claude Opus 5.5".

export interface ModelInfo { id: string; key: string; name: string }

export function modelInfo(raw: unknown): ModelInfo | null {
  if (typeof raw !== "string") return null;
  let id = raw.toLowerCase().trim().replace(/\[.*?\]/g, "").replace(/^(us|eu|apac|global)\.anthropic\./, "").replace(/^anthropic[./]/, "");
  id = id.replace(/@.*$/, "").replace(/-v\d+(:\d+)?$/, "").replace(/[^a-z0-9.-]/g, "");
  if (!/^claude-[a-z0-9.-]{2,40}$/.test(id)) return null;
  // drop date snapshots (8 digits) and "latest" so every snapshot shares the account
  const parts = id.split("-").filter((p) => p && !/^\d{8}$/.test(p) && p !== "latest");
  if (parts.length < 2) return null;
  const words: string[] = [];
  let nums: string[] = [];
  const flush = () => { if (nums.length) { words.push(nums.join(".")); nums = []; } };
  for (const p of parts.slice(1)) {
    if (/^\d{1,2}$/.test(p)) nums.push(p);
    else { flush(); words.push(p.charAt(0).toUpperCase() + p.slice(1)); }
  }
  flush();
  const canonical = parts.join("-");
  return { id: canonical, key: `model:${canonical}`, name: `Claude ${words.join(" ")}`.slice(0, 40) };
}
