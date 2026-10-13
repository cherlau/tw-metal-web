// Objetos destrutíveis das arenas (nós 0x13; destruct.cpp). RE em docs/NATIVE.md, "Estados de dano" e
// "Destrutíveis das arenas": FUN_00168aa8 cria um objeto por nó; golpe direto/batida (FUN_00171838/FUN_00171fc8)
// tira vida se dano > u16 +0x06; a entrada segue a fração da vida (FUN_00171560); piora 2 tiques depois e solta a
// ação da entrada na hora (FUN_00172768). Render e colisão mostram só a geometria do estado atual.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildGeometry, instanceMatrix, type DamageDef, type InstanceDef, type ModelDoc } from './assets';
import type { LevelCollision } from './collision';
import { boxBody, DebrisSystem } from './debris';
import { buildBatched, materialFor } from './render';
import { damageEntry } from './rig';
import type { WeaponId } from './game/weapons';

const DAMAGE_DELAY = 2 / 60; // FUN_00172768: FUN_00172908 para agora + 2 tiques
const FAR = -1e6;
/** FUN_00171838: categorias 0x1194..0x119d (postes, árvores) tombam ao morrer — cópia como corpo rígido
 *  (FUN_001e2000: no máximo 15, velocidade do golpe × 0,05); 0x1196..0x1198 e 0x119a..0x119d pegam fogo com
 *  napalm em vez de quebrar (FUN_00172bb0). */
const isTopple = (cat: number) => cat >= 0x1194 && cat <= 0x119d;
const isFlammable = (cat: number) => (cat >= 0x1196 && cat <= 0x1198) || (cat >= 0x119a && cat <= 0x119d);
/** FUN_00171838: categoria 0x11a3 só sofre golpes a até 10 pés da origem do objeto. */
const NEAR_ONLY = 0x11a3;
/** Tipos de golpe 4/0x29 (napalm/fogo) = arma napalm no runtime. */
const FIRE_WEAPONS: WeaponId[] = ['napalm'];
/** ⚠️ ESCOLHA DO HOST: dano de batida = velocidade normal (pés/s) × 0,2 (o jogo calcula no código de colisão). */
export const RAM_DAMAGE = 0.2;

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
}

export interface HitContext {
  kind: 'weapon' | 'blast' | 'ram';
  weapon?: WeaponId;
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
}

export class LevelDestructibles {
  /** Malhas dos destrutíveis no espaço do PS2 (o chamador põe a matriz PS2 -> mundo). */
  readonly group = new THREE.Group();
  private nodes = new Map<string, NodeState>();
  private byInst = new Map<number, string[]>();
  private render = new Map<number, { attr: THREE.BufferAttribute; orig: Float32Array; a: number; b: number }[]>();
  private dirty = new Set<string>();
  /** Destruídos desde a última leitura (QA/HUD). */
  readonly destroyed: string[] = [];

  private constructor(
    private readonly doc: ModelDoc,
    private readonly bin: ArrayBuffer,
    private readonly collision: LevelCollision,
    private readonly debris: DebrisSystem,
    private readonly toWorld: THREE.Matrix4,
  ) {}

  /** `collision` deve ter sido montada com doc.scene + doc.damageScene (mesma ordem de instâncias). */
  static async build(doc: ModelDoc, bin: ArrayBuffer, collision: LevelCollision, debris: DebrisSystem, toWorld: THREE.Matrix4) {
    const d = new LevelDestructibles(doc, bin, collision, debris, toWorld);
    const insts = collision.instances;
    insts.forEach((inst, k) => {
      for (const [n] of inst.dmg ?? []) {
        if (!doc.damage?.[n]) continue;
        if (!d.byInst.has(k)) d.byInst.set(k, []);
        d.byInst.get(k)!.push(n);
        let st = d.nodes.get(n);
        if (!st) {
          const def = doc.damage[n];
          st = { key: n, def, state: 0, target: 0, due: 0, hp: def.maxHp, insts: [], frame: new THREE.Matrix4(), origin: new THREE.Vector3(), radius: 0 };
          d.nodes.set(n, st);
        }
        st.insts.push(k);
      }
    });
    // Quadro e esfera de cada objeto: transformação da 1ª instância e esfera das malhas da entrada 0. ⚠️ o jogo usa
    // a posição acumulada no nó 0x13; a malha pode ter transformação própria abaixo dele.
    for (const st of d.nodes.values()) {
      const first = insts[st.insts[0]];
      st.frame.copy(toWorld).multiply(instanceMatrix(first) ?? new THREE.Matrix4());
      st.origin.setFromMatrixPosition(st.frame);
      const box = new THREE.Box3();
      for (const k of st.insts) if (d.entryOf(insts[k], st.key) === 0) box.union(collision.instanceBox(k));
      if (!box.isEmpty()) {
        const s = box.getBoundingSphere(new THREE.Sphere());
        st.radius = s.radius;
        st.origin.copy(s.center);
      }
    }
    await d.buildRender([...d.byInst.keys()]);
    d.refreshAll();
    return d;
  }

  private entryOf(inst: InstanceDef, node: string): number {
    return inst.dmg?.find(([n]) => n === node)?.[1] ?? 0;
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
        const { key, material } = await materialFor(this.doc, def, part.texture);
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
      let v = 0;
      geos.forEach((g, i) => {
        const n = g.getAttribute('position').count;
        const k = owner[i];
        if (!this.render.has(k)) this.render.set(k, []);
        this.render.get(k)!.push({ attr, orig, a: v, b: v + n });
        v += n;
      });
      this.group.add(new THREE.Mesh(merged, material));
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
    }
    for (const a of touched) a.needsUpdate = true;
    this.collision.setVisible(hide, false);
    this.collision.setVisible(show, true);
  }

  private refreshAll() {
    this.apply([...this.byInst.keys()]);
  }

  get count(): number {
    return this.nodes.size;
  }

  /** Estado atual de cada nó (QA). */
  states(): Record<string, { state: number; hp: number }> {
    return Object.fromEntries([...this.nodes].map(([n, s]) => [n, { state: s.state, hp: s.hp }]));
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

  /** Dano em área (explosão): queda linear até `radius` pela distância à esfera do objeto. ⚠️ host (como nos carros). */
  blast(pos: THREE.Vector3, radius: number, damage: number, weapon: WeaponId, now: number) {
    if (radius <= 0) return;
    for (const st of this.nodes.values()) {
      if (st.hp <= 0) continue;
      const d = Math.max(0, st.origin.distanceTo(pos) - st.radius);
      if (d >= radius) continue;
      const vel = st.origin.clone().sub(pos).normalize().multiplyScalar(100);
      this.hit(st.key, damage * 0.6 * (1 - d / radius), { kind: 'blast', weapon, pos, vel }, now);
    }
  }

  /** FUN_00171838 (golpe) / FUN_00171fc8 (batida). Devolve se tirou vida. */
  hit(node: string, amount: number, ctx: HitContext, now: number): boolean {
    const st = this.nodes.get(node);
    if (!st || st.hp <= 0) return false;
    const cat = st.def.category;
    if (amount <= st.def.minDamage) return false;
    if (ctx.weapon && FIRE_WEAPONS.includes(ctx.weapon) && isFlammable(cat)) return false; // pega fogo (⚠️ fogo não desenhado)
    if (cat === NEAR_ONLY && ctx.pos.distanceTo(st.origin) > 10) return false;
    st.hp = Math.max(0, st.hp - amount);
    this.setEntry(st, damageEntry(st.def, st.def.maxHp ? st.hp / st.def.maxHp : 0), now);
    if (st.hp <= 0) {
      this.destroyed.push(node);
      if (isTopple(cat) && ctx.kind !== 'ram') void this.topple(st, ctx);
    }
    return true;
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

  /** FUN_001e2000: cópia da entrada 0 caindo como corpo rígido, empurrada pela velocidade do golpe × 0,05. */
  private async topple(st: NodeState, ctx: HitContext) {
    const insts = st.insts.filter((k) => this.entryOf(this.collision.instances[k], st.key) === 0);
    if (!insts.length) return;
    const list = insts.map((k) => this.collision.instances[k]);
    const { group } = await buildBatched(this.doc, this.bin, list);
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
    // a árvore em pé sai da colisão já (o estado vale 2 tiques depois) para medir o terreno sob a base
    this.collision.setVisible(st.insts, false);
    body.slop = DebrisSystem.embed(body, this.collision, st.origin.y);
    if (ctx.vel) body.impulse(ctx.vel.clone().multiplyScalar(0.05 * body.mass), ctx.pos);
    this.debris.add(holder, body, 'topple', 15);
    // ⚠️ som: o jogo chama FUN_001e2348 com a categoria; o host escolhe árvore (LG/SM pelo tamanho) ou poste
    const tree = isFlammable(st.def.category);
    this.debris.onSound?.(tree ? (st.radius > 20 ? 'D_TREE_FALL_LG' : 'D_TREE_FALL_SM') : 'D_LPOST_FALL', st.origin);
  }

  /** Aplica as pioras agendadas e atualiza render/colisão. `now` em segundos. */
  update(now: number) {
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
