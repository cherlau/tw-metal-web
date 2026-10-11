// Regras de combate (puras) — projéteis, alvo, dano, pickups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { damageFromHit, fire, pickTarget, pickupEffect, PICKUP_NAMES, stepProjectile, WEAPON_RULES, type CarBody } from '../src/game/weapons';
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

test('ids de pickup batem com a tabela nativa 0x2c3a00', () => {
  assert.equal(PICKUP_NAMES[1], 'Fire Missile');
  assert.equal(PICKUP_NAMES[2], 'Homing Missile');
  assert.equal(PICKUP_NAMES[8], 'Health 30 Percent');
  assert.equal(PICKUP_NAMES[11], 'Remote Bomb');
  assert.deepEqual(pickupEffect(8), { kind: 'health', fraction: 0.3 });
  assert.deepEqual(pickupEffect(2), { kind: 'weapon', weapon: 'homing' });
});

test('escolha de alvo nativa prefere quem está à frente', () => {
  const from = v3(0, 0, 0);
  const fwd = v3(0, 0, 1);
  // atrás a 30 (×3 = 90) perde para à frente a 60
  const t = pickTarget(from, fwd, [{ id: 1, pos: v3(0, 0, -30) }, { id: 2, pos: v3(0, 0, 60) }]);
  assert.equal(t?.id, 2);
  // de lado (dot 0) a 40 (×2 = 80) perde para à frente a 70
  const t2 = pickTarget(from, fwd, [{ id: 3, pos: v3(40, 0, 0) }, { id: 4, pos: v3(0, 0, 70) }]);
  assert.equal(t2?.id, 4);
});

test('míssil reto acerta um carro à frente', () => {
  const cars: CarBody[] = [{ id: 7, pos: v3(0, 0, 100), radius: 5, alive: true }];
  const [p] = fire('power', 1, v3(0, 0, 0), v3(0, 0, 1), null);
  let hit = null;
  for (let i = 0; i < 120 && !hit; i++) hit = stepProjectile(p, 1 / 60, empty, cars);
  assert.equal(hit?.victim, 7);
  assert.equal(damageFromHit(hit!, cars).get(7), WEAPON_RULES.power.damage);
});

test('teleguiado faz a curva até um alvo de lado', () => {
  const cars: CarBody[] = [{ id: 9, pos: v3(120, 0, 120), radius: 5, alive: true }];
  const [p] = fire('homing', 1, v3(0, 0, 0), v3(0, 0, 1), 9);
  let hit = null;
  for (let i = 0; i < 360 && !hit; i++) hit = stepProjectile(p, 1 / 60, empty, cars);
  assert.equal(hit?.victim, 9);
});

test('ricochete quica na parede e o míssil comum explode nela', () => {
  const [r] = fire('ricochet', 1, v3(0, 0, 0), v3(0, 0, 1), null);
  for (let i = 0; i < 30; i++) stepProjectile(r, 1 / 60, wallAtZ(50), []);
  assert.ok(r.bounces >= 1 && r.vel.z < 0, 'deveria voltar após quicar');
  const [m] = fire('fire', 1, v3(0, 0, 0), v3(0, 0, 1), null);
  let hit = null;
  for (let i = 0; i < 60 && !hit; i++) hit = stepProjectile(m, 1 / 60, wallAtZ(50), []);
  assert.ok(hit && Math.abs(hit.pos.z - 50) < 1e-6 && hit.victim === null);
});

test('dano em área cai com a distância', () => {
  const cars: CarBody[] = [
    { id: 1, pos: v3(3, 0, 0), radius: 2, alive: true },
    { id: 2, pos: v3(12, 0, 0), radius: 2, alive: true },
  ];
  const dmg = damageFromHit({ projectile: fire('napalm', 0, v3(), v3(0, 0, 1), null)[0], pos: v3(0, 0, 0), victim: null }, cars);
  assert.ok((dmg.get(1) ?? 0) > (dmg.get(2) ?? 0));
});
