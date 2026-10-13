// Regras de combate (puras) — tabela nativa de projéteis, voo, alvo, dano, pickups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  damageFromHit, fire, pickTarget, pickupEffect, pickupRespawnRange, PICKUP_NAMES, PROJECTILES, PROJECTILES_HARBOR, stepProjectile, type CarBody,
} from '../src/game/weapons';
import { SPECIALS } from '../src/game/specials';
import { v3 } from '../src/physics/vec';
import type { CollisionWorld } from '../src/physics/vehicle';

const empty: CollisionWorld = { raycast: () => null, closestPoint: () => null };
const wallAtZ = (z: number): CollisionWorld => ({
  raycast: (o, d, max) => {
    if (d.z <= 0) return null;
    const t = (z - o.z) / d.z;
    return t >= 0 && t <= max ? { distance: t, normal: v3(0, 0, -1) } : null;
  },
  closestPoint: () => null,
});
const flatGround: CollisionWorld = {
  raycast: (o, d, max) => {
    if (d.y >= 0 || o.y < 0) return null;
    const t = o.y / -d.y;
    return t <= max ? { distance: t, normal: v3(0, 1, 0) } : null;
  },
  closestPoint: () => null,
};
const fwd = v3(0, 0, 1);
const fly = (p: ReturnType<typeof fire>, world: CollisionWorld, cars: CarBody[], ticks: number) => {
  let hit = null;
  for (let i = 0; i < ticks && !hit; i++) hit = stepProjectile(p, 1 / 60, world, cars, () => 0.5);
  return hit;
};

test('ids de pickup batem com a tabela nativa 0x2c3a00', () => {
  assert.equal(PICKUP_NAMES[1], 'Fire Missile');
  assert.equal(PICKUP_NAMES[8], 'Health 30 Percent');
  assert.equal(PICKUP_NAMES[11], 'Remote Bomb');
  // FUN_001bc6f8: 2 de munição no Head-On; vida +30 pontos (0x35b4d4) ou +100.
  assert.deepEqual(pickupEffect(8), { kind: 'health', amount: 30 });
  assert.deepEqual(pickupEffect(12), { kind: 'health', amount: 100 });
  assert.deepEqual(pickupEffect(2), { kind: 'weapon', weapon: 'homing', amount: 2 });
});

test('tabela de projéteis emulada de FUN_001fd4e0', () => {
  // Metralhadora: dano 2 (HC 1), 750 mph, 1 s; Fire Missile 12 de dano, 600 mph (HC 250), persegue (modo 1).
  assert.deepEqual([PROJECTILES[0].damage, PROJECTILES[0].speedMph, PROJECTILES[0].lifetime], [2, 750, 1]);
  assert.equal(PROJECTILES_HARBOR[0].damage, 1);
  assert.deepEqual([PROJECTILES[2].damage, PROJECTILES[2].speedMph, PROJECTILES[2].homing], [12, 600, 1]);
  assert.equal(PROJECTILES_HARBOR[2].speedMph, 250);
  // Napalm: raio 120; Remote: 30 s; Homing: antecipa (modo 2); Swarmer oscila.
  assert.equal(PROJECTILES[4].blastRadius, 120);
  assert.equal(PROJECTILES[10].lifetime, 30);
  assert.equal(PROJECTILES[3].homing, 2);
  assert.equal(PROJECTILES[9].wobble, 1);
  // Luz do Fire Missile (255, 100, 25).
  assert.deepEqual([PROJECTILES[2].lightR, PROJECTILES[2].lightG, PROJECTILES[2].lightB], [255, 100, 25]);
});

test('renascimento dos pickups (0x2c3a70): 30–45 s, Remote 60–90 s', () => {
  assert.deepEqual(pickupRespawnRange(1), [30, 45]);
  assert.deepEqual(pickupRespawnRange(11), [60, 90]);
});

test('escolha de alvo nativa prefere quem está à frente', () => {
  const from = v3(0, 0, 0);
  // atrás a 30 (×3 = 90) perde para à frente a 60
  assert.equal(pickTarget(from, fwd, [{ id: 1, pos: v3(0, 0, -30) }, { id: 2, pos: v3(0, 0, 60) }])?.id, 2);
  // de lado (dot 0) a 40 (×2 = 80) perde para à frente a 70
  assert.equal(pickTarget(from, fwd, [{ id: 3, pos: v3(40, 0, 0) }, { id: 4, pos: v3(0, 0, 70) }])?.id, 4);
});

test('Power Missile reto acerta um carro à frente com o dano da tabela', () => {
  const cars: CarBody[] = [{ id: 7, pos: v3(0, 0, 100), radius: 5, alive: true }];
  const p = fire(6, 'power', 1, v3(0, 0, 0), fwd, null);
  const hit = fly(p, empty, cars, 120);
  assert.equal(hit?.victim, 7);
  assert.equal(damageFromHit(hit!, cars).get(7), PROJECTILES[6].damage);
});

test('Homing faz a curva até um alvo dentro do cone de trava', () => {
  const cars: CarBody[] = [{ id: 9, pos: v3(100, 0, 250), radius: 5, alive: true, vel: v3() }];
  const p = fire(3, 'homing', 1, v3(0, 0, 0), fwd, 9);
  assert.equal(fly(p, empty, cars, 5 * 60)?.victim, 9);
});

test('teleguiado perde a trava com o alvo fora do cone (FUN_001ff5a0)', () => {
  const cars: CarBody[] = [{ id: 9, pos: v3(200, 0, 10), radius: 5, alive: true, vel: v3() }];
  const p = fire(2, 'fire', 1, v3(0, 0, 0), fwd, 9);
  for (let i = 0; i < 10; i++) stepProjectile(p, 1 / 60, empty, cars);
  assert.equal(p.target, null);
  assert.equal(p.homing, 0);
});

test('ricochete quica na parede e triplica o dano; o míssil comum explode nela', () => {
  const r = fire(7, 'ricochet', 1, v3(0, 0, 0), fwd, null);
  fly(r, wallAtZ(50), [], 30);
  assert.ok(r.bounces >= 1 && Math.cos(r.yaw) < 0, 'deveria voltar após quicar');
  const back: CarBody[] = [{ id: 3, pos: v3(0, 0, -600), radius: 5, alive: true }];
  const hit = fly(r, empty, back, 120);
  assert.equal(hit?.victim, 3);
  assert.equal(damageFromHit(hit!, back).get(3), PROJECTILES[7].damage * 3);
  const m = fire(2, 'fire', 1, v3(0, 0, 0), fwd, null);
  const h2 = fly(m, wallAtZ(50), [], 60);
  assert.ok(h2 && Math.abs(h2.pos.z - 50) < 1e-6 && h2.victim === null);
});

test('Napalm sobe, cai no chão e queima até o fim da vida (300 tiques)', () => {
  const p = fire(4, 'napalm', 1, v3(0, 5, 0), fwd, null);
  let hit = null;
  let landedAt = -1;
  for (let i = 0; i < 400 && !hit; i++) {
    hit = stepProjectile(p, 1 / 60, flatGround, []);
    if (p.landed && landedAt < 0) landedAt = i;
  }
  assert.ok(landedAt > 0 && landedAt < 300, `pousou em ${landedAt}`);
  assert.ok(hit && hit.victim === null && Math.abs(hit.pos.y - 2) < 1e-6);
});

test('área: Napalm dá dano cheio ×1,5 em todo o raio; Hearse cai com a distância (mín. 33 %)', () => {
  const cars: CarBody[] = [
    { id: 1, pos: v3(3, 0, 0), radius: 2, alive: true },
    { id: 2, pos: v3(100, 0, 0), radius: 2, alive: true },
    { id: 3, pos: v3(130, 0, 0), radius: 2, alive: true },
  ];
  const nap = damageFromHit({ projectile: fire(4, 'napalm', 0, v3(), fwd, null), pos: v3(), victim: null }, cars);
  assert.equal(nap.get(1), PROJECTILES[4].damage * 1.5);
  assert.equal(nap.get(2), PROJECTILES[4].damage * 1.5);
  assert.equal(nap.get(3), undefined);
  const hearse = damageFromHit({ projectile: fire(22, 'special', 0, v3(), fwd, null), pos: v3(), victim: null }, cars);
  assert.ok((hearse.get(1) ?? 0) > (hearse.get(3) ?? 0));
  assert.ok((hearse.get(3) ?? 0) >= PROJECTILES[22].damage * 0.33 - 1e-9);
  assert.equal(hearse.get(0), undefined, 'o Hearse poupa o dono');
});

test('todo especial de projétil aponta para um tipo existente da tabela', () => {
  for (const [car, s] of Object.entries(SPECIALS)) {
    if (s.kind !== 'shots') continue;
    for (const shot of s.shots) assert.ok(PROJECTILES[shot.proj]?.speedMph > 0, `${car}: tipo ${shot.proj}`);
  }
});
