// Estados de dano (nós 0x13) pela vida do carro: FUN_00171560 (entrada) e FUN_00172768 (atraso da piora).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { damageEntry } from '../src/rig';
import type { DamageDef } from '../src/assets';

const part: DamageDef = { category: 0x46, thresholds: [0x7fff, 0x3fff, 0x28f, 0], maxHp: 1, minDamage: 0, fx: [null, null, null, null] };

test('entrada = 1ª com limiar ≤ int(fração · 65535), senão a última', () => {
  assert.equal(damageEntry(part, 1), 0);
  assert.equal(damageEntry(part, 0.5), 0); // int(0,5·65535) = 32767 = 0x7FFF
  assert.equal(damageEntry(part, 0.49), 1);
  assert.equal(damageEntry(part, 0.25), 1);
  assert.equal(damageEntry(part, 0.2), 2);
  assert.equal(damageEntry(part, 0.02), 2); // vivo com f < 0,01 vira 0,02 (FUN_0012e8c0)
  assert.equal(damageEntry(part, 0), 3); // carcaça
  const dark: DamageDef = { ...part, thresholds: [0xe665, 0x7fff, 0x28f, 0] };
  assert.equal(damageEntry(dark, 0.95), 0);
  assert.equal(damageEntry(dark, 0.85), 1);
});
