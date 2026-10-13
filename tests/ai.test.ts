// IA dos bots com as regras do ELF (src/game/ai.ts; docs/NATIVE.md "IA dos bots").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_WEAPON, BotBrain, type AiProfile, type AiTables, type AiView } from '../src/game/ai';

// Perfil e tabelas do Axel (rules/ai.json: 0x2b2d10, 0x2b1d20, 0x2b2518, 0x2b35d0..).
const AXEL: AiProfile = { fleeHealth: 0.4, fireCone: 0.9, switchFrames: 16, waitFrames: 50, losHeight: 7, aggression: 0.7, retreatHealth: 0.3 };
const FRONT = [0, 0.5, 0.1, 0.1, 0, 0, 0.1, 0, 0, 0.1, 0.1, 0, 0, 0, 0];
const REAR = [0, 0, 0.4, 0.1, 0, 0, 0, 0, 0, 0.3, 0.2, 0, 0, 0, 0];
const TABLES: AiTables = {
  profiles: [AXEL],
  front: [FRONT],
  rear: [REAR],
  range: {
    max: [0, 500, 400, 600, 700, 700, 250, 300, 1000, 700, 500, 700, 700, 300, 300, 0],
    min: [0, 20, 20, 20, 60, 50, 20, 20, 0, 50, 50, 50, 50, 50, 50, 0],
    dot: [0, 0.92, 0.95, 0.9, 0.95, 0.9, 0.98, 0.94, -1, 0.92, -1, 0.5, 0.5, -1, 0.97, 0],
  },
};

const view = (o: Partial<AiView> = {}): AiView => ({
  dist: 150, align: 1, targetFacing: 0, targetSpeedMph: 40, visible: true, health01: 1, turbo01: 1, speed: 60,
  steerAngle: 0, ammo: {}, selected: null, ...o,
});

/** Gerador determinístico para os sorteios (FUN_00237d20). */
function seq(...xs: number[]) {
  let i = 0;
  return () => xs[i++ % xs.length];
}

test('escolha de frente: só tipos implementados com uso abaixo do desejado; dá 1 de munição', () => {
  const b = new BotBrain(AXEL, FRONT, REAR, TABLES, 2, seq(0.5, 0.1));
  const out = b.step(view());
  const w = AI_WEAPON[b.chosen];
  assert.ok(w, `tipo ${b.chosen} sem arma`);
  assert.ok(FRONT[b.chosen] > 0);
  assert.equal(out.grant, w); // FUN_00107148
  assert.equal(b.state, 2);
});

test('alvo atrás (alinhamento < 0): escolha pela tabela de ré', () => {
  const b = new BotBrain(AXEL, FRONT, REAR, TABLES, 2, seq(0.0, 0.1));
  b.step(view({ align: -0.9 }));
  assert.ok(b.rearPick);
  assert.ok(REAR[b.chosen] > 0, `tipo ${b.chosen}`);
});

test('máquina das armas dispara a arma escolhida alinhada e no alcance', () => {
  const b = new BotBrain(AXEL, FRONT, REAR, TABLES, 3, seq(0.5, 0.1));
  let ammo: Record<string, number> = {};
  let selected: string | null = null;
  let fired = false;
  for (let f = 0; f < 600 && !fired; f++) {
    const out = b.step(view({ ammo, selected: selected as never }));
    if (out.grant) {
      ammo = { ...ammo, [out.grant]: 1 };
      selected = out.grant;
    }
    fired = out.fireSpecial;
  }
  assert.ok(fired, `estado ${b.state}`);
  assert.equal(b.usedTotal, 2);
});

test('metralhadora: cone estreita com a distância (FUN_00105970)', () => {
  const b = new BotBrain(AXEL, FRONT, REAR, TABLES, 2);
  assert.ok(b.step(view({ dist: 50, align: 0.99 })).fireGun);
  assert.ok(!b.step(view({ dist: 50, align: 0.5 })).fireGun);
  assert.ok(!b.step(view({ dist: 450, align: 0.95 })).fireGun, 'longe exige alinhamento maior');
  assert.ok(!b.step(view({ visible: false, align: 1 })).fireGun, 'sem visada não atira');
});

test('turbo: liga em reta com carga > 20 % e só desliga vazio (FUN_001034a0)', () => {
  const b = new BotBrain(AXEL, FRONT, REAR, TABLES, 3);
  // perseguido: alvo atrás, virado para o bot, a menos de 200 pés
  assert.ok(b.step(view({ align: -0.9, targetFacing: 0.99, dist: 150 })).turbo);
  assert.ok(b.step(view({ align: 1, targetFacing: 0, dist: 900, turbo01: 0.5 })).turbo, 'continua até esvaziar');
  assert.ok(!b.step(view({ turbo01: 0 })).turbo);
});
