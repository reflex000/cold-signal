// Balance runs without a browser: the whole hour, played by the same bot minds as the release scenario
// (src/game/bots.ts: a Mind in the 'lead' role plays "You", companions follow through Host.setBotInput /
// botAct), against the real simulation and the real world of each seed. Nothing is handed over.
//
//   node tools/balance.mjs [--seeds 417,1,2] [--bots 1] [--max 95] [--json out.json] [--quiet 1]
//
// Per run it logs the time of every leg (each radio part found, the tower, the parts fitted, the call,
// the rescue), downs and deaths with their cause, the closest calls with the cold (lowest core, seconds
// below 34 / 33 / 32 C), the wolves met (distinct wolves that came within 30 m on the hunt, bites, kills),
// and the matches, rounds and flares picked up, used and left over. --json writes every run's numbers.
// The autopilot reads the authoritative state here (in the game it reads the client's View); its
// decisions are otherwise the same, so the numbers match the playthrough scenario's within run noise.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : '1';
}
const seeds = String(args.seeds ?? '417').split(',').map((s) => Math.floor(Number(s))).filter((s) => Number.isFinite(s));
const nBots = Math.max(0, Math.min(3, Number(args.bots ?? 1)));
const MAX_T = Number(args.max ?? 95) * 60;
const quiet = args.quiet === '1';
const trace = Number(args.trace ?? 0); // print the autopilot's state every this many game seconds

const cacheDir = path.join(os.tmpdir(), 'cold-signal-vite', 'balance-' + process.pid);
const server = await createServer({
  root, configFile: path.join(root, 'vite.config.ts'), cacheDir, logLevel: 'error',
  server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
const load = (p) => server.ssrLoadModule(p);
const { createWorld } = await load('/src/world/index.ts');
const { Sim } = await load('/src/sim/sim.ts');
const { Host } = await load('/src/net/host.ts');
const { copyInput, neutralInput } = await load('/src/sim/entities.ts');
const { Mind, BotBrain, litFires } = await load('/src/game/bots.ts');
const { SimReader } = await load('/src/game/botnav.ts');
const { DT } = await load('/src/sim/types.ts');

const HUNTING = new Set(['stalk', 'circle', 'feint', 'charge', 'bite', 'drag']);
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

function run(seed) {
  const t0 = performance.now();
  const world = createWorld(seed);
  const sim = new Sim(world, { seed, debug: false, players: 1 + nBots });
  const host = new Host(sim);
  const me = sim.addPlayer('You');
  const brain = new BotBrain(world);
  brain.attach(host, me.id);
  brain.set(nBots);
  const reader = new SimReader(world, sim.ctx);
  const lead = new Mind(me.id, 'lead', 1);
  const cmd = neutralInput();
  const link = { send: (c) => { copyInput(cmd, c); sim.setInput(me.id, cmd); }, act: (a) => sim.act(me.id, a) };
  const tower = world.poi('tower');

  // ------------------------------------------------------------------ the record
  const R = {
    seed, bots: nBots, legs: [], downs: [], deaths: [], revives: 0,
    core: {}, wolves: { met: 0, packs: 0, bites: 0, wolfDamage: 0, kills: 0, howls: 0, attacksOn: {} },
    fires: { built: 0, lit: 0, fail: {}, out: {} },
    picked: {}, used: { matchStrikes: 0, shots: 0, flares: 0 }, left: {},
    whiteouts: [], stages: [], firstCold: null, doing: {},
  };
  const lastHurt = new Map();
  const metWolves = new Set(), metPacks = new Set();
  const coreOf = (p) => (R.core[p.name] ??= { min: 99, below34: 0, below33: 0, below32: 0, dips: 0, inDip: false, minHealth: 100 });
  let spell = null;
  let towerAt = -1, deadFor = 0;
  const leg = (label) => R.legs.push({ label, t: Math.round(sim.state.env.t) });
  const names = new Map(sim.ctx.players().map((p) => [p.id, p.name]));

  for (let guard = 0; guard < MAX_T * 30 + 10; guard++) {
    const st = sim.state;
    if (st.objective.stage === 'won' || st.env.t > MAX_T) break;
    brain.planner.fires = litFires(reader, brain.planner.fires);
    const p0 = sim.ctx.get(me.id);
    if (p0 && p0.life === 'dead') {
      deadFor += DT;
      if (deadFor > 5) sim.act(me.id, { t: 'respawn' });
    } else deadFor = 0;
    lead.tick(reader, brain.planner, DT, link);
    brain.tick(DT);
    const evs = host.tick();
    for (const e of evs) {
      switch (e.t) {
        case 'hurt': lastHurt.set(e.id, e.cause); if (e.cause === 'wolf') R.wolves.wolfDamage += e.amount; break;
        case 'downed': R.downs.push({ who: names.get(e.id) ?? e.id, cause: lastHurt.get(e.id) ?? '?', t: Math.round(st.env.t) }); break;
        case 'died': R.deaths.push({ who: names.get(e.id) ?? e.id, cause: lastHurt.get(e.id) ?? '?', t: Math.round(st.env.t) }); break;
        case 'revived': R.revives++; break;
        case 'bite': R.wolves.bites++; { const n = names.get(e.target) ?? e.target; R.wolves.attacksOn[n] = (R.wolves.attacksOn[n] ?? 0) + 1; } break;
        case 'wolfDie': R.wolves.kills++; break;
        case 'howl': R.wolves.howls++; break;
        case 'fireBuilt': R.fires.built++; break;
        case 'fireLit': R.fires.lit++; break;
        case 'igniteFail': R.fires.fail[e.why] = (R.fires.fail[e.why] ?? 0) + 1; break;
        case 'fireOut': R.fires.out[e.why] = (R.fires.out[e.why] ?? 0) + 1; break;
        case 'pickup': R.picked[e.item] = (R.picked[e.item] ?? 0) + e.n; break;
        case 'shot': R.used.shots++; break;
        case 'flareShot': R.used.flares++; break;
        case 'partFound': leg(`${e.part} (${names.get(e.by) ?? e.by})`); break;
        case 'stage': R.stages.push({ stage: e.stage, t: Math.round(st.env.t) }); if (e.stage !== 'search' && e.stage !== 'tower') leg('stage ' + e.stage); break;
        case 'partInstalled': if (Object.values(st.objective.parts).every((v) => v === 'installed')) leg('all fitted'); break;
        case 'spawn': { const ent = sim.ctx.get(e.id); if (ent && ent.kind === 'player') names.set(ent.id, ent.name); } break;
      }
      if (e.t === 'fireLit' || e.t === 'igniteFail') R.used.matchStrikes++;
    }
    // ---- sampled state
    const t = st.env.t;
    { const k = lead.doing.replace(/ (the|a|an) .*/, '').replace(/^(take|find|fetch|chop|install|hand over) .*/, '$1'); R.doing[k] = (R.doing[k] ?? 0) + DT; }
    if (trace && st.tick % (30 * trace) === 0) {
      const p = sim.ctx.get(me.id);
      const parts = Object.entries(st.objective.parts).map(([k, v]) => k[0] + (v === 'installed' ? 'I' : v === 'held' ? 'H' : '-')).join('');
      const bots = Object.values(brain.doing()).join(', ');
      const near = p ? sim.ctx.all('wolf').filter((w) => Math.hypot(w.x - p.x, w.z - p.z) < 40).map((w) => `${w.mood}${Math.round(Math.hypot(w.x - p.x, w.z - p.z))}m`).join(' ') : '';
      if (p) console.log(`    ${fmt(t)} ${st.env.clock.toFixed(1)}h storm ${st.env.storm.toFixed(2)} ${st.objective.stage} ${parts} at ${Math.round(p.x)},${Math.round(p.z)} core ${p.core.toFixed(1)} wet ${p.wet.toFixed(2)} ${p.life} sticks ${p.inv.stick ?? 0} matches ${p.inv.matches ?? 0} ammo ${(p.inv.ammo ?? 0) + p.loaded} | ${lead.doing} | bot: ${bots}${near ? ' | wolves ' + near : ''}`);
    }
    for (const p of sim.ctx.players()) {
      const c = coreOf(p);
      if (p.life === 'alive' || p.life === 'downed') {
        c.min = Math.min(c.min, p.core);
        c.minHealth = Math.min(c.minHealth, p.health);
        if (p.core < 34) c.below34 += DT;
        if (p.core < 33) c.below33 += DT;
        if (p.core < 32) c.below32 += DT;
        if (!c.inDip && p.core < 33.5) { c.inDip = true; c.dips++; if (R.firstCold === null) R.firstCold = Math.round(t); }
        if (c.inDip && p.core > 35) c.inDip = false;
      }
      if (towerAt < 0 && p.id === me.id && Math.hypot(p.x - tower.x, p.z - tower.z) < 40) { towerAt = t; leg('tower reached'); }
    }
    if ((sim.state.tick & 7) === 0) {
      for (const w of sim.ctx.all('wolf')) {
        if (!HUNTING.has(w.mood) || metWolves.has(w.id)) continue;
        for (const p of sim.ctx.players()) {
          if (p.life === 'dead' || p.life === 'rescued') continue;
          if (Math.hypot(w.x - p.x, w.z - p.z) < 30) { metWolves.add(w.id); metPacks.add(w.pack); break; }
        }
      }
    }
    const storm = st.env.storm;
    if (storm > 0.9 && st.objective.stage !== 'holdout' && st.objective.stage !== 'rescue') {
      const p = sim.ctx.get(me.id);
      if (!spell) R.whiteouts.push((spell = { t0: Math.round(t), dur: 0, atFire: 0, minCore: 99 }));
      spell.dur += DT;
      if (p && p.life === 'alive' && p.fireHeat > 0.2) spell.atFire += DT;
      if (p) spell.minCore = Math.min(spell.minCore, p.core);
    } else spell = null;
  }

  // ------------------------------------------------------------------ the verdict
  const st = sim.state;
  R.stage = st.objective.stage;
  R.t = Math.round(st.env.t);
  R.realMs = Math.round(performance.now() - t0);
  R.wolves.met = metWolves.size;
  R.wolves.packs = metPacks.size;
  R.wolves.wolfDamage = Math.round(R.wolves.wolfDamage);
  for (const p of sim.ctx.players()) {
    for (const k of ['matches', 'ammo', 'flare', 'stick', 'log', 'tinder', 'bandage', 'ration', 'thermos', 'cell']) R.left[k] = (R.left[k] ?? 0) + (p.inv[k] ?? 0);
    R.left.ammo += p.loaded ?? 0;
    R.left.flare += p.flareLoaded ?? 0;
  }
  for (const c of Object.values(R.core)) {
    c.min = Math.round(c.min * 10) / 10;
    c.below34 = Math.round(c.below34); c.below33 = Math.round(c.below33); c.below32 = Math.round(c.below32);
    c.minHealth = Math.round(c.minHealth);
    delete c.inDip;
  }
  for (const w of R.whiteouts) { w.dur = Math.round(w.dur); w.atFire = Math.round(w.atFire); w.minCore = Math.round(w.minCore * 10) / 10; }
  // what the mountain held for this group: loose pickups plus crate loot
  const supply = {};
  for (const e of sim.ctx.all('pickup')) supply[e.item] = (supply[e.item] ?? 0) + e.n;
  for (const e of sim.ctx.all('crate')) if (!e.open) for (const l of e.loot) supply[l.item] = (supply[l.item] ?? 0) + l.n;
  R.unclaimed = { matches: supply.matches ?? 0, ammo: supply.ammo ?? 0, flare: supply.flare ?? 0 };
  return R;
}

function report(R) {
  const L = [];
  L.push(`seed ${R.seed}, ${R.bots} bot(s): ${R.stage} after ${fmt(R.t)} game time (${(R.realMs / 1000).toFixed(0)} s real)`);
  let prev = 0;
  L.push('  legs: ' + R.legs.map((l) => { const s = `${l.label} ${fmt(l.t)} (+${fmt(l.t - prev)})`; prev = l.t; return s; }).join(' | '));
  L.push(`  downs ${R.downs.length} ${JSON.stringify(R.downs)}; deaths ${R.deaths.length} ${JSON.stringify(R.deaths)}; revives ${R.revives}`);
  L.push('  cold: ' + Object.entries(R.core).map(([n, c]) => `${n} min ${c.min} C, <34 ${c.below34} s, <33 ${c.below33} s, <32 ${c.below32} s, dips ${c.dips}, min health ${c.minHealth}`).join(' | ') + `; first dip below 33.5 at ${R.firstCold === null ? '-' : fmt(R.firstCold)}`);
  L.push(`  wolves: met ${R.wolves.met} from ${R.wolves.packs} pack(s), bites ${R.wolves.bites} ${JSON.stringify(R.wolves.attacksOn)}, wolf damage ${R.wolves.wolfDamage}, kills ${R.wolves.kills}, howls ${R.wolves.howls}`);
  L.push(`  fires: built ${R.fires.built}, lit ${R.fires.lit}, failed ${JSON.stringify(R.fires.fail)}, went out ${JSON.stringify(R.fires.out)}`);
  L.push(`  matches picked ${R.picked.matches ?? 0}, strikes ${R.used.matchStrikes}, left ${R.left.matches} (unclaimed ${R.unclaimed.matches}) | rounds picked ${R.picked.ammo ?? 0}, shots ${R.used.shots}, left ${R.left.ammo} (unclaimed ${R.unclaimed.ammo}) | flares picked ${R.picked.flare ?? 0}, fired ${R.used.flares}, left ${R.left.flare} (unclaimed ${R.unclaimed.flare})`);
  L.push('  autopilot time: ' + Object.entries(R.doing).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + fmt(v)).join(', '));
  L.push('  whiteouts: ' + R.whiteouts.map((w) => `${fmt(w.t0)} ${w.dur} s, at fire ${w.atFire} s, min ${w.minCore} C`).join(' | '));
  return L.join('\n');
}

const all = [];
try {
  for (const seed of seeds) {
    const R = run(seed);
    all.push(R);
    console.log(report(R));
  }
} finally {
  await server.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
}
if (args.json) fs.writeFileSync(path.resolve(args.json), JSON.stringify(all, null, 1));
if (!quiet && all.length > 1) {
  const won = all.filter((r) => r.stage === 'won');
  const ts = won.map((r) => r.t).sort((a, b) => a - b);
  console.log(`SUMMARY ${won.length}/${all.length} won; game time ${ts.map(fmt).join(', ')}; downs ${all.map((r) => r.downs.length).join(',')}; deaths ${all.map((r) => r.deaths.length).join(',')}`);
}
