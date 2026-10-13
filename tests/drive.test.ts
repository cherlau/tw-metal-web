// Controlador de direção nativo (tabela 0x2b8ab0 → carro+0x848..; FUN_00133650 / FUN_00132aa8 / FUN_00133078).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approach, createVehicle, NO_CONTROLS, speedOf, stepVehicle, type CollisionWorld, type Controls, type DriveParams, type VehicleShape } from '../src/physics/vehicle';
import { v3, type V3 } from '../src/physics/vec';

// Axel (0x2b8ab0) e Warthog (0x2b8d54), como em rules/vehicles.json.
const AXEL: DriveParams = { mass: 1.344, turn: 0.05, maxMph: 121, accel: 0.02, coast: 0.005, brake: 0.075, grip: 0.03, ramDamage: 3 };
const WART: DriveParams = { mass: 1.476, turn: 0.035, maxMph: 118, accel: 0.01, coast: 0.005, brake: 0.075, grip: 0.03, ramDamage: 6 };
const DT = 1 / 60;

const flat: CollisionWorld = {
  raycast(o: V3, d: V3, max: number) {
    if (d.y >= 0 || o.y < 0) return null;
    const t = o.y / -d.y;
    return t <= max ? { distance: t, normal: v3(0, 1, 0) } : null;
  },
  closestPoint(p: V3, max: number) {
    return p.y >= 0 && p.y <= max ? { point: v3(p.x, 0, p.z), distance: p.y } : null;
  },
};

function drive(d: DriveParams, seconds: number, c: Controls) {
  const shape: VehicleShape = { halfWidth: 4, halfLength: 8, bottom: -3, top: 4, drive: d };
  const s = createVehicle(v3(0, 3.5, 0));
  for (let i = 0; i < seconds * 60; i++) stepVehicle(s, shape, c, flat, DT);
  return s;
}

test('FUN_00253128: passo (alvo − v)·taxa com mínimo, sem passar do alvo', () => {
  assert.equal(approach(0, 1, 0.25, 0.001), 0.25);
  assert.equal(approach(0.9995, 1, 0.25, 0.001), 1);
  assert.equal(approach(0, -1, 0.02, 0.001), -0.02);
});

test('acelerador: chega à vel. máx. da tabela (mph) e o turbo a leva a ×1,25', () => {
  const go = { ...NO_CONTROLS, throttle: 1 };
  const s = drive(AXEL, 8, go);
  assert.ok(Math.abs(speedOf(s) / 1.4666667 - 121) < 2, `vel. ${(speedOf(s) / 1.4666667).toFixed(1)} mph`);
  const t = drive(AXEL, 8, { ...go, turbo: true });
  assert.ok(Math.abs(speedOf(t) / 1.4666667 - 121 * 1.25) < 3, `turbo ${(speedOf(t) / 1.4666667).toFixed(1)} mph`);
});

test('giro: o Axel (0,05) vira mais rápido que o Warthog (0,035)', () => {
  const c = { ...NO_CONTROLS, throttle: 1, steer: 1 };
  const a = drive(AXEL, 3, c);
  const w = drive(WART, 3, c);
  assert.ok(Math.abs(a.yaw) > Math.abs(w.yaw), `Axel ${a.yaw.toFixed(2)} × Warthog ${w.yaw.toFixed(2)}`);
  assert.ok(Math.abs(a.yaw) > Math.PI, 'Axel deveria dar meia-volta em 3 s');
});

test('sem pedal a roda perde vmáx·0,005 por quadro até parar', () => {
  const s = drive(AXEL, 3, { ...NO_CONTROLS, throttle: 1 });
  const shape: VehicleShape = { halfWidth: 4, halfLength: 8, bottom: -3, top: 4, drive: AXEL };
  for (let i = 0; i < 4 * 60; i++) stepVehicle(s, shape, NO_CONTROLS, flat, DT);
  assert.ok(speedOf(s) < 1, `ainda a ${speedOf(s).toFixed(1)} pés/s`);
});
