// Colisão do nível com objetos destrutíveis: dono por triângulo (`tag`) e geometria escondida pelo estado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LevelCollision } from '../src/collision';
import type { ModelDoc } from '../src/assets';

/** Dois quadrados no plano y=0 (x 0..10 e 20..30), um por instância. */
function doc(): { doc: ModelDoc; bin: ArrayBuffer } {
  const quads = [0, 20].map((x0) => [x0, 0, 0, x0 + 10, 0, 0, x0 + 10, 0, 10, x0, 0, 10]);
  const buf = new ArrayBuffer(2 * (12 * 4 + 6 * 4));
  const meshes: ModelDoc['meshes'] = {};
  quads.forEach((q, k) => {
    const off = k * (12 * 4 + 6 * 4);
    new Float32Array(buf, off, 12).set(q);
    new Uint32Array(buf, off + 48, 6).set([0, 1, 2, 0, 2, 3]);
    meshes[`m${k}`] = {
      offset: k, flags: 0, texture: null, texture2: null, scale: 1, packed: 'none', poolOwner: null, sphere: [0, 0, 0, 1],
      parts: [{ texture: null, attributes: { position: [off, 12], indices: [off + 48, 6] } as never }],
    };
  });
  const d = { scene: [{ mesh: 'm0', bone: null }, { mesh: 'm1', bone: null, dmg: [['n1', 0]] }], meshes } as unknown as ModelDoc;
  return { doc: d, bin: buf };
}

test('raycast devolve a instância dona do triângulo', () => {
  const { doc: d, bin } = doc();
  const c = new LevelCollision(d, bin, new THREE.Matrix4());
  assert.equal(c.raycast({ x: 5, y: 5, z: 5 }, { x: 0, y: -1, z: 0 }, 10)?.tag, 0);
  assert.equal(c.raycast({ x: 25, y: 5, z: 5 }, { x: 0, y: -1, z: 0 }, 10)?.tag, 1);
  assert.equal(c.closestPoint({ x: 25, y: 1, z: 5 }, 3)?.tag, 1);
});

test('instância escondida sai da colisão e volta igual', () => {
  const { doc: d, bin } = doc();
  const c = new LevelCollision(d, bin, new THREE.Matrix4());
  c.setVisible([1], false);
  assert.equal(c.raycast({ x: 25, y: 5, z: 5 }, { x: 0, y: -1, z: 0 }, 10), null);
  assert.equal(c.raycast({ x: 5, y: 5, z: 5 }, { x: 0, y: -1, z: 0 }, 10)?.tag, 0);
  c.setVisible([1], true);
  assert.ok(Math.abs(c.raycast({ x: 25, y: 5, z: 5 }, { x: 0, y: -1, z: 0 }, 10)!.distance - 5) < 1e-6);
  assert.deepEqual(c.instanceBox(1).min.toArray(), [20, 0, 0]);
});
