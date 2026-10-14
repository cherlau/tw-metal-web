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

test('ataque de ambiente: só a ARENA tem evento; nas DM avisa e não gasta munição (FUN_0014d040)', () => {
  const m = new Match(flat, [v3(0, 0, 0), v3(0, 0, 300)], ground);
  m.setLevel('egyptdm');
  const car = m.addCar('p', 'axel', SHAPE, false);
  m.addCar('b', 'axel', SHAPE, false);
  car.ammo.env = 2;
  car.selected = 'env';
  m.drain();
  m.step(1 / 60, new Map([[car.id, { ...NO_ACTIONS, fireSpecial: true }]]));
  assert.ok(m.drain().some((e) => e.kind === 'message' && e.text === 'Env Weapon Unavailable'));
  assert.equal(car.ammo.env, 2);
  assert.equal(m.projectiles.length, 0);
});

test('ataque de ambiente da ARENA: raio 0x13 em cada inimigo vivo, um evento por vez, 120 tiques', () => {
  // inimigo perto do bocal 1 (PS2 517, 130, 34 → mundo 517, 34, −130)
  const m = new Match(flat, [v3(0, 0, 0), v3(520, 0, -100), v3(-300, 0, 0)], ground, () => 0.5);
  m.setLevel('arena');
  const car = m.addCar('p', 'axel', SHAPE, false);
  const near = m.addCar('b', 'axel', SHAPE, false);
  const far = m.addCar('c', 'axel', SHAPE, false);
  far.deadFor = 1; // morto: não leva raio
  car.ammo.env = 2;
  car.selected = 'env';
  m.drain();
  const fire = new Map([[car.id, { ...NO_ACTIONS, fireSpecial: true }]]);
  m.step(1 / 60, fire);
  const ev = m.drain();
  assert.ok(ev.some((e) => e.kind === 'env' && e.fx === 'start'));
  assert.equal(ev.filter((e) => e.kind === 'env' && e.fx === 'jet').length, 5);
  assert.equal(car.ammo.env, 1);
  assert.deepEqual(m.projectiles.map((p) => [p.type, p.owner, p.target]), [[0x13, car.id, near.id]]);
  // segundo disparo com o evento em curso: "Already Active", sem gastar
  car.nextFire = 0;
  m.step(1 / 60, new Map());
  m.step(1 / 60, fire);
  assert.ok(m.drain().some((e) => e.kind === 'message' && e.text === 'Env Weapon Already Active'));
  assert.equal(car.ammo.env, 1);
  run(m, 2);
  assert.ok(near.health < MATCH_RULES.maxHealth, 'o raio deveria acertar o inimigo');
  assert.equal(m.envActive, null);
});

/** Dois carros: atacante na origem virado para +Z e alvo `dist` pés à frente. */
function duel(model: string, dist: number) {
  const m = new Match(flat, [v3(0, 0, 0), v3(0, 0, dist)], ground, () => 0.5);
  const a = m.addCar('p', model, SHAPE, false);
  const b = m.addCar('alvo', 'cop', SHAPE, false);
  a.state.pos = ground(v3(0, 0, 0), SHAPE);
  a.state.yaw = 0;
  b.state.pos = ground(v3(0, 0, dist), SHAPE);
  run(m, 0.2);
  a.selected = 'special';
  return { m, a, b };
}
const press = (m: Match, id: number) => m.step(1 / 60, new Map([[id, { ...NO_ACTIONS, fireSpecial: true }]]));

test('Twister: tornado captura (13), segura com 0,035/tique e arremessa no fim do giro (FUN_001e4670)', () => {
  const { m, a, b } = duel('twist', 30);
  press(m, a.id);
  run(m, 30 / 60); // preparo de 25 tiques
  assert.equal(b.heldBy, a.id);
  assert.ok(a.pose && a.pose.lift > 5 && a.pose.tilt < -0.8, JSON.stringify(a.pose)); // 9·(1 − 0,96^25) ≈ 5,6 pés
  run(m, 160 / 60); // giro de 150 tiques
  assert.equal(b.heldBy, null);
  assert.ok(b.health < 100 - 13 - 3, `vida ${b.health}`);
  run(m, 50 / 60); // recuperação de 45
  assert.equal(a.action, null);
  assert.equal(a.ammo.special, 0);
});

test('Mr. Slam: agarra quem está na garra (10), bate 5 × 3 e arremessa (FUN_001b1fc0)', () => {
  const { m, a, b } = duel('mrslam', 14);
  m.step(1 / 60, new Map()); // o disparo roda a cada quadro com o especial selecionado
  assert.equal(b.heldBy, a.id);
  run(m, 61 / 60);
  assert.equal(b.heldBy, null);
  assert.equal(b.health, 100 - 10 - 5 * 3);
  assert.ok(Math.hypot(b.state.vel.x, b.state.vel.z) > 200, 'arremessado a 200 mph');
});

test('Hammerhead: sem alvo só pula sem gastar; com alvo cai em cima (15) e esmaga (FUN_00196b60)', () => {
  const far = duel('hamr', 400);
  press(far.m, far.a.id);
  assert.equal(far.a.ammo.special, 1);
  assert.equal(far.a.action, null);
  const { m, a, b } = duel('hamr', 60);
  press(m, a.id);
  run(m, 35 / 60);
  assert.equal(b.health, 100 - 15);
  run(m, 40 / 60);
  assert.equal(a.action, null);
  assert.equal(a.ammo.special, 0);
});

test('Grasshopper: salta, mergulha no alvo travado e acerta 18 (FUN_00193198)', () => {
  const { m, a, b } = duel('grass', 80);
  press(m, a.id);
  run(m, 2);
  assert.equal(b.health, 100 - 18);
});

test('trava: fora do cone não há alvo (FUN_00147700 sem escolha ponderada)', async () => {
  const { lockTarget } = await import('../src/game/weapons');
  assert.equal(lockTarget(v3(0, 0, 0), v3(0, 0, 1), [{ id: 1, pos: v3(100, 0, 10) }], 14.5, 7000), null);
  assert.equal(lockTarget(v3(0, 0, 0), v3(0, 0, 1), [{ id: 1, pos: v3(5, 0, 100) }], 14.5, 7000)?.id, 1);
});

test('energia: Cima, Baixo, Cima congela (0,4); o congelado fica parado 300 tiques e botões descongelam', async () => {
  const { DIR } = await import('../src/game/energy');
  const { m, a, b } = duel('axel', 120);
  const seq = [DIR.up, 0, 0, DIR.down, 0, 0, DIR.up];
  for (const d of seq) m.step(1 / 60, new Map([[a.id, { ...NO_ACTIONS, dirs: d }]]));
  assert.ok(Math.abs(a.energy - 0.6) < 0.01, `energia ${a.energy}`);
  run(m, 1);
  assert.ok(b.frozen > 200, `congelado ${b.frozen}`);
  // descongelar: soltar todos e apertar um (FUN_00123410) — 20 apertos × (2 + 13) > 300 − 60
  for (let i = 0; i < 40; i++) m.step(1 / 60, new Map([[b.id, { ...NO_ACTIONS, buttonsHeld: i % 2 === 1 }]]));
  assert.equal(b.frozen, 0);
});

test('energia: Direita, Esquerda, Baixo solta mina atrás; a onda (Cima, Baixo, Esq., Dir.) fere a 100 pés', async () => {
  const { DIR } = await import('../src/game/energy');
  const { m, a, b } = duel('axel', 60);
  for (const d of [DIR.right, 0, DIR.left, 0, DIR.down]) m.step(1 / 60, new Map([[a.id, { ...NO_ACTIONS, dirs: d }]]));
  const mine = m.projectiles.find((p) => p.type === 0xd);
  assert.ok(mine && mine.pos.z < a.state.pos.z, 'mina atrás do carro');
  run(m, 1);
  for (const d of [DIR.up, 0, DIR.down, 0, DIR.left, 0, DIR.right]) m.step(1 / 60, new Map([[a.id, { ...NO_ACTIONS, dirs: d }]]));
  assert.equal(b.health, 100 - 10);
});

test('HC Hearse: segurar 100 tiques carrega 4 projéteis 0x2d; HC Grimm arranca rumo a 250 mph (FUN_001c8ee8, FUN_001d06a8)', () => {
  const { m, a } = duel('hc_hears', 300);
  for (let i = 0; i < 100; i++) m.step(1 / 60, new Map([[a.id, { ...NO_ACTIONS, fireSpecial: i === 0, fireSpecialHeld: true }]]));
  m.step(1 / 60, new Map());
  assert.equal(m.projectiles.filter((p) => p.type === 0x2d).length, 4);
  const g = duel('hc_grim', 300);
  press(g.m, g.a.id);
  run(g.m, 1.5);
  assert.ok(Math.hypot(g.a.state.vel.x, g.a.state.vel.z) > 150, `vel ${Math.hypot(g.a.state.vel.x, g.a.state.vel.z)}`);
});

test('combos do jogo (FUN_0012c9b8): sequências e janelas', async () => {
  const { DIR, BIT, comboBits } = await import('../src/game/energy');
  const hist = (...steps: [number, number][]) => steps.flatMap(([d, n]) => Array<number>(n).fill(d));
  const { up: U, down: D, left: L, right: R } = DIR;
  assert.equal(comboBits(hist([U, 3], [0, 3], [D, 3], [0, 3], [U, 1])) & BIT.freeze, BIT.freeze);
  assert.equal(comboBits(hist([U, 3], [0, 30], [D, 3], [0, 3], [U, 1])) & BIT.freeze, 0, 'Cima longe demais');
  assert.equal(comboBits(hist([R, 2], [0, 2], [L, 2], [0, 2], [D, 1])) & BIT.mine, BIT.mine);
  assert.equal(comboBits(hist([R, 2], [0, 2], [R, 2], [0, 2], [D, 2], [0, 2], [D, 1])) & BIT.shell, BIT.shell);
  assert.equal(comboBits(hist([U, 2], [0, 2], [D, 2], [0, 2], [L, 2], [0, 2], [R, 1])) & BIT.blast, BIT.blast);
  // tiro para trás: Cima, Baixo, Baixo — vale enquanto o último Baixo começou há ≤ 20 quadros (sem borda)
  assert.equal(comboBits(hist([U, 2], [0, 2], [D, 2], [0, 2], [D, 5])) & BIT.rear, BIT.rear);
  assert.equal(comboBits(hist([U, 2], [0, 2], [D, 2], [0, 2], [D, 30])) & BIT.rear, 0, 'segurou demais');
  assert.equal(comboBits(hist([D, 5])) & BIT.rear, 0);
  // míssil de energia: Direita, Esquerda, Cima, Cima
  assert.equal(comboBits(hist([R, 2], [0, 2], [L, 2], [0, 2], [U, 2], [0, 2], [U, 2], [0, 5])) & BIT.boost, BIT.boost);
});

test('tiro para trás (bit 0x10): o Power sai de ré; o Remote sempre sai de ré (FUN_00147ec8, FUN_0014e030)', async () => {
  const { DIR } = await import('../src/game/energy');
  const { m, a } = duel('axel', 300);
  a.ammo.power = 2;
  a.selected = 'power';
  for (const d of [DIR.up, DIR.up, 0, 0, DIR.down, DIR.down, 0, 0, DIR.down]) m.step(1 / 60, new Map([[a.id, { ...NO_ACTIONS, dirs: d }]]));
  m.step(1 / 60, new Map([[a.id, { ...NO_ACTIONS, dirs: DIR.down, fireSpecial: true }]]));
  const p = m.projectiles.find((x) => x.type === 6)!;
  assert.ok(Math.cos(p.yaw) < -0.99, `rumo ${p.yaw}`);
});

test('míssil de energia (bit 0x40): disparar solta um 0xf extra e gasta 0,3 (FUN_00148300)', async () => {
  const { DIR } = await import('../src/game/energy');
  const { m, a } = duel('axel', 300);
  a.ammo.power = 2;
  a.selected = 'power';
  for (const d of [DIR.right, DIR.right, 0, 0, DIR.left, DIR.left, 0, 0, DIR.up, DIR.up, 0, 0, DIR.up, 0])
    m.step(1 / 60, new Map([[a.id, { ...NO_ACTIONS, dirs: d }]]));
  m.step(1 / 60, new Map([[a.id, { ...NO_ACTIONS, fireSpecial: true }]]));
  assert.ok(m.projectiles.some((x) => x.type === 0xf));
  assert.ok(Math.abs(a.energy - 0.7) < 0.01, `energia ${a.energy}`);
});

test('IA: congela o alvo alinhado a < 300 pés e solta a onda depois de 1200 quadros lenta (FUN_00106cf0, FUN_00103ca8)', async () => {
  const { BotBrain } = await import('../src/game/ai');
  const prof = { fleeHealth: 0.4, fireCone: 0.9, switchFrames: 16, waitFrames: 50, losHeight: 7, aggression: 0.7, retreatHealth: 0.3, timerA: 10, timerB: 10 };
  const tables = { profiles: [prof], front: [[]], rear: [[]], range: { max: [], min: [], dot: [] } };
  const front = new Array(15).fill(0);
  front[2] = 1; // Fire: a máquina das armas fica no estado 2 (trocando) com o alvo à frente
  const b = new BotBrain(prof, front, new Array(15).fill(0), tables, 3, () => 0.05);
  const shared = { lastShell: -1e9, lastFreeze: -1e9 };
  const view = { dist: 150, align: 1, targetFacing: 1, targetSpeedMph: 0, visible: true, health01: 1, turbo01: 1, speed: 80, steerAngle: 0, ammo: {}, selected: null, energy: 1, shared, rivalsDone: 1, rivalsTotal: 1 };
  let bits = 0;
  for (let f = 0; f < 30; f++) bits |= b.step({ ...view, frame: f }).bits;
  assert.equal(bits & 1, 1, 'congelar');
  let blast = 0;
  for (let f = 0; f < 1300; f++) blast |= b.step({ ...view, speed: 10, frame: 2000 + f }).bits & 0x20;
  assert.equal(blast, 0x20, 'onda');
});

test('golpe por tipo (FUN_0011f280): Power joga para cima a 44 pés/s; Thumper acende fogo de 0,01/tique por 300 tiques', () => {
  const { m, a, b } = duel('thump', 120);
  a.ammo.power = 1;
  a.selected = 'power';
  m.step(1 / 60, new Map([[a.id, { ...NO_ACTIONS, fireSpecial: true }]]));
  let vy = 0;
  for (let i = 0; i < 30 && vy === 0; i++) {
    m.step(1 / 60, new Map());
    if (b.state.vel.y > 30) vy = b.state.vel.y;
  }
  assert.ok(vy > 30, `vy ${vy}`);
  run(m, 2);
  const { m: m2, a: t, b: v } = duel('thump', 80);
  press(m2, t.id);
  for (let i = 0; i < 60 && v.burning === 0; i++) m2.step(1 / 60, new Map());
  assert.ok(v.burning > 0, 'pegou fogo');
  const h = v.health;
  run(m2, 1);
  assert.ok(h - v.health > 0.55 && h - v.health < 0.65 + 25 * 3, `queimou ${h - v.health}`);
  // turbo apaga (FUN_001238c8)
  m2.step(1 / 60, new Map([[v.id, { ...NO_ACTIONS, throttle: 1, turbo: true }]]));
  assert.equal(v.burning, 0);
});

test('HC: Semi solta o anel de 8 × 0x32; Taxi 10 projéteis 0x35..0x37 (FUN_001dd878, FUN_001c9a38)', () => {
  const s = duel('hc_semi', 300);
  press(s.m, s.a.id);
  assert.equal(s.m.projectiles.filter((p) => p.type === 0x32).length, 8);
  const t = duel('hc_taxi', 300);
  press(t.m, t.a.id);
  assert.equal(t.m.projectiles.filter((p) => p.type >= 0x35 && p.type <= 0x37).length, 10);
});

test('HC: o objeto do Derby persegue e prende no alvo (20); o raio do Spectre HC queima (FUN_00195638, FUN_001e0c58)', () => {
  const d = duel('hc_derby', 150);
  press(d.m, d.a.id);
  run(d.m, 3);
  assert.equal(d.b.health, 100 - 20);
  const v = duel('hc_vette', 80);
  press(v.m, v.a.id);
  run(v.m, 1);
  assert.ok(v.b.health < 100 - 5, `vida ${v.b.health}`);
  assert.ok(v.b.burning > 0);
});

test('HC: canhão do Manslaughter (segurar ergue, 10 × 0x31) e Preacher solta 0x2e a cada novo toque', () => {
  const { m, a } = duel('hc_rock', 300);
  for (let i = 0; i < 31 + 19 * 10; i++) m.step(1 / 60, new Map([[a.id, { ...NO_ACTIONS, fireSpecial: i === 0, fireSpecialHeld: i < 40 }]]));
  assert.ok(m.drain().filter((e) => e.kind === 'launch' && e.type === 0x31).length === 10);
  const p = duel('hc_preac', 300);
  for (let i = 0; i < 40; i++) p.m.step(1 / 60, new Map([[p.a.id, { ...NO_ACTIONS, fireSpecial: i === 0 || i === 20, fireSpecialHeld: i < 5 || (i >= 20 && i < 25) }]]));
  assert.equal(p.m.drain().filter((e) => e.kind === 'launch' && e.type === 0x2e).length, 1);
});

test('Warthog: os 3 tiros 0x28 saem juntos (FUN_001fcd00)', () => {
  const { m, a } = duel('wart', 300);
  press(m, a.id);
  assert.equal(m.drain().filter((e) => e.kind === 'launch' && e.type === 0x28).length, 3);
});

test('trava em objeto do cenário sem carro no cone (FUN_00147cf0): o Homing persegue o ponto', () => {
  const { m, a, b } = duel('axel', 300);
  b.state.pos = v3(500, b.state.pos.y, -500); // fora do cone
  m.sceneTargets = () => [v3(40, 5, 200)];
  a.ammo.homing = 1;
  a.selected = 'homing';
  m.step(1 / 60, new Map([[a.id, { ...NO_ACTIONS, fireSpecial: true }]]));
  const p = m.projectiles.find((x) => x.type === 3)!;
  assert.ok(p.aimPoint, 'travou no objeto');
  for (let i = 0; i < 20; i++) m.step(1 / 60, new Map());
  assert.ok(p.pos.x > 5, `x ${p.pos.x}`);
});

test('Cousin Eddy: a onda do Axel com 23 de dano a até 100 pés (FUN_001176b8)', () => {
  const { m, a, b } = duel('edplayer', 60);
  press(m, a.id);
  assert.equal(b.health, 100 - 23);
  assert.ok(b.state.vel.y > 50, 'sobe');
  assert.equal(a.ammo.special, 0);
});

test('Dark Tooth: trava (5) e, segurando, golpeia 1 por tique até 300 tiques (FUN_0016fe00)', () => {
  const { m, a, b } = duel('darkpla1', 100);
  press(m, a.id);
  assert.equal(a.action?.kind, 'arc');
  assert.equal(b.health, 100 - 5);
  const hold = new Map([[a.id, { ...NO_ACTIONS, fireSpecial: true }]]);
  for (let i = 0; i < 20; i++) m.step(1 / 60, hold);
  assert.ok(b.health < 100 - 5 - 15, `vida ${b.health}`);
  run(m, 300 / 60);
  assert.equal(a.action, null);
  assert.equal(a.ammo.special, 0);
});

test('pontos de disparo 0x00F8: metralhadora alterna 9 ↔ 8 e cada arma sai do seu ponto', () => {
  // Sweet Tooth: 8/9 nos faróis da frente, 4 (Napalm) no alto da traseira, 2 (Fire) na lateral esquerda.
  const mounts = { 2: [-4.7, -5.849, 2.377], 4: [0, -10.8941, 3.3824], 8: [-4.4899, 10.4611, -0.5945], 9: [4.4721, 10.4611, -0.5945] } as const;
  const m = new Match(flat, [v3(0, 0, 0)], ground);
  const car = m.addCar('p', 'sweet', { ...SHAPE, mounts }, false);
  run(m, 0.5); // assenta
  const yaw = car.state.yaw;
  const toLocal = (p: V3) => {
    const d = v3(p.x - car.state.pos.x, p.y - car.state.pos.y, p.z - car.state.pos.z);
    // PS2: x direita, y frente, z cima (forwardOf = (sin, 0, cos); direita = (−cos, 0, sin))
    return [d.x * -Math.cos(yaw) + d.z * Math.sin(yaw), d.x * Math.sin(yaw) + d.z * Math.cos(yaw), d.y];
  };
  const near = (a: number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 0.05);
  m.drain();
  const fireGun = new Map([[car.id, { ...NO_ACTIONS, fireGun: true }]]);
  for (let i = 0; i < 25; i++) m.step(1 / 60, fireGun);
  const shots = m.drain().flatMap((e) => (e.kind === 'shot' ? [toLocal(e.from)] : []));
  assert.equal(shots.length, 3);
  assert.ok(near(shots[0], mounts[9]) && near(shots[1], mounts[8]) && near(shots[2], mounts[9]), JSON.stringify(shots));

  for (const [w, id] of [['fire', 2], ['napalm', 4]] as const) {
    car.ammo[w] = 1;
    car.selected = w;
    car.nextFire = 0;
    m.step(1 / 60, new Map([[car.id, { ...NO_ACTIONS, fireSpecial: true }]]));
    const launch = m.drain().find((e) => e.kind === 'launch');
    assert.ok(launch && launch.kind === 'launch' && near(toLocal(launch.pos), mounts[id]), `${w}: ${launch && JSON.stringify(launch)}`);
  }
});

test('spawn nativo: entrada não repete nó, nasce virado para o vizinho e longe dos outros (FUN_00112110/FUN_001123d8)', () => {
  const spawns = [
    { pos: v3(0, 0, 0), face: v3(100, 0, 0) },
    { pos: v3(0, 0, 1000), face: v3(0, 0, 900) },
  ];
  const m = new Match(flat, spawns, ground, () => 0);
  const a = m.addCar('a', 'axel', SHAPE, false);
  const b = m.addCar('b', 'cop', SHAPE, false);
  assert.ok(Math.abs(a.state.pos.z) < 1 && Math.abs(b.state.pos.z - 1000) < 1, 'dois carros no mesmo nó');
  assert.ok(Math.abs(a.state.yaw - Math.PI / 2) < 1e-6, `yaw ${a.state.yaw}`); // de (0,0,0) para (100,0,0)
  assert.ok(Math.abs(Math.abs(b.state.yaw) - Math.PI) < 1e-6, `yaw ${b.state.yaw}`);
  // renascer: o nó a mais de 300 pés do outro carro
  a.state.pos = ground(v3(0, 0, 990), SHAPE);
  m.respawn(b);
  assert.ok(Math.abs(b.state.pos.z) < 1, `renasceu em z=${b.state.pos.z}`);
});
