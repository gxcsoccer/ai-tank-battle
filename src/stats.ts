// Tank builds: the 秘籍 appraisal turns a prompt into attribute points, and the
// points turn into concrete engine stats. All numbers are clamped server-side,
// so no prompt can push a tank past the caps.

export const ATTRS = ["armor", "speed", "power", "reload", "sense"] as const;
export type Attr = (typeof ATTRS)[number];
export type Points = Record<Attr, number>;

export const BASE_POINTS = 12;
export const MAX_BONUS = 3;
export const MAX_ATTR = 5;

export interface Build {
  points: Points; // includes bonus
  bonus: number;
  title: string;
  comment: string;
  cheat: boolean;
  ai: boolean; // appraised by Workers AI (vs local fallback)
}

export interface TankStats {
  maxHp: number;
  speed: number;
  bulletSpeed: number;
  crit: number; // chance a shell deals double damage
  cooldown: number;
  maxBullets: number;
  reaction: number; // AI: seconds lined up before firing
  dodge: number; // AI: chance to notice an incoming shell
}

export function toStats(p: Points): TankStats {
  return {
    maxHp: 2 + Math.round(p.armor * 0.6),
    speed: 62 + p.speed * 8,
    bulletSpeed: 200 + p.power * 25,
    crit: p.power * 0.07,
    cooldown: 0.6 - p.reload * 0.08,
    maxBullets: p.reload >= 4 ? 2 : 1,
    reaction: 0.4 - p.sense * 0.05,
    dodge: 0.25 + p.sense * 0.13,
  };
}

const clampInt = (n: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

/**
 * Force base points to sum to exactly BASE_POINTS (each 0..MAX_ATTR), then add
 * the bonus to the attributes the appraiser weighted highest.
 */
export function normalize(raw: Partial<Record<Attr, unknown>>, bonusRaw: unknown): { points: Points; bonus: number } {
  const p = Object.fromEntries(ATTRS.map((a) => [a, clampInt(raw[a], 0, MAX_ATTR)])) as Points;
  let sum = ATTRS.reduce((s, a) => s + p[a], 0);
  if (sum === 0) {
    for (const a of ATTRS) p[a] = 2;
    p.armor = 4;
    sum = BASE_POINTS;
  }
  const byWeight = [...ATTRS].sort((a, b) => p[b] - p[a]);
  while (sum > BASE_POINTS) {
    const a = [...ATTRS].sort((x, y) => p[y] - p[x])[0];
    p[a]--;
    sum--;
  }
  for (let i = 0; sum < BASE_POINTS; i++) {
    const a = byWeight[i % ATTRS.length];
    if (p[a] < MAX_ATTR) {
      p[a]++;
      sum++;
    }
  }
  let bonus = clampInt(bonusRaw, 0, MAX_BONUS);
  const given = bonus;
  for (let i = 0; bonus > 0 && i < 20; i++) {
    const a = byWeight[i % ATTRS.length];
    if (p[a] < MAX_ATTR) {
      p[a]++;
      bonus--;
    }
  }
  return { points: p, bonus: given - bonus };
}

export const DEFAULT_BUILD: Build = {
  points: { armor: 3, speed: 2, power: 2, reload: 3, sense: 2 },
  bonus: 0,
  title: "新兵坦克",
  comment: "没写秘籍，凭本能作战。",
  cheat: false,
  ai: false,
};

/** Keyword appraisal used when Workers AI is unavailable. */
export function localAppraise(prompt: string): Build {
  const kw: Record<Attr, RegExp> = {
    armor: /装甲|血|肉|坦|硬|防御|守/g,
    speed: /快|速度|机动|闪|跑|灵活|迂回|包抄/g,
    power: /火力|伤害|猛|狙|一击|爆/g,
    reload: /连射|射速|装填|火力压制|扫射|连发/g,
    sense: /躲|预判|侦察|感知|观察|冷静|草丛|埋伏/g,
  };
  const raw = Object.fromEntries(ATTRS.map((a) => [a, 1 + (prompt.match(kw[a])?.length ?? 0)])) as Points;
  const total = ATTRS.reduce((s, a) => s + raw[a], 0);
  const scaled = Object.fromEntries(ATTRS.map((a) => [a, (raw[a] / total) * BASE_POINTS])) as Points;
  const { points, bonus } = normalize(scaled, 0);
  return { points, bonus, title: "无名坦克", comment: "鉴定师打盹中，按关键词粗略估算。", cheat: false, ai: false };
}

// NPC tanks: preset personas with fixed 12-point builds (no bonus, so a good 秘籍 beats them).
export interface NpcPreset {
  name: string;
  title: string;
  secret: string;
  points: Points;
}

export const NPCS: NpcPreset[] = [
  {
    name: "铁锤·Llama",
    title: "正面莽夫",
    secret: "极度好战的莽夫，永远正面强攻最近的敌人，绝不后退。",
    points: { armor: 4, speed: 1, power: 4, reload: 2, sense: 1 },
  },
  {
    name: "幽灵·Qwen",
    title: "草丛刺客",
    secret: "狡猾的猎手，擅长迂回包抄、埋伏在草丛里，专挑比分领先者偷袭。",
    points: { armor: 1, speed: 4, power: 2, reload: 1, sense: 4 },
  },
  {
    name: "堡垒·Mistral",
    title: "移动要塞",
    secret: "谨慎的守护者，血量低时立刻撤退去捡回血和护盾，血量高时稳扎稳打反击。",
    points: { armor: 5, speed: 1, power: 2, reload: 3, sense: 1 },
  },
  {
    name: "疾风·Gemma",
    title: "闪电突击",
    secret: "速度至上，绕着敌人高速游走，抢光所有道具，用连射压制。",
    points: { armor: 1, speed: 5, power: 1, reload: 4, sense: 1 },
  },
  {
    name: "狙神·DeepSeek",
    title: "一击必杀",
    secret: "冷静的狙击手，保持距离，等敌人进入直线再开火，专挑残血目标。",
    points: { armor: 1, speed: 1, power: 5, reload: 2, sense: 3 },
  },
  {
    name: "狂犬·GLM",
    title: "火力狂潮",
    secret: "疯狂扫射，哪里有人就往哪里冲，享受混战。",
    points: { armor: 1, speed: 3, power: 2, reload: 5, sense: 1 },
  },
];
