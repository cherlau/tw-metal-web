// Luzes dos níveis: sprites (brilhos de lâmpadas) e fachos (colunas/raios de luz) que o conversor já
// exporta por malha mas o batching não desenha. Coordenadas do PS2: o grupo vai dentro da raiz do nível.
import * as THREE from 'three';
import { instanceMatrix, loadTexture, type InstanceDef, type MeshDef, type ModelDoc } from './assets';

export interface BeamDef {
  points: number[][]; // (x, y, z, largura) — sempre em pares: cada par é um quadrilátero
  colors: number[][]; // (r, g, b, a) por ponto, 128 = 1,0
  uvs: number[][]; // (u esquerda, v, u direita, v) por ponto
}

/**
 * Facho voltado para a câmera em torno do próprio eixo (billboard cilíndrico): o vértice guarda as duas
 * pontas do segmento, qual ponta é (t) e o lado (±1); a expansão é feita no vertex shader.
 */
const BEAM_VERTEX = /* glsl */ `
  attribute vec3 aOther;
  attribute float aSide;
  attribute float aWidth;
  attribute vec4 aColor;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    vec4 o = modelViewMatrix * vec4(aOther, 1.0);
    vec3 axis = normalize(o.xyz - p.xyz);
    vec3 toCam = normalize(-p.xyz);
    vec3 side = normalize(cross(axis, toCam));
    p.xyz += side * aSide * aWidth * 0.5;
    vUv = uv;
    vColor = aColor;
    gl_Position = projectionMatrix * p;
  }
`;
const BEAM_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vec4 t = texture2D(map, vUv);
    gl_FragColor = vec4(t.rgb * vColor.rgb, t.a * vColor.a);
    #include <colorspace_fragment>
  }
`;

function beamGeometry(beams: BeamDef[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const other: number[] = [];
  const side: number[] = [];
  const width: number[] = [];
  const color: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (const b of beams) {
    for (let i = 0; i + 1 < b.points.length; i += 2) {
      const a = b.points[i];
      const c = b.points[i + 1];
      const base = pos.length / 3;
      // 4 vértices: (ponta A, esquerda), (A, direita), (B, esquerda), (B, direita)
      for (const [p, q, k] of [
        [a, c, i],
        [c, a, i + 1],
      ] as const) {
        const uvp = b.uvs[k] ?? [0, 0, 1, 0];
        const col = b.colors[k] ?? [1, 1, 1, 1];
        for (const s of [-1, 1]) {
          pos.push(p[0], p[1], p[2]);
          other.push(q[0], q[1], q[2]);
          // na ponta B o eixo (B->A) fica invertido; inverter o lado mantém a mesma face
          side.push(p === a ? s : -s);
          width.push(p[3]);
          color.push(col[0], col[1], col[2], Math.min(1, col[3]));
          uv.push(s < 0 ? uvp[0] : uvp[2], uvp[1]);
        }
      }
      index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aOther', new THREE.Float32BufferAttribute(other, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setAttribute('aWidth', new THREE.Float32BufferAttribute(width, 1));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(color, 4));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/** Sprites e fachos das malhas `instances` (normalmente doc.scene). Um draw call por textura. */
export async function buildLevelLights(doc: ModelDoc, instances: InstanceDef[]): Promise<THREE.Group> {
  const group = new THREE.Group();
  group.name = 'level-lights';
  const beamsByTex = new Map<string, BeamDef[]>();
  const seen = new Set<string>();
  const v = new THREE.Vector3();
  for (const inst of instances) {
    const { mesh } = inst;
    const xf = instanceMatrix(inst);
    const key = `${mesh}|${inst.matrix?.join(',') ?? inst.offset?.join(',') ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // ponto do modelo -> nível (objeto posicionado: nós 0x03/0x1F)
    const place = (x: number, y: number, z: number): [number, number, number] =>
      xf ? (v.set(x, y, z).applyMatrix4(xf), [v.x, v.y, v.z]) : [x, y, z];
    const def = doc.meshes[mesh] as MeshDef & { beams?: BeamDef[] };
    const texId = def.texture ?? def.textures?.[0];
    const texDef = texId ? doc.textures[texId] : undefined;
    if (!texDef) continue;
    if (def.beams?.length) {
      if (!beamsByTex.has(texId!)) beamsByTex.set(texId!, []);
      beamsByTex.get(texId!)!.push(
        ...(xf ? def.beams.map((b) => ({ ...b, points: b.points.map((q) => [...place(q[0], q[1], q[2]), q[3]]) })) : def.beams),
      );
    }
    if (def.sprites?.length) {
      const base = await loadTexture(texDef);
      for (const s of def.sprites) {
        const map = base.clone();
        const [u0, v0, u1, v1] = s.uv;
        map.offset.set(Math.min(u0, u1), Math.min(v0, v1));
        map.repeat.set(Math.abs(u1 - u0) || 1, Math.abs(v1 - v0) || 1);
        map.needsUpdate = true;
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map,
            color: new THREE.Color(s.color[0], s.color[1], s.color[2]),
            opacity: Math.min(1, s.color[3] * 2), // alfa do PS2: 0x80 = 1,0
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
          }),
        );
        sprite.position.set(...place(s.center[0], s.center[1], s.center[2]));
        sprite.scale.setScalar(s.size);
        sprite.renderOrder = 2;
        group.add(sprite);
      }
    }
  }
  for (const [texId, beams] of beamsByTex) {
    const map = await loadTexture(doc.textures[texId]);
    const mesh = new THREE.Mesh(
      beamGeometry(beams),
      new THREE.ShaderMaterial({
        uniforms: { map: { value: map } },
        vertexShader: BEAM_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.frustumCulled = false; // a expansão é no shader; a esfera da geometria não cobre a largura
    mesh.renderOrder = 2;
    group.add(mesh);
  }
  return group;
}

/**
 * Céu do nível (doc.sky: cúpula 412×412 + tampa, centradas na origem, modeladas pequenas). O PS2 o desenha
 * centrado na câmera; aqui: ampliado, sempre atrás de tudo (sem teste/gravação de profundidade), seguindo
 * a câmera a cada quadro.
 */
export async function buildSky(
  doc: ModelDoc,
  bin: ArrayBuffer,
  toWorld: THREE.Matrix4,
  build: (doc: ModelDoc, bin: ArrayBuffer, inst: InstanceDef[]) => Promise<{ group: THREE.Group }>,
): Promise<{ group: THREE.Group; update: (camera: THREE.Camera) => void } | null> {
  const list = (doc as ModelDoc & { sky?: InstanceDef[] }).sky ?? [];
  if (!list.length) return null;
  const { group } = await build(doc, bin, list);
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = (mesh.material as THREE.Material).clone();
    // Opaco: entra na fila opaca e, com renderOrder baixo, é desenhado antes de tudo (fundo).
    mat.transparent = false;
    mat.blending = THREE.NormalBlending;
    mat.depthTest = false;
    mat.depthWrite = false;
    mesh.material = mat;
    mesh.renderOrder = -100;
    mesh.frustumCulled = false;
  });
  group.matrixAutoUpdate = false;
  const scale = new THREE.Matrix4().makeScale(40, 40, 40); // raio ~206 -> ~8.000 (dentro do far)
  const update = (camera: THREE.Camera) => {
    group.matrix.makeTranslation(camera.position.x, camera.position.y, camera.position.z).multiply(scale).multiply(toWorld);
    group.matrixWorldNeedsUpdate = true;
  };
  return { group, update };
}
