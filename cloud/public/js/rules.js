// Connect Four rules shared by the browser and the Cloudflare Worker.
// Cells are column-major: index = col * ROWS + row, row 0 = bottom.
export const COLS = 7;
export const ROWS = 6;
export const CELLS = COLS * ROWS;

export const idx = (c, r) => c * ROWS + r;

// Every 4-cell line on the board (69 of them) as index arrays.
export const WINDOWS = [];
for (let c = 0; c < COLS; c++) {
  for (let r = 0; r < ROWS; r++) {
    for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const cells = [];
      for (let i = 0; i < 4; i++) {
        const x = c + i * dc, y = r + i * dr;
        if (x < 0 || x >= COLS || y < 0 || y >= ROWS) break;
        cells.push(idx(x, y));
      }
      if (cells.length === 4) WINDOWS.push(cells);
    }
  }
}

/** Replay a list of columns. Player 1 moves first. */
export function fromMoves(moves) {
  const board = new Array(CELLS).fill(0);
  const heights = new Array(COLS).fill(0);
  moves.forEach((c, n) => {
    board[idx(c, heights[c])] = (n % 2) + 1;
    heights[c]++;
  });
  return { board, heights };
}

export function legalColumns(heights) {
  const out = [];
  for (let c = 0; c < COLS; c++) if (heights[c] < ROWS) out.push(c);
  return out;
}

/** {winner: 1|2, line: [[col,row] x4]} | {winner: 0} for a draw | null while playing. */
export function result(board) {
  for (const w of WINDOWS) {
    const p = board[w[0]];
    if (p && board[w[1]] === p && board[w[2]] === p && board[w[3]] === p) {
      return { winner: p, line: w.map((i) => [Math.floor(i / ROWS), i % ROWS]) };
    }
  }
  if (board.every((v) => v !== 0)) return { winner: 0, line: null };
  return null;
}

/** Text board for LLMs: row 6 at the top, columns numbered 1-7. */
export function boardText(board, marks = { 1: "R", 2: "Y" }) {
  const lines = ["  1 2 3 4 5 6 7"];
  for (let r = ROWS - 1; r >= 0; r--) {
    let line = `${r + 1} `;
    for (let c = 0; c < COLS; c++) line += (marks[board[idx(c, r)]] || ".") + " ";
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}
