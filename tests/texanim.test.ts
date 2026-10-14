// Animação de material (src/texanim.ts): canais do objeto → deslocamento de UV, escala de cor e alfa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { MeshDef, ModelDoc } from '../src/assets';
import type { RigClip } from '../src/rig';
import { ObjectClips } from '../src/objanim';
import { MaterialAnimator } from '../src/texanim';

// Trilha tipo 4 (Hermite) de 0 a 2 em 480 quadros, como a água de Paris DM (objeto 0x254dc0).
const water: RigClip = {
  category: 0,
  start: 0,
  duration: 480,
  role: 'other',
  loop: true,
  tracks: [{ ch: 0, kind: 0x1014, step: 480 / 255, base: 0, scale: 2 / 255, t0: 0, keys: [[0, 0, 0.0041504, 0.0041504], [255, 255, 0.0041504, 0.0041504]] }],
};

const meshDef = (mat: number[]): MeshDef =>
  ({ offset: 0, flags: 0x80990a04, texture: null, texture2: null, scale: 1, packed: '', poolOwner: null, sphere: [0, 0, 0, 1], mat }) as MeshDef;

/** Quadro que a instância do clipe dá no tique `tick` (a trilha da água vai de 0 a 2 quase linear: quadro ≈ v·240). */
function frameAt(clip: RigClip, tick: number, play: boolean, finish = false): number {
  const probe = clip;
  const c = new ObjectClips();
  c.register('n1', [probe]);
  if (play) c.play('n1', 0, 0);
  if (finish) c.finish('n1');
  let v = NaN;
  c.evaluate('n1', [probe], tick, (_ch, x) => (v = x));
  return v * 240;
}

test('instância em laço dá a volta; sem laço prende no fim; sem instância fica no início', () => {
  assert.ok(Math.abs(frameAt(water, 500, true) - 20) < 2);
  assert.ok(Math.abs(frameAt({ ...water, loop: false }, 500, true) - 480) < 2);
  assert.ok(Math.abs(frameAt({ ...water, start: 10 }, 500, false) - 10) < 2);
  assert.ok(Math.abs(frameAt(water, 100, true, true) - 480) < 2); // pular: tempo 1, sem laço
});

test('auto-play (FUN_002111f8) toca só os clipes com o bit auto; a instância mais nova escreve por cima', () => {
  const c = new ObjectClips();
  c.register('n1', [{ ...water, auto: true } as RigClip, { ...water, category: 2, auto: false } as RigClip], 0xc23);
  c.autoStart(0);
  assert.equal(c.objectOf(0xc23), 'n1');
  assert.equal(c.done('n1', 2, 10), true); // nunca tocou
  assert.equal(c.play('n1', 2, 5), true);
  assert.equal(c.play('n1', 7, 5), false);
  assert.equal(c.done('n1', 0, 1e6), false); // laço não acaba
});

test('canal de V desloca a textura; canais ausentes ficam no padrão do pacote (0 e 1,0)', () => {
  const doc = { matAnim: { n1: { clips: [water] } } } as unknown as ModelDoc;
  const clips = new ObjectClips();
  const anim = new MaterialAnimator(doc, clips);
  clips.play('n1', 0, 0);
  const base = new THREE.MeshBasicMaterial({ map: new THREE.Texture(), transparent: true });
  const { material } = anim.material(base, 'k', meshDef([-1, 0, -1, -1, -1, -1]), 'n1');
  assert.notEqual(material, base);
  anim.update(240);
  const m = material as THREE.MeshBasicMaterial;
  assert.equal(m.map!.offset.x, 0);
  assert.ok(Math.abs(m.map!.offset.y - 1) < 0.02, `V = ${m.map!.offset.y}`);
  assert.deepEqual([m.color.r, m.color.g, m.color.b, m.opacity], [1, 1, 1, 1]);
  assert.equal(base.map!.offset.y, 0); // a textura compartilhada não muda
});

test('mesmo objeto e mesmos canais dividem o material', () => {
  const doc = { matAnim: { n1: { clips: [water] } } } as unknown as ModelDoc;
  const anim = new MaterialAnimator(doc, new ObjectClips());
  const base = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
  const a = anim.material(base, 'k', meshDef([-1, 0, -1, -1, -1, -1]), 'n1');
  const b = anim.material(base, 'k', meshDef([-1, 0, -1, -1, -1, -1]), 'n1');
  const c = anim.material(base, 'k', meshDef([-1, 0, -1, -1, -1, -1]), 'n2');
  assert.equal(a.material, b.material);
  assert.notEqual(a.material, c.material);
  assert.equal(anim.size, 2);
});
