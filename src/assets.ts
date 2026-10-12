import * as THREE from 'three';

/** Span [byteOffset, count] dentro do .bin (SPEC §7.1). */
export type Span = [number, number];

export interface SpriteDef {
  center: [number, number, number];
  size: number;
  color: [number, number, number, number];
  uv: [number, number, number, number];
}

export interface PartDef {
  texture: string | null;
  attributes: Record<'position' | 'normal' | 'uv' | 'color' | 'indices', Span>;
}

export interface MeshDef {
  offset: number;
  flags: number;
  texture: string | null;
  texture2: string | null;
  textures?: string[];
  scale: number;
  packed: string;
  poolOwner: string | null;
  sphere: [number, number, number, number];
  parts?: PartDef[]; // uma por slot de textura
  sprites?: SpriteDef[];
  /** Estado do GS herdado do grupo (pacote A+D): ALPHA_1 [A, B, C, D, FIX] e gravação de z. */
  gs?: { alpha?: [number, number, number, number, number]; zwrite?: boolean };
}

export interface TextureDef {
  url: string;
  width: number;
  height: number;
  bpp: number;
  alpha: 'opaque' | 'cutout' | 'blend';
}

export interface InstanceDef {
  mesh: string;
  bone: string | null;
  /** Translação do objeto (nós 0x03/0x1F dos níveis), coordenadas do PS2. */
  offset?: [number, number, number];
  /** Transformação com rotação (nós 0x1F dos níveis): 4x4 linha-major, vetor-linha (p' = p·M). */
  matrix?: number[];
  /** Entradas de nós 0x13 no caminho ([nó, entrada]): visível só quando cada nó está nessa entrada. */
  dmg?: [string, number][];
  /** Filhos de seletores 0x05 no caminho ([nó, filho]): visível só quando cada seletor está nesse filho. */
  sel?: [string, number][];
  /** Carros com esqueleto: índice do osso (tools/rig.py), -1 = raiz. */
  b?: number;
}

/** Nó 0x13 (estado de dano): limiares u16 (fração da vida × 65535) por entrada — tools/ngp.py: DamageNode. */
export interface DamageDef {
  category: number;
  thresholds: number[];
  maxHp: number;
  minDamage: number;
  /** nó de ação solto ao entrar em cada entrada (chave em ModelDoc.actions) */
  fx: (string | null)[];
}

/** Seletor 0x05: filho desenhado = byte +0x08 (state), trocado pelo código do jogo por categoria. */
export interface SelectorDef {
  category: number;
  id: number;
  kind: number;
  state: number;
  count: number;
  /** ⚠️ host: 'shadow' = sombra (malha plana; projetada no chão pelo runtime) */
  role?: 'shadow';
}

/** Nó de ação (actionDispatch.cpp, tools/actions.py): atraso em tiques de 1/60 s. */
export type ActionDef =
  | { type: 0; delay: number; items: ActionDef[] }
  | { type: 1; delay: number; matrix: number[]; child: ActionDef | null }
  | { type: 2; delay: number; object: number; flags: number; clip: number }
  | { type: 3; delay: number; mass: number; mode: number; center: number[]; speed: number; pieces: { model: string; pos: number[] }[] }
  | { type: 4; delay: number; sound: number; name?: string; near?: number; far?: number }
  | { type: 5 | 6 | 7; delay: number };

/** Peça de destroço: malhas (no espaço da peça, mais `offset`), caixa (centro + 3 semi-eixos) e raio. */
export interface DebrisModelDef {
  instances: InstanceDef[];
  offset: number[];
  center: number[];
  axes: number[][];
  radius: number;
}

/** Transformação de uma instância posicionada (ou null): `matrix` do PS2 ou a translação `offset`. */
export function instanceMatrix(i: InstanceDef): THREE.Matrix4 | null {
  // linha-major vetor-linha -> fromArray lê coluna-major = transposta = forma do Three (p' = M·p)
  if (i.matrix) return new THREE.Matrix4().fromArray(i.matrix);
  if (i.offset) return new THREE.Matrix4().makeTranslation(i.offset[0], i.offset[1], i.offset[2]);
  return null;
}

export interface BoneDef {
  parent: string | null;
  invBind: number[]; // 16 floats, vetor-linha achatado = column-major do Three
  bind: number[] | null;
}

export interface ModelDoc {
  version: number;
  name: string;
  source: string;
  coords: string;
  counts: Record<string, number>;
  errors: string[];
  scene: InstanceDef[];
  /** Carros: instâncias das entradas ≥ 1 dos nós 0x13 (fora da pose base) e a regra de cada nó. */
  damageScene?: InstanceDef[];
  damage?: Record<string, DamageDef>;
  /** Carros: filhos de todos os seletores 0x05 (marcados em `sel`) e cada seletor. */
  selectScene?: InstanceDef[];
  selectors?: Record<string, SelectorDef>;
  /** Carros: ações dos nós 0x13 e modelos das peças de destroço. */
  actions?: Record<string, ActionDef>;
  debris?: Record<string, DebrisModelDef>;
  bones: Record<string, BoneDef>;
  effects: Record<string, InstanceDef[]>;
  objects?: { node: string; inScene: boolean; instances: InstanceDef[] }[];
  /** Listas de pontos das arenas (coordenadas do PS2): spt, pkp, pts, gps. */
  points?: Record<string, { pos: [number, number, number]; raw: string[] }[]>;
  sceneUnknown: Record<string, string[]>;
  meshes: Record<string, MeshDef>;
  textures: Record<string, TextureDef>;
}

export const assetURL = (path: string) => `${import.meta.env.BASE_URL}assets/${path}`;

const textureCache = new Map<string, Promise<THREE.Texture>>();

export function loadTexture(def: TextureDef): Promise<THREE.Texture> {
  let pending = textureCache.get(def.url);
  if (!pending) {
    pending = new THREE.TextureLoader().loadAsync(assetURL(def.url)).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.flipY = false; // UV do GS: v=0 é a primeira linha da imagem
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = 4;
      t.needsUpdate = true;
      return t;
    });
    textureCache.set(def.url, pending);
  }
  return pending;
}

export async function loadModel(path: string): Promise<{ doc: ModelDoc; bin: ArrayBuffer }> {
  const [doc, bin] = await Promise.all([
    fetch(assetURL(`${path}.json`)).then((r) => {
      if (!r.ok) throw new Error(`${path}.json: HTTP ${r.status}`);
      return r.json() as Promise<ModelDoc>;
    }),
    fetch(assetURL(`${path}.bin`)).then((r) => {
      if (!r.ok) throw new Error(`${path}.bin: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return { doc, bin };
}

/** Geometria zero-copy a partir dos spans. Nº de componentes implícito pelo nome. */
export function buildGeometry(part: PartDef, bin: ArrayBuffer): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [key, [offset, count]] of Object.entries(part.attributes)) {
    if (key === 'indices') g.setIndex(new THREE.BufferAttribute(new Uint32Array(bin, offset, count), 1));
    // colorA: cor com alfa (malhas com estado do GS; o alfa controla a mistura).
    else if (key === 'colorA') g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(bin, offset, count), 4));
    else g.setAttribute(key, new THREE.BufferAttribute(new Float32Array(bin, offset, count), key === 'uv' ? 2 : 3));
  }
  g.computeBoundingSphere();
  return g;
}
