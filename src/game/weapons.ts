// Armas, projéteis e pickups — regras PURAS (sem DOM/Three), testadas em tests/weapons.test.ts.
//
// NATIVO (SCUS_976.21, docs/NATIVE.md): ids/nomes dos pickups (tabela 0x2c3a00, índice = word 8 do PKP),
// regra de escolha de alvo (FUN_00102f50), unidades em pés/mph, gravidade 64,4 pés/s².
// ⚠️ ESCOLHA DO HOST (provisório): dano, velocidade, munição, curva dos teleguiados, tempos de recarga.
import { add, dot, len, norm, scale, sub, v3, type V3 } from '../physics/vec';
import { VEHICLE_RULES, type CollisionWorld } from '../physics/vehicle';

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

export type WeaponId = 'machinegun' | 'fire' | 'homing' | 'swarmer' | 'napalm' | 'ricochet' | 'power' | 'remote';

export interface WeaponRule {
  name: string;
  damage: number;
  speed: number; // pés/s
  ammoPerPickup: number;
  cooldown: number; // s entre disparos
  homing: number; // rad/s de curva (0 = reto)
  gravity: boolean; // balístico (napalm)
  bounces: number; // ricochetes
  lifetime: number; // s
  blastRadius: number; // pés (dano em área com queda linear)
  count: number; // projéteis por disparo (swarmer)
  spread: number; // rad
}

const MPH = 1.4666667; // NATIVO: mph -> pés/s

export const WEAPON_RULES: Record<WeaponId, WeaponRule> = {
  machinegun: { name: 'Machine Gun', damage: 1.5, speed: 900, ammoPerPickup: Infinity, cooldown: 0.08, homing: 0, gravity: false, bounces: 0, lifetime: 0.6, blastRadius: 0, count: 1, spread: 0.02 },
  fire: { name: 'Fire Missile', damage: 14, speed: 140 * MPH, ammoPerPickup: 2, cooldown: 0.5, homing: 1.2, gravity: false, bounces: 0, lifetime: 4, blastRadius: 8, count: 1, spread: 0 },
  homing: { name: 'Homing Missile', damage: 10, speed: 120 * MPH, ammoPerPickup: 2, cooldown: 0.5, homing: 3.0, gravity: false, bounces: 0, lifetime: 6, blastRadius: 8, count: 1, spread: 0 },
  swarmer: { name: 'Swarmer Missile', damage: 4, speed: 110 * MPH, ammoPerPickup: 1, cooldown: 1, homing: 2.2, gravity: false, bounces: 0, lifetime: 5, blastRadius: 5, count: 5, spread: 0.35 },
  napalm: { name: 'Napalm', damage: 22, speed: 90 * MPH, ammoPerPickup: 1, cooldown: 1, homing: 0, gravity: true, bounces: 0, lifetime: 5, blastRadius: 18, count: 1, spread: 0 },
  ricochet: { name: 'Ricochet', damage: 18, speed: 130 * MPH, ammoPerPickup: 1, cooldown: 0.8, homing: 0, gravity: false, bounces: 3, lifetime: 6, blastRadius: 10, count: 1, spread: 0 },
  power: { name: 'Power Missile', damage: 40, speed: 160 * MPH, ammoPerPickup: 1, cooldown: 1, homing: 0, gravity: false, bounces: 0, lifetime: 4, blastRadius: 14, count: 1, spread: 0 },
  remote: { name: 'Remote Bomb', damage: 35, speed: 60 * MPH, ammoPerPickup: 1, cooldown: 1, homing: 0, gravity: true, bounces: 0, lifetime: 8, blastRadius: 25, count: 1, spread: 0 },
};

/** id do pickup (PKP) -> efeito. Environment Attack/Upgrade ficam para depois (específicos de arena/modo). */
export type PickupEffect = { kind: 'weapon'; weapon: WeaponId } | { kind: 'health'; fraction: number } | { kind: 'turbo' } | { kind: 'none' };

export function pickupEffect(id: number): PickupEffect {
  switch (id) {
    case 1: return { kind: 'weapon', weapon: 'fire' };
    case 2: return { kind: 'weapon', weapon: 'homing' };
    case 3: return { kind: 'weapon', weapon: 'swarmer' };
    case 4: return { kind: 'weapon', weapon: 'napalm' };
    case 5: return { kind: 'weapon', weapon: 'ricochet' };
    case 6: return { kind: 'weapon', weapon: 'power' };
    case 7: return { kind: 'turbo' };
    case 8: return { kind: 'health', fraction: 0.3 };
    case 11: return { kind: 'weapon', weapon: 'remote' };
    case 12: return { kind: 'health', fraction: 1 };
    default: return { kind: 'none' };
  }
}

export const PICKUP_RULES = { radius: 9, respawn: 20, maxAmmo: 9 } as const; // escolha do host

// ------------------------------------------------------------------ alvo (NATIVO, FUN_00102f50)

export interface Target {
  id: number;
  pos: V3;
}

/**
 * Escolhe o alvo como o jogo: distância ponderada pelo ângulo — atrás (dot < 0) ×3, dot < 0.3 ×2,
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

// ------------------------------------------------------------------ projéteis

export interface Projectile {
  weapon: WeaponId;
  owner: number;
  pos: V3;
  vel: V3;
  age: number;
  bounces: number;
  target: number | null;
  alive: boolean;
}

export interface HitResult {
  projectile: Projectile;
  pos: V3;
  victim: number | null; // id do carro atingido diretamente
}

export interface CarBody {
  id: number;
  pos: V3; // centro aproximado
  radius: number;
  alive: boolean;
}

export function fire(weapon: WeaponId, owner: number, origin: V3, forward: V3, target: number | null, seed = 0): Projectile[] {
  const r = WEAPON_RULES[weapon];
  const out: Projectile[] = [];
  for (let i = 0; i < r.count; i++) {
    const a = r.count > 1 ? (i / (r.count - 1) - 0.5) * 2 * r.spread : r.spread * Math.sin(seed * 12.9898 + i);
    // gira a direção em torno do eixo vertical
    const dir = norm(v3(forward.x * Math.cos(a) - forward.z * Math.sin(a), forward.y + (r.gravity ? 0.35 : 0), forward.x * Math.sin(a) + forward.z * Math.cos(a)));
    out.push({ weapon, owner, pos: { ...origin }, vel: scale(dir, r.speed), age: 0, bounces: 0, target, alive: true });
  }
  return out;
}

/** Avança um projétil; devolve o impacto (parede, chão ou carro) ou null. */
export function stepProjectile(p: Projectile, dt: number, world: CollisionWorld, cars: CarBody[]): HitResult | null {
  const r = WEAPON_RULES[p.weapon];
  p.age += dt;
  if (p.age > r.lifetime) {
    p.alive = false;
    return r.blastRadius > 0 ? { projectile: p, pos: { ...p.pos }, victim: null } : null;
  }
  // Teleguiado: gira a velocidade em direção ao alvo até `homing` rad/s.
  const tgt = p.target !== null ? cars.find((c) => c.id === p.target && c.alive) : undefined;
  if (r.homing > 0 && tgt) {
    const speed = len(p.vel);
    const want = norm(sub(tgt.pos, p.pos));
    const have = scale(p.vel, 1 / speed);
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(want, have))));
    const t = ang > 1e-6 ? Math.min(1, (r.homing * dt) / ang) : 1;
    p.vel = scale(norm(add(scale(have, 1 - t), scale(want, t))), speed);
  }
  if (r.gravity) p.vel = add(p.vel, v3(0, -VEHICLE_RULES.gravity * dt, 0));

  const step = scale(p.vel, dt);
  const dist = len(step);
  const dir = scale(step, 1 / Math.max(dist, 1e-9));
  // Carros: interseção do segmento com esferas.
  for (const c of cars) {
    if (!c.alive || c.id === p.owner) continue;
    const oc = sub(c.pos, p.pos);
    const t = Math.max(0, Math.min(dist, dot(oc, dir)));
    const closest = add(p.pos, scale(dir, t));
    if (len(sub(c.pos, closest)) <= c.radius) {
      p.alive = false;
      return { projectile: p, pos: closest, victim: c.id };
    }
  }
  // Cenário.
  const hit = world.raycast(p.pos, dir, dist);
  if (hit) {
    const at = add(p.pos, scale(dir, hit.distance));
    if (p.bounces < r.bounces) {
      p.bounces++;
      const n = hit.normal;
      p.vel = sub(p.vel, scale(n, 2 * dot(p.vel, n)));
      p.pos = add(at, scale(n, 0.5));
      return null;
    }
    p.alive = false;
    return { projectile: p, pos: at, victim: null };
  }
  p.pos = add(p.pos, step);
  return null;
}

/** Dano de um impacto: direto na vítima + área com queda linear para os demais. */
export function damageFromHit(hit: HitResult, cars: CarBody[]): Map<number, number> {
  const r = WEAPON_RULES[hit.projectile.weapon];
  const out = new Map<number, number>();
  if (hit.victim !== null) out.set(hit.victim, r.damage);
  if (r.blastRadius > 0) {
    for (const c of cars) {
      if (!c.alive || c.id === hit.victim) continue;
      const d = len(sub(c.pos, hit.pos)) - c.radius;
      if (d < r.blastRadius) out.set(c.id, (out.get(c.id) ?? 0) + r.damage * 0.6 * (1 - Math.max(0, d) / r.blastRadius));
    }
  }
  return out;
}
