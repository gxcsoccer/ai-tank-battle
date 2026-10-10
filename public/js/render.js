// Canvas renderer: tile layers, interpolated tanks/bullets, particles, bubbles.

export const COLORS = ["#f5c542", "#4cd964", "#ff5a5f", "#b07cff", "#4fd1ff", "#ff9f43", "#ff6bcb", "#d9e1ee"];
const T = { Empty: 0, Brick: 1, Steel: 2, Water: 3, Grass: 4 };
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const INTERP_DELAY = 100; // ms behind the server clock
const POWER_LABEL = { shield: "护盾", rapid: "连射", heal: "回血" };

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const f = (c) => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

export class Renderer {
  constructor(canvas, sound) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.sound = sound;
    this.S = 2; // canvas pixels per world unit
    this.meta = null;
    this.tiles = null;
    this.tileLayer = document.createElement("canvas");
    this.grassLayer = document.createElement("canvas");
    this.waterTiles = [];
    this.snaps = [];
    this.offset = null;
    this.particles = [];
    this.rings = [];
    this.floaters = [];
    this.killfeed = [];
    this.bubbles = new Map();
    this.treads = new Map();
    this.shake = 0;
    this.phase = "lobby";
    this.countdown = 0;
    this.goUntil = 0;
    this.myIds = new Set(); // tank ids controlled by this browser
  }

  // ---- state in ----------------------------------------------------------

  setMatch(m) {
    const fresh = !this.meta || this.meta.tilesStr !== m.tiles;
    this.meta = {
      cols: m.cols,
      rows: m.rows,
      tile: m.tile,
      W: m.cols * m.tile,
      H: m.rows * m.tile,
      tilesStr: m.tiles,
      tanks: new Map(m.tanks.map((t) => [t.id, t])),
    };
    if (fresh) {
      this.tiles = Uint8Array.from(m.tiles, (c) => c.charCodeAt(0) - 48);
      this.rebuildLayers();
    }
  }

  newRound() {
    this.snaps = [];
    this.offset = null;
    this.particles = [];
    this.rings = [];
    this.floaters = [];
    this.killfeed = [];
    this.bubbles.clear();
    this.meta = null;
  }

  rebuildLayers() {
    const { W, H, cols, rows } = this.meta;
    for (const c of [this.tileLayer, this.grassLayer]) {
      c.width = W * this.S;
      c.height = H * this.S;
    }
    this.waterTiles = [];
    for (let i = 0; i < cols * rows; i++) {
      this.redrawTile(i);
      if (this.tiles[i] === T.Water) this.waterTiles.push(i);
    }
  }

  redrawTile(i) {
    const { cols, tile } = this.meta;
    const x = (i % cols) * tile;
    const y = Math.floor(i / cols) * tile;
    const v = this.tiles[i];
    for (const layer of [this.tileLayer, this.grassLayer]) {
      const c = layer.getContext("2d");
      c.setTransform(this.S, 0, 0, this.S, 0, 0);
      c.clearRect(x, y, tile, tile);
    }
    const c = this.tileLayer.getContext("2d");
    if (v === T.Brick) drawBrick(c, x, y);
    else if (v === T.Steel) drawSteel(c, x, y);
    else if (v === T.Grass) drawGrass(this.grassLayer.getContext("2d"), x, y, i);
  }

  applyTileChanges(tc) {
    if (!tc || !this.tiles) return;
    for (let j = 0; j < tc.length; j += 2) {
      const i = tc[j];
      this.tiles[i] = tc[j + 1];
      this.redrawTile(i);
      const { cols, tile } = this.meta;
      this.burst((i % cols) * tile + 8, Math.floor(i / cols) * tile + 8, 5, ["#b8562a", "#6b2d12", "#d9794a"], 60, 2.5);
    }
  }

  pushSnapshot(s, now) {
    this.phase = s.ph;
    if (s.ph === "countdown") this.countdown = s.cd;
    if (this.prevPhase === "countdown" && s.ph === "playing") {
      this.goUntil = now + 900;
      this.sound.go();
    }
    if (s.ph === "countdown" && Math.ceil(s.cd) !== Math.ceil(this.lastCd ?? 99) && s.cd > 0) this.sound.beep();
    this.lastCd = s.cd;
    this.prevPhase = s.ph;

    const tm = s.tm * 1000;
    const last = this.snaps[this.snaps.length - 1];
    if (last && tm < last.tm) this.snaps = [];
    const sample = tm - now;
    if (this.offset === null || Math.abs(sample - this.offset) > 400) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.06;
    this.snaps.push({
      tm,
      tanks: new Map(s.k.map((k) => [k.i, k])),
      bullets: new Map(s.b.map((b) => [b.i, b])),
      powerups: s.p,
    });
    if (this.snaps.length > 40) this.snaps.shift();
  }

  event(ev, now) {
    const mine = (id) => this.myIds.has(id);
    switch (ev.k) {
      case "shot":
        this.rings.push({ x: ev.x, y: ev.y, r: 1, max: 7, life: 0.12, t: 0, color: "#fff6c2" });
        this.sound.shoot(mine(ev.o));
        break;
      case "spark":
        this.burst(ev.x, ev.y, 6, ["#ffffff", "#ffe08a"], 70, 1.5);
        break;
      case "hit":
        this.burst(ev.x, ev.y, 12, ["#ff5a5f", "#ffb347", "#fff"], 90, 2);
        this.rings.push({ x: ev.x, y: ev.y, r: 2, max: 12, life: 0.25, t: 0, color: "#ffb347" });
        if (mine(ev.id)) this.shake = Math.max(this.shake, 4);
        this.sound.hit();
        break;
      case "boom":
        this.burst(ev.x, ev.y, 40, ["#ffec8a", "#ffb347", "#ff5a2a", "#7a7a7a"], 150, 3.2);
        this.rings.push({ x: ev.x, y: ev.y, r: 4, max: 34, life: 0.45, t: 0, color: "#ffd27a" });
        this.shake = Math.max(this.shake, 7);
        this.sound.boom();
        break;
      case "kill": {
        const k = this.meta?.tanks.get(ev.killer);
        const v = this.meta?.tanks.get(ev.victim);
        if (k && v) this.killfeed.unshift({ k, v, until: now + 4500 });
        this.killfeed.length = Math.min(this.killfeed.length, 4);
        break;
      }
      case "spawn":
        break;
      case "power":
        this.rings.push({ x: ev.x, y: ev.y, r: 2, max: 18, life: 0.5, t: 0, color: "#9ff3d0" });
        break;
      case "pick": {
        const t = this.lastTanks?.get(ev.id);
        if (t) this.floaters.push({ x: t.x, y: t.y - 18, text: `+${POWER_LABEL[ev.type]}`, color: "#9ff3d0", t: 0, life: 1.2 });
        this.sound.pick();
        break;
      }
    }
  }

  say(id, text, now, kind = "say") {
    if (text) this.bubbles.set(id, { text: kind === "order" ? `📣 ${text}` : text, kind, until: now + (kind === "order" ? 3000 : 4200) });
  }

  burst(x, y, n, colors, speed, size) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0.3 + Math.random() * 0.5, t: 0,
        size: size * (0.5 + Math.random()),
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
  }

  // ---- interpolation -----------------------------------------------------

  sample(now) {
    const snaps = this.snaps;
    if (!snaps.length) return null;
    const rt = now + this.offset - INTERP_DELAY;
    let a = snaps[snaps.length - 1];
    let b = a;
    for (let i = snaps.length - 2; i >= 0; i--) {
      if (snaps[i].tm <= rt) {
        a = snaps[i];
        b = snaps[i + 1];
        break;
      }
      a = b = snaps[i];
    }
    const span = b.tm - a.tm;
    const f = span > 0 ? Math.max(0, Math.min(1, (rt - a.tm) / span)) : 1;
    const lerp = (p, q) => p + (q - p) * f;

    const tanks = new Map();
    for (const [id, tb] of b.tanks) {
      const ta = a.tanks.get(id);
      const jump = !ta || !ta.a || Math.abs(ta.x - tb.x) + Math.abs(ta.y - tb.y) > 24;
      tanks.set(id, jump ? { ...tb } : { ...tb, x: lerp(ta.x, tb.x), y: lerp(ta.y, tb.y) });
    }
    const bullets = [];
    for (const [id, bb] of b.bullets) {
      const ba = a.bullets.get(id);
      bullets.push(ba ? { ...bb, x: lerp(ba.x, bb.x), y: lerp(ba.y, bb.y) } : bb);
    }
    return { tanks, bullets, powerups: b.powerups };
  }

  /** Latest (non-interpolated) tank states, used by the HUD. */
  latest() {
    return this.snaps[this.snaps.length - 1] ?? null;
  }

  // ---- draw --------------------------------------------------------------

  draw(now, dt) {
    const c = this.ctx;
    const S = this.S;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "#070a12";
    c.fillRect(0, 0, this.cv.width, this.cv.height);
    if (!this.meta) return;
    const { W, H, tile } = this.meta;

    this.shake *= Math.pow(0.0015, dt);
    const sx = (Math.random() - 0.5) * this.shake;
    const sy = (Math.random() - 0.5) * this.shake;
    c.setTransform(S, 0, 0, S, sx * S, sy * S);

    // floor grid
    c.fillStyle = "#0b101c";
    c.fillRect(0, 0, W, H);
    c.fillStyle = "#0f1626";
    for (let x = 0; x < W; x += tile * 2) for (let y = 0; y < H; y += tile * 2) c.fillRect(x + 15.5, y + 15.5, 1, 1);

    // water (animated)
    const wt = now / 1000;
    for (const i of this.waterTiles) {
      if (this.tiles[i] !== T.Water) continue;
      const x = (i % this.meta.cols) * tile;
      const y = Math.floor(i / this.meta.cols) * tile;
      c.fillStyle = "#1d4fa8";
      c.fillRect(x, y, tile, tile);
      c.fillStyle = "#3c7be0";
      for (let r = 0; r < 3; r++) {
        const off = Math.floor((wt * 6 + r * 5 + (i % 3) * 3) % 16);
        c.fillRect(x + ((off + r * 6) % 12), y + 3 + r * 5, 4, 1);
      }
    }

    c.drawImage(this.tileLayer, 0, 0, W, H);

    const st = this.sample(now);
    if (st) {
      this.lastTanks = st.tanks;
      for (const p of st.powerups) drawPowerup(c, p, now);
      for (const b of st.bullets) drawBullet(c, b);
      for (const [id, t] of st.tanks) {
        if (!t.a) continue;
        const info = this.meta.tanks.get(id);
        if (!info) continue;
        const tr = this.treads.get(id) ?? { phase: 0, x: t.x, y: t.y };
        tr.phase += Math.abs(t.x - tr.x) + Math.abs(t.y - tr.y);
        tr.x = t.x;
        tr.y = t.y;
        this.treads.set(id, tr);
        drawTank(c, t, COLORS[info.slot], tr.phase, info.npc, now);
      }
    }

    c.drawImage(this.grassLayer, 0, 0, W, H);

    // Above the grass: your own tank shows as a ghost when hidden; shields and buffs are
    // drawn only for tanks that are visible, so they never give away a hidden enemy.
    if (st) {
      for (const [id, t] of st.tanks) {
        if (!t.a) continue;
        const info = this.meta.tanks.get(id);
        if (!info) continue;
        const mine = this.myIds.has(id);
        const covered = this.inGrass(t.x, t.y);
        if (covered && !mine) continue;
        if (covered) {
          c.globalAlpha = 0.5;
          drawTank(c, t, COLORS[info.slot], this.treads.get(id)?.phase ?? 0, info.npc, now);
          c.globalAlpha = 1;
        }
        drawBuffs(c, t, now);
      }
    }

    // particles & rings
    this.particles = this.particles.filter((p) => (p.t += dt) < p.life);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.9;
      p.vy *= 0.9;
      c.globalAlpha = 1 - p.t / p.life;
      c.fillStyle = p.color;
      c.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    this.rings = this.rings.filter((r) => (r.t += dt) < r.life);
    for (const r of this.rings) {
      const k = r.t / r.life;
      c.globalAlpha = 1 - k;
      c.strokeStyle = r.color;
      c.lineWidth = 2 * (1 - k) + 0.5;
      c.beginPath();
      c.arc(r.x, r.y, r.r + (r.max - r.r) * k, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;

    // labels, hp, bubbles (above grass, but hidden for enemies lurking in grass)
    if (st) {
      c.textAlign = "center";
      c.textBaseline = "alphabetic";
      for (const [id, t] of st.tanks) {
        if (!t.a) continue;
        const info = this.meta.tanks.get(id);
        if (!info) continue;
        const hidden = this.inGrass(t.x, t.y) && !this.myIds.has(id);
        if (!hidden) drawLabel(c, t, info, COLORS[info.slot], this.myIds.has(id), W);
        const bub = this.bubbles.get(id);
        if (bub && now < bub.until && !hidden) drawBubble(c, t.x, t.y < 40 ? t.y + 46 : t.y - 26, bub.text, W, bub.kind);
      }
    }

    this.floaters = this.floaters.filter((f) => (f.t += dt) < f.life);
    c.font = "bold 7px sans-serif";
    for (const f of this.floaters) {
      c.globalAlpha = 1 - f.t / f.life;
      c.fillStyle = f.color;
      c.fillText(f.text, f.x, f.y - f.t * 14);
    }
    c.globalAlpha = 1;

    // kill feed (top-right)
    c.setTransform(S, 0, 0, S, 0, 0);
    this.killfeed = this.killfeed.filter((k) => now < k.until);
    c.font = "bold 6.5px sans-serif";
    c.textAlign = "right";
    this.killfeed.forEach((k, i) => {
      const y = 12 + i * 11;
      const text = `${k.k.name}  ➜  ${k.v.name}`;
      const w = c.measureText(text).width + 10;
      c.fillStyle = "rgba(5,8,16,0.65)";
      c.fillRect(W - w - 4, y - 7.5, w, 10);
      c.fillStyle = COLORS[k.v.slot];
      c.fillText(k.v.name, W - 9, y);
      const vw = c.measureText(k.v.name).width;
      c.fillStyle = "#cfd6e6";
      c.fillText("  ➜  ", W - 9 - vw, y);
      const aw = c.measureText("  ➜  ").width;
      c.fillStyle = COLORS[k.k.slot];
      c.fillText(k.k.name, W - 9 - vw - aw, y);
    });

    // countdown / GO
    c.textAlign = "center";
    c.textBaseline = "middle";
    if (this.phase === "countdown" && this.countdown > 0) {
      const n = Math.ceil(this.countdown);
      const k = n - this.countdown;
      c.globalAlpha = 1 - k * 0.6;
      c.font = `${48 + k * 30}px "Press Start 2P", monospace`;
      c.fillStyle = "#000";
      c.fillText(String(n), W / 2 + 3, H / 2 + 3);
      c.fillStyle = "#f5c542";
      c.fillText(String(n), W / 2, H / 2);
      c.globalAlpha = 1;
    } else if (now < this.goUntil) {
      c.globalAlpha = Math.min(1, (this.goUntil - now) / 300);
      c.font = `40px "Press Start 2P", monospace`;
      c.fillStyle = "#000";
      c.fillText("GO!", W / 2 + 3, H / 2 + 3);
      c.fillStyle = "#4cd9a0";
      c.fillText("GO!", W / 2, H / 2);
      c.globalAlpha = 1;
    }
  }

  inGrass(x, y) {
    if (!this.tiles) return false;
    const { cols, tile } = this.meta;
    let g = 0;
    for (const [ox, oy] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
      const tx = Math.floor((x + ox) / tile);
      const ty = Math.floor((y + oy) / tile);
      if (this.tiles[ty * cols + tx] === T.Grass) g++;
    }
    return g >= 3;
  }
}

// ---- sprites ---------------------------------------------------------------

function drawBrick(c, x, y) {
  c.fillStyle = "#5a2610";
  c.fillRect(x, y, 16, 16);
  for (let r = 0; r < 4; r++) {
    const off = r % 2 ? 4 : 0;
    for (let bx = -off; bx < 16; bx += 8) {
      const x0 = Math.max(0, bx);
      const x1 = Math.min(16, bx + 7);
      if (x1 <= x0) continue;
      c.fillStyle = "#b8562a";
      c.fillRect(x + x0, y + r * 4, x1 - x0, 3);
      c.fillStyle = "#da7b4b";
      c.fillRect(x + x0, y + r * 4, x1 - x0, 1);
    }
  }
}

function drawSteel(c, x, y) {
  c.fillStyle = "#59636f";
  c.fillRect(x, y, 16, 16);
  c.fillStyle = "#aeb8c4";
  c.fillRect(x + 1, y + 1, 14, 14);
  c.fillStyle = "#7d8895";
  c.fillRect(x + 4, y + 4, 8, 8);
  c.fillStyle = "#e6edf5";
  c.fillRect(x + 1, y + 1, 14, 1);
  c.fillRect(x + 1, y + 1, 1, 14);
  c.fillStyle = "#c5cdd7";
  c.fillRect(x + 4, y + 4, 8, 1);
}

function drawGrass(c, x, y, seed) {
  // Fully opaque so nothing underneath leaks through.
  c.fillStyle = "#1f6b2e";
  c.fillRect(x, y, 16, 16);
  c.fillStyle = "#24793a";
  c.fillRect(x, y + 8, 16, 8);
  // A few leaf tufts on a jittered 2x2 grid instead of random speckle.
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  for (const [gx, gy] of [[2, 2], [10, 1], [3, 9], [11, 10]]) {
    const tx = x + gx + Math.floor(rnd() * 2);
    const ty = y + gy + Math.floor(rnd() * 2);
    c.fillStyle = "#3d9e4f";
    c.fillRect(tx, ty + 2, 1, 3);
    c.fillRect(tx + 2, ty + 1, 1, 4);
    c.fillRect(tx + 4, ty + 2, 1, 3);
    c.fillStyle = "#6fcf78";
    c.fillRect(tx + 2, ty, 1, 1);
  }
}

function drawTank(c, t, color, phase, npc, now) {
  c.save();
  c.translate(t.x, t.y);
  c.rotate((t.d * Math.PI) / 2);
  // treads
  c.fillStyle = shade(color, -0.6);
  c.fillRect(-13, -13, 7, 26);
  c.fillRect(6, -13, 7, 26);
  c.fillStyle = shade(color, -0.3);
  const p = Math.floor(phase / 1.5) % 5;
  for (let yy = -13 + ((5 - p) % 5); yy < 13; yy += 5) {
    c.fillRect(-13, yy, 7, 2);
    c.fillRect(6, yy, 7, 2);
  }
  // hull
  c.fillStyle = shade(color, -0.15);
  c.fillRect(-7, -10, 14, 21);
  c.fillStyle = color;
  c.fillRect(-6, -9, 12, 18);
  c.fillStyle = shade(color, 0.35);
  c.fillRect(-6, -9, 12, 2);
  // turret + barrel
  c.fillStyle = shade(color, -0.35);
  c.fillRect(-1.5, -16, 3, 13);
  c.fillStyle = shade(color, -0.1);
  c.beginPath();
  c.arc(0, 1, 5.5, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = shade(color, 0.3);
  c.fillRect(-2, -2, 2, 2);
  if (npc) {
    // antenna marks NPC tanks
    c.fillStyle = "#cfd6e6";
    c.fillRect(4, 3, 1, 7);
    c.fillStyle = Math.floor(now / 300) % 2 ? "#4cd9a0" : "#1e7a57";
    c.fillRect(3.5, 2, 2, 2);
  }
  c.restore();
}

function drawBuffs(c, t, now) {
  if (t.sh) {
    c.save();
    c.strokeStyle = `rgba(120, 230, 255, ${0.55 + 0.35 * Math.sin(now / 90)})`;
    c.lineWidth = 1.5;
    c.setLineDash([4, 3]);
    c.lineDashOffset = -now / 40;
    c.beginPath();
    c.arc(t.x, t.y, 18, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }
  if (t.rp && Math.random() < 0.4) {
    c.fillStyle = "#ffe08a";
    c.fillRect(t.x + (Math.random() - 0.5) * 26, t.y + (Math.random() - 0.5) * 26, 1.5, 1.5);
  }
}

function drawLabel(c, t, info, color, mine, W) {
  c.font = "bold 6px sans-serif";
  const name = mine ? `▼ ${info.name}` : info.name;
  const half = c.measureText(name).width / 2;
  // Near the top edge, put the label under the tank instead.
  const below = t.y < 26;
  const ly = below ? t.y + 25 : t.y - 21;
  const py = below ? t.y + 16 : t.y - 18;
  const lx = Math.max(half + 1, Math.min(W - half - 1, t.x));
  c.fillStyle = "rgba(0,0,0,0.6)";
  c.fillText(name, lx + 0.5, ly + 0.5);
  c.fillStyle = mine ? "#fff" : color;
  c.fillText(name, lx, ly);
  const n = info.maxHp || 3;
  const w = (18 - (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    c.fillStyle = i < t.hp ? "#ff5a5f" : "rgba(255,255,255,0.18)";
    c.fillRect(t.x - 9 + i * (w + 1), py, w, 2);
  }
}

function drawBubble(c, x, y, text, W, kind) {
  c.font = "bold 7px sans-serif";
  const w = Math.min(160, c.measureText(text).width + 10);
  const h = 12;
  let bx = Math.max(2, Math.min(W - w - 2, x - w / 2));
  const by = Math.max(2, y - h - 4);
  c.fillStyle = kind === "order" ? "#f5c542" : "#fff";
  c.beginPath();
  c.roundRect(bx, by, w, h, 3);
  c.fill();
  c.beginPath();
  c.moveTo(x - 3, by + h);
  c.lineTo(x + 3, by + h);
  c.lineTo(x, by + h + 4);
  c.fill();
  c.fillStyle = "#111";
  c.textAlign = "left";
  c.textBaseline = "middle";
  c.fillText(text, bx + 5, by + h / 2 + 0.5, w - 10);
  c.textAlign = "center";
  c.textBaseline = "alphabetic";
}

function drawBullet(c, b) {
  c.fillStyle = "rgba(255, 220, 120, 0.35)";
  c.fillRect(b.x - DX[b.d] * 6 - 1.5, b.y - DY[b.d] * 6 - 1.5, 3, 3);
  c.fillStyle = "#fff6c2";
  c.fillRect(b.x - 2, b.y - 2, 4, 4);
  c.fillStyle = "#ffffff";
  c.fillRect(b.x - 1, b.y - 1, 2, 2);
}

function drawPowerup(c, p, now) {
  if (p.e && Math.floor(now / 150) % 2) return;
  const bob = Math.sin(now / 250 + p.i) * 1.5;
  const x = p.x;
  const y = p.y + bob;
  c.fillStyle = "rgba(0,0,0,0.35)";
  c.fillRect(x - 7, p.y + 8, 14, 2);
  c.fillStyle = "#0b1426";
  c.strokeStyle = p.t === "shield" ? "#78e6ff" : p.t === "rapid" ? "#ffd84a" : "#ff6b6b";
  c.lineWidth = 1.5;
  c.beginPath();
  c.roundRect(x - 8, y - 8, 16, 16, 3);
  c.fill();
  c.stroke();
  c.fillStyle = c.strokeStyle;
  c.beginPath();
  if (p.t === "shield") {
    c.moveTo(x, y - 5);
    c.lineTo(x + 5, y - 3);
    c.lineTo(x + 4, y + 2);
    c.lineTo(x, y + 5);
    c.lineTo(x - 4, y + 2);
    c.lineTo(x - 5, y - 3);
  } else if (p.t === "rapid") {
    c.moveTo(x + 1, y - 6);
    c.lineTo(x - 4, y + 1);
    c.lineTo(x - 0.5, y + 1);
    c.lineTo(x - 1.5, y + 6);
    c.lineTo(x + 4, y - 1);
    c.lineTo(x + 0.5, y - 1);
  } else {
    c.rect(x - 1.5, y - 5, 3, 10);
    c.rect(x - 5, y - 1.5, 10, 3);
  }
  c.fill();
}
