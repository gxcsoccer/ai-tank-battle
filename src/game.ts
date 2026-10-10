// Authoritative, deterministic-ish tank battle simulation. Pure TS, no Workers APIs,
// so it can run inside the Durable Object and in a local headless sim script.

import type { TankStats } from "./stats";

export const TILE = 16;
export const COLS = 32;
export const ROWS = 22;
export const WORLD_W = COLS * TILE; // 512
export const WORLD_H = ROWS * TILE; // 352

export const TANK_HALF = 13;
export const BULLET_HALF = 2;
export const MAX_TANKS = 8;
export const TIME_LIMIT = 180;
export const RESPAWN_TIME = 2.5;
export const SPAWN_SHIELD = 2.5;
export const POWERUP_INTERVAL = 11;
export const POWERUP_TTL = 15;
export const SHIELD_TIME = 6;
export const RAPID_TIME = 10;

export const T = { Empty: 0, Brick: 1, Steel: 2, Water: 3, Grass: 4 } as const;

// Directions: 0 up, 1 right, 2 down, 3 left
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

// Spawn points by slot: four corners first (0/1 are opposite), then edge midpoints.
export const SPAWNS = [
  { x: 16, y: 16, dir: 1 },
  { x: WORLD_W - 16, y: WORLD_H - 16, dir: 3 },
  { x: WORLD_W - 16, y: 16, dir: 3 },
  { x: 16, y: WORLD_H - 16, dir: 1 },
  { x: WORLD_W / 2, y: 16, dir: 2 },
  { x: WORLD_W / 2, y: WORLD_H - 16, dir: 0 },
  { x: 16, y: WORLD_H / 2, dir: 1 },
  { x: WORLD_W - 16, y: WORLD_H / 2, dir: 3 },
];

export type PowerType = "shield" | "rapid" | "heal";
const POWER_TYPES: PowerType[] = ["shield", "rapid", "heal"];

export interface Input {
  dir: number; // -1 = idle, 0..3 = move in direction
  fire: boolean;
  face?: number; // turn in place without moving
  dist?: number; // cap on distance moved this tick (lets the AI stop exactly on a waypoint)
}

export interface PlayerSpec {
  id: string;
  name: string;
  slot: number;
  npc: boolean;
  stats: TankStats;
}

export interface Tank extends PlayerSpec {
  x: number;
  y: number;
  dir: number;
  moving: boolean;
  hp: number;
  alive: boolean;
  respawnAt: number;
  shieldUntil: number;
  rapidUntil: number;
  cooldown: number;
  kills: number;
  deaths: number;
  input: Input;
}

export interface Bullet {
  id: number;
  owner: string;
  x: number;
  y: number;
  dir: number;
  speed: number;
  damage: number;
  dead: boolean;
}

export interface PowerUp {
  id: number;
  type: PowerType;
  x: number;
  y: number;
  expires: number;
  dead?: boolean;
}

export type GameEvent =
  | { k: "shot"; x: number; y: number; o: string }
  | { k: "spark"; x: number; y: number }
  | { k: "hit"; x: number; y: number; id: string }
  | { k: "boom"; x: number; y: number }
  | { k: "kill"; killer: string; victim: string }
  | { k: "spawn"; id: string }
  | { k: "power"; x: number; y: number; type: PowerType }
  | { k: "pick"; id: string; type: PowerType };

const r1 = (n: number) => Math.round(n * 10) / 10;
const isSolid = (v: number) => v === T.Brick || v === T.Steel || v === T.Water;

// ---------------------------------------------------------------------------
// Navigation helpers (shared with the bot AI)
// A nav node (nx, ny) is a tank center at (nx*TILE, ny*TILE); the tank then
// covers tiles nx-1..nx × ny-1..ny.
// ---------------------------------------------------------------------------

export const NODE_W = COLS + 1;
export const NODE_COUNT = NODE_W * (ROWS + 1);

/** -1 if a tank can never stand here, otherwise the number of brick tiles in the way. */
export function nodeInfo(tiles: Uint8Array, nx: number, ny: number): number {
  if (nx < 1 || ny < 1 || nx > COLS - 1 || ny > ROWS - 1) return -1;
  let bricks = 0;
  for (let ty = ny - 1; ty <= ny; ty++) {
    for (let tx = nx - 1; tx <= nx; tx++) {
      const v = tiles[ty * COLS + tx];
      if (v === T.Steel || v === T.Water) return -1;
      if (v === T.Brick) bricks++;
    }
  }
  return bricks;
}

export function tileAt(tiles: Uint8Array, x: number, y: number): number {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return T.Steel;
  return tiles[ty * COLS + tx];
}

function reachable(tiles: Uint8Array, from: [number, number]): Uint8Array {
  const seen = new Uint8Array(NODE_COUNT);
  const queue = [from[1] * NODE_W + from[0]];
  seen[queue[0]] = 1;
  while (queue.length) {
    const u = queue.pop()!;
    const ux = u % NODE_W;
    const uy = (u / NODE_W) | 0;
    for (let k = 0; k < 4; k++) {
      const vx = ux + DX[k];
      const vy = uy + DY[k];
      if (nodeInfo(tiles, vx, vy) < 0) continue;
      const v = vy * NODE_W + vx;
      if (!seen[v]) {
        seen[v] = 1;
        queue.push(v);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Map generation: random wall segments in one quadrant, mirrored to all four
// so every spawn corner is equally fair.
// ---------------------------------------------------------------------------

export function generateMap(rand: () => number = Math.random): Uint8Array {
  const QX = COLS / 2;
  const QY = ROWS / 2;
  for (let attempt = 0; attempt < 200; attempt++) {
    const tiles = new Uint8Array(COLS * ROWS);
    const set = (x: number, y: number, v: number) => {
      if (x < 0 || y < 0 || x >= QX || y >= QY) return;
      tiles[y * COLS + x] = v;
      tiles[y * COLS + (COLS - 1 - x)] = v;
      tiles[(ROWS - 1 - y) * COLS + x] = v;
      tiles[(ROWS - 1 - y) * COLS + (COLS - 1 - x)] = v;
    };

    const segments = 10 + Math.floor(rand() * 5);
    for (let i = 0; i < segments; i++) {
      const r = rand();
      const type = r < 0.56 ? T.Brick : r < 0.7 ? T.Steel : r < 0.82 ? T.Water : T.Grass;
      const horizontal = rand() < 0.5;
      const len = 1 + Math.floor(rand() * (type === T.Steel ? 2 : 4)); // blocks
      const thick = rand() < 0.35 ? 1 : 2; // tiles
      const x0 = Math.floor(rand() * 8) * 2;
      const y0 = Math.floor(rand() * 6) * 2;
      const w = horizontal ? len * 2 : thick;
      const h = horizontal ? thick : len * 2;
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) set(x0 + dx, y0 + dy, type);
    }
    // Keep every spawn area clear (corner, top-middle and left-middle in the quadrant).
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) set(x, y, T.Empty);
    for (let y = 0; y < 4; y++) for (let x = QX - 3; x < QX; x++) set(x, y, T.Empty);
    for (let y = QY - 3; y < QY; y++) for (let x = 0; x < 4; x++) set(x, y, T.Empty);

    let open = 0;
    for (const v of tiles) if (v === T.Empty || v === T.Grass) open++;
    if (open < tiles.length * 0.55) continue;

    const seen = reachable(tiles, [1, 1]);
    const ok = SPAWNS.every((s) => seen[(s.y / TILE) * NODE_W + s.x / TILE]);
    if (ok) return tiles;
  }
  return new Uint8Array(COLS * ROWS);
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

export class Game {
  tiles: Uint8Array;
  tanks: Tank[];
  bullets: Bullet[] = [];
  powerups: PowerUp[] = [];
  time = 0;
  over = false;
  events: GameEvent[] = [];
  tileChanges: number[] = []; // flat [index, value, index, value, ...]
  private nextId = 1;
  private nextPowerAt = 8;

  constructor(
    players: PlayerSpec[],
    public killTarget = 5,
    tiles: Uint8Array = generateMap(),
  ) {
    this.tiles = tiles;
    this.tanks = players.map((p) => {
      const sp = SPAWNS[p.slot];
      return {
        ...p,
        x: sp.x,
        y: sp.y,
        dir: sp.dir,
        moving: false,
        hp: p.stats.maxHp,
        alive: true,
        respawnAt: 0,
        shieldUntil: SPAWN_SHIELD,
        rapidUntil: 0,
        cooldown: 0,
        kills: 0,
        deaths: 0,
        input: { dir: -1, fire: false },
      };
    });
  }

  tank(id: string): Tank | undefined {
    return this.tanks.find((t) => t.id === id);
  }

  get timeLeft(): number {
    return Math.max(0, TIME_LIMIT - this.time);
  }

  step(dt: number): void {
    if (this.over) return;
    this.time += dt;
    for (const t of this.tanks) this.updateTank(t, dt);
    this.updateBullets(dt);
    this.updatePowerups();
    if (this.tanks.some((t) => t.kills >= this.killTarget) || this.time >= TIME_LIMIT) this.over = true;
  }

  /** Sorted by kills desc, then deaths asc. */
  ranking(): Tank[] {
    return [...this.tanks].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }

  /** Winner tank, or null on a draw. */
  winner(): Tank | null {
    const [a, b] = this.ranking();
    if (!a) return null;
    if (b && a.kills === b.kills && a.deaths === b.deaths) return null;
    return a;
  }

  // ---- tanks ---------------------------------------------------------------

  blocked(t: Tank, x: number, y: number): boolean {
    const l = x - TANK_HALF;
    const r = x + TANK_HALF;
    const top = y - TANK_HALF;
    const b = y + TANK_HALF;
    if (l < 0 || top < 0 || r > WORLD_W || b > WORLD_H) return true;
    const tx0 = Math.floor(l / TILE);
    const tx1 = Math.floor((r - 0.001) / TILE);
    const ty0 = Math.floor(top / TILE);
    const ty1 = Math.floor((b - 0.001) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (isSolid(this.tiles[ty * COLS + tx])) return true;
      }
    }
    const S = TANK_HALF * 2;
    for (const o of this.tanks) {
      if (o === t || !o.alive) continue;
      if (Math.abs(x - o.x) < S && Math.abs(y - o.y) < S) {
        // Allow separating if already overlapping (e.g. respawn on top of someone).
        const before = Math.abs(t.x - o.x) < S && Math.abs(t.y - o.y) < S;
        if (!before) return true;
      }
    }
    return false;
  }

  private updateTank(t: Tank, dt: number) {
    if (!t.alive) {
      if (this.time >= t.respawnAt) this.respawn(t);
      return;
    }
    t.cooldown = Math.max(0, t.cooldown - dt);
    const { dir, fire, face, dist } = t.input;
    t.moving = false;
    if (dir >= 0 && dir <= 3) {
      this.turn(t, dir);
      const step = t.stats.speed * dt;
      t.moving = this.move(t, dist !== undefined ? Math.min(step, Math.max(0, dist)) : step) > 0;
    } else if (face !== undefined && face >= 0 && face <= 3) {
      t.dir = face;
    }
    if (fire) this.fire(t);
  }

  private turn(t: Tank, dir: number) {
    if (dir === t.dir) return;
    // Classic grid assist: snap the cross axis to a half-tile when turning 90°.
    if (dir % 2 !== t.dir % 2) {
      if (dir % 2 === 0) {
        const sx = Math.round(t.x / 8) * 8;
        if (!this.blocked(t, sx, t.y)) t.x = sx;
      } else {
        const sy = Math.round(t.y / 8) * 8;
        if (!this.blocked(t, t.x, sy)) t.y = sy;
      }
    }
    t.dir = dir;
  }

  private move(t: Tank, dist: number): number {
    if (dist <= 0) return 0;
    const steps = Math.max(1, Math.ceil(dist));
    const per = dist / steps;
    let moved = 0;
    for (let i = 0; i < steps; i++) {
      const nx = t.x + DX[t.dir] * per;
      const ny = t.y + DY[t.dir] * per;
      if (this.blocked(t, nx, ny)) break;
      t.x = nx;
      t.y = ny;
      moved += per;
    }
    return moved;
  }

  private fire(t: Tank) {
    if (t.cooldown > 0) return;
    const rapid = this.time < t.rapidUntil;
    let mine = 0;
    for (const b of this.bullets) if (b.owner === t.id) mine++;
    if (mine >= t.stats.maxBullets + (rapid ? 1 : 0)) return;
    t.cooldown = t.stats.cooldown * (rapid ? 0.5 : 1);
    const x = t.x + DX[t.dir] * TANK_HALF;
    const y = t.y + DY[t.dir] * TANK_HALF;
    this.bullets.push({
      id: this.nextId++,
      owner: t.id,
      x,
      y,
      dir: t.dir,
      speed: t.stats.bulletSpeed * (rapid ? 1.25 : 1),
      damage: Math.random() < t.stats.crit ? 2 : 1,
      dead: false,
    });
    this.events.push({ k: "shot", x: r1(x), y: r1(y), o: t.id });
  }

  private respawn(t: Tank) {
    const order = [t.slot, ...SPAWNS.keys()];
    let sp = SPAWNS[t.slot];
    for (const s of order) {
      const cand = SPAWNS[s];
      const clear = this.tanks.every(
        (o) => o === t || !o.alive || Math.abs(o.x - cand.x) >= TANK_HALF * 2 || Math.abs(o.y - cand.y) >= TANK_HALF * 2,
      );
      if (clear) {
        sp = cand;
        break;
      }
    }
    Object.assign(t, {
      x: sp.x,
      y: sp.y,
      dir: sp.dir,
      hp: t.stats.maxHp,
      alive: true,
      cooldown: 0.3,
      shieldUntil: this.time + SPAWN_SHIELD,
    });
    this.events.push({ k: "spawn", id: t.id });
  }

  private kill(t: Tank, by: string) {
    t.alive = false;
    t.hp = 0;
    t.deaths++;
    t.rapidUntil = 0;
    t.respawnAt = this.time + RESPAWN_TIME;
    const killer = this.tank(by);
    if (killer && killer !== t) killer.kills++;
    this.events.push({ k: "boom", x: r1(t.x), y: r1(t.y) });
    this.events.push({ k: "kill", killer: by, victim: t.id });
  }

  // ---- bullets -------------------------------------------------------------

  private updateBullets(dt: number) {
    for (const b of this.bullets) {
      if (b.dead) continue;
      const dist = b.speed * dt;
      const steps = Math.ceil(dist / 2);
      const per = dist / steps;
      for (let s = 0; s < steps && !b.dead; s++) {
        b.x += DX[b.dir] * per;
        b.y += DY[b.dir] * per;
        this.bulletCollide(b);
      }
    }
    this.bullets = this.bullets.filter((b) => !b.dead);
  }

  private bulletCollide(b: Bullet) {
    const H = BULLET_HALF;
    if (b.x < 0 || b.y < 0 || b.x > WORLD_W || b.y > WORLD_H) {
      b.dead = true;
      this.events.push({ k: "spark", x: r1(b.x), y: r1(b.y) });
      return;
    }

    const tx0 = Math.max(0, Math.floor((b.x - H) / TILE));
    const tx1 = Math.min(COLS - 1, Math.floor((b.x + H - 0.001) / TILE));
    const ty0 = Math.max(0, Math.floor((b.y - H) / TILE));
    const ty1 = Math.min(ROWS - 1, Math.floor((b.y + H - 0.001) / TILE));
    const bricks: [number, number][] = [];
    let steel = false;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const v = this.tiles[ty * COLS + tx];
        if (v === T.Steel) steel = true;
        else if (v === T.Brick) bricks.push([tx, ty]);
      }
    }
    if (bricks.length || steel) {
      for (const [tx, ty] of bricks) this.breakBricks(b, tx, ty);
      b.dead = true;
      this.events.push({ k: "spark", x: r1(b.x), y: r1(b.y) });
      return;
    }

    for (const t of this.tanks) {
      if (!t.alive || t.id === b.owner) continue;
      if (Math.abs(b.x - t.x) < TANK_HALF + H && Math.abs(b.y - t.y) < TANK_HALF + H) {
        b.dead = true;
        this.hitTank(t, b);
        return;
      }
    }

    for (const o of this.bullets) {
      if (o === b || o.dead || o.owner === b.owner) continue;
      if (Math.abs(o.x - b.x) < H * 2 + 1 && Math.abs(o.y - b.y) < H * 2 + 1) {
        b.dead = o.dead = true;
        this.events.push({ k: "spark", x: r1(b.x), y: r1(b.y) });
        return;
      }
    }
  }

  /** A shell blasts a half-tank-wide swath of bricks across its path. */
  private breakBricks(b: Bullet, tx: number, ty: number) {
    if (b.dir % 2 === 0) {
      const a = Math.max(0, Math.floor((b.x - 8) / TILE));
      const z = Math.min(COLS - 1, Math.floor((b.x + 8 - 0.001) / TILE));
      for (let x = a; x <= z; x++) this.clearBrick(x, ty);
    } else {
      const a = Math.max(0, Math.floor((b.y - 8) / TILE));
      const z = Math.min(ROWS - 1, Math.floor((b.y + 8 - 0.001) / TILE));
      for (let y = a; y <= z; y++) this.clearBrick(tx, y);
    }
  }

  private clearBrick(tx: number, ty: number) {
    const i = ty * COLS + tx;
    if (this.tiles[i] !== T.Brick) return;
    this.tiles[i] = T.Empty;
    this.tileChanges.push(i, T.Empty);
  }

  private hitTank(t: Tank, b: Bullet) {
    if (this.time < t.shieldUntil) {
      this.events.push({ k: "spark", x: r1(b.x), y: r1(b.y) });
      return;
    }
    t.hp -= b.damage;
    this.events.push({ k: "hit", x: r1(b.x), y: r1(b.y), id: t.id });
    if (t.hp <= 0) this.kill(t, b.owner);
  }

  // ---- power-ups -----------------------------------------------------------

  private updatePowerups() {
    for (const p of this.powerups) {
      if (this.time > p.expires) {
        p.dead = true;
        continue;
      }
      for (const t of this.tanks) {
        if (!t.alive) continue;
        if (Math.abs(t.x - p.x) < TANK_HALF + 7 && Math.abs(t.y - p.y) < TANK_HALF + 7) {
          if (p.type === "shield") t.shieldUntil = Math.max(t.shieldUntil, this.time + SHIELD_TIME);
          else if (p.type === "rapid") t.rapidUntil = this.time + RAPID_TIME;
          else t.hp = t.stats.maxHp;
          p.dead = true;
          this.events.push({ k: "pick", id: t.id, type: p.type });
          break;
        }
      }
    }
    this.powerups = this.powerups.filter((p) => !p.dead);

    if (this.time >= this.nextPowerAt) {
      this.nextPowerAt = this.time + POWERUP_INTERVAL;
      if (this.powerups.length < 2 + Math.floor(this.tanks.length / 4)) this.spawnPowerup();
    }
  }

  private spawnPowerup() {
    for (let attempt = 0; attempt < 40; attempt++) {
      const bx = Math.floor(Math.random() * (COLS / 2));
      const by = Math.floor(Math.random() * (ROWS / 2));
      const x = bx * 32 + 16;
      const y = by * 32 + 16;
      const tx = x / TILE - 1;
      const ty = y / TILE - 1;
      const t = this.tiles;
      if (t[ty * COLS + tx] || t[ty * COLS + tx + 1] || t[(ty + 1) * COLS + tx] || t[(ty + 1) * COLS + tx + 1]) continue;
      if (this.tanks.some((t) => t.alive && Math.abs(t.x - x) < 48 && Math.abs(t.y - y) < 48)) continue;
      if (this.powerups.some((p) => p.x === x && p.y === y)) continue;
      const type = POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)];
      this.powerups.push({ id: this.nextId++, type, x, y, expires: this.time + POWERUP_TTL });
      this.events.push({ k: "power", x, y, type });
      return;
    }
  }

  // ---- network -------------------------------------------------------------

  snapshot() {
    return {
      tm: r1(this.time),
      tl: Math.ceil(this.timeLeft),
      k: this.tanks.map((t) => ({
        i: t.id,
        x: r1(t.x),
        y: r1(t.y),
        d: t.dir,
        hp: t.hp,
        a: t.alive ? 1 : 0,
        m: t.moving ? 1 : 0,
        sh: this.time < t.shieldUntil ? 1 : 0,
        rp: this.time < t.rapidUntil ? 1 : 0,
        ki: t.kills,
        de: t.deaths,
      })),
      b: this.bullets.map((b) => ({ i: b.id, x: r1(b.x), y: r1(b.y), d: b.dir })),
      p: this.powerups.map((p) => ({
        i: p.id,
        t: p.type,
        x: p.x,
        y: p.y,
        e: p.expires - this.time < 3 ? 1 : 0,
      })),
    };
  }
}
