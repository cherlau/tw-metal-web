// Esqueleto e clipes de animação dos carros, avaliados como o jogo (RE: FUN_0022c678 / FUN_00236e50).
// Os dados vêm de tools/rig.py: ossos (constantes, índices de canal, visibilidade, matrizes) e clipes
// (trilhas com chaves quantizadas). Matrizes no formato do PS2 (vetor-linha): p' = p · pre · R · post + t.
import * as THREE from 'three';
import type { InstanceDef, ModelDoc } from './assets';
import { VEHICLE_TO_THREE } from './coords';
import { buildBatched } from './render';

export interface RigBone {
  parent: number;
  const: number[]; // rx, ry, rz, tx, ty, tz
  chan: number[]; // índice do canal por componente (-1 = constante)
  vis: number; // >= 0 canal; -1 sempre visível; -2 nunca
  pre: number[] | null;
  post: number[] | null;
}
export interface RigTrack {
  ch: number;
  kind: number;
  step: number;
  base: number;
  scale: number;
  t0?: number;
  /** tipos 1/4/5/6: [t (byte), v (byte), m0, m1]; tipo 2: [i, v]; tipo 0: [t, v, c3, c2, c1]; tipo 3: [] */
  keys: number[][];
}
export interface RigClip {
  category: number;
  start?: number;
  duration: number;
  role: 'spin' | 'steer' | 'susp' | 'weapon' | 'other';
  /** roda (0..3) dos clipes de giro/suspensão/esterço */
  wheel?: number;
  /** armas cujo suporte este clipe abre (FUN_00148e00) */
  weapons?: string[];
  tracks: RigTrack[];
}
export interface RigDoc {
  bones: RigBone[];
  clips: RigClip[];
  /** Valor de repouso por canal (clipes em t=0; pose de bind nos ossos com nó 0x15). */
  rest?: Record<string, number>;
  /** Canais de roda sem clipe (o código do jogo escreve direto): giro (rx) e esterço (rz). */
  direct?: { spin: number[]; steer: number[] };
  /** Velocidade dos clipes de suporte de arma (FUN_00127778: 2 nos carros Head-On, 1 nos HC). */
  mountSpeed?: number;
}

/** Maior i em [0, last) com byte de tempo ≤ int((t − t0)/passo) — busca dos amostradores do jogo. */
function segment(tr: RigTrack, frame: number, last: number): number {
  const u = tr.step ? Math.trunc((frame - (tr.t0 ?? 0)) / tr.step) : 0;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr.keys[mid][0] <= u) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Valor da trilha no quadro `frame` do clipe — mesma regra de tools/rig.py: sample (amostradores 0x2c77e0). */
export function sampleTrack(tr: RigTrack, frame: number): number {
  const k = tr.kind & 7;
  const keys = tr.keys;
  if (k === 3 || !keys.length) return tr.base;
  if (k === 0) {
    let i = 0;
    while (i + 2 < keys.length && keys[i + 1][0] <= frame) i++;
    const [t, v, c3, c2, c1] = keys[i];
    const d = frame - t;
    return v + c1 * d + c2 * d * d + c3 * d * d * d;
  }
  const t0 = tr.t0 ?? 0;
  const val = (key: number[]) => tr.base + key[1] * tr.scale;
  const tim = (key: number[]) => t0 + key[0] * tr.step;
  if (k === 2) {
    const u = tr.step ? (frame - t0) / tr.step : 0;
    const i = Math.min(Math.max(Math.trunc(u), 0), keys.length - 1);
    const next = keys[Math.min(i + 1, keys.length - 1)];
    return val(keys[i]) + (val(next) - val(keys[i])) * (u - i);
  }
  if (k === 5) {
    if (keys.length === 1 || frame >= tim(keys[keys.length - 1])) return val(keys[keys.length - 1]);
    return val(keys[segment(tr, frame, keys.length - 1)]);
  }
  if (keys.length === 1) return val(keys[0]);
  const i = segment(tr, frame, keys.length - 1);
  const a = keys[i];
  const b = keys[i + 1];
  const span = tim(b) - tim(a);
  const s = span ? (frame - tim(a)) / span : 0;
  const va = val(a);
  const d = val(b) - va;
  if (k === 6) return va + s * s * 3 * d - s * s * s * 2 * d;
  const m0 = k === 1 ? a[2] : a[2] * span;
  const m1 = k === 1 ? a[3] : b[2] * span;
  return va + s * m0 + s * s * (3 * d - 2 * m0 - m1) + s * s * s * (m0 + m1 - 2 * d);
}

/** Tempo normalizado 0..1 (FUN_002113c0) -> quadro do clipe (FUN_00212170). */
export function clipFrame(c: RigClip, t01: number): number {
  const start = c.start ?? 0;
  return start + Math.min(1, Math.max(0, t01)) * (c.duration - start);
}

/** Rotação exatamente como FUN_00236e50 (linha-major, uso p · M). */
function euler(rx: number, ry: number, rz: number, out: number[]): void {
  const sx = Math.sin(rx), sy = Math.sin(ry), sz = Math.sin(rz);
  const cx = Math.cos(rx), cy = Math.cos(ry), cz = Math.cos(rz);
  out[0] = cy * cz; out[1] = -cy * sz; out[2] = sy; out[3] = 0;
  out[4] = sx * sy * cz + cx * sz; out[5] = -sx * sy * sz + cx * cz; out[6] = -sx * cy; out[7] = 0;
  out[8] = -cx * sy * cz + sx * sz; out[9] = cx * sy * sz + sx * cz; out[10] = cx * cy; out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
}

/** a · b (linha-major 4x4). */
function mul(a: number[], b: number[], out: number[]): void {
  const r = new Array<number>(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
  for (let k = 0; k < 16; k++) out[k] = r[k];
}

/** Esterço máximo dos canais diretos (rad): ⚠️ ESCOLHA DO HOST = amplitude típica dos clipes de esterço (0,611). */
const STEER_DIRECT = 0.611;

export class CarRig {
  readonly group = new THREE.Group();
  readonly channels: Float32Array;
  /** Tempo atual (0..1) de cada clipe, por categoria. */
  readonly time = new Map<number, number>();
  private boneGroups: THREE.Group[] = [];
  private world: number[][];

  private constructor(readonly rig: RigDoc) {
    let n = 0;
    for (const b of rig.bones) for (const c of [...b.chan, b.vis]) n = Math.max(n, c + 1);
    for (const c of rig.clips) for (const t of c.tracks) n = Math.max(n, t.ch + 1);
    this.channels = new Float32Array(n);
    for (const [k, v] of Object.entries(rig.rest ?? {})) if (Number(k) < n) this.channels[Number(k)] = v;
    this.world = rig.bones.map(() => new Array<number>(16).fill(0));
    for (const c of rig.clips) if (c.role !== 'other') this.time.set(c.category, 0);
  }

  /** Monta o carro (batching por osso) a partir das instâncias com índice de osso `b`. */
  static async build(doc: ModelDoc & { rig: RigDoc }, bin: ArrayBuffer, instances: (InstanceDef & { b?: number })[]): Promise<CarRig> {
    const r = new CarRig(doc.rig);
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.matrix.copy(VEHICLE_TO_THREE);
    r.group.add(root);
    const byBone = new Map<number, InstanceDef[]>();
    for (const i of instances) {
      const k = i.b ?? -1;
      if (!byBone.has(k)) byBone.set(k, []);
      byBone.get(k)!.push(i);
    }
    r.boneGroups = doc.rig.bones.map(() => new THREE.Group());
    for (const g of r.boneGroups) {
      g.matrixAutoUpdate = false;
      root.add(g);
    }
    for (const [k, list] of byBone) {
      const { group } = await buildBatched(doc, bin, list);
      (k >= 0 ? r.boneGroups[k] : root).add(group);
    }
    r.update();
    return r;
  }

  /** Rodas sem clipe: giro (fase 0..1, mesma convenção dos clipes 0..−2π) e esterço (−1..1). */
  setDirect(phase: number, steer: number): void {
    const d = this.rig.direct;
    if (!d) return;
    for (const c of d.spin) if (c < this.channels.length) this.channels[c] = -2 * Math.PI * phase; // mesmo sentido dos clipes de giro (0 → −2π)
    for (const c of d.steer) if (c < this.channels.length) this.channels[c] = steer * STEER_DIRECT;
  }

  /** Avalia os clipes nos tempos atuais, depois os ossos (matriz e visibilidade). */
  update(): void {
    const ch = this.channels;
    for (const c of this.rig.clips) {
      // clipes sem papel no runtime ficam no repouso (rig.rest), a menos que alguém defina o tempo deles
      if (c.role === 'other' && !this.time.has(c.category)) continue;
      const t = this.time.get(c.category) ?? 0;
      const frame = clipFrame(c, t);
      for (const tr of c.tracks) if (tr.ch < ch.length) ch[tr.ch] = sampleTrack(tr, frame);
    }
    const vals = [0, 0, 0, 0, 0, 0];
    const m = new Array<number>(16);
    const visible: boolean[] = [];
    this.rig.bones.forEach((b, i) => {
      for (let k = 0; k < 6; k++) {
        const c = b.chan[k];
        const v = c >= 0 ? ch[c] : b.const[k];
        vals[k] = k < 3 ? -v : v; // FUN_0021b3c0: rotação sempre negada (constante ou canal)
      }
      euler(vals[0], vals[1], vals[2], m);
      if (b.pre) mul(b.pre, m, m);
      if (b.post) mul(m, b.post, m);
      m[12] += vals[3];
      m[13] += vals[4];
      m[14] += vals[5];
      const w = this.world[i];
      if (b.parent >= 0) mul(m, this.world[b.parent], w);
      else for (let k = 0; k < 16; k++) w[k] = m[k];
      // linha-major (vetor-linha) -> Matrix4.fromArray lê coluna-major = transposta = forma do Three
      this.boneGroups[i].matrix.fromArray(w);
      const own = b.vis === -2 ? false : b.vis >= 0 ? ch[b.vis] !== 0 : true;
      visible[i] = own && (b.parent < 0 || visible[b.parent]);
      this.boneGroups[i].visible = visible[i];
    });
  }

  clipsWithRole(role: RigClip['role']): RigClip[] {
    return this.rig.clips.filter((c) => c.role === role);
  }
}

/** Carro parado (menu, visualizador): com esqueleto, pose de repouso (suspensão e esterço no meio). */
export async function buildCarRest(doc: ModelDoc, bin: ArrayBuffer): Promise<THREE.Group> {
  const rigDoc = (doc as ModelDoc & { rig?: RigDoc }).rig;
  if (!rigDoc) {
    const { group } = await buildBatched(doc, bin, doc.scene);
    group.matrixAutoUpdate = false;
    group.matrix.copy(VEHICLE_TO_THREE);
    const g = new THREE.Group();
    g.add(group);
    return g;
  }
  const r = await CarRig.build(doc as ModelDoc & { rig: RigDoc }, bin, doc.scene);
  for (const c of r.rig.clips) if (c.role === 'susp' || c.role === 'steer') r.time.set(c.category, 0.5);
  r.update();
  return r.group;
}

/** Caixa das malhas visíveis e não aditivas de um grupo já montado. */
export function visibleBox(group: THREE.Object3D): THREE.Box3 {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  group.traverse((o) => {
    let shown = true;
    o.traverseAncestors((a) => (shown &&= a.visible));
    const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
    if ((o as THREE.Mesh).isMesh && shown && mat?.blending !== THREE.AdditiveBlending) box.expandByObject(o);
  });
  return box;
}
