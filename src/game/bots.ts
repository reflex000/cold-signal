// The companion bot brain (settings.bots). Bots are players without a transport: the brain runs
// beside the host, reads the authoritative state and drives each bot with the same InputCmd a
// human sends (Host.setBotInput), so every co-op system sees them exactly as it sees people.
// For now they keep near the local player: walk to them when they fall behind, hold a loose
// spacing, step round what blocks the way, hop when stuck, sprint to catch up.
// Owner: GAME.
import { wrapAngle } from '../core/math';
import type { Host } from '../net/host';
import { neutralInput } from '../sim/entities';
import { BTN, type InputCmd, type NetId, type PlayerEnt } from '../sim/types';
import type { World } from '../world/types';

const NAMES = ['Mara', 'Tomas', 'Ines'];

interface Bot {
  id: NetId;
  cmd: InputCmd;
  /** Where it was a second ago, to notice being stuck. */
  lastX: number;
  lastZ: number;
  checkIn: number;
  stuck: number;
  side: number;
}

export class BotBrain {
  private host: Host | null = null;
  private bots: Bot[] = [];
  private leader: NetId = 0;
  private seq = 0;

  constructor(private readonly world: World) {}

  attach(host: Host | null, leader: NetId): void {
    this.host = host;
    this.leader = leader;
    this.bots = [];
  }

  setLeader(id: NetId): void {
    this.leader = id;
  }

  get count(): number {
    return this.bots.length;
  }

  /** Ids of the bots in play. */
  ids(): NetId[] {
    return this.bots.map((b) => b.id);
  }

  /** Add or remove bots until there are `n` (0..3). */
  set(n: number): void {
    const host = this.host;
    if (!host) return;
    n = Math.max(0, Math.min(3, Math.floor(n)));
    while (this.bots.length > n) {
      const b = this.bots.pop()!;
      host.removeBot(b.id);
    }
    while (this.bots.length < n) {
      const i = this.bots.length;
      const p = host.addBot(NAMES[i] ?? 'Bot ' + (i + 1));
      this.bots.push({ id: p.id, cmd: neutralInput(), lastX: p.x, lastZ: p.z, checkIn: 1, stuck: 0, side: i % 2 ? 1 : -1 });
    }
  }

  /** Once per host tick, before host.tick(). */
  tick(dt: number): void {
    const host = this.host;
    if (!host || this.bots.length === 0) return;
    const ctx = host.sim.ctx;
    const lead = ctx.get<PlayerEnt>(this.leader);
    for (let k = 0; k < this.bots.length; k++) {
      const b = this.bots[k];
      const p = ctx.get<PlayerEnt>(b.id);
      if (!p) continue;
      const c = b.cmd;
      c.seq = ++this.seq;
      c.mx = 0;
      c.mz = 0;
      c.b = 0;
      c.focus = 0;
      if (!lead || p.life !== 'alive') {
        host.setBotInput(b.id, c);
        continue;
      }
      // a spot beside and a little behind the leader, one per bot
      const ly = lead.yaw;
      const back = 2.6 + k * 1.2;
      const tx = lead.x + Math.sin(ly) * back + Math.cos(ly) * b.side * (1.6 + k * 0.4);
      const tz = lead.z + Math.cos(ly) * back - Math.sin(ly) * b.side * (1.6 + k * 0.4);
      const dx = tx - p.x, dz = tz - p.z;
      const d = Math.hypot(dx, dz);
      const dl = Math.hypot(lead.x - p.x, lead.z - p.z);
      let yaw = p.yaw;
      if (d > 1.2) {
        // yaw that faces (dx, dz): 0 looks north (-Z), positive turns left
        let want = Math.atan2(-dx, -dz);
        // look ahead: if the way is blocked, try either side
        const probe = (a: number) => this.world.walkable(p.x - Math.sin(a) * 2.2, p.z - Math.cos(a) * 2.2);
        if (!probe(want)) {
          for (const off of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
            if (probe(want + off * b.side)) {
              want += off * b.side;
              break;
            }
          }
        }
        yaw = want;
        c.mz = d > 3 ? 1 : 0.55;
        if (dl > 22 && p.stamina > 0.3) c.b |= BTN.SPRINT;
      } else {
        // arrived: face the way the leader looks
        yaw = p.yaw + wrapAngle(ly - p.yaw) * 0.05;
      }
      // stuck: no progress for a second while trying to walk -> hop and veer
      b.checkIn -= dt;
      if (b.checkIn <= 0) {
        const moved = Math.hypot(p.x - b.lastX, p.z - b.lastZ);
        b.stuck = c.mz > 0 && moved < 0.4 ? b.stuck + 1 : 0;
        b.lastX = p.x;
        b.lastZ = p.z;
        b.checkIn = 1;
        if (b.stuck >= 2) b.side = -b.side;
      }
      if (b.stuck > 0 && b.checkIn > 0.95) c.b |= BTN.JUMP;
      c.yaw = wrapAngle(yaw);
      c.pitch = 0;
      host.setBotInput(b.id, c);
    }
  }
}
