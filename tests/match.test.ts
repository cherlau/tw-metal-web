// Partida (pura): pickups, dano, morte/renascimento e bots, num mundo plano.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match, MATCH_RULES, NO_ACTIONS } from '../src/game/match';
import { v3, type V3 } from '../src/physics/vec';
import type { CollisionWorld, VehicleShape } from '../src/physics/vehicle';

const SHAPE: VehicleShape = { halfWidth: 4, halfLength: 8, bottom: -3, top: 4 };
const flat: CollisionWorld = {
  raycast(o, d, max) {
    if (d.y >= 0 || o.y < 0) return null;
    const t = o.y / -d.y;
    return t <= max ? { distance: t, normal: v3(0, 1, 0) } : null;
  },
  closestPoint(p, max) {
    return p.y >= 0 && p.y <= max ? { point: v3(p.x, 0, p.z), distance: p.y } : null;
  },
};
const ground = (p: V3, s: VehicleShape) => v3(p.x, -s.bottom + 0.5, p.z);

function run(m: Match, seconds: number, actions = new Map()) {
  for (let i = 0; i < seconds * 60; i++) m.step(1 / 60, actions);
}

test('pegar Health 30% recupera vida e o pickup some até renascer', () => {
  const m = new Match(flat, [v3(0, 0, 0)], ground);
  const car = m.addCar('p', 'axel', SHAPE, false);
  car.health = 50;
  m.addPickups([{ id: 8, pos: v3(0, 1, 0) }]);
  run(m, 0.2);
  assert.equal(car.health, 50 + 30); // FUN_00120ba0: +30 pontos (0x35b4d4)
  assert.ok(m.pickups[0].respawnIn > 0);
  assert.ok(m.drain().some((e) => e.kind === 'pickup'));
});

test('pegar arma dá munição e disparar consome', () => {
  const m = new Match(flat, [v3(0, 0, 0)], ground);
  const car = m.addCar('p', 'axel', SHAPE, false);
  m.addPickups([{ id: 6, pos: v3(0, 1, 0) }]);
  run(m, 0.1);
  assert.equal(car.ammo.power, 2); // FUN_001bc6f8: 2 por pickup no Head-On
  // Nasce com Fire 1, Homing 1 e o especial 1 (FUN_00147420).
  assert.deepEqual([car.ammo.fire, car.ammo.homing, car.ammo.special], [1, 1, 1]);
  car.selected = 'power';
  m.step(1 / 60, new Map([[car.id, { ...NO_ACTIONS, fireSpecial: true }]]));
  assert.equal(car.ammo.power, 1);
  // Outro disparo só depois de 48 tiques (carro+0x6300).
  m.step(1 / 60, new Map([[car.id, { ...NO_ACTIONS, fireSpecial: true }]]));
  assert.equal(car.ammo.power, 1);
  assert.ok(m.projectiles.length + m.drain().filter((e) => e.kind === 'explosion').length > 0);
});

test('metralhadora mata um alvo parado à frente e ele renasce', () => {
  const m = new Match(flat, [v3(0, 0, 0), v3(0, 0, 60)], ground);
  const shooter = m.addCar('p', 'axel', SHAPE, false);
  const victim = m.addCar('alvo', 'cop', SHAPE, false);
  shooter.state.pos = ground(v3(0, 0, 0), SHAPE);
  shooter.state.yaw = 0;
  victim.state.pos = ground(v3(0, 0, 60), SHAPE);
  run(m, 0.5);
  const firing = new Map([[shooter.id, { ...NO_ACTIONS, fireGun: true }]]);
  for (let i = 0; i < 12 * 60 && victim.deaths === 0; i++) m.step(1 / 60, firing);
  assert.equal(victim.deaths, 1, `vida restante ${victim.health}`);
  assert.equal(shooter.kills, victim.deaths);
  run(m, MATCH_RULES.respawnDelay + 0.5);
  assert.equal(victim.deadFor, 0);
  assert.equal(victim.health, MATCH_RULES.maxHealth);
});

test('bots se movem e se enfrentam sem travar', () => {
  const spawns = [v3(0, 0, 0), v3(200, 0, 0), v3(0, 0, 200), v3(200, 0, 200)];
  const m = new Match(flat, spawns, ground);
  const bots = [0, 1, 2].map((i) => m.addCar(`bot${i}`, 'cop', SHAPE, true));
  const start = bots.map((b) => ({ ...b.state.pos }));
  run(m, 20);
  const moved = bots.filter((b, i) => Math.hypot(b.state.pos.x - start[i].x, b.state.pos.z - start[i].z) > 30).length;
  assert.ok(moved >= 2, 'bots parados');
  const shots = m.drain().filter((e) => e.kind === 'shot').length;
  assert.ok(shots > 0, 'bots não atiraram');
});

test('carros não se atravessam (colisão carro × carro)', () => {
  const m = new Match(flat, [v3(0, 0, 0), v3(0, 0, 100)], ground);
  const a = m.addCar('a', 'axel', SHAPE, false);
  const b = m.addCar('b', 'cop', SHAPE, false);
  a.state.pos = ground(v3(0, 0, 0), SHAPE);
  a.state.yaw = 0;
  b.state.pos = ground(v3(0, 0, 60), SHAPE);
  b.state.yaw = Math.PI; // de frente um para o outro
  const go = { ...NO_ACTIONS, throttle: 1 };
  let minGap = Infinity;
  for (let i = 0; i < 8 * 60; i++) {
    m.step(1 / 60, new Map([[a.id, go], [b.id, go]]));
    minGap = Math.min(minGap, Math.hypot(b.state.pos.x - a.state.pos.x, b.state.pos.z - a.state.pos.z));
  }
  const r = (SHAPE.halfWidth + SHAPE.halfLength) * 0.5;
  assert.ok(minGap > 2 * r - 1.5, `se atravessaram: menor distância ${minGap.toFixed(1)}`);
});

test('especial do Axel: onda de choque fere quem está a até 100 pés e recarrega em 1800 tiques', () => {
  const m = new Match(flat, [v3(0, 0, 0), v3(0, 0, 80), v3(0, 0, 300)], ground, () => 0.5);
  const axel = m.addCar('p', 'axel', SHAPE, false);
  const near = m.addCar('perto', 'cop', SHAPE, false);
  const far = m.addCar('longe', 'cop', SHAPE, false);
  axel.state.pos = ground(v3(0, 0, 0), SHAPE);
  near.state.pos = ground(v3(0, 0, 80), SHAPE);
  far.state.pos = ground(v3(0, 0, 300), SHAPE);
  axel.selected = 'special';
  m.step(1 / 60, new Map([[axel.id, { ...NO_ACTIONS, fireSpecial: true }]]));
  assert.equal(near.health, MATCH_RULES.maxHealth - 15);
  assert.equal(far.health, MATCH_RULES.maxHealth);
  assert.equal(axel.ammo.special, 0);
  run(m, 1800 / 60 + 0.1);
  assert.equal(axel.ammo.special, 1);
});

test('Swarmer: segurar carrega até 6 mísseis e solta sozinho em 210 tiques', () => {
  const m = new Match(flat, [v3(0, 0, 0)], ground, () => 0.5);
  const car = m.addCar('p', 'axel', SHAPE, false);
  car.ammo.swarmer = 1;
  car.selected = 'swarmer';
  const hold = { ...NO_ACTIONS, fireSpecialHeld: true };
  m.step(1 / 60, new Map([[car.id, { ...hold, fireSpecial: true }]]));
  for (let i = 0; i < 230; i++) m.step(1 / 60, new Map([[car.id, hold]]));
  assert.equal(m.projectiles.filter((p) => p.type === 9).length, 6);
  assert.equal(car.ammo.swarmer, 0);
});

test('metralhadora: um tiro a cada 10 tiques e superaquece depois de 500 tiques segurando', () => {
  const m = new Match(flat, [v3(0, 0, 0)], ground);
  const car = m.addCar('p', 'axel', SHAPE, false);
  m.drain();
  const fireGun = new Map([[car.id, { ...NO_ACTIONS, fireGun: true }]]);
  for (let i = 0; i < 100; i++) m.step(1 / 60, fireGun);
  assert.equal(m.drain().filter((e) => e.kind === 'shot').length, 10);
  for (let i = 0; i < 420; i++) m.step(1 / 60, fireGun);
  assert.ok(car.mg.overheat > 0, `calor ${car.mg.heat}`);
  m.drain();
  for (let i = 0; i < 60; i++) m.step(1 / 60, fireGun);
  assert.equal(m.drain().filter((e) => e.kind === 'shot').length, 0);
});
