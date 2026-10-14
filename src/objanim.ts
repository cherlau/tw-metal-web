// Clipes dos objetos dos níveis (nós 0x11) e peças móveis — RE em docs/NATIVE.md, "Animação de objetos dos níveis".
//
// FUN_002111f8 (montagem do objeto) toca na carga todo clipe com o bit 0 do u16 +0x0E ("auto": água das DM, telões,
// hélices); os outros só tocam quando alguém chama FUN_00210590 — roteiro de abertura (FUN_001b5ab8), roteiros 0xDCA
// (FUN_00115348) e o código (ataque de ambiente). Cada FUN_00210590 acrescenta uma instância ao objeto (FUN_00210ca0);
// as instâncias escrevem os canais na ordem, a mais nova por cima. Laço = bit 1 do u16 +0x0E (FUN_00211348).
import * as THREE from 'three';
import type { InstanceDef, ModelDoc } from './assets';
import { buildLevelLights } from './levelfx';
import { buildBatched } from './render';
import { euler, mul, sampleTrack, type RigBone, type RigClip } from './rig';
import type { MaterialAnimator } from './texanim';

export type ObjClip = RigClip & { auto?: boolean };

export interface ObjRigDoc {
  category: number;
  bones: RigBone[];
  clips: ObjClip[];
}

interface Play {
  category: number;
  start: number;
  duration: number;
  loop: boolean;
  /** tique (1/60 s) em que a instância começou */
  t0: number;
  speed: number;
  /** FUN_002115f8(1,0) + flag 0x40: preso no fim, sem laço */
  ended: boolean;
}

/** Estado de reprodução dos clipes de cada objeto (chave `nXXXXXX` = nó 0x11). */
export class ObjectClips {
  private readonly plays = new Map<string, Play[]>();
  private readonly clips = new Map<string, ObjClip[]>();
  private readonly byCat = new Map<number, string>();

  /** Registra os clipes de um objeto (categoria do nó para FUN_00211190). Fontes diferentes somam clipes novos. */
  register(obj: string, clips: ObjClip[], category?: number): void {
    const have = this.clips.get(obj) ?? [];
    for (const c of clips) if (!have.some((h) => h.category === c.category)) have.push(c);
    this.clips.set(obj, have);
    if (category) this.byCat.set(category, obj);
  }

  objectOf(category: number): string | undefined {
    return this.byCat.get(category);
  }

  /** FUN_002111f8: toca os clipes "auto" de todos os objetos a partir do tique `tick`. */
  autoStart(tick: number): void {
    for (const [obj, list] of this.clips) for (const c of list) if (c.auto) this.play(obj, c.category, tick);
  }

  /** FUN_00210590: nova instância do 1º clipe da categoria (FUN_002110d8). */
  play(obj: string, category: number, tick: number, speed = 1): boolean {
    const c = this.clips.get(obj)?.find((k) => k.category === category);
    if (!c) return false;
    const list = this.plays.get(obj) ?? [];
    list.push({ category, start: c.start ?? 0, duration: c.duration, loop: !!c.loop, t0: tick, speed, ended: false });
    this.plays.set(obj, list);
    return true;
  }

  /** FUN_001b5d88 (pular a abertura): cada instância vai para o tempo 1 e para de repetir. */
  finish(obj: string): void {
    for (const p of this.plays.get(obj) ?? []) p.ended = true;
  }

  /** Quadro de uma instância no tique `tick` (FUN_002113c0: laço com 0x10000, senão preso em [início, fim]). */
  private frame(p: Play, tick: number): number {
    const span = p.duration - p.start;
    if (p.ended || span <= 0) return p.ended ? p.duration : p.start;
    const f = (tick - p.t0) * p.speed;
    return p.start + (p.loop ? ((f % span) + span) % span : Math.min(Math.max(f, 0), span));
  }

  /** A instância mais nova da categoria acabou (sem laço e no fim)? FUN_00211498 == 0. */
  done(obj: string, category: number, tick: number): boolean {
    const p = [...(this.plays.get(obj) ?? [])].reverse().find((k) => k.category === category);
    if (!p) return true;
    if (p.ended) return true;
    return !p.loop && (tick - p.t0) * p.speed >= p.duration - p.start;
  }

  /**
   * Canais do objeto: as instâncias em ordem com as trilhas de `clips` (o subconjunto que o chamador usa). Sem
   * instância, o objeto fica no início do 1º clipe (o estado que os roteiros amostram na carga, FUN_001151e0).
   */
  evaluate(obj: string, clips: RigClip[], tick: number, out: (ch: number, v: number) => void): void {
    const plays = this.plays.get(obj);
    if (!plays?.length) {
      const c = clips.find((k) => k.category === 0) ?? clips[0];
      if (c) for (const tr of c.tracks) out(tr.ch, sampleTrack(tr, c.start ?? 0));
      return;
    }
    for (const p of plays) {
      const c = clips.find((k) => k.category === p.category);
      if (!c) continue;
      const f = this.frame(p, tick);
      for (const tr of c.tracks) out(tr.ch, sampleTrack(tr, f));
    }
  }
}

/** Avalia um esqueleto (ossos 0x0D/0x1F/0x03 como FUN_0021b3c0) com os canais `ch`; `world` em linha-major. */
export function evalBones(bones: RigBone[], ch: ArrayLike<number>, world: number[][], visible: boolean[]): void {
  const vals = [0, 0, 0, 0, 0, 0];
  const m = new Array<number>(16);
  bones.forEach((b, i) => {
    for (let k = 0; k < 6; k++) {
      const c = b.chan[k];
      const v = c >= 0 ? ch[c] ?? 0 : b.const[k];
      vals[k] = k < 3 ? -v : v; // rotação sempre negada
    }
    euler(vals[0], vals[1], vals[2], m);
    if (b.pre) mul(b.pre, m, m);
    if (b.post) mul(m, b.post, m);
    m[12] += vals[3];
    m[13] += vals[4];
    m[14] += vals[5];
    const w = (world[i] ??= new Array<number>(16));
    if (b.parent >= 0) mul(m, world[b.parent], w);
    else for (let k = 0; k < 16; k++) w[k] = m[k];
    const own = b.vis === -2 ? false : b.vis >= 0 ? (ch[b.vis] ?? 0) !== 0 : true;
    visible[i] = own && (b.parent < 0 || visible[b.parent]);
  });
}

interface RigState {
  key: string;
  def: ObjRigDoc;
  groups: THREE.Group[];
  ch: Float32Array;
  world: number[][];
  visible: boolean[];
}

/**
 * Peças móveis: as instâncias marcadas com `ob`/`b` (tools/convert_model.py, objRigs) são desenhadas no osso do
 * objeto, com a malha crua (sem offset/matrix: o esqueleto já leva os nós 0x03/0x1F do caminho). Grupo no espaço do
 * PS2 — o chamador põe a matriz PS2 → mundo.
 */
export class LevelObjectRigs {
  readonly group = new THREE.Group();
  private readonly rigs: RigState[] = [];

  private constructor(readonly clips: ObjectClips) {}

  static async build(doc: ModelDoc & { objRigs?: Record<string, ObjRigDoc> }, bin: ArrayBuffer, clips: ObjectClips, animator?: MaterialAnimator): Promise<LevelObjectRigs> {
    const r = new LevelObjectRigs(clips);
    const defs = doc.objRigs ?? {};
    const byKey = new Map<string, Map<number, InstanceDef[]>>();
    for (const i of doc.scene) {
      // destrutíveis ficam com LevelDestructibles (⚠️ não seguem o osso)
      if (!i.ob || !defs[i.ob] || i.dmg?.length) continue;
      if (!byKey.has(i.ob)) byKey.set(i.ob, new Map());
      const m = byKey.get(i.ob)!;
      const b = i.b ?? -1;
      if (!m.has(b)) m.set(b, []);
      // malha crua: o osso faz o posicionamento
      m.get(b)!.push({ ...i, offset: undefined, matrix: undefined });
    }
    for (const [key, def] of Object.entries(defs)) {
      clips.register(key, def.clips, def.category || undefined);
      const root = new THREE.Group();
      const groups = def.bones.map(() => {
        const g = new THREE.Group();
        g.matrixAutoUpdate = false;
        root.add(g);
        return g;
      });
      for (const [b, list] of byKey.get(key) ?? []) {
        const { group } = await buildBatched(doc, bin, list, { animator });
        const lights = await buildLevelLights(doc, list);
        const holder = b >= 0 ? groups[b] : root;
        holder.add(group);
        if (lights.children.length) holder.add(lights);
      }
      const maxCh = Math.max(0, ...def.bones.flatMap((b) => [...b.chan, b.vis]), ...def.clips.flatMap((c) => c.tracks.map((t) => t.ch))) + 1;
      r.rigs.push({ key, def, groups, ch: new Float32Array(maxCh), world: [], visible: [] });
      r.group.add(root);
    }
    return r;
  }

  get count(): number {
    return this.rigs.length;
  }

  /** Instância é desenhada aqui (fica fora do lote estático)? */
  static owns(doc: { objRigs?: Record<string, ObjRigDoc> }, i: InstanceDef): boolean {
    return !!i.ob && !!doc.objRigs?.[i.ob] && !i.dmg?.length;
  }

  /** Avalia os clipes no tique `tick` (1/60 s) e põe as matrizes dos ossos. */
  update(tick: number): void {
    for (const s of this.rigs) {
      s.ch.fill(0);
      this.clips.evaluate(s.key, s.def.clips, tick, (c, v) => c < s.ch.length && (s.ch[c] = v));
      evalBones(s.def.bones, s.ch, s.world, s.visible);
      s.groups.forEach((g, i) => {
        g.matrix.fromArray(s.world[i]); // linha-major lido como coluna-major = forma do Three
        g.matrixWorldNeedsUpdate = true;
        g.visible = s.visible[i];
      });
    }
  }
}
