import { DurableObject } from "cloudflare:workers";
import { AIConfig, BotController, MODE_LABEL, appraise, commentate } from "./ai";
import { USER_HEADER, decodeUserHeader } from "./auth";
import { COLS, Game, MAX_TANKS, ROWS, TILE, TIME_LIMIT, Tank } from "./game";
import { Build, DEFAULT_BUILD, NPCS, Points, localAppraise, toStats } from "./stats";

const TICK_MS = 1000 / 30;
const DT = 1 / 30;
const COUNTDOWN_MS = 3000;
const CAST_GAP_MS = 3500;
const AI_BACKOFF_MS = 30_000;
const APPRAISE_GAP_MS = 4000;
const ORDER_GAP_MS = 2500;
const MAX_SECRET = 300;
const KILL_TARGETS = [3, 5, 10];

type Phase = "lobby" | "countdown" | "playing" | "over";

/** A player identity that survives reconnects (keyed by a secret client token). */
interface Profile {
  id: string; // public id
  name: string;
  avatar: string; // Google profile picture
  secret: string; // the 秘籍 prompt
  build: Build | null;
  appraising: boolean;
  lastAppraiseAt: number;
  lastOrderAt: number;
}

interface Session {
  ws: WebSocket;
  profile: Profile;
  seated: boolean;
  joinedAt: number;
  replaced?: boolean;
}

interface Settings {
  maxTanks: number;
  npcs: number;
  killTarget: number;
}

interface TankMeta {
  owner: string | null; // profile id, null for NPCs
  avatar: string;
  title: string;
  secret: string;
  points: Points;
  bonus: number;
}

const clean = (raw: unknown, max: number) =>
  String(raw ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f<>]/g, "")
    .trim()
    .slice(0, max);

/**
 * One Durable Object instance per room. It owns the authoritative simulation,
 * runs the 30Hz game loop, drives every tank's AI brain and fans state out to
 * every connected WebSocket.
 */
export class GameRoom extends DurableObject<Env> {
  private sessions = new Map<WebSocket, Session>();
  private profiles = new Map<string, Profile>(); // by "g:<google sub>"
  private hostId: string | null = null;
  private settings: Settings = { maxTanks: 4, npcs: 2, killTarget: 5 };
  private phase: Phase = "lobby";
  private game: Game | null = null;
  private bots = new Map<string, BotController>();
  private meta = new Map<string, TankMeta>();
  private matchId = 0;
  private countdownUntil = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastStep = 0;
  private acc = 0;

  private aiStatus: "unknown" | "ok" | "down" = "unknown";
  private aiDownUntil = 0;
  private casting = false;
  private lastCastAt = 0;
  private pendingCast: { context: string; fallback: string } | null = null;
  private streaks = new Map<string, number>();
  private firstBlood = false;
  private lastResult: unknown = null;

  private get aiCfg(): AIConfig {
    return { ai: this.env.AI, brainModel: this.env.BRAIN_MODEL, castModel: this.env.CAST_MODEL };
  }

  private get thinkMs(): number {
    return Math.max(1000, Number(this.env.BRAIN_INTERVAL_MS) || 2500);
  }

  // ---- connections ---------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const url = new URL(request.url);

    // Players are keyed by their Google account, verified by the Worker.
    const user = decodeUserHeader(request.headers.get(USER_HEADER));
    if (!user) return new Response("Login required", { status: 401 });
    const token = `g:${user.sub}`;
    let profile = this.profiles.get(token);
    if (!profile) {
      profile = { id: crypto.randomUUID().slice(0, 8), name: "", avatar: "", secret: "", build: null, appraising: false, lastAppraiseAt: 0, lastOrderAt: 0 };
      this.profiles.set(token, profile);
    }
    profile.name = clean(user.name, 12) || profile.name || "指挥官";
    profile.avatar = /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//.test(user.picture) ? user.picture : "";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // Same player opened another tab / reconnected: the new socket takes over.
    const prev = [...this.sessions.values()].find((s) => s.profile === profile);
    const s: Session = { ws: server, profile, seated: false, joinedAt: Date.now() };
    if (prev) {
      prev.replaced = true;
      this.sessions.delete(prev.ws);
      try {
        prev.ws.close(4000, "replaced");
      } catch {}
      s.seated = prev.seated;
      s.joinedAt = prev.joinedAt;
    } else if (this.inMatch()) {
      s.seated = [...this.meta.values()].some((m) => m.owner === profile!.id);
    } else {
      s.seated = this.seated().length < this.settings.maxTanks;
    }
    this.sessions.set(server, s);
    if (!this.hostId || !this.sessionOf(this.hostId)) this.hostId = profile.id;

    server.addEventListener("message", (e) => this.onMessage(s, e.data));
    server.addEventListener("close", () => this.onClose(s));
    server.addEventListener("error", () => this.onClose(s));

    this.send(s, { t: "welcome", id: profile.id, secret: profile.secret, room: url.pathname.split("/").pop() });
    if (this.game) this.send(s, this.matchMessage());
    if (this.phase === "over" && this.lastResult) this.send(s, this.lastResult);
    this.broadcastRoom();
    this.ensureLoop();
    return new Response(null, { status: 101, webSocket: client });
  }

  private onMessage(s: Session, data: string | ArrayBuffer) {
    if (typeof data !== "string" || data.length > 4000) return;
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const isHost = s.profile.id === this.hostId;
    switch (msg.t) {
      case "secret":
        void this.onSecret(s, clean(msg.text, MAX_SECRET));
        break;
      case "settings":
        if (!isHost || this.inMatch()) return;
        this.applySettings(msg);
        break;
      case "start":
        if (!isHost || this.inMatch()) return;
        this.startMatch();
        break;
      case "order":
        this.onOrder(s, msg);
        break;
      case "chat": {
        const text = clean(msg.text, 60);
        if (text) this.broadcast({ t: "chat", from: s.profile.name, text });
        break;
      }
    }
  }

  private onClose(s: Session) {
    if (s.replaced || !this.sessions.delete(s.ws)) return;
    if (this.sessions.size === 0) {
      this.reset();
      return;
    }
    if (s.profile.id === this.hostId) {
      const next = [...this.sessions.values()].sort((a, b) => Number(b.seated) - Number(a.seated) || a.joinedAt - b.joinedAt)[0];
      this.hostId = next?.profile.id ?? null;
    }
    // Their tank keeps fighting on its 秘籍 — it's AI-driven anyway.
    if (!this.inMatch()) this.assignSeats();
    this.broadcastRoom();
  }

  private inMatch() {
    return this.phase === "countdown" || this.phase === "playing";
  }

  private seated() {
    return [...this.sessions.values()].filter((s) => s.seated).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  private sessionOf(profileId: string) {
    return [...this.sessions.values()].find((s) => s.profile.id === profileId);
  }

  /** Fill free seats with waiting spectators; drop the newest players if over the limit. */
  private assignSeats() {
    const seated = this.seated();
    for (const s of seated.slice(this.settings.maxTanks).reverse()) {
      if (s.profile.id !== this.hostId) s.seated = false;
    }
    const waiting = [...this.sessions.values()].filter((s) => !s.seated).sort((a, b) => a.joinedAt - b.joinedAt);
    let free = this.settings.maxTanks - this.seated().length;
    for (const s of waiting) {
      if (free-- <= 0) break;
      s.seated = true;
    }
  }

  private applySettings(msg: any) {
    const st = this.settings;
    if (msg.maxTanks !== undefined) st.maxTanks = Math.max(2, Math.min(MAX_TANKS, Number(msg.maxTanks) | 0));
    if (msg.npcs !== undefined) st.npcs = Math.max(0, Math.min(MAX_TANKS - 1, Number(msg.npcs) | 0));
    if (msg.killTarget !== undefined && KILL_TARGETS.includes(Number(msg.killTarget))) st.killTarget = Number(msg.killTarget);
    this.assignSeats();
    this.broadcastRoom();
  }

  private reset() {
    this.stopLoop();
    this.phase = "lobby";
    this.game = null;
    this.bots.clear();
    this.meta.clear();
    this.pendingCast = null;
    this.lastResult = null;
  }

  // ---- 秘籍 & orders -------------------------------------------------------

  private async onSecret(s: Session, text: string) {
    const p = s.profile;
    const now = Date.now();
    if (p.appraising) return;
    if (text === p.secret && p.build) return;
    if (now - p.lastAppraiseAt < APPRAISE_GAP_MS) {
      this.send(s, { t: "notice", text: "鉴定师忙不过来，请稍等几秒再提交" });
      return;
    }
    p.secret = text;
    if (!text) {
      p.build = null;
      this.broadcastRoom();
      return;
    }
    p.appraising = true;
    p.lastAppraiseAt = now;
    this.broadcastRoom();
    let build: Build;
    try {
      build = this.aiUsable() ? await appraise(this.aiCfg, text) : localAppraise(text);
      if (build.ai) this.setAiStatus("ok");
    } catch (err) {
      console.warn("appraise failed", String(err));
      this.markAiDown();
      build = localAppraise(text);
    }
    p.appraising = false;
    // Ignore a stale result if the player submitted something else meanwhile.
    if (p.secret === text) p.build = build;
    this.broadcastRoom();
  }

  private onOrder(s: Session, msg: any) {
    const g = this.game;
    if (!g || !this.inMatch()) return;
    const tankId = [...this.meta.entries()].find(([, m]) => m.owner === s.profile.id)?.[0];
    const bot = tankId ? this.bots.get(tankId) : undefined;
    if (!bot || !tankId) return;
    const now = Date.now();
    if (now - s.profile.lastOrderAt < ORDER_GAP_MS) return;
    s.profile.lastOrderAt = now;
    let text: string | null;
    if (msg.k) {
      text = bot.quickOrder(g, String(msg.k));
    } else {
      text = clean(msg.text, 40);
      if (text) bot.textOrder(g, text);
    }
    if (!text) return;
    this.broadcast({ t: "order", id: tankId, text, mode: bot.strategy.mode, label: MODE_LABEL[bot.strategy.mode] });
  }

  // ---- match lifecycle -----------------------------------------------------

  private startMatch() {
    const players = this.seated().slice(0, this.settings.maxTanks);
    if (!players.length) return;
    let npcCount = Math.min(this.settings.npcs, this.settings.maxTanks - players.length);
    if (players.length + npcCount < 2) npcCount = 1;

    const presets = [...NPCS].sort(() => Math.random() - 0.5);
    this.meta.clear();
    const specs = players.map((s, slot) => {
      const build = s.profile.build ?? DEFAULT_BUILD;
      const id = `t${slot}`;
      this.meta.set(id, { owner: s.profile.id, avatar: s.profile.avatar, title: build.title, secret: s.profile.secret, points: build.points, bonus: build.bonus });
      return { id, name: s.profile.name, slot, npc: false, stats: toStats(build.points) };
    });
    for (let i = 0; i < npcCount; i++) {
      const slot = players.length + i;
      const n = presets[i % presets.length];
      const id = `t${slot}`;
      this.meta.set(id, { owner: null, avatar: "", title: n.title, secret: n.secret, points: n.points, bonus: 0 });
      specs.push({ id, name: n.name, slot, npc: true, stats: toStats(n.points) });
    }

    this.game = new Game(specs, this.settings.killTarget);
    this.matchId++;
    this.bots.clear();
    for (const sp of specs) {
      const m = this.meta.get(sp.id)!;
      const bot = new BotController(sp.id, { name: sp.name, title: m.title, secret: m.secret }, (this.thinkMs / 1000) * (sp.npc ? 1.5 : 1));
      bot.strategy = bot.fallback(this.game);
      bot.nextThinkAt = 0.3 + Math.random() * 1.5;
      this.bots.set(sp.id, bot);
    }
    this.streaks.clear();
    this.firstBlood = false;
    this.lastResult = null;
    this.pendingCast = null;
    this.phase = "countdown";
    this.countdownUntil = Date.now() + COUNTDOWN_MS;

    this.broadcast(this.matchMessage());
    this.broadcastRoom();
    const roster = specs.map((p) => `${p.name}「${this.meta.get(p.id)!.title}」${p.npc ? "(NPC)" : ""}`).join("、");
    this.requestCast(`比赛即将开始！参赛坦克：${roster}。先拿 ${this.settings.killTarget} 杀者获胜，来一句热血的开场白。`, "秘籍已就位，坦克大战即将开打！", true);
  }

  private endMatch() {
    const g = this.game!;
    this.phase = "over";
    const ranking = g.ranking();
    const winner = g.winner();
    this.lastResult = {
      t: "over",
      winner: winner?.id ?? null,
      ranking: ranking.map((t) => {
        const m = this.meta.get(t.id)!;
        return { id: t.id, name: t.name, slot: t.slot, npc: t.npc, kills: t.kills, deaths: t.deaths, avatar: m.avatar, title: m.title, secret: m.secret, points: m.points, bonus: m.bonus };
      }),
    };
    this.broadcast(this.lastResult);
    this.assignSeats();
    this.broadcastRoom();
    const label = (t: Tank) => `${t.name}「${this.meta.get(t.id)?.title}」${t.npc ? "(NPC)" : ""}`;
    const board = ranking.map((t, i) => `第${i + 1}名 ${label(t)} ${t.kills}杀${t.deaths}死`).join("；");
    const ctx = winner
      ? `比赛结束！冠军是 ${label(winner)}。最终排名：${board}。来一句赛后总结。`
      : `比赛结束，打成平局！最终排名：${board}。来一句赛后总结。`;
    this.pendingCast = null;
    this.requestCast(ctx, winner ? `${winner.name} 的秘籍笑到了最后！` : "平局！秘籍难分高下！", true, true);
  }

  private matchMessage() {
    const g = this.game!;
    return {
      t: "match",
      id: this.matchId,
      cols: COLS,
      rows: ROWS,
      tile: TILE,
      killTarget: g.killTarget,
      timeLimit: TIME_LIMIT,
      tiles: Array.from(g.tiles).join(""),
      tanks: g.tanks.map((t) => {
        const m = this.meta.get(t.id)!;
        return { id: t.id, name: t.name, slot: t.slot, npc: t.npc, owner: m.owner, avatar: m.avatar, title: m.title, points: m.points, bonus: m.bonus, maxHp: t.stats.maxHp };
      }),
    };
  }

  // ---- loop ----------------------------------------------------------------

  private ensureLoop() {
    if (this.interval) return;
    this.lastStep = Date.now();
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  private stopLoop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private tick() {
    const now = Date.now();
    const g = this.game;

    if (this.pendingCast && !this.casting && now - this.lastCastAt >= CAST_GAP_MS) {
      const p = this.pendingCast;
      this.pendingCast = null;
      void this.doCast(p.context, p.fallback);
    }
    if (!g) return;

    if (this.phase === "countdown") {
      if (now >= this.countdownUntil) {
        this.phase = "playing";
        this.lastStep = now;
        this.acc = 0;
        this.broadcastRoom();
      }
      this.broadcastState();
      return;
    }
    if (this.phase !== "playing") return;

    this.acc += now - this.lastStep;
    this.lastStep = now;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 4) {
      for (const bot of this.bots.values()) bot.update(g, DT);
      g.step(DT);
      this.acc -= TICK_MS;
      steps++;
      if (g.over) break;
    }
    if (steps >= 4) this.acc = 0;
    if (!steps) return;

    this.thinkBots(g);
    this.broadcastState();
    if (g.over) this.endMatch();
  }

  private thinkBots(g: Game) {
    for (const bot of this.bots.values()) {
      if (bot.thinking || g.time < bot.nextThinkAt) continue;
      bot.nextThinkAt = g.time + bot.thinkEvery;
      if (!this.aiUsable()) {
        if (g.time >= bot.orderUntil) bot.strategy = bot.fallback(g);
        continue;
      }
      bot.thinking = true;
      bot
        .think(this.aiCfg, g)
        .then(({ say, ai }) => {
          if (ai) this.setAiStatus("ok");
          if (this.game !== g) return;
          const s = bot.strategy;
          this.broadcast({ t: "brain", id: bot.tankId, mode: s.mode, label: MODE_LABEL[s.mode], target: s.target, say });
        })
        .catch((err) => {
          console.warn("brain failed", String(err));
          this.markAiDown();
          if (g.time >= bot.orderUntil) bot.strategy = bot.fallback(g);
        })
        .finally(() => {
          bot.thinking = false;
        });
    }
  }

  private broadcastState() {
    const g = this.game!;
    for (const ev of g.events) if (ev.k === "kill") this.onKill(g, ev.killer, ev.victim);
    const cd = this.phase === "countdown" ? Math.max(0, (this.countdownUntil - Date.now()) / 1000) : 0;
    const msg = JSON.stringify({ t: "s", ph: this.phase, cd: Math.round(cd * 10) / 10, ...g.snapshot(), ev: g.events, tc: g.tileChanges });
    g.events = [];
    g.tileChanges = [];
    for (const s of this.sessions.values()) this.sendRaw(s, msg);
  }

  // ---- commentary ----------------------------------------------------------

  private onKill(g: Game, killerId: string, victimId: string) {
    const killer = g.tank(killerId);
    const victim = g.tank(victimId);
    if (!killer || !victim) return;
    const streak = (this.streaks.get(killer.id) ?? 0) + 1;
    this.streaks.set(killer.id, streak);
    this.streaks.set(victim.id, 0);

    const kb = this.bots.get(killer.id);
    const vb = this.bots.get(victim.id);
    if (kb) kb.memory = `你刚击毁了 ${victim.name}`;
    if (vb) {
      vb.memory = `你刚被 ${killer.name} 击毁，正在重生`;
      vb.nextThinkAt = Math.min(vb.nextThinkAt, g.time); // rethink right away
    }

    let tag = "";
    if (!this.firstBlood) {
      this.firstBlood = true;
      tag = "拿下一血！";
    } else if (streak >= 2) {
      tag = `${streak}连杀！`;
    }
    if (killer.kills === g.killTarget - 1) tag += "拿到赛点！";
    const label = (t: Tank) => `${t.name}「${this.meta.get(t.id)?.title}」${t.npc ? "(NPC)" : ""}`;
    const score = g.tanks.map((t) => `${t.name} ${t.kills}杀`).join("，");
    const ctx = `${label(killer)} 击毁了 ${label(victim)}。${tag} 当前战况：${score}。剩余 ${Math.round(g.timeLeft)} 秒。`;
    const templates = [
      `${killer.name} 一炮送走了 ${victim.name}！`,
      `${victim.name} 被 ${killer.name} 炸上了天！`,
      `漂亮！${killer.name} 击毁 ${victim.name}！`,
      `${victim.name} 的秘籍失灵了，凶手是 ${killer.name}！`,
    ];
    const fallback = tag ? `${tag}${killer.name} 击毁了 ${victim.name}！` : templates[Math.floor(Math.random() * templates.length)];
    this.requestCast(ctx, fallback, !!tag);
  }

  private requestCast(context: string, fallback: string, important = false, force = false) {
    if (!force && (this.casting || Date.now() - this.lastCastAt < CAST_GAP_MS)) {
      if (important || !this.pendingCast) this.pendingCast = { context, fallback };
      return;
    }
    void this.doCast(context, fallback);
  }

  private async doCast(context: string, fallback: string) {
    this.casting = true;
    this.lastCastAt = Date.now();
    let text: string | null = null;
    try {
      if (this.aiUsable()) {
        text = await commentate(this.aiCfg, context);
        if (text) this.setAiStatus("ok");
      }
    } catch (err) {
      console.warn("commentary failed", String(err));
      this.markAiDown();
    } finally {
      this.casting = false;
    }
    this.broadcast({ t: "cast", text: text ?? fallback, ai: !!text });
  }

  private aiUsable() {
    return Date.now() >= this.aiDownUntil;
  }

  private markAiDown() {
    this.aiDownUntil = Date.now() + AI_BACKOFF_MS;
    this.setAiStatus("down");
  }

  private setAiStatus(st: "ok" | "down") {
    if (this.aiStatus === st) return;
    this.aiStatus = st;
    this.broadcastRoom();
  }

  // ---- messaging -----------------------------------------------------------

  private broadcastRoom() {
    const all = [...this.sessions.values()];
    this.broadcast({
      t: "room",
      phase: this.phase,
      hostId: this.hostId,
      settings: this.settings,
      maxTanksCap: MAX_TANKS,
      killTargets: KILL_TARGETS,
      players: this.seated().map((s) => ({
        id: s.profile.id,
        name: s.profile.name,
        avatar: s.profile.avatar,
        build: s.profile.build,
        appraising: s.profile.appraising,
        hasSecret: !!s.profile.secret,
      })),
      spectators: all.filter((s) => !s.seated).map((s) => ({ id: s.profile.id, name: s.profile.name, avatar: s.profile.avatar })),
      npcPool: NPCS.map((n) => ({ name: n.name, title: n.title })),
      ai: this.aiStatus,
      brainModel: this.env.BRAIN_MODEL,
      castModel: this.env.CAST_MODEL,
    });
  }

  private broadcast(obj: unknown) {
    const msg = JSON.stringify(obj);
    for (const s of this.sessions.values()) this.sendRaw(s, msg);
  }

  private send(s: Session, obj: unknown) {
    this.sendRaw(s, JSON.stringify(obj));
  }

  private sendRaw(s: Session, msg: string) {
    try {
      s.ws.send(msg);
    } catch {
      this.onClose(s);
    }
  }
}
