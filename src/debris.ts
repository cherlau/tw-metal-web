// Ações dos nós 0x13 (actionDispatch.cpp) e destroços físicos (FUN_0016e678 / FUN_00173a80). RE: docs/NATIVE.md,
// "Ações e destroços". Coordenadas: a ação vive no espaço do PS2 do objeto (`frame` leva PS2 local -> mundo Three).
import * as THREE from 'three';
import type { ActionDef, DebrisModelDef, ModelDoc } from './assets';
import { buildBatched } from './render';

const TICK = 1 / 60; // relógio dos temporizadores (DAT_002f4548, 60 Hz)
/** FUN_0016e678: vida das peças (+0x302 = 0xB4 tiques). */
export const DEBRIS_LIFE = 180;
/** FUN_00173a80: a partir de vida − 60 (iGpffff8a6c) o alfa cai 1 por segundo. */
export const DEBRIS_FADE = 60;
/** FUN_00173a80 → FUN_00251dc8(dt, −128): gravidade do voo livre (pés/s²). */
export const DEBRIS_GRAVITY = -128;
/** Impulso: (velocidade-base + fator) × 1000 (fGpffff8a1c) / 60 (DAT_002f4544) / massa. */
const IMPULSE = 1000 / 60;
/** FUN_001729e0: fator do golpe = 1 sem golpe direto nem batida (obj+0x80 = obj+0x81 = 0), como na vida do carro. */
const HIT_FACTOR = 1;
/** Espalhamento da direção: ± 5 % do raio da peça (FUN_00237cb0 nos eixos; z só para cima). */
const SPREAD = 0.05;
// ⚠️ ESCOLHA DO HOST: semântica dos coeficientes do corpo (+0x14 = 0,25 → restituição, +0x10 = 0,8 → atrito) e o
// contato simplificado (plano do chão sob a peça, um ponto por passo); o jogo tem o próprio integrador de contato.
const RESTITUTION = 0.25;
const FRICTION = 0.8;

export interface GroundQuery {
  raycast(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDist: number): { distance: number; normal?: { x: number; y: number; z: number } } | null;
}

type DebrisAction = Extract<ActionDef, { type: 3 }>;

/** Corpo rígido de uma peça: estado no mundo do Three; caixa no espaço local da peça (PS2). */
export class DebrisBody {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly rot = new THREE.Quaternion();
  readonly omega = new THREE.Vector3();
  age = 0; // tiques
  alpha = 1;
  /** Vida em tiques (Infinity = fica até ser reciclado, como as árvores tombadas de FUN_001e2000). */
  life = DEBRIS_LIFE;
  /** Quanto um canto pode ficar abaixo do chão sem contato (objetos que já nascem enterrados, como árvores). */
  slop = 0;
  resting = false;
  /** Ponto local do topo (FUN_001e2770): ao chegar a ≤ 3 pés do chão chama `onLand(|v|², ponto no mundo)` uma vez. */
  landTip: THREE.Vector3 | null = null;
  onLand: ((v2: number, at: THREE.Vector3) => void) | null = null;
  private landed = false;
  private readonly invInertia: THREE.Vector3; // diagonal, no espaço local
  private readonly corners: THREE.Vector3[];

  constructor(readonly mass: number, corners: THREE.Vector3[]) {
    this.corners = corners;
    // FUN_002507e8: caixa I = m/12·(y²+z², x²+z², x²+y²) com as dimensões do conjunto de cantos
    const ext = [0, 1, 2].map((k) => {
      const v = corners.map((c) => c.getComponent(k));
      return Math.max(...v) - Math.min(...v);
    });
    const [x, y, z] = ext;
    const inv = (a: number) => (a > 1e-6 ? 1 / a : 0);
    this.invInertia = new THREE.Vector3(inv((mass / 12) * (y * y + z * z)), inv((mass / 12) * (x * x + z * z)), inv((mass / 12) * (x * x + y * y)));
  }

  /** ω no mundo a partir de um momento angular L no mundo: R·I⁻¹·Rᵀ·L. */
  private applyInvInertia(l: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const inv = this.rot.clone().invert();
    out.copy(l).applyQuaternion(inv).multiply(this.invInertia).applyQuaternion(this.rot);
    return out;
  }

  /** Impulso J (mundo) no ponto p (mundo): FUN_00250c98 (linear) + FUN_00250cd0 (angular). */
  impulse(j: THREE.Vector3, p: THREE.Vector3): void {
    this.vel.addScaledVector(j, 1 / this.mass);
    const r = p.clone().sub(this.pos);
    this.omega.add(this.applyInvInertia(r.cross(j), new THREE.Vector3()));
  }

  cornerWorld(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.corners[i]).applyQuaternion(this.rot).add(this.pos);
  }

  /** Um tique: voo livre com gravidade −128 e contato com o chão (plano sob a peça). */
  step(dt: number, ground: GroundQuery | null): void {
    this.age += dt / TICK;
    if (this.age > this.life - DEBRIS_FADE) this.alpha = Math.max(0, this.alpha - dt);
    if (this.resting) return;
    this.vel.y += DEBRIS_GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);
    const w = this.omega.length();
    if (w > 1e-6) this.rot.premultiply(new THREE.Quaternion().setFromAxisAngle(this.omega.clone().divideScalar(w), w * dt)).normalize();
    if (!ground) return;
    if (this.landTip && !this.landed) {
      const tip = this.landTip.clone().applyQuaternion(this.rot).add(this.pos);
      const hit = ground.raycast({ x: tip.x, y: tip.y + 10, z: tip.z }, { x: 0, y: -1, z: 0 }, 110);
      if (hit && hit.distance - 10 <= 3) {
        this.landed = true;
        this.onLand?.(this.vel.lengthSq(), tip.setY(tip.y + 10 - hit.distance));
      }
    }
    // Canto mais fundo: raio curto por canto (sobe 3 pés e desce 6) — funciona em encosta e sob outras copas.
    let deepest = -1;
    let depth = 0;
    const n = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Vector3();
    for (let i = 0; i < this.corners.length; i++) {
      this.cornerWorld(i, c);
      const top = c.y + 3 + this.slop;
      const hit = ground.raycast({ x: c.x, y: top, z: c.z }, { x: 0, y: -1, z: 0 }, 6 + this.slop);
      if (!hit) continue;
      const d = c.y - (top - hit.distance) + this.slop; // < 0: canto abaixo da superfície além da folga
      if (d < depth) {
        depth = d;
        deepest = i;
        n.set(hit.normal?.x ?? 0, hit.normal?.y ?? 1, hit.normal?.z ?? 0).normalize();
        if (n.y < 0) n.negate();
      }
    }
    if (deepest < 0) return;
    this.pos.y -= depth;
    const p = this.cornerWorld(deepest, new THREE.Vector3());
    const r = p.clone().sub(this.pos);
    const vp = this.vel.clone().add(this.omega.clone().cross(r));
    const vn = vp.dot(n);
    if (vn < 0) {
      const k = (dir: THREE.Vector3) => 1 / this.mass + dir.dot(this.applyInvInertia(r.clone().cross(dir), new THREE.Vector3()).cross(r));
      const jn = (-(1 + RESTITUTION) * vn) / k(n);
      this.impulse(n.clone().multiplyScalar(jn), p);
      const vt = vp.clone().addScaledVector(n, -vn);
      const st = vt.length();
      if (st > 1e-4) {
        const t = vt.divideScalar(st);
        const jt = Math.min(FRICTION * jn, st / k(t));
        this.impulse(t.multiplyScalar(-jt), p);
      }
    }
    if (this.vel.lengthSq() < 1 && this.omega.lengthSq() < 0.25) {
      this.resting = true;
      this.vel.set(0, 0, 0);
      this.omega.set(0, 0, 0);
    }
  }
}

/**
 * Estado inicial de uma peça (FUN_0016e678): posição = frame · pos; direção = (pos − centro) girada pelo objeto,
 * espalhada ± 5 % do raio (z do PS2 só para cima) e normalizada; velocidade = direção × (base + fator) × 1000/60 /
 * massa; o mesmo impulso aplicado no canto máximo da caixa dá o giro.
 */
export function launchBody(
  model: DebrisModelDef,
  action: Pick<DebrisAction, 'center' | 'speed' | 'mass'>,
  piecePos: number[],
  frame: THREE.Matrix4,
  rand: () => number = Math.random,
): DebrisBody {
  const [c, a0, a1, a2] = [model.center, ...model.axes].map((v) => new THREE.Vector3(v[0], v[1], v[2]));
  const corners: THREE.Vector3[] = [];
  for (const s0 of [-1, 1]) for (const s1 of [-1, 1]) for (const s2 of [-1, 1])
    corners.push(c.clone().addScaledVector(a0, s0).addScaledVector(a1, s1).addScaledVector(a2, s2));
  const mass = action.mass > 0 ? action.mass : 1;
  const body = new DebrisBody(mass, corners);
  const local = new THREE.Vector3(piecePos[0], piecePos[1], piecePos[2]);
  body.pos.copy(local).applyMatrix4(frame);
  const rot = new THREE.Matrix4().extractRotation(frame);
  body.rot.setFromRotationMatrix(rot);
  const dir = local.clone().sub(new THREE.Vector3(action.center[0], action.center[1], action.center[2]));
  if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
  dir.normalize().applyMatrix4(rot);
  const spread = model.radius * SPREAD;
  dir.x += (rand() * 2 - 1) * spread;
  dir.z += (rand() * 2 - 1) * spread;
  dir.y += rand() * spread; // z do PS2 (para cima) = y do Three
  dir.normalize();
  const j = dir.multiplyScalar(((action.speed + HIT_FACTOR) * IMPULSE) / mass); // auStack_1c0
  const tip = c.clone().add(a0).add(a1).add(a2).applyQuaternion(body.rot).add(body.pos);
  body.impulse(j, tip);
  return body;
}

interface Piece {
  body: DebrisBody;
  obj: THREE.Object3D;
  faded: boolean;
  /** grupo de reciclagem (ex.: 'topple', no máximo 15 — FUN_001e2000) */
  pool?: string;
}

/** Corpo de caixa a partir dos cantos locais (espaço do objeto), posto no mundo por `frame`. */
export function boxBody(corners: THREE.Vector3[], frame: THREE.Matrix4, mass = 1): DebrisBody {
  const b = new DebrisBody(mass, corners);
  b.pos.setFromMatrixPosition(frame);
  b.rot.setFromRotationMatrix(new THREE.Matrix4().extractRotation(frame));
  return b;
}

/** Despacha ações (com atraso em tiques) e simula/desenha as peças de destroço soltas. */
export class DebrisSystem {
  private pending: { at: number; action: ActionDef; frame: THREE.Matrix4; doc: ModelDoc; bin: ArrayBuffer }[] = [];
  private pieces: Piece[] = [];
  private templates = new Map<string, Promise<THREE.Group>>();
  private acc = 0;
  /** Som de uma ação tipo 4 (nome do banco, posição no mundo). */
  onSound: ((name: string, pos: THREE.Vector3) => void) | null = null;

  constructor(private readonly scene: THREE.Object3D, private readonly ground: GroundQuery | null) {}

  get count(): number {
    return this.pieces.length;
  }

  /** FUN_00101010: executa já ou agenda para daqui a `delay` tiques. `now` em segundos. */
  dispatch(doc: ModelDoc, bin: ArrayBuffer, action: ActionDef, frame: THREE.Matrix4, now: number): void {
    if (action.delay > 0) this.pending.push({ at: now + action.delay * TICK, action, frame: frame.clone(), doc, bin });
    else this.exec(doc, bin, action, frame, now);
  }

  private exec(doc: ModelDoc, bin: ArrayBuffer, a: ActionDef, frame: THREE.Matrix4, now: number): void {
    if (a.type === 0) for (const it of a.items) this.dispatch(doc, bin, it, frame, now);
    else if (a.type === 1) {
      if (a.child) this.dispatch(doc, bin, a.child, frame.clone().multiply(new THREE.Matrix4().fromArray(a.matrix)), now);
    } else if (a.type === 3) void this.spawn(doc, bin, a, frame);
    else if (a.type === 4 && a.name) this.onSound?.(a.name, new THREE.Vector3().setFromMatrixPosition(frame));
    // 2 (clipe em outro objeto), 5 (tremor de câmera) e 6+ não têm efeito nos carros (o jogo ignora 5+)
  }

  private template(doc: ModelDoc, bin: ArrayBuffer, key: string, model: DebrisModelDef): Promise<THREE.Group> {
    const id = `${doc.source}|${key}`;
    let t = this.templates.get(id);
    if (!t) {
      t = buildBatched(doc, bin, model.instances).then(({ group }) => {
        group.position.set(model.offset[0], model.offset[1], model.offset[2]);
        const holder = new THREE.Group();
        holder.add(group);
        return holder;
      });
      this.templates.set(id, t);
    }
    return t;
  }

  private async spawn(doc: ModelDoc, bin: ArrayBuffer, a: DebrisAction, frame: THREE.Matrix4): Promise<void> {
    for (const p of a.pieces) {
      const model = doc.debris?.[p.model];
      if (!model) continue;
      const body = launchBody(model, a, p.pos, frame);
      const obj = (await this.template(doc, bin, p.model, model)).clone();
      obj.matrixAutoUpdate = false;
      this.scene.add(obj);
      this.pieces.push({ body, obj, faded: false });
    }
  }

  /** Avança `dt` segundos em tiques de 1/60 e atualiza as matrizes. `now` em segundos. */
  update(dt: number, now: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (now < p.at) continue;
      this.pending.splice(i, 1);
      this.exec(p.doc, p.bin, { ...p.action, delay: 0 } as ActionDef, p.frame, now);
    }
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= TICK) {
      for (const p of this.pieces) p.body.step(TICK, this.ground);
      this.acc -= TICK;
    }
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const { body, obj } = this.pieces[i];
      if (body.alpha <= 0) {
        this.scene.remove(obj);
        this.pieces.splice(i, 1);
        continue;
      }
      obj.matrix.compose(body.pos, body.rot, new THREE.Vector3(1, 1, 1));
      obj.matrixWorldNeedsUpdate = true;
      if (body.alpha < 1) this.fade(this.pieces[i], body.alpha);
    }
  }

  /** Alfa da peça (FUN_00173a80 grava em instância+0xB8): materiais próprios só a partir do fade. */
  private fade(p: Piece, alpha: number): void {
    if (!p.faded) {
      p.obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = (m.material as THREE.Material).clone();
        mat.transparent = true;
        mat.userData.baseOpacity = mat.opacity;
        m.material = mat;
      });
      p.faded = true;
    }
    p.obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) (m.material as THREE.Material).opacity = alpha * ((m.material as THREE.Material).userData.baseOpacity ?? 1);
    });
  }

  /** Folga inicial: maior profundidade em que os cantos já nascem abaixo do chão (raio a partir de `fromY`). */
  static embed(body: DebrisBody, ground: GroundQuery, fromY: number): number {
    let worst = 0;
    const c = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      body.cornerWorld(i, c);
      if (c.y >= fromY) continue;
      const hit = ground.raycast({ x: c.x, y: fromY, z: c.z }, { x: 0, y: -1, z: 0 }, fromY - c.y + 50);
      if (hit) worst = Math.max(worst, fromY - hit.distance - c.y);
    }
    return worst;
  }

  /** Acrescenta um corpo já pronto (objeto no espaço local do corpo). `pool`/`max`: recicla o mais velho. */
  add(obj: THREE.Object3D, body: DebrisBody, pool?: string, max = Infinity): void {
    const same = this.pieces.filter((p) => p.pool === pool && pool !== undefined);
    if (same.length >= max) {
      const old = same[0];
      this.scene.remove(old.obj);
      this.pieces.splice(this.pieces.indexOf(old), 1);
    }
    obj.matrixAutoUpdate = false;
    this.scene.add(obj);
    this.pieces.push({ body, obj, faded: false, pool });
  }

  clear(): void {
    for (const p of this.pieces) this.scene.remove(p.obj);
    this.pieces = [];
    this.pending = [];
  }
}
