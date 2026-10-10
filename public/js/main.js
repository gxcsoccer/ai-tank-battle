import { COLORS, Renderer } from "./render.js";
import { Sound } from "./sound.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, area = localStorage) {
    try {
      return area.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v, area = localStorage) {
    try {
      area.setItem(k, v);
    } catch {}
  },
};

const sound = new Sound();
const renderer = new Renderer($("#cv"), sound);

const ATTRS = [
  ["armor", "装甲", (p) => `${2 + Math.round(p * 0.6)} 血`],
  ["speed", "机动", (p) => `速度 ${62 + p * 8}`],
  ["power", "火力", (p) => `暴击 ${p * 7}%`],
  ["reload", "装填", (p) => `${(0.6 - p * 0.08).toFixed(2)}s${p >= 4 ? " ×2弹" : ""}`],
  ["sense", "感知", (p) => `闪避 ${Math.round((0.25 + p * 0.13) * 100)}%`],
];

const FRAGMENTS = [
  ["人设", ["狂暴莽夫，永不后退", "冷静的狙击手，只打有把握的仗", "狡猾的刺客，擅长偷袭", "稳健的守护者，先保命再输出", "话痨战神，边打边嘲讽"]],
  ["战术", ["开局先抢最近的道具", "沿墙迂回，从侧翼包抄", "藏在草丛里伏击", "血量低于一半立刻撤退找回血", "有护盾时全力冲锋", "保持距离，拉开射击"]],
  ["目标", ["集火比分领先的敌人", "专挑残血的收割", "优先猎杀真人玩家的坦克", "先清理 NPC 刷分", "谁打我我就追谁"]],
  ["台词", ["击杀时大喊“这就是秘籍的力量！”", "说话带东北口音", "用文言文嘲讽对手", "像武侠小说里的大侠一样说话"]],
  ["倾向", ["装甲要厚", "速度要快", "火力要猛", "射速要高", "眼观六路耳听八方"]],
];

const ORDERS = [
  ["charge", "⚔️", "冲锋"],
  ["focus", "🎯", "集火"],
  ["snipe", "🩸", "收割"],
  ["flank", "↪️", "包抄"],
  ["ambush", "🌿", "埋伏"],
  ["retreat", "🛡️", "撤退"],
  ["powerup", "🎁", "道具"],
];
const ORDER_GAP = 2500;

const app = {
  room: null,
  ws: null,
  myId: null,
  roomInfo: null,
  match: null,
  result: null,
  brain: new Map(), // tankId -> { label, target, say, sayAt }
  timeLeft: null,
  showResult: false,
  sentSecret: null, // what the server currently holds for us
  orderReadyAt: 0,
  leaving: false,
  retries: 0,
  auth: { enabled: false, user: null }, // Google sign-in state from /api/me
};

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // Identity comes from the Google session cookie, which the browser attaches to the upgrade.
  const ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(app.room)}`);
  app.ws = ws;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    app.retries = 0;
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (app.ws !== ws || app.leaving) return;
    if (e.code === 4000) {
      toast("你在另一个窗口打开了这个房间");
      return;
    }
    if (!opened) {
      // The handshake was refused: most likely the session expired.
      fetch("/api/me")
        .then((r) => r.json())
        .then((me) => {
          if (!me.user) {
            app.auth = me;
            leaveRoom();
            renderAuth();
            $("#home-err").textContent = "登录已过期，请重新登录";
          }
        })
        .catch(() => {});
    }
    if (app.retries++ < 5) {
      toast("连接中断，正在重连…");
      setTimeout(() => app.ws === ws && connect(), 1000 * app.retries);
    } else {
      toast("无法连接服务器，请刷新页面");
    }
  };
}

function send(obj) {
  if (app.ws?.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(obj));
}

function handle(m) {
  const now = performance.now();
  switch (m.t) {
    case "welcome": {
      app.myId = m.id;
      app.sentSecret = m.secret || "";
      const draft = $("#secret").value.trim();
      if (m.secret) {
        $("#secret").value = m.secret;
      } else if (draft) {
        submitSecret();
      }
      renderWorkshop();
      break;
    }
    case "room":
      app.roomInfo = m;
      renderLobby();
      updateView();
      break;
    case "match":
      if (m.id !== app.match?.id) {
        renderer.newRound();
        app.brain.clear();
        app.result = null;
        app.showResult = false;
        $("#feed").innerHTML = "";
      }
      app.match = m;
      renderer.setMatch(m);
      renderer.myIds = new Set(m.tanks.filter((t) => t.owner === app.myId).map((t) => t.id));
      renderCommand();
      updateView();
      scheduleBoard();
      break;
    case "s":
      app.timeLeft = m.tl;
      renderer.pushSnapshot(m, now);
      for (const ev of m.ev) renderer.event(ev, now);
      renderer.applyTileChanges(m.tc);
      scheduleBoard();
      break;
    case "brain": {
      const b = app.brain.get(m.id) ?? {};
      Object.assign(b, { label: m.label, target: m.target });
      if (m.say) {
        b.say = m.say;
        b.sayAt = now;
        renderer.say(m.id, m.say, now);
        const t = tankMeta(m.id);
        if (t) pushFeed(`${t.name}：${m.say}`, "台词", "say");
      }
      app.brain.set(m.id, b);
      scheduleBoard();
      break;
    }
    case "order": {
      const b = app.brain.get(m.id) ?? {};
      b.label = m.label;
      app.brain.set(m.id, b);
      renderer.say(m.id, m.text, now, "order");
      const t = tankMeta(m.id);
      if (t) pushFeed(`${t.name} 收到指令：${m.text}`, "指令", "order");
      scheduleBoard();
      break;
    }
    case "cast":
      pushFeed(m.text, m.ai ? "AI 解说" : "解说", m.ai ? "" : "local");
      break;
    case "chat":
      pushFeed(`${m.from}：${m.text}`, "聊天", "say");
      break;
    case "notice":
      toast(m.text);
      break;
    case "over":
      app.result = m;
      app.showResult = true;
      renderResult();
      updateView();
      if (m.winner && renderer.myIds.has(m.winner)) sound.win();
      break;
  }
}

const tankMeta = (id) => app.match?.tanks.find((t) => t.id === id);
const me = () => app.roomInfo?.players.find((p) => p.id === app.myId);
const isHost = () => app.roomInfo?.hostId === app.myId;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function randomCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => a[Math.floor(Math.random() * a.length)]).join("");
}

function enterRoom(room) {
  if (!app.auth.user) return;
  sound.unlock();
  app.leaving = false;
  app.room = room.toUpperCase();
  Object.assign(app, { roomInfo: null, match: null, result: null, showResult: false, timeLeft: null, myId: null });
  app.brain.clear();
  renderer.newRound();
  $("#feed").innerHTML = "";
  $("#room-code").textContent = app.room;
  $("#share-link").value = shareUrl();
  const u = new URL(location.href);
  u.searchParams.set("room", app.room);
  history.replaceState(null, "", u);
  $("#home").classList.add("hidden");
  $("#room").classList.remove("hidden");
  renderLobby();
  updateView();
  connect();
}

function leaveRoom() {
  app.leaving = true;
  app.ws?.close();
  app.ws = null;
  const u = new URL(location.href);
  u.searchParams.delete("room");
  history.replaceState(null, "", u);
  $("#room").classList.add("hidden");
  $("#home").classList.remove("hidden");
}

function updateView() {
  const ph = app.roomInfo?.phase;
  const battle = ph === "countdown" || ph === "playing" || (ph === "over" && app.showResult && app.match);
  $("#lobby").classList.toggle("hidden", !!battle);
  $("#battle").classList.toggle("hidden", !battle);
  $("#result").classList.toggle("hidden", !(ph === "over" && app.showResult && app.result));
  renderTop();
}

function shareUrl() {
  return `${location.origin}/?room=${app.room}`;
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareUrl());
    toast("邀请链接已复制，发给好友即可加入");
  } catch {
    toast(shareUrl());
  }
}

let toastTimer = 0;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

// ---------------------------------------------------------------------------
// Google sign-in
// ---------------------------------------------------------------------------

const GOOGLE_ICON = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>`;
const LOGIN_ERRORS = { denied: "你取消了 Google 授权", state: "登录已过期，请重试", token: "Google 登录校验失败，请重试", google: "Google 返回了错误，请重试", disabled: "服务器还没有配置 Google 登录" };

const avatarImg = (url, cls = "") => (url ? `<img class="avatar ${cls}" src="${esc(url)}" alt="" referrerpolicy="no-referrer" loading="lazy" />` : "");
const loginUrl = () => `/auth/google?next=${encodeURIComponent(location.pathname + location.search)}`;

async function loadAuth() {
  try {
    const r = await fetch("/api/me", { credentials: "same-origin" });
    if (r.ok) app.auth = await r.json();
  } catch {}
  renderAuth();
}

async function logout() {
  try {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {}
  const u = new URL(location.href);
  u.searchParams.delete("room");
  location.href = u.pathname + u.search;
}

function renderAuth() {
  const { enabled, user } = app.auth;
  const box = $("#auth");
  $("#play").classList.toggle("hidden", !user);
  if (user) {
    box.innerHTML = `<div class="account">${avatarImg(user.picture)}<div class="who"><b>${esc(user.name)}</b><span>${esc(user.email)}</span></div>
      <button class="btn ghost" id="btn-logout">退出</button></div>`;
  } else if (enabled) {
    const room = new URLSearchParams(location.search).get("room");
    box.innerHTML = `<a class="btn google lg" id="btn-google" href="${loginUrl()}">${GOOGLE_ICON}使用 Google 登录</a>
      <p class="hint">${room ? `登录后加入房间 <b>${esc(room.toUpperCase())}</b>` : "登录后即可创建或加入房间"}</p>`;
  } else {
    box.innerHTML = `<p class="hint">服务器还没有配置 Google 登录，暂时无法进入游戏</p>`;
  }
  $("#btn-logout")?.addEventListener("click", logout);
  $("#btn-google")?.addEventListener("click", (e) => (e.currentTarget.href = loginUrl()));

  const chip = $("#me-chip");
  chip.innerHTML = user ? `<button class="chip" id="btn-me" title="${esc(user.email)} · 点击退出登录">${avatarImg(user.picture, "xs")}<span>${esc(user.name)}</span></button>` : "";
  $("#btn-me")?.addEventListener("click", () => confirm("退出 Google 登录？") && logout());
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function renderTop() {
  const info = app.roomInfo;
  const pill = $("#ai-pill");
  const st = info?.ai ?? "unknown";
  pill.querySelector(".dot").className = `dot ${st}`;
  pill.querySelector("span").textContent = { ok: "Workers AI 在线", down: "AI 离线 · 本地战术", unknown: "Workers AI" }[st];
  pill.title = info ? `大脑：${info.brainModel}\n解说：${info.castModel}` : "";

  const ph = info?.phase;
  const center = $("#top-center");
  if ((ph === "countdown" || ph === "playing") && app.match) {
    const tl = app.timeLeft ?? app.match.timeLimit;
    const low = tl <= 20 && ph === "playing";
    center.innerHTML = `<span class="timer ${low ? "low" : ""}">${Math.floor(tl / 60)}:${String(tl % 60).padStart(2, "0")}</span>`;
  } else if (ph === "over") {
    center.innerHTML = `<span class="phase-tag">本局结束</span>`;
  } else {
    center.innerHTML = info ? `<span class="phase-tag">备战中 · ${info.players.length}/${info.settings.maxTanks} 名指挥官</span>` : "";
  }
}

// ---------------------------------------------------------------------------
// Lobby: 秘籍工坊
// ---------------------------------------------------------------------------

function buildChips() {
  $("#chips").innerHTML = FRAGMENTS.map(
    ([group, list]) =>
      `<div class="chip-row"><span>${group}</span><div class="list">${list
        .map((f) => `<button class="frag" data-frag="${esc(f)}">${esc(f)}</button>`)
        .join("")}</div></div>`,
  ).join("");
  $("#chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-frag]");
    if (!b) return;
    toggleFragment(b.dataset.frag);
  });
}

function toggleFragment(frag) {
  const ta = $("#secret");
  let v = ta.value;
  if (v.includes(frag)) {
    v = v
      .replace(frag, "")
      .replace(/；{2,}/g, "；")
      .replace(/^；|；$/g, "")
      .trim();
  } else {
    v = v.trim();
    v = v ? `${v}${/[。；！？!?.,，]$/.test(v) ? "" : "；"}${frag}` : frag;
  }
  ta.value = v.slice(0, 300);
  onSecretInput();
}

function randomSecret() {
  const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
  const parts = [
    ...pick(FRAGMENTS[0][1], 1),
    ...pick(FRAGMENTS[1][1], 2),
    ...pick(FRAGMENTS[2][1], 1),
    ...pick(FRAGMENTS[4][1], 1),
    ...(Math.random() < 0.6 ? pick(FRAGMENTS[3][1], 1) : []),
  ];
  $("#secret").value = parts.join("；");
  onSecretInput();
}

function onSecretInput() {
  store.set("tank.secret", $("#secret").value);
  renderWorkshop();
}

function submitSecret() {
  const text = $("#secret").value.trim();
  if (text.length < 4) {
    toast("秘籍太短了，多写几句吧");
    return;
  }
  sound.unlock();
  app.sentSecret = text;
  send({ t: "secret", text });
  renderWorkshop();
}

function pipsHtml(points, bonusAttrs = {}) {
  return ATTRS.map(([k, label, fmt]) => {
    const p = points[k];
    const plus = bonusAttrs[k] ?? 0;
    const pips = Array.from({ length: 5 }, (_, i) => `<i class="${i < p - plus ? "on" : i < p ? "plus" : ""}"></i>`).join("");
    return `<div class="bar"><span>${label}</span><div class="pips">${pips}</div><span class="val">${fmt(p)}</span></div>`;
  }).join("");
}

function buildCard(build, { pending = false } = {}) {
  if (pending) {
    return `<div class="bcard pending"><div class="bcard-head"><span class="spinner"></span><span>鉴定师正在研读你的秘籍…</span></div></div>`;
  }
  if (!build) {
    return `<div class="bcard pending"><div class="bcard-head"><span class="btitle" style="color:var(--muted)">新兵坦克</span><span class="bbadge local">未鉴定</span></div>
      <p class="bcomment">还没有鉴定过的秘籍，将以均衡的新兵属性出战。</p></div>`;
  }
  const badges = [
    build.cheat ? `<span class="bbadge cheat">作弊被识破</span>` : build.bonus ? `<span class="bbadge bonus">秘籍加成 +${build.bonus}</span>` : `<span class="bbadge">无加成</span>`,
    build.ai ? `<span class="bbadge">Workers AI 鉴定</span>` : `<span class="bbadge local">本地估算</span>`,
  ].join("");
  return `<div class="bcard ${build.cheat ? "cheat" : ""}">
    <div class="bcard-head"><span class="btitle">「${esc(build.title)}」</span>${badges}</div>
    ${build.comment ? `<p class="bcomment">${esc(build.comment)}</p>` : ""}
    <div class="bars">${pipsHtml(build.points)}</div>
  </div>`;
}

function renderWorkshop() {
  const text = $("#secret").value;
  $("#secret-count").textContent = `${text.length}/300`;
  document.querySelectorAll("[data-frag]").forEach((b) => b.classList.toggle("used", text.includes(b.dataset.frag)));

  const mine = me();
  const appraising = mine?.appraising;
  const changed = text.trim() !== (app.sentSecret ?? "");
  const state = $("#secret-state");
  if (appraising) state.innerHTML = `<span class="spinner"></span> 鉴定中…`;
  else if (changed && text.trim()) state.innerHTML = `<span class="warn">秘籍有改动，重新鉴定后生效</span>`;
  else if (mine?.build) state.textContent = "已鉴定 ✓";
  else state.textContent = "";

  $("#btn-appraise").disabled = !!appraising || !text.trim() || (!changed && !!mine?.build);
  $("#btn-appraise").textContent = mine?.build && !changed ? "已鉴定" : "鉴定秘籍";
  $("#build").innerHTML = buildCard(mine?.build ?? null, { pending: appraising });
}

// ---------------------------------------------------------------------------
// Lobby: room panel
// ---------------------------------------------------------------------------

function tankIcon(color) {
  return `<svg class="tank-ico" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="1" y="2" width="4" height="13" rx="1" fill="${color}" opacity=".55"/><rect x="11" y="2" width="4" height="13" rx="1" fill="${color}" opacity=".55"/>
    <rect x="4" y="4" width="8" height="10" fill="${color}"/><rect x="7" y="0" width="2" height="8" fill="${color}"/><circle cx="8" cy="9" r="2.4" fill="rgba(0,0,0,.25)"/></svg>`;
}

function miniBars(points) {
  return `<div class="mini">${ATTRS.map(([k, label]) => `<i class="l${points[k]}" title="${label} ${points[k]}"></i>`).join("")}</div>`;
}

function renderLobby() {
  renderTop();
  renderWorkshop();
  const info = app.roomInfo;
  if (!info) {
    $("#settings").innerHTML = `<div class="muted"><span class="spinner"></span> 正在连接战场…</div>`;
    $("#seats").innerHTML = "";
    $("#start-area").innerHTML = "";
    return;
  }
  const host = isHost();
  const st = info.settings;
  const players = info.players;
  const npcSlots = Math.min(st.npcs, Math.max(0, st.maxTanks - players.length));
  const hostName = players.find((p) => p.id === info.hostId)?.name ?? info.spectators.find((p) => p.id === info.hostId)?.name;
  $("#host-hint").textContent = host ? "你是房主" : hostName ? `房主：${hostName}` : "";

  const dis = host ? "" : "disabled";
  $("#settings").innerHTML = `
    <div class="setting"><span class="lbl">坦克上限<small>玩家 + NPC，最多 ${info.maxTanksCap} 辆</small></span>
      <div class="stepper"><button ${dis} data-set="maxTanks" data-v="${st.maxTanks - 1}" ${st.maxTanks <= 2 ? "disabled" : ""}>−</button><b>${st.maxTanks}</b><button ${dis} data-set="maxTanks" data-v="${st.maxTanks + 1}" ${st.maxTanks >= info.maxTanksCap ? "disabled" : ""}>+</button></div></div>
    <div class="setting"><span class="lbl">NPC 坦克<small>${info.npcPool.length} 种 AI 人设随机登场</small></span>
      <div class="stepper"><button ${dis} data-set="npcs" data-v="${st.npcs - 1}" ${st.npcs <= 0 ? "disabled" : ""}>−</button><b>${st.npcs}</b><button ${dis} data-set="npcs" data-v="${st.npcs + 1}" ${st.npcs >= st.maxTanks - 1 ? "disabled" : ""}>+</button></div></div>
    <div class="setting"><span class="lbl">胜利条件<small>先达到击杀数者获胜，限时 3 分钟</small></span>
      <div class="seg">${info.killTargets.map((k) => `<button ${dis} data-set="killTarget" data-v="${k}" class="${st.killTarget === k ? "on" : ""}">${k}杀</button>`).join("")}</div></div>`;

  const seats = [];
  players.forEach((p, i) => {
    const c = COLORS[i];
    const you = p.id === app.myId;
    const crown = p.id === info.hostId ? `<span class="crown" title="房主">♛</span>` : "";
    const sub = p.appraising
      ? `<span class="spinner"></span> 鉴定中…`
      : p.build
        ? `<b>「${esc(p.build.title)}」</b>${p.build.cheat ? " 作弊被抓" : p.build.bonus ? ` +${p.build.bonus}` : ""}`
        : p.hasSecret
          ? "秘籍未鉴定"
          : "还没写秘籍";
    seats.push(`<div class="seat ${you ? "me" : ""}" style="--c:${c}">${tankIcon(c)}<div class="info">
      <span class="nm">${avatarImg(p.avatar, "sm")}${esc(p.name)}${crown}${you ? '<span class="tag-sm">你</span>' : ""}</span>
      <span class="sub">${sub}</span>${p.build ? miniBars(p.build.points) : ""}</div></div>`);
  });
  for (let i = 0; i < npcSlots; i++) {
    const c = COLORS[players.length + i];
    seats.push(`<div class="seat npc" style="--c:${c}">${tankIcon(c)}<div class="info">
      <span class="nm">NPC 坦克<span class="tag-sm npc">AI</span></span><span class="sub">开战时随机分配人设</span></div></div>`);
  }
  for (let i = players.length + npcSlots; i < st.maxTanks; i++) {
    seats.push(`<div class="seat empty" style="--c:${COLORS[i]}33">${tankIcon("#3a4766")}<div class="info">
      <span class="nm">空位</span><span class="sub">邀请好友加入</span></div></div>`);
  }
  $("#seats").innerHTML = seats.join("");

  const seated = !!me();
  let start = "";
  if (host) {
    const total = players.length + npcSlots;
    start = `<button class="btn primary lg" id="btn-start">${info.phase === "over" ? "再来一局" : "开战"}</button>
      <p>${total < 2 ? "人数不足，开战时会自动补 1 辆 NPC" : `${total} 辆坦克参战`}${!me()?.build ? " · 你的秘籍还没鉴定" : ""}</p>`;
  } else {
    start = `<p>${seated ? "等待房主开战，先把秘籍打磨好" : "房间已满，你正在观战，有空位时自动入座"}</p>`;
  }
  $("#start-area").innerHTML = start;
  $("#btn-start")?.addEventListener("click", () => {
    sound.unlock();
    send({ t: "start" });
  });
  $("#spectators").textContent = info.spectators.length ? `观战：${info.spectators.map((s) => s.name).join("、")}` : "";
}

// ---------------------------------------------------------------------------
// Battle: board, command panel, feed, result
// ---------------------------------------------------------------------------

let boardQueued = false;
function scheduleBoard() {
  if (boardQueued) return;
  boardQueued = true;
  setTimeout(() => {
    boardQueued = false;
    renderBoard();
    renderTop();
  }, 120);
}

function renderBoard() {
  const snap = renderer.latest();
  const m = app.match;
  if (!m) return;
  $("#goal").textContent = `先到 ${m.killTarget} 杀获胜`;
  const now = performance.now();
  const rows = m.tanks
    .map((t) => ({ t, s: snap?.tanks.get(t.id) }))
    .sort((a, b) => (b.s?.ki ?? 0) - (a.s?.ki ?? 0) || (a.s?.de ?? 0) - (b.s?.de ?? 0));
  $("#board").innerHTML = rows
    .map(({ t, s }) => {
      const c = COLORS[t.slot];
      const mine = t.owner === app.myId;
      const hp = s?.hp ?? t.maxHp;
      const alive = s ? s.a : 1;
      const b = app.brain.get(t.id) ?? {};
      const target = b.target ? tankMeta(b.target)?.name : "";
      const say = b.say && now - b.sayAt < 8000 ? `“${esc(b.say)}”` : target ? `→ ${esc(target)}` : "";
      const buffs = `${s?.sh ? '<span class="shield" title="护盾">◆</span>' : ""}${s?.rp ? '<span class="rapid" title="连射">⚡</span>' : ""}`;
      return `<div class="tcard ${mine ? "me" : ""} ${alive ? "" : "dead"}" style="--c:${c}">
        <span class="nm">${avatarImg(t.avatar, "xs")}${esc(t.name)}${t.npc ? '<span class="tag-sm npc">NPC</span>' : ""}${mine ? '<span class="tag-sm">你</span>' : ""} ${buffs}</span>
        <span class="k">${s?.ki ?? 0}<small>/${m.killTarget}</small></span>
        <span class="ttl">「${esc(t.title)}」</span>
        <div class="hpbar">${Array.from({ length: t.maxHp }, (_, i) => `<i class="${i < hp && alive ? "on" : ""}"></i>`).join("")}</div>
        <div class="think">${alive ? `<span class="mode">${esc(b.label ?? "思考中")}</span>` : `<span class="mode" style="color:var(--muted)">重生中</span>`}<span class="say">${say}</span></div>
      </div>`;
    })
    .join("");
}

function renderCommand() {
  const mine = app.match?.tanks.some((t) => t.owner === app.myId);
  $("#command").classList.toggle("hidden", !mine);
}

function buildOrders() {
  $("#orders").innerHTML = ORDERS.map(([k, emo, label], i) => `<button data-order="${k}" title="快捷键 ${i + 1}"><em>${emo}</em>${label}</button>`).join("");
  $("#orders").addEventListener("click", (e) => {
    const b = e.target.closest("[data-order]");
    if (b) issueOrder({ k: b.dataset.order });
  });
  $("#order-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#order-text").value.trim();
    if (!text) return;
    if (issueOrder({ text })) $("#order-text").value = "";
  });
}

function issueOrder(o) {
  const now = performance.now();
  if (now < app.orderReadyAt || app.roomInfo?.phase !== "playing") return false;
  app.orderReadyAt = now + ORDER_GAP;
  send({ t: "order", ...o });
  sound.beep();
  document.querySelectorAll("#orders button, #order-form button").forEach((b) => (b.disabled = true));
  const bar = $("#cooldown-bar");
  bar.style.transition = "none";
  bar.style.transform = "scaleX(0)";
  requestAnimationFrame(() => {
    bar.style.transition = `transform ${ORDER_GAP}ms linear`;
    bar.style.transform = "scaleX(1)";
  });
  setTimeout(() => document.querySelectorAll("#orders button, #order-form button").forEach((b) => (b.disabled = false)), ORDER_GAP);
  return true;
}

function pushFeed(text, src, cls = "") {
  const feed = $("#feed");
  const row = document.createElement("div");
  row.className = `cast ${cls}`;
  row.innerHTML = `<span class="src">${esc(src)}</span><span>${esc(text)}</span>`;
  feed.prepend(row);
  while (feed.children.length > 30) feed.lastChild.remove();
}

function renderResult() {
  const r = app.result;
  if (!r) return;
  const win = r.ranking.find((x) => x.id === r.winner);
  const youWin = win && renderer.myIds.has(win.id);
  const title = win ? (youWin ? "你的秘籍赢了！" : `${esc(win.name)} 获胜`) : "平局";
  const sub = youWin ? "AI 完美执行了你的作战意图" : win?.npc ? "NPC 笑到了最后，改改秘籍再来" : "秘籍已公开，看看对手是怎么写的";
  const ranks = r.ranking
    .map(
      (t, i) => `<div class="rank ${t.id === r.winner ? "win" : ""}" style="--c:${COLORS[t.slot]}">
        <span class="pos">#${i + 1}</span>
        <span class="who"><span class="sw"></span>${avatarImg(t.avatar, "xs")}${esc(t.name)} <span class="muted small">「${esc(t.title)}」</span>${t.npc ? '<span class="tag-sm npc">NPC</span>' : ""}</span>
        <span class="kd">${t.kills}K/${t.deaths}D</span>
        <details><summary>查看秘籍${t.bonus ? ` · 加成 +${t.bonus}` : ""}</summary><p>${t.secret ? esc(t.secret) : "（没有写秘籍）"}</p></details>
      </div>`,
    )
    .join("");
  $("#result").innerHTML = `<div class="result"><h2>${title}</h2><p class="sub">${sub}</p><div class="ranks">${ranks}</div>
    <div class="row"><button class="btn" id="btn-back">回到房间改秘籍</button>${isHost() ? '<button class="btn primary" id="btn-again">再来一局</button>' : ""}</div></div>`;
  $("#btn-back").addEventListener("click", () => {
    app.showResult = false;
    updateView();
  });
  $("#btn-again")?.addEventListener("click", () => send({ t: "start" }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!$("#battle").classList.contains("hidden")) renderer.draw(now, dt);
  requestAnimationFrame(frame);
}

async function boot() {
  $("#secret").value = store.get("tank.secret") || "";
  const params = new URLSearchParams(location.search);
  const roomParam = params.get("room");
  const loginError = params.get("login_error");
  if (loginError) {
    const u = new URL(location.href);
    u.searchParams.delete("login_error");
    history.replaceState(null, "", u);
    $("#home-err").textContent = LOGIN_ERRORS[loginError] ?? "登录失败";
    if (roomParam) setTimeout(() => toast(LOGIN_ERRORS[loginError] ?? "登录失败"), 300);
  }
  if (roomParam) $("#code").value = roomParam.toUpperCase();

  buildChips();
  buildOrders();

  $("#btn-create").addEventListener("click", () => enterRoom(randomCode()));
  const join = () => {
    const code = $("#code").value.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,16}$/.test(code)) {
      $("#home-err").textContent = "请输入有效的房间号";
      return;
    }
    $("#home-err").textContent = "";
    enterRoom(code);
  };
  $("#btn-join").addEventListener("click", join);
  $("#code").addEventListener("keydown", (e) => e.key === "Enter" && join());

  $("#secret").addEventListener("input", onSecretInput);
  $("#secret").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitSecret();
  });
  $("#btn-appraise").addEventListener("click", submitSecret);
  $("#btn-dice").addEventListener("click", randomSecret);
  $("#btn-clear").addEventListener("click", () => {
    $("#secret").value = "";
    onSecretInput();
  });

  $("#settings").addEventListener("click", (e) => {
    const b = e.target.closest("[data-set]");
    if (b && !b.disabled) send({ t: "settings", [b.dataset.set]: Number(b.dataset.v) });
  });

  $("#btn-copy").addEventListener("click", copyLink);
  $("#btn-share").addEventListener("click", copyLink);
  $("#btn-leave").addEventListener("click", leaveRoom);
  const mute = $("#btn-mute");
  const paintMute = () => {
    mute.textContent = sound.muted ? "✕" : "♪";
    mute.title = sound.muted ? "已静音" : "音效";
  };
  paintMute();
  mute.addEventListener("click", () => {
    sound.toggle();
    paintMute();
  });

  addEventListener("pointerdown", () => sound.unlock(), { once: true });
  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if ($("#battle").classList.contains("hidden")) return;
    const i = Number(e.key) - 1;
    if (i >= 0 && i < ORDERS.length && !$("#command").classList.contains("hidden")) issueOrder({ k: ORDERS[i][0] });
  });

  renderWorkshop();
  requestAnimationFrame(frame);
  await loadAuth();
  if (roomParam && app.auth.user) enterRoom(roomParam);
}

boot();
