import { COLS, ROWS, idx, fromMoves, result } from "./rules.js";
import { LEVELS } from "./engine.js";

/* ================================================================ utils */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const ORIGIN = location.origin;
const MCP_URL = `${ORIGIN}/mcp`;
const LEVEL_KEYS = Object.keys(LEVELS);
const LEVEL_COLORS = { beginner: "#22c55e", easy: "#84cc16", medium: "#eab308", hard: "#f97316", expert: "#ef4444", master: "#a855f7" };
const LEVEL_PTS = { beginner: 1, easy: 2, medium: 3, hard: 5, expert: 8, master: 13 };

function toast(msg) {
  const t = h(`<div class="toast">${esc(msg)}</div>`);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 3100);
}
async function copy(text, label = "Copied!") {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { prompt("Copy this:", text); }
}
function opponentLabel(mode, level) {
  if (mode === "ai") return LEVELS[level]?.name ? `AI · ${LEVELS[level].name}` : "AI";
  return mode === "claude" ? "Claude" : "Friends";
}
const initials = (n) => (n || "?").trim().slice(0, 1).toUpperCase();
function avatarColor(name) {
  let x = 0; for (const ch of name || "") x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${x % 360} 65% 45%)`;
}

/* ================================================================ auth + api */
let auth = ls.get("c4.auth"); // {token, name}
async function api(path, { method = "GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth?.token) headers.authorization = `Bearer ${auth.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}
async function verifyAuth() {
  if (!auth) return;
  try { const me = await api("/api/me"); auth.name = me.name; ls.set("c4.auth", auth); }
  catch (e) { if (e.status === 401) { auth = null; ls.del("c4.auth"); } }
  updateHeader();
}

function openAuth(reason = "") {
  const d = $("#auth-dialog");
  d.innerHTML = `
    <form method="dialog" novalidate>
      <div>
        <div class="eyebrow">Leaderboard account</div>
        <h2 style="margin-top:6px">Sign in or register</h2>
        <p class="muted" style="margin:0">${esc(reason || "Pick a name and a passcode. First time? It registers you automatically.")}</p>
      </div>
      <div class="field"><label for="a-name">Name</label>
        <input class="input" id="a-name" maxlength="20" autocomplete="username" placeholder="e.g. Shady" required /></div>
      <div class="note" id="a-note" hidden></div>
      <div class="field"><label for="a-pass">Passcode</label>
        <input class="input" id="a-pass" type="password" maxlength="32" autocomplete="current-password" placeholder="4+ characters" required /></div>
      <div class="err" id="a-err"></div>
      <div class="row" style="justify-content:flex-end">
        <button class="btn ghost" value="cancel" formnovalidate>Cancel</button>
        <button class="btn" id="a-go" value="go">Continue</button>
      </div>
    </form>`;
  const name = $("#a-name", d), pass = $("#a-pass", d), note = $("#a-note", d), err = $("#a-err", d), go = $("#a-go", d);
  let timer;
  name.value = ls.get("c4.name", "") || "";
  const check = async () => {
    const n = name.value.trim();
    if (n.length < 3) { note.hidden = true; go.textContent = "Continue"; return; }
    try {
      const { exists } = await api("/api/auth/check", { method: "POST", body: { name: n } });
      note.hidden = false;
      note.className = `note ${exists ? "back" : "new"}`;
      note.textContent = exists ? `Welcome back, ${n}! Enter your passcode.` : `“${n}” is free. Choose a passcode to register - you'll need it to sign in next time.`;
      go.textContent = exists ? "Sign in" : "Register";
      pass.autocomplete = exists ? "current-password" : "new-password";
    } catch { /* offline */ }
  };
  name.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(check, 300); });
  check();
  go.addEventListener("click", async (e) => {
    e.preventDefault();
    err.textContent = "";
    go.disabled = true;
    try {
      const r = await api("/api/auth", { method: "POST", body: { name: name.value, passcode: pass.value } });
      auth = { token: r.token, name: r.name };
      ls.set("c4.auth", auth);
      ls.set("c4.name", r.name);
      d.close();
      toast(r.created ? `Registered as ${r.name} 🎉` : `Welcome back, ${r.name}!`);
      updateHeader();
      render();
    } catch (ex) {
      err.textContent = ex.message;
    } finally { go.disabled = false; }
  });
  d.showModal();
  (name.value ? pass : name).focus();
}

function openAccountMenu() {
  const d = $("#auth-dialog");
  d.innerHTML = `
    <form method="dialog">
      <div class="row"><span class="avatar" style="width:44px;height:44px;font-size:1.2rem;background:${avatarColor(auth.name)}">${esc(initials(auth.name))}</span>
        <div><div class="eyebrow">Signed in</div><h2 style="margin:2px 0 0">${esc(auth.name)}</h2></div></div>
      <div class="row">
        <a class="btn" href="/u/${encodeURIComponent(auth.name)}" data-link id="m-prof">My stats</a>
        <button class="btn ghost" id="m-out" value="out">Sign out</button>
        <button class="btn ghost" value="cancel">Close</button>
      </div>
    </form>`;
  $("#m-prof", d).addEventListener("click", () => d.close());
  $("#m-out", d).addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST" }); } catch { /* ignore */ }
    auth = null; ls.del("c4.auth"); updateHeader(); render(); toast("Signed out");
  });
  d.showModal();
}

/* ================================================================ header, theme, sound */
const ICONS = {
  sun: '<svg viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5 1 3h-2zm0 20-1-3h2zM2 12l3-1v2zm20 0-3 1v-2zM4.9 4.9l2.8 1.4-1.4 1.4zm14.2 14.2-2.8-1.4 1.4-1.4zM4.9 19.1l1.4-2.8 1.4 1.4zM19.1 4.9l-1.4 2.8-1.4-1.4z"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5z"/></svg>',
  on: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  off: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4zm12.6 3 2.7-2.7 1.4 1.4-2.7 2.7 2.7 2.7-1.4 1.4-2.7-2.7-2.7 2.7-1.4-1.4 2.7-2.7-2.7-2.7 1.4-1.4z"/></svg>',
};
let soundOn = ls.get("c4.sound", true);
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : !matchMedia("(prefers-color-scheme: light)").matches;
}
function updateHeader() {
  $("#theme-btn").innerHTML = isDark() ? ICONS.sun : ICONS.moon;
  $("#sound-btn").innerHTML = soundOn ? ICONS.on : ICONS.off;
  const b = $("#account-btn");
  b.innerHTML = auth
    ? `<span class="avatar" style="background:${avatarColor(auth.name)}">${esc(initials(auth.name))}</span><span>${esc(auth.name)}</span>`
    : `<span>Sign in</span>`;
  const path = location.pathname;
  $$(".nav a, .tabbar a").forEach((a) => {
    const href = a.getAttribute("href");
    a.classList.toggle("active", href === "/" ? path === "/" : path.startsWith(href) || (href === "/play" && path.startsWith("/friend")));
  });
}
$("#theme-btn").addEventListener("click", () => {
  const t = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("c4.theme", t); } catch { /* private mode */ }
  updateHeader();
});
$("#sound-btn").addEventListener("click", () => { soundOn = !soundOn; ls.set("c4.sound", soundOn); updateHeader(); });
$("#account-btn").addEventListener("click", () => (auth ? openAccountMenu() : openAuth()));

let actx;
function tone(freq, dur = 0.12, type = "sine", gain = 0.15, delay = 0) {
  if (!soundOn) return;
  try {
    actx ??= new AudioContext();
    const t = actx.currentTime + delay;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
  } catch { /* audio unavailable */ }
}
const sfx = {
  drop: (delay) => tone(180, 0.14, "triangle", 0.25, delay),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, "sine", 0.14, i * 0.11)),
  lose: () => [392, 330, 262].forEach((f, i) => tone(f, 0.28, "sine", 0.12, i * 0.14)),
  pop: () => tone(660, 0.08, "sine", 0.08),
};
function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const wrap = h('<div class="confetti"></div>');
  const colors = ["#ef4444", "#facc15", "#3b82f6", "#22c55e", "#a855f7"];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement("i");
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.setProperty("--dx", `${(Math.random() - 0.5) * 300}px`);
    p.style.setProperty("--rot", `${Math.random() * 900 - 450}deg`);
    p.style.animationDelay = `${Math.random() * 0.5}s`;
    wrap.append(p);
  }
  document.body.append(wrap);
  setTimeout(() => wrap.remove(), 3200);
}

/* ================================================================ tooltip */
const tip = $("#tooltip");
function showTip(el, x, y) {
  tip.innerHTML = el.dataset.tip;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12))}px`;
  tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
}
document.addEventListener("pointermove", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (el) showTip(el, e.clientX, e.clientY); else tip.hidden = true;
});
document.addEventListener("focusin", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top); }
});
document.addEventListener("focusout", () => (tip.hidden = true));

/* ================================================================ board component */
function createBoard({ interactive = true, mini = false, onColumn } = {}) {
  const wrap = h(`<div class="board-wrap${mini ? " mini" : ""}">
    ${interactive ? '<div class="ghost-row" aria-hidden="true"></div>' : ""}
    <div class="board" role="grid" aria-label="Connect Four board"></div></div>`);
  const board = $(".board", wrap);
  const ghost = $(".ghost-row", wrap);
  const cells = new Array(COLS * ROWS);
  const shown = new Array(COLS * ROWS).fill(0);
  for (let top = 0; top < ROWS; top++) {
    for (let c = 0; c < COLS; c++) {
      const el = h('<div class="cell" role="gridcell"></div>');
      cells[idx(c, ROWS - 1 - top)] = el;
      board.append(el);
    }
  }
  let ghostSeat = 0, locked = false, hover = -1, heights = new Array(COLS).fill(0);
  if (ghost) for (let c = 0; c < COLS; c++) ghost.append(h("<span><i></i></span>"));
  const updateGhost = () => {
    if (!ghost) return;
    $$("span", ghost).forEach((s, c) => {
      const show = !locked && c === hover && heights[c] < ROWS && ghostSeat;
      s.classList.toggle("show", !!show);
      s.firstChild.className = ghostSeat ? `disc-ghost p${ghostSeat}` : "";
      s.firstChild.style.background = show ? `var(${ghostSeat === 1 ? "--red" : "--yellow"})` : "";
    });
  };
  if (interactive) {
    for (let c = 0; c < COLS; c++) {
      const b = h(`<button class="colhit" aria-label="Drop in column ${c + 1}" style="left:calc(3% + ${c} * 94% / 7)"></button>`);
      b.addEventListener("click", () => !locked && onColumn?.(c));
      b.addEventListener("pointerenter", () => { hover = c; updateGhost(); });
      b.addEventListener("focus", () => { hover = c; updateGhost(); });
      board.append(b);
    }
    board.addEventListener("pointerleave", () => { hover = -1; updateGhost(); });
  }
  let hintEl = null;
  return {
    el: wrap,
    set(moves, { animate = false, line = null } = {}) {
      const st = fromMoves(moves);
      heights = st.heights;
      const lastIdx = moves.length ? idx(moves[moves.length - 1], st.heights[moves[moves.length - 1]] - 1) : -1;
      st.board.forEach((p, i) => {
        if (shown[i] === p) return;
        cells[i].querySelector(".disc")?.remove();
        if (p) {
          const d = h(`<div class="disc p${p}"></div>`);
          if (animate && i === lastIdx) {
            const r = i % ROWS;
            d.classList.add("drop");
            d.style.setProperty("--fall", ((ROWS - r + 0.7) / 0.8).toFixed(2));
            d.style.setProperty("--dur", `${0.22 + 0.055 * (ROWS - r)}s`);
            sfx.drop(0.2 + 0.05 * (ROWS - r));
          }
          cells[i].append(d);
        }
        shown[i] = p;
      });
      $$(".disc", board).forEach((d) => d.classList.remove("last", "win"));
      if (lastIdx >= 0) cells[lastIdx].querySelector(".disc")?.classList.add("last");
      if (line) for (const [c, r] of line) cells[idx(c, r)].querySelector(".disc")?.classList.add("win");
      board.classList.toggle("over", !!line);
      updateGhost();
    },
    lock(v, seat = 0) { locked = v; ghostSeat = seat; board.classList.toggle("locked", v); updateGhost(); },
    hint(col) {
      hintEl?.remove(); hintEl = null;
      if (col == null) return;
      hintEl = h(`<div class="hint-arrow" style="left:calc(3% + ${col} * 94% / 7)">▼</div>`);
      board.append(hintEl);
    },
    overlay(node) { $(".result", wrap)?.remove(); if (node) board.append(node); },
    emoji(e) {
      const f = h(`<div class="float-emoji" style="left:${20 + Math.random() * 60}%">${esc(e)}</div>`);
      wrap.append(f); setTimeout(() => f.remove(), 1900);
    },
  };
}
// CSS for the disc centring inside cells
document.head.append(h("<style>.cell .disc{inset:0;margin:auto}</style>"));

function playerCard(p, { right = false, turn = false } = {}) {
  return `<div class="player ${right ? "right" : ""} ${turn ? "turn" : ""} p${p.seat}">
    <span class="disc-ico"></span>
    <div class="meta"><div class="name">${esc(p.name)}</div>
    <div class="sub">${p.online !== undefined ? `<span class="dot ${p.online ? "on" : ""}"></span>` : ""}${esc(p.sub || "")}</div></div></div>`;
}
function playersBar(a, b, turn, score = "") {
  return `<div class="players">${playerCard(a, { turn: turn === a.seat })}<div class="vs">VS<b>${esc(score)}</b></div>${playerCard(b, { right: true, turn: turn === b.seat })}</div>`;
}
function resultCard({ title, sub = "", pts = "", buttons = [] }) {
  const el = h(`<div class="result"><div class="card"><h2>${esc(title)}</h2>
    ${sub ? `<p class="muted" style="margin:0">${sub}</p>` : ""}<div class="pts">${esc(pts)}</div>
    <div class="row" style="justify-content:center"></div></div></div>`);
  for (const b of buttons) {
    const btn = h(b.href ? `<a class="btn ${b.cls || ""}" href="${b.href}" data-link>${esc(b.label)}</a>` : `<button class="btn ${b.cls || ""}">${esc(b.label)}</button>`);
    if (b.onClick) btn.addEventListener("click", b.onClick);
    $(".row", el).append(btn);
  }
  return el;
}

/* ================================================================ views */
const app = $("#app");
let cleanup = null;

function viewHome() {
  app.innerHTML = `
    <section class="hero">
      <div>
        <div class="eyebrow">Four in a row · since 1974</div>
        <h1>Drop. Connect. <em>Win.</em></h1>
        <p>Play six AI levels from Beginner to near-perfect Master, challenge a friend with a shared link, or take on <b>your own Claude</b> through MCP. Sign in and climb the leaderboard.</p>
        <div class="row" style="margin-top:18px">
          <a class="btn" href="/play" data-link>Play now</a>
          <a class="btn ghost" href="/friend" data-link>Invite a friend</a>
        </div>
      </div>
      <div class="hero-board" id="hero-board"></div>
    </section>
    <section class="modes">
      ${modeCard("/play", "#6366f1", "Vs Computer", "Six levels powered by alpha-beta search. Wins earn leaderboard points.", '<path d="M5 4h14v10H5zm-2 12h18v2H3zM9 7h2v2H9zm4 0h2v2h-2zm-4 4h6v1H9z"/>')}
      ${modeCard("/friend", "#22c55e", "Online with a friend", "Create a room, send the link, play live from any device.", '<path d="M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20a6 6 0 0 1 12 0zm12 0a5 5 0 0 1 8 0z"/>')}
      ${modeCard("/claude", "#d97757", "Vs your Claude", "Connect the MCP server and let Claude play you, with table talk.", '<path d="M12 2 14 9l7 3-7 3-2 7-2-7-7-3 7-3z"/>')}
      ${modeCard("/play/pvp", "#eab308", "Pass & play", "Two players, one screen. Perfect for the couch.", '<path d="M4 6h16v10H4zm-1 12h18v2H3z"/>')}
    </section>
    <section class="card" style="margin-top:24px">
      <div class="chart-head"><h3 style="margin:0">Top players</h3><a href="/leaderboard" data-link>Full leaderboard →</a></div>
      <div id="home-top"><div class="empty"><span class="spinner"></span></div></div>
    </section>`;
  const b = createBoard({ interactive: false });
  $("#hero-board").append(b.el);
  const demo = [3, 3, 2, 4, 4, 2, 1, 5, 5, 5, 0];
  let i = 0, alive = true;
  (async function loop() {
    while (alive) {
      i = i >= demo.length ? 0 : i + 1;
      const moves = demo.slice(0, i);
      const r = result(fromMoves(moves).board);
      const s = soundOn; soundOn = false;
      b.set(moves, { animate: true, line: r?.line });
      soundOn = s;
      await sleep(i >= demo.length ? 2200 : 650);
      if (i >= demo.length) b.set([], {});
    }
  })();
  api("/api/leaderboard?mode=all").then(({ rows }) => {
    $("#home-top").innerHTML = rows.length ? lbTable(rows.slice(0, 5), "all") : `<div class="empty">No games yet - be the first on the board!</div>`;
  }).catch(() => ($("#home-top").innerHTML = '<div class="empty">Leaderboard unavailable.</div>'));
  return () => { alive = false; };
}
const modeCard = (href, c, title, text, icon) =>
  `<a class="mode" href="${href}" data-link style="--c:${c}"><span class="ico"><svg viewBox="0 0 24 24">${icon}</svg></span><h3>${title}</h3><p>${text}</p></a>`;

function viewPlayMenu() {
  let first = ls.get("c4.first", "you");
  app.innerHTML = `
    <div class="page-head"><div class="eyebrow">Vs computer</div><h1>Choose your opponent</h1>
      <p>${auth ? `Playing as <b>${esc(auth.name)}</b> - wins are saved to the leaderboard.` : `<a href="#" id="signin-link">Sign in</a> to save your wins to the leaderboard (first time = quick register).`}</p></div>
    <div class="row" style="margin-bottom:18px"><span class="muted" style="font-weight:600">First move:</span>
      <div class="seg" id="first">${["you", "ai", "random"].map((f) => `<button data-v="${f}" aria-pressed="${f === first}">${f === "you" ? "You" : f === "ai" ? "Computer" : "Random"}</button>`).join("")}</div></div>
    <div class="levels">
      ${LEVEL_KEYS.map((k, i) => `<button class="level" data-level="${k}" style="--c:${LEVEL_COLORS[k]}">
        <b>${LEVELS[k].name}</b><span class="muted">${LEVELS[k].desc}</span>
        <span class="pips">${LEVEL_KEYS.map((_, j) => `<i class="${j <= i ? "on" : ""}"></i>`).join("")}</span>
        <small>${LEVEL_PTS[k]} pt${LEVEL_PTS[k] > 1 ? "s" : ""} per win</small></button>`).join("")}
    </div>
    <div class="grid-2" style="margin-top:22px">
      <a class="mode" href="/friend" data-link style="--c:#22c55e"><h3>Online with a friend →</h3><p>Create a room and share the link.</p></a>
      <a class="mode" href="/play/pvp" data-link style="--c:#eab308"><h3>Pass & play →</h3><p>Two players on this device.</p></a>
    </div>`;
  $("#signin-link")?.addEventListener("click", (e) => { e.preventDefault(); openAuth(); });
  $$("#first button").forEach((b) => b.addEventListener("click", () => {
    first = b.dataset.v; ls.set("c4.first", first);
    $$("#first button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  }));
  $$(".level").forEach((b) => b.addEventListener("click", () => navigate(`/play/${b.dataset.level}`)));
}

/* ---------------- local game: vs AI or pass & play */
function viewLocal(level) {
  const vsAI = level !== "pvp";
  if (vsAI && !LEVELS[level]) return navigate("/play", true);
  const firstPref = ls.get("c4.first", "you");
  let human = 1, moves = [], over = false, aiBusy = false, gid, score = { 1: 0, 2: 0, d: 0 }, reqId = 0;
  const worker = new Worker("/js/ai-worker.js", { type: "module" });
  const pending = new Map();
  worker.onmessage = (e) => { pending.get(e.data.id)?.(e.data.col); pending.delete(e.data.id); };
  const ask = (lvl) => new Promise((res) => { const id = ++reqId; pending.set(id, res); worker.postMessage({ id, moves, level: lvl }); });

  app.innerHTML = `<div class="game"><div class="game-main">
      <div id="pbar"></div><div class="status" id="status"></div><div id="board-slot"></div>
      <div class="toolbar">
        <button class="btn ghost small" id="undo">↶ Undo</button>
        ${vsAI ? '<button class="btn ghost small" id="hint">💡 Hint</button>' : ""}
        <button class="btn ghost small" id="restart">⟲ New game</button>
        <a class="btn ghost small" href="/play" data-link>☰ Menu</a>
      </div>
      <div class="kbd-hint">Keys: 1-7 drop · U undo · ${vsAI ? "H hint · " : ""}R new game</div>
    </div>
    <aside class="side">
      <div class="card panel"><h3>${vsAI ? `AI · ${LEVELS[level].name}` : "Pass & play"}</h3>
        <p style="margin:0">${vsAI ? `${LEVELS[level].desc}. A win is worth <b>${LEVEL_PTS[level]} point${LEVEL_PTS[level] > 1 ? "s" : ""}</b>.` : "Take turns on this device. Red always opens the first game; the loser opens the next."}</p>
        ${vsAI && !auth ? `<p class="note" style="margin:12px 0 0"><a href="#" id="side-signin">Sign in</a> to put this win on the leaderboard.</p>` : ""}
      </div>
      ${vsAI ? `<div class="card panel"><h3>Change level</h3><div class="row">${LEVEL_KEYS.map((k) => `<a class="btn small ${k === level ? "" : "ghost"}" href="/play/${k}" data-link>${LEVELS[k].name}</a>`).join("")}</div></div>` : ""}
    </aside></div>`;
  $("#side-signin")?.addEventListener("click", (e) => { e.preventDefault(); openAuth(); });
  const board = createBoard({ onColumn: (c) => humanMove(c) });
  $("#board-slot").append(board.el);

  const turn = () => (moves.length % 2 === 0 ? 1 : 2);
  const names = () => vsAI
    ? { [human]: auth?.name || "You", [3 - human]: `AI · ${LEVELS[level].name}` }
    : { 1: "Red", 2: "Yellow" };
  function paint(animate = false) {
    const n = names();
    const r = result(fromMoves(moves).board);
    $("#pbar").innerHTML = playersBar({ seat: 1, name: n[1], sub: vsAI ? (human === 1 ? "you" : "computer") : "player 1" },
      { seat: 2, name: n[2], sub: vsAI ? (human === 2 ? "you" : "computer") : "player 2" }, over ? 0 : turn(), `${score[1]} : ${score[2]}`);
    board.set(moves, { animate, line: r?.line });
    const myTurn = !over && !aiBusy && (!vsAI || turn() === human);
    board.lock(!myTurn, turn());
    $("#status").innerHTML = over ? "" : aiBusy ? '<span class="spinner"></span> Computer is thinking…'
      : vsAI ? "Your turn" : `${n[turn()]}'s turn`;
  }
  function start() {
    moves = []; over = false; aiBusy = false; gid = crypto.randomUUID(); board.overlay(null); board.hint(null);
    human = !vsAI ? 1 : firstPref === "you" ? 1 : firstPref === "ai" ? 2 : Math.random() < 0.5 ? 1 : 2;
    paint();
    if (vsAI && human === 2) aiMove();
  }
  async function aiMove() {
    aiBusy = true; paint();
    const t0 = performance.now();
    const snapshot = moves.length;
    const col = await ask(level);
    await sleep(Math.max(0, 420 - (performance.now() - t0)));
    if (moves.length !== snapshot || over) return; // game changed meanwhile
    aiBusy = false;
    play(col);
  }
  function humanMove(c) {
    if (over || aiBusy || (vsAI && turn() !== human) || fromMoves(moves).heights[c] >= ROWS) return;
    board.hint(null);
    play(c);
    if (!over && vsAI) aiMove();
  }
  function play(c) {
    moves.push(c);
    const r = result(fromMoves(moves).board);
    if (r) over = true;
    paint(true);
    if (r) setTimeout(() => finish(r), 650);
  }
  async function finish(r) {
    if (r.winner) score[r.winner]++; else score.d++;
    paint();
    const youWin = vsAI ? r.winner === human : false;
    const title = r.winner === 0 ? "Draw!" : vsAI ? (youWin ? "You win! 🎉" : "Computer wins") : `${names()[r.winner]} wins!`;
    if (r.winner === 0 || !vsAI || youWin) { sfx.win(); if (youWin || !vsAI) confetti(); } else sfx.lose();
    const card = resultCard({
      title, sub: `${moves.length} moves`,
      buttons: [{ label: "Play again", onClick: start }, { label: "Leaderboard", cls: "ghost", href: "/leaderboard" }],
    });
    board.overlay(card);
    if (vsAI && auth) {
      try {
        const res = await api("/api/results", { method: "POST", body: { gid, level, moves, seat: human } });
        $(".pts", card).textContent = res.points ? `+${res.points} point${res.points === 1 ? "" : "s"} saved to the leaderboard` : "Result saved to your stats";
      } catch (e) { $(".pts", card).textContent = `Couldn't save: ${e.message}`; }
    } else if (vsAI) {
      $(".pts", card).innerHTML = `<a href="#" id="ov-signin">Sign in</a> to save results`;
      $("#ov-signin", card)?.addEventListener("click", (e) => { e.preventDefault(); openAuth(); });
    }
  }
  function undo() {
    if (aiBusy || !moves.length) return;
    if (over) { const r = result(fromMoves(moves).board); if (r.winner) score[r.winner]--; else score.d--; }
    over = false; board.overlay(null); board.hint(null);
    moves.pop();
    if (vsAI && moves.length && turn() !== human) moves.pop();
    if (vsAI && turn() !== human) { paint(); aiMove(); return; } // AI opened the game
    paint();
  }
  async function hint() {
    if (over || aiBusy || turn() !== human) return;
    $("#status").innerHTML = '<span class="spinner"></span> Finding the best move…';
    board.hint(await ask("expert"));
    paint();
  }
  $("#undo").onclick = undo;
  $("#restart").onclick = start;
  if ($("#hint")) $("#hint").onclick = hint;
  const onKey = (e) => {
    if (e.target.closest("input, dialog[open]")) return;
    if (e.key >= "1" && e.key <= "7") humanMove(Number(e.key) - 1);
    else if (e.key === "u" || e.key === "U") undo();
    else if (vsAI && (e.key === "h" || e.key === "H")) hint();
    else if (e.key === "r" || e.key === "R") start();
  };
  document.addEventListener("keydown", onKey);
  start();
  return () => { worker.terminate(); document.removeEventListener("keydown", onKey); };
}

/* ---------------- friend rooms */
function viewFriend() {
  let first = "me";
  app.innerHTML = `
    <div class="page-head"><div class="eyebrow">Online</div><h1>Play with a friend</h1>
      <p>Create a private room and send the link. Your friend opens it on any device - no install, no account needed.</p></div>
    <div class="grid-2">
      <div class="card stack">
        <h3>Create a room</h3>
        <div class="field"><label for="f-name">Your name</label>
          <input class="input" id="f-name" maxlength="20" value="${esc(auth?.name || ls.get("c4.name", ""))}" ${auth ? "disabled" : ""} placeholder="Your name" /></div>
        <div class="field"><label>Who starts?</label>
          <div class="seg" id="f-first">${[["me", "Me"], ["them", "My friend"], ["random", "Random"]].map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === first}">${l}</button>`).join("")}</div></div>
        <button class="btn" id="f-create">Create room & get link</button>
        <p class="muted" style="margin:0;font-size:.9rem">${auth ? "Signed in - wins in rooms count on the Friends leaderboard." : "Tip: sign in first so room wins count on the leaderboard."}</p>
      </div>
      <div class="card stack">
        <h3>Join with a code</h3>
        <div class="field"><label for="j-code">Room code</label>
          <input class="input mono" id="j-code" maxlength="6" placeholder="K7QX2M" style="text-transform:uppercase;letter-spacing:.2em" /></div>
        <button class="btn ghost" id="j-go">Join room</button>
      </div>
    </div>`;
  $$("#f-first button").forEach((b) => b.addEventListener("click", () => {
    first = b.dataset.v; $$("#f-first button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  }));
  $("#f-create").onclick = async (e) => {
    e.target.disabled = true;
    const name = $("#f-name").value.trim();
    if (name && !auth) ls.set("c4.name", name);
    try {
      const r = await api("/api/rooms", { method: "POST", body: { mode: "friend", first, name } });
      ls.set(`c4.room.${r.id}`, r.token);
      navigate(`/r/${r.id}`);
    } catch (ex) { toast(ex.message); e.target.disabled = false; }
  };
  $("#j-go").onclick = () => {
    const code = $("#j-code").value.trim().toUpperCase();
    if (/^[A-Z0-9]{6}$/.test(code)) navigate(`/r/${code}`); else toast("Room codes have 6 characters");
  };
}

function viewRoom(code) {
  code = code.toUpperCase();
  let token = ls.get(`c4.room.${code}`);
  let ws, state = null, disposed = false, retry = 0, lastMoves = -1, pingT;
  const link = `${ORIGIN}/r/${code}`;

  // new visitor without a name: ask first (so the friend sees who joined)
  if (!token && !auth && !ls.get("c4.name")) {
    app.innerHTML = `<div class="card stack" style="max-width:460px;margin:30px auto">
      <div class="eyebrow">Room ${esc(code)}</div><h2>Join the game</h2>
      <div class="field"><label for="jn">Your name</label><input class="input" id="jn" maxlength="20" placeholder="Your name" /></div>
      <div class="row"><button class="btn" id="jgo">Join</button><button class="btn ghost" id="jsign">Sign in instead</button></div></div>`;
    $("#jn").focus();
    const go = () => { ls.set("c4.name", $("#jn").value.trim() || "Guest"); render(); };
    $("#jgo").onclick = go;
    $("#jn").addEventListener("keydown", (e) => e.key === "Enter" && go());
    $("#jsign").onclick = () => openAuth("Sign in so this game counts on the leaderboard.");
    return;
  }

  app.innerHTML = `<div class="game"><div class="game-main">
      <div id="pbar"></div><div class="status" id="status"><span class="spinner"></span> Connecting…</div>
      <div id="board-slot"></div><div class="kbd-hint">Keys: 1-7 drop a piece</div></div>
    <aside class="side" id="side"></aside></div>`;
  const board = createBoard({ onColumn: (c) => send({ type: "move", col: c }) });
  $("#board-slot").append(board.el);

  function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }
  function connect() {
    const q = new URLSearchParams({ token: token || "", name: auth?.name || ls.get("c4.name", "") || "", auth: auth?.token || "" });
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${code}/ws?${q}`);
    ws.onopen = () => { retry = 0; };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "welcome" && m.token) { token = m.token; ls.set(`c4.room.${code}`, token); }
      else if (m.type === "state") paint(m.state);
      else if (m.type === "emoji") { board.emoji(m.e); sfx.pop(); }
      else if (m.type === "error") toast(m.message);
    };
    ws.onclose = (e) => {
      if (disposed) return;
      if (e.code === 1006 && retry === 0 && !state) { /* first attempt failed - maybe 404 */ }
      $("#status").innerHTML = '<span class="spinner"></span> Reconnecting…';
      setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
    };
  }
  fetch(`/api/rooms/${code}`).then((r) => {
    if (r.status === 404) {
      app.innerHTML = `<div class="card stack" style="max-width:480px;margin:30px auto;text-align:center"><h2>Room not found</h2>
        <p>Room <b class="mono">${esc(code)}</b> doesn't exist or expired (rooms last a week after the last move).</p>
        <div class="row" style="justify-content:center"><a class="btn" href="/friend" data-link>Create a new room</a></div></div>`;
      disposed = true;
    } else connect();
  });
  pingT = setInterval(() => send({ type: "ping" }), 30000);

  function paint(s) {
    const animate = lastMoves >= 0 && s.moves.length === lastMoves + 1;
    lastMoves = s.moves.length;
    const prevWinner = state?.winner ?? null;
    state = s;
    const me = s.you;
    const isClaude = s.mode === "claude";
    const P = s.players.map((p) => ({
      seat: p.seat,
      name: p.name ? (p.seat === me ? `${p.name} (you)` : p.name) : "Waiting…",
      sub: `${p.wins} win${p.wins === 1 ? "" : "s"}${p.claude ? " · AI" : ""}`,
      online: p.name ? p.online : false,
    }));
    const opp = s.players.find((p) => p.seat !== me) || s.players[1];
    $("#pbar").innerHTML = playersBar(P[0], P[1], s.winner === null && s.ready ? s.turn : 0, `${s.players[0].wins} : ${s.players[1].wins}`);
    board.set(s.moves, { animate, line: s.line });
    const myTurn = s.ready && s.winner === null && me === s.turn;
    board.lock(!myTurn, s.turn);

    // status line
    let st = "";
    if (!s.ready) st = isClaude ? "Waiting for you to join…" : '<span class="spinner"></span> Waiting for your friend to join…';
    else if (s.winner !== null) st = "";
    else if (myTurn) st = "Your turn";
    else if (me === null) st = `Watching · ${esc(s.players.find((p) => p.seat === s.turn)?.name)} to move`;
    else if (opp?.claude) st = '<span class="spinner"></span> Claude is thinking… <span class="muted">(keep your Claude chat running)</span>';
    else st = `<span class="spinner"></span> Waiting for ${esc(opp?.name || "your friend")}…`;
    $("#status").innerHTML = st;

    // result overlay
    if (s.winner !== null) {
      const youWon = s.winner === me, draw = s.winner === 0;
      const title = draw ? "Draw!" : me === null ? `${s.players.find((p) => p.seat === s.winner).name} wins` : youWon ? "You win! 🎉" : `${opp?.name || "Opponent"} wins`;
      if (prevWinner === null && animate) {
        if (youWon) { sfx.win(); confetti(); } else if (draw) sfx.win(); else sfx.lose();
      }
      const iAsked = s.rematch.includes(me), theyAsked = s.rematch.some((x) => x !== null && x !== me);
      const sub = me === null ? "" : iAsked ? "Waiting for your opponent to accept the rematch…" : theyAsked ? `<b>${esc(opp?.name)} wants a rematch!</b>` : `${s.moves.length} moves`;
      const btns = [];
      if (me !== null && !iAsked) btns.push({ label: theyAsked ? "Accept rematch" : "Rematch", onClick: () => send({ type: "rematch" }) });
      btns.push({ label: "Leaderboard", cls: "ghost", href: `/leaderboard?mode=${s.mode}` });
      const card = resultCard({ title, sub, buttons: btns, pts: auth && me !== null ? "Result saved to your stats" : "" });
      setTimeout(() => state === s && board.overlay(card), animate ? 650 : 0);
    } else board.overlay(null);

    // side panel
    const side = $("#side");
    side.innerHTML = "";
    if (isClaude) {
      side.append(h(`<div class="card panel"><h3>Claude's table talk</h3>
        <div class="bubble claude"><span class="who">Claude</span>${s.comment ? esc(s.comment) : '<span class="muted">No comment yet.</span>'}</div></div>`));
      const prompt = `Let's play Connect Four! Join room ${code} with the connect-four tools and play until the game ends.`;
      const p = h(`<div class="card panel stack"><h3>Start Claude</h3>
        <p style="margin:0">Paste this into your Claude chat (with the Connect Four MCP connected):</p>
        <div class="copy-box"><code>${esc(prompt)}</code><button class="btn small" id="cp">Copy</button></div>
        <a href="/claude" data-link>Setup guide →</a></div>`);
      $("#cp", p).onclick = () => copy(prompt, "Prompt copied - paste it to Claude");
      side.append(p);
    } else {
      const share = h(`<div class="card panel stack"><h3>${s.ready ? "Room" : "Invite your friend"}</h3>
        <div class="share-code">${esc(code)}</div>
        <div class="copy-box"><code>${esc(link)}</code><button class="btn small" id="cl">Copy</button></div>
        ${navigator.share ? '<button class="btn ghost" id="sh">Share link…</button>' : ""}</div>`);
      $("#cl", share).onclick = () => copy(link, "Link copied - send it to your friend");
      $("#sh", share)?.addEventListener("click", () => navigator.share({ title: "Connect Four", text: "Play Connect Four with me!", url: link }).catch(() => {}));
      side.append(share);
      if (me !== null) {
        const em = h(`<div class="card panel"><h3>React</h3><div class="emojis">${["👍", "😂", "😮", "😡", "🔥", "🎉", "🤔", "👋"].map((e) => `<button>${e}</button>`).join("")}</div></div>`);
        $$("button", em).forEach((b) => (b.onclick = () => send({ type: "emoji", e: b.textContent })));
        side.append(em);
      }
    }
    if (me !== null && !auth) {
      const n = h(`<div class="note">Playing as a guest. <a href="#">Sign in</a> to count this room's wins on the leaderboard.</div>`);
      $("a", n).onclick = (e) => { e.preventDefault(); openAuth(); };
      side.append(n);
    }
    if (me === null && s.ready) side.prepend(h('<div class="banner">This room is full - you are watching.</div>'));
  }
  const onKey = (e) => {
    if (e.target.closest("input, dialog[open]")) return;
    if (e.key >= "1" && e.key <= "7") send({ type: "move", col: Number(e.key) - 1 });
  };
  document.addEventListener("keydown", onKey);
  return () => { disposed = true; clearInterval(pingT); ws?.close(); document.removeEventListener("keydown", onKey); };
}

/* ---------------- Claude guide + room creation */
function viewClaude() {
  let first = "me", client = ls.get("c4.client", "code");
  const cmd = `claude mcp add --transport http connect-four ${MCP_URL}`;
  app.innerHTML = `
    <div class="page-head"><div class="eyebrow" style="color:var(--claude)">MCP · Model Context Protocol</div>
      <h1>Play against your own Claude</h1>
      <p>This site runs a remote MCP server. Connect it to Claude once, and Claude can create rooms, wait for your move and drop its pieces - while you play on this page.</p></div>
    <div class="game split">
      <div class="card steps">
        <div class="step"><h3>Connect the MCP server</h3>
          <div class="seg tabs-mini" id="client">${[["code", "Claude Code"], ["web", "claude.ai / Desktop"]].map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === client}">${l}</button>`).join("")}</div>
          <div id="client-body"></div></div>
        <div class="step"><h3>Create a room</h3>
          <p>Choose who opens, then create the room. You'll land on the board.</p>
          <div class="row"><div class="seg" id="c-first">${[["me", "I start"], ["claude", "Claude starts"], ["random", "Random"]].map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === first}">${l}</button>`).join("")}</div>
          <button class="btn claude" id="c-create">Create Claude room</button></div>
          <p class="muted" style="font-size:.9rem">Or just ask Claude: <i>“Create a Connect Four room and play me.”</i> It will send you the link.</p></div>
        <div class="step"><h3>Tell Claude to play</h3>
          <p>In your Claude chat, paste the prompt shown next to the board, e.g.</p>
          <div class="copy-box"><code>Let's play Connect Four! Join room ABC123 with the connect-four tools and play until the game ends.</code></div></div>
        <div class="step"><h3>Play!</h3>
          <p>Drop your pieces on the board. Claude calls <code>wait_for_my_turn</code>, thinks, then <code>play_move</code> - its pieces and comments appear live. ${auth ? "Your result is saved to the leaderboard (8 pts per win)." : "<a href='#' id='c-sign'>Sign in</a> to put wins vs Claude on the leaderboard (8 pts each)."}</p></div>
      </div>
      <aside class="side">
        <div class="card panel stack"><h3>Server URL</h3>
          <div class="copy-box"><code>${MCP_URL}</code><button class="btn small" id="cp-url">Copy</button></div>
          <p class="muted" style="margin:0;font-size:.9rem">Streamable HTTP · no auth · tools only</p></div>
        <div class="card panel"><h3>Tools Claude gets</h3>
          <div class="stack" style="gap:8px;font-size:.92rem">
            <div><code>create_room</code> - new room + link for you</div>
            <div><code>wait_for_my_turn</code> - waits until Claude must move</div>
            <div><code>play_move</code> - drop in column 1-7, with a comment</div>
            <div><code>get_game</code> - board, scores, result</div>
            <div><code>rematch</code> - next game, sides swap</div></div></div>
        <div class="card panel"><h3>Troubleshooting</h3>
          <details class="faq"><summary>Claude stopped moving</summary><p>Claude only acts while its chat is running. Say “your move” or “keep playing” and it will call <code>wait_for_my_turn</code> again.</p></details>
          <details class="faq"><summary>Tools don't show up</summary><p>Claude Code: run <code>/mcp</code> to check the server is connected, or restart Claude. claude.ai: enable the connector in the chat's tools menu.</p></details>
          <details class="faq"><summary>Is it the real Claude?</summary><p>Yes - every Claude move comes from your Claude calling <code>play_move</code>. The server only checks the move is legal and sends it exact facts (immediate wins / threats).</p></details>
        </div>
      </aside>
    </div>`;
  const body = () => {
    $("#client-body").innerHTML = client === "code"
      ? `<p>Run this once in a terminal:</p>
         <div class="copy-box"><code>${esc(cmd)}</code><button class="btn small" id="cp-cmd">Copy</button></div>
         <p class="muted" style="font-size:.9rem">Add <code>-s user</code> to make it available in every project. Check it with <code>/mcp</code> inside Claude Code.</p>`
      : `<ol style="line-height:1.8;color:var(--text-2);padding-left:20px;margin:6px 0">
           <li>Open <b>Settings → Connectors</b> (claude.ai or the Claude desktop app).</li>
           <li>Click <b>Add custom connector</b>.</li>
           <li>Name: <b>Connect Four</b> · URL: <code>${MCP_URL}</code> → <b>Add</b>.</li>
           <li>In a new chat, enable <b>Connect Four</b> from the tools (🔧/+) menu.</li></ol>`;
    $("#cp-cmd")?.addEventListener("click", () => copy(cmd, "Command copied"));
  };
  body();
  $$("#client button").forEach((b) => b.addEventListener("click", () => {
    client = b.dataset.v; ls.set("c4.client", client);
    $$("#client button").forEach((x) => x.setAttribute("aria-pressed", x === b)); body();
  }));
  $$("#c-first button").forEach((b) => b.addEventListener("click", () => {
    first = b.dataset.v; $$("#c-first button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  }));
  $("#cp-url").onclick = () => copy(MCP_URL, "MCP URL copied");
  $("#c-sign")?.addEventListener("click", (e) => { e.preventDefault(); openAuth(); });
  $("#c-create").onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api("/api/rooms", { method: "POST", body: { mode: "claude", first, name: auth?.name || ls.get("c4.name", "") || "You" } });
      ls.set(`c4.room.${r.id}`, r.token);
      navigate(`/r/${r.id}`);
    } catch (ex) { toast(ex.message); e.target.disabled = false; }
  };
}

/* ---------------- leaderboard */
function lbTable(rows, mode) {
  const medal = (i) => (i < 3 ? `<span class="rank medal ${"gsb"[i]}">${i + 1}</span>` : `<span class="rank">${i + 1}</span>`);
  return `<div class="table-wrap"><table class="lb"><thead><tr>
    <th>#</th><th>Player</th><th class="num">Points</th><th class="num">W</th><th class="num">L</th><th class="num">D</th><th>Win rate</th><th class="num">Games</th></tr></thead><tbody>
    ${rows.map((r, i) => {
      const wr = r.games ? Math.round((r.wins / r.games) * 100) : 0;
      return `<tr class="${auth && r.name.toLowerCase() === auth.name.toLowerCase() ? "me" : ""}">
        <td>${medal(i)}</td>
        <td><a class="who-cell" href="/u/${encodeURIComponent(r.name)}" data-link><span class="avatar" style="background:${avatarColor(r.name)}">${esc(initials(r.name))}</span>${esc(r.name)}</a></td>
        <td class="num"><b>${+Number(r.points).toFixed(1)}</b></td><td class="num">${r.wins}</td><td class="num">${r.losses}</td><td class="num">${r.draws}</td>
        <td><span class="wr"><span class="bar"><i style="width:${wr}%"></i></span>${wr}%</span></td><td class="num">${r.games}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  void mode;
}

function stackedBars(rows) {
  // rows: [{label, wins, losses, draws}] - one horizontal bar per opponent
  const max = Math.max(1, ...rows.map((r) => r.wins + r.losses + r.draws));
  return `<div class="legend" style="margin-bottom:10px"><span><i style="background:var(--s-win)"></i>Wins</span><span><i style="background:var(--s-loss)"></i>Losses</span><span><i style="background:var(--s-draw)"></i>Draws</span></div>
    <div class="sbars">${rows.map((r) => {
      const tot = r.wins + r.losses + r.draws;
      const seg = (n, v, k) => (n ? `<i style="width:${(n / max) * 100}%;background:var(--s-${v})" data-tip="<b>${esc(r.label)}</b>${n} ${k} · ${Math.round((n / tot) * 100)}%" tabindex="0"></i>` : "");
      return `<div class="sbar"><span class="lab" title="${esc(r.label)}">${esc(r.label)}</span>
        <span class="track">${seg(r.wins, "win", "wins")}${seg(r.losses, "loss", "losses")}${seg(r.draws, "draw", "draws")}</span>
        <span class="tot">${tot}</span></div>`;
    }).join("")}</div>`;
}
function opponentRows(list, include = () => true) {
  const order = [...LEVEL_KEYS.map((k) => `ai:${k}`), "claude:claude", "friend:friend"];
  return list
    .filter(include)
    .map((r) => ({ key: `${r.mode}:${r.level}`, label: r.mode === "ai" ? LEVELS[r.level]?.name || r.level : r.mode === "claude" ? "Claude" : "Friends", wins: r.wins, losses: r.losses, draws: r.draws }))
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

function viewLeaderboard() {
  const q = new URLSearchParams(location.search);
  let mode = q.get("mode") || "all", level = q.get("level") || "", days = q.get("days") || "";
  app.innerHTML = `
    <div class="page-head"><div class="eyebrow">Hall of fame</div><h1>Leaderboard</h1>
      <p>Points per win: Beginner 1 · Easy 2 · Medium 3 · Hard 5 · Expert 8 · Master 13 · Claude 8 · Friend 5. Draws give half.</p></div>
    <div class="filters">
      <div class="seg" id="lb-mode">${[["all", "All"], ["ai", "Vs Computer"], ["claude", "Vs Claude"], ["friend", "Vs Friends"]].map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === mode}">${l}</button>`).join("")}</div>
      <select class="input" id="lb-level" style="width:auto" ${mode === "ai" ? "" : "hidden"}>
        <option value="">All levels</option>${LEVEL_KEYS.map((k) => `<option value="${k}" ${k === level ? "selected" : ""}>${LEVELS[k].name}</option>`).join("")}</select>
      <div class="seg" id="lb-days">${[["", "All time"], ["30", "30 days"], ["7", "7 days"]].map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === days}">${l}</button>`).join("")}</div>
      ${auth ? "" : '<button class="btn small" id="lb-sign" style="margin-left:auto">Sign in to compete</button>'}
    </div>
    <div class="tiles" id="lb-tiles"></div>
    <div class="game split">
      <div class="card"><div id="lb-table"><div class="empty"><span class="spinner"></span></div></div></div>
      <div class="card"><div class="chart-head"><h3 style="margin:0">How humans do vs each opponent</h3></div><div id="lb-chart"></div>
        <p class="muted" style="font-size:.85rem;margin:12px 0 0">Results from the human side. Friend games count once per signed-in player.</p></div>
    </div>`;
  $("#lb-sign")?.addEventListener("click", () => openAuth());
  let stats = null;
  const sync = () => {
    const p = new URLSearchParams();
    if (mode !== "all") p.set("mode", mode);
    if (mode === "ai" && level) p.set("level", level);
    if (days) p.set("days", days);
    history.replaceState(null, "", `/leaderboard${p.toString() ? "?" + p : ""}`);
    $("#lb-level").hidden = mode !== "ai";
    load();
  };
  $$("#lb-mode button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.v; if (mode !== "ai") level = "";
    $$("#lb-mode button").forEach((x) => x.setAttribute("aria-pressed", x === b)); sync();
  }));
  $$("#lb-days button").forEach((b) => b.addEventListener("click", () => {
    days = b.dataset.v; $$("#lb-days button").forEach((x) => x.setAttribute("aria-pressed", x === b)); sync();
  }));
  $("#lb-level").addEventListener("change", (e) => { level = e.target.value; sync(); });

  async function load() {
    const p = new URLSearchParams({ mode, level, days });
    try {
      const [{ rows }, st] = await Promise.all([api(`/api/leaderboard?${p}`), stats ? Promise.resolve(stats) : api("/api/stats")]);
      stats = st;
      $("#lb-table").innerHTML = rows.length ? lbTable(rows, mode) : '<div class="empty">No results for this filter yet.</div>';
      const inFilter = (r) => (mode === "all" || r.mode === mode) && (!level || r.level === level);
      const scoped = stats.byMode.filter(inFilter);
      const games = scoped.reduce((a, r) => a + r.games, 0);
      const humanWins = scoped.filter((r) => r.mode !== "friend").reduce((a, r) => a + r.wins, 0);
      const humanGames = scoped.filter((r) => r.mode !== "friend").reduce((a, r) => a + r.games, 0);
      $("#lb-tiles").innerHTML = [
        ["Players", stats.players],
        ["Games recorded", games],
        ["Human win rate", humanGames ? `${Math.round((humanWins / humanGames) * 100)}%` : "-"],
        ["Leader", rows[0] ? esc(rows[0].name) : "-"],
      ].map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
      const chartRows = opponentRows(stats.byMode, (r) => inFilter(r) && r.mode !== "friend");
      $("#lb-chart").innerHTML = chartRows.length ? stackedBars(chartRows) : '<div class="empty">No games yet.</div>';
    } catch (e) {
      $("#lb-table").innerHTML = `<div class="empty">Couldn't load: ${esc(e.message)}</div>`;
    }
  }
  load();
}

/* ---------------- player profile */
async function viewProfile(name) {
  app.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  let p;
  try { p = await api(`/api/players/${encodeURIComponent(name)}`); }
  catch { app.innerHTML = `<div class="card empty" style="margin-top:30px">No player called <b>${esc(name)}</b>. <a href="/leaderboard" data-link>Back to the leaderboard</a></div>`; return; }
  const tot = p.breakdown.reduce((a, r) => ({ w: a.w + r.wins, l: a.l + r.losses, d: a.d + r.draws, pts: a.pts + r.points }), { w: 0, l: 0, d: 0, pts: 0 });
  const games = tot.w + tot.l + tot.d;
  // 30-day activity
  const dayMs = 86400000;
  const start = Math.floor((Date.now() - 29 * dayMs) / dayMs) * dayMs;
  const byDay = new Map(p.daily.map((d) => [d.day, d]));
  const days = Array.from({ length: 30 }, (_, i) => ({ date: new Date(start + i * dayMs), ...(byDay.get(i) || { games: 0, wins: 0 }) }));
  const maxG = Math.max(1, ...days.map((d) => d.games));
  const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const isMe = auth && auth.name.toLowerCase() === p.name.toLowerCase();
  app.innerHTML = `
    <div class="page-head row" style="gap:16px">
      <span class="avatar" style="width:64px;height:64px;font-size:1.8rem;background:${avatarColor(p.name)}">${esc(initials(p.name))}</span>
      <div><div class="eyebrow">${isMe ? "Your stats" : "Player"}</div><h1 style="margin:0">${esc(p.name)}</h1>
        <span class="muted">Member since ${new Date(p.created).toLocaleDateString()}</span></div></div>
    <div class="tiles">
      <div class="tile"><div class="k">Rank</div><div class="v">#${p.rank}</div></div>
      <div class="tile"><div class="k">Points</div><div class="v">${+tot.pts.toFixed(1)}</div></div>
      <div class="tile"><div class="k">Games</div><div class="v">${games}</div></div>
      <div class="tile"><div class="k">Win rate</div><div class="v">${games ? Math.round((tot.w / games) * 100) + "%" : "-"}</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="chart-head"><h3 style="margin:0">Results by opponent</h3></div>
        ${p.breakdown.length ? stackedBars(opponentRows(p.breakdown)) : '<div class="empty">No games yet.</div>'}</div>
      <div class="card"><div class="chart-head"><h3 style="margin:0">Games played · last 30 days</h3><span class="muted">${(() => { const n = days.reduce((a, d) => a + d.games, 0); return `${n} game${n === 1 ? "" : "s"}`; })()}</span></div>
        <div class="cols">${days.map((d) => `<i class="${d.games ? "" : "zero"}" style="height:${(d.games / maxG) * 100}%" tabindex="${d.games ? 0 : -1}"
          data-tip="<b>${fmt(d.date)}</b>${d.games} game${d.games === 1 ? "" : "s"} · ${d.wins} win${d.wins === 1 ? "" : "s"}"></i>`).join("")}</div>
        <div class="axis"><span>${fmt(days[0].date)}</span><span>${fmt(days[15].date)}</span><span>Today</span></div></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>Recent games</h3>
      ${p.recent.length ? `<div class="recent">${p.recent.map((g) => `<div><span class="tag ${g.outcome}">${g.outcome}</span>
        <span>vs <b>${esc(g.mode === "ai" ? opponentLabel("ai", g.level) : g.opponent || opponentLabel(g.mode))}</b> <span class="muted">· ${g.moves} moves</span></span>
        <span class="muted">${g.points ? `+${g.points} · ` : ""}${new Date(g.created).toLocaleDateString()}</span></div>`).join("")}</div>` : '<div class="empty">No games yet.</div>'}</div>`;
}

/* ================================================================ router */
const routes = [
  [/^\/$/, viewHome],
  [/^\/play\/?$/, viewPlayMenu],
  [/^\/play\/([a-z]+)$/, viewLocal],
  [/^\/friend\/?$/, viewFriend],
  [/^\/r\/([A-Za-z0-9]{6})$/, viewRoom],
  [/^\/claude\/?$/, viewClaude],
  [/^\/leaderboard\/?$/, viewLeaderboard],
  [/^\/u\/(.+)$/, (n) => viewProfile(decodeURIComponent(n))],
];
function render() {
  cleanup?.(); cleanup = null;
  tip.hidden = true;
  const path = location.pathname;
  for (const [re, view] of routes) {
    const m = path.match(re);
    if (m) {
      const r = view(...m.slice(1));
      if (typeof r === "function") cleanup = r;
      updateHeader();
      const titles = { "/": "Connect Four", "/play": "Play · Connect Four", "/leaderboard": "Leaderboard · Connect Four", "/claude": "Play Claude · Connect Four", "/friend": "Play a friend · Connect Four" };
      document.title = titles[path] || (path.startsWith("/r/") ? `Room ${path.slice(3)} · Connect Four` : "Connect Four");
      return;
    }
  }
  app.innerHTML = '<div class="card empty" style="margin-top:30px">Page not found. <a href="/" data-link>Go home</a></div>';
}
function navigate(path, replace = false) {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  render();
  window.scrollTo(0, 0);
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || a.target) return;
  e.preventDefault();
  $("#auth-dialog").open && $("#auth-dialog").close();
  navigate(a.getAttribute("href"));
});
window.addEventListener("popstate", render);
matchMedia("(prefers-color-scheme: light)").addEventListener("change", updateHeader);

updateHeader();
render();
verifyAuth();
