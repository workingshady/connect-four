// Connect Four AI: negamax + alpha-beta, centre-first move ordering,
// Zobrist-hashed transposition table, immediate win/forced-block detection
// and iterative deepening with a time budget. Runs inside a Web Worker.
import { COLS, ROWS, CELLS, WINDOWS, idx } from "./rules.js";

export const LEVELS = {
  beginner: { name: "Beginner", depth: 0, time: 0, random: true, desc: "Plays random moves" },
  easy: { name: "Easy", depth: 1, time: 0, random: true, desc: "Looks 1 move ahead" },
  medium: { name: "Medium", depth: 3, time: 0, random: true, desc: "Looks 3 moves ahead" },
  hard: { name: "Hard", depth: 6, time: 0, random: true, desc: "Looks 6 moves ahead" },
  expert: { name: "Expert", depth: 12, time: 1500, random: false, desc: "Up to 12 moves deep" },
  master: { name: "Master", depth: 42, time: 3000, random: false, desc: "Near-perfect, 3s per move" },
};

const ORDER = [3, 2, 4, 1, 5, 0, 6];
const WIN = 1_000_000;
const CELL_WINDOWS = Array.from({ length: CELLS }, () => []);
for (const w of WINDOWS) for (const i of w) CELL_WINDOWS[i].push(w);
const CENTER = Array.from({ length: CELLS }, (_, i) => (Math.floor(i / ROWS) === 3 ? 1 : 0));
const Z = [null, [], []];
for (let p = 1; p <= 2; p++) for (let i = 0; i < CELLS; i++) Z[p].push((Math.random() * 2 ** 31) | 0);

class Timeout extends Error {}

class Search {
  constructor(moves, deadline) {
    this.board = new Int8Array(CELLS);
    this.h = new Int8Array(COLS);
    this.n = 0;
    this.hash = 0;
    this.tt = new Map();
    this.nodes = 0;
    this.deadline = deadline;
    for (const c of moves) this.play(c);
  }
  play(c) {
    const i = idx(c, this.h[c]);
    const p = (this.n % 2) + 1;
    this.board[i] = p;
    this.hash ^= Z[p][i];
    this.h[c]++;
    this.n++;
  }
  undo(c) {
    this.h[c]--;
    this.n--;
    const i = idx(c, this.h[c]);
    this.hash ^= Z[this.board[i]][i];
    this.board[i] = 0;
  }
  winsAt(i, p) {
    const b = this.board;
    for (const w of CELL_WINDOWS[i]) {
      let ok = true;
      for (const j of w) if (j !== i && b[j] !== p) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }
  evaluate(p) {
    const b = this.board, o = 3 - p;
    let s = 0;
    for (let i = 0; i < CELLS; i++) if (CENTER[i]) s += b[i] === p ? 3 : b[i] === o ? -3 : 0;
    for (const w of WINDOWS) {
      let mine = 0, theirs = 0;
      for (const j of w) { if (b[j] === p) mine++; else if (b[j] === o) theirs++; }
      if (!theirs) s += mine === 3 ? 6 : mine === 2 ? 2 : 0;
      else if (!mine) s -= theirs === 3 ? 6 : theirs === 2 ? 2 : 0;
    }
    return s;
  }
  negamax(depth, alpha, beta) {
    if ((++this.nodes & 2047) === 0 && this.deadline && performance.now() > this.deadline) throw new Timeout();
    const p = (this.n % 2) + 1, o = 3 - p;
    if (this.n >= CELLS) return 0;
    for (const c of ORDER) if (this.h[c] < ROWS && this.winsAt(idx(c, this.h[c]), p)) return WIN - this.n;
    if (this.n === CELLS - 1) return 0;

    // forced blocks / unstoppable double threats
    let forced = -1, threats = 0;
    for (const c of ORDER) {
      if (this.h[c] < ROWS && this.winsAt(idx(c, this.h[c]), o)) { forced = c; threats++; }
    }
    if (threats >= 2) return -(WIN - this.n - 1);
    if (depth <= 0) return this.evaluate(p);

    const alpha0 = alpha;
    const e = this.tt.get(this.hash);
    let ttMove = -1;
    if (e) {
      ttMove = e.m;
      if (e.d >= depth) {
        if (e.f === 0) return e.v;
        if (e.f === 1) alpha = Math.max(alpha, e.v); else beta = Math.min(beta, e.v);
        if (alpha >= beta) return e.v;
      }
    }

    let cols = forced >= 0 ? [forced] : ORDER.filter((c) => this.h[c] < ROWS);
    if (forced < 0) {
      // play safe moves first: moves that give the opponent the cell above come last
      const safe = [], risky = [];
      for (const c of cols) {
        const above = this.h[c] + 1;
        (above < ROWS && this.winsAt(idx(c, above), o) ? risky : safe).push(c);
      }
      cols = safe.concat(risky);
      if (ttMove >= 0 && cols.includes(ttMove)) cols = [ttMove, ...cols.filter((c) => c !== ttMove)];
    }

    let best = -2 * WIN, bestCol = cols[0];
    for (const c of cols) {
      this.play(c);
      const v = -this.negamax(depth - 1, -beta, -alpha);
      this.undo(c);
      if (v > best) { best = v; bestCol = c; }
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    if (this.tt.size > 2_000_000) this.tt.clear();
    this.tt.set(this.hash, { d: depth, f: best <= alpha0 ? 2 : best >= beta ? 1 : 0, v: best, m: bestCol });
    return best;
  }
  root(depth, randomTies) {
    const p = (this.n % 2) + 1;
    const cols = ORDER.filter((c) => this.h[c] < ROWS);
    for (const c of cols) if (this.winsAt(idx(c, this.h[c]), p)) return { col: c, score: WIN };
    const tt = this.tt.get(this.hash);
    if (tt && cols.includes(tt.m)) cols.sort((a, b) => (b === tt.m) - (a === tt.m));
    let alpha = -2 * WIN;
    const scores = new Map();
    for (const c of cols) {
      this.play(c);
      const v = -this.negamax(depth - 1, -2 * WIN, randomTies ? 2 * WIN : -alpha);
      this.undo(c);
      scores.set(c, v);
      alpha = Math.max(alpha, v);
    }
    const best = Math.max(...scores.values());
    const top = [...scores].filter(([, v]) => v === best).map(([c]) => c);
    return { col: randomTies ? top[(Math.random() * top.length) | 0] : top[0], score: best };
  }
}

/** Best column (0-6) for the side to move after `moves`. */
export function bestMove(moves, levelKey) {
  const L = LEVELS[levelKey] || LEVELS.medium;
  const s = new Search(moves, L.time ? performance.now() + L.time : 0);
  const legal = ORDER.filter((c) => s.h[c] < ROWS);
  if (L.depth === 0) return legal[(Math.random() * legal.length) | 0];
  let best = legal[0];
  for (let d = 1; d <= L.depth; d++) {
    try {
      const r = s.root(d, L.random && d === L.depth);
      best = r.col;
      if (Math.abs(r.score) >= WIN - 100 || s.n + d >= CELLS) break;
    } catch (e) {
      if (e instanceof Timeout) break;
      throw e;
    }
  }
  return best;
}
