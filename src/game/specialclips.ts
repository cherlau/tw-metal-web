/**
 * Clipes do carro tocados ao selecionar/desselecionar a arma especial. A troca de arma (FUN_0014a4e0) chama o
 * método +0x1c da arma que sai; a seleção, o +0x14 da que entra (que leva a classe ao estado 0). Os dois tocam
 * clipes do próprio carro pela API 0x127608..0x127ed8 — ex.: cabeça do Sweet Tooth (0x1a), arma no teto do
 * Crimson Fury (0x1a). Vtables das classes em FUN_0011d340 (construtores); ver docs/NATIVE.md.
 */

/**
 * Operações da API de clipes (velocidade em múltiplos de 60 quadros/s; k = 2 nos veículos < 0x76, 1 nos HC):
 * - play    FUN_00127778: volta a 0 e toca a +k
 * - resume  FUN_00127be8: toca a +1 de onde está
 * - reverse FUN_00127980: toca a −k de onde está
 * - rewind  FUN_00127d58: toca a −2 de onde está
 * - reset   FUN_00127ed8: volta a 0 e para
 * - finish  FUN_00127d08: clipe em laço termina a volta atual e para (flag 0x40)
 */
export type ClipOp = 'play' | 'resume' | 'reverse' | 'rewind' | 'reset' | 'finish';

/**
 * Deixas do disparo: 'fire' (aperto, ou início de uma ação que dura; também 'start:<tipo>' com o tipo da ação), 'alt'
 * (disparo alternativo), 'shotN' (N-ésimo tiro
 * agendado), 'phaseN' (a ação mudou para a fase N), 'end' (a ação acabou), 'abort' (acabou ainda na fase 1).
 */
export type ClipCue = string;

export interface SpecialClipRule {
  select: [ClipOp, number][];
  deselect: [ClipOp, number][];
  /** o estado 0 só toca com munição (FUN_001485d8 > 0) */
  ammo: boolean;
  /** clipes tocados pelo disparo (vtable +0x44 e a função de estado da classe) */
  cues?: Record<ClipCue, [ClipOp, number][]>;
  /** pronta de novo (a classe volta ao estado 0 depois da espera, com munição e o botão solto) */
  ready?: [ClipOp, number][];
}

const OPEN_1A: SpecialClipRule = { select: [['resume', 0x1a]], deselect: [['rewind', 0x1a]], ammo: true };
const CANNON: SpecialClipRule = {
  select: [], deselect: [['reverse', 0x1a], ['finish', 0x1b]], ammo: true,
  cues: { fire: [['play', 0x1a]], phase2: [['play', 0x1b]], end: [['finish', 0x1b]], abort: [['reverse', 0x1a]] },
};
const HC_1A: SpecialClipRule = { select: [['play', 0x1a]], deselect: [['reverse', 0x1a]], ammo: true, ready: [['play', 0x1a]] };

/** Por modelo (vtable +0x14 → estado 0 / vtable +0x1c). Ausentes: a classe não toca clipe na troca. */
export const SPECIAL_CLIPS: Record<string, SpecialClipRule> = {
  // FUN_001172e8 / FUN_00116560 (Axel) e FUN_00117df8 / FUN_00117458 (Cousin Eddy)
  // FUN_001165a8 estado 2: onda zera e retoma 0x1a, toca 0x1c do início (carregada: 0x1d e, acima de 0,25, 0x1e)
  axel: {
    select: [['resume', 0x1b], ['resume', 0x1f]], deselect: [['rewind', 0x1b]], ammo: true,
    cues: { fire: [['reset', 0x1a], ['resume', 0x1a], ['reset', 0x1c], ['play', 0x1c]] },
  },
  // FUN_00199878 / FUN_00199230
  hearse: { select: [['resume', 0x1a], ['resume', 0x1b]], deselect: [['rewind', 0x1a]], ammo: true },
  rkill: OPEN_1A, // FUN_001c8610 / FUN_001c8020
  spectre: OPEN_1A, // FUN_001d6270 / FUN_001d5d50
  twist: OPEN_1A, // FUN_001e5fb8 / FUN_001e44a0
  crim: OPEN_1A, // FUN_0016a018 / FUN_00169938
  wart: OPEN_1A, // FUN_001fd278 / FUN_001fccb8
  // FUN_001dbf38 / FUN_001dbfc0: cabeça sobe do início
  // FUN_001dc078 estado 2: cada tiro zera e toca 0x1b (o modelo do Sweet não tem esse clipe)
  sweet: { select: [['play', 0x1a]], deselect: [['reverse', 0x1a]], ammo: true, cues: { fire: [['reset', 0x1b], ['play', 0x1b]] } },
  // FUN_001b0298 → FUN_001b07f0 estado 1: zera e toca 0x1b (0x1e na carregada); o tiro sai com ele em 0,75
  mrgrim: { select: [], deselect: [], ammo: true, cues: { fire: [['reset', 0x1b], ['play', 0x1b]] } },
  // FUN_00115b78: estado 1 toca 0x1c na 1ª rajada e 0x1d na 2ª (o modelo do ATV não os tem); estado 2 (bots) toca
  // 0x1b (FUN_00116358, vel. 2 por FUN_00127b68) e atira com ele > 0,4
  edatv: {
    select: [], deselect: [], ammo: true,
    cues: { fire: [['reset', 0x1c], ['play', 0x1c]], shot1: [['reset', 0x1d], ['play', 0x1d]], alt: [['reset', 0x1b], ['play', 0x1b]] },
  },
  // FUN_001e1c48 / FUN_001e1450: sem teste de munição
  thump: { select: [['resume', 0x1a]], deselect: [['rewind', 0x1a]], ammo: false },
  // FUN_001b1168 → FUN_001b3278 / FUN_001b11e0: garra (0x1c fecha ao contrário, 0x1a abre)
  // agarrar (FUN_001b3278 estados 4/5): zera 0x1a/0x1b e toca 0x1b; pronta de novo (7 → 0): toca 0x1a e inverte 0x1c
  mrslam: {
    select: [['reverse', 0x1c], ['play', 0x1a]], deselect: [['reverse', 0x1a], ['play', 0x1c]], ammo: false,
    cues: { fire: [['reset', 0x1a], ['reset', 0x1b], ['play', 0x1b]] }, ready: [['play', 0x1a], ['reverse', 0x1c]],
  },
  // FUN_001b7b18 / FUN_001b7b80
  // choque (FUN_001b8318): estado 1 retoma 0x1b (laço), estado 2 o deixa terminar a volta
  cop: {
    select: [['reset', 0x1a], ['resume', 0x1a]], deselect: [['rewind', 0x1a], ['finish', 0x1b]], ammo: false,
    cues: { fire: [['resume', 0x1b]], end: [['finish', 0x1b]] },
  },
  // FUN_00197da0 (sem munição só fecha) / FUN_001969b0
  // pisão com alvo (FUN_00196b60 → estado 1): toca 0x1b (chama e giro da turbina); estado 4 termina e zera 0x1b
  hamr: {
    select: [['reset', 0x1b], ['resume', 0x1a]], deselect: [['reset', 0x1b], ['rewind', 0x1a]], ammo: true,
    cues: { fire: [['play', 0x1b]], end: [['finish', 0x1b], ['reset', 0x1b]] },
  },
  // Cousin Eddy jogável (FUN_001174a0 estado 1): a onda zera/retoma 0x1a e zera/toca 0x1c, como o Axel
  edplayer: {
    select: [['resume', 0x1b], ['resume', 0x1f]], deselect: [['reverse', 0x1b]], ammo: true,
    cues: { fire: [['reset', 0x1a], ['resume', 0x1a], ['reset', 0x1c], ['play', 0x1c]] },
  },
  // Dark Tooth jogável (FUN_00170360 estado 0): se 0x1a ainda não chegou ao fim, toca do início; com ele completo
  // saem as faíscas (FUN_001704a0); recolher (FUN_0016fdc0) volta 0x1a
  darkpla1: { select: [['play', 0x1a]], deselect: [['rewind', 0x1a]], ammo: false },
  // Harbor City
  // FUN_001b0e90 estado 1: zera e toca 0x1b (0x1e na carregada). ⚠️ o hc_axel só tem 0x1e: o host toca 0x1e
  hc_axel: { ...HC_1A, cues: { fire: [['reset', 0x1e], ['play', 0x1e]] } },
  // FUN_001c93c8: estado 3 (depois da salva) inverte 0x1a; estado 0 o toca de novo
  hc_hears: { ...HC_1A, cues: { end: [['reverse', 0x1a]] } },
  hc_sweet: HC_1A, // FUN_001d6770 / FUN_001d6460
  // FUN_001dd7e8: estado 1 (anel) zera 0x1a; estado 0 o toca de novo
  hc_semi: { ...HC_1A, cues: { fire: [['reset', 0x1a]] } },
  // FUN_001db498 / FUN_001db0c8
  // FUN_001db178: congela 0x1b, zera e toca 0x1c; estado 2 toca 0x1b, estado 3 zera 0x1b
  hc_preac: {
    select: [['play', 0x1a]], deselect: [['reset', 0x1b], ['reset', 0x1c], ['reverse', 0x1a]], ammo: false, ready: [['play', 0x1a]],
    cues: { fire: [['reset', 0x1c], ['play', 0x1c], ['play', 0x1b]], end: [['reset', 0x1b]] },
  },
  // FUN_001c9918 / FUN_001c9700
  // FUN_001c9918: estado 1 (disparo) toca 0x1c, estado 2 toca 0x1b; estado 0 zera e toca 0x1a
  hc_taxi: {
    select: [['reset', 0x1a], ['reset', 0x1b], ['reset', 0x1c], ['play', 0x1a]], deselect: [['reverse', 0x1a]], ammo: true,
    cues: { fire: [['play', 0x1c], ['play', 0x1b]] }, ready: [['reset', 0x1a], ['reset', 0x1b], ['reset', 0x1c], ['play', 0x1a]],
  },
  // FUN_001e39b0 estado 1 (disparo): zera e toca 0x1a
  hc_suv: { select: [], deselect: [], ammo: true, cues: { fire: [['reset', 0x1a], ['play', 0x1a]] } },
  // canhão (FUN_001dcc6c / FUN_001dce7c / FUN_001dd3c0): erguer toca 0x1a; atirando toca 0x1b; fim termina 0x1b;
  // soltar antes de erguer abaixa (FUN_00127980)
  hc_rkill: CANNON,
  hc_rock: CANNON,
  hc_vette: { select: [['resume', 0x1a]], deselect: [['rewind', 0x1a]], ammo: false }, // FUN_001e11a8 / FUN_001e0b58
};

export interface ClipPlayback {
  t: number;
  /** múltiplos de 60 quadros/s (negativo = ao contrário) */
  speed: number;
  /** laço: para ao completar a volta (FUN_00127d08) */
  finish?: boolean;
}

/** Aplica as operações; devolve 'deploy'/'retract' se alguma tocou som (FUN_001451a0 / FUN_001452d8). */
export function applyClipOps(play: Map<number, ClipPlayback>, ops: [ClipOp, number][], k: number, has: (cat: number) => boolean): 'deploy' | 'retract' | null {
  let sound: 'deploy' | 'retract' | null = null;
  for (const [op, cat] of ops) {
    if (!has(cat)) continue;
    const p = play.get(cat) ?? { t: 0, speed: 0 };
    if (op === 'reset') {
      p.t = 0;
      p.speed = 0;
      p.finish = false;
    } else if (op === 'finish') {
      p.finish = true;
    } else {
      p.finish = false;
      if (op === 'play') p.t = 0;
      p.speed = op === 'play' ? k : op === 'resume' ? 1 : op === 'reverse' ? -k : -2;
      // 0x1b toca o som próprio do disparo (FUN_00145418); 0x0f nenhum.
      if (cat !== 0x1b && cat !== 0x0f) sound = p.speed > 0 ? 'deploy' : 'retract';
    }
    play.set(cat, p);
  }
  return sound;
}

/** Avança os clipes `dt` segundos; `len(cat)` = duração em quadros. Para nas pontas [0, 1]; em laço dá a volta. */
export function stepClips(play: Map<number, ClipPlayback>, dt: number, len: (cat: number) => number, loop: (cat: number) => boolean): void {
  for (const [cat, p] of play) {
    if (!p.speed) continue;
    const t = p.t + (p.speed * 60 * dt) / Math.max(len(cat), 1);
    if (loop(cat) && !p.finish && (t > 1 || t < 0)) {
      p.t = t - Math.floor(t);
      continue;
    }
    p.t = Math.max(0, Math.min(1, t));
    if (p.t === 0 || p.t === 1) {
      p.speed = 0;
      p.finish = false;
    }
  }
}
