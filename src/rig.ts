// Esqueleto e clipes de animação dos carros, avaliados como o jogo (RE: FUN_0022c678 / FUN_00236e50).
// Os dados vêm de tools/rig.py: ossos (constantes, índices de canal, visibilidade, matrizes) e clipes
// (trilhas com chaves quantizadas). Matrizes no formato do PS2 (vetor-linha): p' = p · pre · R · post + t.
import * as THREE from 'three';
import type { DamageDef, InstanceDef, ModelDoc, SelectorDef } from './assets';
import { VEHICLE_TO_THREE } from './coords';
import { buildBatched } from './render';

export interface RigBone {
  parent: number;
  const: number[]; // rx, ry, rz, tx, ty, tz
  chan: number[]; // índice do canal por componente (-1 = constante)
  vis: number; // >= 0 canal; -1 sempre visível; -2 nunca
  pre: number[] | null;
  post: number[] | null;
  /** Nó 0x18: canal de cada componente da escala (u16 +0x12/+0x14/+0x16; -1 = constante de `pre`). */
  schan?: number[];
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
  role: 'spin' | 'steer' | 'susp' | 'weapon' | 'driver' | 'other';
  /** bit 1 do u16 +0x0E do clipe: a instância toca em laço (FUN_00211348). */
  loop?: boolean;
  /** Clipes de piloto (0x22..0x25, FUN_00127060): esterço, no ar, aterrissagem, pilotando. */
  driver?: 'steer' | 'air' | 'land' | 'ride';
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
  /** Marcadores 0x00F0 (cat. 0x3C; id → tipo de arma por MARK_SLOT): FUN_00147568 pendura ali o modelo do projétil. */
  launchMarks?: { type: number; bone: number; pos: number[] }[];
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
export function euler(rx: number, ry: number, rz: number, out: number[]): void {
  const sx = Math.sin(rx), sy = Math.sin(ry), sz = Math.sin(rz);
  const cx = Math.cos(rx), cy = Math.cos(ry), cz = Math.cos(rz);
  out[0] = cy * cz; out[1] = -cy * sz; out[2] = sy; out[3] = 0;
  out[4] = sx * sy * cz + cx * sz; out[5] = -sx * sy * sz + cx * cz; out[6] = -sx * cy; out[7] = 0;
  out[8] = -cx * sy * cz + sx * sz; out[9] = cx * sy * sz + sx * cz; out[10] = cx * cy; out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
}

/** a · b (linha-major 4x4). */
export function mul(a: number[], b: number[], out: number[]): void {
  const r = new Array<number>(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
  for (let k = 0; k < 16; k++) out[k] = r[k];
}

/**
 * Entrada da máquina do piloto (FUN_001258f0 / FUN_00125688, por quadro): esterço 0..1 com 0,5 = centrado
 * (carro+0x4a8), velocidade em pés/s (carro+0x898) e quadros no ar (carro+0x7c1/+0x7c8).
 */
export interface DriverInput {
  steer01: number;
  speed: number;
  airFrames: number;
}

/** Esterço máximo dos canais diretos (rad): ⚠️ ESCOLHA DO HOST = amplitude típica dos clipes de esterço (0,611). */
const STEER_DIRECT = 0.611;

/** Categoria dos nós 0x13 ligados à vida do carro (FUN_00124288 os registra em carro+0x6190). */
const CAR_DAMAGE_CATEGORY = 0x46;
/** Atraso da piora de estado: FUN_00172768 agenda FUN_00172908 para daqui a 2 tiques de 1/60 s. */
const DAMAGE_DELAY = 2 / 60;

/** Entrada escolhida para a fração de vida (FUN_00171560): 1ª com limiar ≤ int(f·65535), senão a última. */
export function damageEntry(d: DamageDef, fraction: number): number {
  const v = Math.trunc(fraction * 65535);
  const i = d.thresholds.findIndex((t) => t <= v);
  return i < 0 ? d.thresholds.length - 1 : i;
}

/** Estado de um nó 0x13: byte de estado (nó 0x14 + 0x0C), alvo agendado (+0xA2), quando vale e a vida (+0xA4). */
interface DamageState {
  def: DamageDef;
  state: number;
  target: number;
  due: number;
  hp: number;
  /** Caixa da peça no espaço do grupo do carro (peças por golpe direto, categoria ≠ 0x46). */
  box?: THREE.Box3;
}

/** Ação solta por um nó 0x13 ao piorar de estado (FUN_00172768 → FUN_00172938). */
export interface ReleasedAction {
  node: string;
  entry: number;
  action: string;
}

/**
 * Marcador 0x00F0 de id n → slot carro+0x61d8 + 4·tipo lido por FUN_00147568/FUN_001474f0 com o tipo da classe
 * (FUN_00124288): ids 1..7 vão para o próprio tipo, 15 → 10 (Remote), 10 → 11, 11 → 12. O slot 9 (Swarmer) nunca é
 * preenchido: o jogo não mostra modelo no lançador do Swarmer.
 */
const MARK_SLOT: Record<number, number> = { 15: 10, 10: 11, 11: 12 };

export class CarRig {
  readonly group = new THREE.Group();
  readonly channels: Float32Array;
  /** Tempo atual (0..1) de cada clipe, por categoria. */
  readonly time = new Map<number, number>();
  /** Ações soltas desde a última leitura (o jogo as despacha na hora; o runtime drena por quadro). */
  readonly released: ReleasedAction[] = [];
  private boneGroups: THREE.Group[] = [];
  private world: number[][];
  private damage = new Map<string, DamageState>();
  private selectors = new Map<string, { def: SelectorDef; state: number }>();
  /** Grupos com marcas de dano/seletor: visível só se todas batem com o estado atual. */
  private tagged: { dmg: [string, number][]; sel: [string, number][]; obj: THREE.Object3D }[] = [];
  /** Grupo de cada marcador de projétil (por tipo de arma), onde o modelo é pendurado. */
  private marks = new Map<number, THREE.Group>();
  private lastFraction = 1;
  /** Piloto: estado (carro+0x6338), esterço suavizado (+0x633c), clipe ativo e mistura de entrada (FUN_00210b08). */
  private drv = { state: 0, steer: 0.5, active: -1, speed: 1 };
  private blend: { from: Map<number, number>; t: number; frames: number } | null = null;
  private driverChannels: number[] = [];

  private constructor(readonly rig: RigDoc) {
    let n = 0;
    for (const b of rig.bones) for (const c of [...b.chan, b.vis, ...(b.schan ?? [])]) n = Math.max(n, c + 1);
    for (const c of rig.clips) for (const t of c.tracks) n = Math.max(n, t.ch + 1);
    this.channels = new Float32Array(n);
    for (const [k, v] of Object.entries(rig.rest ?? {})) if (Number(k) < n) this.channels[Number(k)] = v;
    this.world = rig.bones.map(() => new Array<number>(16).fill(0));
    for (const c of rig.clips) if (c.role !== 'other' && c.role !== 'driver') this.time.set(c.category, 0);
    this.driverChannels = [...new Set(rig.clips.filter((c) => c.role === 'driver').flatMap((c) => c.tracks.map((t) => t.ch)))];
  }

  private driverClip(kind: NonNullable<RigClip['driver']>): RigClip | undefined {
    return this.rig.clips.find((c) => c.driver === kind);
  }

  /** FUN_00210b08: passa a tocar o clipe do piloto, misturando a pose atual por `frames` quadros (15 ou 30). */
  private playDriver(kind: NonNullable<RigClip['driver']>, frames: number, restart: boolean): void {
    const c = this.driverClip(kind);
    if (!c) return;
    // a primeira instância entra direto (não há pose anterior do piloto para misturar)
    this.blend = this.drv.active < 0 ? null : { from: new Map(this.driverChannels.map((ch) => [ch, this.channels[ch]])), t: 0, frames };
    this.drv.active = c.category;
    if (restart || !this.time.has(c.category)) this.time.set(c.category, 0);
  }

  /** Há clipes de piloto (veículos de FUN_00127060: Axel, Mr. Grimm, ATV, Cousin Eddy, HC Axel)? */
  get hasDriver(): boolean {
    return this.rig.clips.some((c) => c.role === 'driver');
  }

  /**
   * Máquina do piloto (FUN_001258f0 nos veículos 0x65/0x77, FUN_00125688 em 0x67/0x7a/0x73 — `variant` 'b'/'a'):
   * no ar > 5 quadros → 0x23 (estado 1); ao tocar o chão → 0x24 (estado 2) e, no fim dele, 0x25 (estado 3);
   * volante centrado (0,5) → 0x25; senão 0x22 (estado 4) com tempo = esterço suavizado (FUN_00253128: passo
   * (alvo − v)·0,1 / 0,09, mínimo 0,001 / 1e-5). 0x25 toca a 0,25× / 0,15× abaixo de 7,33 pés/s (5 mph), senão 1×.
   * `dt` em segundos.
   */
  drive(input: DriverInput, dt: number, variant: 'a' | 'b'): void {
    if (!this.hasDriver) return;
    const d = this.drv;
    const air = input.airFrames > 5;
    if (air && d.state !== 1) {
      d.state = 1;
      this.playDriver('air', 15, true);
    }
    if (!air && d.state === 1) {
      d.state = 2;
      this.playDriver('land', 15, true);
    }
    if (d.state === 2 && (this.time.get(this.driverClip('land')?.category ?? -1) ?? 1) >= 1) {
      d.state = 3;
      this.playDriver('ride', 15, false);
    }
    if (d.state !== 1 && d.state !== 2) {
      if (input.steer01 === 0.5) {
        if (d.state !== 3) {
          d.state = 3;
          this.playDriver('ride', 15, false);
        }
      } else {
        if (d.state !== 4) {
          d.state = 4;
          d.steer = 0.5;
          this.playDriver('steer', 30, false);
        }
        const [k, min] = variant === 'a' ? [0.09, 1e-5] : [0.1, 0.001];
        let step = (input.steer01 - d.steer) * k;
        if (Math.abs(step) < min) step = step < 0 ? -min : min;
        const next = d.steer + step;
        d.steer = d.steer < input.steer01 ? Math.min(next, input.steer01) : Math.max(next, input.steer01);
        const c = this.driverClip('steer');
        if (c) this.time.set(c.category, Math.min(1, Math.max(0, d.steer))); // FUN_00211988
      }
    }
    if (variant === 'b' || d.state === 3) d.speed = input.speed < 7.3333335 ? (variant === 'a' ? 0.15 : 0.25) : 1;
    // instâncias que tocam sozinhas (0x23, 0x24, 0x25): tempo += velocidade × quadros / duração
    for (const kind of ['air', 'land', 'ride'] as const) {
      const c = this.driverClip(kind);
      if (!c || c.category !== d.active) continue;
      const len = Math.max(c.duration - (c.start ?? 0), 1);
      let t = (this.time.get(c.category) ?? 0) + ((kind === 'ride' ? d.speed : 1) * dt * 60) / len;
      t = c.loop ? t - Math.floor(t) : Math.min(1, t);
      this.time.set(c.category, t);
    }
    if (this.blend) this.blend.t += dt * 60;
  }

  /**
   * Monta o carro (batching por osso, estado de dano e filho de seletor) a partir das instâncias com índice de
   * osso `b`. Instâncias com `dmg`/`sel` (doc.damageScene, doc.selectScene) aparecem só no estado atual.
   */
  static async build(doc: ModelDoc & { rig: RigDoc }, bin: ArrayBuffer, instances: InstanceDef[]): Promise<CarRig> {
    const r = new CarRig(doc.rig);
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.matrix.copy(VEHICLE_TO_THREE);
    r.group.add(root);
    for (const [node, def] of Object.entries(doc.damage ?? {}))
      r.damage.set(node, { def, state: 0, target: 0, due: 0, hp: def.maxHp });
    for (const [node, def] of Object.entries(doc.selectors ?? {})) r.selectors.set(node, { def, state: def.state });
    const byBone = new Map<string, { bone: number; dmg: [string, number][]; sel: [string, number][]; list: InstanceDef[] }>();
    for (const i of instances) {
      const dmg = (i.dmg ?? []).filter(([n]) => r.damage.has(n));
      const sel = (i.sel ?? []).filter(([n]) => r.selectors.has(n));
      const k = `${i.b ?? -1}|${dmg.map((t) => t.join(':')).join(',')}|${sel.map((t) => t.join(':')).join(',')}`;
      if (!byBone.has(k)) byBone.set(k, { bone: i.b ?? -1, dmg, sel, list: [] });
      byBone.get(k)!.list.push(i);
    }
    r.boneGroups = doc.rig.bones.map(() => new THREE.Group());
    for (const g of r.boneGroups) {
      g.matrixAutoUpdate = false;
      root.add(g);
    }
    for (const { bone, dmg, sel, list } of byBone.values()) {
      const { group } = await buildBatched(doc, bin, list, { sprites: true });
      (bone >= 0 ? r.boneGroups[bone] : root).add(group);
      if (dmg.length || sel.length) r.tagged.push({ dmg, sel, obj: group });
    }
    for (const m of doc.rig.launchMarks ?? []) {
      const slot = MARK_SLOT[m.type] ?? m.type;
      if (r.marks.has(slot)) continue;
      const g = new THREE.Group();
      g.position.set(m.pos[0], m.pos[1], m.pos[2]);
      (m.bone >= 0 ? r.boneGroups[m.bone] : root).add(g);
      r.marks.set(slot, g);
    }
    r.showTagged();
    r.update();
    // Caixa de cada peça destrutível por golpe (entrada 0, pose de repouso): base do teste de acerto. ⚠️ host
    r.group.updateMatrixWorld(true);
    for (const [node, d] of r.damage) {
      if (d.def.category === CAR_DAMAGE_CATEGORY) continue;
      const box = new THREE.Box3();
      for (const t of r.tagged) if (t.dmg.some(([n, e]) => n === node && e === 0) && t.obj.visible) box.expandByObject(t.obj);
      if (!box.isEmpty()) d.box = box;
    }
    return r;
  }

  /** O modelo tem nós 0x13 ligados à vida (inclui a carcaça mostrada com vida 0)? */
  get hasDamage(): boolean {
    for (const d of this.damage.values()) if (d.def.category === CAR_DAMAGE_CATEGORY) return true;
    return false;
  }

  /** Estado atual (entrada) de cada nó 0x13. */
  damageStates(): Record<string, number> {
    return Object.fromEntries([...this.damage].map(([n, d]) => [n, d.state]));
  }

  /** Filho atual de cada seletor 0x05. */
  selectorStates(): Record<string, number> {
    return Object.fromEntries([...this.selectors].map(([n, s]) => [n, s.state]));
  }

  /** FUN_00230138: põe os seletores da categoria no filho `child` (ignorado se ≥ nº de filhos). */
  setSelector(category: number, child: number): void {
    let changed = false;
    for (const s of this.selectors.values()) {
      if (s.def.category !== category || child >= s.def.count || s.state === child) continue;
      s.state = child;
      changed = true;
    }
    if (changed) this.showTagged();
  }

  /** Pendura (ou tira, com null) o modelo do projétil no marcador do tipo de arma (FUN_00147568/FUN_001474f0). */
  setProjectile(type: number, model: THREE.Object3D | null): void {
    const g = this.marks.get(type);
    if (!g || g.userData.model === model) return;
    g.clear();
    if (model) g.add(model);
    g.userData.model = model;
  }

  hasMark(type: number): boolean {
    return this.marks.has(type);
  }

  /**
   * FUN_00172768: piora agendada para daqui a 2 tiques (FUN_00172908 grava o alvo) e solta na hora a ação da
   * nova entrada (FUN_00172938); melhora imediata. Devolve se o estado visível mudou.
   */
  private setEntry(node: string, d: DamageState, s: number, now: number): boolean {
    if (s > d.state) {
      if (s > d.target) {
        if (d.target <= d.state) d.due = now + DAMAGE_DELAY; // já agendado: o mesmo temporizador grava o novo alvo
        d.target = s;
        const fx = d.def.fx[s];
        if (fx) this.released.push({ node, entry: s, action: fx });
      }
    } else if (s < d.state) {
      d.state = d.target = s;
      return true;
    }
    return false;
  }

  private settle(now: number): boolean {
    let changed = false;
    for (const d of this.damage.values()) {
      if (d.target > d.state && now >= d.due) {
        d.state = d.target;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Vida do carro → estado dos nós 0x13 de categoria 0x46, como FUN_0012e8c0 (por quadro): fração =
   * vida/vidaMáx (0 < f < 0,01 vira 0,02: vivo nunca mostra a última entrada); entrada por FUN_00171560.
   * `now` em segundos.
   */
  setHealth(fraction: number, now: number): void {
    let f = Math.max(0, fraction);
    if (f > 0 && f < 0.01) f = 0.02;
    let changed = false;
    if (f !== this.lastFraction) {
      for (const [node, d] of this.damage) {
        if (d.def.category !== CAR_DAMAGE_CATEGORY) continue;
        d.hp = f * d.def.maxHp; // FUN_00171498
        changed = this.setEntry(node, d, damageEntry(d.def, f), now) || changed;
      }
    }
    this.lastFraction = f;
    if (this.settle(now) || changed) this.showTagged();
  }

  /**
   * Golpe direto nas peças destrutíveis que não seguem a vida do carro (categoria ≠ 0x46; FUN_00171838):
   * dano > u16 +0x06 tira vida (mín. 0) e reescolhe a entrada (FUN_001715c0). `local` no espaço do grupo do
   * carro. ⚠️ ESCOLHA DO HOST: a peça atingida é a de caixa (ampliada em `margin`) mais próxima do ponto — o jogo
   * usa o id do objeto da geometria de colisão atingida (DAT_0041b71c).
   */
  hitPart(local: THREE.Vector3, amount: number, now: number, margin = 1.5): string | null {
    let best: [string, DamageState] | null = null;
    let bestD = Infinity;
    const c = new THREE.Vector3();
    for (const [node, d] of this.damage) {
      if (!d.box || d.hp <= 0 || d.box.distanceToPoint(local) > margin) continue;
      const dist = d.box.getCenter(c).distanceTo(local);
      if (dist < bestD) {
        bestD = dist;
        best = [node, d];
      }
    }
    if (!best) return null;
    const [node, d] = best;
    if (amount <= d.def.minDamage) return null;
    d.hp = Math.max(0, d.hp - amount);
    if (this.setEntry(node, d, damageEntry(d.def, d.def.maxHp ? d.hp / d.def.maxHp : 0), now)) this.showTagged();
    return node;
  }

  /** Renascimento (FUN_0012ea48): zera os alvos (FUN_00171410) e volta à vida cheia (estado 0 na hora). */
  resetDamage(): void {
    for (const d of this.damage.values()) {
      d.state = d.target = 0;
      d.hp = d.def.maxHp;
    }
    this.lastFraction = 1;
    this.showTagged();
  }

  private showTagged(): void {
    for (const t of this.tagged)
      t.obj.visible =
        t.dmg.every(([n, e]) => this.damage.get(n)!.state === e) && t.sel.every(([n, c]) => this.selectors.get(n)!.state === c);
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
      if (c.role === 'driver' && c.category !== this.drv.active) continue; // só a instância ativa do piloto
      const t = this.time.get(c.category) ?? 0;
      const frame = clipFrame(c, t);
      for (const tr of c.tracks) if (tr.ch < ch.length) ch[tr.ch] = sampleTrack(tr, frame);
    }
    // Mistura de entrada do clipe do piloto (FUN_00210b08 com 15/30 quadros). ⚠️ aproximação: interpola a partir
    // da pose congelada na troca, não entre as duas instâncias animadas.
    if (this.blend) {
      const w = Math.min(1, this.blend.t / this.blend.frames);
      for (const [c, v] of this.blend.from) ch[c] = v + (ch[c] - v) * w;
      if (w >= 1) this.blend = null;
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
      if (b.schan && b.pre) {
        // nó 0x18 com escala por canal (medidores do HUD): diagonal de `pre` trocada pelo canal
        const s = b.pre.slice();
        b.schan.forEach((c, k) => c >= 0 && (s[k * 5] = ch[c]));
        mul(s, m, m);
      } else if (b.pre) mul(b.pre, m, m);
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

  /** Grupo do osso `i` (HUD: tingir as malhas de um medidor). */
  boneGroup(i: number): THREE.Group | undefined {
    return this.boneGroups[i];
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
  const r = await CarRig.build(doc as ModelDoc & { rig: RigDoc }, bin, [...doc.scene, ...(doc.selectScene ?? [])]);
  for (const c of r.rig.clips) if (c.role === 'susp' || c.role === 'steer') r.time.set(c.category, 0.5);
  r.drive({ steer01: 0.5, speed: 0, airFrames: 0 }, 0, 'b'); // piloto parado: clipe 0x25 no início
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
