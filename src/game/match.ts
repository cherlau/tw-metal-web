// Partida de deathmatch — estado PURO (sem DOM/Three). O runtime (src/game.ts) só desenha e lê eventos.
// ⚠️ ESCOLHA DO HOST: vida, turbo, tempo da carcaça, navegação dos bots (ver docs/NATIVE.md para o que é nativo).
// Armas, pickups e especiais seguem as regras do jogo (src/game/weapons.ts, src/game/specials.ts).
import { add, len, scale, sub, v3, type V3 } from '../physics/vec';
import { createVehicle, forwardOf, stepVehicle, type CollisionWorld, type Controls, type VehicleShape, type VehicleState } from '../physics/vehicle';
import {
  damageFromHit, fire, INVENTORY_ORDER, isBullet, lockTarget, MACHINE_GUN, pickTarget, pickupEffect, pickupRespawnRange, PICKUP_RULES,
  stepProjectile, SWARMER, WEAPON_CLASSES, weaponName, type CarBody, type HitResult, type Projectile, type WeaponId,
} from './weapons';
import { SPECIAL_MAX, specialRecharge, SPECIALS, type SpecialShot } from './specials';
import { BotBrain, type AiProfile, type AiTables } from './ai';

const MPH = 1.4666667;

export const MATCH_RULES = {
  maxHealth: 100,
  respawnDelay: 3,
  turboMax: 100,
  turboDrain: 40, // por segundo
  turboRegen: 6,
  turboAccelMul: 1.5, // velocidade de equilíbrio ∝ acelerador → turbo ≈ 1,5 × vel. máx.
  botFireRange: 220,
} as const;

export interface CarActions extends Controls {
  fireGun: boolean;
  fireSpecial: boolean; // borda de subida
  /** botão da arma segurado (Swarmer carrega, 2º toque do Napalm/Remote); sem ele, o toque vale 1 tique */
  fireSpecialHeld?: boolean;
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
  /** tique a partir do qual outra arma pode disparar (carro+0x6300) */
  nextFire: number;
  /** tiques acumulados para +1 carga do especial (carro+0x62ee) */
  specialCharge: number;
  /** metralhadora: calor (obj+0x94), tiques de superaquecimento, próximo tiro e espera da recarga */
  mg: { heat: number; overheat: number; next: number; regenIn: number };
  /** estado do botão da arma no tique anterior */
  fireWasHeld: boolean;
  /** Swarmer carregando (tiques segurando) */
  swarmCharge: number | null;
  /** tiros agendados (especiais em sequência) */
  queue: { at: number; shot: SpecialShot; weapon: WeaponId; target: number | null }[];
  /** projétil esperando o 2º toque (Napalm, Remote, especiais com detonação) */
  armed: Projectile | null;
  /** especial corpo a corpo/choque em andamento */
  action: { kind: 'taser' | 'melee'; until: number; target: number | null; hit: Set<number>; airborne?: boolean } | null;
  /** giro visual do especial do Twister (rad) */
  spin: number;
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
  /** IA do jogo (src/game/ai.ts), criada no primeiro quadro do bot. */
  brain?: BotBrain;
  /** Índice do perfil de IA (tabela de nomes 0x2b39f0 / perfis 0x2b2d10). */
  aiIndex?: number;
  /** Tempo até poder causar dano de batida de novo (FUN_001349f0: 60 quadros). */
  ramCooldown?: number;
  /** Próximo instante em que a mensagem "Bay Full" pode repetir (s de partida). ⚠️ host */
  bayFullCooldown?: number;
}

/** WeaponId → índice do inventário do jogo (carro+0x4fbc; nomes 0x2ba680: 0 Special … 8 Remote). */
export const INVENTORY_INDEX: Partial<Record<WeaponId, number>> = Object.fromEntries(INVENTORY_ORDER.map((w, i) => [w, i]));

export interface Pickup {
  index: number;
  id: number; // id nativo (PKP word 8)
  pos: V3;
  respawnIn: number; // 0 = disponível
}

export type MatchEvent =
  /** Tiro da metralhadora (som e clarão); a bala é um projétil do tipo `type`. */
  | { kind: 'shot'; car: number; weapon: WeaponId; from: V3; to: V3; hitCar: boolean }
  /** Bala da metralhadora acertou (FUN_00153ff0: W_BUL_METAL no carro, W_BUL_DIRT no cenário). */
  | { kind: 'bulletHit'; pos: V3; car: boolean }
  /** Ricochete quicou numa parede (W_RICOCHET_BNCE). */
  | { kind: 'bounce'; pos: V3 }
  | { kind: 'launch'; car: number; weapon: WeaponId; pos: V3; type: number }
  | { kind: 'impact'; a: number; b: number; pos: V3; speed: number }
  | { kind: 'explosion'; pos: V3; weapon: WeaponId; type: number }
  /** Especial sem projétil (onda do Axel, choque do Cop, golpes): para efeito e som. */
  | { kind: 'special'; car: number; model: string; pos: V3; target?: number }
  /** Mensagem do jogo para o jogador (tabela 0x2ba4c0). */
  | { kind: 'message'; car: number; text: string }
  | { kind: 'hit'; car: number; amount: number; pos: V3 }
  /** Golpe direto no cenário (projétil ou metralhadora): `tag` = dono do triângulo na colisão. */
  | { kind: 'worldHit'; tag: number; weapon: WeaponId; amount: number; pos: V3; vel: V3 }
  /** Batida de carro numa parede do cenário (velocidade normal, pés/s). */
  | { kind: 'ram'; car: number; tag: number; speed: number; pos: V3 }
  | { kind: 'pickup'; car: number; pickupId: number; name: string }
  /** Pickup tocado com o compartimento cheio ("Weapons/Health/Turbo Bay Full", tabela 0x2ba4c0). */
  | { kind: 'bayFull'; car: number; bay: 'weapon' | 'health' | 'turbo' }
  | { kind: 'killed'; victim: number; killer: number | null; pos: V3 }
  | { kind: 'respawn'; car: number };

/** Perfil do Axel (0x2b2d10) — usado quando as tabelas da IA não foram carregadas (testes). */
const DEFAULT_PROFILE: AiProfile = { fleeHealth: 0.4, fireCone: 0.9, switchFrames: 16, waitFrames: 50, losHeight: 7, aggression: 0.7, retreatHealth: 0.3 };

export class Match {
  cars: Car[] = [];
  /** Tabelas da IA (rules/ai.json) e dificuldade 0..3 (FUN_00190448(0x2f4b24)). */
  ai: { tables: AiTables; difficulty: number } | null = null;
  pickups: Pickup[] = [];
  projectiles: Projectile[] = [];
  private events: MatchEvent[] = [];
  private time = 0;
  /** relógio da partida em tiques de 1/60 s */
  private get tick() {
    return Math.round(this.time * 60);
  }

  constructor(
    private readonly world: CollisionWorld,
    private readonly spawns: V3[],
    private readonly ground: (p: V3, shape: VehicleShape) => V3,
    private readonly rand: () => number = Math.random,
  ) {}

  addCar(name: string, model: string, shape: VehicleShape, bot: boolean, aiIndex?: number): Car {
    const id = this.cars.length;
    const car: Car = {
      id, name, model, bot, shape, aiIndex,
      state: createVehicle(v3()),
      health: MATCH_RULES.maxHealth, turbo: MATCH_RULES.turboMax,
      ammo: {}, selected: null, nextFire: 0, specialCharge: 0, mg: { heat: MACHINE_GUN.heatMax, overheat: 0, next: 0, regenIn: 0 }, fireWasHeld: false,
      swarmCharge: null, queue: [], armed: null, action: null, spin: 0,
      deadFor: 0, kills: 0, deaths: 0, botStuck: 0, botReverse: 0, boosting: false, braking: false, steer: 0, airFrames: 0,
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
    return this.cars.map((c) => ({ id: c.id, pos: this.center(c), radius: Math.max(3, Math.min(c.shape.halfWidth, c.shape.halfLength)), alive: c.deadFor === 0, vel: c.state.vel }));
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
    // Munição ao nascer (FUN_00147420: Fire 1, Homing 1, especial 1 se o carro tem classe de especial).
    car.ammo = {};
    for (const [w, c] of Object.entries(WEAPON_CLASSES)) if (c.start) car.ammo[w as WeaponId] = c.start;
    if (SPECIALS[car.model]) car.ammo.special = 1;
    car.selected = null;
    car.nextFire = 0;
    car.specialCharge = 0;
    car.mg = { heat: MACHINE_GUN.heatMax, overheat: 0, next: 0, regenIn: 0 };
    car.swarmCharge = null;
    car.queue = [];
    car.armed = null;
    car.action = null;
    car.spin = 0;
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
      const a = car.bot ? this.botActions(car, bodies) : actions.get(car.id) ?? NO_ACTIONS;
      // Turbo: aceleração extra enquanto houver carga.
      const boosting = a.turbo && car.turbo > 1 && a.throttle > 0;
      car.boosting = boosting;
      car.braking = a.brake > 0;
      car.steer = a.steer;
      car.turbo = Math.min(MATCH_RULES.turboMax, car.turbo + (boosting ? -MATCH_RULES.turboDrain : MATCH_RULES.turboRegen) * dt);
      // Com a tabela nativa o turbo entra no controlador (×3 aceleração, ×1,25 vel. máx.); sem ela, acelerador ×1,5.
      const throttle = boosting && !car.shape.drive ? MATCH_RULES.turboAccelMul : a.throttle;
      stepVehicle(car.state, car.shape, { ...a, throttle, turbo: boosting }, this.world, dt);
      car.ramCooldown = Math.max(0, (car.ramCooldown ?? 0) - dt);
      car.airFrames = car.state.grounded ? 0 : car.airFrames + 1;
      for (const k of car.state.contacts ?? []) this.events.push({ kind: 'ram', car: car.id, tag: k.tag, speed: k.speed, pos: k.point });
      this.weapons(car, a, bodies, dt);
    }
    this.collideCars();
    this.stepProjectiles(dt);
    this.stepPickups(dt);
  }

  /**
   * Carro × carro: círculos no plano (raio = meia-largura média ⚠️ host), separação e impulso ao longo da normal
   * com restituição 0,3 ⚠️ host, divididos pela massa nativa (carro+0x848). Dano de batida (FUN_001349f0): quem bate
   * a mais de 100 pés/s causa ramDamage·mín(v_rel − 100, 100)/100 no outro, no máximo a cada 60 quadros.
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
        const ma = a.shape.drive?.mass ?? 1;
        const mb = b.shape.drive?.mass ?? 1;
        const wa = mb / (ma + mb); // parte de a (o mais leve se move mais)
        const wb = ma / (ma + mb);
        a.state.pos = v3(a.state.pos.x - nx * overlap * wa, a.state.pos.y, a.state.pos.z - nz * overlap * wa);
        b.state.pos = v3(b.state.pos.x + nx * overlap * wb, b.state.pos.y, b.state.pos.z + nz * overlap * wb);
        const rel = (b.state.vel.x - a.state.vel.x) * nx + (b.state.vel.z - a.state.vel.z) * nz;
        if (rel < 0) {
          const at = v3(a.state.pos.x + dx / 2, a.state.pos.y, a.state.pos.z + dz / 2);
          if (rel < -15) this.events.push({ kind: 'impact', a: a.id, b: b.id, pos: at, speed: -rel });
          const j = -(1 + 0.3) * rel;
          a.state.vel = v3(a.state.vel.x - nx * j * wa, a.state.vel.y, a.state.vel.z - nz * j * wa);
          b.state.vel = v3(b.state.vel.x + nx * j * wb, b.state.vel.y, b.state.vel.z + nz * j * wb);
          const relSpeed = Math.hypot(b.state.vel.x - a.state.vel.x, b.state.vel.z - a.state.vel.z); // após o impulso
          const closing = Math.max(relSpeed, -rel);
          for (const [hitter, victim] of [[a, b], [b, a]] as const) {
            const d = hitter.shape.drive;
            if (!d || (hitter.ramCooldown ?? 0) > 0 || Math.hypot(hitter.state.vel.x, hitter.state.vel.z) <= 100 || closing <= 100) continue;
            hitter.ramCooldown = 1;
            this.damage(victim.id, (d.ramDamage * Math.min(closing - 100, 100)) / 100, hitter.id, at);
          }
        }
      }
    }
  }

  private weapons(car: Car, a: CarActions, bodies: CarBody[], dt: number) {
    const now = this.tick;
    const fwd = forwardOf(car.state.yaw);
    const targets = bodies.filter((b) => b.alive && b.id !== car.id).map((b) => ({ id: b.id, pos: b.pos }));
    const carSpeed = Math.max(0, car.state.vel.x * fwd.x + car.state.vel.z * fwd.z);

    // Carga do especial (FUN_0011ef10): +1 a cada carro+0x62f0 tiques até 5; parado em 5.
    if (SPECIALS[car.model]) {
      const n = car.ammo.special ?? 0;
      if (n >= SPECIAL_MAX) car.specialCharge = 0;
      else if ((car.specialCharge += dt * 60) > specialRecharge(car.model)) {
        car.ammo.special = n + 1;
        car.specialCharge = 0;
      }
    }

    // Troca (FUN_0014a3a8): próximo índice do inventário com munição.
    const owned = INVENTORY_ORDER.filter((w) => (car.ammo[w] ?? 0) > 0);
    if (!car.selected || !owned.includes(car.selected)) car.selected = owned[0] ?? null;
    if (a.nextWeapon && owned.length > 1) car.selected = owned[(owned.indexOf(car.selected!) + 1) % owned.length];

    this.machineGun(car, a.fireGun, fwd, carSpeed, dt);

    // Botão da arma: borda + estado segurado (o jogo lê o byte de estado do controle, controle+0x21).
    const held = a.fireSpecialHeld ?? a.fireSpecial;
    const pressed = a.fireSpecial || (held && !car.fireWasHeld);
    const released = !held && car.fireWasHeld;
    car.fireWasHeld = held;

    // Tiros agendados dos especiais em sequência.
    for (const q of car.queue.filter((q) => q.at <= now)) this.shoot(car, q.shot, q.weapon, q.target, carSpeed);
    car.queue = car.queue.filter((q) => q.at > now);
    this.stepAction(car, bodies, now);

    // Swarmer (FUN_0014d970): segurar carrega; soltar (ou passar de 210 tiques) dispara.
    if (car.swarmCharge !== null) {
      car.swarmCharge += dt * 60;
      if (released || !held || car.swarmCharge > SWARMER.autoFire) {
        const n = Math.min(SWARMER.max, Math.floor(car.swarmCharge / SWARMER.perMissile) + 1);
        const c = WEAPON_CLASSES.swarmer;
        const t = lockTarget(this.muzzle(car), fwd, targets, c.lockDeg, c.range);
        for (let i = 0; i < n; i++) {
          // FUN_0014dd00: arfagem U(1°, 20°) e rumo U(−20°, 20°) por míssil.
          const shot: SpecialShot = {
            proj: c.proj,
            pitch: (SWARMER.pitchMin + this.rand() * (SWARMER.pitchMax - SWARMER.pitchMin)) * (Math.PI / 180),
            yaw: (this.rand() * 2 - 1) * SWARMER.yawSpread * (Math.PI / 180),
          };
          this.shoot(car, shot, 'swarmer', t?.id ?? null, carSpeed);
        }
        car.ammo.swarmer = Math.max(0, (car.ammo.swarmer ?? 0) - 1);
        car.nextFire = now + c.refire;
        car.swarmCharge = null;
      }
      return;
    }

    const w = car.selected;
    if (!pressed || !w) return;
    // 2º toque com a mesma arma: explode/derruba o projétil armado (Napalm FUN_002009d0, Remote/especiais
    // FUN_002024a8) — cada classe cuida do seu (obj+0x40 = slot do projétil).
    if (car.armed && !car.armed.alive) car.armed = null;
    if (car.armed && car.armed.weapon === w) {
      if (car.armed.type === 4) {
        car.armed.vy = -30 * 60;
        car.armed.speed = 0;
      } else car.armed.detonate = true;
      car.armed = null;
      return;
    }
    if (now < car.nextFire || (car.ammo[w] ?? 0) <= 0) return;

    if (w === 'special') return this.special(car, fwd, targets, carSpeed, bodies);
    const c = WEAPON_CLASSES[w as Exclude<WeaponId, 'machinegun' | 'special'>];
    if (w === 'env') {
      // Ataque de ambiente (tipo 8, FUN_0014cf78): evento próprio de cada arena — ⚠️ não feito ("Env Weapon Unavailable").
      this.events.push({ kind: 'message', car: car.id, text: 'Env Weapon Unavailable' });
      car.nextFire = now + c.refire;
      return;
    }
    if (w === 'swarmer') {
      car.swarmCharge = 0;
      return;
    }
    const t = lockTarget(this.muzzle(car), fwd, targets, c.lockDeg, c.range);
    const p = this.shoot(car, { proj: c.proj }, w, t?.id ?? null, carSpeed);
    if (w === 'napalm' || w === 'remote') car.armed = p;
    car.ammo[w] = (car.ammo[w] ?? 0) - 1;
    car.nextFire = now + c.refire;
  }

  /** Ponto de saída dos tiros. ⚠️ host: à frente do carro (o jogo usa os marcadores 0x00F8 de cada arma). */
  muzzle(car: Car): V3 {
    const fwd = forwardOf(car.state.yaw);
    return add(this.center(car), add(scale(fwd, car.shape.halfLength + 2), v3(0, 1, 0)));
  }

  private shoot(car: Car, shot: SpecialShot, weapon: WeaponId, target: number | null, carSpeed: number): Projectile {
    const fwd = forwardOf(car.state.yaw);
    const origin = this.muzzle(car);
    let last!: Projectile;
    for (let i = 0; i < (shot.count ?? 1); i++) {
      const pr = shot.pitchRange;
      const yr = shot.yawRange;
      const p = fire(shot.proj, weapon, car.id, origin, fwd, target, {
        pitch: (shot.pitch ?? 0) + (pr ? pr[0] + this.rand() * (pr[1] - pr[0]) : 0),
        yaw: (shot.yaw ?? 0) + (yr ? yr[0] + this.rand() * (yr[1] - yr[0]) : 0),
        carSpeed, damage: shot.damage, rand: this.rand,
      });
      this.projectiles.push(p);
      last = p;
    }
    this.events.push({ kind: 'launch', car: car.id, weapon, pos: origin, type: shot.proj });
    return last;
  }

  /**
   * Metralhadora (FUN_0014ae38): um tiro a cada 10 tiques enquanto segura; o calor cai 0,2 por tique segurando e
   * volta 0,4 por tique 60 tiques depois de soltar; abaixo de 0,1 trava por 300 tiques e volta cheio.
   */
  private machineGun(car: Car, held: boolean, fwd: V3, carSpeed: number, dt: number) {
    const g = car.mg;
    const ticks = dt * 60;
    const now = this.tick;
    if (g.overheat > 0) {
      g.overheat -= ticks;
      if (g.overheat <= 0) g.heat = MACHINE_GUN.heatMax;
      return;
    }
    if (!held) {
      if ((g.regenIn -= ticks) <= 0) g.heat = Math.min(MACHINE_GUN.heatMax, g.heat + MACHINE_GUN.heatRegen * ticks);
      return;
    }
    g.regenIn = MACHINE_GUN.regenDelay;
    g.heat -= MACHINE_GUN.heatPerTick * ticks;
    if (g.heat < MACHINE_GUN.overheatBelow) {
      g.overheat = MACHINE_GUN.overheatTicks;
      return;
    }
    if (now < g.next) return;
    g.next = now + MACHINE_GUN.interval[0];
    // Mira automática só para alguns carros do jogador humano (FUN_00147700 com cone de 7,5°). ⚠️ host: todos retos.
    const origin = this.muzzle(car);
    const p = fire(MACHINE_GUN.proj, 'machinegun', car.id, origin, fwd, null, { carSpeed, doubleDamage: (car.ammo.machinegun ?? 0) > 1, rand: this.rand });
    this.projectiles.push(p);
    this.events.push({ kind: 'shot', car: car.id, weapon: 'machinegun', from: origin, to: add(origin, scale(fwd, 30)), hitCar: false });
  }

  /** Dispara o especial do carro (src/game/specials.ts). */
  private special(car: Car, fwd: V3, targets: { id: number; pos: V3 }[], carSpeed: number, bodies: CarBody[]) {
    const rule = SPECIALS[car.model];
    if (!rule) return;
    const now = this.tick;
    car.ammo.special = (car.ammo.special ?? 0) - 1;
    car.nextFire = now + rule.refire;
    const origin = this.muzzle(car);
    if (rule.kind === 'shots') {
      const t = rule.lockDeg > 0 ? lockTarget(origin, fwd, targets, rule.lockDeg, 7000) : pickTarget(origin, fwd, targets, 7000);
      let first: Projectile | null = null;
      for (const s of rule.shots) {
        if ((s.at ?? 0) > 0) car.queue.push({ at: now + (s.at ?? 0), shot: s, weapon: 'special', target: t?.id ?? null });
        else first ??= this.shoot(car, s, 'special', t?.id ?? null, carSpeed);
      }
      if (rule.detonate && first) car.armed = first;
      return;
    }
    this.events.push({ kind: 'special', car: car.id, model: car.model, pos: this.center(car) });
    if (rule.kind === 'shockwave') {
      // FUN_00116940: todos no raio (menos o dono) levam o dano e sobem a liftMph·1,4667 pés/s.
      for (const b of bodies) {
        if (!b.alive || b.id === car.id || len(sub(b.pos, this.center(car))) > rule.radius) continue;
        const v = this.cars[b.id];
        v.state.vel = add(v.state.vel, v3(0, rule.liftMph * MPH, 0));
        this.damage(b.id, rule.damage, car.id, b.pos);
      }
      return;
    }
    if (rule.kind === 'taser') {
      const t = pickTarget(this.center(car), fwd, targets, rule.range);
      car.action = { kind: 'taser', until: now + rule.ticks, target: t?.id ?? null, hit: new Set() };
      return;
    }
    // melee (⚠️ host)
    car.action = { kind: 'melee', until: now + rule.ticks, target: null, hit: new Set() };
    if (rule.boostMph) car.state.vel = add(car.state.vel, scale(fwd, rule.boostMph * MPH));
    if (rule.jumpMph) {
      car.state.vel = add(car.state.vel, v3(0, rule.jumpMph * MPH * 0.5, 0));
      car.action.airborne = true;
    }
  }

  /** Especiais que duram (choque do Cop, golpes corpo a corpo). */
  private stepAction(car: Car, bodies: CarBody[], now: number) {
    const act = car.action;
    const rule = SPECIALS[car.model];
    if (!act || !rule) return;
    const me = this.center(car);
    if (rule.kind === 'taser') {
      const b = act.target !== null ? bodies.find((x) => x.id === act.target && x.alive) : undefined;
      if (!b || len(sub(b.pos, me)) > rule.range) act.target = null; // FUN_001b86b8: fora do alcance solta
      else {
        const v = this.cars[b.id];
        v.state.vel = scale(v.state.vel, 0.9); // ⚠️ host: o choque segura o alvo
        this.damage(b.id, rule.perTick, car.id, b.pos);
      }
    } else if (rule.kind === 'melee') {
      if (rule.spin) car.spin += rule.spin;
      if (rule.landRadius) {
        if (act.airborne && car.state.grounded && now > act.until - rule.ticks + 10) {
          act.airborne = false;
          for (const b of bodies) {
            if (!b.alive || b.id === car.id || len(sub(b.pos, me)) > rule.landRadius) continue;
            this.damage(b.id, rule.damage, car.id, b.pos);
          }
          this.events.push({ kind: 'special', car: car.id, model: car.model, pos: me });
        }
      } else {
        for (const b of bodies) {
          if (!b.alive || b.id === car.id || act.hit.has(b.id)) continue;
          const r = Math.max(car.shape.halfWidth, car.shape.halfLength) + rule.reach;
          if (len(sub(b.pos, me)) > r) continue;
          act.hit.add(b.id);
          const v = this.cars[b.id];
          const away = sub(b.pos, me);
          const L = Math.max(len(away), 1e-3);
          v.state.vel = add(v.state.vel, add(scale(v3(away.x / L, 0, away.z / L), rule.pushMph * MPH * 0.2), v3(0, rule.liftMph * MPH, 0)));
          this.damage(b.id, rule.damage, car.id, b.pos);
        }
      }
    }
    if (now >= act.until && !act.airborne) {
      car.action = null;
      car.spin = 0;
    }
  }

  private stepProjectiles(dt: number) {
    const bodies = this.bodies();
    for (const p of this.projectiles) {
      const bounces = p.bounces;
      const hit = stepProjectile(p, dt, this.world, bodies, this.rand);
      if (p.bounces > bounces) this.events.push({ kind: 'bounce', pos: { ...p.pos } });
      if (hit) this.detonate(hit, bodies);
    }
    this.projectiles = this.projectiles.filter((p) => p.alive);
  }

  private detonate(hit: HitResult, bodies: CarBody[]) {
    const p = hit.projectile;
    if (hit.tag !== undefined && hit.victim === null)
      this.events.push({ kind: 'worldHit', tag: hit.tag, weapon: p.weapon, amount: p.damage, pos: hit.pos, vel: p.vel });
    if (isBullet(p.type)) this.events.push({ kind: 'bulletHit', pos: hit.pos, car: hit.victim !== null });
    else this.events.push({ kind: 'explosion', pos: hit.pos, weapon: p.weapon, type: p.type });
    for (const [id, dmg] of damageFromHit(hit, bodies)) this.damage(id, dmg, p.owner, hit.pos);
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
      this.events.push({ kind: 'explosion', pos: this.center(car), weapon: 'power', type: 6 });
    }
  }

  /**
   * Pickups (FUN_001bc6f8 → FUN_00120ba0): arma +2 até a soma do compartimento chegar a 30; vida +30/+100 só se
   * faltar vida; turbo enche só se não estiver cheio. Recusado = fica no lugar e avisa "… Bay Full" (a cada 120
   * tiques). Volta depois de U(mín, mín·3/2) s (0x2c3a70, FUN_001bc970).
   */
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
        const full = (bay: 'weapon' | 'health' | 'turbo') => {
          if ((car.bayFullCooldown ?? 0) <= this.time) this.events.push({ kind: 'bayFull', car: car.id, bay });
          car.bayFullCooldown = this.time + PICKUP_RULES.fullMessageTicks / 60;
        };
        if (eff.kind === 'weapon') {
          const total = INVENTORY_ORDER.reduce((s, w) => s + (car.ammo[w] ?? 0), 0);
          if (total >= PICKUP_RULES.weaponBay) {
            full('weapon');
            continue;
          }
          car.ammo[eff.weapon] = (car.ammo[eff.weapon] ?? 0) + Math.min(eff.amount, PICKUP_RULES.weaponBay - total);
        } else if (eff.kind === 'health') {
          if (car.health >= MATCH_RULES.maxHealth) {
            full('health');
            continue;
          }
          car.health = Math.min(MATCH_RULES.maxHealth, car.health + eff.amount);
        } else if (eff.kind === 'turbo') {
          if (car.turbo >= MATCH_RULES.turboMax) {
            full('turbo');
            continue;
          }
          car.turbo = MATCH_RULES.turboMax;
        }
        const [lo, hi] = pickupRespawnRange(p.id);
        p.respawnIn = (lo * 60 + Math.floor(this.rand() * ((hi - lo) * 60 + 1))) / 60;
        this.events.push({ kind: 'pickup', car: car.id, pickupId: p.id, name: eff.kind === 'weapon' ? weaponName(eff.weapon) : eff.kind === 'health' ? 'Health' : 'Turbo' });
        break;
      }
    }
  }

  private brainOf(car: Car): BotBrain {
    if (!car.brain) {
      const t = this.ai?.tables;
      const i = car.aiIndex ?? -1;
      const profile = t?.profiles[i] ?? DEFAULT_PROFILE;
      const empty = new Array<number>(15).fill(0);
      const tables: AiTables = t ?? { profiles: [], front: [], rear: [], range: { max: [], min: [], dot: [] } };
      car.brain = new BotBrain(profile, t?.front[i] ?? empty, t?.rear[i] ?? empty, tables, this.ai?.difficulty ?? 1);
    }
    return car.brain;
  }

  /** Linha de visada entre dois carros na altura do perfil (FUN_00105520 → FUN_00229780). */
  private lineOfSight(a: Car, b: Car, height: number): boolean {
    const from = add(a.state.pos, v3(0, height, 0));
    const to = add(b.state.pos, v3(0, height, 0));
    const d = sub(to, from);
    const L = len(d);
    return L < 1e-3 || !this.world.raycast(from, scale(d, 1 / L), L);
  }

  /**
   * IA do bot (src/game/ai.ts, regras do ELF) + navegação do host: mira direto no alvo (ou na vida mais perto ao
   * recuar) e dá ré quando atola.
   */
  private botActions(car: Car, bodies: CarBody[]): CarActions {
    const brain = this.brainOf(car);
    const pos = car.state.pos;
    const fwd = forwardOf(car.state.yaw);
    const targets = bodies.filter((b) => b.alive && b.id !== car.id).map((b) => ({ id: b.id, pos: b.pos }));
    const target = pickTarget(this.center(car), fwd, targets);
    const tc = target ? this.cars[target.id] : null;
    // Recuo: vida abaixo do limiar do perfil -> vida mais perto (FUN_001049a8 → modo 2).
    const health01 = car.health / MATCH_RULES.maxHealth;
    const lowHealth = health01 < brain.retreatAt;
    let goal = target?.pos ?? null;
    if (lowHealth || !goal) {
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
      if (best) goal = best.pos;
    }
    if (!goal) return { ...NO_ACTIONS, throttle: 0.6, steer: 0.3 };
    const to = sub(goal, pos);
    const dist = len(to);
    const right = v3(-Math.cos(car.state.yaw), 0, Math.sin(car.state.yaw));
    const f = (to.x * fwd.x + to.z * fwd.z) / Math.max(dist, 1e-6);
    const r = (to.x * right.x + to.z * right.z) / Math.max(dist, 1e-6);
    const ang = Math.atan2(r, f);
    const speed = Math.hypot(car.state.vel.x, car.state.vel.z);
    // Visão do alvo para a IA (+0x308 distância, +0x2c4 alinhamento, +0x2d4 alvo virado para mim).
    let view = { dist: 1e9, align: -1, targetFacing: -1, targetSpeedMph: 0, visible: false };
    if (tc) {
      const d = sub(tc.state.pos, pos);
      const L = Math.max(len(d), 1e-6);
      const tf = forwardOf(tc.state.yaw);
      view = {
        dist: L,
        align: (d.x * fwd.x + d.z * fwd.z) / L,
        targetFacing: -(d.x * tf.x + d.z * tf.z) / L,
        targetSpeedMph: Math.hypot(tc.state.vel.x, tc.state.vel.z) * 0.6818182,
        visible: this.lineOfSight(car, tc, brain.profile.losHeight),
      };
    }
    const out = brain.step({
      ...view,
      health01,
      turbo01: car.turbo / MATCH_RULES.turboMax,
      speed,
      steerAngle: ang,
      ammo: car.ammo,
      selected: car.selected,
    });
    if (out.grant) car.ammo[out.grant] = Math.max(car.ammo[out.grant] ?? 0, 1); // FUN_00107148
    // ⚠️ host: atolado por 1,5 s (90 quadros abaixo de 4,4 pés/s) → 1 s de ré girando.
    if (car.botReverse > 0) car.botReverse -= 1 / 60;
    else if (brain.stuck > 90 && dist > 20) {
      car.botReverse = 1;
      brain.stuck = 0;
    }
    const stuck = car.botReverse > 0;
    return {
      throttle: stuck ? 0 : 1,
      brake: stuck ? 1 : 0,
      steer: stuck ? -Math.sign(ang) : Math.max(-1, Math.min(1, ang * 2)),
      handbrake: Math.abs(ang) > 1.4 && speed > 40,
      fireGun: out.fireGun && !lowHealth,
      fireSpecial: out.fireSpecial,
      nextWeapon: out.nextWeapon,
      turbo: !stuck && out.turbo,
    };
  }
}
