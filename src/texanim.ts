// Animação de material das malhas dos níveis — fogo, telões, água, lava (RE: FUN_0024baa8).
//
// Malhas com o bit 31 das flags trazem, depois dos TEX0, u16 índices de canal do objeto 0x11 dono (obj+4):
// [0] desloca U e [1] desloca V (só com a flag 0x800), [2..4] escalam R, G, B e [5] escala o alfa (base em +0x5C,
// sempre 1,0). Os canais são escritos pelos clipes 0x0B do próprio objeto, como os ossos dos carros. O pacote vai
// para a VU com padrão (0, 0) de deslocamento e 1,0 nas escalas quando o canal é −1.
//
// Quem toca os clipes: src/objanim.ts (ObjectClips) — auto-play da montagem (FUN_002111f8), roteiros e código.
import * as THREE from 'three';
import type { MeshDef, ModelDoc } from './assets';
import type { ObjectClips } from './objanim';
import type { RigClip } from './rig';

type AnimMaterial = THREE.MeshBasicMaterial | THREE.MeshLambertMaterial;

interface Target {
  obj: string;
  mat: number[];
  material: AnimMaterial;
}

/** Valor padrão de cada componente quando o canal não existe ou o clipe não o escreve: U, V, R, G, B, alfa. */
const DEFAULTS = [0, 0, 1, 1, 1, 1];

export class MaterialAnimator {
  private readonly targets: Target[] = [];
  private readonly cache = new Map<string, AnimMaterial>();
  private readonly channels = new Map<string, Map<number, number>>();

  constructor(private readonly doc: ModelDoc, readonly clips: ObjectClips) {
    for (const [obj, m] of Object.entries(doc.matAnim ?? {})) clips.register(obj, m.clips as RigClip[]);
  }

  get size(): number {
    return this.targets.length;
  }

  /**
   * Material próprio do objeto: cópia do compartilhado com textura própria (o deslocamento de UV é por textura no
   * Three). Malhas do mesmo objeto com os mesmos canais dividem a cópia.
   */
  material(base: THREE.Material, baseKey: string, def: MeshDef, obj: string): { key: string; material: THREE.Material } {
    const key = `${baseKey}|${obj}|${def.mat!.join(',')}`;
    let m = this.cache.get(key);
    if (!m) {
      const src = base as AnimMaterial;
      m = src.clone();
      m.onBeforeCompile = src.onBeforeCompile; // luzes dinâmicas (render.ts)
      if (src.map) {
        m.map = src.map.clone();
        m.map.needsUpdate = true;
      }
      this.cache.set(key, m);
      this.targets.push({ obj, mat: def.mat!, material: m });
    }
    return { key, material: m };
  }

  /** Avalia os canais de cada objeto no quadro `frame` (tiques de 1/60 s) e aplica nos materiais. */
  update(frame: number): void {
    this.channels.clear();
    for (const t of this.targets) {
      let ch = this.channels.get(t.obj);
      if (!ch) {
        ch = new Map();
        this.clips.evaluate(t.obj, (this.doc.matAnim?.[t.obj]?.clips ?? []) as RigClip[], frame, (c, v) => ch!.set(c, v));
        this.channels.set(t.obj, ch);
      }
      const v = t.mat.map((c, i) => (c >= 0 ? ch.get(c) ?? DEFAULTS[i] : DEFAULTS[i]));
      t.material.map?.offset.set(v[0], v[1]);
      t.material.color.setRGB(v[2], v[3], v[4]);
      if (t.material.transparent) t.material.opacity = Math.max(0, v[5]);
    }
  }
}
