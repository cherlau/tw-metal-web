// Montagem de malhas e materiais a partir do formato .json+.bin (compartilhado: visualizador e jogo).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildGeometry, instanceMatrix, loadTexture, type InstanceDef, type MeshDef, type ModelDoc } from './assets';
import type { MaterialAnimator } from './texanim';

export interface RenderOptions {
  /** Padrão true: textura × cor de vértice (a luz do PS2 vem pré-calculada nas cores). */
  unlit?: boolean;
  vertexColors?: boolean;
}

const materialCache = new Map<string, THREE.Material>();

/**
 * Luzes dinâmicas (pool 0x585880 de 32, FUN_0024c448; as 8 mais perto do carro do jogador vão para o desenho,
 * FUN_0024c740). Cor RGB 0..255 da tabela de projéteis (FUN_0024c350), raio 250 pés (FUN_0024c300).
 * ⚠️ host: soma cor·textura·(1 − d/r)² no fragmento (o microcódigo da VU não foi lido); escala 255 = 1,0.
 */
export const MAX_DYN_LIGHTS = 8;
export const dynLights = {
  uDynPos: { value: Array.from({ length: MAX_DYN_LIGHTS }, () => new THREE.Vector3()) },
  uDynColor: { value: Array.from({ length: MAX_DYN_LIGHTS }, () => new THREE.Color(0, 0, 0)) },
  uDynRadius: { value: new Array<number>(MAX_DYN_LIGHTS).fill(1) },
};

function withDynLights(m: THREE.Material) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, dynLights);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDynWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvDynWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vDynWorld;
uniform vec3 uDynPos[${MAX_DYN_LIGHTS}];
uniform vec3 uDynColor[${MAX_DYN_LIGHTS}];
uniform float uDynRadius[${MAX_DYN_LIGHTS}];`,
      )
      .replace(
        '#include <opaque_fragment>',
        `vec3 dynAdd = vec3(0.0);
for (int i = 0; i < ${MAX_DYN_LIGHTS}; i++) {
  vec3 d = vDynWorld - uDynPos[i];
  float f = max(1.0 - length(d) / uDynRadius[i], 0.0);
  dynAdd += uDynColor[i] * f * f;
}
outgoingLight += dynAdd * diffuseColor.rgb;
#include <opaque_fragment>`,
      );
  };
}

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
      // ⚠️ host: aditivos (fogo, brilhos) sem névoa — misturar a cor da névoa num aditivo acenderia a malha
      fog: !additive,
    });
    if (unlit && !additive) withDynLights(material);
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
  opt: RenderOptions & {
    filter?: (key: string, def: MeshDef) => boolean;
    sprites?: boolean;
    /** Malhas com canais de material (def.mat + inst.obj) recebem material próprio do objeto (src/texanim.ts). */
    animator?: MaterialAnimator;
  } = {},
): Promise<{ group: THREE.Group; drawCalls: number; triangles: number }> {
  const buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const sprites: THREE.Sprite[] = [];
  for (const inst of instances) {
    const key = inst.mesh;
    const def = doc.meshes[key];
    const xf = instanceMatrix(inst);
    if (opt.filter && !opt.filter(key, def)) continue;
    // Sprites (brilhos aditivos: luz de freio, turbo) — opcional; os níveis desenham os seus em levelfx.
    if (opt.sprites) for (const s of def.sprites ?? []) sprites.push(await spriteFor(doc, def, s, xf));
    for (const part of def.parts ?? []) {
      let { key: mk, material } = await materialFor(doc, def, part.texture, opt);
      if (opt.animator && def.mat && inst.obj) ({ key: mk, material } = opt.animator.material(material, mk, def, inst.obj));
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
  for (const sp of sprites) group.add(sp);
  return { group, drawCalls: buckets.size + sprites.length, triangles };
}

const spriteMaterials = new Map<string, THREE.SpriteMaterial>();

/** Sprite aditivo de uma malha (lote de sprite da VU1: centro, tamanho, cor, retângulo de UV), como levelfx. */
/**
 * UV de sprite normalizado. O `uv` do conversor = bruto/4096, mas o bruto é texel em ponto fixo 12.4 (texel·16):
 * normaliza pela textura (×256/largura, ×256/altura). Antes saía só o canto 4×4 de uma textura 32×32.
 */
export const spriteUV = (uv: readonly number[], tex: { width: number; height: number }): number[] =>
  uv.map((v, i) => (v * 256) / ((i % 2 ? tex.height : tex.width) || 256));

async function spriteFor(doc: ModelDoc, def: MeshDef, s: NonNullable<MeshDef['sprites']>[number], xf: THREE.Matrix4 | null) {
  const texDef = def.texture ? doc.textures[def.texture] : undefined;
  const key = `${doc.source}|${def.texture}|${s.color.join(',')}|${s.uv.join(',')}`;
  let mat = spriteMaterials.get(key);
  if (!mat) {
    let map: THREE.Texture | null = null;
    if (texDef) {
      map = (await loadTexture(texDef)).clone();
      const [u0, v0, u1, v1] = spriteUV(s.uv, texDef);
      map.offset.set(Math.min(u0, u1), Math.min(v0, v1));
      map.repeat.set(Math.abs(u1 - u0) || 1, Math.abs(v1 - v0) || 1);
      map.needsUpdate = true;
    }
    mat = new THREE.SpriteMaterial({
      map,
      color: new THREE.Color(s.color[0], s.color[1], s.color[2]),
      opacity: Math.min(1, s.color[3] * 2), // alfa do PS2: 0x80 = 1,0
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    spriteMaterials.set(key, mat);
  }
  const sp = new THREE.Sprite(mat);
  sp.position.set(...s.center);
  if (xf) sp.position.applyMatrix4(xf);
  sp.scale.setScalar(s.size);
  sp.renderOrder = 2;
  return sp;
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
