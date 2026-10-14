// Ataques de energia — regras PURAS. NATIVO (SCUS_976.21, docs/NATIVE.md "Ataques de energia"):
// inventário carro+0x51b4 criado em FUN_0011d340 (congelar 0x5860, mina 0x5740, onda 0x57c0), combos do controle
// (FUN_0012c9b8 → FUN_0012ce60/FUN_0012d6b0/FUN_0012cfa8/FUN_0012d1b8/FUN_0012d7c0/FUN_0012d910 ligam bits de
// controle+0x1c), energia em carro+0x6898 (0..1) gasta por FUN_0011bd48 e recarregada por tique em FUN_0011e3d0
// (tabela 0x2b3e30).

/** Direções do direcional (bitmask usada no histórico de combos). */
export const DIR = { up: 1, down: 2, left: 4, right: 8 } as const;

/**
 * Índices do registro do controle (FUN_00223908: `~(data[2]<<8 | data[3])` do libpad, FUN_00233a90) → direcional:
 * 0xd = 0x8000 Esquerda, 0xe = 0x2000 Direita, 0xf = 0x1000 Cima, 0x10 = 0x4000 Baixo. O analógico esquerdo também
 * preenche esses índices (eixo 2 → 0xd/0xe, eixo 3 → 0xf/0x10) quando o direcional está solto.
 */
export const PAD_INDEX = { 0xd: DIR.left, 0xe: DIR.right, 0xf: DIR.up, 0x10: DIR.down } as const;

/** Bits de controle+0x1c ligados pelos combos (e pela IA, que escreve direto em jogador+0x13c). */
export const BIT = { freeze: 0x1, mine: 0x2, shell: 0x4, rear: 0x10, blast: 0x20, boost: 0x40 } as const;

/** Tamanho do histórico do controle (anel de 0x5a registros de 0x18 bytes, FUN_00223c90 / FUN_00224088). */
export const HISTORY = 90;

export type EnergyKind = 'freeze' | 'mine' | 'blast' | 'shell';

export interface EnergyRule {
  /** energia exigida e gasta (DAT_002f28e4/e8/fc, gp−0x7d04) */
  cost: number;
  /** tiques até poder disparar outra arma (obj+0x74/+0x84) */
  refire: number;
}

export const ENERGY: Record<EnergyKind, EnergyRule> = {
  // FUN_0012ce60 (bit 0) → FUN_0014d588: projétil 0xe, trava 30° a 7000 pés (FUN_0014d478); energia > 0,4
  freeze: { cost: 0.4, refire: 48 },
  // FUN_0012cfa8 (bit 1) → FUN_0014c208: projétil 0xd solto atrás, só no chão; energia > 0,1
  mine: { cost: 0.1, refire: 48 },
  // FUN_0012d7c0 (bit 5) → FUN_0014c648 / FUN_0014ca00: onda em volta do carro; energia > 0,3
  blast: { cost: 0.3, refire: 120 },
  // FUN_0012d1b8 (bit 2, exige ≥ 0,6 e gasta na hora) → FUN_00123010: casca de fogo por 180 tiques (gp−0x7e28)
  shell: { cost: 0.6, refire: 0 },
};

/**
 * Míssil de energia (bit 0x40, FUN_0012d910 → FUN_00147ec8 / FUN_0014dd00): ao disparar uma arma do inventário
 * (menos especial, Remote e — fora da rajada — Swarmer) com energia > 0,3 (gp−0x7cf8), gasta 0,3 e solta um projétil
 * 0xf extra (FUN_00148300): trava 22,5° em 7000 pés; arfagem +5° (< 300 pés), +15° (< 600) ou +30°; se a arma já
 * tinha alvo, +15° a menos de √200 pés e +30° além.
 */
export const BOOST = { cost: 0.3, proj: 0xf, lockDeg: 22.5, range: 7000 } as const;

/** Recarga por tique (0x2b3e30[carro+0x14]: 0,000205 em todos os veículos jogáveis; ×1,15 com o bit 0x20 de +0x63f0). */
export const ENERGY_REGEN = 0.000205;
/** Onda (FUN_0014c4e8 / FUN_0014ca00): raio +0x78 (Dark2: 150, ×1,5 no teste), dano +0x7c, chute +0x80 mph. */
export const BLAST = { radius: 100, damage: 10, kickMph: 50, kickBelow: 7.3333335 } as const;
/**
 * Congelado (FUN_00120838 / FUN_00123410): 300 tiques (gp−0x7e2c). Só no jogador humano: com todos os 12 botões da
 * lista soltos (L1, L2, R1, R2, X, O, Δ, □ e o direcional — fora L3, R3, Start e Select) arma; o próximo aperto
 * de qualquer um tira 13 tiques.
 */
export const FREEZE = { ticks: 300, perPress: 13 } as const;
/** Casca de fogo (FUN_00123010): tiques ligada; impede pegar fogo (FUN_00120778). */
export const SHELL_TICKS = 180;

// ------------------------------------------------------------------ histórico e combos

/** Registro i quadros atrás (0 = o atual); além do que foi gravado conta como solto. */
const at = (h: readonly number[], i: number) => (i >= 0 && i < h.length && i < HISTORY ? h[h.length - 1 - i] : 0);

/** FUN_00223d58: 1º quadro em [de, até] (para trás no tempo) com a direção apertada; −1 se não houver. */
export function pressAt(h: readonly number[], bit: number, from: number, to: number): number {
  for (let i = from; i <= to; i++) if (at(h, i) & bit) return i;
  return -1;
}

/** FUN_00223e18: 1º quadro em [de, até] com a direção solta; −1 se não houver. */
export function releaseAt(h: readonly number[], bit: number, from: number, to: number): number {
  for (let i = from; i <= to; i++) if (!(at(h, i) & bit)) return i;
  return -1;
}

const edge = (h: readonly number[], bit: number) => (at(h, 0) & bit) !== 0 && (at(h, 1) & bit) === 0;
const { up: U, down: D, left: L, right: R } = DIR;

/** FUN_0012ce60 — Cima, Baixo, Cima (borda do último Cima); falha só se Esquerda e Direita apareceram no meio. */
function freezeCombo(h: readonly number[]): boolean {
  if (!edge(h, U)) return false;
  let i = pressAt(h, D, 0, 0xe);
  if (i < 0 || (i = releaseAt(h, D, i, i + 10)) < 0 || (i = pressAt(h, U, i, i + 0xe)) < 0) return false;
  return !(pressAt(h, L, 0, i) >= 0 && pressAt(h, R, 0, i) >= 0);
}

/**
 * FUN_0012d6b0 — Cima, Baixo, Baixo: sem borda, o bit 0x10 fica ligado enquanto o último Baixo começou há ≤ 20
 * quadros (segurar mais que isso desliga) e cada toque anterior coube em 20 quadros; Esquerda no meio cancela.
 * As armas o travam ao disparar (obj+0x44): é o "tiro para trás".
 */
function rearCombo(h: readonly number[]): boolean {
  let i = pressAt(h, D, 0, 0x14);
  if (i < 0 || (i = releaseAt(h, D, i, i + 0x14)) < 0 || (i = pressAt(h, D, i, i + 0x14)) < 0) return false;
  if ((i = releaseAt(h, D, i, i + 0x14)) < 0 || (i = pressAt(h, U, i, i + 0x14)) < 0) return false;
  if ((i = releaseAt(h, U, i, i + 0x14)) < 0) return false;
  return pressAt(h, L, 0, i) < 0;
}

/** FUN_0012cfa8 — Direita, Esquerda, Baixo (borda do Baixo), toques a ≤ 12 quadros, nada mais apertado no meio. */
function mineCombo(h: readonly number[]): boolean {
  if (!edge(h, D)) return false;
  const r = releaseAt(h, D, 0, 0xc);
  if (r < 0 || pressAt(h, R, 0, r) >= 0 || pressAt(h, U, 0, r) >= 0 || pressAt(h, L, 0, r) >= 0) return false;
  let p = pressAt(h, L, r, r + 0xc);
  if (p < 0 || (p = releaseAt(h, L, p, p + 0xc)) < 0) return false;
  if (pressAt(h, U, r, p) >= 0 || pressAt(h, D, r, p) >= 0 || pressAt(h, R, r, p) >= 0) return false;
  return pressAt(h, R, p, p + 0xc) >= 0;
}

/** FUN_0012d1b8 — Direita, Direita, Baixo, Baixo (borda do 2º Baixo), toques a ≤ 20 quadros. */
function shellCombo(h: readonly number[]): boolean {
  if (!edge(h, D)) return false;
  let i = releaseAt(h, D, 0, 0x14);
  if (i < 0 || (i = pressAt(h, D, i, i + 0x14)) < 0 || (i = releaseAt(h, D, i, i + 0x14)) < 0) return false;
  if (pressAt(h, R, 0, i) >= 0 || pressAt(h, U, 0, i) >= 0 || pressAt(h, L, 0, i) >= 0) return false;
  if ((i = pressAt(h, R, i, i + 0x14)) < 0 || (i = releaseAt(h, R, i, i + 0x14)) < 0 || (i = pressAt(h, R, i, i + 0x14)) < 0) return false;
  return pressAt(h, L, 0, i) < 0 || pressAt(h, U, 0, i) < 0;
}

/** FUN_0012d7c0 — Cima, Baixo, Esquerda, Direita (borda da Direita), toques a ≤ 20 quadros, sem Cima no meio. */
function blastCombo(h: readonly number[]): boolean {
  if (!edge(h, R)) return false;
  let i = pressAt(h, L, 0, 0x14);
  if (i < 0 || (i = releaseAt(h, L, i, i + 0x14)) < 0 || (i = pressAt(h, D, i, i + 0x14)) < 0) return false;
  if (pressAt(h, U, 0, i) >= 0) return false;
  return pressAt(h, U, i, i + 0x14) >= 0;
}

/**
 * FUN_0012d910 (só Head-On) — Direita, Esquerda, Cima, Cima: o último Cima a ≤ 30 quadros, sem Baixo nos últimos
 * 60. Liga o bit 0x40 (míssil de energia no próximo disparo).
 */
function boostCombo(h: readonly number[]): boolean {
  let i = pressAt(h, U, 0, 0x1e);
  if (i < 0) return false;
  if ((i = releaseAt(h, U, i + 1, i + 0x15)) < 0 || (i = pressAt(h, U, i, i + 0x14)) < 0) return false;
  if ((i = pressAt(h, L, i, i + 0x14)) < 0 || pressAt(h, R, i, i + 0x14) < 0) return false;
  return pressAt(h, D, 0, 0x3c) < 0;
}

/** Bits de controle+0x1c deste quadro (FUN_0012c9b8, Head-On). */
export function comboBits(h: readonly number[]): number {
  let bits = 0;
  if (freezeCombo(h)) bits |= BIT.freeze;
  if (rearCombo(h)) bits |= BIT.rear;
  if (mineCombo(h)) bits |= BIT.mine;
  if (shellCombo(h)) bits |= BIT.shell;
  if (blastCombo(h)) bits |= BIT.blast;
  if (boostCombo(h)) bits |= BIT.boost;
  return bits;
}
