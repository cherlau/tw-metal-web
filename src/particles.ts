// Partículas — porte do sistema do SCUS_976.21 (docs/NATIVE.md "Partículas"). Dados: rules/particles.json
// (tools/native/export_particles.py: tabelas 0x2cab00/0x2cbd60/0x2cd8e0/0x2cf320 por id, texturas do RESIDENT.BDD).
//
// NATIVO:
//   FUN_002470c0 (avulso) / FUN_00247580 (preso a uma posição e matriz) → FUN_00246878 copia as tabelas do id e
//     aplica a escala (√escala na duração, taxa, velocidade, vida; escala no tamanho);
//   FUN_00245288 nasce n = taxa·quadros partículas (resto acumulado em +0x1650): direção sorteada num cone em
//     torno do eixo Y do emissor (FUN_00237d80: y ∈ [1 − 2k, 1]), D1/D2 = linhas X/Z + Y·axial[0|1];
//     velocidade = herdada + D1·U(vel); posição = anterior + deslocamento·frac + D2·U(espalhamento) +
//     D1·vel·(1 − frac) (frac = i/n distribui o lote ao longo do quadro);
//   FUN_00245d48 (VU0) por quadro: idade += taxa da partícula; pos += v; v = A + (v − A)/(1 + |v − A|·arrasto);
//     v.z += gravidade; A = (0,1; 0; empuxo); arrasto interpolado de drag[0] a drag[1] até dragSplit;
//     tamanho += grow[0] → grow[1] (até growSplit, depois grow[1]);
//   FUN_00246620: emite enquanto o atraso (+0x15f4) zerou e a duração (+0x15f6, tiques) não acabou; 0 = até
//     FUN_00249828 parar; o emissor some quando acaba de emitir e não há partículas vivas;
//   FUN_002464e8: luz (T1 flags & 6) com intensidade em rampa pela tabela T2+0x18..+0x24;
//   efeitos compostos ≥ 0x55 (FUN_00248278 … FUN_002494f8), com a reflexão 0,75·(tangente − normal) de
//     FUN_00248070.
// ⚠️ ESCOLHA DO HOST: desenho (o jogo usa microcódigo da VU1): tipo 6 = sprites de lado = tamanho (pés), tipo 3 =
//   riscos do rastro de 1 tique, tipo 1 = sprites ao longo do rastro (largura = tamanho + grow[1]·idade); cores ×1/128 (MODULATE do GS); mistura
//   0x48 aditiva, 0x44 normal, 0xfe/0xff recorte; slot 1 (textura 1, fora do RESIDENT) = mancha gerada; luz com
//   raio = 8·intensidade; partículas do tipo 0x20 de T2 (vizinhança) sem a força entre vizinhas.
import * as THREE from 'three';
import { loadTexture, type TextureDef } from './assets';

export interface EmitterDef {
  id: number;
  flags: number;
  type: number;
  slot: number;
  blend: number;
  colors: number[][];
  lightColor: number[];
  drag: [number, number];
  dragSplit: number;
  buoyancy: number;
  gravity: number;
  light: [number, number, number, number];
  emitFlags: number;
  delay: number;
  duration: number;
  lifeRand: number;
  rate: number;
  coneK: number;
  offset: [number, number, number];
  axial: [number, number];
  speed: [number, number];
  inherit: number;
  spread: [number, number];
  size: [number, number];
  grow: [number, number];
  growSplit: number;
  life: number;
}

export interface ParticleSlot {
  mode: number;
  tiles: [number, number];
  frames: number;
  image?: TextureDef;
}

export interface ParticleDoc {
  emitters: EmitterDef[];
  slots: Record<string, ParticleSlot>;
}

/** PS2 (x, y, z), z para cima → Three (x, z, −y) (src/coords.ts). */
const fromPs2 = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
const UP = new THREE.Vector3(0, 1, 0);

interface Particle {
  p: THREE.Vector3;
  v: THREE.Vector3;
  age: number;
  rate: number;
  size: number;
  tile: number;
}

export interface SpawnOptions {
  scale?: number;
  /** eixo do cone (Three); padrão: para cima (matriz 0x2cd820) */
  dir?: THREE.Vector3;
  /** velocidade herdada em pés/s (FUN_002470c0 param_6: ×1/60 por tique) */
  vel?: THREE.Vector3;
  /** cor 0xAABBGGRR que tinge as 8 chaves (FUN_002470c0 param_5) */
  color?: number;
}

export interface Follow {
  pos: THREE.Vector3;
  /** eixo Y do emissor (frente) e X; sem eles, a matriz padrão */
  forward?: THREE.Vector3;
  right?: THREE.Vector3;
}

export class Emitter {
  readonly particles: Particle[] = [];
  readonly pos = new THREE.Vector3();
  private prev = new THREE.Vector3();
  private r0 = new THREE.Vector3(1, 0, 0);
  private r1 = UP.clone();
  private r2 = new THREE.Vector3(0, 0, 1);
  private accum = 0;
  private delay: number;
  /** tiques de emissão restantes (+0x15f6); 0 na tabela = até parar */
  duration: number;
  private readonly finite: boolean;
  emitting = true;
  private progress = 0;
  private readonly progressRate: number;
  private fixedVel: THREE.Vector3 | null = null;
  readonly colors: number[][];
  rate: number;
  speed: [number, number];
  spread: [number, number];
  size: [number, number];
  grow: [number, number];
  life: number;
  coneK: number;
  intensity = 0;
  readonly capacity: number;

  constructor(
    readonly def: EmitterDef,
    readonly slot: ParticleSlot | null,
    pos: THREE.Vector3,
    opts: SpawnOptions,
    private readonly rand: () => number,
    readonly follow?: () => Follow,
  ) {
    const scale = opts.scale ?? 1;
    const f = def.emitFlags;
    this.delay = def.delay;
    this.duration = def.duration;
    this.rate = def.rate;
    this.speed = [...def.speed];
    this.spread = [...def.spread];
    this.size = [...def.size];
    this.grow = [...def.grow];
    this.life = def.life;
    this.coneK = def.coneK;
    if (scale !== 1) {
      // FUN_00246878: √escala na duração/taxa (flags 0x10/0x08/0x20), na velocidade (0x40) e na vida (0x80)
      const s1 = f & 0x10 ? Math.sqrt(scale) : 1;
      const s2 = Math.sqrt(scale);
      if (this.duration) this.duration = Math.max(1, Math.trunc(this.duration * s1 + 0.5));
      if (f & 0x8) this.rate *= s1;
      else if (f & 0x20) this.rate /= s1;
      if (f & 0x40) this.speed = [this.speed[0] * s2, this.speed[1] * s2];
      if (f & 0x80) {
        this.size = [this.size[0] * scale, this.size[1] * scale];
        this.life = Math.trunc(this.life * s1);
        this.grow = [this.grow[0] * s2, this.grow[1] * s2];
      }
      if (f & 0x100) this.spread = [this.spread[0] * scale, this.spread[1] * scale];
    }
    this.finite = this.duration !== 0;
    this.progressRate = this.finite ? 1 / (this.duration + (this.life >> 1)) : 0;
    this.capacity = def.type === 3 ? 0x8b : 0x80;
    // FUN_002470c0 param_5: alfa = (alfa·cor) e RGB da cor
    const c = opts.color;
    this.colors = def.colors.map((k) => {
      if (c === undefined) return [...k];
      const hiK = ((k[3] << 8) | k[2]) >>> 0;
      const hiC = (c >>> 16) & 0xffff;
      const a = ((Math.imul(hiK, hiC) + 0xff0000) >>> 24) & 0xff;
      return [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, a];
    });
    const off = def.offset;
    this.pos.copy(pos).add(fromPs2(off[0], off[1], off[2]));
    this.prev.copy(this.pos);
    if (opts.dir) this.setAxis(opts.dir);
    if (opts.vel) {
      // FUN_002470c0: com velocidade, herda vel/60 por tique e o atraso cai 1
      this.fixedVel = opts.vel.clone().multiplyScalar(1 / 60);
      this.delay = Math.max(0, this.delay - 1);
    }
  }

  /** Matriz pelo eixo (FUN_00237680): Y = eixo; X e Z ortogonais. */
  setAxis(axis: THREE.Vector3, right?: THREE.Vector3) {
    this.r1.copy(axis).normalize();
    const ref = right ?? (Math.abs(this.r1.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP);
    this.r2.crossVectors(ref, this.r1).normalize();
    if (this.r2.lengthSq() < 1e-6) this.r2.set(0, 0, 1);
    this.r0.crossVectors(this.r1, this.r2).normalize();
  }

  /** FUN_00249828: para de emitir (as partículas vivas terminam a vida). */
  stop() {
    this.emitting = false;
  }

  get done(): boolean {
    return !this.emitting && this.particles.length === 0 && this.intensity <= 0;
  }

  /** Um tique de 1/60 s (FUN_00249af0: nascimento, física, fim). */
  tick() {
    const def = this.def;
    if (this.follow) {
      const fl = this.follow();
      this.pos.copy(fl.pos);
      if (fl.forward) this.setAxis(fl.forward, fl.right);
    }
    this.simulate();
    if (this.emitting && this.delay === 0) this.spawn();
    this.prev.copy(this.pos);
    // FUN_00246620: a duração conta depois do atraso
    if (this.finite && this.delay === 0 && this.emitting) {
      this.duration -= 1;
      if (this.duration < 0) this.emitting = false;
    }
    if (this.delay > 0) this.delay--;
    this.light();
    if (def.type === 0 && this.progress >= 1) this.emitting = false;
  }

  private light() {
    const def = this.def;
    if (!(def.flags & 6)) return;
    this.progress += this.progressRate;
    const [l0, l1, split, fade] = def.light;
    const p = this.progress;
    this.intensity = p <= split ? l0 + (split ? ((l1 - l0) / split) * p : 0) : l1 - (fade ? (l1 / fade) * (p - split) : l1);
    if (!this.finite && this.emitting) this.intensity = Math.max(this.intensity, l1);
    if (this.intensity < 0) this.intensity = 0;
  }

  private spawn() {
    const def = this.def;
    if (def.type === 0) return;
    const want = this.accum + this.rate;
    let n = Math.trunc(want);
    this.accum = want - n;
    n = Math.min(n, this.capacity - this.particles.length);
    if (n <= 0) return;
    const disp = this.pos.clone().sub(this.prev);
    const inherit = this.fixedVel ?? disp.clone().multiplyScalar(def.inherit);
    const slot = this.slot;
    const variants = slot ? Math.max(1, Math.min(16, Math.trunc((slot.tiles[0] * slot.tiles[1]) / Math.max(1, slot.frames)))) : 1;
    for (let i = 0; i < n; i++) {
      const frac = (i + 1) / n;
      const r = this.rand;
      const cy = 1 - 2 * this.coneK * r();
      const phi = r() * Math.PI * 2;
      const rr = Math.sqrt(Math.max(0, 1 - cy * cy));
      const cx = rr * Math.cos(phi);
      const cz = rr * Math.sin(phi);
      const base = this.r0.clone().multiplyScalar(cx).addScaledVector(this.r2, cz);
      const d1 = base.clone().addScaledVector(this.r1, cy * def.axial[0]);
      const d2 = base.addScaledVector(this.r1, cy * def.axial[1]);
      const speed = this.speed[0] + (this.speed[1] - this.speed[0]) * r();
      const spread = this.spread[0] + (this.spread[1] - this.spread[0]) * r();
      const v = inherit.clone().addScaledVector(d1, speed);
      const p = this.prev.clone().addScaledVector(disp, frac).addScaledVector(d2, spread).addScaledVector(d1, speed * (1 - frac));
      const lifeRate = this.life > 0 ? 1 / this.life : 1;
      const rate = def.type === 1 ? lifeRate : lifeRate / (1 - def.lifeRand * r());
      const size = this.size[0] < this.size[1] ? this.size[0] + (this.size[1] - this.size[0]) * r() : this.size[0];
      this.particles.push({ p, v, age: 0, rate, size, tile: Math.floor(r() * variants) });
    }
  }

  private simulate() {
    const def = this.def;
    const A = fromPs2(0.1, 0, def.buoyancy);
    const g = def.gravity;
    const [d0, d1] = def.drag;
    const ds = def.dragSplit;
    const [g0, g1] = this.grow;
    const gs = def.growSplit;
    const rel = new THREE.Vector3();
    let w = 0;
    for (const q of this.particles) {
      q.age += q.rate;
      if (q.age >= 1) continue;
      rel.copy(q.v).sub(A);
      const k = q.age < ds && ds > 0 ? d0 + ((d1 - d0) * q.age) / ds : d1;
      const D = 1 + rel.length() * k;
      q.p.add(q.v);
      q.v.copy(A).addScaledVector(rel, 1 / D);
      q.v.y += g; // gravidade em z do PS2 = y do Three
      // tipos 6/3: tamanho por partícula cresce; tipos 1/2 não (a largura da fita vem das constantes do VU1)
      if ((def.type === 6 || def.type === 3) && (g0 !== 0 || g1 !== 0)) {
        q.size += q.age < gs && gs > 0 ? g0 + ((g1 - g0) * q.age) / gs : g1;
        if (q.size < 0) q.size = 0;
      }
      this.particles[w++] = q;
    }
    this.particles.length = w;
  }

  /** Cor RGBA 0..1 pela idade (8 chaves; MODULATE do GS: 0x80 = 1,0). */
  color(age: number, out: number[]) {
    const t = Math.min(0.999, Math.max(0, age)) * 7;
    const i = Math.floor(t);
    const f = t - i;
    const a = this.colors[i];
    const b = this.colors[Math.min(7, i + 1)];
    for (let k = 0; k < 4; k++) out[k] = (a[k] + (b[k] - a[k]) * f) / 128;
    return out;
  }
}

/** FUN_00248070 + FUN_00237840: 0,75·(tangente − componente normal) da velocidade e a direção dela. */
function reflect(vel: THREE.Vector3, normal: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const n = normal.clone().normalize();
  const vn = n.clone().multiplyScalar(vel.dot(n));
  const vt = vel.clone().sub(vn);
  const out = vt.multiplyScalar(0.75).addScaledVector(vn, -0.75);
  const dir = out.lengthSq() > 1e-9 ? out.clone().normalize() : n.clone();
  return [out, dir];
}

const randDir = (rand: () => number) => {
  // FUN_00249008: (U(−1,1), U(−1,1), U(0,25; 1)) normalizado, em PS2
  const v = fromPs2(rand() * 2 - 1, rand() * 2 - 1, 0.25 + rand() * 0.75);
  return v.normalize();
};

export interface ParticleLight {
  pos: THREE.Vector3;
  color: THREE.Color;
  radius: number;
}

interface Batch {
  mesh: THREE.Mesh;
  pos: Float32Array;
  uv: Float32Array;
  col: Float32Array;
  index: Uint32Array;
  n: number;
}

const MAX_QUADS = 4096;

export class ParticleSystem {
  readonly group = new THREE.Group();
  private emitters: Emitter[] = [];
  private batches = new Map<string, Batch>();
  private lines: { obj: THREE.LineSegments; pos: Float32Array; col: Float32Array; n: number };
  private textures = new Map<number, THREE.Texture>();
  private acc = 0;

  private constructor(
    readonly doc: ParticleDoc,
    private readonly rand: () => number,
  ) {
    const pos = new Float32Array(MAX_QUADS * 2 * 3);
    const col = new Float32Array(MAX_QUADS * 2 * 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    const obj = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    obj.frustumCulled = false;
    this.group.add(obj);
    this.lines = { obj, pos, col, n: 0 };
  }

  static async load(doc: ParticleDoc, rand: () => number = Math.random): Promise<ParticleSystem> {
    const s = new ParticleSystem(doc, rand);
    for (const [k, slot] of Object.entries(doc.slots)) {
      const t = slot.image ? await loadTexture(slot.image) : blobTexture();
      const tex = t.clone();
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      s.textures.set(Number(k), tex);
    }
    return s;
  }

  /**
   * FUN_002470c0: emissor avulso (ids < 0x55) ou efeito composto (0x55..0x64). `hitCar` = golpe num carro
   * (FUN_002024a8 passa "objeto atingido é veículo": faíscas 0x36 em vez da fumaça 1).
   */
  spawn(id: number, pos: THREE.Vector3, opts: SpawnOptions = {}, hitCar = false): Emitter | null {
    if (id < 0) return null;
    if (id >= 0x55) {
      this.composite(id, pos, opts, hitCar);
      return null;
    }
    if (id === 0x28) return null; // FUN_0021e070 (caso à parte, não portado)
    const def = this.doc.emitters[id];
    if (!def) return null;
    const e = new Emitter(def, this.doc.slots[String(def.slot)] ?? null, pos, opts, this.rand);
    this.emitters.push(e);
    return e;
  }

  /** FUN_00247580: emissor preso (segue posição e frente a cada tique). */
  attach(id: number, follow: () => Follow, opts: SpawnOptions = {}): Emitter | null {
    const def = this.doc.emitters[id];
    if (!def) return null;
    const f = follow();
    const e = new Emitter(def, this.doc.slots[String(def.slot)] ?? null, f.pos, opts, this.rand, follow);
    if (f.forward) e.setAxis(f.forward, f.right);
    this.emitters.push(e);
    return e;
  }

  /** Efeitos compostos (FUN_00248278 … FUN_002494f8). `opts.vel` = velocidade (pés/s), `opts.dir` = normal. */
  private composite(id: number, pos: THREE.Vector3, opts: SpawnOptions, hitCar: boolean) {
    const s = opts.scale ?? 1;
    const vel = opts.vel ?? fromPs2(0, 0, 0.01);
    const normal = opts.dir ?? UP.clone();
    const [refl, rdir] = reflect(vel, normal);
    const one = (k: number, o: SpawnOptions) => this.spawn(k, pos, { scale: s, ...o });
    const half = (e: Emitter | null) => {
      if (e) e.coneK = 0.5;
    };
    const rnd = (k: number) => this.rand() * (k + 1);
    switch (id) {
      case 0x55: // FUN_00248278
        half(one(0, { dir: normal, vel: refl }));
        half(one(hitCar ? 0x36 : 1, {}));
        half(one(2, {}));
        half(one(3, { dir: normal, vel: refl }));
        break;
      case 0x59:
        one(0xe, { dir: opts.dir, vel: opts.vel, color: opts.color });
        break;
      case 0x5a: // FUN_00248b68
        half(one(0x39, { dir: normal, vel: refl }));
        one(0x3d, { dir: rdir });
        half(one(3, { dir: normal, vel: refl }));
        break;
      case 0x5b: { // FUN_00248e98
        half(this.spawn(0, pos, { scale: 2 * s, dir: normal, vel: refl }));
        const e = one(0x36, { dir: rdir });
        if (e) e.duration = 0x1e;
        half(one(2, { dir: rdir }));
        half(this.spawn(3, pos, { scale: 2 * s, dir: normal, vel: refl }));
        break;
      }
      case 0x5c: { // FUN_00248628
        one(0x3b, { dir: rdir, color: 0x80ffd0ff });
        one(0x3c, { dir: rdir, color: 0x80ffd0ff });
        const e = one(hitCar ? 0x36 : 1, { dir: rdir });
        if (e) {
          if (hitCar) {
            e.rate = 30;
            e.life = 0x3c;
          } else {
            e.rate = 10 + Math.floor(rnd(20));
            e.life = 0x1e + Math.floor(rnd(30));
          }
        }
        break;
      }
      case 0x5d: { // FUN_00248410
        one(2, { dir: rdir, color: 0x800000ff });
        one(0x3c, { dir: rdir, color: 0x804040ff });
        one(0x3b, { dir: rdir, color: 0x80ffffff });
        for (let k = 0; k < 2; k++) this.spawn(0x3e, pos, { scale: 2 * s, dir: randDir(this.rand), color: 0x800000ff });
        break;
      }
      case 0x5e: { // FUN_00248798
        one(0x3b, { dir: rdir, color: 0x80ffffff });
        const e = one(hitCar ? 0x36 : 1, { dir: rdir });
        if (e) e.rate = 10 + Math.floor(rnd(20));
        one(3, { dir: normal, vel: refl });
        one(0x3c, { dir: rdir, color: 0x806464e0 });
        const n0 = fromPs2(0, 0, 0.9).add(new THREE.Vector3(normal.x, 0, normal.z)).normalize();
        one(0x3e, { dir: n0, color: 0x8032c8ff });
        one(0x3e, { dir: n0.clone().add(new THREE.Vector3(0.3, 0, -0.3)).normalize(), color: 0x8032c8ff });
        one(0x3e, { dir: new THREE.Vector3(rdir.x, 0.9, rdir.z).normalize(), color: 0x8032c8ff });
        break;
      }
      case 0x5f: // FUN_00248c70
        half(one(0x2a, { dir: normal, vel: refl }));
        half(one(2, { dir: rdir }));
        one(0x3d, { dir: rdir });
        break;
      case 0x60: { // FUN_00248d78
        half(one(0x3f, { dir: normal, vel: refl }));
        half(one(2, { dir: rdir }));
        const e = one(0x3d, { dir: rdir, color: 0x80f080ff });
        if (e) e.rate = 100;
        break;
      }
      case 0x61: { // FUN_002489e8
        const e = one(hitCar ? 0x36 : 1, {});
        if (e) e.rate = 10 + Math.floor(rnd(20));
        one(3, {});
        one(0x3c, { color: 0x800045ff });
        break;
      }
      case 0x62: // FUN_00249008
        for (let k = 0; k < 3; k++) one(0x3e, { dir: randDir(this.rand), color: 0x8032c832 });
        this.spawn(0x34, pos, { scale: 2 * s, color: 0x8032c832 });
        one(0x3b, { color: 0x8032c832 });
        this.spawn(2, pos, { scale: 2 * s, color: 0x8032c832 });
        break;
      case 0x63: // FUN_002492a0 (cor gp−0x6648)
        for (let k = 0; k < 3; k++) one(0x3e, { dir: randDir(this.rand), color: 0x800000ff });
        one(0x3b, { color: 0x800000ff });
        this.spawn(2, pos, { scale: 2 * s, color: 0x800000ff });
        break;
      case 0x64: { // FUN_002494f8 (cor gp−0x6644)
        const c = 0x80f040a0;
        for (let k = 0; k < 3; k++) one(0x3e, { dir: randDir(this.rand), color: c });
        const e = this.spawn(0x2a, pos, { scale: 1.5 * s, color: c });
        if (e) e.life = 0x2d;
        this.spawn(0x3b, pos, { scale: 2 * s, color: c });
        this.spawn(2, pos, { scale: 2 * s, color: c });
        break;
      }
      default:
        break;
    }
  }

  /** Avança `dt` segundos em tiques de 1/60 s. */
  update(dt: number) {
    this.acc += dt * 60;
    let n = Math.min(8, Math.floor(this.acc));
    this.acc -= Math.floor(this.acc);
    while (n-- > 0) {
      for (const e of this.emitters) e.tick();
      this.emitters = this.emitters.filter((e) => !e.done);
    }
  }

  /** Luzes ativas (T1 flags & 6): cor da tabela T1+0x34, raio ⚠️ 8·intensidade. */
  lights(): ParticleLight[] {
    const out: ParticleLight[] = [];
    for (const e of this.emitters) {
      if (!(e.def.flags & 6) || e.intensity <= 0) continue;
      const [r, g, b] = e.def.lightColor;
      out.push({ pos: e.pos.clone(), color: new THREE.Color(r / 255, g / 255, b / 255), radius: 8 * e.intensity });
    }
    return out;
  }

  get count(): number {
    return this.emitters.reduce((s, e) => s + e.particles.length, 0);
  }

  private batch(slot: number, blend: number): Batch {
    const key = `${slot}|${blend}`;
    let b = this.batches.get(key);
    if (b) return b;
    const pos = new Float32Array(MAX_QUADS * 4 * 3);
    const uv = new Float32Array(MAX_QUADS * 4 * 2);
    const col = new Float32Array(MAX_QUADS * 4 * 4);
    const index = new Uint32Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) index.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const cutout = blend >= 0xfe;
    const mat = new THREE.MeshBasicMaterial({
      map: this.textures.get(slot) ?? null,
      vertexColors: true,
      transparent: !cutout,
      alphaTest: cutout ? 0.3 : 0,
      depthWrite: cutout,
      blending: blend === 0x48 ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = blend === 0x48 ? 3 : 2;
    this.group.add(mesh);
    b = { mesh, pos, uv, col, index, n: 0 };
    this.batches.set(key, b);
    return b;
  }

  /** Monta os quads virados para a câmera e as linhas dos riscos. */
  render(camera: THREE.Camera) {
    for (const b of this.batches.values()) b.n = 0;
    this.lines.n = 0;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const c = [0, 0, 0, 0];
    const corner = new THREE.Vector3();
    for (const e of this.emitters) {
      const def = e.def;
      if (def.type === 3) {
        const L = this.lines;
        for (const q of e.particles) {
          if (L.n >= MAX_QUADS) break;
          e.color(q.age, c);
          const i = L.n++;
          L.pos.set([q.p.x, q.p.y, q.p.z, q.p.x - q.v.x, q.p.y - q.v.y, q.p.z - q.v.z], i * 6);
          L.col.set([c[0], c[1], c[2], Math.min(1, c[3]), c[0], c[1], c[2], 0], i * 8);
        }
        continue;
      }
      if (def.type === 0) continue;
      const slot = e.slot;
      const b = this.batch(def.slot, def.blend);
      const tx = slot?.tiles[0] ?? 1;
      const ty = slot?.tiles[1] ?? 1;
      const frames = Math.max(1, slot?.frames ?? 1);
      const animated = frames > 1 && ((slot?.mode ?? 0) & 0x70) === 0x20;
      for (const q of e.particles) {
        if (b.n >= MAX_QUADS) break;
        e.color(q.age, c);
        // ladrilho: variante sorteada ou quadro da animação pela idade
        const tile = animated ? Math.min(frames - 1, Math.floor(q.age * frames)) : frames > 1 ? q.tile * frames + Math.min(frames - 1, Math.floor(q.age * frames)) : q.tile;
        const u0 = (tile % tx) / tx;
        const v0 = Math.floor(tile / tx) % ty / ty;
        // tipo 1 (fita): ⚠️ largura = tamanho + grow[1]·idade (FUN_00243140 passa tamanho e grow[1] ao VU1)
        const h = (def.type === 1 ? q.size + e.grow[1] * q.age : q.size) * 0.5;
        const i = b.n++;
        for (let k = 0; k < 4; k++) {
          const sx = k === 0 || k === 3 ? -1 : 1;
          const sy = k < 2 ? -1 : 1;
          corner.copy(q.p).addScaledVector(right, sx * h).addScaledVector(up, sy * h);
          b.pos.set([corner.x, corner.y, corner.z], (i * 4 + k) * 3);
          b.uv.set([u0 + (sx > 0 ? 1 / tx : 0), v0 + (sy > 0 ? 0 : 1 / ty)], (i * 4 + k) * 2);
          b.col.set([c[0], c[1], c[2], Math.min(1, c[3])], (i * 4 + k) * 4);
        }
      }
    }
    for (const b of this.batches.values()) {
      const g = b.mesh.geometry;
      g.setDrawRange(0, b.n * 6);
      for (const a of ['position', 'uv', 'color']) (g.getAttribute(a) as THREE.BufferAttribute).needsUpdate = true;
      b.mesh.visible = b.n > 0;
    }
    const lg = this.lines.obj.geometry;
    lg.setDrawRange(0, this.lines.n * 2);
    (lg.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (lg.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Slot 1 (textura 1 do jogo, fora do RESIDENT): ⚠️ mancha radial 2×2 gerada. */
function blobTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  for (let k = 0; k < 4; k++) {
    const x = (k % 2) * 32 + 16;
    const y = Math.floor(k / 2) * 32 + 16;
    const grd = g.createRadialGradient(x, y, 0, x, y, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.5 + 0.1 * k, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(x - 16, y - 16, 32, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
