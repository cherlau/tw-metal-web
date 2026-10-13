// Armas, projéteis e pickups — regras PURAS (sem DOM/Three), testadas em tests/weapons.test.ts.
//
// NATIVO (SCUS_976.21, docs/NATIVE.md "Armas"): tabela dos 57 tipos de projétil (0x37cbf0+0xB930, montada por
// FUN_001fd4e0 → src/game/weapon-tables.ts), voo por tique (FUN_001fef00: FUN_001ff0a8 direção, FUN_001ffc98
// movimento, FUN_00200e28 colisão), detonação e área (FUN_002024a8 / FUN_00202d08), classes do inventário
// (FUN_0011d340), pickups (FUN_001bc6f8 / FUN_00120ba0) e renascimento (0x2c3a70, FUN_001bcc20).
// Unidades do jogo: pés e mph; 1 tique = 1/60 s.
import { add, dot, len, norm, scale, sub, v3, type V3 } from '../physics/vec';
import type { CollisionWorld } from '../physics/vehicle';
import { PICKUP_RESPAWN, PROJECTILE_FIELDS, PROJECTILES_HC, PROJECTILES_HO } from './weapon-tables';

const MPH = 1.4666667; // NATIVO: mph -> pés/s (FUN_0016b828)
const DEG = Math.PI / 180;
const TICK = 1 / 60;

/** Tabela nativa de pickups (0x2c3a00); o PKP guarda o índice. */
export const PICKUP_NAMES: Record<number, string> = {
  0: 'Machine Gun',
  1: 'Fire Missile',
  2: 'Homing Missile',
  3: 'Swarmer Missile',
  4: 'Napalm',
  5: 'Ricochet',
  6: 'Power Missile',
  7: 'Turbo',
  8: 'Health 30 Percent',
  9: 'Environment Attack',
  10: 'Upgrade',
  11: 'Remote Bomb',
  12: 'Full Health',
  14: 'Mega Gun',
};

// ------------------------------------------------------------------ tabela de projéteis

export interface ProjectileRule {
  damage: number;
  blastRadius: number;
  lifetime: number; // s
  speedMph: number;
  accel: number; // fração por tique rumo à velocidade
  groundFollow: number;
  homing: number; // 0 reto, 1 persegue, 2 antecipa
  turn: number; // fração do ângulo por tique
  lead: number;
  lockYaw: number; // graus
  lockPitch: number;
  turnLimit: number;
  turnNear: number;
  turnMaxFar: number;
  turnMaxNear: number;
  wobble: number;
  wobbleYaw: number;
  wobblePitch: number;
  wobbleFirst: number;
  wobbleMin: number;
  wobbleMax: number;
  ownFrame: number;
  spin: number;
  light: number;
  lightR: number;
  lightG: number;
  lightB: number;
  emitter: number;
  trail: number;
  explosion: number[];
  explosionScale: number[];
}

const decode = (rows: (number | number[])[][]): ProjectileRule[] =>
  rows.map((r) => Object.fromEntries(PROJECTILE_FIELDS.map((k, i) => [k, r[i]])) as unknown as ProjectileRule);

/** Tabela de projéteis do Head-On (DAT_002f4b14 = 0); as arenas de deathmatch rodam nesse modo. */
export const PROJECTILES: ProjectileRule[] = decode(PROJECTILES_HO);
/** A mesma tabela no modo Harbor City (DAT_002f4b14 = 1). */
export const PROJECTILES_HARBOR: ProjectileRule[] = decode(PROJECTILES_HC);

/** Tipos com detonação em área sem queda com a distância (FUN_00202d08: 0x2b, 0x33, Napalm, Remote, mina). */
const FULL_AREA = new Set([4, 10, 13, 43, 51]);
/** Balas (varredura por raio, FUN_0022bfe0 em FUN_00200e28). */
const BULLETS = new Set([0, 17, 18, 20]);
/** Balísticos (FUN_00191880 / FUN_00191be8). */
const BALLISTIC = new Set([4, 10, 13, 51]);
/** Ricochete (FUN_002003f8 / FUN_00201878). */
const RICOCHET = new Set([7, 42]);
/** Fantasma do Spectre (FUN_00201178): com alvo, só colide com ele. */
const GHOST = new Set([21, 52]);
/** Ficam parados esperando contato ou detonação manual (bit 0x80000000000 em FUN_001916b8). */
const STATIC_BOMB = new Set([10, 13]);

// ------------------------------------------------------------------ armas do inventário

export type WeaponId = 'machinegun' | 'special' | 'fire' | 'homing' | 'napalm' | 'power' | 'ricochet' | 'env' | 'swarmer' | 'remote';

export interface WeaponClass {
  name: string;
  /** tipo de arma do jogo (FUN_00120ba0; índice dos suportes e marcadores) */
  type: number;
  /** tipo de projétil (FUN_00147ec8 → FUN_00203b10) */
  proj: number;
  /** munição ao nascer (último argumento de FUN_00147420) */
  start: number;
  /** cone de trava em graus (0 = sem trava) e alcance em pés (FUN_0014b7d0: +0x5c = cos, +0x60 = alcance²) */
  lockDeg: number;
  range: number;
  /** tiques até poder disparar outra arma (carro+0x6300 = agora + obj+0x6c) */
  refire: number;
}

/**
 * Classes do inventário criadas em FUN_0011d340 (Head-On). Ordem do inventário carro+0x4fbc = nomes 0x2ba680:
 * 0 Special, 1 Fire, 2 Homing, 3 Napalm, 4 Power, 5 Ricochet, 6 Env, 7 Swarmer, 8 Remote.
 */
export const WEAPON_CLASSES: Record<Exclude<WeaponId, 'machinegun' | 'special'>, WeaponClass> = {
  fire: { name: 'Fire Missile', type: 2, proj: 2, start: 1, lockDeg: 14.5, range: 7000, refire: 48 },
  homing: { name: 'Homing Missile', type: 3, proj: 3, start: 1, lockDeg: 30.5, range: 7000, refire: 48 },
  napalm: { name: 'Napalm', type: 4, proj: 4, start: 0, lockDeg: 5, range: 7000, refire: 48 },
  power: { name: 'Power Missile', type: 6, proj: 6, start: 0, lockDeg: 0, range: 0, refire: 48 },
  ricochet: { name: 'Ricochet', type: 7, proj: 7, start: 0, lockDeg: 0, range: 7000, refire: 48 },
  env: { name: 'Environment Attack', type: 8, proj: -1, start: 0, lockDeg: 0, range: 0, refire: 48 },
  swarmer: { name: 'Swarmer Missile', type: 9, proj: 9, start: 0, lockDeg: 30, range: 7000, refire: 120 },
  remote: { name: 'Remote Bomb', type: 10, proj: 10, start: 0, lockDeg: 0, range: 0, refire: 48 },
};

export const INVENTORY_ORDER: WeaponId[] = ['special', 'fire', 'homing', 'napalm', 'power', 'ricochet', 'env', 'swarmer', 'remote'];

export const weaponName = (w: WeaponId): string => (w === 'machinegun' ? 'Machine Gun' : w === 'special' ? 'Special' : WEAPON_CLASSES[w].name);

/** Metralhadora (FUN_0014ad00 / FUN_0014ae38 / FUN_0014b738). */
export const MACHINE_GUN = {
  proj: 0,
  /** tiques entre tiros por modo (obj+0x5c/+0x60/+0x64): normal, melhorada, Mega Gun */
  interval: [10, 6, 6],
  heatMax: 100, // obj+0x94
  heatPerTick: 0.2, // obj+0x78, enquanto o botão está apertado
  heatRegen: 0.4, // obj+0x7c por tique, depois de 60 tiques solto
  regenDelay: 60,
  overheatTicks: 300, // obj+0x70
  overheatBelow: 0.1,
} as const;

/** Swarmer (FUN_0014d970): +1 míssil a cada 22 tiques segurando (gp−0x781c), até 6; solta sozinho em 132 + 78. */
export const SWARMER = { perMissile: 22, max: 6, autoFire: 22 * 6 + 78, pitchMin: 1, pitchMax: 20, yawSpread: 20 } as const;

// ------------------------------------------------------------------ pickups

export type PickupEffect =
  | { kind: 'weapon'; weapon: WeaponId; amount: number }
  | { kind: 'health'; amount: number }
  | { kind: 'turbo' }
  | { kind: 'none' };

/**
 * id do pickup → efeito (FUN_00120ba0, quantidade de FUN_001bc6f8: 2 no Head-On; a metralhadora daria 30 balas,
 * mas os PKP do Head-On não têm o tipo 0). Vida: +30 pontos (FUN_001bcbe0 grava 30 em 0x35b4d4) ou +100.
 */
export function pickupEffect(id: number): PickupEffect {
  switch (id) {
    case 1: return { kind: 'weapon', weapon: 'fire', amount: 2 };
    case 2: return { kind: 'weapon', weapon: 'homing', amount: 2 };
    case 3: return { kind: 'weapon', weapon: 'swarmer', amount: 2 };
    case 4: return { kind: 'weapon', weapon: 'napalm', amount: 2 };
    case 5: return { kind: 'weapon', weapon: 'ricochet', amount: 2 };
    case 6: return { kind: 'weapon', weapon: 'power', amount: 2 };
    case 7: return { kind: 'turbo' };
    case 8: return { kind: 'health', amount: 30 };
    case 9: return { kind: 'weapon', weapon: 'env', amount: 2 };
    case 11: return { kind: 'weapon', weapon: 'remote', amount: 2 };
    case 12: return { kind: 'health', amount: 100 };
    default: return { kind: 'none' };
  }
}

export const PICKUP_RULES = {
  radius: 9, // ⚠️ host: raio de coleta
  /** soma das armas do compartimento (carro+0x4fc4) — FUN_00120ba0 corta em 30 */
  weaponBay: 30,
  /** tiques até repetir a mensagem de compartimento cheio (agora > último + 0x78) */
  fullMessageTicks: 120,
} as const;

/** Faixa de renascimento em segundos (min, máx = mín·3/2) — coluna 0 = Head-On, um jogador (FUN_001bcc20). */
export function pickupRespawnRange(id: number, column = 0): [number, number] {
  const min = PICKUP_RESPAWN[id]?.[column] ?? 30;
  return [min, Math.floor((min * 3) / 2)];
}

// ------------------------------------------------------------------ alvo

export interface Target {
  id: number;
  pos: V3;
}

/**
 * Escolhe o alvo como o jogo (FUN_00102f50): distância ponderada pelo ângulo — atrás (dot < 0) ×3, dot < 0.3 ×2,
 * dot < 0.5 ×1.5, à frente ×1. Devolve o de menor distância ponderada dentro de maxRange.
 */
export function pickTarget(from: V3, forward: V3, targets: Target[], maxRange = Infinity): Target | null {
  let best: Target | null = null;
  let bestScore = maxRange;
  for (const t of targets) {
    const d = sub(t.pos, from);
    let dist = len(d);
    if (dist < 1e-6) continue;
    const c = dot(scale(d, 1 / dist), forward);
    if (c < 0) dist *= 3;
    else if (c < 0.3) dist *= 2;
    else if (c < 0.5) dist *= 1.5;
    if (dist < bestScore) {
      bestScore = dist;
      best = t;
    }
  }
  return best;
}

/**
 * Trava das armas (FUN_00147700(cos, alcance²)): o mais perto dentro do cone; sem ninguém no cone, cai na escolha
 * ponderada dentro do alcance (FUN_00147cf0). ⚠️ host: critério "mais perto" dentro do cone.
 */
export function lockTarget(from: V3, forward: V3, targets: Target[], coneDeg: number, range: number): Target | null {
  if (coneDeg <= 0) return null;
  const cos = Math.cos(coneDeg * DEG);
  let best: Target | null = null;
  let bestD = range;
  for (const t of targets) {
    const d = sub(t.pos, from);
    const dist = len(d);
    if (dist < 1e-6 || dist > bestD) continue;
    if (dot(scale(d, 1 / dist), forward) < cos) continue;
    bestD = dist;
    best = t;
  }
  return best ?? pickTarget(from, forward, targets, range);
}

// ------------------------------------------------------------------ projéteis

export interface Projectile {
  type: number;
  weapon: WeaponId;
  owner: number;
  pos: V3;
  prev: V3;
  /** direção (rumo e arfagem) e velocidade escalar ao longo dela, em pés/s */
  yaw: number;
  pitch: number;
  speed: number;
  /** velocidade vertical do mundo em pés/s (subida/queda dos balísticos e rente ao chão) */
  vy: number;
  /** tiques de vida e tiques máximos */
  age: number;
  life: number;
  target: number | null;
  /** modo de perseguição atual (cai para 0 quando perde a trava) */
  homing: number;
  damage: number;
  bounces: number;
  landed: boolean;
  /** detonação pedida pelo dono (segundo toque no Napalm/Remote/Hearse) */
  detonate: boolean;
  /** oscilação do Swarmer: tiques até trocar, alvo e velocidade angular atuais (rad/tique) */
  wobbleIn: number;
  wobbleAmp: number;
  wobbleGoal: [number, number];
  wobbleRate: [number, number];
  turnRate: number;
  alive: boolean;
  /** velocidade derivada (pés/s) para quem desenha/ouve */
  vel: V3;
}

export interface HitResult {
  projectile: Projectile;
  pos: V3;
  victim: number | null; // id do carro atingido diretamente
  /** Dono do triângulo do cenário atingido (objetos destrutíveis), quando o impacto foi no cenário. */
  tag?: number;
}

export interface CarBody {
  id: number;
  pos: V3; // centro aproximado
  radius: number;
  alive: boolean;
  vel?: V3;
}

export interface FireOptions {
  /** desvio de arfagem/rumo em rad (registros passados como param_3 de FUN_00147ec8) */
  pitch?: number;
  yaw?: number;
  /** velocidade do carro ao longo da frente (pés/s): o projétil parte dela (param_8 de FUN_00203b10) */
  carSpeed?: number;
  /** dano da instância (os especiais sobrescrevem instância+0x1c) */
  damage?: number;
  /** dobra o dano (balas com munição da metralhadora, fim de FUN_00203c68) */
  doubleDamage?: boolean;
  rand?: () => number;
}

const dirOf = (yaw: number, pitch: number): V3 => v3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** FUN_00253740/FUN_00253128: aproxima com fração por tique (corrigida para n tiques) e passo mínimo. */
function approach(cur: number, goal: number, rate: number, min: number, ticks: number): number {
  const r = ticks > 1 ? 1 - Math.pow(1 - rate, ticks) : rate * ticks;
  const d = goal - cur;
  let step = d * r;
  const m = min * ticks;
  if (Math.abs(step) < m) step = Math.sign(d) * m;
  return Math.abs(step) >= Math.abs(d) ? goal : cur + step;
}
const approachAngle = (cur: number, goal: number, rate: number, min: number, ticks: number) =>
  cur + (approach(0, wrap(goal - cur), rate, min, ticks));

export function fire(type: number, weapon: WeaponId, owner: number, origin: V3, forward: V3, target: number | null, o: FireOptions = {}): Projectile {
  const r = PROJECTILES[type] ?? PROJECTILES[2];
  const rand = o.rand ?? Math.random;
  const yaw = Math.atan2(forward.x, forward.z) + (o.yaw ?? 0);
  const pitch = Math.asin(Math.max(-1, Math.min(1, forward.y))) + (o.pitch ?? 0);
  let damage = o.damage ?? r.damage;
  if (o.doubleDamage) damage *= 2;
  let speed = Math.max(0, o.carSpeed ?? 0);
  let vy = 0;
  let life = r.lifetime * 60;
  // FUN_001916b8: Remote/mina caem quase parados; Napalm sobe a 2,5 pés/tique; ambos vivem 300 tiques (Napalm).
  if (STATIC_BOMB.has(type)) speed = 0.2445 * MPH;
  if (type === 4) {
    vy = 2.5 * 60;
    life = 300;
  } else if (type === 51) life = 300;
  const p: Projectile = {
    type, weapon, owner, pos: { ...origin }, prev: { ...origin }, yaw, pitch, speed, vy, age: 0, life,
    target: r.homing > 0 || GHOST.has(type) ? target : null, homing: r.homing, damage, bounces: 0, landed: false, detonate: false,
    wobbleIn: r.wobbleFirst, wobbleAmp: 1, wobbleGoal: [0, 0], wobbleRate: [0, 0], turnRate: r.turn, alive: true, vel: v3(),
  };
  if (type === 36) p.speed = Math.max(0, r.speedMph + (rand() * 200 - 100)) * MPH; // FUN_00203c68 caso 0x24
  p.vel = scale(dirOf(p.yaw, p.pitch), p.speed);
  return p;
}

/** Altura acima do chão (raio de 10 pés acima até 300 abaixo, FUN_00227b58). */
function heightAbove(world: CollisionWorld, p: V3, below = 300): { h: number; normal: V3 } | null {
  const hit = world.raycast(v3(p.x, p.y + 10, p.z), v3(0, -1, 0), 10 + below);
  return hit && hit.normal.y > 0.3 ? { h: hit.distance - 10, normal: hit.normal } : null;
}

/** Direção (FUN_001ff0a8 → FUN_001ff3a8): trava, giro limitado e oscilação. */
function steer(p: Projectile, r: ProjectileRule, cars: CarBody[], ticks: number, rand: () => number) {
  const tgt = p.target !== null ? cars.find((c) => c.id === p.target && c.alive) : undefined;
  if (p.homing === 0 || !tgt || p.age <= 2) return;
  let aim = tgt.pos;
  if (p.homing === 2 && tgt.vel) {
    // FUN_001ff298: antecipa pela velocidade do alvo × (distância / velocidade do projétil) × lead.
    const d = len(sub(tgt.pos, p.pos));
    const f = r.speedMph > 1 ? d / (r.speedMph * MPH) : 1;
    aim = add(tgt.pos, scale(tgt.vel, f * r.lead));
  }
  const to = sub(aim, p.pos);
  const dist = len(to);
  if (dist < 1e-6) return;
  const wantYaw = Math.atan2(to.x, to.z);
  const wantPitch = Math.asin(Math.max(-1, Math.min(1, to.y / dist)));
  const ey = wrap(wantYaw - p.yaw);
  const ep = wrap(wantPitch - p.pitch);
  // FUN_001ff5a0/FUN_001ff800: fora do cone de trava (sem oscilação) a trava cai e o projétil segue reto.
  if (!r.wobble && (Math.abs(ey) > r.lockYaw * DEG || Math.abs(ep) > r.lockPitch * DEG)) {
    p.target = null;
    p.homing = 0;
    return;
  }
  if (r.wobble) wobble(p, r, dist, ticks, rand);
  if (p.type === 18 && r.turnLimit && dist < r.turnNear) p.turnRate += p.turnRate * 0.05 * ticks;
  const ny = approachAngle(p.yaw, wantYaw, p.turnRate, 1e-4, ticks);
  const np = approachAngle(p.pitch, wantPitch, p.turnRate, 1e-4, ticks);
  if (r.turnLimit) {
    const max = (dist < r.turnNear ? r.turnMaxNear : r.turnMaxFar) * ticks;
    p.yaw += Math.max(-max, Math.min(max, wrap(ny - p.yaw)));
    p.pitch += Math.max(-max, Math.min(max, wrap(np - p.pitch)));
  } else {
    p.yaw = ny;
    p.pitch = np;
  }
  p.yaw += p.wobbleRate[0] * ticks;
  p.pitch += p.wobbleRate[1] * ticks;
}

/** FUN_001ffa18: troca o desvio a cada [min, máx] tiques; perto do alvo (300 pés) amortece, a 30 pés solta. */
function wobble(p: Projectile, r: ProjectileRule, dist: number, ticks: number, rand: () => number) {
  p.wobbleIn -= ticks;
  if (p.wobbleIn <= 0) {
    p.wobbleIn = r.wobbleMin + Math.floor(rand() * (r.wobbleMax - r.wobbleMin + 1));
    p.wobbleGoal = [(rand() * 2 - 1) * r.wobbleYaw * DEG, (rand() * 2 - 1) * r.wobblePitch * DEG];
  }
  if (dist < 300) {
    p.wobbleAmp = approach(p.wobbleAmp, 0, 0.25, 1e-3, ticks);
    p.turnRate = approach(p.turnRate, 0.25, 0.25, 2e-3, ticks);
  }
  if (dist < 30) p.homing = 0;
  const half = p.wobbleIn > (r.wobbleMin + r.wobbleMax) / 4;
  for (const k of [0, 1] as const) p.wobbleRate[k] = approach(p.wobbleRate[k], half ? p.wobbleGoal[k] * p.wobbleAmp * 0.1 : 0, 0.1, 1e-4, ticks);
}

/** Primeiro carro atingido pelo segmento a→b (esferas). */
function sweepCars(p: Projectile, a: V3, b: V3, cars: CarBody[], extra = 0, only: number | null = null): { id: number; pos: V3 } | null {
  const seg = sub(b, a);
  const L = len(seg);
  const dir = scale(seg, 1 / Math.max(L, 1e-9));
  let best: { id: number; pos: V3; t: number } | null = null;
  for (const c of cars) {
    if (!c.alive || (only !== null && c.id !== only)) continue;
    // O dono não se atinge com o próprio tiro na saída; bombas paradas só depois de 180 tiques (FUN_00191be8).
    if (c.id === p.owner && (!STATIC_BOMB.has(p.type) || p.age < 180)) continue;
    const t = Math.max(0, Math.min(L, dot(sub(c.pos, a), dir)));
    const at = add(a, scale(dir, t));
    if (len(sub(c.pos, at)) <= c.radius + extra && (!best || t < best.t)) best = { id: c.id, pos: at, t };
  }
  return best;
}

/**
 * Avança um projétil `dt` segundos (o jogo roda por tique; dt maior equivale a n tiques). Devolve o impacto
 * (carro, cenário ou fim da vida dos que explodem) ou null.
 */
export function stepProjectile(p: Projectile, dt: number, world: CollisionWorld, cars: CarBody[], rand: () => number = Math.random): HitResult | null {
  const r = PROJECTILES[p.type] ?? PROJECTILES[2];
  const ticks = dt / TICK;
  p.age += ticks;
  p.prev = { ...p.pos };
  if (p.detonate || p.age > p.life) {
    p.alive = false;
    return { projectile: p, pos: { ...p.pos }, victim: null };
  }
  const goal = r.speedMph * MPH;

  if (BALLISTIC.has(p.type)) {
    // FUN_00191880: velocidade rumo à da tabela, gravidade de 0,02 pés/tique² (só no ar).
    if (!p.landed) {
      p.speed = approach(p.speed, goal, p.speed <= goal ? r.accel : 1e-4, 1e-4 * 60, ticks);
      if (p.type === 10 || p.type === 13) p.speed = 0.2445 * MPH; // FUN_001916b8
      p.vy -= 0.02 * 3600 * dt;
      const flat = dirOf(p.yaw, 0);
      p.pos = add(p.pos, add(scale(flat, p.speed * dt), v3(0, p.vy * dt, 0)));
      // FUN_00191be8: chegou a 0,1 pé do chão (Napalm: 2) → pousa e fica (z = chão + folga).
      const g = heightAbove(world, p.pos, 100);
      const rest = p.type === 4 ? 2 : 0.1;
      if (g && g.h <= rest) {
        p.landed = true;
        p.pos = v3(p.pos.x, p.pos.y - g.h + rest, p.pos.z);
        p.speed = 0;
        p.vy = 0;
      }
    }
    p.vel = add(scale(dirOf(p.yaw, 0), p.speed), v3(0, p.vy, 0));
    // Pousado: raio de contato de 5 pés com carros (FUN_0022bfe0 com 5.0).
    const car = sweepCars(p, p.prev, p.pos, cars, p.landed ? 5 : 0);
    if (car) {
      p.alive = false;
      return { projectile: p, pos: car.pos, victim: STATIC_BOMB.has(p.type) || p.type === 4 ? null : car.id };
    }
    if (!p.landed && !STATIC_BOMB.has(p.type)) {
      const seg = sub(p.pos, p.prev);
      const L = len(seg);
      const hit = L > 1e-6 ? world.raycast(p.prev, scale(seg, 1 / L), L) : null;
      if (hit && hit.normal.y <= 0.3) {
        p.alive = false;
        return { projectile: p, pos: add(p.prev, scale(seg, hit.distance / L)), victim: null, tag: hit.tag };
      }
    }
    return null;
  }

  steer(p, r, cars, ticks, rand);
  // FUN_001ffc98: velocidade escalar rumo à da tabela (fração accel por tique; acima dela, quase nada).
  p.speed = approach(p.speed, goal, p.speed <= goal ? r.accel : 1e-4, 1e-4 * 60, ticks);
  let dir = dirOf(p.yaw, p.pitch);
  p.pos = add(p.pos, add(scale(dir, p.speed * dt), v3(0, p.vy * dt, 0)));

  if (r.groundFollow || RICOCHET.has(p.type)) {
    // FUN_001ffff8 / FUN_002003f8: rente ao chão (≥ 5 pés), afundando quando está alto e sem alvo.
    const g = heightAbove(world, p.pos);
    if (g) {
      if (g.h <= 5) {
        p.vy = 0;
        p.pos = v3(p.pos.x, approach(p.pos.y, p.pos.y - g.h + 5, 0.2, 1e-3, ticks), p.pos.z);
        if (p.target === null || RICOCHET.has(p.type)) p.pitch = approach(p.pitch, 0, 0.06, 1e-3, ticks);
      } else if (p.target === null || RICOCHET.has(p.type)) {
        if (RICOCHET.has(p.type)) p.pos = v3(p.pos.x, approach(p.pos.y, p.pos.y - g.h + 5, 0.1, 1e-3, ticks), p.pos.z);
        else p.vy = approach(p.vy, -0.5 * 60, 0.1, 1e-3, ticks);
        p.pitch = approach(p.pitch, 0, 0.08, 1e-3, ticks);
      }
    }
  }
  dir = dirOf(p.yaw, p.pitch);
  p.vel = add(scale(dir, p.speed), v3(0, p.vy, 0));

  const seg = sub(p.pos, p.prev);
  const L = len(seg);
  const ghostLocked = GHOST.has(p.type) && p.target !== null;
  const car = sweepCars(p, p.prev, p.pos, cars, 0, ghostLocked ? p.target : null);
  const hit = !ghostLocked && L > 1e-6 ? world.raycast(p.prev, scale(seg, 1 / L), L) : null;
  if (car && (!hit || len(sub(car.pos, p.prev)) <= hit.distance)) {
    p.alive = false;
    // Ricochete: depois do 1º quique o golpe vale ×3 no Head-On (FUN_00201878).
    if (RICOCHET.has(p.type) && p.bounces > 0 && p.type === 7) p.damage = r.damage * 3;
    return { projectile: p, pos: car.pos, victim: car.id };
  }
  if (hit) {
    const at = add(p.prev, scale(seg, hit.distance / L));
    if (RICOCHET.has(p.type)) {
      const n = hit.normal;
      if (n.y > 0.866) {
        // chão: desliza por cima (FUN_00201878, normal z > 0,866)
        p.pos = add(at, scale(n, 1));
        return null;
      }
      // parede: reflete a direção (FUN_002037d8) e conta o quique
      const flat = norm(v3(n.x, 0, n.z));
      const d0 = dirOf(p.yaw, 0);
      const rd = sub(d0, scale(flat, 2 * dot(d0, flat)));
      p.yaw = Math.atan2(rd.x, rd.z);
      p.pos = add(at, scale(flat, 1));
      p.bounces++;
      return null;
    }
    p.alive = false;
    return { projectile: p, pos: at, victim: null, tag: hit.tag };
  }
  return null;
}

/** Avalia se o projétil já não deve ser desenhado como bala (traçante) — balas são varridas por raio. */
export const isBullet = (type: number) => BULLETS.has(type);

/**
 * Dano de um impacto (FUN_00200e28 + FUN_00202d08): golpe direto = dano da instância; com raio > 0, todo carro no
 * raio leva dano·máx(0, 1 − d/raio), no mínimo 0,33·dano (Napalm/Remote/mina e 0x2b/0x33: dano cheio; Napalm
 * ×1,5 a ≥ 85 %). Só o Hearse (0x16) poupa o dono.
 */
export function damageFromHit(hit: HitResult, cars: CarBody[]): Map<number, number> {
  const p = hit.projectile;
  const r = PROJECTILES[p.type] ?? PROJECTILES[2];
  const out = new Map<number, number>();
  if (hit.victim !== null) out.set(hit.victim, p.damage);
  if (r.blastRadius > 0) {
    for (const c of cars) {
      if (!c.alive || (p.type === 22 && c.id === p.owner)) continue;
      const d = len(sub(c.pos, hit.pos));
      if (d > r.blastRadius) continue;
      const f = FULL_AREA.has(p.type) ? 1 : Math.max(0, 1 - d / r.blastRadius);
      let dmg = Math.max(p.damage * f, p.damage * 0.33);
      if (p.type === 4 && f >= 0.85) dmg *= 1.5;
      out.set(c.id, (out.get(c.id) ?? 0) + dmg);
    }
  }
  return out;
}
