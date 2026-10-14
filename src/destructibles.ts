// Objetos destrutíveis das arenas (nós 0x13; destruct.cpp). RE em docs/NATIVE.md, "Estados de dano" e
// "Destrutíveis das arenas": FUN_00168aa8 cria um objeto por nó; golpe direto/batida (FUN_00171838/FUN_00171fc8)
// tira vida se dano > u16 +0x06; a entrada segue a fração da vida (FUN_00171560); piora 2 tiques depois e solta a
// ação da entrada na hora (FUN_00172768). Render e colisão mostram só a geometria do estado atual.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildGeometry, instanceMatrix, type DamageDef, type InstanceDef, type ModelDoc } from './assets';
import type { LevelCollision } from './collision';
import { boxBody, DebrisSystem } from './debris';
import { buildLevelLights } from './levelfx';
import type { Emitter, SpawnOptions } from './particles';
import { buildBatched, materialFor } from './render';
import { damageEntry } from './rig';
import type { MaterialAnimator } from './texanim';
import type { WeaponId } from './game/weapons';

const DAMAGE_DELAY = 2 / 60; // FUN_00172768: FUN_00172908 para agora + 2 tiques
const TICK = 1 / 60;
const FAR = -1e6;
/** FUN_00171838: categorias 0x1194..0x119d (postes, árvores) tombam ao morrer — cópia como corpo rígido
 *  (FUN_001e2000: no máximo 15, velocidade do golpe × 0,05; batida FUN_001e21b8: × 30); 0x1196..0x1198 e
 *  0x119a..0x119d pegam fogo com golpe tipo 4/0x29 em vez de perder vida (FUN_00172bb0). */
const isTopple = (cat: number) => cat >= 0x1194 && cat <= 0x119d;
const isFlammable = (cat: number) => (cat >= 0x1196 && cat <= 0x1198) || (cat >= 0x119a && cat <= 0x119d);
/** FUN_00171838: categoria 0x11a3 só sofre golpes a até 10 pés da origem do objeto e pega fogo com qualquer golpe
 *  que não seja tipo 0 (metralhadora) nem 0xe (congelar). */
const NEAR_ONLY = 0x11a3;
/** Tipos de golpe 4/0x29 (napalm/fogo) = arma napalm no runtime. */
const FIRE_WEAPONS: WeaponId[] = ['napalm'];
/** Golpes sem fogo no 0x11a3: tipo 0 (metralhadora) e 0xe (congelar, energia). */
const NO_FIRE_11A3: WeaponId[] = ['machinegun', 'energy'];

/**
 * FUN_001349f0 (batida em objeto que não é carro): dano = máx(1, |v|·(60/88)/vel. máx. (mph, carro+0x858) ·
 * |v̂·n| · 10) = máx(1, vn·6,818/vel. máx.), com vn = componente normal da velocidade em pés/s.
 */
export function ramDamage(normalSpeed: number, maxMph: number): number {
  return Math.max(1, ((Math.abs(normalSpeed) * (60 / 88)) / maxMph) * 10);
}

/**
 * FUN_00172bb0: emissores de fogo por categoria — [escala, altura (pés, PS2 z) ou faixa sorteada, vida (tiques) e
 * cone gravados depois de criar (+0x167c / +0x1600)]. O 1º sempre sobe U(1, 8) pés antes da altura própria.
 */
interface FireEmitter {
  scale: number;
  z: number | [number, number];
  life?: number;
  cone?: number;
}
const FIRE: Record<number, FireEmitter[]> = {
  0x1196: [{ scale: 3, z: [1, 8], life: 0x5a, cone: 0.05 }, { scale: 5, z: 40, cone: 0.5 }],
  0x1197: [{ scale: 1.5, z: [1, 8], life: 0x78, cone: 0.05 }, { scale: 3, z: [30, 35], cone: 0.05 }],
  0x1198: [{ scale: 1.5, z: [1, 8], life: 0x5a, cone: 0.05 }, { scale: 5, z: 25, cone: 0.05 }],
  0x119a: [{ scale: 1.5, z: [1, 8], life: 0x78, cone: 0.05 }, { scale: 3, z: [23, 26], cone: 0.05 }],
  0x119b: [{ scale: 1.5, z: [1, 8], life: 0x78, cone: 0.05 }, { scale: 3.5, z: 38, cone: 0.03 }],
  0x119c: [{ scale: 2, z: [1, 8], life: 0x78, cone: 0.05 }, { scale: 5, z: 53, cone: 0.01 }],
  0x119d: [{ scale: 3, z: 8 }],
  0x11a3: [{ scale: 6, z: -8 }],
};
/** FUN_001730b8: cada tique tira U(a, b) do R/G/B da cor do objeto (tabela 0x4ecd50); no 0x11a3 a faixa é o dobro e
 *  o R cai pela metade. Com R ≤ 0,2 a árvore cai (golpe próprio tipo 0 de 100). */
const BURN_RATE: Record<number, [number, number]> = { [NEAR_ONLY]: [0.0022, 0.0036] };
const BURN_RATE_DEFAULT: [number, number] = [0.0011, 0.0018];
/** FUN_001730b8: direções horizontais (PS2) do empurrão da queda, × 60. */
const FALL_DIRS: [number, number][] = [[1, 0], [0, 1], [0.70703, -0.70703], [0.86603, 0.5], [-0.86603, -0.5]];
/** FUN_001e2770: altura do ponto de prova do topo (pés acima da base) por categoria. */
const TOP_HEIGHT: Record<number, number> = { 0x119b: 35, 0x119c: 50, 0x119d: 7 };

/** Efeitos e sons que os destrutíveis pedem ao jogo (posições no mundo do Three). */
export interface DestructibleFx {
  spawn(id: number, pos: THREE.Vector3, opts?: SpawnOptions): Emitter | null;
  play(name: string, pos: THREE.Vector3, min: number, max: number, volume?: number): void;
  loop(key: string, name: string, volume: number, pos: THREE.Vector3, min: number, max: number): void;
}

interface Burn {
  ems: Emitter[];
  tint: [number, number, number];
  acc: number;
  /** 0x11a3: o fogo acabou mas a cor fica */
  out: boolean;
}

interface NodeState {
  key: string;
  def: DamageDef;
  state: number;
  target: number;
  due: number;
  hp: number;
  /** instâncias (índices na colisão) marcadas com este nó */
  insts: number[];
  /** PS2 local do objeto -> mundo (posição e rotação do percurso, objeto +0xB0/+0xC0) */
  frame: THREE.Matrix4;
  origin: THREE.Vector3;
  radius: number;
  /** origem do objeto no PS2 (obj+0xB0): deslocamento da instância; ⚠️ sem ele, base da caixa */
  basePs2: THREE.Vector3;
  burn?: Burn;
}

export interface HitContext {
  kind: 'weapon' | 'blast' | 'ram' | 'self';
  weapon?: WeaponId;
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
}

interface RenderRange {
  attr: THREE.BufferAttribute;
  orig: Float32Array;
  color?: THREE.BufferAttribute;
  origColor?: Float32Array;
  a: number;
  b: number;
}

export class LevelDestructibles {
  /** Malhas dos destrutíveis no espaço do PS2 (o chamador põe a matriz PS2 -> mundo). */
  readonly group = new THREE.Group();
  private nodes = new Map<string, NodeState>();
  private byInst = new Map<number, string[]>();
  private render = new Map<number, RenderRange[]>();
  /** sprites/fachos de luz de cada instância (somem com a geometria) */
  private lights = new Map<number, THREE.Object3D>();
  private dirty = new Set<string>();
  private burning = new Set<NodeState>();
  private last = -1;
  /** Destruídos desde a última leitura (QA/HUD). */
  readonly destroyed: string[] = [];
  fx: DestructibleFx | null = null;
  private readonly rand: () => number = Math.random;

  private constructor(
    private readonly doc: ModelDoc,
    private readonly bin: ArrayBuffer,
    private readonly collision: LevelCollision,
    private readonly debris: DebrisSystem,
    private readonly toWorld: THREE.Matrix4,
    private readonly animator?: MaterialAnimator,
  ) {}

  /** `collision` deve ter sido montada com doc.scene + doc.damageScene (mesma ordem de instâncias). */
  static async build(doc: ModelDoc, bin: ArrayBuffer, collision: LevelCollision, debris: DebrisSystem, toWorld: THREE.Matrix4, animator?: MaterialAnimator) {
    const d = new LevelDestructibles(doc, bin, collision, debris, toWorld, animator);
    const insts = collision.instances;
    insts.forEach((inst, k) => {
      for (const [n] of inst.dmg ?? []) {
        if (!doc.damage?.[n]) continue;
        if (!d.byInst.has(k)) d.byInst.set(k, []);
        d.byInst.get(k)!.push(n);
        let st = d.nodes.get(n);
        if (!st) {
          const def = doc.damage[n];
          st = { key: n, def, state: 0, target: 0, due: 0, hp: def.maxHp, insts: [], frame: new THREE.Matrix4(), origin: new THREE.Vector3(), radius: 0, basePs2: new THREE.Vector3() };
          d.nodes.set(n, st);
        }
        st.insts.push(k);
      }
    });
    // Quadro e esfera de cada objeto: transformação da 1ª instância e esfera das malhas da entrada 0. ⚠️ o jogo usa
    // a posição acumulada no nó 0x13; a malha pode ter transformação própria abaixo dele.
    const inv = toWorld.clone().invert();
    for (const st of d.nodes.values()) {
      const first = insts[st.insts[0]];
      const xf = instanceMatrix(first);
      st.frame.copy(toWorld).multiply(xf ?? new THREE.Matrix4());
      st.origin.setFromMatrixPosition(st.frame);
      const box = new THREE.Box3();
      for (const k of st.insts) if (d.entryOf(insts[k], st.key) === 0) box.union(collision.instanceBox(k));
      if (xf) st.basePs2.setFromMatrixPosition(xf);
      else if (!box.isEmpty()) st.basePs2.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2).applyMatrix4(inv);
      if (!box.isEmpty()) {
        const s = box.getBoundingSphere(new THREE.Sphere());
        st.radius = s.radius;
        st.origin.copy(s.center);
      }
    }
    await d.buildRender([...d.byInst.keys()]);
    await d.buildLights([...d.byInst.keys()]);
    d.refreshAll();
    return d;
  }

  private entryOf(inst: InstanceDef, node: string): number {
    return inst.dmg?.find(([n]) => n === node)?.[1] ?? 0;
  }

  /** Ponto do PS2 do objeto (base + z) no mundo do Three. */
  private worldAt(st: NodeState, dz: number): THREE.Vector3 {
    return st.basePs2.clone().add(new THREE.Vector3(0, 0, dz)).applyMatrix4(this.toWorld);
  }

  /** Lotes por material só com os destrutíveis; esconder = recolher os vértices da instância. */
  private async buildRender(list: number[]) {
    const insts = this.collision.instances;
    const buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[]; owner: number[] }>();
    for (const k of list) {
      const inst = insts[k];
      const def = this.doc.meshes[inst.mesh];
      const xf = instanceMatrix(inst);
      for (const part of def.parts ?? []) {
        let { key, material } = await materialFor(this.doc, def, part.texture);
        // Materiais animados pelos canais do objeto (FUN_0024baa8), como no lote estático.
        if (this.animator && def.mat && inst.obj) ({ key, material } = this.animator.material(material, key, def, inst.obj));
        if (!buckets.has(key)) buckets.set(key, { material, geos: [], owner: [] });
        const g = buildGeometry(part, this.bin);
        const b = buckets.get(key)!;
        b.geos.push(xf ? g.clone().applyMatrix4(xf) : g.clone());
        b.owner.push(k);
      }
    }
    for (const { material, geos, owner } of buckets.values()) {
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const attr = merged.getAttribute('position') as THREE.BufferAttribute;
      const orig = (attr.array as Float32Array).slice();
      const color = merged.getAttribute('color') as THREE.BufferAttribute | undefined;
      const origColor = color ? (color.array as Float32Array).slice() : undefined;
      let v = 0;
      geos.forEach((g, i) => {
        const n = g.getAttribute('position').count;
        const k = owner[i];
        if (!this.render.has(k)) this.render.set(k, []);
        this.render.get(k)!.push({ attr, orig, color, origColor, a: v, b: v + n });
        v += n;
      });
      this.group.add(new THREE.Mesh(merged, material));
    }
  }

  /** Sprites e fachos de cada instância: no jogo são parte da malha e somem com a entrada (postes quebrados). */
  private async buildLights(list: number[]) {
    for (const k of list) {
      const g = await buildLevelLights(this.doc, [this.collision.instances[k]]);
      if (!g.children.length) continue;
      this.lights.set(k, g);
      this.group.add(g);
    }
  }

  private visible(k: number): boolean {
    const inst = this.collision.instances[k];
    return (inst.dmg ?? []).every(([n, e]) => (this.nodes.get(n)?.state ?? 0) === e);
  }

  private apply(list: number[]) {
    const show: number[] = [];
    const hide: number[] = [];
    const touched = new Set<THREE.BufferAttribute>();
    for (const k of list) {
      const vis = this.visible(k);
      (vis ? show : hide).push(k);
      for (const r of this.render.get(k) ?? []) {
        const arr = r.attr.array as Float32Array;
        if (vis) arr.set(r.orig.subarray(r.a * 3, r.b * 3), r.a * 3);
        else for (let v = r.a; v < r.b; v++) arr.set([0, FAR, 0], v * 3);
        touched.add(r.attr);
      }
      const l = this.lights.get(k);
      if (l) l.visible = vis;
    }
    for (const a of touched) a.needsUpdate = true;
    this.collision.setVisible(hide, false);
    this.collision.setVisible(show, true);
  }

  /** Cor do objeto (slot 0x4ecd50, FUN_002303d0): multiplica as cores de vértice das instâncias. */
  private setTint(st: NodeState, rgb: readonly number[]) {
    const touched = new Set<THREE.BufferAttribute>();
    for (const k of st.insts)
      for (const r of this.render.get(k) ?? []) {
        if (!r.color || !r.origColor) continue;
        const n = r.color.itemSize;
        const arr = r.color.array as Float32Array;
        for (let v = r.a; v < r.b; v++) for (let c = 0; c < 3; c++) arr[v * n + c] = r.origColor[v * n + c] * rgb[c];
        touched.add(r.color);
      }
    for (const a of touched) a.needsUpdate = true;
  }

  private refreshAll() {
    this.apply([...this.byInst.keys()]);
  }

  get count(): number {
    return this.nodes.size;
  }

  /** Estado atual de cada nó (QA). */
  states(): Record<string, { state: number; hp: number; burning?: boolean }> {
    return Object.fromEntries([...this.nodes].map(([n, s]) => [n, { state: s.state, hp: s.hp, ...(s.burn ? { burning: !s.burn.out } : {}) }]));
  }

  /** Nó dono de uma instância da colisão (o `tag` do raycast); o mais interno quando há aninhamento. */
  nodeOf(tag: number): string | null {
    const list = this.byInst.get(tag);
    return list?.length ? list[list.length - 1] : null;
  }

  /** Golpe no objeto dono do triângulo `tag` (projétil, metralhadora, batida). */
  hitTag(tag: number, amount: number, ctx: HitContext, now: number): boolean {
    const n = this.nodeOf(tag);
    return n ? this.hit(n, amount, ctx, now) : false;
  }

  /** Objetos vivos (centro no mundo) para a trava em objetos do cenário (FUN_00147cf0). */
  targets(): { pos: THREE.Vector3 }[] {
    return [...this.nodes.values()].filter((s) => s.hp > 0).map((s) => ({ pos: s.origin }));
  }

  /**
   * Área (FUN_00202d08): a consulta FUN_0022c5a8 acha os objetos a até raio/2 do centro; cada um leva
   * dano·máx(0, 1 − d/raio), com d = distância à origem do objeto (+0xB0) — sem o mínimo de 0,33 nem o ×1,5 do
   * napalm, que valem só para carros. Empurrão: (direção + 0,25 em z) × 1100.
   */
  blast(pos: THREE.Vector3, radius: number, damage: number, weapon: WeaponId, now: number) {
    if (radius <= 0) return;
    for (const st of this.nodes.values()) {
      if (st.hp <= 0) continue;
      // ⚠️ host: a consulta do jogo é contra a forma de colisão; aqui contra a esfera do objeto
      if (st.origin.distanceTo(pos) - st.radius >= radius * 0.5) continue;
      const base = this.worldAt(st, 0);
      const f = Math.max(0, 1 - base.distanceTo(pos) / radius);
      const dir = base.clone().sub(pos).normalize();
      dir.y += 0.25;
      this.hit(st.key, damage * f, { kind: 'blast', weapon, pos: base.clone().add(new THREE.Vector3(0, 7.5, 0)), vel: dir.multiplyScalar(1100) }, now);
    }
  }

  /** FUN_00171838 (golpe) / FUN_00171fc8 (batida). Devolve se tirou vida. */
  hit(node: string, amount: number, ctx: HitContext, now: number): boolean {
    const st = this.nodes.get(node);
    if (!st || st.hp <= 0) return false;
    const cat = st.def.category;
    const fire = ctx.kind !== 'ram' && ctx.weapon !== undefined && FIRE_WEAPONS.includes(ctx.weapon);
    let took = false;
    // Golpe de fogo em árvore/poste inflamável não tira vida (pula para o teste da categoria).
    if (amount > st.def.minDamage && !(fire && isFlammable(cat))) {
      if (cat === NEAR_ONLY && ctx.kind !== 'ram' && ctx.pos.distanceTo(this.worldAt(st, 0)) > 10) return false;
      st.hp = Math.max(0, st.hp - amount);
      this.setEntry(st, damageEntry(st.def, st.def.maxHp ? st.hp / st.def.maxHp : 0), now);
      took = true;
    }
    if (ctx.kind !== 'ram') {
      if (fire && isFlammable(cat)) this.ignite(st);
      else if (cat === NEAR_ONLY && ctx.kind !== 'self' && !(ctx.weapon && NO_FIRE_11A3.includes(ctx.weapon))) this.ignite(st);
    }
    if (took && st.hp <= 0) {
      this.destroyed.push(node);
      const wasBurning = !!st.burn && !st.burn.out;
      this.extinguish(st);
      // FUN_00171838: 0x1198 morto sem fogo solta folhas (0x2f) 20 pés acima
      if (ctx.kind !== 'ram' && !wasBurning && cat === 0x1198) this.fx?.spawn(0x2f, this.worldAt(st, 20));
      if (isTopple(cat)) void this.topple(st, ctx);
    }
    return took;
  }

  /** FUN_00172bb0: acende uma vez — vida cheia, emissores 0x41 pela categoria e tique de queima (FUN_001730b8). */
  private ignite(st: NodeState) {
    if (st.burn) return;
    const list = FIRE[st.def.category];
    if (!list || !this.fx) return;
    // FUN_00171498(1,0): vida cheia e entrada já gravada (o FUN_00172908 agendado relê o alvo +0xA2)
    st.hp = st.def.maxHp;
    const e = damageEntry(st.def, 1);
    if (e !== st.state) this.dirty.add(st.key);
    st.state = st.target = e;
    const ems: Emitter[] = [];
    const z0 = 1 + this.rand() * 7;
    list.forEach((e, i) => {
      const dz = Array.isArray(e.z) ? e.z[0] + this.rand() * (e.z[1] - e.z[0]) : e.z;
      const em = this.fx!.spawn(0x41, this.worldAt(st, i === 0 && Array.isArray(e.z) ? z0 : dz), { scale: e.scale });
      if (!em) return;
      if (e.life !== undefined) em.life = e.life;
      if (e.cone !== undefined) em.coneK = e.cone;
      ems.push(em);
    });
    st.burn = { ems, tint: [1, 1, 1], acc: 0, out: false };
    this.burning.add(st);
  }

  /** Apaga os emissores e solta o slot (FUN_00249828, FUN_00230390); a cor queimada fica na malha. */
  private extinguish(st: NodeState) {
    if (!st.burn) return;
    for (const e of st.burn.ems) e.stop();
    st.burn.out = true;
    this.burning.delete(st);
    this.fx?.loop(`burn:${st.key}`, 'W_FIRE_BURN_L', 0, this.worldAt(st, 0), 100, 350);
  }

  /** FUN_001730b8, por tique: som W_FIRE_BURN_L (100..350), escurece; em R ≤ 0,2 acaba (0x11a3) ou derruba. */
  private burnTick(st: NodeState, now: number) {
    const b = st.burn!;
    this.fx?.loop(`burn:${st.key}`, 'W_FIRE_BURN_L', 1, this.worldAt(st, 0), 100, 350);
    const [lo, hi] = BURN_RATE[st.def.category] ?? BURN_RATE_DEFAULT;
    const k = lo + this.rand() * (hi - lo);
    if (b.tint[0] > 0.2) {
      b.tint[0] = Math.max(0, b.tint[0] - (st.def.category === NEAR_ONLY ? k * 0.5 : k));
      b.tint[1] = Math.max(0, b.tint[1] - k);
      b.tint[2] = Math.max(0, b.tint[2] - k);
      this.setTint(st, b.tint);
      return;
    }
    if (st.def.category === NEAR_ONLY) {
      b.ems[0]?.stop();
      b.out = true;
      this.burning.delete(st);
      this.fx?.loop(`burn:${st.key}`, 'W_FIRE_BURN_L', 0, this.worldAt(st, 0), 100, 350);
      return;
    }
    // golpe próprio: tipo 0, dano 100, velocidade = uma de 5 direções × 60, na origem do objeto
    const [dx, dy] = FALL_DIRS[Math.floor(this.rand() * FALL_DIRS.length)];
    const rot = new THREE.Matrix4().extractRotation(this.toWorld);
    const vel = new THREE.Vector3(dx, dy, 0).applyMatrix4(rot).multiplyScalar(60);
    this.extinguish(st);
    this.hit(st.key, 100, { kind: 'self', pos: this.worldAt(st, 0), vel }, now);
  }

  private setEntry(st: NodeState, s: number, now: number) {
    if (s > st.state) {
      if (s > st.target) {
        if (st.target <= st.state) st.due = now + DAMAGE_DELAY;
        st.target = s;
        const fx = st.def.fx[s];
        const action = fx ? this.doc.actions?.[fx] : undefined;
        if (action) this.debris.dispatch(this.doc, this.bin, action, st.frame, now);
      }
    } else if (s < st.state) {
      st.state = st.target = s;
      this.dirty.add(st.key);
    }
  }

  /**
   * FUN_001e2000 (golpe: velocidade × 0,05) / FUN_001e21b8 (batida: velocidade/60 × 30): cópia da entrada 0 caindo
   * como corpo rígido. FUN_001e2348: poeira 0x34 no ponto do golpe (napalm/remote: no objeto); FUN_001e2770: ao tocar
   * o chão (topo a ≤ 3 pés) FUN_001e2e70 solta poeira/brasas e FUN_001a7630 toca o som da categoria.
   */
  private async topple(st: NodeState, ctx: HitContext) {
    const insts = st.insts.filter((k) => this.entryOf(this.collision.instances[k], st.key) === 0);
    if (!insts.length) return;
    const cat = st.def.category;
    const burnt = st.burn?.tint;
    this.fallFx(cat, ctx.kind === 'blast' && (ctx.weapon === 'napalm' || ctx.weapon === 'remote') ? this.worldAt(st, 0) : ctx.pos, burnt !== undefined);
    const list = insts.map((k) => this.collision.instances[k]);
    const { group } = await buildBatched(this.doc, this.bin, list);
    if (burnt) tintGroup(group, burnt);
    // Corpo com a rotação PS2 -> mundo e origem no centro do objeto: local = PS2 do nível − centro.
    const rot = new THREE.Matrix4().extractRotation(this.toWorld);
    const centerPs2 = st.origin.clone().applyMatrix4(rot.clone().invert());
    group.position.copy(centerPs2).negate();
    const holder = new THREE.Group();
    holder.add(group);
    const box = new THREE.Box3();
    for (const k of insts) box.union(this.collision.instanceBox(k));
    const toLocal = rot.clone().invert().multiply(new THREE.Matrix4().makeTranslation(-st.origin.x, -st.origin.y, -st.origin.z));
    // ⚠️ host: contato pela base do tronco (vértices nos 10 pés de baixo) e pelo topo da caixa toda — a caixa
    // inteira teria a base do tamanho da copa
    const base = new THREE.Box3();
    for (const k of insts) base.union(this.collision.instanceBox(k, box.min.y + 10));
    const corners: THREE.Vector3[] = [];
    for (const [b, y] of [[base, base.min.y], [box, box.max.y]] as const)
      for (const x of [b.min.x, b.max.x]) for (const z of [b.min.z, b.max.z]) corners.push(new THREE.Vector3(x, y, z).applyMatrix4(toLocal));
    const frame = rot.clone().setPosition(st.origin);
    const body = boxBody(corners, frame);
    body.life = Infinity;
    // Ponto de prova do topo (FUN_001e2770): base + eixo z do objeto × altura da categoria.
    const baseW = this.worldAt(st, 0);
    body.landTip = baseW.clone().add(new THREE.Vector3(0, TOP_HEIGHT[cat] ?? 25, 0)).applyMatrix4(toLocal);
    body.onLand = (v2, at) => {
      this.landFx(cat, at, burnt !== undefined);
      // FUN_001a7630: 60..800 pés, volume × |v|²/6 abaixo de 6
      const vol = v2 < 6 ? v2 / 6 : 1;
      if (cat === 0x1194) this.fx?.play('D_LPOST_SIM_FAL', at, 60, 800, vol);
      else if (isFlammable(cat)) this.fx?.play('D_TREE_FALL_LG', at, 60, 800, vol);
    };
    // a árvore em pé sai da colisão já (o estado vale 2 tiques depois) para medir o terreno sob a base
    this.collision.setVisible(st.insts, false);
    body.slop = DebrisSystem.embed(body, this.collision, st.origin.y);
    if (ctx.vel) {
      const k = ctx.kind === 'ram' ? 30 / 60 : 0.05;
      // ⚠️ host: na queda pelo fogo o jogo empurra a 3 pés/s na origem e o corpo dele tomba (centro de massa
      // FUN_00250658(0, 0, 6)); a caixa daqui fica de pé com isso, então o empurrão vai no topo.
      const at = ctx.kind === 'self' ? baseW.clone().add(new THREE.Vector3(0, TOP_HEIGHT[cat] ?? 25, 0)) : ctx.pos;
      body.impulse(ctx.vel.clone().multiplyScalar(k * body.mass), at);
    }
    this.debris.add(holder, body, 'topple', 15);
  }

  /** FUN_001e2348: poeira 0x34 (cinza 0x80c0c0c0 nos postes, marrom 0x80405060 nas árvores) e folhas 0x2f. */
  private fallFx(cat: number, at: THREE.Vector3, burnt: boolean) {
    if (!this.fx) return;
    if (cat === 0x1194 || cat === 0x1195) this.fx.spawn(0x34, at, { scale: 0.2, color: 0x80c0c0c0 });
    else if (cat === 0x1199) this.fx.spawn(0x34, at, { color: 0x80c0c0c0 });
    else if (isFlammable(cat)) {
      this.fx.spawn(0x34, at, { color: 0x80405060 });
      if (cat === 0x1198 && !burnt) this.fx.spawn(0x2f, at.clone().add(new THREE.Vector3(0, 20, 0)));
    }
  }

  /** FUN_001e2e70 (pouso): poeira e, se não estava queimando, brasas 0x35 / folhas 0x2f. */
  private landFx(cat: number, at: THREE.Vector3, burnt: boolean) {
    if (!this.fx) return;
    if (cat === 0x1194 || cat === 0x1195) this.fx.spawn(0x34, at, { scale: 0.5, color: 0x80c0c0c0 });
    else if (cat === 0x1199) this.fx.spawn(0x34, at, { color: 0x80c0c0c0 });
    else if (cat === 0x1198) {
      if (!burnt) {
        this.fx.spawn(0x2f, at);
        this.fx.spawn(0x35, at);
      }
      this.fx.spawn(0x34, at, { scale: 2, color: 0x80405060 });
    } else if (isFlammable(cat)) {
      this.fx.spawn(0x34, at, { scale: 2, color: 0x80405060 });
      if (!burnt) this.fx.spawn(0x35, at);
    }
  }

  /** Aplica as pioras agendadas, a queima por tique e atualiza render/colisão. `now` em segundos. */
  update(now: number) {
    if (this.last < 0) this.last = now;
    let ticks = Math.min(15, Math.floor((now - this.last) / TICK));
    this.last += ticks * TICK;
    if (now - this.last > 0.25) this.last = now;
    for (; ticks > 0; ticks--) for (const st of [...this.burning]) this.burnTick(st, now);
    for (const st of this.nodes.values()) {
      if (st.target > st.state && now >= st.due) {
        st.state = st.target;
        this.dirty.add(st.key);
      }
    }
    if (!this.dirty.size) return;
    const list = new Set<number>();
    for (const n of this.dirty) for (const k of this.nodes.get(n)!.insts) list.add(k);
    this.dirty.clear();
    this.apply([...list]);
  }
}

/** Cor queimada na cópia que cai (as geometrias do lote são próprias). */
function tintGroup(group: THREE.Object3D, rgb: readonly number[]) {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    const c = m.isMesh ? (m.geometry.getAttribute('color') as THREE.BufferAttribute | undefined) : undefined;
    if (!c) return;
    m.geometry = m.geometry.clone();
    const attr = m.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let v = 0; v < attr.count; v++) for (let k = 0; k < 3; k++) attr.array[v * attr.itemSize + k] *= rgb[k];
    attr.needsUpdate = true;
  });
}
