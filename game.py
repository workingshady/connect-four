"""Connect Four - single-file Pygame app (replaces GUI.py + lvl.py + easy/medium/hard.py).

Run:  pip install pygame
      python game.py

Keys in game:  R restart · U undo · H hint · Esc back to menu
"""
import random
import sys
import threading

import pygame

import engine as E
import ollama_ai

# ------------------------------------------------------------------ layout
SQ = 90
COLS, ROWS = E.WIDTH, E.HEIGHT
TOP = SQ                    # hover row above the board
BAR = 64                    # status bar below the board
W = COLS * SQ
H = TOP + ROWS * SQ + BAR
RADIUS = SQ // 2 - 8

# ------------------------------------------------------------------ palette
BG = (17, 24, 39)
PANEL = (31, 41, 55)
BOARD = (37, 99, 235)
BOARD_DARK = (29, 78, 216)
HOLE = (15, 23, 42)
TEXT = (243, 244, 246)
MUTED = (156, 163, 175)
RED = (239, 68, 68)
RED_DARK = (185, 28, 28)
YELLOW = (250, 204, 21)
YELLOW_DARK = (202, 138, 4)
GREEN = (34, 197, 94)
PIECE = {1: (RED, RED_DARK), 2: (YELLOW, YELLOW_DARK)}

LEVEL_COLORS = [(34, 197, 94), (132, 204, 22), (234, 179, 8), (249, 115, 22), (239, 68, 68), (168, 85, 247)]


def font(size, bold=True):
    return pygame.font.SysFont("segoeui,helveticaneue,arial", size, bold=bold)


def draw_piece(surf, color_pair, center, r=RADIUS, alpha=255):
    light, dark = color_pair
    if alpha < 255:
        tmp = pygame.Surface((r * 2 + 4, r * 2 + 4), pygame.SRCALPHA)
        pygame.draw.circle(tmp, (*light, alpha), (r + 2, r + 2), r)
        surf.blit(tmp, (center[0] - r - 2, center[1] - r - 2))
        return
    pygame.draw.circle(surf, dark, center, r)
    pygame.draw.circle(surf, light, center, r - 5)
    pygame.draw.circle(surf, dark, center, r - 14, 3)


class Button:
    def __init__(self, rect, text, color=BOARD, sub=None):
        self.rect = pygame.Rect(rect)
        self.text, self.color, self.sub = text, color, sub

    def draw(self, surf, mouse):
        hover = self.rect.collidepoint(mouse)
        rect = self.rect.move(0, -2) if hover else self.rect
        shade = tuple(max(0, c - 40) for c in self.color)
        pygame.draw.rect(surf, shade, rect.move(0, 4), border_radius=14)
        pygame.draw.rect(surf, self.color, rect, border_radius=14)
        if self.sub:
            t = font(26).render(self.text, True, TEXT)
            s = font(15, False).render(self.sub, True, TEXT)
            surf.blit(t, t.get_rect(midleft=(rect.x + 20, rect.centery - 10)))
            surf.blit(s, s.get_rect(midleft=(rect.x + 20, rect.centery + 14)))
        else:
            t = font(28).render(self.text, True, TEXT)
            surf.blit(t, t.get_rect(center=rect.center))

    def clicked(self, event):
        return event.type == pygame.MOUSEBUTTONDOWN and event.button == 1 and self.rect.collidepoint(event.pos)


class App:
    def __init__(self):
        pygame.init()
        pygame.display.set_caption("Connect Four")
        # SCALED: game renders at W x H and is stretched (aspect kept) to any
        # window size or full screen; mouse positions are mapped back for us.
        self.screen = pygame.display.set_mode((W, H), pygame.SCALED | pygame.RESIZABLE)
        self.fullscreen = False
        self.clock = pygame.time.Clock()
        self.scene = "menu"
        self.level = "Medium"
        self.first = "You"            # You / AI / Random
        self.vs_ai = True
        self.score = {1: 0, 2: 0, 0: 0}
        self.ollama_model = None
        self.ollama_models = None     # fetched when the model picker opens
        # board overlay with transparent holes, built once
        self.board_surf = pygame.Surface((W, ROWS * SQ), pygame.SRCALPHA)
        self.board_surf.fill(BOARD)
        pygame.draw.rect(self.board_surf, BOARD_DARK, (0, ROWS * SQ - 8, W, 8))
        for c in range(COLS):
            for r in range(ROWS):
                centre = (c * SQ + SQ // 2, r * SQ + SQ // 2)
                pygame.draw.circle(self.board_surf, BOARD_DARK, centre, RADIUS + 3)
                pygame.draw.circle(self.board_surf, (0, 0, 0, 0), centre, RADIUS)
        self.col_hl = pygame.Surface((SQ, ROWS * SQ), pygame.SRCALPHA)
        self.col_hl.fill((255, 255, 255, 22))
        self.reset_game()

    # ------------------------------------------------------------ game state
    def reset_game(self):
        self.board = E.Board()
        self.result = None            # None | (winner, cells) | (0, [])
        self.anim = None              # falling piece: dict(col,row,player,y,vy)
        self.ai_thread = None
        self.ai_result = None
        self.gen = getattr(self, "gen", 0) + 1
        self.hint_col = None
        self.ai_note = ""
        if self.vs_ai:
            first = self.first if self.first != "Random" else random.choice(["You", "AI"])
            self.human = 1 if first == "You" else 2
        else:
            self.human = None

    def ai_turn(self):
        return self.vs_ai and self.result is None and self.board.to_move != self.human

    def start_ai(self, level=None, hint=False):
        b, gen = self.board, self.gen
        args = (b.cur, b.mask, b.moves, level or self.level)

        def work():
            if args[3] == "Ollama":
                col, note = ollama_ai.choose_move(*args[:3], self.ollama_model)
                self.ai_note = f"{self.ollama_model}: {note}"
            else:
                col = E.best_move(*args)
            self.ai_result = (gen, col, hint)

        self.ai_result = None
        self.ai_thread = threading.Thread(target=work, daemon=True)
        self.ai_thread.start()

    def drop(self, col):
        if self.anim or self.result or not self.board.can_play(col):
            return
        player = self.board.to_move
        row = self.board.play(col)
        self.hint_col = None
        self.anim = {"col": col, "row": row, "player": player, "y": TOP // 2, "vy": 0.0}

    def finish_anim(self):
        self.anim = None
        w = self.board.winner_cells()
        if w:
            self.result = w
            self.score[w[0]] += 1
        elif self.board.is_full():
            self.result = (0, [])
            self.score[0] += 1

    def undo(self):
        if self.anim or self.thinking():
            return
        steps = 2 if self.vs_ai and self.board.moves >= 2 else 1
        if self.vs_ai and self.board.to_move != self.human:
            steps = 1  # undoing the human's move that the AI hasn't answered yet
        for _ in range(steps):
            self.board.undo()
        if self.result:
            self.score[self.result[0]] -= 1
            self.result = None
        self.hint_col = None

    def thinking(self):
        return self.ai_thread is not None and self.ai_thread.is_alive()

    # ------------------------------------------------------------ scenes
    def run(self):
        while True:
            mouse = pygame.mouse.get_pos()
            events = pygame.event.get()
            for e in events:
                if e.type == pygame.QUIT:
                    pygame.quit()
                    sys.exit()
                if e.type == pygame.KEYDOWN and (e.key == pygame.K_F11 or
                                                 (e.key == pygame.K_RETURN and e.mod & pygame.KMOD_ALT)):
                    self.toggle_fullscreen()
            getattr(self, "scene_" + self.scene)(events, mouse)
            pygame.display.flip()
            self.clock.tick(60)

    def toggle_fullscreen(self):
        pygame.display.toggle_fullscreen()
        self.fullscreen = not self.fullscreen

    def title(self, text, y, size=64):
        t = font(size).render(text, True, TEXT)
        self.screen.blit(t, t.get_rect(center=(W // 2, y)))

    def scene_menu(self, events, mouse):
        self.screen.fill(BG)
        # decorative pieces
        for i, c in enumerate([1, 2, 1, 2]):
            draw_piece(self.screen, PIECE[c], (W // 2 - 135 + i * 90, 110), 34)
        self.title("Connect Four", 210, 72)
        sub = font(18, False).render("Get four in a row before the other player does", True, MUTED)
        self.screen.blit(sub, sub.get_rect(center=(W // 2, 262)))
        buttons = [
            Button((W // 2 - 160, 310, 320, 66), "Play vs AI", BOARD),
            Button((W // 2 - 160, 392, 320, 66), "Two Players", (16, 185, 129)),
            Button((W // 2 - 160, 474, 320, 66),
                   "Exit Full Screen" if self.fullscreen else "Full Screen", (124, 58, 237)),
            Button((W // 2 - 160, 556, 320, 66), "Quit", (75, 85, 99)),
        ]
        hint = font(14, False).render("F11 or Alt+Enter toggles full screen anytime", True, MUTED)
        self.screen.blit(hint, hint.get_rect(center=(W // 2, H - 26)))
        for b in buttons:
            b.draw(self.screen, mouse)
        for e in events:
            if buttons[0].clicked(e):
                self.scene = "levels"
            elif buttons[1].clicked(e):
                self.vs_ai = False
                self.reset_game()
                self.scene = "game"
            elif buttons[2].clicked(e):
                self.toggle_fullscreen()
            elif buttons[3].clicked(e):
                pygame.quit()
                sys.exit()

    def scene_levels(self, events, mouse):
        self.screen.fill(BG)
        self.title("Choose a level", 52, 46)
        buttons = []
        for i, (name, (_, _, _, desc)) in enumerate(E.LEVELS.items()):
            x = 30 + (i % 2) * (W // 2 - 15)
            y = 96 + (i // 2) * 88
            buttons.append((name, Button((x, y, W // 2 - 45, 76), name, LEVEL_COLORS[i], desc)))
        llm_desc = f"Local LLM · {self.ollama_model}" if self.ollama_model else "Play a local LLM via Ollama"
        buttons.append(("Ollama", Button((30, 96 + 3 * 88, W - 60, 76), "Ollama AI", (13, 148, 136), llm_desc)))
        for _, b in buttons:
            b.draw(self.screen, mouse)

        # who goes first selector
        lab = font(20).render("First move:", True, MUTED)
        self.screen.blit(lab, (30, 492))
        opts = []
        for i, o in enumerate(["You", "AI", "Random"]):
            r = pygame.Rect(170 + i * 140, 480, 125, 48)
            sel = o == self.first
            pygame.draw.rect(self.screen, BOARD if sel else PANEL, r, border_radius=12)
            t = font(20).render(o, True, TEXT if sel else MUTED)
            self.screen.blit(t, t.get_rect(center=r.center))
            opts.append((o, r))

        back = Button((30, H - 110, 160, 60), "Back", (75, 85, 99))
        back.draw(self.screen, mouse)
        tip = font(16, False).render("Tip: Expert & Master think for a couple of seconds", True, MUTED)
        self.screen.blit(tip, tip.get_rect(midright=(W - 30, H - 80)))

        for e in events:
            for name, b in buttons:
                if b.clicked(e):
                    if name == "Ollama":
                        self.ollama_models = None  # refresh list
                        self.scene = "models"
                        return
                    self.level, self.vs_ai = name, True
                    self.reset_game()
                    self.scene = "game"
            for o, r in opts:
                if e.type == pygame.MOUSEBUTTONDOWN and r.collidepoint(e.pos):
                    self.first = o
            if back.clicked(e) or (e.type == pygame.KEYDOWN and e.key == pygame.K_ESCAPE):
                self.scene = "menu"

    def scene_models(self, events, mouse):
        """Pick which installed Ollama model to play against."""
        if self.ollama_models is None:
            self.ollama_models = ollama_ai.list_models()
        self.screen.fill(BG)
        self.title("Choose a model", 52, 46)
        sub = font(16, False).render(f"Installed on {ollama_ai.HOST}", True, MUTED)
        self.screen.blit(sub, sub.get_rect(center=(W // 2, 96)))

        buttons = []
        for i, name in enumerate(self.ollama_models[:7]):
            if name == "qwen2.5:3b-instruct":
                note = "recommended · fast"
            elif any(k in name for k in ("30b", "vl")):
                note = "large · slow replies"
            else:
                note = None
            color = (13, 148, 136) if i == 0 else PANEL
            buttons.append((name, Button((60, 120 + i * 62, W - 120, 54), name, color, note)))
        for _, b in buttons:
            b.draw(self.screen, mouse)

        retry = None
        if not self.ollama_models:
            for j, line in enumerate(["Couldn't reach Ollama.", "Start the Ollama app, then retry."]):
                t = font(22, j == 0).render(line, True, TEXT if j == 0 else MUTED)
                self.screen.blit(t, t.get_rect(center=(W // 2, 220 + j * 36)))
            retry = Button((W // 2 - 90, 320, 180, 60), "Retry", BOARD)
            retry.draw(self.screen, mouse)

        back = Button((30, H - 90, 160, 60), "Back", (75, 85, 99))
        back.draw(self.screen, mouse)
        for e in events:
            for name, b in buttons:
                if b.clicked(e):
                    self.ollama_model, self.level, self.vs_ai = name, "Ollama", True
                    self.reset_game()
                    self.scene = "game"
            if retry and retry.clicked(e):
                self.ollama_models = None
            if back.clicked(e) or (e.type == pygame.KEYDOWN and e.key == pygame.K_ESCAPE):
                self.scene = "levels"

    def scene_game(self, events, mouse):
        b = self.board
        hover_col = mouse[0] // SQ if 0 <= mouse[0] < W else None
        human_turn = self.result is None and not self.anim and (not self.vs_ai or b.to_move == self.human)

        # --- input
        for e in events:
            if e.type == pygame.KEYDOWN:
                if e.key == pygame.K_ESCAPE:
                    self.gen += 1
                    self.scene = "levels" if self.vs_ai else "menu"
                    return
                if e.key == pygame.K_r:
                    self.reset_game()
                if e.key == pygame.K_u:
                    self.undo()
                if e.key == pygame.K_h and human_turn and not self.thinking():
                    self.start_ai("Expert", hint=True)
                if pygame.K_1 <= e.key <= pygame.K_7 and human_turn:
                    self.drop(e.key - pygame.K_1)
            if e.type == pygame.MOUSEBUTTONDOWN and e.button == 1:
                if self.result and self.again_rect().collidepoint(e.pos):
                    self.reset_game()
                elif self.result and self.menu_rect().collidepoint(e.pos):
                    self.scene = "levels" if self.vs_ai else "menu"
                    return
                elif human_turn and 0 <= e.pos[0] < W and e.pos[1] < TOP + ROWS * SQ:
                    self.drop(e.pos[0] // SQ)

        # --- AI
        if self.ai_turn() and not self.anim and not self.thinking() and self.ai_result is None:
            self.start_ai()
        if self.ai_result and not self.thinking():
            gen, col, hint = self.ai_result
            self.ai_result = None
            if gen == self.gen:
                if hint:
                    self.hint_col = col
                elif self.ai_turn():
                    self.drop(col)

        # --- falling animation
        if self.anim:
            a = self.anim
            target = TOP + (ROWS - 1 - a["row"]) * SQ + SQ // 2
            a["vy"] += 2.2
            a["y"] += a["vy"]
            if a["y"] >= target:
                if a["vy"] > 6:   # small bounce
                    a["y"], a["vy"] = target, -a["vy"] * 0.3
                else:
                    self.finish_anim()

        self.draw_game(hover_col if human_turn else None)

    # ------------------------------------------------------------ drawing
    def draw_game(self, hover_col):
        s, b = self.screen, self.board
        s.fill(BG)

        pygame.draw.rect(s, HOLE, (0, TOP, W, ROWS * SQ))  # what shows through empty holes

        # ghost piece where the hovered move would land
        if hover_col is not None and b.can_play(hover_col):
            row = b.height(hover_col)
            draw_piece(s, PIECE[b.to_move], (hover_col * SQ + SQ // 2, TOP + (ROWS - 1 - row) * SQ + SQ // 2), alpha=70)

        # placed pieces + falling piece go *behind* the board, seen through the holes
        anim_cell = (self.anim["col"], self.anim["row"]) if self.anim else None
        for c in range(COLS):
            for r in range(ROWS):
                p = b.cell(c, r)
                if p and (c, r) != anim_cell:
                    draw_piece(s, PIECE[p], (c * SQ + SQ // 2, TOP + (ROWS - 1 - r) * SQ + SQ // 2))
        if self.anim:
            a = self.anim
            draw_piece(s, PIECE[a["player"]], (a["col"] * SQ + SQ // 2, int(a["y"])))

        s.blit(self.board_surf, (0, TOP))

        # column highlight + hover piece on top
        if hover_col is not None and b.can_play(hover_col):
            s.blit(self.col_hl, (hover_col * SQ, TOP))
            draw_piece(s, PIECE[b.to_move], (hover_col * SQ + SQ // 2, TOP // 2))

        # what the LLM said about its last move (top bar, when not hovering)
        if self.ai_note and hover_col is None:
            note = self.ai_note if len(self.ai_note) <= 70 else self.ai_note[:67] + "..."
            t = font(16, False).render(f"“{note}”", True, MUTED)
            s.blit(t, t.get_rect(center=(W // 2, TOP // 2)))

        # hint arrow
        if self.hint_col is not None:
            x = self.hint_col * SQ + SQ // 2
            pygame.draw.polygon(s, GREEN, [(x - 18, 18), (x + 18, 18), (x, 48)])

        # winning line
        if self.result and self.result[0]:
            cells = self.result[1]
            pts = [(c * SQ + SQ // 2, TOP + (ROWS - 1 - r) * SQ + SQ // 2) for c, r in cells]
            for p in pts:
                pygame.draw.circle(s, TEXT, p, RADIUS - 2, 5)
            pygame.draw.line(s, TEXT, pts[0], pts[-1], 6)

        self.draw_status()
        if self.result and not self.anim:
            self.draw_result()

    def player_name(self, p):
        if not self.vs_ai:
            return "Red" if p == 1 else "Yellow"
        if p == self.human:
            return "You"
        return f"AI ({self.ollama_model})" if self.level == "Ollama" else f"AI ({self.level})"

    def draw_status(self):
        s, b = self.screen, self.board
        y0 = TOP + ROWS * SQ
        pygame.draw.rect(s, PANEL, (0, y0, W, BAR))
        if self.result:
            msg = "Game over"
        elif self.thinking() and self.ai_turn():
            dots = "." * (1 + pygame.time.get_ticks() // 300 % 3)
            msg = f"AI is thinking{dots}"
        else:
            who = self.player_name(b.to_move)
            msg = f"{who}'s turn" if who != "You" else "Your turn"
        draw_piece(s, PIECE[b.to_move], (30, y0 + BAR // 2), 16)
        t = font(22).render(msg, True, TEXT)
        s.blit(t, (56, y0 + BAR // 2 - t.get_height() // 2))
        sc = font(18, False).render(
            f"{self.player_name(1)} {self.score[1]}  ·  {self.player_name(2)} {self.score[2]}  ·  draws {self.score[0]}",
            True, MUTED)
        s.blit(sc, sc.get_rect(midright=(W - 16, y0 + 20)))
        keys = font(14, False).render("R restart · U undo · H hint · F11 full · Esc menu", True, MUTED)
        s.blit(keys, keys.get_rect(midright=(W - 16, y0 + 44)))

    def again_rect(self):
        return pygame.Rect(W // 2 - 170, H // 2 + 20, 160, 54)

    def menu_rect(self):
        return pygame.Rect(W // 2 + 10, H // 2 + 20, 160, 54)

    def draw_result(self):
        s = self.screen
        shade = pygame.Surface((W, H), pygame.SRCALPHA)
        shade.fill((0, 0, 0, 120))
        s.blit(shade, (0, 0))
        card = pygame.Rect(W // 2 - 210, H // 2 - 110, 420, 210)
        pygame.draw.rect(s, PANEL, card, border_radius=20)
        winner = self.result[0]
        if winner == 0:
            msg, col = "It's a draw!", TEXT
        elif self.vs_ai:
            msg, col = ("You win!", GREEN) if winner == self.human else ("AI wins!", PIECE[winner][0])
        else:
            msg, col = f"{self.player_name(winner)} wins!", PIECE[winner][0]
        t = font(48).render(msg, True, col)
        s.blit(t, t.get_rect(center=(W // 2, H // 2 - 45)))
        mouse = pygame.mouse.get_pos()
        Button(self.again_rect(), "Play again", BOARD).draw(s, mouse)
        Button(self.menu_rect(), "Menu", (75, 85, 99)).draw(s, mouse)


if __name__ == "__main__":
    App().run()
