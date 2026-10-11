// Montagem de malhas e materiais a partir do formato .json+.bin (compartilhado: visualizador e jogo).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildGeometry, loadTexture, type InstanceDef, type MeshDef, type ModelDoc } from './assets';

export interface RenderOptions {
  /** Padrão true: textura × cor de vértice (a luz do PS2 vem pré-calculada nas cores). */
  unlit?: boolean;
  vertexColors?: boolean;
}

const materialCache = new Map<string, THREE.Material>();

/** flags do cabeçalho de malha, bit 15: translúcida/aditiva (fogo, fumaça, brilho) — 🟡 hipótese. */
export const isAdditive = (def: MeshDef) => (def.flags & 0x8000) !== 0;

export async function materialFor(doc: ModelDoc, def: MeshDef, texture: string | null, opt: RenderOptions = {}) {
  const unlit = opt.unlit ?? true;
  const vertexColors = opt.vertexColors ?? true;
  const texDef = texture ? doc.textures[texture] : undefined;
  const additive = isAdditive(def);
  const key = `${doc.source}|${texture}|${additive}|${texDef?.alpha}|${unlit}|${vertexColors}`;
  let material = materialCache.get(key);
  if (!material) {
    const map = texDef ? await loadTexture(texDef) : null;
    material = new (unlit ? THREE.MeshBasicMaterial : THREE.MeshLambertMaterial)({
      map,
      vertexColors,
      side: THREE.DoubleSide,
      alphaTest: !additive && texDef?.alpha === 'cutout' ? 0.5 : 0,
      transparent: additive || texDef?.alpha === 'blend',
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: !additive && texDef?.alpha !== 'blend',
    });
    materialCache.set(key, material);
  }
  return { key, material };
}

/**
 * Junta todas as instâncias com o mesmo material numa malha só (SPEC §9.4: batching estático).
 * As malhas já estão no espaço do modelo, então não há transformação por instância.
 */
export async function buildBatched(
  doc: ModelDoc,
  bin: ArrayBuffer,
  instances: InstanceDef[],
  opt: RenderOptions & { filter?: (key: string, def: MeshDef) => boolean } = {},
): Promise<{ group: THREE.Group; drawCalls: number; triangles: number }> {
  const buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();
  for (const { mesh: key } of instances) {
    const def = doc.meshes[key];
    if (opt.filter && !opt.filter(key, def)) continue;
    for (const part of def.parts ?? []) {
      const { key: mk, material } = await materialFor(doc, def, part.texture, opt);
      if (!buckets.has(mk)) buckets.set(mk, { material, geos: [] });
      buckets.get(mk)!.geos.push(buildGeometry(part, bin));
    }
  }
  const group = new THREE.Group();
  let triangles = 0;
  for (const { material, geos } of buckets.values()) {
    const merged = mergeGeometries(geos, false);
    if (!merged) throw new Error('mergeGeometries falhou');
    triangles += merged.index!.count / 3;
    group.add(new THREE.Mesh(merged, material));
  }
  return { group, drawCalls: buckets.size, triangles };
}

/** Uma malha (todas as partes + sprites) como Group nomeado (para listas e destaque). */
export async function buildMeshObject(doc: ModelDoc, bin: ArrayBuffer, key: string, opt: RenderOptions = {}) {
  const def = doc.meshes[key];
  const group = new THREE.Group();
  group.name = key;
  for (const part of def.parts ?? []) {
    const { material } = await materialFor(doc, def, part.texture, opt);
    const mesh = new THREE.Mesh(buildGeometry(part, bin), material);
    mesh.userData.material = material;
    group.add(mesh);
  }
  const texDef = def.texture ? doc.textures[def.texture] : undefined;
  const map = texDef ? await loadTexture(texDef) : null;
  for (const s of def.sprites ?? []) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map, color: new THREE.Color(s.color[0], s.color[1], s.color[2]), blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    sprite.position.set(...s.center);
    sprite.scale.setScalar(s.size);
    group.add(sprite);
  }
  return group;
}
