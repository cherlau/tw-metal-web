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
//   "atolado": < 4,4 pés/s acumula, > 73,3 pés/s corta pela metade (FUN_00104df0).
// ⚠️ ESCOLHA DO HOST: navegação (o jogo segue o grafo PTS/GPS pelo "ptool"; aqui o bot mira direto no objetivo e
//   dá ré quando atola), escolha do alvo (regra do jogador, FUN_00102f50), base da habilidade (+0x4c/+0x50 do
//   modo de jogo) e o que fazer com a arma especial e o ataque de ambiente (tipos 1 e 8: não implementados).
import type { WeaponId } from './weapons';

export interface AiProfile {
  fleeHealth: number;
  fireCone: number;
  switchFrames: number;
  waitFrames: number;
  losHeight: number;
  aggression: number;
  retreatHealth: number;
}

export interface AiTables {
  profiles: AiProfile[];
  front: number[][];
  rear: number[][];
  range: { max: number[]; min: number[]; dot: number[] };
}

/** Tipo de arma do jogo (FUN_00120ba0) → arma implementada. 8 = ambiente fica de fora (evento de arena não feito). */
export const AI_WEAPON: Partial<Record<number, WeaponId>> = { 1: 'special', 2: 'fire', 3: 'homing', 4: 'napalm', 6: 'power', 7: 'ricochet', 9: 'swarmer', 10: 'remote' };

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
}

export interface AiOutput {
  fireGun: boolean;
  fireSpecial: boolean;
  nextWeapon: boolean;
  turbo: boolean;
  /** arma a ganhar 1 de munição (FUN_00107148) */
  grant: WeaponId | null;
  retreat: boolean;
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
    const out: AiOutput = { fireGun: false, fireSpecial: false, nextWeapon: false, turbo: false, grant: null, retreat: false };
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

    // Atolado (FUN_00104df0): < 4,4 pés/s acumula; > 73,3 corta pela metade.
    if (v.speed < 4.4) this.stuck++;
    else if (v.speed > 73.333336) this.stuck = Math.floor(this.stuck / 2);
    return out;
  }
}
