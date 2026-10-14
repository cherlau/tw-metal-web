// Ataque de ambiente (arma tipo 8, pickup 9 "Environment Attack") — evento próprio de cada fase.
// FUN_0014d040 (disparo da classe de inventário 0x2d67c8) escolhe pela fase DAT_002f4900 = índice do nome da fase na
// tabela 0x2c37d0 (FUN_00100b08). Só as fases com objeto próprio têm ataque; as outras respondem
// "Env Weapon Unavailable" (mensagem 0x50) sem gastar munição. Das arenas do port, só a ARENA (0x10) tem.
import { v3, type V3 } from '../physics/vec';

/** Tabela 0x2c37d0: nome da fase → índice (DAT_002f4900). */
export const LEVEL_NAMES = [
  'COLISEUM', 'EGYPT', 'FWAY', 'PARIS', 'RUSSIA', 'GREECE', 'MONACO', 'CASTLE', 'FWAYBOSS', 'TOKYO', 'ROOFTOPS', 'EGYPTDM',
  'PARISDM', 'COLISDM', 'GREECEDM', 'TOKYODM', 'ARENA', 'TOKYOB', 'CASTLEDM', 'HC_SC', 'HC_SU', 'HC_GD', 'HC_ND', 'HC_ST',
  'ASYLUM', 'IMPOUND',
] as const;

export const levelIndex = (name: string) => LEVEL_NAMES.indexOf(name.toUpperCase() as (typeof LEVEL_NAMES)[number]);

/** Mensagens da tabela 0x2ba4c0 usadas pelo disparo. */
export const ENV_MESSAGES = { active: 'Env Weapon Already Active', unavailable: 'Env Weapon Unavailable' } as const;

/** PS2 (Z para cima) → mundo da partida (Y para cima), a mesma rotação de PS2_TO_THREE. */
const P = (x: number, y: number, z: number): V3 => v3(x, z, -y);

export interface EnvRule {
  /** bocais de onde sai o raio para o carro de índice i (o objeto lê o ponto i; ver `origin`) */
  nozzles: V3[];
  /** ponto do clarão branco e das faíscas (+0xc0) */
  flash: V3;
  /** cor de cada bocal (0x2c4058, RGB) */
  colors: number[];
  /** projétil lançado contra cada inimigo vivo */
  proj: number;
  /** som do disparo e onde toca (FUN_001a4548: ponto +0xa0 = bocal 3) */
  sound: { name: string; at: V3; min: number; max: number };
  /** som das faíscas (FUN_001a45c0) */
  sparkSound: { name: string; min: number; max: number };
  /** faíscas durante `sparkTicks`, uma chance em `sparkOdds` por tique, em volta de `flash` (caixa PS2 x, y, z) */
  sparkTicks: number;
  sparkOdds: number;
  sparkBox: { x: [number, number]; y: [number, number]; z: [number, number] };
}

/**
 * ARENA (fase 0x10): objeto 0x37bee0, vtable 0x2d9468. Construtor FUN_001d7970 (pontos), início FUN_001d7a80 /
 * FUN_001d7f50 (estado 1, 120 tiques), atualização FUN_001d7b48: no estado 1 cada bocal solta jatos coloridos para
 * cima (efeitos 0x3e e 0x3b) e o ponto +0xc0 um clarão branco (0x3c, 0x3b); cada carro vivo que não é o dono
 * (+0x68c0 bit 40 e +0x34 == 4) leva um projétil 0x13 que sai do ponto de índice igual ao dele na lista de carros;
 * no estado 2, faíscas e L_ENV_ZAP até acabar o tempo.
 */
export const ENV_RULES: Partial<Record<number, EnvRule>> = {
  16: {
    nozzles: [P(512, 147, 34), P(517, 130, 34), P(522, 114, 34), P(529, 98, 34), P(536, 83, 34)],
    flash: P(557, 127, 97),
    colors: [0x40ff40, 0x4040ff, 0xff4040, 0x4040ff, 0x40ff40],
    proj: 0x13,
    // FUN_001d32d8(pos, 100, 2500) / (pos, 5, 2500): distância mínima e máxima do som.
    sound: { name: 'L_ENV_PYRO', at: P(529, 98, 34), min: 100, max: 2500 },
    sparkSound: { name: 'L_ENV_ZAP', min: 5, max: 2500 },
    sparkTicks: 120,
    sparkOdds: 7, // FUN_00237d20(0, 6) == 0 — sorteio inclusivo
    sparkBox: { x: [-30, 30], y: [-100, 100], z: [-50, 30] },
  },
};

export const envRuleFor = (level: string): EnvRule | null => ENV_RULES[levelIndex(level)] ?? null;

/**
 * Ponto de saída do raio para o carro de índice `i`. O jogo lê +0x70 + 16·i sem limite: 0..4 são os bocais, 5 é o
 * ponto do clarão (+0xc0). ⚠️ Do 6 em diante lê memória fora da lista de pontos; o host usa o ponto do clarão.
 */
export const envOrigin = (rule: EnvRule, i: number): V3 => rule.nozzles[i] ?? rule.flash;

/** Faísca do estado 2: deslocamento aleatório em volta do clarão (eixos PS2). */
export function envSpark(rule: EnvRule, rand: () => number): V3 {
  const u = (a: [number, number]) => a[0] + rand() * (a[1] - a[0]);
  const b = rule.sparkBox;
  const d = P(u(b.x), u(b.y), u(b.z));
  return v3(rule.flash.x + d.x, rule.flash.y + d.y, rule.flash.z + d.z);
}
