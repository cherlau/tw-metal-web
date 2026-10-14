// IA dos bots — regras recuperadas do SCUS_976.21 (docs/NATIVE.md "IA dos bots"); módulo puro (sem DOM/Three).
//
// NATIVO:
//   perfil por veículo (0x2b2d10 + i·0x40, FUN_00102300) e dificuldade 0..3 (FUN_00190448(0x2f4b24));
//   habilidade = mín(0,72 | 0,85 | 1,0, base) (FUN_0013d800);
//   linha de visada entre os carros na altura do perfil (+0x14) e contadores visto/escondido que se cortam pela
//     metade depois de 60 quadros (FUN_00105520);
//   máquina das armas (+0x288, FUN_00106f80): 1 escolhe (FUN_00107500 frente / FUN_00107600 ré / FUN_00107450 longe)
//     pela proporção de uso desejada (0x2b1d20 / 0x2b2518, FUN_001098b0) e se dá 1 de munição se não tiver
//     (FUN_00107148 → FUN_00148638); 2 troca de arma a cada `switchFrames` (FUN_00107708); 3 espera `waitFrames`·2
//     (·1 na dificuldade 3, ·0,1 com o alvo à vista — FUN_00107808); 5 confere o alcance (FUN_00107a00); 6 dispara
//     com alinhamento > dot da arma e distância < alcance (FUN_00107ad8, tabelas 0x2b35d0/0x2b3610/0x2b3650);
//   metralhadora pelo cone que estreita com a distância e a habilidade (FUN_00105970);
//   turbo só em reta (|esterço| < 10°) com > 20 % de carga, até esvaziar (FUN_001034a0);
//   recuo para buscar vida abaixo de `retreatHealth`·U(0,75; 1,25) (FUN_001049a8 / FUN_001027f8);
//   "atolado": < 4,4 pés/s acumula, > 73,3 pés/s corta pela metade (FUN_00104df0);
//   energia (a IA escreve os bits de controle direto em jogador+0x13c): casca de fogo agendada por FUN_00106a88 e
//     ligada por FUN_00104b28 (sem gastar energia, mas exige > 0,6), congelar por FUN_00106cf0, onda quando fica
//     lenta por 1200 quadros (FUN_00103ca8), tiro para trás (bit 0x10) nas armas de ré (FUN_001088e0).
// ⚠️ ESCOLHA DO HOST: navegação (o jogo segue o grafo PTS/GPS pelo "ptool"; aqui o bot mira direto no objetivo e
//   dá ré quando atola), escolha do alvo (regra do jogador, FUN_00102f50), base da habilidade (+0x4c/+0x50 do
//   modo de jogo).
import type { WeaponId } from './weapons';

export interface AiProfile {
  fleeHealth: number;
  fireCone: number;
  switchFrames: number;
  waitFrames: number;
  losHeight: number;
  aggression: number;
  retreatHealth: number;
  /** +0x18 / +0x1c: quadros mínimos entre decisões de congelar e de casca de fogo (escalados pela dificuldade) */
  timerA?: number;
  timerB?: number;
}

/**
 * Estado global da IA no jogo (BSS): último congelar/casca de qualquer bot (DAT_002f41a4 / DAT_002f4198) e o
 * intervalo mínimo entre eles (FUN_001027f8: 0x4b0 quadros para os carros comuns).
 */
export interface AiShared {
  lastShell: number;
  lastFreeze: number;
}
export const AI_ENERGY_GAP = 0x4b0;

export interface AiTables {
  profiles: AiProfile[];
  front: number[][];
  rear: number[][];
  range: { max: number[]; min: number[]; dot: number[] };
}

/** Tipo de arma do jogo (FUN_00120ba0) → arma do port. O 8 (ambiente) tem peso 0 em todas as tabelas: bot não usa. */
export const AI_WEAPON: Partial<Record<number, WeaponId>> = { 1: 'special', 2: 'fire', 3: 'homing', 4: 'napalm', 6: 'power', 7: 'ricochet', 8: 'env', 9: 'swarmer', 10: 'remote' };

/** Teto da habilidade por dificuldade (FUN_0013d800). */
const SKILL_CAP = [0.72, 0.85, 1.0, 1.0];
/** Fator da espera do estado 3 (FUN_00107808): 2, ou 1 na dificuldade 3. */
const waitFactor = (diff: number) => (diff === 3 ? 1 : 2);

export interface AiView {
  /** distância ao alvo (pés), alinhamento = frente·direção ao alvo, alvo olhando para mim = frenteAlvo·(−direção) */
  dist: number;
  align: number;
  targetFacing: number;
  targetSpeedMph: number;
  visible: boolean;
  health01: number;
  turbo01: number;
  speed: number; // pés/s
  steerAngle: number; // rad até o objetivo
  ammo: Partial<Record<WeaponId, number>>;
  selected: WeaponId | null;
  /** energia 0..1 (carro+0x6898), congelado, quadro atual e o estado global da IA */
  energy?: number;
  frozen?: boolean;
  frame?: number;
  shared?: AiShared;
  /** progresso do modo (struct 0x327798 +0x50, DAT_003277e8) — ⚠️ host 0,5, o mesmo da habilidade */
  progress?: number;
  /** rivais abatidos / total (DAT_003277dc / DAT_003277e0, 🟡 papel inferido) */
  rivalsDone?: number;
  rivalsTotal?: number;
  /** esterço pedido no quadro anterior (FUN_00133008) */
  steerCmd?: number;
}

export interface AiOutput {
  fireGun: boolean;
  fireSpecial: boolean;
  nextWeapon: boolean;
  turbo: boolean;
  /** arma a ganhar 1 de munição (FUN_00107148) */
  grant: WeaponId | null;
  retreat: boolean;
  /** bits de energia (src/game/energy.ts BIT) escritos em jogador+0x13c neste quadro */
  bits: number;
}

/** Estado da IA de um carro (campos +0x280..+0x478 do controlador do jogo). */
export class BotBrain {
  state = 1; // +0x288
  stateFrames = 0; // +0x3c8
  chosen = 0; // +0x460 (tipo de arma)
  rearPick = false; // bit 0x10000 de +0x478
  used = new Array<number>(15).fill(0); // +0x330
  usedTotal = 1; // +0x3a8
  usedRear = new Array<number>(15).fill(0); // +0x36c
  usedRearTotal = 1; // +0x3ac
  visFrames = 0; // +0x3e0
  hidFrames = 0; // +0x3e4
  switchTimer = 0; // +0x3fc
  turboOn = false; // controle +0x12c
  stuck = 0; // +0x418
  reverseFrames = 0;
  readonly retreatAt: number; // +0x32c
  readonly skill: number; // +0x31c
  /** energia: quadros com o alvo à vista (+0x3e8), desde a última decisão de congelar/casca (+0x3d8/+0x3dc),
   *  contagem para ligar a casca (+0x45c), fator da vida para a casca (+0x328), quadros lento (+0x448) */
  visRun = 0;
  sinceFreeze = 0;
  sinceShell = 0;
  shellIn = 0;
  shellScale: number;
  slowFrames = 0;
  readonly freezeEvery: number;
  readonly shellEvery: number;

  constructor(
    readonly profile: AiProfile,
    readonly front: number[],
    readonly rear: number[],
    readonly tables: AiTables,
    readonly difficulty: number,
    private readonly rand: () => number = Math.random,
  ) {
    const p = profile;
    this.retreatAt = p.retreatHealth * (0.75 + 0.5 * rand());
    // ⚠️ host: base 0,5 e progresso 0,5 no lugar de +0x4c/+0x50 do modo de jogo.
    const k = [0.33, 0.4, 0.5, 1.0][difficulty] ?? 0.5; // FUN_0013d800 (Head-On; HC usa 0,3 e 0,4)
    this.skill = Math.min(SKILL_CAP[difficulty] ?? 0.85, 0.5 + 0.5 * 0.5 * k);
    this.switchTimer = p.switchFrames;
    // FUN_00102300: +0x18 ×5/×4/×2/×1 e +0x1c ×3/×2/×1/÷2 pela dificuldade; contadores começam sorteados.
    this.freezeEvery = (p.timerA ?? 1800) * ([5, 4, 2, 1][difficulty] ?? 2);
    this.shellEvery = Math.trunc((p.timerB ?? 1800) * ([3, 2, 1, 0.5][difficulty] ?? 1));
    this.sinceFreeze = Math.floor(rand() * (this.freezeEvery + 1));
    this.sinceShell = Math.floor(rand() * (this.shellEvery + 1));
    this.shellScale = this.skill;
  }

  private setState(s: number) {
    if (this.state !== s) {
      this.state = s;
      this.stateFrames = 0;
    }
  }

  /** FUN_00105520: contadores de visada (60 quadros cortam o outro pela metade). */
  private see(visible: boolean) {
    if (visible) {
      if (++this.visFrames > 0x3c) this.hidFrames = Math.floor(this.hidFrames / 2);
    } else if (++this.hidFrames > 0x3c) this.visFrames = Math.floor(this.visFrames / 2);
  }

  /** Escolha da arma (FUN_00107500 / FUN_00107600): a partir de um tipo sorteado, a 1ª com uso abaixo do desejado. */
  private pick(rear: boolean): number {
    const w = rear ? this.rear : this.front;
    const used = rear ? this.usedRear : this.used;
    const total = rear ? this.usedRearTotal : this.usedTotal;
    let t = Math.floor(this.rand() * 15);
    for (let n = 0; n < 15; n++, t++) {
      if (t > 14) t = 1;
      if (w[t] && AI_WEAPON[t] && used[t] / total < w[t]) return t;
    }
    return 0;
  }

  /** Cone da metralhadora (FUN_00105970, alvo de frente: caso B; de costas: caso A). */
  private gunCone(v: AiView): boolean {
    const p = this.profile;
    const s = this.skill;
    const { dist: d, align: a } = v;
    if (v.targetFacing < -0.3) {
      // caso A: alvo de costas, perto
      if (d >= 300 || a <= p.fireCone) return false;
      let th = d < 80 ? 0.992 : d < 160 ? 0.994 : 0.996;
      if (s < 0.1) th = 0.7;
      else if (s < 0.4) th = 0.85;
      else if (s < 0.6) th = 0.92;
      else if (s > 0.9) th = 1.0;
      if (v.targetSpeedMph < 20) th = 1.0;
      return a > th;
    }
    // caso B
    let de = d;
    if (a > p.fireCone && d > 300 && a > 0.95) de = a < 0.97 ? d * 0.75 * 0.75 : d * 0.75;
    if (a <= p.fireCone || de >= 500) return false;
    let th = d < 25 ? p.fireCone : d <= 500 ? p.fireCone + ((1 - p.fireCone) * d) / 500 : 1;
    if (s < 0.1) th = 1;
    else if (s < 0.4) {
      if (v.targetSpeedMph > 70 && a > 0.95) th = 1;
    } else if (s > 0.7) th = 0.95;
    return a > th;
  }

  /** Um quadro de 1/60 s. */
  step(v: AiView): AiOutput {
    const out: AiOutput = { fireGun: false, fireSpecial: false, nextWeapon: false, turbo: false, grant: null, retreat: false, bits: 0 };
    const p = this.profile;
    this.stateFrames++;
    this.see(v.visible);
    out.retreat = v.health01 < this.retreatAt;

    // Metralhadora.
    out.fireGun = v.visible && this.gunCone(v);

    // Máquina das armas.
    const weaponOf = (t: number) => AI_WEAPON[t] ?? null;
    switch (this.state) {
      case 1: {
        const far = v.dist >= 1200;
        this.rearPick = !far && v.align < 0;
        if (far) this.chosen = this.front[3] ? 3 : this.front[2] ? 2 : 0; // FUN_00107450
        else this.chosen = this.pick(this.rearPick);
        const w = weaponOf(this.chosen);
        if (!w) break;
        if (!(v.ammo[w] ?? 0)) out.grant = w; // FUN_00107148: 1 de munição
        this.setState(2);
        break;
      }
      case 2: {
        const w = weaponOf(this.chosen);
        if (!w || this.stateFrames > 0x3b) {
          this.setState(1);
          break;
        }
        if (v.selected === w) this.setState(3);
        else if (--this.switchTimer <= 0) {
          out.nextWeapon = true;
          this.switchTimer = p.switchFrames;
        }
        break;
      }
      case 3: {
        let wait = p.waitFrames * waitFactor(this.difficulty);
        if (v.visible) wait *= 0.1;
        if (this.stateFrames > wait) this.setState(5);
        break;
      }
      case 5: {
        const max = this.tables.range.max[this.chosen] ?? 0;
        if (v.dist >= max) this.setState(1);
        else this.setState(6);
        break;
      }
      case 6: {
        const w = weaponOf(this.chosen);
        const r = this.tables.range;
        const dot = r.dot[this.chosen] ?? 1;
        // ré: dispara com o alvo atrás (FUN_00108170); frente: alinhamento > dot da arma
        const aligned = this.rearPick ? -v.align > Math.max(dot, 0.5) : v.align > dot;
        if (w && v.selected === w && aligned && v.dist < (r.max[this.chosen] ?? 0) && v.dist > (r.min[this.chosen] ?? 0)) {
          out.fireSpecial = true;
          // FUN_001088e0: de ré, os tipos 1, 2, 3, 4, 6, 7 e 10 saem para trás (bit 0x10)
          if (this.rearPick && REAR_TYPES.has(this.chosen)) out.bits |= 0x10;
          if (this.rearPick) {
            this.usedRear[this.chosen]++;
            this.usedRearTotal++;
          } else {
            this.used[this.chosen]++;
            this.usedTotal++;
          }
          this.setState(1);
        } else if (this.stateFrames > 0x12d) this.setState(1);
        break;
      }
      default:
        this.setState(1);
    }

    // Turbo (FUN_001034a0): liga em reta com > 20 % de carga; fica até esvaziar.
    if (!this.turboOn && Math.abs(v.steerAngle) < 0.17453292 && v.turbo01 > 0.2) {
      const chased = this.skill > 0.6 && v.targetFacing > 0.95 && v.align < 0 && v.dist < 200;
      if (chased || (out.retreat && this.stateFrames < 300)) this.turboOn = true;
    }
    if (this.turboOn && v.turbo01 < 0.01) this.turboOn = false;
    out.turbo = this.turboOn;

    this.energyStep(v, out);

    // Atolado (FUN_00104df0): < 4,4 pés/s acumula; > 73,3 corta pela metade.
    if (v.speed < 4.4) this.stuck++;
    else if (v.speed > 73.333336) this.stuck = Math.floor(this.stuck / 2);
    return out;
  }

  /** Decisões de energia (FUN_00104b28 → FUN_00106a88 / FUN_00106cf0, FUN_00103ca8). */
  private energyStep(v: AiView, out: AiOutput) {
    const sh = v.shared;
    if (!sh || v.frame === undefined) return;
    const now = v.frame;
    const p = this.profile;
    const energy = v.energy ?? 0;
    const progress = v.progress ?? 0.5;
    this.visRun = v.visible ? this.visRun + 1 : 0; // FUN_00104df0: bit 0x20 de +0x478 (visada, FUN_00105520)
    this.sinceFreeze++;
    this.sinceShell++;

    // FUN_00106a88: agenda a casca de fogo quando a vida cai abaixo de (1 − perfil+4)·fator.
    if (this.shellIn === 0 && this.visRun >= 8 && this.sinceShell > this.shellEvery && now - sh.lastShell > AI_ENERGY_GAP &&
      energy > 0.6 && !v.frozen && v.health01 < (1 - p.fleeHealth) * this.shellScale) {
      if (this.rand() > progress + 0.5) {
        const k = p.switchFrames * ([7, 5, 3, 1][this.difficulty] ?? 3);
        this.shellIn = k + Math.floor(this.rand() * (3 * k + 1));
      }
      this.sinceShell = 0;
    }
    // FUN_00104b28: a contagem chega a zero → bit 4 (casca), e o fator da vida cai (×habilidade).
    if (this.shellIn > 0 && --this.shellIn < 1) {
      out.bits |= 0x4;
      this.shellScale *= this.skill;
      sh.lastShell = now;
      this.shellIn = 0;
    }

    // FUN_00106cf0: congelar com a arma em preparo, alvo a < 300 pés bem alinhado e quase sem esterço.
    if (this.skill >= 0.1 && this.state >= 2 && this.state <= 6 && v.dist < 300 && Math.abs(v.steerCmd ?? 0) < 0.4 &&
      this.sinceFreeze > this.freezeEvery && now - sh.lastFreeze > AI_ENERGY_GAP && v.align > 0.95) {
      if (this.rand() < progress + 0.5 && (v.rivalsTotal ?? 0) * 0.25 < (v.rivalsDone ?? 0)) {
        if (this.rand() < this.skill) {
          out.bits |= 0x1;
          sh.lastFreeze = now;
        }
      }
      this.sinceFreeze = 0;
    }

    // FUN_00103ca8: lento (< 40 mph) acumula, rápido desconta; passou de 1200 quadros → onda se o alvo está a
    // < 200 pés ou virado para mim (senão o jogo reposiciona o bot no grafo — não portado).
    if (v.frozen) this.slowFrames = 0;
    else if (v.speed >= 58.666668) this.slowFrames = Math.max(0, this.slowFrames - 1);
    else this.slowFrames++;
    if (this.slowFrames > 0x4b0) {
      if (v.dist < 200 || v.targetFacing > 0) out.bits |= 0x20;
      this.slowFrames = 0;
    }
  }
}

/** Tipos que FUN_001088e0 dispara para trás quando escolhidos pela tabela de ré. */
const REAR_TYPES = new Set([1, 2, 3, 4, 6, 7, 10]);
