// Testes da física pura do veículo contra um mundo sintético (chão plano + parede).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVehicle, NO_CONTROLS, rightOf, forwardOf, speedOf, stepVehicle, VEHICLE_RULES, type CollisionWorld, type VehicleShape } from '../src/physics/vehicle';
import { v3, type V3 } from '../src/physics/vec';

const SHAPE: VehicleShape = { halfWidth: 4, halfLength: 8, bottom: -3, top: 4 };
const DT = 1 / 60;

/** Chão em y=0; parede opcional no plano z = wallZ (normal -Z, sólida para z > wallZ). */
function flatWorld(wallZ = Infinity): CollisionWorld {
  return {
    raycast(o: V3, d: V3, max: number) {
      if (d.y >= 0 || o.y < 0) return null;
      const t = o.y / -d.y;
      return t <= max ? { distance: t, normal: v3(0, 1, 0) } : null;
    },
    closestPoint(p: V3, max: number) {
      let best: { point: V3; distance: number } | null = null;
      if (p.y >= 0 && p.y <= max) best = { point: v3(p.x, 0, p.z), distance: p.y };
      const dz = wallZ - p.z;
      if (dz >= 0 && dz <= max && (!best || dz < best.distance)) best = { point: v3(p.x, p.y, wallZ), distance: dz };
      return best;
    },
  };
}

function run(seconds: number, controls = NO_CONTROLS, world = flatWorld(), start = v3(0, 10, 0)) {
  const s = createVehicle(start);
  for (let i = 0; i < seconds * 60; i++) stepVehicle(s, SHAPE, controls, world, DT);
  return s;
}

test('cai e assenta no chão sem atravessar', () => {
  const s = run(3);
  assert.ok(s.grounded, 'deveria estar no chão');
  const bottom = s.pos.y + SHAPE.bottom;
  assert.ok(Math.abs(bottom) < 0.6, `fundo do carro em ${bottom}`);
  assert.ok(Math.abs(s.vel.y) < 0.5);
});

test('acelera para a frente (+Z) e respeita a velocidade máxima', () => {
  const s = run(20, { ...NO_CONTROLS, throttle: 1 });
  assert.ok(s.pos.z > 500, `andou só ${s.pos.z}`);
  assert.ok(Math.abs(s.pos.x) < 1e-6);
  const v = speedOf(s);
  assert.ok(v <= VEHICLE_RULES.maxSpeed + 1 && v > VEHICLE_RULES.maxSpeed * 0.9, `velocidade ${v}`);
});

test('freia até parar e depois dá ré', () => {
  const s = createVehicle(v3(0, 3, 0));
  const w = flatWorld();
  for (let i = 0; i < 300; i++) stepVehicle(s, SHAPE, { ...NO_CONTROLS, throttle: 1 }, w, DT);
  for (let i = 0; i < 120; i++) stepVehicle(s, SHAPE, { ...NO_CONTROLS, brake: 1 }, w, DT);
  const vf = s.vel.x * forwardOf(s.yaw).x + s.vel.z * forwardOf(s.yaw).z;
  assert.ok(vf < 0, `deveria estar em ré, vf=${vf}`);
  assert.ok(vf >= -VEHICLE_RULES.maxReverse - 1e-6);
});

test('virar à direita leva o carro para a direita', () => {
  const s = createVehicle(v3(0, 3, 0));
  const w = flatWorld();
  for (let i = 0; i < 180; i++) stepVehicle(s, SHAPE, { ...NO_CONTROLS, throttle: 1, steer: i > 60 ? 1 : 0 }, w, DT);
  const r = rightOf(0);
  assert.ok(s.pos.x * r.x + s.pos.z * r.z > 5, `não foi para a direita: ${JSON.stringify(s.pos)}`);
});

test('parede detém o carro (não atravessa)', () => {
  const wallZ = 120;
  const s = run(10, { ...NO_CONTROLS, throttle: 1 }, flatWorld(wallZ), v3(0, 3, 0));
  assert.ok(s.pos.z + SHAPE.halfLength * 0.55 < wallZ + 0.01, `atravessou: z=${s.pos.z}`);
  assert.ok(speedOf(s) < 20, `ainda rápido: ${speedOf(s)}`);
});

test('parado não gira no lugar', () => {
  const s = run(2, { ...NO_CONTROLS, steer: 1 }, flatWorld(), v3(0, 3, 0));
  assert.ok(Math.abs(s.yaw) < 1e-3, `yaw ${s.yaw}`);
});
