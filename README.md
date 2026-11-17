# 🎮 Connect Four — desktop, web, online rooms & Claude

**Play online:** https://connect-four.workingshady.workers.dev

| | |
|---|---|
| 🤖 **Vs Computer** | 6 levels (Beginner → Master) — negamax + alpha-beta, transposition table, iterative deepening |
| 👥 **Online with a friend** | create a room, send the link (`/r/CODE`), play live over WebSockets, rematch, emoji reactions |
| ✨ **Vs your own Claude** | remote MCP server at `/mcp` — Claude creates/joins a room and plays you |
| 🏆 **Leaderboard** | name + passcode (first sign-in registers), points per level, filters by mode/level/period, player stats & charts |

## Play against Claude (MCP)

1. **Connect the server** (once):
   - **Claude Code:** `claude mcp add --transport http -s user connect-four https://connect-four.workingshady.workers.dev/mcp`
   - **claude.ai / Claude Desktop:** Settings → Connectors → *Add custom connector* → URL `https://connect-four.workingshady.workers.dev/mcp`
2. Open the site → **Claude** → *Create Claude room* (or ask Claude: "create a Connect Four room and play me").
3. Tell Claude: *"Let's play Connect Four! Join room ABC123 with the connect-four tools and play until the game ends."*
4. Play on the board — Claude's moves and comments appear live.

Tools: `create_room`, `wait_for_my_turn` (long-poll), `play_move`, `get_game`, `rematch`.

## Leaderboard points

Win = Beginner 1 · Easy 2 · Medium 3 · Hard 5 · Expert 8 · Master 13 · Claude 8 · Friend 5 (draw = half).
Games vs the browser AI are re-played on the server to check the result; room games are recorded by the room itself.

## Cloud architecture (`cloud/`)

- **Cloudflare Worker** (`src/worker.ts`) — static site + `/api/*` + `/mcp`
- **Durable Object `Room`** (`src/room.ts`) — one per room: state, seats, WebSockets (hibernation), Claude long-poll
- **Durable Object `Leaderboard`** (`src/leaderboard.ts`) — one global SQLite instance: accounts (PBKDF2-hashed passcodes), sessions, results
- **MCP** (`src/mcp.ts`) — Streamable HTTP JSON-RPC, no dependencies
- **Frontend** (`public/`) — vanilla JS, no build step; AI runs in a Web Worker (`js/engine.js`); rules shared with the server (`js/rules.js`)

```bash
cd cloud
npm install
npm run dev      # http://localhost:8787
npm run deploy   # wrangler deploy
```

## Desktop version (Python / Pygame)

![image](https://github.com/user-attachments/assets/ecfe69b0-5318-4b53-bef8-896f793611f7)

An interactive version of the classic **Connect Four** game, built with **Python** and **Pygame**, featuring a clean GUI and an intelligent AI opponent using the **Minimax algorithm** with **Alpha-Beta pruning**.

## 🧠 AI Difficulty Levels:
- **Easy** – Random AI
- **Medium** – Minimax with shallow depth
- **Hard** – Minimax with deeper search and Alpha-Beta pruning
![image](https://github.com/user-attachments/assets/ed4cf454-7090-4074-9dc4-eba2df593565)

## 🎮 Game Modes:
- Player vs Player  
- Player vs AI

## 🖥️ Features:
- Smooth graphical user interface using **Pygame**
- Real-time move previews
- Win and draw detection
- Reset and replay functionality
- Object-Oriented clean codebase

## 🤖 Minimax + Alpha-Beta Pruning:
The AI uses the **Minimax** algorithm to evaluate game states and simulate optimal moves. **Alpha-Beta pruning** is applied to ignore unpromising branches, improving performance significantly at deeper levels.
![image](https://github.com/user-attachments/assets/db95a3b8-e256-42a7-b4f3-fdf8ee168b4a)

## 🚀 How to Run:
```bash
pip install pygame
python game.py
```

`game.py` is the new all-in-one app (menus, 6 AI levels, PvP, undo, hints) and
`engine.py` is the optimised AI (bitboards, negamax + alpha-beta, transposition
table, threat-based move ordering, iterative deepening with a time limit).
In-game keys: **R** restart · **U** undo · **H** hint · **1-7** drop in column · **Esc** menu.

| Level | AI |
|---|---|
| Beginner | random moves |
| Easy | 1 move ahead |
| Medium | 3 moves ahead |
| Hard | 6 moves ahead |
| Expert | up to 10 moves ahead, 2 s |
| Master | deep search, 4 s |
| Ollama AI | a local LLM via [Ollama](https://ollama.com) — pick any installed model; it explains each move. Immediate wins/blocks are enforced, and the engine moves if the model fails |

For the Ollama level, have the Ollama app running (`OLLAMA_HOST` is respected). `qwen2.5:3b-instruct` is fast; bigger models think longer.

The original `GUI.py` / `lvl.py` / `easy.py` / `medium.py` / `hard.py` are kept for reference.
