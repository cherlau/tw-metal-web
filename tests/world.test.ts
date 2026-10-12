// Física + colisão REAL das arenas (assets publicados em public/assets) rodando em Node — SPEC §14.2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { LevelCollision } from '../src/collision';
import { PS2_TO_THREE } from '../src/coords';
import type { ModelDoc } from '../src/assets';
import { createVehicle, NO_CONTROLS, stepVehicle, type VehicleShape } from '../src/physics/vehicle';
import { v3 } from '../src/physics/vec';

const DT = 1 / 60;
const SHAPE: VehicleShape = { halfWidth: 5, halfLength: 5, bottom: -4.1, top: 4.1 }; // ≈ Axel

function loadLevel(name: string) {
  const base = `public/assets/lvl/${name}`;
  const doc = JSON.parse(readFileSync(`${base}.json`, 'utf-8')) as ModelDoc;
  const buf = readFileSync(`${base}.bin`);
  const bin = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { doc, collision: new LevelCollision(doc, bin, PS2_TO_THREE) };
}

function spawns(doc: ModelDoc) {
  return (doc.points?.pts ?? []).map((p) => {
    const v = new THREE.Vector3(...p.pos).applyMatrix4(PS2_TO_THREE);
    return v3(v.x, v.y, v.z);
  });
}

for (const name of ['arena', 'tokyodm']) {
  const has = existsSync(`public/assets/lvl/${name}.json`);
  test(`${name}: o carro assenta e dirige sem cair do mundo`, { skip: !has && 'assets ausentes' }, () => {
    const { doc, collision } = loadLevel(name);
    const pts = spawns(doc);
    assert.ok(pts.length > 10, 'arena sem nós PTS');
    const floor = collision.bounds.min.y - 50;
    let checked = 0;
    for (const p of pts.filter((_, i) => i % Math.ceil(pts.length / 12) === 0)) {
      const hit = collision.raycast(v3(p.x, p.y + 40, p.z), v3(0, -1, 0), 400);
      assert.ok(hit, `sem chão sob o nó ${JSON.stringify(p)}`);
      const s = createVehicle(v3(p.x, p.y + 40 - hit.distance - SHAPE.bottom + 2, p.z), checked);
      for (let i = 0; i < 120; i++) stepVehicle(s, SHAPE, NO_CONTROLS, collision, DT);
      assert.ok(s.grounded, `não assentou em ${JSON.stringify(p)}`);
      // Acelera 6 s virando levemente: não pode atravessar o chão nem cair abaixo da arena.
      let minY = s.pos.y;
      for (let i = 0; i < 360; i++) {
        stepVehicle(s, SHAPE, { ...NO_CONTROLS, throttle: 1, steer: 0.3 }, collision, DT);
        minY = Math.min(minY, s.pos.y);
      }
      assert.ok(minY > floor, `caiu do mundo partindo de ${JSON.stringify(p)} (y=${minY})`);
      checked++;
    }
    assert.ok(checked >= 8);
  });
}

// Regressão: no Egito o carro nascia de frente para um paredão (nós PTS não têm direção).
for (const name of ['arena', 'tokyodm']) {
  const has = existsSync(`public/assets/lvl/${name}.json`);
  test(`${name}: o carro nasce virado para um espaço livre`, { skip: !has && 'assets ausentes' }, async () => {
    const { Match } = await import('../src/game/match');
    const { forwardOf } = await import('../src/physics/vehicle');
    const { doc, collision } = loadLevel(name);
    const pts = spawns(doc);
    const match = new Match(collision, pts, (p) => p);
    for (const p of pts.filter((_, i) => i % Math.ceil(pts.length / 12) === 0)) {
      const hit = collision.raycast(v3(p.x, p.y + 40, p.z), v3(0, -1, 0), 400);
      if (!hit) continue;
      const pos = v3(p.x, p.y + 40 - hit.distance - SHAPE.bottom + 2, p.z);
      const yaw = match.openYaw(pos, SHAPE);
      const o = v3(pos.x, pos.y, pos.z);
      const ahead = collision.raycast(o, forwardOf(yaw), 300);
      assert.ok(!ahead || ahead.distance >= 20, `parede a ${ahead?.distance.toFixed(1)} pés em ${JSON.stringify(p)}`);
    }
  });
}
