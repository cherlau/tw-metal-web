// Destroços dos nós 0x13 (FUN_0016e678 / FUN_00173a80): impulso inicial, gravidade −128, fade nos últimos 60 tiques.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DEBRIS_FADE, DEBRIS_GRAVITY, DEBRIS_LIFE, launchBody } from '../src/debris';
import { VEHICLE_TO_THREE } from '../src/coords';
import type { DebrisModelDef } from '../src/assets';

const box: DebrisModelDef = { instances: [], offset: [0, 0, 0], center: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], radius: 2 };
const action = { center: [0, 0, -11], speed: 0, mass: 1 };
const still = () => 0.5; // sem espalhamento em x/z (2·0,5 − 1 = 0)

test('impulso: (base + 1) × 1000/60 na direção peça − centro, girada pelo objeto', () => {
  const b = launchBody(box, action, [0, 0, 1], VEHICLE_TO_THREE, still);
  // z do PS2 (para cima) = y do Three; espalhamento só para cima: 0,05·raio·0,5
  assert.ok(Math.abs(b.vel.length() - 1000 / 60) < 1e-6);
  assert.ok(b.vel.y > 16 && Math.abs(b.vel.x) < 1e-9 && Math.abs(b.vel.z) < 1e-9);
  assert.ok(Math.abs(b.pos.y - 1) < 1e-9); // posição = frame · pos da peça
  const fast = launchBody(box, { ...action, speed: 2 }, [0, 0, 1], VEHICLE_TO_THREE, still);
  assert.ok(Math.abs(fast.vel.length() - 3000 / 60) < 1e-6);
});

test('voo livre: gravidade −128 pés/s²', () => {
  const b = launchBody(box, action, [0, 0, 1], VEHICLE_TO_THREE, still);
  const v0 = b.vel.y;
  for (let i = 0; i < 30; i++) b.step(1 / 60, null);
  assert.ok(Math.abs(b.vel.y - (v0 + DEBRIS_GRAVITY * 0.5)) < 1e-6);
});

test('vida 180 tiques: alfa cai 1/s a partir de 120', () => {
  const b = launchBody(box, action, [0, 0, 1], VEHICLE_TO_THREE, still);
  for (let i = 0; i < DEBRIS_LIFE - DEBRIS_FADE; i++) b.step(1 / 60, null);
  assert.equal(b.alpha, 1);
  for (let i = 0; i < 30; i++) b.step(1 / 60, null);
  assert.ok(Math.abs(b.alpha - 0.5) < 0.02);
  for (let i = 0; i < 31; i++) b.step(1 / 60, null);
  assert.equal(b.alpha, 0);
});

test('chão: a peça para sobre o plano sem atravessar', () => {
  const ground = {
    raycast: (o: { x: number; y: number; z: number }, _d: unknown, max: number) => (o.y >= 0 && o.y <= max ? { distance: o.y, normal: { x: 0, y: 1, z: 0 } } : null),
  };
  const b = launchBody(box, action, [0, 0, 3], VEHICLE_TO_THREE, still);
  for (let i = 0; i < 150; i++) b.step(1 / 60, ground);
  const c = new THREE.Vector3();
  let low = Infinity;
  for (let i = 0; i < 8; i++) low = Math.min(low, b.cornerWorld(i, c).y);
  assert.ok(low > -0.05, `canto mais baixo ${low}`);
  assert.ok(b.vel.length() < 2, `velocidade ${b.vel.length()}`);
});
