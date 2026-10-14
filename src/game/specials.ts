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
  /** ponto de saída no espaço do carro, PS2 (x direita, y frente, z cima); padrão: o ponto do host */
  offset?: [number, number, number];
  /** tipo sorteado entre estes (FUN_001c9a38: 0x35 + U{0..2}) */
  projChoice?: number[];
}

export type SpecialRule =
  /**
   * Projéteis da tabela nativa. `detonate`: o 2º toque explode o projétil ainda vivo (FUN_002024a8). `rear`: a
   * classe trava o bit 0x10 do controle no disparo (obj+0x44 → tiro para trás: ATV FUN_00116358, Thumper
   * FUN_001e1c48, Spectre FUN_001d62e8, HC Sweet FUN_001d67f0, Taxi FUN_001c9730).
   */
  | {
      kind: 'shots'; shots: SpecialShot[]; lockDeg: number; refire: number; detonate?: boolean; native: boolean; rear?: boolean;
      /** disparo alternativo dos bots: chance por aperto, tiros, cone/alcance da trava e espera própria */
      alt?: { chance: number; shots: SpecialShot[]; lockDeg: number; range: number; refire?: number };
    }
  /** Axel (FUN_00116940): todos os carros no raio levam o dano e um impulso para cima de liftMph·massa. */
  | { kind: 'shockwave'; radius: number; damage: number; liftMph: number; refire: number }
  /** Cop Car (FUN_001b7c50 / FUN_001b83f0): choque no alvo mais perto em `range` por `ticks`, dano por tique. */
  | { kind: 'taser'; range: number; ticks: number; perTick: number; refire: number }
  /**
   * Twister (FUN_001e4670, init FUN_001e42d0): tornado. Preparo `prep` tiques (inclina até `tilt` rad, sobe `lift`
   * pés, giro rumo a `spinRate` rad/tique), giro `spin` tiques capturando carros a ≤ `radius` pés (FUN_001e4d30 →
   * FUN_001e5198: dano `captureDamage`, impulso de 65 mph para cima), recuperação `recover` tiques. Presos orbitam
   * (FUN_001e54b0) a `orbitRadius` pés e `orbitHeight` acima, `orbitRate` rad/tique, levando `holdDamage` por tique
   * até `holdTicks`; soltos (fim do giro ou do tempo) saem a `throwMph`·massa, `throwPitch` rad acima; batendo em
   * parede presos: `wallDamage`. Cada vaga só recaptura `recapture` tiques depois.
   */
  | {
      kind: 'tornado'; prep: number; spin: number; recover: number; spinRate: number; tilt: number; lift: number; radius: number;
      captureDamage: number; captureLiftMph: number; holdDamage: number; orbitRadius: number; orbitHeight: number; orbitRate: number;
      holdTicks: number; throwMph: number; throwPitch: number; wallDamage: number; recapture: number; refire: number;
    }
  /**
   * Mr. Slam (FUN_001b1330, init FUN_001b1058): garra. Agarra o carro mais perto a ≤ `grabRadius` pés do ponto
   * `reach` (local: frente, cima) que esteja num cone de `lockDeg` em `lockRange` pés com visada (FUN_001b2c48):
   * dano `grabDamage`. Segura no ponto (de cabeça para baixo) enquanto o clipe 0x1b toca; em cada fase de `phases`
   * bate (`slamDamage`, FUN_001b1fc0). No fim do clipe arremessa a `throwMph`·massa, `throwPitchDeg` acima.
   */
  /**
   * Dark Tooth jogável (FUN_0016fe00, init FUN_0016fc40): raio elétrico por `ticks`. Trava o alvo num cone de
   * `lockDeg` a < `range` pés (FUN_00170688 → FUN_00170c30; golpe tipo 1 de `hitDamage`, FUN_00170d30); enquanto o
   * botão fica segurado, golpe de `perTick` por tique no alvo; longe demais solta e procura de novo (FUN_00170a30).
   */
  | { kind: 'arc'; ticks: number; lockDeg: number; range: number; hitDamage: number; perTick: number; refire: number }
  | {
      kind: 'crane'; reach: [number, number]; grabRadius: number; lockDeg: number; lockRange: number; grabDamage: number;
      slamDamage: number; phases: number[]; clipTicks: number; throwMph: number; throwPitchDeg: number; refire: number;
    }
  /**
   * Hammerhead (FUN_00196b60, init FUN_00196848): pula sobre o carro mais perto no chão a ≤ `seek` pés com visada
   * (FUN_001977b8). Sem alvo: só um pulo de `missHopMph`. Com alvo: pulo de `hopMph`, `wait` tiques, cai em cima
   * (FUN_00197da0 estado 2: dano `damage`) e fica `ride` tiques esmagando (posição rumo ao alvo + `rideHeight`,
   * alvo parado no plano); sai com um pulo de `hopMph`.
   */
  | { kind: 'stomp'; seek: number; hopMph: number; missHopMph: number; wait: number; ride: number; rideHeight: number; damage: number; refire: number }
  /**
   * Grasshopper (FUN_001927a8, init FUN_00192498): trava num cone de `lockDeg` em `range` pés, salta a `jumpMph`
   * para cima por `climb` tiques; com alvo mergulha nele (posição rumo ao alvo com fração crescendo até 0,5) e, a
   * menos de 5 pés, acerta (FUN_00193198: dano `damage`, alvo sobe a `hitLiftMph`); desiste em `timeout` tiques.
   */
  /** Rajada carregada (HC Hearse): segurar soma 1 projétil a cada `per` tiques até `max`; soltar dispara todos. */
  | { kind: 'volley'; proj: number; per: number; max: number; giveUp: number; lockDeg: number; pitchDeg: [number, number]; yawDeg: [number, number]; refire: number }
  /** Arrancada (HC Mr. Grimm): por `ticks` tiques, no chão, a velocidade vai a `mph` pela frente com fração `rate`. */
  | { kind: 'boost'; ticks: number; mph: number; rate: number; refire: number }
  | { kind: 'leap'; lockDeg: number; range: number; jumpMph: number; climb: number; damage: number; hitLiftMph: number; timeout: number; refire: number }
  /**
   * Derby (FUN_001c2cf0 → FUN_00196608/FUN_00195548, objeto 0x3573f0 + i·0xe0, FUN_00195638): objeto lançado a
   * `mph` (+0x68) que persegue o alvo travado (22,5° em 7000); vive `life` tiques (0xf0); ao alcançá-lo prende e,
   * no fim do clipe (⚠️ `latch` tiques), dá `damage` (+0x6c); alvo com casca de fogo desvia (estado 4, 45 tiques);
   * batendo noutro carro no caminho dá o dano; no cenário acaba. Sem alvo voa reto caindo.
   */
  | { kind: 'derby'; mph: number; life: number; damage: number; lockDeg: number; latch: number; refire: number }
  /**
   * Canhão (classe 0x2d9610 dos veículos 0x7f e 0x86, FUN_001dcbd8: estados na tabela 0x2eb540): segurar ergue o
   * canhão (clipe 0x1a até 0,95; ⚠️ `raise` tiques); depois `shots` (+0x6c = 10) tiros `proj` a cada `every` (0x13)
   * tiques, trava cos(0,533 rad) em 7000 pés (FUN_001dce7c).
   */
  | { kind: 'cannon'; raise: number; shots: number; every: number; proj: number; lockDeg: number; refire: number }
  /**
   * Raio (veículo 0x85, FUN_001e0c58, init FUN_001e0a68): por `ticks` (+0x64 = 225) tiques varre `range` (+0x74 =
   * 200) pés à frente (FUN_001e0ee0) e o carro atingido leva `perTick` (+0x70 = 0,11) como golpe tipo 0x29 (acende
   * fogo); emissor 0x1e vermelho na saída.
   */
  | { kind: 'beam'; ticks: number; range: number; perTick: number; refire: number }
  /** Preacher (FUN_001db178): `ticks` tiques soltando `proj` a cada `every` e `pressProj` a cada novo toque. */
  | { kind: 'preach'; ticks: number; every: number; proj: number; pressProj: number; refire: number }
  /**
   * Tow (FUN_001d8160 / FUN_001d88e8): 1º toque abre `ticks` (600) tiques de trava (cone `lockDeg`, `range`;
   * FUN_001d7fd8(60, 1000)) que somam tiques travados; 2º toque dispara n = carga/60 + 1 tiros `proj` (0xb) com
   * rumo alternado ±7°·i.
   */
  | { kind: 'tractor'; ticks: number; lockDeg: number; range: number; proj: number; per: number; stepDeg: number; refire: number };

const D = Math.PI / 180;

/** Especial por modelo (id do veículo = carro+0x10 − 0x65). Ausente = o jogo não cria classe (hc_stock, hc_tank). */
export const SPECIALS: Record<string, SpecialRule> = {
  // Head-On
  axel: { kind: 'shockwave', radius: 100, damage: 15, liftMph: 80, refire: 48 }, // +0x68, +0x6c, +0x74, +0x5c
  hearse: { kind: 'shots', shots: [{ proj: 0x16 }], lockDeg: 0, refire: 48, detonate: true, native: true }, // FUN_00199350
  mrgrim: { kind: 'shots', shots: [{ proj: 0x1e, at: 12, damage: 25 }], lockDeg: 0, refire: 25, native: true }, // FUN_001b0298 (clipe 0x1b a 0,75)
  rkill: { kind: 'shots', shots: [{ proj: 0x17 }], lockDeg: 22.5, refire: 48, detonate: true, native: true }, // FUN_001c8070
  sweet: { kind: 'shots', shots: [{ proj: 0x1b, damage: 18 }], lockDeg: 30.5, refire: 48, native: true }, // FUN_001dc078 (+0x80)
  thump: { kind: 'shots', shots: [0, 30, 60, 90].map((at) => ({ proj: 0x20, at })), lockDeg: 22.5, refire: 48, native: true, rear: true }, // FUN_001e1550
  spectre: { kind: 'shots', shots: [{ proj: 0x15, pitch: 0.0698 }], lockDeg: 22.5, refire: 48, native: true, rear: true }, // FUN_001d62e8
  twist: {
    kind: 'tornado', prep: 25, spin: 150, recover: 45, spinRate: -0.6, tilt: -1.3089969, lift: 9, radius: 50, // +0x64 +0x6c +0x74 +0x7c, 0x41100000, +0xa0
    captureDamage: 13, captureLiftMph: 65, holdDamage: 0.035, orbitRadius: 20, orbitHeight: 35, orbitRate: 0.15, // +0x80, 0x42beaaab, +0x84, +0xa4, +0xf4
    holdTicks: 180, throwMph: 80, throwPitch: 0.349, wallDamage: 5, recapture: 300, refire: 48, // +0xf0, 117,33·massa, 0x3eb2b8c2, +0xcc, +0x5c
  },
  mrslam: {
    kind: 'crane', reach: [12, 13], grabRadius: 30, lockDeg: 90, lockRange: 50, grabDamage: 10, slamDamage: 3, // FUN_001b2c48, +0xd0, +0x70, +0x74
    phases: [0.08, 0.31, 0.5, 0.7, 0.93], clipTicks: 60, throwMph: 200, throwPitchDeg: 15, refire: 48, // FUN_001b1fc0 (clipe 0x1b: 120 quadros a vel. 2, FUN_00127778), +0xe4, +0xe0
  },
  cop: { kind: 'taser', range: 250, ticks: 240, perTick: 0.025, refire: 48 }, // FUN_001b7a58 (+0x7c, +0x6c·60, +0x74)
  crim: { kind: 'shots', shots: [{ proj: 0x19 }], lockDeg: 22.5, refire: 48, native: true }, // FUN_00169ea0
  hamr: { kind: 'stomp', seek: 175, hopMph: 60, missHopMph: 40, wait: 31, ride: 30, rideHeight: 10, damage: 15, refire: 48 }, // +0x84, 88 e 58,67 pés/s, 0x1f, +0x74, +0x78
  grass: { kind: 'leap', lockDeg: 22.5, range: 230, jumpMph: 61, climb: 45, damage: 18, hitLiftMph: 120, timeout: 300, refire: 48 }, // +0x74 +0x6c +0x68 +0x70, 176 pés/s
  wart: {
    kind: 'shots', lockDeg: 30, refire: 70, native: true, // FUN_001fcd00: 3 × 0x28 com ±5°
    shots: [{ proj: 0x28, pitch: 5 * D, yaw: -5 * D }, { proj: 0x28 }, { proj: 0x28, pitch: 5 * D, yaw: 5 * D }],
  },
  edatv: {
    kind: 'shots', lockDeg: 0, refire: 120, native: true, rear: true, // FUN_00115b78: 2 rajadas de 10 chumbos (dano 1)
    shots: [0, 15].map((at) => ({ proj: 0x24, at, count: 10, damage: 1, pitchRange: [-1 * D, 3 * D] as [number, number], yawRange: [-4 * D, 4 * D] as [number, number] })),
    // estado 2 (bots, 1 em 3): clipe 0x1b a vel. 2 (60 quadros → 30 tiques); com ele > 0,4 sai 0x23 travado a 15° em
    // 4000 pés (0x3e860a92, 0x4b742400); espera o fim do clipe. ⚠️ o fator por distância em +0x58 do projétil não é lido
    alt: { chance: 1 / 3, shots: [{ proj: 0x23, at: 12 }], lockDeg: 15, range: 4000 },
  },
  // Harbor City (disparo = vtable+0x44 da classe criada em FUN_0011d340; ver docs/NATIVE.md "Especiais do Harbor City")
  // FUN_001b0b40: 0x2c quando o clipe 0x1b passa de 0,26 (⚠️ o hc_axel só traz o clipe 0x1e: 50 quadros a vel. 2 → 7 tiques)
  hc_axel: { kind: 'shots', shots: [{ proj: 0x2c, at: 7 }], lockDeg: 0, refire: 25, native: true },
  // FUN_001c8ee8 / FUN_001c9450: segurar carrega 1 + tiques/32 (máx. 6, desiste após 160 + 180); soltar dispara
  hc_hears: { kind: 'volley', proj: 0x2d, per: 32, max: 6, giveUp: 340, lockDeg: 30.5, pitchDeg: [2.5, 15], yawDeg: [-10, 10], refire: 48 },
  // FUN_001d06a8 (init FUN_001d05c8): 120 tiques no chão rumo a 250 mph pela frente (fração +0x7c = 0,25)
  hc_grim: { kind: 'boost', ticks: 120, mph: 250, rate: 0.25, refire: 48 },
  // FUN_001db178: 300 tiques soltando 0x2f a cada 15 (FUN_001dbbc0) e 0x2e a cada novo toque
  hc_preac: { kind: 'preach', ticks: 300, every: 15, proj: 0x2f, pressProj: 0x2e, refire: 90 },
  // FUN_001dd5e8 → FUN_001dd878: anel de 8 × 0x32 dos pontos 0x2eb5a0 com rumos 0x2eb620 (−45…180°); também
  // dispara sozinho ao bater num carro acima de 4 pés/s (+0x902 = id do carro, Match.collideCars)
  hc_semi: {
    kind: 'shots', lockDeg: 0, refire: 90, native: true,
    shots: ([
      [-3.533, 7.772, -0.824, -45], [0, 8.529, -0.824, 0], [3.463, 7.737, -0.824, 45], [3.962, 0, -0.706, 90],
      [3.392, -7.84, -0.706, 135], [0.003, -8.583, -0.706, 180], [-3.424, -7.839, -0.605, -135], [-4.001, -0.001, -0.706, -90],
    ] as const).map(([x, y, z, deg]) => ({ proj: 0x32, offset: [x, y, z] as [number, number, number], yaw: -deg * D })),
  },
  // classe do Derby (0x7b)
  hc_derby: { kind: 'derby', mph: 250, life: 0xf0, damage: 20, lockDeg: 22.5, latch: 60, refire: 48 },
  // canhão: Roadkill HC (0x7f) atira 0x30, Manslaughter (0x86) 0x31
  hc_rkill: { kind: 'cannon', raise: 30, shots: 10, every: 0x13, proj: 0x30, lockDeg: 30.56, refire: 48 },
  hc_rock: { kind: 'cannon', raise: 30, shots: 10, every: 0x13, proj: 0x31, lockDeg: 30.56, refire: 48 },
  // raio do Spectre HC (0x85)
  hc_vette: { kind: 'beam', ticks: 0xe1, range: 200, perTick: 0.11, refire: 48 },
  // FUN_001e3120: 0x33 quando o clipe 0x1a passa de 0,1; o 2º toque derruba (FUN_002009d0, como o Napalm)
  hc_suv: { kind: 'shots', shots: [{ proj: 0x33 }], lockDeg: 0, refire: 48, detonate: true, native: true },
  // FUN_001d64a8 → FUN_001d67f0: 0x34 com +4° (0x3d8efa35), trava o tiro para trás
  hc_sweet: { kind: 'shots', shots: [{ proj: 0x34, pitch: 0.0698 }], lockDeg: 22.5, refire: 48, native: true, rear: true },
  // FUN_001c9730 → FUN_001c9a38: 10 × (0x35 + U{0..2}) do teto (0x2c3e90) com rumos 0x2c3fd0; de ré, de 0x2c3f30
  hc_taxi: {
    kind: 'shots', lockDeg: 0, refire: 120, native: true, rear: true,
    shots: ([
      [-0.294, 1.471, 21.911, -1], [3.872, 2.052, 20.636, 3.2], [1.326, 2.478, 20.504, 2], [-2.186, 2.385, 19.426, -2],
      [-3.808, 3.183, 16.529, -4.5], [1.359, 3.655, 15.537, 1.2], [-0.517, 3.832, 13.568, -1.2], [-2.819, 4.835, 12.864, -3.2],
      [3.584, 4.747, 12.276, 4.5], [0.123, 4.958, 9.332, 1],
    ] as const).map(([x, y, z, deg]) => ({ proj: 0x35, projChoice: [0x35, 0x36, 0x37], offset: [x, y, z] as [number, number, number], yaw: -deg * D })),
  },
  // FUN_001d8160 → FUN_001d88e8
  hc_tow: { kind: 'tractor', ticks: 600, lockDeg: 60, range: 1000, proj: 0x0b, per: 60, stepDeg: 7, refire: 48 },
  // Cousin Eddy jogável (FUN_001174a0 → FUN_001176b8, init FUN_001173a8): a onda do Axel com +0x60 = 100 pés,
  // +0x64 = 23 de dano e +0x68 = 80 mph
  edplayer: { kind: 'shockwave', radius: 100, damage: 23, liftMph: 80, refire: 0x30 },
  // Dark Tooth jogável (FUN_0016fc40): +0x68 = 5 s, +0x84 = cos 45°, +0x78 = 300 pés, +0x7c = 5, +0x80 = 1 por tique
  darkpla1: { kind: 'arc', ticks: 300, lockDeg: 45, range: 300, hitDamage: 5, perTick: 1, refire: 0x30 },
};

/** Tiques para +1 carga (carro+0x62f0 em FUN_0011d340): 1800, com exceções por id de veículo. */
export const SPECIAL_RECHARGE: Record<string, number> = { edplayer: 0x870, hc_hears: 0x834, hc_grim: 0x834, hc_suv: 0x654, hc_taxi: 0x870 };
export const specialRecharge = (model: string) => SPECIAL_RECHARGE[model] ?? 0x708;
export const SPECIAL_MAX = 5;
