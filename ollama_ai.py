"""Connect Four opponent powered by a local Ollama model.

The model gets the board as text plus the list of legal columns and must reply
with JSON {"column": 1-7, "reason": "..."} (enforced via Ollama's `format`).

Safety net (so the LLM isn't hopeless at tactics):
  * if the AI can win immediately, it plays that move;
  * if the opponent threatens to win next move, it blocks.
If the model is unreachable, too slow, or answers with an illegal column,
the move falls back to the built-in engine ("Medium").
"""
import json
import os
import re
import urllib.error
import urllib.request

import engine as E

HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
if not HOST.startswith("http"):
    HOST = "http://" + HOST
TIMEOUT = 90  # first call may need to load the model into memory
PREFERRED = ["qwen2.5:3b-instruct", "qwen3:4b", "llama3:latest"]

SCHEMA = {
    "type": "object",
    "properties": {
        "column": {"type": "integer", "minimum": 1, "maximum": 7},
        "reason": {"type": "string"},
    },
    "required": ["column", "reason"],
}

# Strategy distilled from Connect Four theory (Allis 1988 solution, Wikibooks,
# MIT ES.268 notes): priorities, centre control, threat parity and zugzwang.
SYSTEM = """You are an expert Connect Four player.
Rules: 7 columns (1-7), 6 rows (row 1 = bottom). A piece drops to the lowest empty
cell of its column. Four of your pieces in a row horizontally, vertically or
diagonally wins.

Choose your move with these priorities, in order:
1. WIN: if a move completes four in a row, play it.
2. BLOCK: if O could win next turn, play in that cell's column.
3. SAFETY: never play a move marked UNSAFE (it lets O win on the cell above it).
4. DOUBLE THREAT: prefer a move that creates two winning cells at once; O can only
   block one, so it usually wins the game.
5. PARITY (zugzwang): the player who moved first wants threats on ODD rows (1,3,5);
   the player who moved second wants threats on EVEN rows (2,4,6). Threats on your
   good rows tend to win the endgame because the opponent is forced to play under them.
   Do not play directly under your own threat.
6. CENTRE: column 4 is part of the most possible fours; then 3 and 5; edges (1, 7)
   are weakest. With no tactics on the board, play as central as possible.
   On an empty board, play column 4.
7. BUILD: prefer moves that connect to your pieces with open space on both sides
   and that take cells O needs.

Use the move analysis you are given; it is computed exactly and is reliable.
Reply ONLY with JSON: {"column": <1-7>, "reason": "<max 12 words>"}"""


def analyse_moves(cur, mask, legal):
    """Exact per-column facts for the model (X = side to move)."""
    opp = cur ^ mask
    opp_threats_now = E.winning_spots(opp, mask)
    my_threats_now = E.winning_spots(cur, mask)
    first_player = bin(mask).count("1") % 2 == 0  # X moves first if an even number of pieces is on the board
    good_rows = "odd" if first_player else "even"
    lines = []
    for c in legal:
        mv = E.possible(mask) & E.column_mask(c)
        row = E.popcount(mask & E.column_mask(c)) + 1
        new_mask = mask | mv
        tags = []
        if E.is_win(cur | mv):
            tags.append("WINS NOW")
        if mv & opp_threats_now:
            tags.append("blocks O's win")
        opp_after = E.winning_spots(opp, new_mask) & E.possible(new_mask)
        if opp_after and not E.is_win(cur | mv):
            tags.append("UNSAFE: O wins next")
        created = E.winning_spots(cur | mv, new_mask) & ~my_threats_now
        n_new = E.popcount(created)
        if n_new:
            rows = sorted({(b.bit_length() - 1) % E.H1 + 1 for b in _bits(created)})
            good = [r for r in rows if (r % 2 == 1) == first_player]
            tags.append(f"creates {n_new} threat(s) on row(s) {rows}"
                        + (f", {len(good)} on your good ({good_rows}) rows" if good else ""))
            immediate = created & E.possible(new_mask)
            if E.popcount(immediate) >= 2:
                tags.append("DOUBLE THREAT")
        lines.append(f"- column {c + 1}: lands on row {row}" + ("; " + "; ".join(tags) if tags else ""))
    return first_player, "\n".join(lines)


def _bits(x):
    while x:
        low = x & -x
        yield low
        x ^= low


def _request(path, payload=None, timeout=3):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(HOST + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def list_models():
    """Installed model names (chat-capable first in PREFERRED order). [] if Ollama is down."""
    try:
        names = [m["name"] for m in _request("/api/tags").get("models", [])]
    except Exception:
        return []
    names = [n for n in names if "embed" not in n]
    return sorted(names, key=lambda n: (PREFERRED.index(n) if n in PREFERRED else len(PREFERRED), n))


def board_text(cur, mask):
    """Board as text: X = AI (player to move), O = opponent, top row first."""
    lines = ["  1 2 3 4 5 6 7"]
    for r in range(E.HEIGHT - 1, -1, -1):
        row = []
        for c in range(E.WIDTH):
            bit = 1 << (c * E.H1 + r)
            row.append("." if not mask & bit else ("X" if cur & bit else "O"))
        lines.append(f"{r + 1} " + " ".join(row))
    return "\n".join(lines)


def _col_of(bits):
    for c in range(E.WIDTH):
        if bits & E.column_mask(c):
            return c
    return None


def ask_model(model, cur, mask, legal):
    first, analysis = analyse_moves(cur, mask, legal)
    prompt = (
        f"You are X. Your opponent is O. You moved {'FIRST' if first else 'SECOND'}, "
        f"so your good threat rows are {'ODD (1,3,5)' if first else 'EVEN (2,4,6)'}.\n"
        f"Current board (row 1 is the bottom):\n"
        f"{board_text(cur, mask)}\n\n"
        f"Move analysis:\n{analysis}\n\n"
        f"Which column do you play?"
    )
    payload = {
        "model": model,
        "stream": False,
        "format": SCHEMA,
        "keep_alive": "15m",
        "options": {"temperature": 0.2, "num_predict": 120},
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
    }
    if model.startswith("qwen3"):
        payload["think"] = False  # qwen3 is a thinking model; skip the long reasoning trace
    try:
        resp = _request("/api/chat", payload, timeout=TIMEOUT)
    except urllib.error.HTTPError as e:
        if "think" in payload and e.code == 400:  # model doesn't support the think flag
            payload.pop("think")
            resp = _request("/api/chat", payload, timeout=TIMEOUT)
        else:
            raise
    text = resp.get("message", {}).get("content", "")
    try:
        data = json.loads(text)
        col, reason = int(data["column"]) - 1, str(data.get("reason", ""))
    except Exception:
        m = re.search(r"[1-7]", text)
        if not m:
            raise ValueError(f"unparseable reply: {text[:80]!r}")
        col, reason = int(m.group()) - 1, ""
    return col, reason.strip()


def choose_move(cur, mask, moves, model, safety_net=True):
    """Return (column, note) where note explains where the move came from."""
    poss = E.possible(mask)
    legal = [c for c in range(E.WIDTH) if poss & E.column_mask(c)]

    if safety_net:
        win = E.winning_spots(cur, mask) & poss
        if win:
            return _col_of(win), "takes the winning move"
        block = E.winning_spots(cur ^ mask, mask) & poss
        if block:
            return _col_of(block), "blocks your four-in-a-row"

    try:
        col, reason = ask_model(model, cur, mask, legal)
    except Exception as e:
        return E.best_move(cur, mask, moves, "Medium"), f"(model error, engine moved: {type(e).__name__})"
    if col not in legal:
        return E.best_move(cur, mask, moves, "Medium"), f"(illegal column {col + 1}, engine moved)"
    return col, reason or "…"
