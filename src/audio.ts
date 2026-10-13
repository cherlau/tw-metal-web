// Áudio com WebAudio (SPEC §9.10: barramentos, mixagem, espacialização). Música em streaming, efeitos
// decodificados sob demanda. O contexto só nasce no primeiro gesto do usuário (política de autoplay).
//
// NATIVO (docs/NATIVE.md "Som"): cada som posicional tem distância mínima e máxima (FUN_001d32d8 → FUN_00216b78):
// volume cheio até a mínima, cai em linha reta até zero na máxima (= PannerNode "linear"); o ouvinte é o CARRO do
// jogador (FUN_001d32d8 mede a distância ao carro), só o pan vem da câmera.
import { assetURL } from './assets';

interface SfxEntry {
  url: string;
  duration: number;
  loop: boolean;
}
interface SfxIndex {
  banks: Record<string, Record<string, SfxEntry[]>>;
  cars: Record<string, string>;
  /** carro -> banco de armas (*WP.BNK: S_DEPLOY/S_RETRACT dos suportes) */
  carWeapons?: Record<string, string>;
}

export interface PlayOptions {
  pos?: Vec;
  volume?: number;
  rate?: number;
  /** distâncias mínima/máxima da atenuação linear (pés; FUN_001d32d8). Padrão 10/200. */
  min?: number;
  max?: number;
}
interface MusicIndex {
  tracks: Record<string, { url: string; duration: number }>;
  levels: Record<string, string[]>;
  menu: string[];
}

export interface Vec {
  x: number;
  y: number;
  z: number;
}

/** Motor do carro: 3 laços (marcha lenta, médio, alto) misturados pela velocidade (escolha do host). */
class EngineVoice {
  private sources: AudioBufferSourceNode[] = [];
  private gains: GainNode[] = [];
  readonly out: GainNode;
  readonly panner: PannerNode;

  constructor(private ctx: AudioContext, buffers: (AudioBuffer | null)[], dest: AudioNode, siren: AudioBuffer | null) {
    // ⚠️ host: faixa do motor (o jogo usa a mínima/máxima do objeto de som do carro, campos [0x2b]/[0x2c]).
    this.panner = new PannerNode(ctx, { panningModel: 'equalpower', distanceModel: 'linear', refDistance: 20, maxDistance: 600, rolloffFactor: 1 });
    this.out = new GainNode(ctx, { gain: 0.5 });
    this.out.connect(this.panner).connect(dest);
    for (const b of [...buffers, siren]) {
      if (!b) continue;
      const src = new AudioBufferSourceNode(ctx, { buffer: b, loop: true });
      const g = new GainNode(ctx, { gain: 0 });
      src.connect(g).connect(this.out);
      src.start(0, Math.random() * b.duration);
      this.sources.push(src);
      this.gains.push(g);
    }
    if (siren) this.gains[this.gains.length - 1].gain.value = 0.35;
  }

  /** speed01: 0..1 (fração da vel. máx.); throttle: 0..1. */
  update(speed01: number, throttle: number, pos: Vec, alive: boolean) {
    const t = this.ctx.currentTime;
    const s = Math.max(0, Math.min(1.3, speed01));
    const mix = [Math.max(0, 1 - s * 2.5), Math.max(0, 1 - Math.abs(s - 0.45) * 2.5), Math.max(0, (s - 0.45) * 2)];
    for (let i = 0; i < 3 && i < this.gains.length; i++) {
      this.gains[i].gain.setTargetAtTime(alive ? mix[i] * (0.6 + 0.4 * throttle) : 0, t, 0.08);
      this.sources[i].playbackRate.setTargetAtTime(0.85 + s * 0.45 + throttle * 0.1, t, 0.1);
    }
    this.out.gain.setTargetAtTime(alive ? 0.5 : 0, t, 0.1);
    this.panner.positionX.setTargetAtTime(pos.x, t, 0.03);
    this.panner.positionY.setTargetAtTime(pos.y, t, 0.03);
    this.panner.positionZ.setTargetAtTime(pos.z, t, 0.03);
  }
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private sfx: SfxIndex | null = null;
  private music: MusicIndex | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private musicEl: HTMLAudioElement | null = null;
  private playlist: string[] = [];
  private muted = false;
  private engines = new Map<number, EngineVoice>();
  private enginesLoading = new Set<number>();
  private pending: (() => void)[] = [];

  constructor(private readonly level: string, signal: AbortSignal) {
    const start = () => this.start();
    for (const ev of ['keydown', 'pointerdown', 'gamepadconnected'] as const) addEventListener(ev, start, { signal, once: true });
    addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'KeyM') this.toggleMute();
      },
      { signal },
    );
    void Promise.all([
      fetch(assetURL('sfx/index.json')).then((r) => (r.ok ? r.json() : null)),
      fetch(assetURL('music/index.json')).then((r) => (r.ok ? r.json() : null)),
    ]).then(([s, m]) => {
      this.sfx = s;
      this.music = m;
      // O gesto pode chegar antes do índice: a música começa quando os dois existirem.
      if (this.ctx && !this.musicEl) this.startMusic();
    });
  }

  get started() {
    return this.ctx !== null;
  }

  get isMuted() {
    return this.muted;
  }

  private start() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.master = new GainNode(this.ctx, { gain: 0.9 });
    this.musicBus = new GainNode(this.ctx, { gain: 0.45 });
    this.sfxBus = new GainNode(this.ctx, { gain: 0.8 });
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.startMusic();
    for (const f of this.pending.splice(0)) f();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  private startMusic() {
    const tracks = this.music?.levels[this.level] ?? this.music?.menu ?? [];
    if (!tracks.length || !this.ctx || this.musicEl) return;
    this.playlist = [...tracks].sort(() => Math.random() - 0.5);
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    this.ctx.createMediaElementSource(el).connect(this.musicBus);
    let i = 0;
    const next = () => {
      el.src = assetURL(this.music!.tracks[this.playlist[i % this.playlist.length]].url);
      i++;
      // O progresso do jogo nunca depende da mídia tocar (SPEC §12).
      el.play().catch(() => undefined);
    };
    el.addEventListener('ended', next);
    this.musicEl = el;
    next();
  }

  private buffer(url: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(url);
    if (!p) {
      p = fetch(assetURL(url))
        .then((r) => r.arrayBuffer())
        .then((b) => this.ctx!.decodeAudioData(b))
        .catch(() => null);
      this.buffers.set(url, p);
    }
    return p;
  }

  private entries(bank: string, name: string): SfxEntry[] {
    return this.sfx?.banks[bank]?.[name] ?? [];
  }

  /** Toca um efeito (variação sorteada); `pos` posiciona no espaço 3D com a atenuação linear do jogo. */
  play(bank: string, name: string, opt: PlayOptions = {}) {
    if (!this.ctx || this.muted) return;
    const list = this.entries(bank, name);
    if (!list.length) return;
    const e = list[Math.floor(Math.random() * list.length)];
    void this.buffer(e.url).then((buf) => {
      if (!buf || !this.ctx) return;
      const src = new AudioBufferSourceNode(this.ctx, { buffer: buf, playbackRate: opt.rate ?? 1 });
      const g = new GainNode(this.ctx, { gain: opt.volume ?? 1 });
      src.connect(g).connect(this.spatial(opt)).connect(this.sfxBus);
      src.start();
    });
  }

  /** Nó de posição (FUN_00216b78: linear entre mínima e máxima) ou passagem direta sem `pos`. */
  private spatial(opt: PlayOptions): AudioNode {
    if (!opt.pos) return new GainNode(this.ctx!, { gain: 1 });
    return new PannerNode(this.ctx!, {
      panningModel: 'equalpower', distanceModel: 'linear', refDistance: opt.min ?? 10, maxDistance: opt.max ?? 200, rolloffFactor: 1,
      positionX: opt.pos.x, positionY: opt.pos.y, positionZ: opt.pos.z,
    });
  }

  private loops = new Map<string, { src: AudioBufferSourceNode | null; gain: GainNode; pan: AudioNode; want: number }>();

  /**
   * Laço nomeado (turbo, vida baixa, ambiente do menu…): começa no primeiro pedido, depois só acompanha volume e
   * posição; `fade` em segundos (o jogo sobe/desce volume por quadros, FUN_00257338).
   */
  loop(key: string, bank: string, name: string, volume: number, opt: PlayOptions & { fade?: number } = {}) {
    if (!this.ctx || !this.sfx) return;
    let l = this.loops.get(key);
    const t = this.ctx.currentTime;
    if (!l) {
      if (volume <= 0) return;
      const list = this.entries(bank, name);
      if (!list.length) return;
      const gain = new GainNode(this.ctx, { gain: 0 });
      const pan = this.spatial(opt);
      gain.connect(pan).connect(this.sfxBus);
      l = { src: null, gain, pan, want: volume };
      this.loops.set(key, l);
      const entry = l;
      void this.buffer(list[0].url).then((buf) => {
        if (!buf || !this.ctx || this.loops.get(key) !== entry) return;
        entry.src = new AudioBufferSourceNode(this.ctx, { buffer: buf, loop: true });
        entry.src.connect(entry.gain);
        entry.src.start();
      });
    }
    l.want = volume;
    l.gain.gain.setTargetAtTime(this.muted ? 0 : volume, t, Math.max(0.01, (opt.fade ?? 0.05) / 3));
    if (opt.pos && l.pan instanceof PannerNode) {
      l.pan.positionX.setTargetAtTime(opt.pos.x, t, 0.03);
      l.pan.positionY.setTargetAtTime(opt.pos.y, t, 0.03);
      l.pan.positionZ.setTargetAtTime(opt.pos.z, t, 0.03);
    }
    if (volume <= 0 && l.src) {
      const src = l.src;
      const fade = opt.fade ?? 0.05;
      src.stop(t + fade + 0.05);
      this.loops.delete(key);
    }
  }

  /** Ouvinte: posição do carro do jogador (FUN_001d32d8), orientação da câmera (pan). */
  listener(pos: Vec, forward: Vec) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    l.positionX.setTargetAtTime(pos.x, t, 0.02);
    l.positionY.setTargetAtTime(pos.y, t, 0.02);
    l.positionZ.setTargetAtTime(pos.z, t, 0.02);
    l.forwardX.setTargetAtTime(forward.x, t, 0.02);
    l.forwardY.setTargetAtTime(forward.y, t, 0.02);
    l.forwardZ.setTargetAtTime(forward.z, t, 0.02);
  }

  /** Banco de armas do carro (S_DEPLOY/S_RETRACT). */
  weaponBank(car: string): string | null {
    return this.sfx?.carWeapons?.[car] ?? null;
  }

  /** Motor de um carro (cria na primeira chamada; banco pelo nome do modelo). */
  engine(id: number, car: string, speed01: number, throttle: number, pos: Vec, alive: boolean) {
    if (!this.ctx || !this.sfx) return;
    const v = this.engines.get(id);
    if (!v) {
      if (this.enginesLoading.has(id)) return;
      this.enginesLoading.add(id);
      const bank = this.sfx.cars[car] ?? 'axel';
      const names = ['C_IDLE_L', 'C_MID_L', 'C_HIGH_L'];
      void Promise.all([...names.map((n) => this.entries(bank, n)[0]), this.entries(bank, 'C_SIREN_L')[0]].map((e) => (e ? this.buffer(e.url) : Promise.resolve(null)))).then(
        ([a, b, c, siren]) => {
          if (this.ctx) this.engines.set(id, new EngineVoice(this.ctx, [a, b, c], this.sfxBus, siren));
        },
      );
      return;
    }
    v.update(speed01, throttle, pos, alive);
  }
}
