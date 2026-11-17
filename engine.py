"""Connect Four AI engine.

Optimisations (vs. the original numpy minimax in easy/medium/hard.py):
  * Bitboards: each side is one Python int (7 bits per column, 6 rows + 1
    sentinel bit). Win detection = a few shifts and ANDs instead of nested loops.
  * Negamax + alpha-beta pruning.
  * Move ordering: transposition-table move first, then moves that create the
    most new threats, then centre columns first.
  * Transposition table keyed by (position + mask), a unique 49-bit code.
  * "Non-losing moves": forced blocks are detected instantly and moves that
    let the opponent win on top of them are skipped.
  * Iterative deepening with a time budget, so deep levels never freeze the UI.
"""
import random
import time

WIDTH = 7
HEIGHT = 6
H1 = HEIGHT + 1

BOTTOM = sum(1 << (c * H1) for c in range(WIDTH))
BOARD_MASK = BOTTOM * ((1 << HEIGHT) - 1)
CENTER_ORDER = [3, 2, 4, 1, 5, 0, 6]

WIN = 1_000_000


def bottom_mask(col):
    return 1 << (col * H1)


def top_mask(col):
    return 1 << (HEIGHT - 1 + col * H1)


def column_mask(col):
    return ((1 << HEIGHT) - 1) << (col * H1)


def popcount(x):
    return bin(x).count("1")


def winning_spots(p, mask):
    """Empty cells that would complete four-in-a-row for bitboard p."""
    # vertical
    r = (p << 1) & (p << 2) & (p << 3)
    # horizontal (7) and both diagonals (6, 8)
    for s in (H1, H1 - 1, H1 + 1):
        t = (p << s) & (p << 2 * s)
        r |= t & (p << 3 * s)
        r |= t & (p >> s)
        t = (p >> s) & (p >> 2 * s)
        r |= t & (p << s)
        r |= t & (p >> 3 * s)
    return r & (BOARD_MASK ^ mask)


def possible(mask):
    """Bit of the next playable cell in every non-full column."""
    return (mask + BOTTOM) & BOARD_MASK


def is_win(p):
    for s in (1, H1, H1 - 1, H1 + 1):
        m = p & (p >> s)
        if m & (m >> 2 * s):
            return True
    return False


# Every 4-cell window on the board as a bitmask (69 of them), built once.
WINDOWS = []
for _c in range(WIDTH):
    for _r in range(HEIGHT):
        for _dc, _dr in ((1, 0), (0, 1), (1, 1), (1, -1)):
            cells = [(_c + i * _dc, _r + i * _dr) for i in range(4)]
            if all(0 <= x < WIDTH and 0 <= y < HEIGHT for x, y in cells):
                WINDOWS.append(sum(1 << (x * H1 + y) for x, y in cells))
CENTER_MASK = column_mask(3)
WINDOW_SCORE = {0: 0, 1: 0, 2: 2, 3: 6, 4: 0}


def evaluate(cur, mask):
    """Heuristic score from the side-to-move's point of view."""
    opp = cur ^ mask
    score = 3 * (popcount(cur & CENTER_MASK) - popcount(opp & CENTER_MASK))
    for w in WINDOWS:
        a = cur & w
        b = opp & w
        if not b:
            score += WINDOW_SCORE[popcount(a)]
        elif not a:
            score -= WINDOW_SCORE[popcount(b)]
    # open threats (cells that would win) are worth a lot
    score += 8 * popcount(winning_spots(cur, mask)) - 8 * popcount(winning_spots(opp, mask))
    return score


class _Timeout(Exception):
    pass


class Searcher:
    def __init__(self, deadline=None):
        self.tt = {}
        self.nodes = 0
        self.deadline = deadline

    def ordered_moves(self, cur, mask, moves_bits, tt_move):
        order = []
        for col in CENTER_ORDER:
            mv = moves_bits & column_mask(col)
            if mv:
                threats = popcount(winning_spots(cur | mv, mask | mv))
                order.append((col == tt_move, threats, -abs(3 - col), col, mv))
        order.sort(reverse=True)
        return [(o[3], o[4]) for o in order]

    def negamax(self, cur, mask, moves, depth, alpha, beta):
        self.nodes += 1
        if self.deadline and (self.nodes & 1023) == 0 and time.perf_counter() > self.deadline:
            raise _Timeout

        poss = possible(mask)
        # 1. win right now?
        if winning_spots(cur, mask) & poss:
            return WIN - moves
        if moves >= WIDTH * HEIGHT - 1:
            return 0  # we can't win now and the board fills up

        # 2. only keep moves that don't lose immediately
        opp = cur ^ mask
        opp_win = winning_spots(opp, mask)
        forced = poss & opp_win
        if forced:
            if forced & (forced - 1):
                return -(WIN - moves - 1)  # two threats: can't block both
            poss = forced
        poss &= ~(opp_win >> 1)  # don't play directly under an opponent threat
        if not poss:
            return -(WIN - moves - 1)

        if depth <= 0:
            return evaluate(cur, mask)

        alpha0 = alpha
        key = cur + mask
        entry = self.tt.get(key)
        tt_move = -1
        if entry is not None:
            e_depth, e_flag, e_val, tt_move = entry
            if e_depth >= depth:
                if e_flag == 0:
                    return e_val
                if e_flag == 1:
                    alpha = max(alpha, e_val)
                else:
                    beta = min(beta, e_val)
                if alpha >= beta:
                    return e_val

        best = -WIN * 2
        best_col = -1
        for col, mv in self.ordered_moves(cur, mask, poss, tt_move):
            new_mask = mask | mv
            val = -self.negamax(cur ^ mask, new_mask, moves + 1, depth - 1, -beta, -alpha)
            if val > best:
                best, best_col = val, col
            if val > alpha:
                alpha = val
            if alpha >= beta:
                break

        flag = 0 if alpha0 < best < beta else (1 if best >= beta else 2)
        self.tt[key] = (depth, flag, best, best_col)
        return best

    def root(self, cur, mask, moves, depth, random_ties):
        poss = possible(mask)
        cols = [c for c in CENTER_ORDER if poss & column_mask(c)]
        tt_move = self.tt.get(cur + mask, (0, 0, 0, -1))[3]
        cols.sort(key=lambda c: c != tt_move)
        scores = {}
        alpha, beta = -WIN * 2, WIN * 2
        for col in cols:
            mv = poss & column_mask(col)
            if is_win(cur | mv):
                return col, WIN
            a = -WIN * 2 if random_ties else alpha
            val = -self.negamax(cur ^ mask, mask | mv, moves + 1, depth - 1, -beta, -a)
            scores[col] = val
            alpha = max(alpha, val)
        best = max(scores.values())
        choices = [c for c, v in scores.items() if v == best]
        return (random.choice(choices) if random_ties else choices[0]), best


# --------------------------------------------------------------------- levels
# name: (max depth, time budget seconds or None, random tie-breaks, description)
LEVELS = {
    "Beginner": (0, None, True, "Plays random moves"),
    "Easy": (1, None, True, "Looks 1 move ahead"),
    "Medium": (3, None, True, "Looks 3 moves ahead"),
    "Hard": (6, None, True, "Looks 6 moves ahead"),
    "Expert": (10, 2.0, False, "Up to 10 moves, 2s"),
    "Master": (42, 4.0, False, "Deep search, 4s"),
}


def best_move(cur, mask, moves, level):
    """Return the column the AI plays. `cur` is the side-to-move's bitboard."""
    max_depth, budget, random_ties, _ = LEVELS[level]
    poss = possible(mask)
    legal = [c for c in range(WIDTH) if poss & column_mask(c)]
    if max_depth == 0:
        return random.choice(legal)

    deadline = time.perf_counter() + budget if budget else None
    s = Searcher(deadline)
    best_col = legal[0]
    for d in range(1, max_depth + 1):
        try:
            col, score = s.root(cur, mask, moves, d, random_ties and d == max_depth)
        except _Timeout:
            break
        best_col = col
        if abs(score) >= WIN - 100 or moves + d >= WIDTH * HEIGHT:
            break  # result is proven, deeper search won't change it
    return best_col


# ---------------------------------------------------------------- game state
class Board:
    """Game state for the UI: bitboards for the AI plus undo history."""

    def __init__(self):
        self.cur = 0      # pieces of the player to move
        self.mask = 0     # all pieces
        self.moves = 0
        self.history = []

    @property
    def to_move(self):
        return 1 + self.moves % 2  # 1 = first player (red), 2 = second (yellow)

    def can_play(self, col):
        return 0 <= col < WIDTH and not (self.mask & top_mask(col))

    def height(self, col):
        return popcount(self.mask & column_mask(col))

    def play(self, col):
        row = self.height(col)
        self.history.append((self.cur, self.mask))
        self.cur ^= self.mask
        self.mask |= self.mask + bottom_mask(col)
        self.moves += 1
        return row

    def undo(self):
        if self.history:
            self.cur, self.mask = self.history.pop()
            self.moves -= 1

    def cell(self, col, row):
        bit = 1 << (col * H1 + row)
        if not self.mask & bit:
            return 0
        # self.cur belongs to player `to_move`
        return self.to_move if self.cur & bit else 3 - self.to_move

    def winner_cells(self):
        """(player, [(col,row) x4]) if someone has won, else None."""
        for c in range(WIDTH):
            for r in range(HEIGHT):
                p = self.cell(c, r)
                if not p:
                    continue
                for dc, dr in ((1, 0), (0, 1), (1, 1), (1, -1)):
                    cells = [(c + i * dc, r + i * dr) for i in range(4)]
                    if all(0 <= x < WIDTH and 0 <= y < HEIGHT and self.cell(x, y) == p for x, y in cells):
                        return p, cells
        return None

    def is_full(self):
        return self.moves == WIDTH * HEIGHT
