// Headless smoke test: N AI tanks (NPC presets, heuristic tactics, no LLM) play full matches.
import { BotController, QUICK_ORDERS } from "../src/ai";
import { COLS, Game, ROWS, T } from "../src/game";
import { NPCS, toStats } from "../src/stats";

const matches = Number(process.argv[2] ?? 4);
const n = Number(process.argv[3] ?? 8);
for (let m = 0; m < matches; m++) {
  const specs = Array.from({ length: n }, (_, slot) => {
    const p = NPCS[slot % NPCS.length];
    return { id: `t${slot}`, name: p.name, slot, npc: true, stats: toStats(p.points) };
  });
  const g = new Game(specs, 5);
  if (m === 0) {
    const ch = [".", "#", "@", "~", "\""];
    for (let y = 0; y < ROWS; y++) console.log(Array.from(g.tiles.slice(y * COLS, (y + 1) * COLS), (v) => ch[v]).join(""));
  }
  const bots = specs.map((s) => new BotController(s.id, { name: s.name, title: "", secret: "" }, 2.5));
  let shots = 0, picks = 0, steps = 0;
  const keys = Object.keys(QUICK_ORDERS);
  const t0 = performance.now();
  while (!g.over) {
    for (const b of bots) {
      if (g.time >= b.nextThinkAt) {
        if (Math.random() < 0.2) b.quickOrder(g, keys[Math.floor(Math.random() * keys.length)]);
        else if (g.time >= b.orderUntil) b.strategy = b.fallback(g);
        b.nextThinkAt = g.time + 2.5;
      }
      b.update(g, 1 / 30);
    }
    g.step(1 / 30);
    steps++;
    for (const e of g.events) { if (e.k === "shot") shots++; if (e.k === "pick") picks++; }
    g.events = []; g.tileChanges = [];
  }
  const ms = (performance.now() - t0) / steps;
  console.log(`match ${m}: ${g.time.toFixed(0)}s  ${g.ranking().map((t) => `${t.name}:${t.kills}/${t.deaths}`).join(" ")}  shots=${shots} picks=${picks}  ${ms.toFixed(3)}ms/tick`);
}
