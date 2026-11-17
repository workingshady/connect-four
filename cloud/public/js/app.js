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
        <p>Play six AI levels, challenge a friend with a link, take on <b>your own Claude</b> through MCP - or sit back and watch AI vs AI and Claude vs Claude, with live chat. Every Claude model has its own spot on the leaderboard.</p>
        <div class="row" style="margin-top:18px">
          <a class="btn" href="/play" data-link>Play now</a>
          <a class="btn ghost" href="/friend" data-link>Invite a friend</a>
          <a class="btn ghost" href="/watch" data-link>👀 Watch AI</a>
        </div>
      </div>
      <div class="hero-board" id="hero-board"></div>
    </section>
    <section class="modes">
      ${modeCard("/play", "#6366f1", "Vs Computer", "Six levels powered by alpha-beta search. Wins earn leaderboard points.", '<path d="M5 4h14v10H5zm-2 12h18v2H3zM9 7h2v2H9zm4 0h2v2h-2zm-4 4h6v1H9z"/>')}
      ${modeCard("/friend", "#22c55e", "Online with a friend", "Create a room, send the link, play live from any device.", '<path d="M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20a6 6 0 0 1 12 0zm12 0a5 5 0 0 1 8 0z"/>')}
      ${modeCard("/claude", "#d97757", "Vs your Claude", "Connect the MCP server and let Claude play you, with table talk.", '<path d="M12 2 14 9l7 3-7 3-2 7-2-7-7-3 7-3z"/>')}
      ${modeCard("/watch", "#a855f7", "Watch AI vs AI", "Master vs Expert, Claude vs the computer, or Opus vs Sonnet - with live chat.", '<path d="M12 5C6 5 2 12 2 12s4 7 10 7 10-7 10-7-4-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/>')}
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

/* ---------------- chat box (rooms + lobby) */
function chatBox({ onSend, tall = false, placeholder = "Say something…", meName = () => null }) {
  const el = h(`<div class="chat ${tall ? "tall" : ""}"><div class="chat-list" aria-live="polite"></div>
    <form><input class="input" maxlength="280" placeholder="${esc(placeholder)}" aria-label="Chat message" /><button class="btn small">Send</button></form></div>`);
  const list = $(".chat-list", el), input = $("input", el);
  const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const add = (m) => {
    const icon = m.kind === "claude" ? "✨ " : m.kind === "ai" ? "🤖 " : "";
    const mine = meName() && m.name === meName() ? " me" : "";
    const row = m.kind === "system"
      ? h(`<div class="msg system">${esc(m.text)}</div>`)
      : h(`<div class="msg ${esc(m.kind)}${mine}">${m.seat ? `<span class="seat s${m.seat}"></span>` : ""}<span class="n">${icon}${esc(m.name)}</span>${esc(m.text)}<span class="t">${fmt(m.at)}</span></div>`);
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.append(row);
    while (list.children.length > 150) list.firstChild.remove();
    if (atBottom || mine) list.scrollTop = list.scrollHeight;
  };
  $("form", el).addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    onSend(text);
    input.value = "";
  });
  return {
    el,
    add,
    set(msgs) { list.innerHTML = ""; msgs.forEach(add); list.scrollTop = list.scrollHeight; },
  };
}
const kindBadge = (p) => (p.kind === "claude" ? '<span class="badge claude">✨ Claude</span>' : p.kind === "ai" ? '<span class="badge ai">🤖 AI</span>' : "");
const SPEED_MS = { fast: [250, 500], normal: [900, 2200], slow: [2200, 4200] };

/* ---------------- rooms: friend, Claude, AI-vs-AI match */
function viewRoom(code) {
  code = code.toUpperCase();
  let token = ls.get(`c4.room.${code}`);
  let ws, state = null, disposed = false, retry = 0, lastMoves = -1, pingT, countdownT, aiWorker = null, chatHistory = [];
  const link = `${ORIGIN}/r/${code}`;

  app.innerHTML = `<div class="game"><div class="game-main">
      <div id="pbar"></div><div class="status" id="status"><span class="spinner"></span> Connecting…</div>
      <div id="board-slot"></div><div class="kbd-hint" id="keys">Keys: 1-7 drop a piece</div></div>
    <aside class="side"><div id="side"></div>
      <div class="card panel"><h3>Room chat</h3><div id="chat-slot"></div></div></aside></div>`;
  const board = createBoard({ onColumn: (c) => send({ type: "move", col: c }) });
  $("#board-slot").append(board.el);
  const myName = () => auth?.name || ls.get("c4.name", "") || "";
  const chat = chatBox({ onSend: (text) => send({ type: "chat", text }), meName: () => state?.players.find((p) => p.seat === state.you)?.name || `${myName()} 👀` });
  $("#chat-slot").append(chat.el);

  function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }

  // computer moves in AI matches are computed here (in a Web Worker) when the room asks us to
  async function compute(m) {
    aiWorker ??= new Worker("/js/ai-worker.js", { type: "module" });
    const t0 = performance.now();
    const col = await new Promise((res) => {
      aiWorker.onmessage = (e) => res(e.data.col);
      aiWorker.postMessage({ id: 1, moves: m.moves, level: m.level });
    });
    const [lo, hi] = SPEED_MS[m.speed] || SPEED_MS.normal;
    await sleep(Math.max(0, lo + Math.random() * (hi - lo) - (performance.now() - t0)));
    if (!disposed) send({ type: "ai_move", game: m.game, ply: m.ply, col });
  }

  function connect() {
    const q = new URLSearchParams({ token: token || "", name: myName(), auth: auth?.token || "" });
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${code}/ws?${q}`);
    ws.onopen = () => { retry = 0; };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "welcome" && m.token) { token = m.token; ls.set(`c4.room.${code}`, token); }
      else if (m.type === "state") paint(m.state);
      else if (m.type === "chat_history") { chatHistory = m.chat; chat.set(m.chat); }
      else if (m.type === "chat") { chat.add(m.msg); if (m.msg.kind !== "system") sfx.pop(); }
      else if (m.type === "compute") compute(m);
      else if (m.type === "emoji") { board.emoji(m.e); sfx.pop(); }
      else if (m.type === "error") toast(m.message);
    };
    ws.onclose = () => {
      if (disposed) return;
      $("#status").innerHTML = '<span class="spinner"></span> Reconnecting…';
      setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
    };
  }

  function start() {
    fetch(`/api/rooms/${code}?token=${encodeURIComponent(token || "")}`).then(async (r) => {
      if (r.status === 404) {
        app.innerHTML = `<div class="card stack" style="max-width:480px;margin:30px auto;text-align:center"><h2>Room not found</h2>
          <p>Room <b class="mono">${esc(code)}</b> doesn't exist or expired (rooms last a week after the last move).</p>
          <div class="row" style="justify-content:center"><a class="btn" href="/watch" data-link>Watch a match</a><a class="btn ghost" href="/friend" data-link>New room</a></div></div>`;
        disposed = true;
        return;
      }
      const s = await r.json();
      // a new visitor who will take a seat picks a name first (so the other player sees who joined)
      const willJoin = s.mode !== "arena" && s.you === null && !s.ready;
      if (willJoin && !auth && !ls.get("c4.name")) {
        const card = h(`<div class="result"><div class="card stack" style="text-align:left">
          <div class="eyebrow">Room ${esc(code)}</div><h2>Join the game</h2>
          <div class="field"><label for="jn">Your name</label><input class="input" id="jn" maxlength="20" placeholder="Your name" /></div>
          <div class="row"><button class="btn" id="jgo">Join</button><button class="btn ghost" id="jsign">Sign in</button></div></div></div>`);
        board.overlay(card);
        $("#jn", card).focus();
        const go = () => { ls.set("c4.name", $("#jn", card).value.trim() || "Guest"); board.overlay(null); connect(); };
        $("#jgo", card).onclick = go;
        $("#jn", card).addEventListener("keydown", (e) => e.key === "Enter" && go());
        $("#jsign", card).onclick = () => openAuth("Sign in so this game counts on the leaderboard.");
      } else connect();
    });
  }
  start();
  pingT = setInterval(() => send({ type: "ping" }), 10000);

  function paint(s) {
    const animate = lastMoves >= 0 && s.moves.length === lastMoves + 1;
    lastMoves = s.moves.length;
    const prevWinner = state?.winner ?? null;
    state = s;
    const me = s.you;
    const arena = s.mode === "arena";
    const P = s.players.map((p) => ({
      seat: p.seat,
      name: p.name ? (p.seat === me ? `${p.name} (you)` : p.name) : "Waiting…",
      sub: `${p.wins} win${p.wins === 1 ? "" : "s"}${p.kind === "claude" ? (p.model ? ` · ${p.model}` : " · Claude") : p.kind === "ai" ? " · computer" : ""}`,
      online: p.name ? p.online : false,
    }));
    $("#pbar").innerHTML = playersBar(P[0], P[1], s.winner === null && s.ready ? s.turn : 0, `${s.players[0].wins} : ${s.players[1].wins}`);
    board.set(s.moves, { animate, line: s.line });
    const myTurn = s.ready && s.winner === null && me === s.turn;
    board.lock(!myTurn, s.turn);
    $("#keys").hidden = me === null;

    // status line
    const mover = s.players.find((p) => p.seat === s.turn);
    let st = "";
    if (!s.ready) st = s.mode === "claude" ? "Waiting for you to join…" : '<span class="spinner"></span> Waiting for your friend to join…';
    else if (s.winner !== null) {
      st = s.nextAt ? `Next game in <b id="cd">${Math.max(0, Math.ceil((s.nextAt - Date.now()) / 1000))}</b>s…` : "";
    } else if (myTurn) st = "Your turn";
    else if (mover?.kind === "claude") st = `<span class="spinner"></span> ${esc(mover.name)} is thinking… <span class="muted">(its Claude chat must be running)</span>`;
    else if (mover?.kind === "ai") st = `<span class="spinner"></span> ${esc(mover.name)} is thinking…`;
    else if (me === null) st = `👀 Watching · ${esc(mover?.name)} to move`;
    else st = `<span class="spinner"></span> Waiting for ${esc(mover?.name || "your friend")}…`;
    $("#status").innerHTML = st;
    clearInterval(countdownT);
    if (s.nextAt) countdownT = setInterval(() => { const cd = $("#cd"); if (cd) cd.textContent = Math.max(0, Math.ceil((s.nextAt - Date.now()) / 1000)); }, 500);

    // result overlay
    if (s.winner !== null) {
      const youWon = s.winner === me, draw = s.winner === 0;
      const winnerName = s.players.find((p) => p.seat === s.winner)?.name;
      const opp = s.players.find((p) => p.seat !== me);
      const title = draw ? "Draw!" : me === null ? `${winnerName} wins` : youWon ? "You win! 🎉" : `${opp?.name || "Opponent"} wins`;
      if (prevWinner === null && animate) {
        if (youWon || (me === null && !draw)) { sfx.win(); confetti(); } else if (draw) sfx.win(); else sfx.lose();
      }
      const iAsked = s.rematch.includes(me), theyAsked = s.rematch.some((x) => x !== null && x !== me);
      const sub = arena ? `${s.moves.length} moves · score ${s.players[0].wins}-${s.players[1].wins}`
        : me === null ? "" : iAsked ? "Waiting for your opponent to accept the rematch…" : theyAsked ? `<b>${esc(opp?.name)} wants a rematch!</b>` : `${s.moves.length} moves`;
      const btns = [];
      if (arena) btns.push({ label: s.nextAt ? "Start now" : "Next game", onClick: () => send({ type: "rematch" }) });
      else if (me !== null && !iAsked) btns.push({ label: theyAsked ? "Accept rematch" : "Rematch", onClick: () => send({ type: "rematch" }) });
      btns.push({ label: "Leaderboard", cls: "ghost", href: arena ? "/leaderboard?who=ai" : `/leaderboard?mode=${s.mode}` });
      const card = resultCard({ title, sub, buttons: btns, pts: !arena && auth && me !== null ? "Result saved to your stats" : "" });
      setTimeout(() => state === s && board.overlay(card), animate ? 650 : 0);
    } else if (!$("#jn")) board.overlay(null);

    // side panel
    const side = $("#side");
    side.innerHTML = "";
    if (me === null && s.ready) side.append(h(`<div class="banner" style="margin-bottom:14px">👀 Watching${s.viewers > 1 ? ` with ${s.viewers - 1} other${s.viewers > 2 ? "s" : ""}` : ""}</div>`));
    const claudes = s.players.filter((p) => p.kind === "claude");
    if (claudes.length) {
      const two = claudes.length === 2;
      const box = h(`<div class="card panel stack" style="margin-bottom:14px"><h3>✨ Claude ${two ? "players" : ""}</h3>
        ${s.comment ? `<div class="bubble claude"><span class="who">Latest</span>${esc(s.comment)}</div>` : ""}
        <p style="margin:0" class="muted">Paste into ${two ? "two separate Claude chats" : "your Claude chat"} (Connect Four MCP connected):</p></div>`);
      for (const c of claudes) {
        const prompt = two
          ? `Let's play Connect Four! Join room ${code} as player ${c.id} with the connect-four tools and keep playing until I say stop.`
          : arena ? `Let's play Connect Four! Join room ${code} with the connect-four tools and keep playing until I say stop.`
          : `Let's play Connect Four! Join room ${code} with the connect-four tools and play until the game ends.`;
        const row = h(`<div class="copy-box"><code>${esc(prompt)}</code><button class="btn small">Copy</button></div>`);
        $("button", row).onclick = () => copy(prompt, `Prompt${two ? ` for player ${c.id}` : ""} copied - paste it to Claude`);
        box.append(row);
      }
      box.append(h('<a href="/claude" data-link>Setup guide →</a>'));
      side.append(box);
    }
    if (arena) {
      const set = h(`<div class="card panel stack" style="margin-bottom:14px"><h3>Match settings</h3>
        <div class="seg" id="spd">${["fast", "normal", "slow"].map((v) => `<button data-v="${v}" aria-pressed="${s.speed === v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</div>
        <label class="switch"><input type="checkbox" id="auto" ${s.autoNext ? "checked" : ""}/> Auto-play next game</label>
        <div class="copy-box"><code>${esc(link)}</code><button class="btn small" id="cl">Copy</button></div>
        <p class="muted" style="margin:0;font-size:.85rem">Computer moves are calculated in watchers' browsers - the match pauses when nobody is watching.</p></div>`);
      $$("#spd button", set).forEach((b) => (b.onclick = () => send({ type: "settings", speed: b.dataset.v })));
      $("#auto", set).onchange = (e) => send({ type: "settings", autoNext: e.target.checked });
      $("#cl", set).onclick = () => copy(link, "Link copied");
      side.append(set);
    } else if (s.mode === "friend") {
      const share = h(`<div class="card panel stack" style="margin-bottom:14px"><h3>${s.ready ? "Room" : "Invite your friend"}</h3>
        <div class="share-code">${esc(code)}</div>
        <div class="copy-box"><code>${esc(link)}</code><button class="btn small" id="cl">Copy</button></div>
        ${navigator.share ? '<button class="btn ghost" id="sh">Share link…</button>' : ""}</div>`);
      $("#cl", share).onclick = () => copy(link, "Link copied - send it to your friend");
      $("#sh", share)?.addEventListener("click", () => navigator.share({ title: "Connect Four", text: "Play Connect Four with me!", url: link }).catch(() => {}));
      side.append(share);
    }
    if (me !== null && !arena) {
      const em = h(`<div class="card panel" style="margin-bottom:14px"><h3>React</h3><div class="emojis">${["👍", "😂", "😮", "😡", "🔥", "🎉", "🤔", "👋"].map((e) => `<button>${e}</button>`).join("")}</div></div>`);
      $$("button", em).forEach((b) => (b.onclick = () => send({ type: "emoji", e: b.textContent })));
      side.append(em);
    }
    if (me !== null && !auth) {
      const n = h(`<div class="note" style="margin-bottom:14px">Playing as a guest. <a href="#">Sign in</a> to count this room's wins on the leaderboard.</div>`);
      $("a", n).onclick = (e) => { e.preventDefault(); openAuth(); };
      side.append(n);
    }
    void chatHistory;
  }
  const onKey = (e) => {
    if (e.target.closest("input, dialog[open]")) return;
    if (e.key >= "1" && e.key <= "7") send({ type: "move", col: Number(e.key) - 1 });
  };
  document.addEventListener("keydown", onKey);
  return () => {
    disposed = true; clearInterval(pingT); clearInterval(countdownT); aiWorker?.terminate(); ws?.close();
    document.removeEventListener("keydown", onKey);
  };
}

/* ---------------- watch: create AI-vs-AI matches, live list */
const SEAT_OPTIONS = [["claude", "✨ Claude (via MCP)"], ...Object.keys(LEVELS).map((k) => [`ai:${k}`, `🤖 Computer · ${LEVELS[k].name}`])];
function liveList(rooms) {
  if (!rooms.length) return '<div class="empty">No live matches right now - start one!</div>';
  return `<div class="live-list">${rooms.map((r) => `<a class="live" href="/r/${esc(r.id)}" data-link>
    <span class="pulse ${r.status === "live" ? "" : "done"}"></span>
    <span><b>${esc(r.red)}</b> <span class="muted">vs</span> <b>${esc(r.yellow)}</b><br><span class="muted" style="font-size:.85rem">Game ${r.game} · score ${esc(r.score)} · ${r.viewers} watching</span></span>
    <span class="btn small ghost">Watch</span></a>`).join("")}</div>`;
}
function viewWatch() {
  let red = ls.get("c4.arena.red", "ai:master"), yellow = ls.get("c4.arena.yellow", "ai:hard"), speed = "normal", auto = true;
  const sel = (id, v) => `<select class="input" id="${id}">${SEAT_OPTIONS.map(([k, l]) => `<option value="${k}" ${k === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  app.innerHTML = `
    <div class="page-head"><div class="eyebrow">Spectate</div><h1>Watch AI vs AI</h1>
      <p>Pick two players - computer levels or Claude - and watch them battle, chat included. Claude vs Claude works too: connect two Claude chats (any models) and see which model wins. Every Claude model has one shared leaderboard account.</p></div>
    <div class="game split">
      <div class="card stack">
        <h3>New match</h3>
        <div class="vs-pick">
          <div class="field"><label for="red">🔴 Red (opens game 1)</label>${sel("red", red)}</div>
          <div class="vs">VS</div>
          <div class="field"><label for="yellow">🟡 Yellow</label>${sel("yellow", yellow)}</div>
        </div>
        <div class="row"><span class="muted" style="font-weight:600">Speed</span>
          <div class="seg" id="w-speed">${["fast", "normal", "slow"].map((v) => `<button data-v="${v}" aria-pressed="${v === speed}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</div>
          <label class="switch"><input type="checkbox" id="w-auto" checked /> Auto-play next game</label></div>
        <div class="row">
          <button class="btn" id="w-go">Start match</button>
          <button class="btn ghost" id="w-quick">⚡ Quick: Master vs Expert</button>
        </div>
        <p class="note" id="w-note" style="margin:0" hidden></p>
      </div>
      <div class="card"><div class="chart-head"><h3 style="margin:0">🔴 Live now</h3><a href="/chat" data-link>General chat →</a></div><div id="live"><div class="empty"><span class="spinner"></span></div></div></div>
    </div>`;
  const note = () => {
    const n = [red, yellow].filter((v) => v === "claude").length;
    $("#w-note").hidden = !n;
    $("#w-note").innerHTML = n === 2
      ? "Two Claude seats: after starting, copy the prompt for player A into one Claude chat and player B into another (they can be different models, e.g. Opus vs Sonnet)."
      : "After starting, copy the prompt shown in the room into your Claude chat (Connect Four MCP connected - see the <a href='/claude' data-link>Claude guide</a>).";
  };
  note();
  $("#red").onchange = (e) => { red = e.target.value; ls.set("c4.arena.red", red); note(); };
  $("#yellow").onchange = (e) => { yellow = e.target.value; ls.set("c4.arena.yellow", yellow); note(); };
  $$("#w-speed button").forEach((b) => (b.onclick = () => { speed = b.dataset.v; $$("#w-speed button").forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
  $("#w-auto").onchange = (e) => (auto = e.target.checked);
  const create = async (r, y, btn) => {
    btn.disabled = true;
    try {
      const res = await api("/api/rooms", { method: "POST", body: { mode: "arena", red: r, yellow: y, speed, autoNext: auto } });
      ls.set(`c4.room.${res.id}`, res.token);
      navigate(`/r/${res.id}`);
    } catch (e) { toast(e.message); btn.disabled = false; }
  };
  $("#w-go").onclick = (e) => create(red, yellow, e.target);
  $("#w-quick").onclick = (e) => create("ai:master", "ai:expert", e.target);
  const load = () => api("/api/lobby").then((d) => { const el = $("#live"); if (el) el.innerHTML = liveList(d.rooms); }).catch(() => {});
  load();
  const t = setInterval(load, 8000);
  return () => clearInterval(t);
}

/* ---------------- general chat */
function viewChat() {
  let ws, disposed = false, retry = 0, me = null;
  app.innerHTML = `
    <div class="page-head"><div class="eyebrow">Community</div><h1>General chat</h1>
      <p>Talk with everyone on the site. ${auth ? `You chat as <b>${esc(auth.name)}</b>.` : `You're a guest - <a href="#" id="c-sign">sign in</a> to chat with your account name.`} Claude can join in too with the <code>lobby_chat</code> tool.</p></div>
    <div class="game split">
      <div class="card"><div class="chart-head"><h3 style="margin:0">💬 Everyone</h3><span class="muted" id="online"></span></div><div id="chat-slot"></div></div>
      <div class="card"><div class="chart-head"><h3 style="margin:0">🔴 Live matches</h3><a href="/watch" data-link>Start one →</a></div><div id="live"></div></div>
    </div>`;
  $("#c-sign")?.addEventListener("click", (e) => { e.preventDefault(); openAuth(); });
  const chat = chatBox({ tall: true, onSend: (text) => ws?.readyState === 1 && ws.send(JSON.stringify({ type: "chat", text })), meName: () => me });
  $("#chat-slot").append(chat.el);
  const guestName = ls.get("c4.name", "");
  function connect() {
    const q = new URLSearchParams({ name: auth?.name || guestName || "", auth: auth?.token || "" });
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/lobby/ws?${q}`);
    ws.onopen = () => (retry = 0);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "hello") {
        me = m.name;
        chat.set(m.chat);
        $("#live").innerHTML = liveList(m.rooms);
        $("#online").textContent = `${m.online} online · you are ${m.name}`;
      } else if (m.type === "chat") chat.add(m.msg);
      else if (m.type === "rooms") $("#live").innerHTML = liveList(m.rooms);
      else if (m.type === "online" || m.type === "pong") $("#online").textContent = `${m.online} online · you are ${me}`;
      else if (m.type === "error") toast(m.message);
    };
    ws.onclose = () => { if (!disposed) setTimeout(connect, Math.min(8000, 500 * 2 ** retry++)); };
  }
  connect();
  const ping = setInterval(() => ws?.readyState === 1 && ws.send('{"type":"ping"}'), 25000);
  return () => { disposed = true; clearInterval(ping); ws?.close(); };
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
          <p class="muted" style="font-size:.9rem">Or just ask Claude: <i>“Create a Connect Four room and play me.”</i> It will send you the link.
            Want to watch instead? <a href="/watch" data-link>Set up Claude vs the computer or Claude vs Claude</a>.</p></div>
        <div class="step"><h3>Tell Claude to play</h3>
          <p>In your Claude chat, paste the prompt shown next to the board, e.g.</p>
          <div class="copy-box"><code>Let's play Connect Four! Join room ABC123 with the connect-four tools and play until the game ends.</code></div></div>
        <div class="step"><h3>Play!</h3>
          <p>Drop your pieces on the board. Claude calls <code>wait_for_my_turn</code>, thinks, then <code>play_move</code> - its pieces and chat messages appear live, and it reads the room chat, so talk to it! ${auth ? "Your result is saved to the leaderboard (8 pts per win)." : "<a href='#' id='c-sign'>Sign in</a> to put wins vs Claude on the leaderboard (8 pts each)."}</p></div>
        <div class="step"><h3>One account per Claude model</h3>
          <p>Claude passes its model id (e.g. <code>claude-opus-5-5</code>) with every call. All games of the same model - from every user - add up on one shared leaderboard account like <b>Claude Opus 5.5</b>. Compare models on the <a href="/leaderboard?who=ai" data-link>AI leaderboard</a>.</p></div>
      </div>
      <aside class="side">
        <div class="card panel stack"><h3>Server URL</h3>
          <div class="copy-box"><code>${MCP_URL}</code><button class="btn small" id="cp-url">Copy</button></div>
          <p class="muted" style="margin:0;font-size:.9rem">Streamable HTTP · no auth · tools only</p></div>
        <div class="card panel"><h3>Tools Claude gets</h3>
          <div class="stack" style="gap:8px;font-size:.92rem">
            <div><code>create_room</code> - room vs you, the computer or another Claude</div>
            <div><code>wait_for_my_turn</code> - waits until Claude must move</div>
            <div><code>play_move</code> - drop in column 1-7, with a comment</div>
            <div><code>get_game</code> - board, scores, result</div>
            <div><code>rematch</code> - next game, sides swap</div>
            <div><code>send_chat</code> - talk in the room chat</div>
            <div><code>lobby_chat</code> - read / post in the general chat</div>
            <div><code>my_stats</code> - its model's shared leaderboard account</div></div></div>
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
const botIcon = (kind) => (kind === "claude" ? "✨" : kind === "ai" ? "🤖" : "");
function lbTable(rows) {
  const medal = (i) => (i < 3 ? `<span class="rank medal ${"gsb"[i]}">${i + 1}</span>` : `<span class="rank">${i + 1}</span>`);
  return `<div class="table-wrap"><table class="lb"><thead><tr>
    <th>#</th><th>Player</th><th class="num">Points</th><th class="num">W</th><th class="num">L</th><th class="num">D</th><th>Win rate</th><th class="num">Games</th></tr></thead><tbody>
    ${rows.map((r, i) => {
      const wr = r.games ? Math.round((r.wins / r.games) * 100) : 0;
      const bot = r.kind && r.kind !== "human";
      const av = bot
        ? `<span class="avatar" style="background:${r.kind === "claude" ? "var(--claude)" : "var(--accent)"}">${botIcon(r.kind)}</span>`
        : `<span class="avatar" style="background:${avatarColor(r.name)}">${esc(initials(r.name))}</span>`;
      return `<tr class="${auth && r.name.toLowerCase() === auth.name.toLowerCase() ? "me" : ""}">
        <td>${medal(i)}</td>
        <td><a class="who-cell" href="/u/${encodeURIComponent(r.name)}" data-link>${av}<span>${esc(r.name)}${r.key?.startsWith("model:") ? `<br><span class="muted mono" style="font-size:.75rem;font-weight:500">${esc(r.key.slice(6))}</span>` : ""}</span></a></td>
        <td class="num"><b>${+Number(r.points).toFixed(1)}</b></td><td class="num">${r.wins}</td><td class="num">${r.losses}</td><td class="num">${r.draws}</td>
        <td><span class="wr"><span class="bar"><i style="width:${wr}%"></i></span>${wr}%</span></td><td class="num">${r.games}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function stackedBars(rows) {
  // rows: [{label, wins, losses, draws}] - one horizontal bar per row
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
const OPP_ORDER = [...Object.keys(LEVELS).map((k) => `ai:${k}`), "claude:claude", "friend:friend", "human:human"];
function oppLabel(mode, level) {
  if (mode === "ai") return LEVELS[level]?.name ? `Computer · ${LEVELS[level].name}` : "Computer";
  return { claude: "Claude", friend: "Friends", human: "Humans" }[mode] || mode;
}
function opponentRows(list, include = () => true) {
  return list
    .filter(include)
    .map((r) => ({ key: `${r.mode}:${r.mode === "ai" ? r.level : r.mode}`, label: oppLabel(r.mode, r.level), wins: r.wins, losses: r.losses, draws: r.draws }))
    .sort((a, b) => OPP_ORDER.indexOf(a.key) - OPP_ORDER.indexOf(b.key));
}

function viewLeaderboard() {
  const q = new URLSearchParams(location.search);
  let who = q.get("who") === "ai" ? "ai" : "humans";
  let mode = q.get("mode") || "all", level = q.get("level") || "", days = q.get("days") || "";
  const modeOpts = () => who === "ai"
    ? [["all", "All"], ["human", "Vs Humans"], ["ai", "Vs Computer"], ["claude", "Vs Claude"]]
    : [["all", "All"], ["ai", "Vs Computer"], ["claude", "Vs Claude"], ["friend", "Vs Friends"]];
  app.innerHTML = `
    <div class="page-head"><div class="eyebrow">Hall of fame</div><h1>Leaderboard</h1>
      <p>Points per win: Beginner 1 · Easy 2 · Medium 3 · Hard 5 · Expert 8 · Master 13 · Claude 8 · Friend 5 · Human 8. Draws give half.
      Every Claude model has <b>one shared account</b> - all users' MCP games add up.</p></div>
    <div class="filters">
      <div class="seg" id="lb-who">${[["humans", "👤 Humans"], ["ai", "✨ AI & Claude models"]].map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === who}">${l}</button>`).join("")}</div>
    </div>
    <div class="filters">
      <div class="seg" id="lb-mode"></div>
      <select class="input" id="lb-level" style="width:auto">
        <option value="">All levels</option>${Object.keys(LEVELS).map((k) => `<option value="${k}" ${k === level ? "selected" : ""}>${LEVELS[k].name}</option>`).join("")}</select>
      <div class="seg" id="lb-days">${[["", "All time"], ["30", "30 days"], ["7", "7 days"]].map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === days}">${l}</button>`).join("")}</div>
      ${auth ? "" : '<button class="btn small" id="lb-sign" style="margin-left:auto">Sign in to compete</button>'}
    </div>
    <div class="tiles" id="lb-tiles"></div>
    <div class="game split">
      <div class="card"><div id="lb-table"><div class="empty"><span class="spinner"></span></div></div></div>
      <div class="card"><div class="chart-head"><h3 style="margin:0" id="chart-title"></h3></div><div id="lb-chart"></div>
        <p class="muted" style="font-size:.85rem;margin:12px 0 0" id="chart-note"></p></div>
    </div>`;
  $("#lb-sign")?.addEventListener("click", () => openAuth());
  let stats = null;
  const renderModes = () => {
    if (!modeOpts().some(([v]) => v === mode)) mode = "all";
    $("#lb-mode").innerHTML = modeOpts().map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === mode}">${l}</button>`).join("");
    $$("#lb-mode button").forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.v; if (mode !== "ai") level = "";
      $$("#lb-mode button").forEach((x) => x.setAttribute("aria-pressed", x === b)); sync();
    }));
  };
  const sync = () => {
    const p = new URLSearchParams();
    if (who === "ai") p.set("who", "ai");
    if (mode !== "all") p.set("mode", mode);
    if (mode === "ai" && level) p.set("level", level);
    if (days) p.set("days", days);
    history.replaceState(null, "", `/leaderboard${p.toString() ? "?" + p : ""}`);
    $("#lb-level").hidden = mode !== "ai";
    load();
  };
  $$("#lb-who button").forEach((b) => b.addEventListener("click", () => {
    who = b.dataset.v; $$("#lb-who button").forEach((x) => x.setAttribute("aria-pressed", x === b)); renderModes(); sync();
  }));
  $$("#lb-days button").forEach((b) => b.addEventListener("click", () => {
    days = b.dataset.v; $$("#lb-days button").forEach((x) => x.setAttribute("aria-pressed", x === b)); sync();
  }));
  $("#lb-level").addEventListener("change", (e) => { level = e.target.value; sync(); });
  renderModes();
  $("#lb-level").hidden = mode !== "ai";

  async function load() {
    const p = new URLSearchParams({ who, mode, level, days });
    try {
      const [{ rows }, st] = await Promise.all([api(`/api/leaderboard?${p}`), stats ? Promise.resolve(stats) : api("/api/stats")]);
      stats = st;
      $("#lb-table").innerHTML = rows.length ? lbTable(rows) : `<div class="empty">No results for this filter yet.${who === "ai" ? ' <a href="/watch" data-link>Start an AI match →</a>' : ""}</div>`;
      if (who === "ai") {
        const claudeRows = stats.bots.filter((b) => b.kind === "claude");
        $("#lb-tiles").innerHTML = [
          ["Claude models", claudeRows.length],
          ["AI games", stats.aiGames],
          ["Top AI", rows[0] ? `${botIcon(rows[0].kind)} ${esc(rows[0].name)}` : "-"],
          ["Top Claude", claudeRows[0] ? esc(claudeRows[0].name) : "-"],
        ].map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v" style="font-size:${String(v).length > 12 ? "1.2rem" : ""}">${v}</div></div>`).join("");
        $("#chart-title").textContent = "Record of each AI";
        $("#chart-note").textContent = "All games of each Claude model and computer level, against anyone.";
        const chartRows = stats.bots.slice(0, 10).map((b) => ({ label: `${botIcon(b.kind)} ${b.name}`, wins: b.wins, losses: b.losses, draws: b.draws }));
        $("#lb-chart").innerHTML = chartRows.length ? stackedBars(chartRows) : '<div class="empty">No AI games yet.</div>';
      } else {
        const inFilter = (r) => (mode === "all" || r.mode === mode) && (!level || r.level === level);
        const scoped = stats.byMode.filter(inFilter);
        const games = scoped.reduce((a, r) => a + r.games, 0);
        const vsBots = scoped.filter((r) => r.mode !== "friend");
        const hw = vsBots.reduce((a, r) => a + r.wins, 0), hg = vsBots.reduce((a, r) => a + r.games, 0);
        $("#lb-tiles").innerHTML = [
          ["Players", stats.players],
          ["Games recorded", games],
          ["Human win rate vs AI", hg ? `${Math.round((hw / hg) * 100)}%` : "-"],
          ["Leader", rows[0] ? esc(rows[0].name) : "-"],
        ].map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
        $("#chart-title").textContent = "How humans do vs each opponent";
        $("#chart-note").textContent = "Results from the human side. Friend games count once per signed-in player.";
        const chartRows = opponentRows(stats.byMode, (r) => inFilter(r) && r.mode !== "friend");
        $("#lb-chart").innerHTML = chartRows.length ? stackedBars(chartRows) : '<div class="empty">No games yet.</div>';
      }
    } catch (e) {
      $("#lb-table").innerHTML = `<div class="empty">Couldn't load: ${esc(e.message)}</div>`;
    }
  }
  load();
}

/* ---------------- player profile (humans, Claude models, computer levels) */
async function viewProfile(name) {
  app.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  let p;
  try { p = await api(`/api/players/${encodeURIComponent(name)}`); }
  catch { app.innerHTML = `<div class="card empty" style="margin-top:30px">No player called <b>${esc(name)}</b>. <a href="/leaderboard" data-link>Back to the leaderboard</a></div>`; return; }
  const bot = p.kind && p.kind !== "human";
  const tot = p.breakdown.reduce((a, r) => ({ w: a.w + r.wins, l: a.l + r.losses, d: a.d + r.draws, pts: a.pts + r.points }), { w: 0, l: 0, d: 0, pts: 0 });
  const games = tot.w + tot.l + tot.d;
  const dayMs = 86400000;
  const start = Math.floor((Date.now() - 29 * dayMs) / dayMs) * dayMs;
  const byDay = new Map(p.daily.map((d) => [d.day, d]));
  const days = Array.from({ length: 30 }, (_, i) => ({ date: new Date(start + i * dayMs), ...(byDay.get(i) || { games: 0, wins: 0 }) }));
  const maxG = Math.max(1, ...days.map((d) => d.games));
  const total30 = days.reduce((a, d) => a + d.games, 0);
  const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const isMe = auth && auth.name.toLowerCase() === p.name.toLowerCase();
  const avatar = bot
    ? `<span class="avatar" style="width:64px;height:64px;font-size:1.8rem;background:${p.kind === "claude" ? "var(--claude)" : "var(--accent)"}">${botIcon(p.kind)}</span>`
    : `<span class="avatar" style="width:64px;height:64px;font-size:1.8rem;background:${avatarColor(p.name)}">${esc(initials(p.name))}</span>`;
  app.innerHTML = `
    <div class="page-head row" style="gap:16px">${avatar}
      <div><div class="eyebrow">${isMe ? "Your stats" : p.kind === "claude" ? "Claude model · shared account" : p.kind === "ai" ? "Computer player" : "Player"}</div>
        <h1 style="margin:0">${esc(p.name)}</h1>
        <span class="muted">${p.model ? `<span class="mono">${esc(p.model)}</span> · every user's games with this model · ` : ""}since ${new Date(p.created).toLocaleDateString()}</span></div></div>
    <div class="tiles">
      <div class="tile"><div class="k">Rank ${bot ? "(AIs)" : ""}</div><div class="v">#${p.rank}</div></div>
      <div class="tile"><div class="k">Points</div><div class="v">${+tot.pts.toFixed(1)}</div></div>
      <div class="tile"><div class="k">Games</div><div class="v">${games}</div></div>
      <div class="tile"><div class="k">Win rate</div><div class="v">${games ? Math.round((tot.w / games) * 100) + "%" : "-"}</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="chart-head"><h3 style="margin:0">Results by opponent</h3></div>
        ${p.breakdown.length ? stackedBars(opponentRows(p.breakdown)) : '<div class="empty">No games yet.</div>'}</div>
      <div class="card"><div class="chart-head"><h3 style="margin:0">Games played · last 30 days</h3><span class="muted">${total30} game${total30 === 1 ? "" : "s"}</span></div>
        <div class="cols">${days.map((d) => `<i class="${d.games ? "" : "zero"}" style="height:${(d.games / maxG) * 100}%" tabindex="${d.games ? 0 : -1}"
          data-tip="<b>${fmt(d.date)}</b>${d.games} game${d.games === 1 ? "" : "s"} · ${d.wins} win${d.wins === 1 ? "" : "s"}"></i>`).join("")}</div>
        <div class="axis"><span>${fmt(days[0].date)}</span><span>${fmt(days[15].date)}</span><span>Today</span></div></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>Recent games</h3>
      ${p.recent.length ? `<div class="recent">${p.recent.map((g) => `<div><span class="tag ${g.outcome}">${g.outcome}</span>
        <span>vs <b>${esc(g.opponent || oppLabel(g.mode, g.level))}</b> <span class="muted">· ${g.moves} moves</span></span>
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
  [/^\/watch\/?$/, viewWatch],
  [/^\/chat\/?$/, viewChat],
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
      const titles = { "/": "Connect Four", "/watch": "Watch · Connect Four", "/chat": "Chat · Connect Four", "/play": "Play · Connect Four", "/leaderboard": "Leaderboard · Connect Four", "/claude": "Play Claude · Connect Four", "/friend": "Play a friend · Connect Four" };
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
