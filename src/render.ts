// Montagem de malhas e materiais a partir do formato .json+.bin (compartilhado: visualizador e jogo).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildGeometry, instanceMatrix, loadTexture, type InstanceDef, type MeshDef, type ModelDoc } from './assets';

export interface RenderOptions {
  /** Padrão true: textura × cor de vértice (a luz do PS2 vem pré-calculada nas cores). */
  unlit?: boolean;
  vertexColors?: boolean;
}

const materialCache = new Map<string, THREE.Material>();

/** flags do cabeçalho de malha, bit 15: translúcida/aditiva (fogo, fumaça, brilho) — 🟡 hipótese. */
export const isAdditive = (def: MeshDef) => (def.flags & 0x8000) !== 0;

/**
 * Mistura do GS: Cv = (A - B) * C + D, com A/B/D ∈ {Cs, Cd, 0} e C ∈ {As, Ad, FIX}.
 * Suportadas: (Cs - Cd) * As + Cd = normal; (Cs - 0) * As + Cd = aditiva. Outras: normal (🟡).
 */
function gsBlending(alpha: [number, number, number, number, number] | undefined): THREE.Blending | null {
  if (!alpha) return null;
  const [a, b, , d] = alpha;
  if (a === 0 && b === 1 && d === 1) return THREE.NormalBlending;
  if (a === 0 && b === 2 && d === 1) return THREE.AdditiveBlending;
  return THREE.NormalBlending;
}

export async function materialFor(doc: ModelDoc, def: MeshDef, texture: string | null, opt: RenderOptions = {}) {
  const unlit = opt.unlit ?? true;
  const vertexColors = opt.vertexColors ?? true;
  const texDef = texture ? doc.textures[texture] : undefined;
  const additive = isAdditive(def);
  const gsBlend = gsBlending(def.gs?.alpha);
  const key = `${doc.source}|${texture}|${additive}|${texDef?.alpha}|${unlit}|${vertexColors}|${def.gs?.alpha?.join(',')}|${def.gs?.zwrite}`;
  let material = materialCache.get(key);
  if (!material) {
    const map = texDef ? await loadTexture(texDef) : null;
    material = new (unlit ? THREE.MeshBasicMaterial : THREE.MeshLambertMaterial)({
      map,
      vertexColors,
      side: THREE.DoubleSide,
      alphaTest: !additive && texDef?.alpha === 'cutout' ? 0.5 : 0,
      transparent: additive || gsBlend !== null || texDef?.alpha === 'blend',
      blending: additive ? THREE.AdditiveBlending : (gsBlend ?? THREE.NormalBlending),
      depthWrite: def.gs?.zwrite ?? (!additive && texDef?.alpha !== 'blend'),
    });
    // Camadas sobrepostas (reflexo) ficam exatamente sobre a pintura: empurra para a frente no z.
    if (def.gs && !additive) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -1;
    }
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
  for (const inst of instances) {
    const key = inst.mesh;
    const def = doc.meshes[key];
    const xf = instanceMatrix(inst);
    if (opt.filter && !opt.filter(key, def)) continue;
    for (const part of def.parts ?? []) {
      const { key: mk, material } = await materialFor(doc, def, part.texture, opt);
      if (!buckets.has(mk)) buckets.set(mk, { material, geos: [] });
      const g = buildGeometry(part, bin);
      // Objeto posicionado (nós 0x03/0x1F): a mesma malha pode aparecer em vários lugares -> cópia transformada.
      buckets.get(mk)!.geos.push(xf ? g.clone().applyMatrix4(xf) : g);
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

/** Caixa das malhas sólidas da cena (sem aditivas: fachos, fogo), com `matrix` aplicada. */
export function solidBox(doc: ModelDoc, bin: ArrayBuffer, matrix: THREE.Matrix4): THREE.Box3 {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (const { mesh } of doc.scene) {
    const def = doc.meshes[mesh];
    if (isAdditive(def)) continue;
    for (const part of def.parts ?? []) {
      const [o, n] = part.attributes.position;
      const a = new Float32Array(bin, o, n);
      for (let i = 0; i < n; i += 3) box.expandByPoint(p.set(a[i], a[i + 1], a[i + 2]).applyMatrix4(matrix));
    }
  }
  return box;
}
