// Armas especiais por carro — dados PUROS (o Match executa). NATIVO: FUN_0011d340 cria a classe da especial por id
// de veículo (carro+0x5f90); o disparo é o método vtable+0x44 de cada classe (docs/NATIVE.md "Armas especiais").
// Todas começam com 1 carga (FUN_00147420(...,1,1)) e ganham +1 a cada carro+0x62f0 tiques até 5 (FUN_0011ef10).

export interface SpecialShot {
  proj: number;
  /** tiques depois do disparo (FUN_001e1550: 0, 30, 60, 90; FUN_00115b78: 2º tiro 15 depois) */
  at?: number;
  /** desvio fixo em rad (param_3 de FUN_00147ec8) */
  pitch?: number;
  yaw?: number;
  /** sorteio uniforme do desvio em rad (FUN_00237cb0) */
  pitchRange?: [number, number];
  yawRange?: [number, number];
  count?: number;
  /** dano da instância (instância+0x1c), quando o especial sobrescreve o da tabela */
  damage?: number;
}

export type SpecialRule =
  /** Projéteis da tabela nativa. `detonate`: o 2º toque explode o projétil ainda vivo (FUN_002024a8). */
  | { kind: 'shots'; shots: SpecialShot[]; lockDeg: number; refire: number; detonate?: boolean; native: boolean }
  /** Axel (FUN_00116940): todos os carros no raio levam o dano e um impulso para cima de liftMph·massa. */
  | { kind: 'shockwave'; radius: number; damage: number; liftMph: number; refire: number }
  /** Cop Car (FUN_001b7c50 / FUN_001b83f0): choque no alvo mais perto em `range` por `ticks`, dano por tique. */
  | { kind: 'taser'; range: number; ticks: number; perTick: number; refire: number }
  /**
   * ⚠️ host (semântica aproximada, constantes da init nativa): golpe corpo a corpo por `ticks`, dano único por
   * carro tocado num raio além do carro e impulso (mph). `jump`: pulo com pouso em área (Grasshopper).
   */
  | { kind: 'melee'; ticks: number; reach: number; damage: number; pushMph: number; liftMph: number; refire: number; spin?: number; boostMph?: number; jumpMph?: number; landRadius?: number };

const D = Math.PI / 180;

/** Especial por modelo (id do veículo = carro+0x10 − 0x65). Ausente = o jogo não cria classe (hc_stock, hc_tank). */
export const SPECIALS: Record<string, SpecialRule> = {
  // Head-On
  axel: { kind: 'shockwave', radius: 100, damage: 15, liftMph: 80, refire: 48 }, // +0x68, +0x6c, +0x74, +0x5c
  hearse: { kind: 'shots', shots: [{ proj: 0x16 }], lockDeg: 0, refire: 48, detonate: true, native: true }, // FUN_00199350
  mrgrim: { kind: 'shots', shots: [{ proj: 0x1e, at: 12, damage: 25 }], lockDeg: 0, refire: 25, native: true }, // FUN_001b0298 (clipe 0x1b a 0,75)
  rkill: { kind: 'shots', shots: [{ proj: 0x17 }], lockDeg: 22.5, refire: 48, detonate: true, native: true }, // FUN_001c8070
  sweet: { kind: 'shots', shots: [{ proj: 0x1b, damage: 18 }], lockDeg: 30.5, refire: 48, native: true }, // FUN_001dc078 (+0x80)
  thump: { kind: 'shots', shots: [0, 30, 60, 90].map((at) => ({ proj: 0x20, at })), lockDeg: 22.5, refire: 48, native: true }, // FUN_001e1550
  spectre: { kind: 'shots', shots: [{ proj: 0x15, pitch: 0.0698 }], lockDeg: 22.5, refire: 48, native: true }, // FUN_001d62e8
  twist: { kind: 'melee', ticks: 150, reach: 6, damage: 13, pushMph: 50, liftMph: 20, refire: 48, spin: 0.6 }, // FUN_001e42d0
  mrslam: { kind: 'melee', ticks: 30, reach: 30, damage: 15, pushMph: 10, liftMph: 30, refire: 48 }, // FUN_001b1058
  cop: { kind: 'taser', range: 250, ticks: 240, perTick: 0.025, refire: 48 }, // FUN_001b7a58 (+0x7c, +0x6c·60, +0x74)
  crim: { kind: 'shots', shots: [{ proj: 0x19 }], lockDeg: 22.5, refire: 48, native: true }, // FUN_00169ea0
  hamr: { kind: 'melee', ticks: 30, reach: 6, damage: 15, pushMph: 175, liftMph: 30, refire: 48, boostMph: 60 }, // FUN_00196848
  grass: { kind: 'melee', ticks: 45, reach: 0, damage: 18, pushMph: 0, liftMph: 0, refire: 48, jumpMph: 61, landRadius: 61 }, // FUN_00192498
  wart: {
    kind: 'shots', lockDeg: 30, refire: 70, native: true, // FUN_001fcd00: 3 × 0x28 com ±5°
    shots: [{ proj: 0x28, pitch: 5 * D, yaw: -5 * D }, { proj: 0x28 }, { proj: 0x28, pitch: 5 * D, yaw: 5 * D }],
  },
  edatv: {
    kind: 'shots', lockDeg: 0, refire: 120, native: true, // FUN_00115b78: 2 rajadas de 10 chumbos (dano 1)
    shots: [0, 15].map((at) => ({ proj: 0x24, at, count: 10, damage: 1, pitchRange: [-1 * D, 3 * D] as [number, number], yawRange: [-4 * D, 4 * D] as [number, number] })),
  },
  // Harbor City: tipo de projétil nativo; cadência da init (+0x5c), padrão de tiro ⚠️ host (1 tiro)
  hc_axel: { kind: 'shots', shots: [{ proj: 0x2c }], lockDeg: 0, refire: 25, native: false }, // FUN_001b0b40
  hc_preac: { kind: 'shots', shots: [{ proj: 0x2e }], lockDeg: 22.5, refire: 48, native: false }, // FUN_001dbbc0
  hc_semi: { kind: 'shots', shots: [{ proj: 0x32 }], lockDeg: 0, refire: 90, native: false }, // FUN_001dd878
  hc_suv: { kind: 'shots', shots: [{ proj: 0x33 }], lockDeg: 0, refire: 48, detonate: true, native: false }, // FUN_001e3120
  hc_sweet: { kind: 'shots', shots: [{ proj: 0x34, pitch: 0.0698 }], lockDeg: 22.5, refire: 48, native: false }, // FUN_001d67f0
  hc_taxi: { kind: 'shots', shots: [{ proj: 0x35 }], lockDeg: 0, refire: 120, native: false }, // FUN_001c9a38
  hc_tow: { kind: 'shots', shots: [{ proj: 0x0b }], lockDeg: 22.5, refire: 48, native: false }, // FUN_001d88e8
};

/** Tiques para +1 carga (carro+0x62f0 em FUN_0011d340): 1800, com exceções por id de veículo. */
export const SPECIAL_RECHARGE: Record<string, number> = { edplayer: 0x870, hc_hears: 0x834, hc_grim: 0x834, hc_suv: 0x654, hc_taxi: 0x870 };
export const specialRecharge = (model: string) => SPECIAL_RECHARGE[model] ?? 0x708;
export const SPECIAL_MAX = 5;
