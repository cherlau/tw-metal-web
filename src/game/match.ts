// Partida de deathmatch — estado PURO (sem DOM/Three). O runtime (src/game.ts) só desenha e lê eventos.
// ⚠️ ESCOLHA DO HOST: vida, turbo, tempos de renascimento, IA dos bots (ver docs/NATIVE.md para o que é nativo).
import { add, len, norm, scale, sub, v3, type V3 } from '../physics/vec';
import { createVehicle, forwardOf, stepVehicle, type CollisionWorld, type Controls, type VehicleShape, type VehicleState } from '../physics/vehicle';
import { damageFromHit, fire, pickTarget, pickupEffect, PICKUP_RULES, stepProjectile, WEAPON_RULES, type CarBody, type Projectile, type WeaponId } from './weapons';

export const MATCH_RULES = {
  maxHealth: 100,
  respawnDelay: 3,
  turboMax: 100,
  turboDrain: 40, // por segundo
  turboRegen: 6,
  turboAccelMul: 1.5, // velocidade de equilíbrio ∝ acelerador → turbo ≈ 1,5 × vel. máx.
  machineGunRange: 260,
  botFireRange: 220,
} as const;

export interface CarActions extends Controls {
  fireGun: boolean;
  fireSpecial: boolean; // borda de subida
  nextWeapon: boolean; // borda de subida
  turbo: boolean;
}

export const NO_ACTIONS: CarActions = { throttle: 0, brake: 0, steer: 0, handbrake: false, fireGun: false, fireSpecial: false, nextWeapon: false, turbo: false };

export interface Car {
  id: number;
  name: string;
  model: string;
  bot: boolean;
  state: VehicleState;
  shape: VehicleShape;
  health: number;
  turbo: number;
  ammo: Partial<Record<WeaponId, number>>;
  selected: WeaponId | null;
  cooldown: number;
  gunCooldown: number;
  deadFor: number; // > 0: morto há x s
  /** Turbo ligado neste passo (controle+0x0C ≠ 0 no jogo: chama do turbo, FUN_001238c8). */
  boosting: boolean;
  /** Freio acionado neste passo (controle+0x10 > 0: lanternas no filho 2, FUN_0011f1e8). */
  braking: boolean;
  /** Esterço pedido neste passo (−1..1; o jogo guarda 0..1 com 0,5 = centro em carro+0x4a8). */
  steer: number;
  /** Passos seguidos sem tocar o chão (carro+0x7c8). */
  airFrames: number;
  kills: number;
  deaths: number;
  /** Memória da IA: tempo acelerando sem andar, e tempo restante de ré para desatolar. */
  botStuck: number;
  botReverse: number;
}

export interface Pickup {
  index: number;
  id: number; // id nativo (PKP word 8)
  pos: V3;
  respawnIn: number; // 0 = disponível
}

export type MatchEvent =
  | { kind: 'shot'; car: number; weapon: WeaponId; from: V3; to: V3 }
  | { kind: 'launch'; car: number; weapon: WeaponId; pos: V3 }
  | { kind: 'impact'; a: number; b: number; pos: V3; speed: number }
  | { kind: 'explosion'; pos: V3; weapon: WeaponId }
  | { kind: 'hit'; car: number; amount: number; pos: V3 }
  | { kind: 'pickup'; car: number; pickupId: number; name: string }
  | { kind: 'killed'; victim: number; killer: number | null; pos: V3 }
  | { kind: 'respawn'; car: number };

export class Match {
  cars: Car[] = [];
  pickups: Pickup[] = [];
  projectiles: Projectile[] = [];
  private events: MatchEvent[] = [];
  private time = 0;

  constructor(
    private readonly world: CollisionWorld,
    private readonly spawns: V3[],
    private readonly ground: (p: V3, shape: VehicleShape) => V3,
  ) {}

  addCar(name: string, model: string, shape: VehicleShape, bot: boolean): Car {
    const id = this.cars.length;
    const car: Car = {
      id, name, model, bot, shape,
      state: createVehicle(v3()),
      health: MATCH_RULES.maxHealth, turbo: MATCH_RULES.turboMax,
      ammo: {}, selected: null, cooldown: 0, gunCooldown: 0, deadFor: 0, kills: 0, deaths: 0, botStuck: 0, botReverse: 0, boosting: false, braking: false, steer: 0, airFrames: 0,
    };
    this.cars.push(car);
    this.respawn(car);
    return car;
  }

  addPickups(list: { id: number; pos: V3 }[]) {
    for (const [index, p] of list.entries()) if (pickupEffect(p.id).kind !== 'none') this.pickups.push({ index, id: p.id, pos: p.pos, respawnIn: 0 });
  }

  /** Eventos desde a última chamada (drenados pelo dono — SPEC §9.3). */
  drain(): MatchEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  bodies(): CarBody[] {
    return this.cars.map((c) => ({ id: c.id, pos: this.center(c), radius: Math.max(3, Math.min(c.shape.halfWidth, c.shape.halfLength)), alive: c.deadFor === 0 }));
  }

  center(c: Car): V3 {
    return add(c.state.pos, v3(0, (c.shape.top + c.shape.bottom) / 2, 0));
  }

  /**
   * Direção mais livre a partir do spawn (16 raios na altura do carro). Os nós PTS não têm direção;
   * antes o carro podia nascer de cara para um paredão (Egito). ⚠️ ESCOLHA DO HOST.
   */
  openYaw(pos: V3, shape: VehicleShape): number {
    const o = v3(pos.x, pos.y + (shape.top + shape.bottom) / 2, pos.z);
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < 16; i++) {
      const yaw = (i / 16) * Math.PI * 2;
      const hit = this.world.raycast(o, forwardOf(yaw), 300);
      const d = hit ? hit.distance : 300;
      if (d > bestD + 1e-6) {
        bestD = d;
        best = yaw;
      }
    }
    return best;
  }

  respawn(car: Car) {
    // Nasce no spawn mais longe dos outros carros vivos.
    const others = this.cars.filter((c) => c !== car && c.deadFor === 0).map((c) => c.state.pos);
    let best = this.spawns[car.id % this.spawns.length];
    let bestD = -1;
    for (let i = 0; i < this.spawns.length; i++) {
      const s = this.spawns[(i * 7 + car.id * 13 + Math.floor(this.time)) % this.spawns.length];
      const d = others.length ? Math.min(...others.map((o) => len(sub(o, s)))) : 1e9;
      if (d > bestD) {
        bestD = d;
        best = s;
        if (!others.length) break;
      }
    }
    const pos = this.ground(best, car.shape);
    car.state = createVehicle(pos, this.openYaw(pos, car.shape));
    car.health = MATCH_RULES.maxHealth;
    car.turbo = MATCH_RULES.turboMax;
    car.deadFor = 0;
    car.ammo = {};
    car.selected = null;
  }

  step(dt: number, actions: Map<number, CarActions>) {
    this.time += dt;
    const bodies = this.bodies();
    for (const car of this.cars) {
      if (car.deadFor > 0) {
        car.boosting = car.braking = false;
        car.deadFor += dt;
        if (car.deadFor >= MATCH_RULES.respawnDelay) {
          this.respawn(car);
          this.events.push({ kind: 'respawn', car: car.id });
        }
        continue;
      }
      const a = car.bot ? this.botActions(car, bodies, dt) : actions.get(car.id) ?? NO_ACTIONS;
      // Turbo: aceleração extra enquanto houver carga.
      const boosting = a.turbo && car.turbo > 1 && a.throttle > 0;
      car.boosting = boosting;
      car.braking = a.brake > 0;
      car.steer = a.steer;
      car.turbo = Math.min(MATCH_RULES.turboMax, car.turbo + (boosting ? -MATCH_RULES.turboDrain : MATCH_RULES.turboRegen) * dt);
      stepVehicle(car.state, car.shape, { ...a, throttle: boosting ? MATCH_RULES.turboAccelMul : a.throttle }, this.world, dt);
      car.airFrames = car.state.grounded ? 0 : car.airFrames + 1;
      this.weapons(car, a, bodies, dt);
    }
    this.collideCars();
    this.stepProjectiles(dt);
    this.stepPickups(dt);
  }

  /**
   * Carro × carro (escolha do host): círculos no plano (raio = meia-largura média), separação
   * meio a meio e impulso igual e oposto ao longo da normal com restituição 0.3.
   */
  private collideCars() {
    const alive = this.cars.filter((c) => c.deadFor === 0);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const ra = (a.shape.halfWidth + a.shape.halfLength) * 0.5;
        const rb = (b.shape.halfWidth + b.shape.halfLength) * 0.5;
        const dx = b.state.pos.x - a.state.pos.x;
        const dz = b.state.pos.z - a.state.pos.z;
        if (Math.abs(b.state.pos.y - a.state.pos.y) > Math.max(a.shape.top - a.shape.bottom, b.shape.top - b.shape.bottom)) continue;
        const d = Math.hypot(dx, dz);
        const overlap = ra + rb - d;
        if (overlap <= 0) continue;
        const nx = d > 1e-6 ? dx / d : 1;
        const nz = d > 1e-6 ? dz / d : 0;
        a.state.pos = v3(a.state.pos.x - nx * overlap * 0.5, a.state.pos.y, a.state.pos.z - nz * overlap * 0.5);
        b.state.pos = v3(b.state.pos.x + nx * overlap * 0.5, b.state.pos.y, b.state.pos.z + nz * overlap * 0.5);
        const rel = (b.state.vel.x - a.state.vel.x) * nx + (b.state.vel.z - a.state.vel.z) * nz;
        if (rel < 0) {
          if (rel < -15) this.events.push({ kind: 'impact', a: a.id, b: b.id, pos: v3(a.state.pos.x + dx / 2, a.state.pos.y, a.state.pos.z + dz / 2), speed: -rel });
          const jImp = -(1 + 0.3) * rel * 0.5;
          a.state.vel = v3(a.state.vel.x - nx * jImp, a.state.vel.y, a.state.vel.z - nz * jImp);
          b.state.vel = v3(b.state.vel.x + nx * jImp, b.state.vel.y, b.state.vel.z + nz * jImp);
        }
      }
    }
  }

  private weapons(car: Car, a: CarActions, bodies: CarBody[], dt: number) {
    car.cooldown = Math.max(0, car.cooldown - dt);
    car.gunCooldown = Math.max(0, car.gunCooldown - dt);
    const owned = (Object.keys(car.ammo) as WeaponId[]).filter((w) => (car.ammo[w] ?? 0) > 0);
    if (!car.selected || !owned.includes(car.selected)) car.selected = owned[0] ?? null;
    if (a.nextWeapon && owned.length > 1) car.selected = owned[(owned.indexOf(car.selected!) + 1) % owned.length];

    const fwd = forwardOf(car.state.yaw);
    const origin = add(this.center(car), add(scale(fwd, car.shape.halfLength + 2), v3(0, 1, 0)));
    const targets = bodies.filter((b) => b.alive && b.id !== car.id).map((b) => ({ id: b.id, pos: b.pos }));

    if (a.fireGun && car.gunCooldown === 0) {
      // Metralhadora: instantânea (hitscan) na direção do alvo nativo se estiver à frente, senão reto.
      car.gunCooldown = WEAPON_RULES.machinegun.cooldown;
      const t = pickTarget(origin, fwd, targets, MATCH_RULES.machineGunRange);
      let dir = fwd;
      if (t) {
        const to = norm(sub(t.pos, origin));
        if (to.x * fwd.x + to.z * fwd.z > 0.9) dir = to;
      }
      const wall = this.world.raycast(origin, dir, MATCH_RULES.machineGunRange);
      const maxD = wall ? wall.distance : MATCH_RULES.machineGunRange;
      let end = add(origin, scale(dir, maxD));
      for (const b of bodies) {
        if (!b.alive || b.id === car.id) continue;
        const along = (b.pos.x - origin.x) * dir.x + (b.pos.y - origin.y) * dir.y + (b.pos.z - origin.z) * dir.z;
        if (along < 0 || along > maxD) continue;
        const p = add(origin, scale(dir, along));
        if (len(sub(b.pos, p)) <= b.radius) {
          end = p;
          this.damage(b.id, WEAPON_RULES.machinegun.damage, car.id, p);
          break;
        }
      }
      this.events.push({ kind: 'shot', car: car.id, weapon: 'machinegun', from: origin, to: end });
    }
    if (a.fireSpecial && car.selected && car.cooldown === 0) {
      const w = car.selected;
      car.cooldown = WEAPON_RULES[w].cooldown;
      car.ammo[w] = (car.ammo[w] ?? 0) - 1;
      const t = pickTarget(origin, fwd, targets);
      this.projectiles.push(...fire(w, car.id, origin, fwd, t?.id ?? null, this.time));
      this.events.push({ kind: 'launch', car: car.id, weapon: w, pos: origin });
    }
  }

  private stepProjectiles(dt: number) {
    const bodies = this.bodies();
    for (const p of this.projectiles) {
      const hit = stepProjectile(p, dt, this.world, bodies);
      if (!hit) continue;
      this.events.push({ kind: 'explosion', pos: hit.pos, weapon: p.weapon });
      for (const [id, dmg] of damageFromHit(hit, bodies)) this.damage(id, dmg, p.owner, hit.pos);
    }
    this.projectiles = this.projectiles.filter((p) => p.alive);
  }

  private damage(id: number, amount: number, by: number | null, at: V3) {
    const car = this.cars[id];
    if (car.deadFor > 0) return;
    this.events.push({ kind: 'hit', car: id, amount, pos: at });
    car.health -= amount;
    if (car.health <= 0) {
      car.health = 0;
      car.deadFor = 1e-6;
      car.deaths++;
      if (by !== null && by !== id) this.cars[by].kills++;
      this.events.push({ kind: 'killed', victim: id, killer: by, pos: at });
      this.events.push({ kind: 'explosion', pos: this.center(car), weapon: 'power' });
    }
  }

  private stepPickups(dt: number) {
    for (const p of this.pickups) {
      if (p.respawnIn > 0) {
        p.respawnIn = Math.max(0, p.respawnIn - dt);
        continue;
      }
      for (const car of this.cars) {
        if (car.deadFor > 0) continue;
        const d = len(sub(this.center(car), p.pos));
        if (d > PICKUP_RULES.radius + car.shape.halfWidth) continue;
        const eff = pickupEffect(p.id);
        if (eff.kind === 'weapon') {
          const have = car.ammo[eff.weapon] ?? 0;
          if (have >= PICKUP_RULES.maxAmmo) continue;
          car.ammo[eff.weapon] = Math.min(PICKUP_RULES.maxAmmo, have + WEAPON_RULES[eff.weapon].ammoPerPickup);
        } else if (eff.kind === 'health') {
          if (car.health >= MATCH_RULES.maxHealth) continue;
          car.health = Math.min(MATCH_RULES.maxHealth, car.health + MATCH_RULES.maxHealth * eff.fraction);
        } else if (eff.kind === 'turbo') {
          car.turbo = MATCH_RULES.turboMax;
        }
        p.respawnIn = PICKUP_RULES.respawn;
        this.events.push({ kind: 'pickup', car: car.id, pickupId: p.id, name: eff.kind === 'weapon' ? WEAPON_RULES[eff.weapon].name : eff.kind === 'health' ? 'Health' : 'Turbo' });
        break;
      }
    }
  }

  /** IA simples (escolha do host): persegue o alvo nativo; se não houver, vai ao pickup mais próximo. */
  private botActions(car: Car, bodies: CarBody[], dt: number): CarActions {
    const pos = car.state.pos;
    const fwd = forwardOf(car.state.yaw);
    const targets = bodies.filter((b) => b.alive && b.id !== car.id).map((b) => ({ id: b.id, pos: b.pos }));
    const target = pickTarget(this.center(car), fwd, targets);
    let goal: V3 | null = target?.pos ?? null;
    const lowHealth = car.health < 40;
    const wantPickup = lowHealth || !Object.values(car.ammo).some((n) => (n ?? 0) > 0);
    if (wantPickup) {
      let best: Pickup | null = null;
      let bestD = Infinity;
      for (const p of this.pickups) {
        if (p.respawnIn > 0) continue;
        const eff = pickupEffect(p.id);
        if (lowHealth && eff.kind !== 'health') continue;
        const d = len(sub(p.pos, pos));
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best && (!target || bestD < len(sub(target.pos, pos)) * 1.5)) goal = best.pos;
    }
    if (!goal) return { ...NO_ACTIONS, throttle: 0.6, steer: 0.3 };
    const to = sub(goal, pos);
    const dist = len(to);
    // ângulo com sinal entre frente e alvo (positivo = alvo à direita)
    const right = v3(-Math.cos(car.state.yaw), 0, Math.sin(car.state.yaw));
    const f = (to.x * fwd.x + to.z * fwd.z) / Math.max(dist, 1e-6);
    const r = (to.x * right.x + to.z * right.z) / Math.max(dist, 1e-6);
    const ang = Math.atan2(r, f);
    // Preso: acelerando há mais de 1,2 s sem passar de 6 pés/s → ré girando por 1 s.
    const speed = Math.hypot(car.state.vel.x, car.state.vel.z);
    if (car.botReverse > 0) car.botReverse -= dt;
    else if (speed < 6 && dist > 20) {
      car.botStuck += dt;
      if (car.botStuck > 1.2) {
        car.botReverse = 1;
        car.botStuck = 0;
      }
    } else car.botStuck = 0;
    const stuck = car.botReverse > 0;
    // Só atira com o alvo à frente, ao alcance e com linha de visão.
    let facing = f > 0.95 && target !== null && dist < MATCH_RULES.botFireRange;
    if (facing && target) {
      const from = this.center(car);
      const d = sub(target.pos, from);
      const L = len(d);
      facing = !this.world.raycast(from, scale(d, 1 / L), Math.max(0, L - 4));
    }
    return {
      throttle: stuck ? 0 : 1,
      brake: stuck ? 1 : 0,
      steer: stuck ? -Math.sign(ang) : Math.max(-1, Math.min(1, ang * 2)),
      handbrake: Math.abs(ang) > 1.4 && speed > 40,
      fireGun: facing,
      fireSpecial: facing && dist < 180 && (Math.floor(this.time * 2) + car.id) % 4 === 0, // ~1 tentativa a cada 2 s
      nextWeapon: false,
      turbo: !stuck && f > 0.9 && dist > 150,
    };
  }
}
