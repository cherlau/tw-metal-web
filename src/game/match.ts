// Partida de deathmatch — estado PURO (sem DOM/Three). O runtime (src/game.ts) só desenha e lê eventos.
// ⚠️ ESCOLHA DO HOST: vida, turbo, tempo da carcaça, navegação dos bots (ver docs/NATIVE.md para o que é nativo).
// Armas, pickups e especiais seguem as regras do jogo (src/game/weapons.ts, src/game/specials.ts).
import { add, len, norm, scale, sub, v3, type V3 } from '../physics/vec';
import { basisOf, createVehicle, forwardOf, stepVehicle, type CollisionWorld, type Controls, type VehicleShape, type VehicleState } from '../physics/vehicle';
import {
  damageFromHit, fire, INVENTORY_ORDER, MG_MOUNTS, WEAPON_MOUNT, isBullet, lockTarget, MACHINE_GUN, MG_AIM, MG_AIM_MODELS, pickTarget, pickupEffect, pickupRespawnRange, PICKUP_RULES,
  stepProjectile, SWARMER, WEAPON_CLASSES, weaponName, type CarBody, type HitResult, type Projectile, type WeaponId,
} from './weapons';
import { SPECIAL_MAX, specialRecharge, SPECIALS, type SpecialRule, type SpecialShot } from './specials';
import { BIT, BLAST, BOOST, comboBits, ENERGY, ENERGY_REGEN, FREEZE, HISTORY, SHELL_TICKS, type EnergyKind } from './energy';
import { BotBrain, type AiProfile, type AiShared, type AiTables } from './ai';
import { ENV_MESSAGES, envOrigin, envRuleFor, envSpark, type EnvRule } from './environment';

const MPH = 1.4666667;
/** Vel. máx. (mph) para o dano de batida quando o carro não tem a tabela nativa (⚠️ host; FUN_001349f0 usa carro+0x858). */
const RAM_FALLBACK_MPH = 120;
/** Saída do congelamento (FUN_0014d478: obj+0x60 = (0, 0, 5,1720)), coords do PS2 no quadro do carro. */
const FREEZE_MUZZLE = [0, 0, 5.172] as const;
/**
 * Mina (FUN_0014c0d0) e Remote sem ponto 15 (FUN_0014de98): obj+0x10 → obj+0x60 = (0, −3, −1); estes veículos
 * (0x65, 0x67, 0x6b, 0x6c, 0x71, 0x73, 0x77, 0x7a, 0x82) soltam em (0, 0, −1).
 */
const dropPoint = (model: string): readonly [number, number, number] =>
  ['axel', 'mrgrim', 'spectre', 'twist', 'grass', 'edatv', 'edplayer', 'hc_axel', 'hc_sweet'].includes(model) ? [0, 0, -1] : [0, -3, -1];
/**
 * Pontos fixos de FUN_00147ec8 por modelo e projétil: [x, y, y de ré, z] (coords do PS2). Ricochet (7) do Cousin
 * Eddy (0x74), Dark1 (0x75) e Dark2 (0x76); projétil 0x1f do Mr. Grimm (0x67) em (0, 10, 0).
 */
const FIXED_MUZZLE: Record<string, Record<number, readonly [number, number, number, number]>> = {
  edboss: { 7: [9.28, 29.64, -24.7, -5.88] },
  dark1: { 7: [8.65, 25.15, -25.15, -3.49] },
  dark2: { 7: [9.28, 160, -160, -5.88] },
  mrgrim: { 0x1f: [0, 10, 10, 0] },
};

/** FUN_00253740: aproxima com fração por tique e passo mínimo. */
function toward(cur: number, goal: number, rate: number, min: number): number {
  const d = goal - cur;
  let step = d * rate;
  if (Math.abs(step) < min) step = Math.sign(d) * min;
  return Math.abs(step) >= Math.abs(d) ? goal : cur + step;
}

/** Ponto de spawn: posição e o nó para onde o carro nasce virado (1º vizinho no grafo). */
export interface SpawnPoint {
  pos: V3;
  face?: V3;
}

export const MATCH_RULES = {
  maxHealth: 100,
  respawnDelay: 3,
  turboMax: 100,
  turboDrain: 40, // por segundo
  turboRegen: 6,
  turboAccelMul: 1.5, // velocidade de equilíbrio ∝ acelerador → turbo ≈ 1,5 × vel. máx.
  botFireRange: 220,
} as const;

export interface CarActions extends Controls {
  fireGun: boolean;
  fireSpecial: boolean; // borda de subida
  /** botão da arma segurado (Swarmer carrega, 2º toque do Napalm/Remote); sem ele, o toque vale 1 tique */
  fireSpecialHeld?: boolean;
  nextWeapon: boolean; // borda de subida
  turbo: boolean;
  /** direcional apertado neste tique (bitmask DIR de src/game/energy.ts) — combos de energia */
  dirs?: number;
  /** algum dos 12 botões de FUN_00123410 segurado neste tique (descongelar: soltar todos e apertar um) */
  buttonsHeld?: boolean;
  /** bits de controle+0x1c já prontos (a IA escreve direto em jogador+0x13c); humanos: combos do histórico */
  ctl?: number;
}

export const NO_ACTIONS: CarActions = { throttle: 0, brake: 0, steer: 0, handbrake: false, fireGun: false, fireSpecial: false, nextWeapon: false, turbo: false };

export interface Car {
  id: number;
  name: string;
  model: string;
  bot: boolean;
  state: VehicleState;
  shape: VehicleShape;
  health: number;
  turbo: number;
  ammo: Partial<Record<WeaponId, number>>;
  selected: WeaponId | null;
  /** tique a partir do qual outra arma pode disparar (carro+0x6300) */
  nextFire: number;
  /** tiques acumulados para +1 carga do especial (carro+0x62ee) */
  specialCharge: number;
  /** metralhadora: calor (obj+0x94), tiques de superaquecimento, próximo tiro, espera da recarga e lado (obj+0x80: true = ponto 9) */
  mg: { heat: number; overheat: number; next: number; regenIn: number; right: boolean };
  /** estado do botão da arma no tique anterior */
  fireWasHeld: boolean;
  /** Swarmer carregando (tiques segurando) */
  swarmCharge: number | null;
  /** tiros agendados (especiais em sequência) */
  queue: { at: number; shot: SpecialShot; weapon: WeaponId; target: number | null; rear?: boolean; index?: number }[];
  /** projétil esperando o 2º toque (Napalm, Remote, especiais com detonação) */
  armed: Projectile | null;
  /** especial que dura (choque do Cop, tornado, garra, pisão, salto): fase, tiques nela e alvo */
  action: SpecialAction | null;
  /** giro visual do especial do Twister (rad) */
  spin: number;
  /** pose visual do especial: subida (pés), inclinação/capotado (rad, em torno do eixo lateral/frontal) */
  pose?: { lift: number; tilt: number; roll: number };
  /** preso por outro carro (tornado do Twister, garra do Mr. Slam): a física fica com quem segura */
  heldBy: number | null;
  deadFor: number; // > 0: morto há x s
  /** Turbo ligado neste passo (controle+0x0C ≠ 0 no jogo: chama do turbo, FUN_001238c8). */
  boosting: boolean;
  /** Freio acionado neste passo (controle+0x10 > 0: lanternas no filho 2, FUN_0011f1e8). */
  braking: boolean;
  /** Esterço pedido neste passo (−1..1; o jogo guarda 0..1 com 0,5 = centro em carro+0x4a8). */
  steer: number;
  /** Passos seguidos sem tocar o chão (carro+0x7c8). */
  airFrames: number;
  /** energia 0..1 (carro+0x6898), histórico do direcional, tiques congelado e de casca de fogo (+0x6308, +0x62e8) */
  energy: number;
  dirHistory: number[];
  frozen: number;
  shell: number;
  /** bits de controle+0x1c deste tique (src/game/energy.ts BIT) e o "armado" do descongelar (+0x68b0) */
  ctl: number;
  unfreezeArmed: boolean;
  /** pegando fogo (bit 46 de +0x68c0; slot do gerente 0x349150): tiques restantes e quem acendeu */
  burning: number;
  burnBy: number | null;
  /** espera entre impulsos de golpe (carro+0x6400 = 12 quadros, FUN_00136048) */
  kickWait: number;
  kills: number;
  deaths: number;
  /** Memória da IA: tempo acelerando sem andar, e tempo restante de ré para desatolar. */
  botStuck: number;
  botReverse: number;
  /** IA do jogo (src/game/ai.ts), criada no primeiro quadro do bot. */
  brain?: BotBrain;
  /** Índice do perfil de IA (tabela de nomes 0x2b39f0 / perfis 0x2b2d10). */
  aiIndex?: number;
  /** Tempo até poder causar dano de batida de novo (FUN_001349f0: 60 quadros). */
  ramCooldown?: number;
  /** Próximo instante em que a mensagem "Bay Full" pode repetir (s de partida). ⚠️ host */
  bayFullCooldown?: number;
}

export interface SpecialAction {
  kind: 'taser' | 'tornado' | 'crane' | 'stomp' | 'leap' | 'volley' | 'boost' | 'derby' | 'cannon' | 'beam' | 'preach' | 'tractor' | 'arc';
  /** estado da classe (obj+0x58) e tiques nele */
  phase: number;
  t: number;
  until: number;
  target: number | null;
  /** taxa de giro atual (Twister +0x78), fração de aproximação (Slam +0xdc, Grasshopper +0x78), fases já batidas */
  rate: number;
  hits: number;
  /** presos do tornado: ângulo e raio da órbita, tiques restantes */
  held: { id: number; angle: number; dist: number; timer: number }[];
  /** objeto lançado (Derby): posição, direção, estado (0 voando, 3 preso, 4 desviado) */
  obj?: { pos: V3; dir: V3; mode: number; t: number; aim?: V3 };
}

/** WeaponId → índice do inventário do jogo (carro+0x4fbc; nomes 0x2ba680: 0 Special … 8 Remote). */
export const INVENTORY_INDEX: Partial<Record<WeaponId, number>> = Object.fromEntries(INVENTORY_ORDER.map((w, i) => [w, i]));

export interface Pickup {
  index: number;
  id: number; // id nativo (PKP word 8)
  pos: V3;
  respawnIn: number; // 0 = disponível
}

export type MatchEvent =
  /** Tiro da metralhadora (som e clarão); a bala é um projétil do tipo `type`. */
  | { kind: 'shot'; car: number; weapon: WeaponId; from: V3; to: V3; hitCar: boolean }
  /** Bala da metralhadora acertou (FUN_00153ff0: W_BUL_METAL no carro, W_BUL_DIRT no cenário). */
  | { kind: 'bulletHit'; pos: V3; car: boolean; type: number; vel: V3; normal?: V3 }
  /** Ricochete quicou numa parede (W_RICOCHET_BNCE). */
  | { kind: 'bounce'; pos: V3 }
  | { kind: 'launch'; car: number; weapon: WeaponId; pos: V3; type: number }
  | { kind: 'impact'; a: number; b: number; pos: V3; speed: number }
  /** Detonação: `vel` do projétil, `normal` do contato e se atingiu um carro (FUN_002024a8 → partículas). */
  | { kind: 'explosion'; pos: V3; weapon: WeaponId; type: number; vel?: V3; normal?: V3; hitCar?: boolean }
  /** Especial sem projétil (onda do Axel, choque do Cop, golpes): para efeito e som. */
  | { kind: 'special'; car: number; model: string; pos: V3; target?: number; noFx?: boolean }
  /** Deixa de animação da especial (src/game/specialclips.ts): aperto ('fire'/'alt') e cada tiro agendado ('shotN'). */
  | { kind: 'specialCue'; car: number; cue: string }
  /** Mensagem do jogo para o jogador (tabela 0x2ba4c0). */
  | { kind: 'message'; car: number; text: string }
  /** ataque de ambiente: início (som), jato de um bocal, clarão, faísca (som) — `color` em RGB */
  | { kind: 'env'; fx: 'start' | 'jet' | 'flash' | 'spark'; pos: V3; color: number }
  | { kind: 'hit'; car: number; amount: number; pos: V3 }
  /** efeito do golpe do Hearse no carro (FUN_0011f280 casos 0x16/0x2b) */
  | { kind: 'hitFx'; car: number; pos: V3 }
  /** carro pegou fogo / apagou (bit 46; emissor de partículas 0x42 de FUN_0017f1e8) */
  | { kind: 'burn'; car: number; on: boolean }
  /** ataque de energia disparado (ou carro congelado): som e efeito */
  | { kind: 'energy'; car: number; what: EnergyKind | 'frozen' | 'boost'; pos: V3 }
  /** Golpe direto no cenário (projétil ou metralhadora): `tag` = dono do triângulo na colisão. */
  | { kind: 'worldHit'; tag: number; weapon: WeaponId; amount: number; pos: V3; vel: V3 }
  /** Batida de carro numa parede do cenário (velocidade normal, pés/s). */
  | { kind: 'ram'; car: number; tag: number; speed: number; pos: V3; vel: V3; maxMph: number }
  | { kind: 'pickup'; car: number; pickupId: number; name: string }
  /** Pickup tocado com o compartimento cheio ("Weapons/Health/Turbo Bay Full", tabela 0x2ba4c0). */
  | { kind: 'bayFull'; car: number; bay: 'weapon' | 'health' | 'turbo' }
  | { kind: 'killed'; victim: number; killer: number | null; pos: V3 }
  | { kind: 'respawn'; car: number };

/** Perfil do Axel (0x2b2d10) — usado quando as tabelas da IA não foram carregadas (testes). */
const DEFAULT_PROFILE: AiProfile = { fleeHealth: 0.4, fireCone: 0.9, switchFrames: 16, waitFrames: 50, losHeight: 7, aggression: 0.7, retreatHealth: 0.3 };

export class Match {
  cars: Car[] = [];
  /** Tabelas da IA (rules/ai.json) e dificuldade 0..3 (FUN_00190448(0x2f4b24)). */
  ai: { tables: AiTables; difficulty: number } | null = null;
  pickups: Pickup[] = [];
  projectiles: Projectile[] = [];
  private events: MatchEvent[] = [];
  private time = 0;
  /** ataque de ambiente da fase (null = "Env Weapon Unavailable") e o evento em curso (um por fase) */
  env: EnvRule | null = null;
  envActive: { owner: number; timer: number } | null = null;
  /** colisão dos raios do ambiente: o cenário sem os aparelhos dos bocais (ver envMouth) */
  private envWorld: CollisionWorld | null = null;
  /**
   * Colisão dos projéteis (o jogo varre sólidos 9/0x1A, FUN_00226c08; ⚠️ host: a malha visual sem as peças que
   * não escrevem profundidade). Padrão: a mesma do carro.
   */
  projectileWorld: CollisionWorld | null = null;
  /** objetos do cenário que a trava aceita sem carro no cone (FUN_00147cf0; o runtime liga aos destrutíveis) */
  sceneTargets: () => V3[] = () => [];
  /** estado global da IA: último congelar/casca de qualquer bot (FUN_00106cf0 / FUN_00106a88) */
  private aiShared: AiShared = { lastShell: -1e9, lastFreeze: -1e9 };
  /** tique a partir do qual o tornado (carro·64 + preso) pode recapturar (+0xac = agora + +0xcc) */
  private recapture = new Map<number, number>();
  /** relógio da partida em tiques de 1/60 s */
  get tick() {
    return Math.round(this.time * 60);
  }

  /** Spawns (nós do grafo com o bit 0x08) e o bit 0x10 "usado" de FUN_00112110 / FUN_001123d8. */
  private readonly spawnList: { pos: V3; face?: V3; used: boolean }[];

  constructor(
    private readonly world: CollisionWorld,
    spawns: (V3 | SpawnPoint)[],
    private readonly ground: (p: V3, shape: VehicleShape) => V3,
    private readonly rand: () => number = Math.random,
  ) {
    this.spawnList = spawns.map((s) => ('pos' in s ? { pos: s.pos, face: s.face, used: false } : { pos: s, used: false }));
  }

  addCar(name: string, model: string, shape: VehicleShape, bot: boolean, aiIndex?: number): Car {
    const id = this.cars.length;
    const car: Car = {
      id, name, model, bot, shape, aiIndex,
      state: createVehicle(v3()),
      health: MATCH_RULES.maxHealth, turbo: MATCH_RULES.turboMax,
      ammo: {}, selected: null, nextFire: 0, specialCharge: 0, mg: { heat: MACHINE_GUN.heatMax, overheat: 0, next: 0, regenIn: 0, right: true }, fireWasHeld: false,
      swarmCharge: null, queue: [], armed: null, action: null, spin: 0, heldBy: null,
      deadFor: 0, kills: 0, deaths: 0, botStuck: 0, botReverse: 0, boosting: false, braking: false, steer: 0, airFrames: 0,
      energy: 1, dirHistory: [], frozen: 0, shell: 0, ctl: 0, unfreezeArmed: false, burning: 0, burnBy: null, kickWait: 0,
    };
    this.cars.push(car);
    this.respawn(car, true);
    return car;
  }

  /** Fase da partida (nome do arquivo, ex.: 'arena') — escolhe o ataque de ambiente (DAT_002f4900). */
  setLevel(name: string) {
    this.env = envRuleFor(name);
    const rule = this.env;
    if (!rule) return;
    const near = (q: V3) => rule.nozzles.some((n) => Math.hypot(q.x - n.x, q.z - n.z) < 6 && Math.abs(q.y - n.y) < 6);
    this.envWorld = {
      closestPoint: (p, max) => this.world.closestPoint(p, max),
      raycast: (o, d, max) => {
        let skipped = 0;
        const base = this.projectileWorld ?? this.world;
        for (let k = 0; k < 8; k++) {
          const from = add(o, scale(d, skipped));
          const hit = base.raycast(from, d, max - skipped);
          if (!hit) return null;
          if (!near(add(from, scale(d, hit.distance)))) return { ...hit, distance: hit.distance + skipped };
          skipped += hit.distance + 0.05;
        }
        return null;
      },
    };
  }

  addPickups(list: { id: number; pos: V3 }[]) {
    for (const [index, p] of list.entries()) if (pickupEffect(p.id).kind !== 'none') this.pickups.push({ index, id: p.id, pos: p.pos, respawnIn: 0 });
  }

  /** Eventos desde a última chamada (drenados pelo dono — SPEC §9.3). */
  drain(): MatchEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  bodies(): CarBody[] {
    return this.cars.map((c) => ({ id: c.id, pos: this.center(c), radius: Math.max(3, Math.min(c.shape.halfWidth, c.shape.halfLength)), alive: c.deadFor === 0, vel: c.state.vel }));
  }

  center(c: Car): V3 {
    return add(c.state.pos, v3(0, (c.shape.top + c.shape.bottom) / 2, 0));
  }

  /**
   * Direção mais livre a partir do spawn (16 raios na altura do carro). Os nós PTS não têm direção;
   * antes o carro podia nascer de cara para um paredão (Egito). ⚠️ ESCOLHA DO HOST.
   */
  openYaw(pos: V3, shape: VehicleShape): number {
    const o = v3(pos.x, pos.y + (shape.top + shape.bottom) / 2, pos.z);
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < 16; i++) {
      const yaw = (i / 16) * Math.PI * 2;
      const hit = this.world.raycast(o, forwardOf(yaw), 300);
      const d = hit ? hit.distance : 300;
      if (d > bestD + 1e-6) {
        bestD = d;
        best = yaw;
      }
    }
    return best;
  }

  /**
   * Spawn (FUN_00112110 na entrada, FUN_001123d8 ao renascer): começa num nó sorteado e percorre a lista; fica com o
   * 1º cuja distância ao carro mais perto passa de 800 pés (entrada, pulando os já usados) ou 300 (renascer), senão
   * com o mais distante. Na entrada o nó fica marcado (bit 0x10); ao renascer, o nó ligado a ele.
   */
  private pickSpawn(car: Car, first: boolean) {
    const list = this.spawnList;
    const others = this.cars.filter((c) => c !== car && c.deadFor === 0).map((c) => c.state.pos);
    const dist = (p: V3) => (others.length ? Math.min(...others.map((o) => len(sub(o, p)))) : Infinity);
    const limit = first ? 800 : 300;
    let best: (typeof list)[number] | null = null;
    let bestD = 0;
    let k = Math.floor(this.rand() * list.length);
    for (let n = 0; n < list.length; n++, k++) {
      const s = list[k % list.length];
      if (first && s.used) continue;
      const d = dist(s.pos);
      if (d > bestD || !best) {
        best = s;
        bestD = d;
        if (d > limit) break;
      }
    }
    if (!best) best = list[Math.floor(this.rand() * list.length)];
    if (first) best.used = true;
    return best;
  }

  /** `first`: entrada na partida (FUN_00112110); senão renascer (FUN_001123d8). */
  respawn(car: Car, first = false) {
    const spot = this.pickSpawn(car, first);
    const pos = this.ground(spot.pos, car.shape);
    // FUN_0011cd38: virado para o nó ligado (+0x14); sem ligação, a direção mais livre (⚠️ host)
    const yaw = spot.face ? Math.atan2(spot.face.x - spot.pos.x, spot.face.z - spot.pos.z) : this.openYaw(pos, car.shape);
    car.state = createVehicle(pos, yaw);
    car.health = MATCH_RULES.maxHealth;
    car.turbo = MATCH_RULES.turboMax;
    car.deadFor = 0;
    // FUN_0011c6e0 / FUN_00122420: energia cheia, descongela, apaga a casca
    car.energy = 1;
    car.dirHistory = [];
    car.frozen = 0;
    car.shell = 0;
    this.extinguish(car);
    car.kickWait = 0;
    // Munição ao nascer (FUN_00147420: Fire 1, Homing 1, especial 1 se o carro tem classe de especial).
    car.ammo = {};
    for (const [w, c] of Object.entries(WEAPON_CLASSES)) if (c.start) car.ammo[w as WeaponId] = c.start;
    if (SPECIALS[car.model]) car.ammo.special = 1;
    car.selected = null;
    car.nextFire = 0;
    car.specialCharge = 0;
    car.mg = { heat: MACHINE_GUN.heatMax, overheat: 0, next: 0, regenIn: 0, right: true };
    car.swarmCharge = null;
    car.queue = [];
    car.armed = null;
    this.endAction(car);
    car.heldBy = null;
  }

  step(dt: number, actions: Map<number, CarActions>) {
    this.time += dt;
    const bodies = this.bodies();
    for (const car of this.cars) {
      if (car.deadFor > 0) {
        car.boosting = car.braking = false;
        car.deadFor += dt;
        if (car.deadFor >= MATCH_RULES.respawnDelay) {
          this.respawn(car);
          this.events.push({ kind: 'respawn', car: car.id });
        }
        continue;
      }
      let a = car.bot ? this.botActions(car, bodies) : actions.get(car.id) ?? NO_ACTIONS;
      // Controle (FUN_0012aaf0 → FUN_00223c90 / FUN_0012c9b8): histórico do direcional e bits dos combos.
      car.dirHistory.push(a.dirs ?? 0);
      if (car.dirHistory.length > HISTORY) car.dirHistory.shift();
      car.ctl = a.ctl ?? (car.bot ? 0 : comboBits(car.dirHistory));
      // Congelado (bit 42 de +0x68c0): sem controle nem armas (FUN_00123410). Só o humano descongela apertando:
      // todos os 12 botões soltos armam (+0x68b0 = 1); o próximo aperto tira 13 tiques.
      if (car.frozen > 0) {
        let press = false;
        if (!car.bot) {
          if (!a.buttonsHeld) car.unfreezeArmed = true;
          else if (car.unfreezeArmed) {
            car.unfreezeArmed = false;
            press = true;
          }
        }
        car.frozen -= 1 + (press ? FREEZE.perPress : 0);
        if (car.frozen < 0) car.frozen = 0;
        a = NO_ACTIONS;
      }
      if (car.shell > 0) car.shell--;
      if (car.kickWait > 0) car.kickWait--;
      this.stepBurn(car);
      car.energy = Math.min(1, car.energy + ENERGY_REGEN); // FUN_0011e3d0 → FUN_0011bde0
      // Turbo: aceleração extra enquanto houver carga.
      const boosting = a.turbo && car.turbo > 1 && a.throttle > 0;
      car.boosting = boosting;
      if (boosting) this.extinguish(car); // FUN_001238c8: o turbo apaga o fogo
      car.braking = a.brake > 0;
      car.steer = a.steer;
      car.turbo = Math.min(MATCH_RULES.turboMax, car.turbo + (boosting ? -MATCH_RULES.turboDrain : MATCH_RULES.turboRegen) * dt);
      // Com a tabela nativa o turbo entra no controlador (×3 aceleração, ×1,25 vel. máx.); sem ela, acelerador ×1,5.
      const throttle = boosting && !car.shape.drive ? MATCH_RULES.turboAccelMul : a.throttle;
      // Preso no tornado/garra: quem segura move o carro (FUN_001e54b0 / FUN_001b1fc0 gravam a posição).
      if (car.heldBy === null) stepVehicle(car.state, car.shape, { ...a, throttle, turbo: boosting }, this.world, dt);
      else car.state.contacts = undefined;
      car.ramCooldown = Math.max(0, (car.ramCooldown ?? 0) - dt);
      car.airFrames = car.state.grounded ? 0 : car.airFrames + 1;
      for (const k of car.state.contacts ?? []) this.events.push({ kind: 'ram', car: car.id, tag: k.tag, speed: k.speed, pos: k.point, vel: car.state.vel, maxMph: car.shape.drive?.maxMph ?? RAM_FALLBACK_MPH });
      if (car.frozen === 0) {
        this.weapons(car, a, bodies, dt);
        this.energyAttacks(car);
      }
    }
    this.collideCars();
    this.stepEnv(dt);
    this.stepProjectiles(dt);
    this.stepPickups(dt);
  }

  /**
   * Carro × carro: círculos no plano (raio = meia-largura média ⚠️ host), separação e impulso ao longo da normal
   * com restituição 0,3 ⚠️ host, divididos pela massa nativa (carro+0x848). Dano de batida (FUN_001349f0): quem bate
   * a mais de 100 pés/s causa ramDamage·mín(v_rel − 100, 100)/100 no outro, no máximo a cada 60 quadros.
   */
  private collideCars() {
    const alive = this.cars.filter((c) => c.deadFor === 0);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const ra = (a.shape.halfWidth + a.shape.halfLength) * 0.5;
        const rb = (b.shape.halfWidth + b.shape.halfLength) * 0.5;
        const dx = b.state.pos.x - a.state.pos.x;
        const dz = b.state.pos.z - a.state.pos.z;
        if (Math.abs(b.state.pos.y - a.state.pos.y) > Math.max(a.shape.top - a.shape.bottom, b.shape.top - b.shape.bottom)) continue;
        const d = Math.hypot(dx, dz);
        const overlap = ra + rb - d;
        if (overlap <= 0) continue;
        const nx = d > 1e-6 ? dx / d : 1;
        const nz = d > 1e-6 ? dz / d : 0;
        const ma = a.shape.drive?.mass ?? 1;
        const mb = b.shape.drive?.mass ?? 1;
        const wa = mb / (ma + mb); // parte de a (o mais leve se move mais)
        const wb = ma / (ma + mb);
        a.state.pos = v3(a.state.pos.x - nx * overlap * wa, a.state.pos.y, a.state.pos.z - nz * overlap * wa);
        b.state.pos = v3(b.state.pos.x + nx * overlap * wb, b.state.pos.y, b.state.pos.z + nz * overlap * wb);
        const rel = (b.state.vel.x - a.state.vel.x) * nx + (b.state.vel.z - a.state.vel.z) * nz;
        if (rel < 0) {
          const at = v3(a.state.pos.x + dx / 2, a.state.pos.y, a.state.pos.z + dz / 2);
          if (rel < -15) this.events.push({ kind: 'impact', a: a.id, b: b.id, pos: at, speed: -rel });
          const j = -(1 + 0.3) * rel;
          a.state.vel = v3(a.state.vel.x - nx * j * wa, a.state.vel.y, a.state.vel.z - nz * j * wa);
          b.state.vel = v3(b.state.vel.x + nx * j * wb, b.state.vel.y, b.state.vel.z + nz * j * wb);
          // Semi (FUN_001dd5e8): bateu num carro (+0x902) acima de 4 pés/s com o especial pronto → dispara sozinho
          for (const s of [a, b]) {
            if (s.model !== 'hc_semi' || (s.ammo.special ?? 0) <= 0 || this.tick <= s.nextFire || s.action) continue;
            if (Math.hypot(s.state.vel.x, s.state.vel.z) > 4) this.fireSpecialNow(s);
          }
          const relSpeed = Math.hypot(b.state.vel.x - a.state.vel.x, b.state.vel.z - a.state.vel.z); // após o impulso
          const closing = Math.max(relSpeed, -rel);
          for (const [hitter, victim] of [[a, b], [b, a]] as const) {
            const d = hitter.shape.drive;
            if (!d || (hitter.ramCooldown ?? 0) > 0 || Math.hypot(hitter.state.vel.x, hitter.state.vel.z) <= 100 || closing <= 100) continue;
            hitter.ramCooldown = 1;
            this.damage(victim.id, (d.ramDamage * Math.min(closing - 100, 100)) / 100, hitter.id, at);
          }
        }
      }
    }
  }

  private weapons(car: Car, a: CarActions, bodies: CarBody[], dt: number) {
    const now = this.tick;
    const fwd = forwardOf(car.state.yaw);
    const targets = bodies.filter((b) => b.alive && b.id !== car.id).map((b) => ({ id: b.id, pos: b.pos }));
    const carSpeed = Math.max(0, car.state.vel.x * fwd.x + car.state.vel.z * fwd.z);

    // Carga do especial (FUN_0011ef10): +1 a cada carro+0x62f0 tiques até 5; parado em 5.
    if (SPECIALS[car.model]) {
      const n = car.ammo.special ?? 0;
      if (n >= SPECIAL_MAX) car.specialCharge = 0;
      else if ((car.specialCharge += dt * 60) > specialRecharge(car.model)) {
        car.ammo.special = n + 1;
        car.specialCharge = 0;
      }
    }

    // Troca (FUN_0014a3a8): próximo índice do inventário com munição.
    const owned = INVENTORY_ORDER.filter((w) => (car.ammo[w] ?? 0) > 0);
    if (!car.selected || !owned.includes(car.selected)) car.selected = owned[0] ?? null;
    if (a.nextWeapon && owned.length > 1) car.selected = owned[(owned.indexOf(car.selected!) + 1) % owned.length];

    this.machineGun(car, a.fireGun, fwd, carSpeed, dt);

    // Botão da arma: borda + estado segurado (o jogo lê o byte de estado do controle, controle+0x21).
    const held = a.fireSpecialHeld ?? a.fireSpecial;
    const pressed = a.fireSpecial || (held && !car.fireWasHeld);
    const released = !held && car.fireWasHeld;
    car.fireWasHeld = held;
    // Napalm: enquanto o botão segue apertado desde o disparo, voa sem gravidade (FUN_00191880, +0x08).
    if (car.armed?.type === 4 && car.armed.alive) car.armed.hover = held && car.armed.hover !== false;

    // Tiros agendados dos especiais em sequência.
    for (const q of car.queue.filter((q) => q.at <= now)) {
      this.shoot(car, q.shot, q.weapon, q.target, carSpeed, undefined, q.rear);
      if (q.weapon === 'special' && q.index) this.events.push({ kind: 'specialCue', car: car.id, cue: `shot${q.index}` });
    }
    car.queue = car.queue.filter((q) => q.at > now);
    this.stepAction(car, bodies, now);
    // Mr. Slam: com o especial selecionado o disparo procura alguém para agarrar a cada quadro (FUN_001b1330 estado 0).
    if (car.selected === 'special') this.craneGrab(car, fwd, targets);

    // Swarmer (FUN_0014d970): segurar carrega; soltar (ou passar de 210 tiques) dispara.
    if (car.swarmCharge !== null) {
      car.swarmCharge += dt * 60;
      if (released || !held || car.swarmCharge > SWARMER.autoFire) {
        const n = Math.min(SWARMER.max, Math.floor(car.swarmCharge / SWARMER.perMissile) + 1);
        const c = WEAPON_CLASSES.swarmer;
        const t = lockTarget(this.muzzle(car, 'swarmer'), fwd, targets, c.lockDeg, c.range);
        for (let i = 0; i < n; i++) {
          // FUN_0014dd00: arfagem U(1°, 20°) e rumo U(−20°, 20°) por míssil.
          const shot: SpecialShot = {
            proj: c.proj,
            pitch: (SWARMER.pitchMin + this.rand() * (SWARMER.pitchMax - SWARMER.pitchMin)) * (Math.PI / 180),
            yaw: (this.rand() * 2 - 1) * SWARMER.yawSpread * (Math.PI / 180),
          };
          this.shoot(car, shot, 'swarmer', t?.id ?? null, carSpeed);
        }
        car.ammo.swarmer = Math.max(0, (car.ammo.swarmer ?? 0) - 1);
        car.nextFire = now + c.refire;
        car.swarmCharge = null;
        this.energyMissile(car, t?.id ?? null); // FUN_0014dd00: bit 0x40 no fim da rajada
      }
      return;
    }

    const w = car.selected;
    if (!pressed || !w) return;
    // 2º toque com a mesma arma: explode/derruba o projétil armado (Napalm FUN_002009d0, Remote/especiais
    // FUN_002024a8) — cada classe cuida do seu (obj+0x40 = slot do projétil).
    if (car.armed && !car.armed.alive) car.armed = null;
    if (car.armed && car.armed.weapon === w) {
      if (car.armed.type === 4 || car.armed.type === 51) {
        car.armed.vy = -30 * 60;
        car.armed.speed = 0;
      } else car.armed.detonate = true;
      car.armed = null;
      return;
    }
    if (now < car.nextFire || (car.ammo[w] ?? 0) <= 0) return;

    if (w === 'special') return this.special(car, fwd, targets, carSpeed, bodies);
    const c = WEAPON_CLASSES[w as Exclude<WeaponId, 'machinegun' | 'special' | 'energy'>];
    if (w === 'env') {
      // Ataque de ambiente (FUN_0014d040): só gasta munição se a fase tem o evento e ele não está em curso.
      car.nextFire = now + c.refire;
      if (!this.env) this.events.push({ kind: 'message', car: car.id, text: ENV_MESSAGES.unavailable });
      else if (this.envActive) this.events.push({ kind: 'message', car: car.id, text: ENV_MESSAGES.active });
      else {
        car.ammo.env = (car.ammo.env ?? 0) - 1;
        this.startEnv(car);
      }
      return;
    }
    if (w === 'swarmer') {
      car.swarmCharge = 0;
      return;
    }
    // FUN_0014b900 / FUN_0014bd60 travam o bit 0x10 (tiro para trás) ao começar; o Remote sai sempre de ré (FUN_0014e030).
    const rear = w === 'remote' || (car.ctl & BIT.rear) !== 0;
    const aim = rear ? v3(-fwd.x, -fwd.y, -fwd.z) : fwd;
    const from = this.muzzle(car, w, c.proj, rear);
    const t = lockTarget(from, aim, targets, c.lockDeg, c.range);
    // FUN_0014b900: sem carro no cone, tenta o objeto do cenário mais alinhado (FUN_00147cf0)
    const sceneAim = !t && c.lockDeg > 0 ? this.sceneLock(from, aim, c.lockDeg, c.range) : null;
    const p = this.shoot(car, { proj: c.proj }, w, t?.id ?? null, carSpeed, undefined, rear, sceneAim ?? undefined);
    if (w === 'napalm' || w === 'remote') car.armed = p;
    if (w === 'napalm') p.hover = held;
    car.ammo[w] = (car.ammo[w] ?? 0) - 1;
    car.nextFire = now + c.refire;
    if (w !== 'remote') this.energyMissile(car, t?.id ?? null);
  }

  /** Bit 0x40 (Direita, Esquerda, Cima, Cima): míssil 0xf extra pagando 0,3 de energia (FUN_00148300). */
  private energyMissile(car: Car, locked: number | null) {
    if (!(car.ctl & BIT.boost) || car.energy <= BOOST.cost) return;
    car.energy -= BOOST.cost;
    const fwd = forwardOf(car.state.yaw);
    const me = this.center(car);
    let target = locked;
    let pitch = 0;
    const D = Math.PI / 180;
    if (target === null) {
      const targets = this.cars.filter((c) => c !== car && c.deadFor === 0).map((c) => ({ id: c.id, pos: this.center(c) }));
      const t = lockTarget(me, fwd, targets, BOOST.lockDeg, BOOST.range);
      if (t) {
        const d2 = len(sub(t.pos, me)) ** 2;
        pitch = d2 < 90000 ? 5 * D : d2 < 360000 ? 15 * D : 30 * D;
        target = t.id;
      }
    } else pitch = len(sub(this.center(this.cars[target]), me)) ** 2 < 200 ? 15 * D : 30 * D;
    // sai 10 pés à frente do carro (FUN_00148300: R·(0, 10, 0))
    this.shoot(car, { proj: BOOST.proj, pitch }, 'energy', target, 0, add(me, scale(fwd, 10)));
    this.events.push({ kind: 'energy', car: car.id, what: 'boost', pos: me });
  }

  /**
   * Ponto no espaço do carro (PS2: x direita, y frente, z cima; de ré, espelhado em y) levado ao mundo pela matriz
   * do carro, com a inclinação (FUN_00147ec8: linhas +0x40..+0x60 do nó do carro × ponto + posição +0x20).
   */
  local(car: Car, o: readonly [number, number, number], rear = false): V3 {
    const b = basisOf(car.state); // x = esquerda, y = cima, z = frente
    return add(car.state.pos, add(add(scale(b.x, -o[0]), scale(b.z, rear ? -o[1] : o[1])), scale(b.y, o[2])));
  }

  /**
   * Ponto de saída da arma (FUN_00147ec8): o registro 0x00F8 da classe (WEAPON_MOUNT) no quadro do carro; sem ele,
   * a origem do carro (o Remote cai no ponto padrão da classe, FUN_0014de98). Casos fixos do jogo: Ricochet (projétil 7) do Cousin Eddy/Dark1/Dark2 e o 0x1f do Mr. Grimm.
   * ⚠️ host: modelo sem `mounts` (testes) sai à frente do carro.
   */
  muzzle(car: Car, weapon: WeaponId = 'special', proj = -1, rear = false): V3 {
    const fixed = FIXED_MUZZLE[car.model]?.[proj];
    if (fixed) return this.local(car, [fixed[0], rear ? fixed[2] : fixed[1], fixed[3]]);
    const mounts = car.shape.mounts;
    if (!mounts) {
      const fwd = forwardOf(car.state.yaw);
      return add(this.center(car), add(scale(fwd, car.shape.halfLength + 2), v3(0, 1, 0)));
    }
    const id = WEAPON_MOUNT[weapon];
    const m = (id !== undefined ? mounts[id] : undefined) ?? (weapon === 'remote' ? dropPoint(car.model) : undefined);
    return m ? this.local(car, m) : { ...car.state.pos };
  }

  /** Metralhadora (FUN_0014ae38): ponto 8 ou 9 (com os dois, alterna); sem nenhum, 1 pé acima da origem do carro. */
  private gunMuzzle(car: Car): V3 {
    const mounts = car.shape.mounts;
    if (!mounts) return this.muzzle(car);
    const a = mounts[MG_MOUNTS[0]];
    const b = mounts[MG_MOUNTS[1]];
    if (a && b) {
      const p = this.local(car, car.mg.right ? b : a);
      car.mg.right = !car.mg.right;
      return p;
    }
    const one = a ?? b;
    return one ? this.local(car, one) : add(car.state.pos, v3(0, 1, 0));
  }

  /**
   * Dispara pela FUN_00147ec8. `rear` = obj+0x44 (bit 0x10 do controle travado no disparo): rumo + π e arfagem
   * negada; o ponto de saída é o mesmo. ⚠️ host: de ré o projétil parte parado (o jogo passa a velocidade do carro).
   */
  /** FUN_00147cf0: o objeto (não carro) mais alinhado com cos > cos(cone) e a menos de `range` pés. */
  sceneLock(from: V3, fwd: V3, coneDeg: number, range: number): V3 | null {
    let best: V3 | null = null;
    let bestCos = Math.cos((coneDeg * Math.PI) / 180);
    for (const q of this.sceneTargets()) {
      const d = sub(q, from);
      const L = len(d);
      if (L < 1e-3 || L >= range) continue;
      const c = (d.x * fwd.x + d.y * fwd.y + d.z * fwd.z) / L;
      if (c > bestCos) {
        bestCos = c;
        best = q;
      }
    }
    return best;
  }

  private shoot(car: Car, shot: SpecialShot, weapon: WeaponId, target: number | null, carSpeed: number, from?: V3, rear = false, aimPoint?: V3): Projectile {
    const f0 = forwardOf(car.state.yaw);
    const fwd = rear ? v3(-f0.x, -f0.y, -f0.z) : f0;
    if (rear) carSpeed = 0;
    const origin = from ?? (shot.offset ? this.local(car, shot.offset, rear) : this.muzzle(car, weapon, shot.proj, rear));
    let last!: Projectile;
    for (let i = 0; i < (shot.count ?? 1); i++) {
      const pr = shot.pitchRange;
      const yr = shot.yawRange;
      const type = shot.projChoice ? shot.projChoice[Math.floor(this.rand() * shot.projChoice.length)] : shot.proj;
      const p = fire(type, weapon, car.id, origin, fwd, target, {
        pitch: (shot.pitch ?? 0) + (pr ? pr[0] + this.rand() * (pr[1] - pr[0]) : 0),
        yaw: (shot.yaw ?? 0) + (yr ? yr[0] + this.rand() * (yr[1] - yr[0]) : 0),
        carSpeed, damage: shot.damage, rand: this.rand, aimPoint,
      });
      this.projectiles.push(p);
      last = p;
    }
    this.events.push({ kind: 'launch', car: car.id, weapon, pos: origin, type: shot.proj });
    return last;
  }

  /**
   * Metralhadora (FUN_0014ae38): um tiro a cada 10 tiques enquanto segura; o calor cai 0,2 por tique segurando e
   * volta 0,4 por tique 60 tiques depois de soltar; abaixo de 0,1 trava por 300 tiques e volta cheio.
   */
  private machineGun(car: Car, held: boolean, fwd: V3, carSpeed: number, dt: number) {
    const g = car.mg;
    const ticks = dt * 60;
    const now = this.tick;
    if (g.overheat > 0) {
      g.overheat -= ticks;
      if (g.overheat <= 0) g.heat = MACHINE_GUN.heatMax;
      g.right = true;
      return;
    }
    if (!held) {
      g.right = true; // botão solto: obj+0x80 = 1, a rajada recomeça pelo ponto 9
      if ((g.regenIn -= ticks) <= 0) g.heat = Math.min(MACHINE_GUN.heatMax, g.heat + MACHINE_GUN.heatRegen * ticks);
      return;
    }
    g.regenIn = MACHINE_GUN.regenDelay;
    g.heat -= MACHINE_GUN.heatPerTick * ticks;
    if (g.heat < MACHINE_GUN.overheatBelow) {
      g.overheat = MACHINE_GUN.overheatTicks;
      g.right = true;
      return;
    }
    if (now < g.next) return;
    g.next = now + MACHINE_GUN.interval[0];
    const origin = this.gunMuzzle(car);
    // Mira (FUN_0014ae38): humano em alguns veículos trava a 7,5° e aponta a bala para o centro do alvo.
    let dir = fwd;
    if (!car.bot && MG_AIM_MODELS.has(car.model)) {
      const targets = this.cars.filter((c) => c !== car && c.deadFor === 0).map((c) => ({ id: c.id, pos: this.center(c) }));
      const t = lockTarget(origin, fwd, targets, MG_AIM.coneDeg, MG_AIM.range);
      if (t) {
        const d = sub(t.pos, origin);
        dir = scale(d, 1 / Math.max(len(d), 1e-6));
      }
    }
    const p = fire(MACHINE_GUN.proj, 'machinegun', car.id, origin, dir, null, { carSpeed, doubleDamage: (car.ammo.machinegun ?? 0) > 1, rand: this.rand });
    this.projectiles.push(p);
    this.events.push({ kind: 'shot', car: car.id, weapon: 'machinegun', from: origin, to: add(origin, scale(dir, 30)), hitCar: false });
  }

  /** Dispara o especial do carro (src/game/specials.ts). */
  private special(car: Car, fwd: V3, targets: { id: number; pos: V3 }[], carSpeed: number, bodies: CarBody[]) {
    const rule = SPECIALS[car.model];
    if (!rule || car.action) return;
    const now = this.tick;
    const origin = this.muzzle(car, 'special');
    if (rule.kind === 'shots') {
      car.ammo.special = (car.ammo.special ?? 0) - 1;
      // Disparo alternativo sorteado pelos bots (ATV, FUN_00115b78 estado 2: FUN_00237d20(0,2) == 0).
      const alt = rule.alt && car.bot && this.rand() < rule.alt.chance ? rule.alt : null;
      car.nextFire = now + (alt?.refire ?? rule.refire);
      const rear = !alt && !!rule.rear && (car.ctl & BIT.rear) !== 0;
      const aim = rear ? v3(-fwd.x, -fwd.y, -fwd.z) : fwd;
      const lockDeg = alt ? alt.lockDeg : rule.lockDeg;
      const t = lockDeg > 0 ? lockTarget(origin, aim, targets, lockDeg, alt?.range ?? 7000) : null;
      this.events.push({ kind: 'specialCue', car: car.id, cue: alt ? 'alt' : 'fire' });
      let first: Projectile | null = null;
      for (const [index, s] of (alt?.shots ?? rule.shots).entries()) {
        if ((s.at ?? 0) > 0) car.queue.push({ at: now + (s.at ?? 0), shot: s, weapon: 'special', target: t?.id ?? null, rear, index });
        else {
          const p = this.shoot(car, s, 'special', t?.id ?? null, carSpeed, undefined, rear);
          first ??= p;
        }
      }
      if (rule.detonate && first) car.armed = first;
      return;
    }
    if (rule.kind === 'shockwave') {
      car.ammo.special = (car.ammo.special ?? 0) - 1;
      car.nextFire = now + rule.refire;
      this.events.push({ kind: 'specialCue', car: car.id, cue: 'fire' });
      this.events.push({ kind: 'special', car: car.id, model: car.model, pos: this.center(car) });
      // FUN_00116940: todos no raio (menos o dono) levam o dano e sobem a liftMph·1,4667 pés/s.
      for (const b of bodies) {
        if (!b.alive || b.id === car.id || len(sub(b.pos, this.center(car))) > rule.radius) continue;
        const v = this.cars[b.id];
        v.state.vel = add(v.state.vel, v3(0, rule.liftMph * MPH, 0));
        this.damage(b.id, rule.damage, car.id, b.pos);
      }
      return;
    }
    const act = (kind: SpecialAction['kind'], phase: number, target: number | null = null): SpecialAction =>
      ({ kind, phase, t: 0, until: 0, target, rate: 0, hits: 0, held: [] });
    if (rule.kind === 'taser') {
      car.ammo.special = (car.ammo.special ?? 0) - 1;
      car.nextFire = now + rule.refire;
      this.events.push({ kind: 'special', car: car.id, model: car.model, pos: this.center(car) });
      const t = pickTarget(this.center(car), fwd, targets, rule.range);
      car.action = { ...act('taser', 1, t?.id ?? null), until: now + rule.ticks };
      return;
    }
    if (car.heldBy !== null) return;
    if (rule.kind === 'derby') {
      // FUN_001c2cf0 estado 1: trava 22,5° em 7000, gasta e lança o objeto à frente do carro
      const t = lockTarget(origin, fwd, targets, rule.lockDeg, 7000);
      this.spendSpecial(car, rule.refire);
      car.action = { ...act('derby', 2, t?.id ?? null), obj: { pos: origin, dir: fwd, mode: 0, t: 0 } };
      this.events.push({ kind: 'special', car: car.id, model: car.model, pos: origin, target: t?.id, noFx: true });
      return;
    }
    if (rule.kind === 'beam') {
      this.spendSpecial(car, rule.refire);
      car.action = act('beam', 1);
      this.events.push({ kind: 'special', car: car.id, model: car.model, pos: origin, noFx: true });
      return;
    }
    if (rule.kind === 'preach') {
      car.ammo.special = (car.ammo.special ?? 0) - 1;
      car.action = act('preach', 2);
      return;
    }
    if (rule.kind === 'arc') {
      // FUN_00170360(1) → FUN_00170688: trava e golpeia já no aperto
      car.action = act('arc', 1);
      this.arcLock(car, car.action, rule);
      this.events.push({ kind: 'special', car: car.id, model: car.model, pos: this.center(car), target: car.action.target ?? undefined, noFx: true });
      return;
    }
    if (rule.kind === 'cannon' || rule.kind === 'tractor') {
      car.action = act(rule.kind, 1);
      if (rule.kind === 'tractor') car.nextFire = this.tick + rule.refire;
      return;
    }
    if (rule.kind === 'volley' || rule.kind === 'boost') {
      car.action = act(rule.kind, 1);
      if (rule.kind === 'boost') this.events.push({ kind: 'special', car: car.id, model: car.model, pos: this.center(car) });
      return;
    }
    if (rule.kind === 'tornado') {
      // FUN_001e4670 estado 0 → 1 (FUN_001e5fb8): giro, subida e taxa zerados.
      car.action = act('tornado', 1);
      car.pose = { lift: 0, tilt: 0, roll: 0 };
      car.spin = 0;
      this.events.push({ kind: 'special', car: car.id, model: car.model, pos: this.center(car) });
    } else if (rule.kind === 'stomp') {
      // FUN_00196b60 estado 0: só no chão; sem alvo é um pulo sem gastar a carga.
      if (!car.state.grounded) return;
      const t = this.stompTarget(car, rule.seek);
      this.events.push({ kind: 'special', car: car.id, model: car.model, pos: this.center(car), target: t ?? undefined });
      if (t === null) {
        car.state.vel = add(car.state.vel, v3(0, rule.missHopMph * MPH, 0));
        car.nextFire = now + rule.refire;
        return;
      }
      car.state.vel = add(car.state.vel, v3(0, rule.hopMph * MPH, 0));
      car.action = act('stomp', 1, t);
    } else if (rule.kind === 'leap') {
      // FUN_001927a8 estado 0 → 1 (FUN_00193880): trava no cone e salta reto para cima.
      if (!car.state.grounded) return;
      const t = lockTarget(this.center(car), fwd, targets, rule.lockDeg, rule.range);
      car.action = act('leap', 1, t?.id ?? null);
      car.state.vel = v3(0, rule.jumpMph * MPH, 0);
      this.events.push({ kind: 'special', car: car.id, model: car.model, pos: this.center(car), target: t?.id });
    }
  }

  private fireSpecialNow(car: Car) {
    const fwd = forwardOf(car.state.yaw);
    const targets = this.cars.filter((c) => c !== car && c.deadFor === 0).map((c) => ({ id: c.id, pos: this.center(c) }));
    this.special(car, fwd, targets, Math.max(0, car.state.vel.x * fwd.x + car.state.vel.z * fwd.z), this.bodies());
  }

  /** Gasta a carga e agenda o próximo disparo (FUN_00148748 + carro+0x6300 = agora + obj+0x5c). */
  private spendSpecial(car: Car, refire: number) {
    car.ammo.special = Math.max(0, (car.ammo.special ?? 0) - 1);
    car.nextFire = this.tick + refire;
  }

  /** Solta todos os presos e zera a pose do especial em andamento. */
  private endAction(car: Car) {
    for (const h of car.action?.held ?? []) if (this.cars[h.id].heldBy === car.id) this.cars[h.id].heldBy = null;
    if (car.action?.kind === 'crane' && car.action.target !== null && this.cars[car.action.target].heldBy === car.id) {
      const v = this.cars[car.action.target];
      v.heldBy = null;
      v.pose = undefined;
    }
    car.action = null;
    car.spin = 0;
    car.pose = undefined;
  }

  /** Visada entre dois pontos (FUN_00229780). */
  private clearLine(a: V3, b: V3): boolean {
    const d = sub(b, a);
    const L = len(d);
    return L < 1e-3 || !this.world.raycast(a, scale(d, 1 / L), L);
  }

  /** FUN_001977b8: carro vivo mais perto no chão, não preso, a menos de `range` pés e com visada. */
  stompTarget(car: Car, range: number): number | null {
    let best: number | null = null;
    let bestD = range;
    for (const c of this.cars) {
      if (c === car || c.deadFor > 0 || c.heldBy !== null || !c.state.grounded) continue;
      const d = len(sub(c.state.pos, car.state.pos));
      if (d < bestD && this.clearLine(this.center(car), this.center(c))) {
        bestD = d;
        best = c.id;
      }
    }
    return best;
  }

  /** Ponto da garra do Mr. Slam: carro + R·(0, frente, cima) (FUN_001b2c48, PS2 (0, 12, 13)). */
  private craneHook(car: Car, reach: [number, number]): V3 {
    return add(car.state.pos, add(scale(forwardOf(car.state.yaw), reach[0]), v3(0, reach[1], 0)));
  }

  /**
   * FUN_001b2c48 (o método de disparo roda a cada quadro com o especial selecionado): agarra o carro mais perto
   * do ponto da garra a ≤ grabRadius pés, se houver alguém no cone de 90° a 50 pés e visada.
   */
  private craneGrab(car: Car, fwd: V3, targets: { id: number; pos: V3 }[]) {
    const rule = SPECIALS[car.model];
    if (rule?.kind !== 'crane' || car.action || car.heldBy !== null || this.tick <= car.nextFire || (car.ammo.special ?? 0) <= 0) return;
    const hook = this.craneHook(car, rule.reach);
    let best: Car | null = null;
    let bestD = 10000;
    for (const c of this.cars) {
      if (c === car || c.deadFor > 0 || c.heldBy !== null) continue;
      const d = len(sub(c.state.pos, hook));
      if (d < rule.grabRadius && d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best || !lockTarget(this.center(car), fwd, targets, rule.lockDeg, rule.lockRange)) return;
    if (!this.clearLine(this.center(car), this.center(best))) return;
    best.heldBy = car.id;
    best.pose = { lift: 0, tilt: 0, roll: 0 };
    car.action = { kind: 'crane', phase: 4, t: 0, until: 0, target: best.id, rate: 0, hits: 0, held: [] };
    this.events.push({ kind: 'special', car: car.id, model: car.model, pos: hook, target: best.id });
    this.damage(best.id, rule.grabDamage, car.id, this.center(best));
  }

  /** Especiais que duram (choque do Cop, tornado, garra, pisão, salto). Um tique por passo. */
  private stepAction(car: Car, bodies: CarBody[], now: number) {
    const act = car.action;
    const rule = SPECIALS[car.model];
    if (!act || !rule) return;
    act.t += 1;
    const me = this.center(car);
    if (rule.kind === 'taser') {
      const b = act.target !== null ? bodies.find((x) => x.id === act.target && x.alive) : undefined;
      if (!b || len(sub(b.pos, me)) > rule.range) act.target = null; // FUN_001b86b8: fora do alcance solta
      else {
        const v = this.cars[b.id];
        v.state.vel = scale(v.state.vel, 0.9); // ⚠️ host: o choque segura o alvo
        this.damage(b.id, rule.perTick, car.id, b.pos);
      }
      if (now >= act.until) this.endAction(car);
    } else if (rule.kind === 'tornado') this.stepTornado(car, act, rule);
    else if (rule.kind === 'crane') this.stepCrane(car, act, rule);
    else if (rule.kind === 'stomp') this.stepStomp(car, act, rule);
    else if (rule.kind === 'leap') this.stepLeap(car, act, rule);
    else if (rule.kind === 'volley') this.stepVolley(car, act, rule);
    else if (rule.kind === 'derby') this.stepDerby(car, act, rule);
    else if (rule.kind === 'cannon') this.stepCannon(car, act, rule);
    else if (rule.kind === 'beam') this.stepBeam(car, act, rule);
    else if (rule.kind === 'preach') this.stepPreach(car, act, rule);
    else if (rule.kind === 'tractor') this.stepTractor(car, act, rule);
    else if (rule.kind === 'arc') this.stepArc(car, act, rule);
    else if (rule.kind === 'boost') {
      // FUN_001d06a8 estado 1: no chão, |v| → mph·1,4667 pela frente (FUN_00253128 com fração +0x7c)
      if (act.t > rule.ticks) {
        this.spendSpecial(car, rule.refire);
        this.endAction(car);
      } else if (car.state.grounded) {
        const fwd = forwardOf(car.state.yaw);
        const v = toward(Math.hypot(car.state.vel.x, car.state.vel.z), rule.mph * MPH, rule.rate, 0.001);
        car.state.vel = v3(fwd.x * v, car.state.vel.y, fwd.z * v);
        car.boosting = true;
      }
    }
  }

  /** FUN_00195638: objeto do Derby (voando, preso, desviado). */
  private stepDerby(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'derby' }>) {
    const o = act.obj!;
    o.t += 1;
    const step = rule.mph * 0.024444444; // pés por tique
    const end = () => this.endAction(car);
    if (o.mode === 3) {
      // preso no alvo até o fim do clipe; então o golpe (vtable +0x14, dano +0x18)
      const v = act.target !== null ? this.cars[act.target] : null;
      if (!v || v.deadFor > 0) return end();
      o.pos = add(this.center(v), v3(0, 2, 0));
      if (o.t >= rule.latch) {
        this.damage(v.id, rule.damage, car.id, o.pos);
        this.events.push({ kind: 'explosion', pos: o.pos, weapon: 'special', type: 0x2b });
        end();
      }
      return;
    }
    if (o.mode === 4) {
      // desviado pela casca de fogo: rumo a um ponto sorteado ao lado do alvo por 45 tiques
      if (o.t > 45 || !o.aim) return end();
      o.pos = add(o.pos, scale(sub(o.aim, o.pos), 0.1));
      return;
    }
    if (o.t > rule.life) return end();
    const v = act.target !== null && this.cars[act.target].deadFor === 0 ? this.cars[act.target] : null;
    if (v) {
      const d = sub(this.center(v), o.pos);
      const L = len(d);
      if (L < step) {
        if (v.shell > 0) {
          o.mode = 4;
          o.t = 0;
          const side = this.rand() < 0.5 ? -1 : 1;
          o.aim = add(this.center(v), v3(side * (50 + this.rand() * 5), 5 + this.rand() * 5, -side * (50 + this.rand() * 5)));
        } else {
          o.mode = 3;
          o.t = 0;
        }
        return;
      }
      o.dir = norm(add(scale(o.dir, 0.9), scale(d, 0.1 / Math.max(L, 1e-6))));
    } else o.dir = norm(add(o.dir, v3(0, -0.03, 0))); // sem alvo cai (+0x0c → −1 a 0,03)
    const next = add(o.pos, scale(o.dir, step));
    // FUN_00196290: varredura; cenário acaba, outro carro leva o golpe
    const seg = sub(next, o.pos);
    const hit = this.world.raycast(o.pos, norm(seg), len(seg));
    for (const c of this.cars) {
      if (c === car || c.deadFor > 0 || c === v) continue;
      if (len(sub(this.center(c), next)) < Math.max(4, c.shape.halfWidth)) {
        this.damage(c.id, rule.damage, car.id, next);
        this.events.push({ kind: 'explosion', pos: next, weapon: 'special', type: 0x2b });
        return end();
      }
    }
    if (hit) {
      this.events.push({ kind: 'explosion', pos: o.pos, weapon: 'special', type: 0x2b });
      return end();
    }
    o.pos = next;
  }

  /** FUN_001dcbd8: segurar ergue o canhão; erguido, 10 tiros a cada 19 tiques com trava. */
  private stepCannon(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'cannon' }>) {
    if (act.phase === 1) {
      if (!car.fireWasHeld) {
        car.action = null; // soltou antes de erguer: abaixa (FUN_00127980)
        return;
      }
      if (act.t < rule.raise) return;
      act.phase = 2;
      act.t = 0;
      act.hits = rule.shots;
      car.ammo.special = Math.max(0, (car.ammo.special ?? 0) - 1);
    }
    if (act.hits <= 0) {
      car.nextFire = this.tick + rule.refire;
      car.action = null;
      return;
    }
    if ((act.t - 1) % rule.every !== 0) return;
    act.hits--;
    const fwd = forwardOf(car.state.yaw);
    const targets = this.cars.filter((c) => c !== car && c.deadFor === 0).map((c) => ({ id: c.id, pos: this.center(c) }));
    const t = lockTarget(this.muzzle(car), fwd, targets, rule.lockDeg, 7000);
    this.shoot(car, { proj: rule.proj }, 'special', t?.id ?? null, Math.max(0, car.state.vel.x * fwd.x + car.state.vel.z * fwd.z));
  }

  /** FUN_001e0c58 / FUN_001e0ee0: raio de 200 pés à frente; quem ele toca leva 0,11 por tique (golpe 0x29). */
  private stepBeam(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'beam' }>) {
    if (act.t > rule.ticks) return this.endAction(car);
    const from = this.muzzle(car);
    const fwd = forwardOf(car.state.yaw);
    const wall = this.world.raycast(from, fwd, rule.range);
    const reach = wall ? wall.distance : rule.range;
    let best: Car | null = null;
    let bestT = reach;
    for (const c of this.cars) {
      if (c === car || c.deadFor > 0) continue;
      const d = sub(this.center(c), from);
      const tt = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z;
      if (tt < 0 || tt > bestT) continue;
      const off = len(sub(d, scale(fwd, tt)));
      if (off < Math.max(3, c.shape.halfWidth)) {
        best = c;
        bestT = tt;
      }
    }
    act.target = best?.id ?? null;
    if (best) {
      this.damage(best.id, rule.perTick, car.id, this.center(best));
      this.ignite(best, car.id); // tipo 0x29 → FUN_00120778
    }
  }

  /** FUN_001db178 estado 2: 0x2f a cada 15 tiques e 0x2e a cada novo toque, por 300 tiques. */
  private stepPreach(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'preach' }>) {
    const fwd = forwardOf(car.state.yaw);
    const speed = Math.max(0, car.state.vel.x * fwd.x + car.state.vel.z * fwd.z);
    if (act.t > rule.ticks) {
      car.nextFire = this.tick + rule.refire;
      car.action = null;
      return;
    }
    if ((act.t - 1) % rule.every === 0) this.shoot(car, { proj: rule.proj }, 'special', null, speed);
    // novo toque: soltou (+0x41 = 1) e apertou de novo
    if (!car.fireWasHeld) act.hits = 1;
    else if (act.hits === 1) {
      act.hits = 0;
      this.shoot(car, { proj: rule.pressProj }, 'special', null, speed);
    }
  }

  /** FUN_001d8160: trava acumula carga; o 2º toque dispara carga/60 + 1 tiros com rumo ±7°·i. */
  private stepTractor(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'tractor' }>) {
    const fwd = forwardOf(car.state.yaw);
    if (act.t > rule.ticks) {
      car.action = null;
      return;
    }
    const targets = this.cars.filter((c) => c !== car && c.deadFor === 0).map((c) => ({ id: c.id, pos: this.center(c) }));
    const t = lockTarget(this.center(car), fwd, targets, rule.lockDeg, rule.range);
    act.target = t?.id ?? null;
    act.rate = t ? act.rate + 1 : Math.max(0, act.rate - 1);
    if (!car.fireWasHeld) act.hits = 1;
    else if (act.hits === 1 && this.tick > car.nextFire) {
      const n = Math.max(1, Math.floor(act.rate / rule.per) + 1);
      const D = Math.PI / 180;
      for (let i = 0; i < n; i++) {
        const yaw = i === 0 ? 0 : (i & 1 ? rule.stepDeg : -rule.stepDeg) * i * D;
        this.shoot(car, { proj: rule.proj, yaw }, 'special', act.target, Math.max(0, car.state.vel.x * fwd.x + car.state.vel.z * fwd.z));
      }
      this.spendSpecial(car, rule.refire);
      car.action = null;
    }
  }

  /** FUN_001c8ee8 / FUN_001c9450: carrega enquanto segura; ao soltar dispara n × proj com arfagem e rumo sorteados. */
  private stepVolley(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'volley' }>) {
    const n = Math.min(rule.max, (act.t >> 5) + 1);
    if (car.fireWasHeld) {
      if (act.t > rule.giveUp) {
        // segurou demais: perde a carga sem disparar
        this.spendSpecial(car, rule.refire);
        car.action = null;
      }
      return;
    }
    const fwd = forwardOf(car.state.yaw);
    const targets = this.cars.filter((c) => c !== car && c.deadFor === 0).map((c) => ({ id: c.id, pos: this.center(c) }));
    const t = lockTarget(this.muzzle(car), fwd, targets, rule.lockDeg, 7000);
    const D = Math.PI / 180;
    for (let i = 0; i < n; i++)
      this.shoot(car, { proj: rule.proj, pitchRange: [rule.pitchDeg[0] * D, rule.pitchDeg[1] * D], yawRange: [rule.yawDeg[0] * D, rule.yawDeg[1] * D] }, 'special', t?.id ?? null, 0);
    this.spendSpecial(car, rule.refire);
    car.action = null;
  }

  /** FUN_001e4670 estados 1..3 + FUN_001e4d30 (captura) + FUN_001e54b0 (órbita e arremesso). */
  private stepTornado(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'tornado' }>) {
    const pose = (car.pose ??= { lift: 0, tilt: 0, roll: 0 });
    if (act.phase === 1 || act.phase === 2) {
      // inclina até −75°, giro rumo a −0,6 rad/tique (fração 0,04 no preparo, 0,05 girando), sobe 9 pés no preparo
      pose.tilt = toward(pose.tilt, rule.tilt, 0.04, 0.001);
      act.rate = toward(act.rate, rule.spinRate, act.phase === 1 ? 0.04 : 0.05, 0.001);
      if (act.phase === 1) pose.lift = toward(pose.lift, rule.lift, 0.04, 0.001);
      car.spin += act.rate;
      if (act.phase === 1 && act.t > rule.prep) {
        act.phase = 2;
        act.t = 0;
      } else if (act.phase === 2) {
        this.tornadoCapture(car, act, rule);
        this.tornadoOrbit(car, act, rule);
        if (act.t > rule.spin) {
          // FUN_001e5fb8(3): zera os tempos e solta todos de uma vez
          for (const h of act.held) h.timer = 0;
          this.tornadoOrbit(car, act, rule);
          act.phase = 3;
          act.t = 0;
        }
      }
      return;
    }
    // estado 3: endireita (giro → 0, inclinação → 0, desce a 0,08) e no fim gasta a carga
    pose.tilt = toward(pose.tilt, 0, act.t > rule.recover / 2 ? 0.1 : 0.04, 0.001);
    act.rate = toward(act.rate, 0, 0.04, 0.001);
    car.spin += act.rate;
    pose.lift = toward(pose.lift, 0, 0.08, 0.001);
    if (act.t > rule.recover) {
      this.spendSpecial(car, rule.refire);
      this.endAction(car);
    }
  }

  private tornadoCenter(car: Car): V3 {
    return add(car.state.pos, v3(0, car.pose?.lift ?? 0, 0));
  }

  /**
   * FUN_001e4d30: esfera de raio +0xa0 em volta da origem do carro (FUN_0022c5a8, não do centro elevado), sem
   * visada; vítima viva com vida > 0 e a vaga dela (índice do jogador +0x6330) livre.
   */
  private tornadoCapture(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'tornado' }>) {
    const c0 = this.tornadoCenter(car);
    for (const v of this.cars) {
      if (v === car || v.deadFor > 0 || v.health <= 0 || v.heldBy !== null || act.held.length >= 8) continue;
      if (len(sub(v.state.pos, car.state.pos)) > rule.radius) continue;
      if ((this.recapture.get(car.id * 64 + v.id) ?? 0) > this.tick) continue;
      // FUN_001e5198: raio e ângulo atuais viram a órbita; impulso de 65 mph para cima; dano +0x80
      const d = sub(v.state.pos, c0);
      act.held.push({ id: v.id, angle: Math.atan2(d.x, d.z), dist: Math.hypot(d.x, d.z), timer: rule.holdTicks });
      v.heldBy = car.id;
      v.state.vel = add(v.state.vel, v3(0, rule.captureLiftMph * MPH, 0));
      this.damage(v.id, rule.captureDamage, car.id, this.center(v));
    }
  }

  private tornadoOrbit(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'tornado' }>) {
    const c0 = this.tornadoCenter(car);
    for (const h of [...act.held]) {
      const v = this.cars[h.id];
      const release = (vel: V3) => {
        act.held.splice(act.held.indexOf(h), 1);
        if (v.heldBy === car.id) v.heldBy = null;
        v.state.vel = vel;
        this.recapture.set(car.id * 64 + v.id, this.tick + rule.recapture);
      };
      if (v.deadFor > 0) {
        release(v.state.vel);
        continue;
      }
      h.timer -= 1;
      if (h.timer <= 0) {
        // arremesso: 80 mph na direção do ângulo da órbita, 20° acima (massa·117,33 / massa)
        const c = Math.cos(rule.throwPitch);
        release(scale(v3(Math.sin(h.angle) * c, Math.sin(rule.throwPitch), Math.cos(h.angle) * c), rule.throwMph * MPH));
        continue;
      }
      const prev = { ...v.state.pos };
      h.angle -= rule.orbitRate; // −0,15 rad/tique, no sentido do giro
      h.dist = toward(h.dist, rule.orbitRadius, 0.03, 0.001);
      const y = toward(v.state.pos.y, c0.y + rule.orbitHeight, 0.05, 0.001);
      const next = v3(c0.x + Math.sin(h.angle) * h.dist, y, c0.z + Math.cos(h.angle) * h.dist);
      // batida no cenário preso: dano 5 e solta (FUN_0022bfe0 entre a posição anterior e a nova)
      const seg = sub(next, prev);
      const L = len(seg);
      if (L > 1e-3 && this.world.raycast(prev, scale(seg, 1 / L), L)) {
        this.damage(v.id, rule.wallDamage, car.id, prev);
        release(v3());
        continue;
      }
      v.state.vel = scale(seg, 60);
      v.state.pos = next;
      v.state.yaw += rule.orbitRate;
      this.damage(v.id, rule.holdDamage, car.id, next);
    }
  }

  /** FUN_001b1fc0: segura no ponto da garra durante o clipe 0x1b, bate nas fases e arremessa no fim. */
  private stepCrane(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'crane' }>) {
    const v = act.target !== null ? this.cars[act.target] : null;
    const f = act.t / rule.clipTicks;
    if (v && v.heldBy === car.id && v.deadFor === 0) {
      if (act.hits < rule.phases.length && f >= rule.phases[act.hits]) {
        act.hits++;
        car.state.vel = add(car.state.vel, v3(0, 11.733334, 0)); // impulso do Slam a cada batida (FUN_00136128)
        this.events.push({ kind: 'special', car: car.id, model: car.model, pos: this.center(v), target: v.id });
        this.damage(v.id, rule.slamDamage, car.id, this.center(v));
      }
      if (f <= 0.93 && v.deadFor === 0) {
        // posição rumo ao gancho com fração crescendo até 0,99 (0,15 por tique), de cabeça para baixo
        act.rate = toward(act.rate, 0.99, 0.15, 0.001);
        const hook = this.craneHook(car, rule.reach);
        const p = v.state.pos;
        v.state.pos = v3(p.x + (hook.x - p.x) * act.rate, p.y + (hook.y - p.y) * act.rate, p.z + (hook.z - p.z) * act.rate);
        v.state.vel = { ...car.state.vel };
        v.pose = { lift: 0, tilt: 0, roll: toward(v.pose?.roll ?? 0, Math.PI, act.rate, 0.001) };
      }
    }
    if (f < 1) return;
    this.spendSpecial(car, rule.refire);
    if (v && v.heldBy === car.id) {
      v.heldBy = null;
      v.pose = undefined;
      if (v.deadFor === 0) {
        // parede entre os dois: sai pela normal a 50 mph; senão arremesso a 200 mph + vel. do Slam, 15° acima
        const a = this.center(car);
        const d = sub(this.center(v), a);
        const L = len(d);
        const hit = L > 1e-3 ? this.world.raycast(a, scale(d, 1 / L), L) : null;
        if (hit) v.state.vel = scale(hit.normal, 73.333336);
        else {
          const fwd = forwardOf(car.state.yaw);
          const speed = rule.throwMph * MPH + Math.max(0, car.state.vel.x * fwd.x + car.state.vel.z * fwd.z);
          const pitch = rule.throwPitchDeg * (Math.PI / 180);
          v.state.vel = add(scale(fwd, speed * Math.cos(pitch)), v3(0, speed * Math.sin(pitch), 0));
        }
      }
    }
    car.action = null;
  }

  /** FUN_00170c30: alvo no cone e no alcance do Dark Tooth; trava com o golpe inicial (FUN_00170d30, +0x7c). */
  private arcLock(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'arc' }>) {
    const targets = this.cars.filter((c) => c !== car && c.deadFor === 0).map((c) => ({ id: c.id, pos: this.center(c) }));
    const t = lockTarget(this.center(car), forwardOf(car.state.yaw), targets, rule.lockDeg, rule.range);
    act.target = t?.id ?? null;
    if (t) this.damage(t.id, rule.hitDamage, car.id, t.pos);
  }

  /** FUN_0016fe00 estado 1: dura `ticks`; segurando o botão, golpe por tique no alvo; longe demais procura outro. */
  private stepArc(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'arc' }>) {
    if (act.t > rule.ticks) {
      // FUN_00170dc8: gasta e espera
      this.spendSpecial(car, rule.refire);
      this.endAction(car);
      return;
    }
    const v = act.target !== null ? this.cars[act.target] : null;
    if (!v || v.deadFor > 0 || len(sub(this.center(v), this.center(car))) >= rule.range) {
      act.target = null;
      this.arcLock(car, act, rule);
      return;
    }
    if (car.fireWasHeld) this.damage(v.id, rule.perTick, car.id, this.center(v));
  }

  /** FUN_00196b60 estados 1..3: espera 31 tiques no ar, cai em cima do alvo (dano) e esmaga por 30 tiques. */
  private stepStomp(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'stomp' }>) {
    const finish = () => {
      this.spendSpecial(car, rule.refire);
      this.endAction(car);
    };
    if (act.phase === 1) {
      if (act.t < rule.wait) return;
      act.t = 0;
      if (act.target === null || this.cars[act.target].deadFor > 0) {
        act.target = null;
        act.phase = 3;
        return;
      }
      act.phase = 2;
      this.damage(act.target, rule.damage, car.id, this.center(this.cars[act.target])); // FUN_00197da0(2) → FUN_00197c68(+0x78)
      return;
    }
    if (act.phase === 3) {
      // sem alvo: 30 tiques procurando de novo (FUN_001977b8); achou → estado 2 com o dano
      if (act.t > rule.ride) return finish();
      const t = this.stompTarget(car, rule.seek);
      if (t !== null) {
        act.target = t;
        act.phase = 2;
        act.t = 0;
        this.damage(t, rule.damage, car.id, this.center(this.cars[t]));
      }
      return;
    }
    const v = this.cars[act.target!];
    if (act.t > rule.ride || v.deadFor > 0 || len(sub(v.state.pos, car.state.pos)) > 250) {
      // sai com um pulo de 88 pés/s (FUN_00136128 (0, 0, 88))
      car.state.vel = add(car.state.vel, v3(0, rule.hopMph * MPH, 0));
      return finish();
    }
    // posição rumo ao teto do alvo (+10 pés, +4 na altura) a 0,15/0,1 por tique; alvo parado no plano
    const p = car.state.pos;
    const goal = add(v.state.pos, v3(0, rule.rideHeight + 4, 0));
    car.state.pos = v3(toward(p.x, goal.x, 0.15, 0.001), toward(p.y, goal.y, 0.1, 0.001), toward(p.z, goal.z, 0.15, 0.001));
    car.state.vel = v3();
    v.state.vel = v3(0, v.state.vel.y, 0);
  }

  /** FUN_001927a8 estados 1..2: sobe 45 tiques, para no ar e mergulha no alvo; a 5 pés acerta (FUN_00193198). */
  private stepLeap(car: Car, act: SpecialAction, rule: Extract<SpecialRule, { kind: 'leap' }>) {
    const v = act.target !== null ? this.cars[act.target] : null;
    if (act.phase === 1) {
      if (!v) {
        // sem alvo: gasta a carga e só pula
        this.spendSpecial(car, rule.refire);
        car.action = null;
        return;
      }
      car.state.yaw = toward(car.state.yaw, Math.atan2(v.state.pos.x - car.state.pos.x, v.state.pos.z - car.state.pos.z), 0.05, 0.001);
      if (act.t <= rule.climb) return;
      car.state.vel = v3();
      act.phase = 2;
      act.t = 0;
      return;
    }
    if (!v || v.deadFor > 0 || act.t > rule.timeout) {
      car.action = null; // vtable +0x34: desiste
      car.nextFire = this.tick + rule.refire;
      return;
    }
    const prev = { ...car.state.pos };
    act.rate = toward(act.rate, 0.5, 0.09, 0.001);
    const g = v.state.pos;
    const next = v3(prev.x + (g.x - prev.x) * act.rate, prev.y + (g.y - prev.y) * act.rate, prev.z + (g.z - prev.z) * act.rate);
    const seg = sub(next, prev);
    const L = len(seg);
    const lift = v3(0, (car.shape.top + car.shape.bottom) / 2, 0);
    if (L > 1e-3 && this.world.raycast(add(prev, lift), scale(seg, 1 / L), L)) {
      // bateu no cenário: volta a 88 pés/s e espera (sem gastar a carga)
      car.state.vel = scale(norm(sub(prev, next)), 88);
      car.nextFire = this.tick + rule.refire;
      car.action = null;
      return;
    }
    car.state.pos = next;
    car.state.vel = scale(seg, 60);
    car.state.yaw = toward(car.state.yaw, Math.atan2(g.x - prev.x, g.z - prev.z), 0.05, 0.001);
    if (len(sub(v.state.pos, car.state.pos)) >= 5) return;
    // FUN_00193198: dano +0x70, alvo sobe a 176 pés/s com metade da velocidade do Grasshopper no plano
    v.state.vel = v3(car.state.vel.x * 0.5, rule.hitLiftMph * MPH, car.state.vel.z * 0.5);
    car.state.vel = scale(car.state.vel, 0.25);
    this.damage(v.id, rule.damage, car.id, this.center(v));
    this.events.push({ kind: 'special', car: car.id, model: car.model, pos: this.center(v), target: v.id });
    this.spendSpecial(car, rule.refire);
    car.action = null;
  }

  /**
   * Ataques de energia pelos bits de controle+0x1c (combos do humano, FUN_0012c9b8; decisões da IA em
   * jogador+0x13c): casca de fogo (FUN_00123010; o humano paga 0,6 no combo, a IA não paga), congelar
   * (FUN_0014d588), mina (FUN_0014c208, só no chão) e onda (FUN_0014c648) — estas exigem energia acima do custo,
   * gastam-no e esperam `refire`.
   */
  private energyAttacks(car: Car) {
    if (car.heldBy !== null) return;
    const now = this.tick;
    const fwd = forwardOf(car.state.yaw);
    const bits = car.ctl;
    const fired = (kind: EnergyKind) => this.events.push({ kind: 'energy', car: car.id, what: kind, pos: this.center(car) });
    // FUN_0012d1b8: só com energia ≥ 0,6, sem casca e não congelado; o combo já gasta.
    if (bits & BIT.shell && car.shell === 0) {
      if (car.bot) car.shell = SHELL_TICKS;
      else if (car.energy >= ENERGY.shell.cost) {
        car.shell = SHELL_TICKS;
        car.energy = Math.max(0, car.energy - ENERGY.shell.cost);
      }
      if (car.shell > 0) fired('shell');
    }
    if (now <= car.nextFire) return;
    const targets = this.cars.filter((c) => c !== car && c.deadFor === 0).map((c) => ({ id: c.id, pos: this.center(c) }));
    const carSpeed = Math.max(0, car.state.vel.x * fwd.x + car.state.vel.z * fwd.z);
    const spend = (kind: EnergyKind) => {
      car.energy = Math.max(0, car.energy - ENERGY[kind].cost);
      car.nextFire = now + ENERGY[kind].refire;
      fired(kind);
    };
    if (bits & BIT.freeze && car.energy > ENERGY.freeze.cost) {
      const from = this.local(car, FREEZE_MUZZLE); // FUN_0014d478: obj+0x10 → obj+0x60
      const t = lockTarget(from, fwd, targets, 30, 7000); // FUN_0014d478(30, 7000)
      const scene = t ? null : this.sceneLock(from, fwd, 30, 7000); // FUN_00147cf0
      this.shoot(car, { proj: 0xe }, 'energy', t?.id ?? null, carSpeed, from, false, scene ?? undefined);
      spend('freeze');
    } else if (bits & BIT.mine && car.energy > ENERGY.mine.cost && car.state.grounded) {
      // FUN_0014c0d0: obj+0x10 → obj+0x60 = (0, −3, −1) no quadro do carro ((0, 0, −1) em alguns); sai virada para trás
      const back = this.local(car, dropPoint(car.model));
      this.shoot(car, { proj: 0xd }, 'energy', null, 0, back, true);
      spend('mine');
    } else if (bits & BIT.blast && car.energy > ENERGY.blast.cost) {
      this.blast(car);
      spend('blast');
    }
  }

  /** Onda de energia (FUN_0014ca00): dano e chute nos carros do raio; detona os projéteis dentro dele. */
  private blast(car: Car) {
    const me = this.center(car);
    const radius = car.model === 'dark2' ? BLAST.radius * 1.5 * 1.5 : BLAST.radius;
    for (const v of this.cars) {
      if (v === car || v.deadFor > 0 || len(sub(this.center(v), me)) > radius) continue;
      const boss = v.model === 'edboss' || v.model === 'dark1' || v.model === 'dark2';
      // no chão e quase parado (< 7,33 pés/s): sobe a 50 mph (massa·73,33 / massa)
      if (!boss && v.state.grounded && Math.hypot(v.state.vel.x, v.state.vel.z) < BLAST.kickBelow)
        v.state.vel = add(v.state.vel, v3((this.rand() * 2 - 1), BLAST.kickMph * MPH, (this.rand() * 2 - 1)));
      this.damage(v.id, BLAST.damage, car.id, this.center(v));
    }
    for (const p of this.projectiles) if (p.alive && len(sub(p.pos, me)) < radius) p.detonate = true;
  }

  /**
   * Início do ataque de ambiente (ARENA: FUN_001d7a80 + estado 1 de FUN_001d7b48): som, jatos dos bocais, clarão e
   * um projétil para cada carro vivo que não é o dono, saindo do ponto de índice igual ao do carro.
   */
  private startEnv(owner: Car) {
    const rule = this.env!;
    this.events.push({ kind: 'env', fx: 'start', pos: rule.sound.at, color: 0xffffff });
    rule.nozzles.forEach((pos, i) => this.events.push({ kind: 'env', fx: 'jet', pos, color: rule.colors[i] }));
    this.events.push({ kind: 'env', fx: 'flash', pos: rule.flash, color: 0xffffff });
    for (const car of this.cars) {
      if (car.id === owner.id || car.deadFor > 0) continue;
      const from = this.envMouth(envOrigin(rule, car.id));
      const to = this.center(car);
      const d = sub(to, from);
      const p = fire(rule.proj, 'env', owner.id, from, scale(d, 1 / Math.max(1e-6, len(d))), car.id, { rand: this.rand });
      this.projectiles.push(p);
    }
    this.envActive = { owner: owner.id, timer: rule.sparkTicks };
  }

  /**
   * ⚠️ host: os bocais da ARENA ficam dentro dos aparelhos de pirotecnia (objetos destrutíveis 836–850 da fase) e
   * 0,1 pé abaixo do piso do palco; com a malha visual como colisão o raio explodiria ali. Sai do topo da superfície
   * que estiver até 5 pés acima (mais 1 pé) e ignora tudo a até 6 pés de qualquer bocal (envWorld).
   */
  private envMouth(p: V3): V3 {
    const hit = this.world.raycast(v3(p.x, p.y + 5, p.z), v3(0, -1, 0), 6);
    return hit ? v3(p.x, p.y + 5 - hit.distance + 1, p.z) : p;
  }

  /** Estado 2 do ataque de ambiente: faíscas em volta do clarão até acabar o tempo (FUN_002646f8 = tiques passados). */
  private stepEnv(dt: number) {
    const rule = this.env;
    const a = this.envActive;
    if (!rule || !a) return;
    a.timer -= dt * 60;
    if (a.timer < 1) this.envActive = null;
    if (Math.floor(this.rand() * rule.sparkOdds) === 0) {
      const color = rule.colors[Math.floor(this.rand() * rule.colors.length)];
      this.events.push({ kind: 'env', fx: 'spark', pos: envSpark(rule, this.rand), color });
    }
  }

  private stepProjectiles(dt: number) {
    const bodies = this.bodies();
    for (const p of this.projectiles) {
      const bounces = p.bounces;
      const hit = stepProjectile(p, dt, p.weapon === 'env' && this.envWorld ? this.envWorld : (this.projectileWorld ?? this.world), bodies, this.rand);
      if (p.bounces > bounces) this.events.push({ kind: 'bounce', pos: { ...p.pos } });
      if (hit) this.detonate(hit, bodies);
    }
    this.projectiles = this.projectiles.filter((p) => p.alive);
  }

  private detonate(hit: HitResult, bodies: CarBody[]) {
    const p = hit.projectile;
    if (hit.tag !== undefined && hit.victim === null)
      this.events.push({ kind: 'worldHit', tag: hit.tag, weapon: p.weapon, amount: p.damage, pos: hit.pos, vel: p.vel });
    if (isBullet(p.type)) this.events.push({ kind: 'bulletHit', pos: hit.pos, car: hit.victim !== null, type: p.type, vel: p.vel, normal: hit.normal });
    else this.events.push({ kind: 'explosion', pos: hit.pos, weapon: p.weapon, type: p.type, vel: p.vel, normal: hit.normal, hitCar: hit.victim !== null });
    for (const [id, dmg] of damageFromHit(hit, bodies)) {
      this.damage(id, dmg, p.owner, hit.pos);
      this.hitEffect(this.cars[id], p, hit.pos);
    }
    // Congelar (tipo 0xe, FUN_0011f280 → FUN_00120838): 300 tiques, chefes Dark imunes, quem já está congelado não renova.
    if (p.type === 0xe && hit.victim !== null) {
      const v = this.cars[hit.victim];
      if (v.deadFor === 0 && v.frozen === 0 && v.model !== 'dark1' && v.model !== 'dark2') {
        v.frozen = FREEZE.ticks;
        v.swarmCharge = null;
        this.events.push({ kind: 'energy', car: v.id, what: 'frozen', pos: this.center(v) });
      }
    }
  }

  /**
   * Efeito do golpe por tipo de projétil (FUN_0011f280, mensagem: +0x10 = velocidade do projétil em pés/s, +0x20 =
   * ponto). Impulsos = massa·k (Δv = k) via FUN_00136048 / FUN_001360b8, só com carro+0x6400 < 1 (depois espera 12
   * quadros) e o carro abaixo de 73,33 pés/s; ⚠️ o ponto de aplicação (torque) é ignorado. 0x20/0x21/0x29 acendem fogo.
   */
  private hitEffect(v: Car, p: Projectile, at: V3) {
    if (v.deadFor > 0) return;
    const kick = (dv: V3) => {
      if (v.kickWait > 0) return;
      v.kickWait = 12;
      if (Math.hypot(v.state.vel.x, v.state.vel.z) < 73.333336) v.state.vel = add(v.state.vel, dv);
    };
    // direção carro − explosão com +50 pés para cima, normalizada (FUN_0011f280 casos 0x0a/0x16/0x2b/0x33)
    const away = () => norm(add(sub(v.state.pos, at), v3(0, 50, 0)));
    const t = p.type;
    if (t === 6) kick(v3(p.vel.x * 0.25, 44, p.vel.z * 0.25));
    else if (t === 7) {
      const k = v.state.grounded ? 0.45 : 0.0035;
      kick(v3(p.vel.x * k, p.vel.y * k + 50 / (v.shape.drive?.mass ?? 1), p.vel.z * k));
    } else if (t === 10) {
      if (v.state.grounded && Math.hypot(v.state.vel.x, v.state.vel.z) < 7.3333335) kick(scale(away(), 110));
    } else if (t === 0x16 || t === 0x2b) {
      kick(scale(away(), 73.333336));
      // partículas 0x3c, 2 × 0x3e e 0x3b na cor gp−0x7d78 (⚠️ o jogo só solta com o clipe do Hearse ≥ 0,75)
      this.events.push({ kind: 'hitFx', car: v.id, pos: { ...v.state.pos } });
    }
    else if (t === 0x1e || t === 0x2c) kick(v3(0, 58.666668, 0));
    else if (t === 0x33) kick(scale(away(), 58.666668));
    else if ((t === 0x20 || t === 0x21 || t === 0x29) && p.owner !== null) this.ignite(v, p.owner);
  }

  /** FUN_00120778: acende (não com casca, nem no Dark2, nem se já queima); FUN_0017f1e8 guarda 300 tiques. */
  private ignite(v: Car, by: number) {
    if (v.burning > 0 || v.shell > 0 || v.model === 'dark2') return;
    v.burning = 300;
    v.burnBy = by;
    this.events.push({ kind: 'burn', car: v.id, on: true });
  }

  private extinguish(car: Car) {
    if (car.burning > 0) this.events.push({ kind: 'burn', car: car.id, on: false });
    car.burning = 0;
    car.burnBy = null;
  }

  /** FUN_0017f400: a cada tique um golpe tipo 0x29 de 0,01 de quem acendeu; no fim apaga (FUN_0017f3a0). */
  private stepBurn(car: Car) {
    if (car.burning <= 0) return;
    if (--car.burning < 1) return this.extinguish(car);
    this.damage(car.id, 0.01, car.burnBy, this.center(car));
  }

  private damage(id: number, amount: number, by: number | null, at: V3) {
    const car = this.cars[id];
    if (car.deadFor > 0) return;
    this.events.push({ kind: 'hit', car: id, amount, pos: at });
    car.health -= amount;
    if (car.health <= 0) {
      car.health = 0;
      car.deadFor = 1e-6;
      this.endAction(car);
      this.extinguish(car);
      if (car.heldBy !== null) {
        const h = this.cars[car.heldBy].action;
        if (h) h.held = h.held.filter((x) => x.id !== car.id);
        car.heldBy = null;
        car.pose = undefined;
      }
      car.deaths++;
      if (by !== null && by !== id) this.cars[by].kills++;
      this.events.push({ kind: 'killed', victim: id, killer: by, pos: at });
      this.events.push({ kind: 'explosion', pos: this.center(car), weapon: 'power', type: 6 });
    }
  }

  /**
   * Pickups (FUN_001bc6f8 → FUN_00120ba0): arma +2 até a soma do compartimento chegar a 30; vida +30/+100 só se
   * faltar vida; turbo enche só se não estiver cheio. Recusado = fica no lugar e avisa "… Bay Full" (a cada 120
   * tiques). Volta depois de U(mín, mín·3/2) s (0x2c3a70, FUN_001bc970).
   */
  private stepPickups(dt: number) {
    for (const p of this.pickups) {
      if (p.respawnIn > 0) {
        p.respawnIn = Math.max(0, p.respawnIn - dt);
        continue;
      }
      for (const car of this.cars) {
        if (car.deadFor > 0) continue;
        const d = len(sub(this.center(car), p.pos));
        if (d > PICKUP_RULES.radius + car.shape.halfWidth) continue;
        const eff = pickupEffect(p.id);
        const full = (bay: 'weapon' | 'health' | 'turbo') => {
          if ((car.bayFullCooldown ?? 0) <= this.time) this.events.push({ kind: 'bayFull', car: car.id, bay });
          car.bayFullCooldown = this.time + PICKUP_RULES.fullMessageTicks / 60;
        };
        if (eff.kind === 'weapon') {
          const total = INVENTORY_ORDER.reduce((s, w) => s + (car.ammo[w] ?? 0), 0);
          if (total >= PICKUP_RULES.weaponBay) {
            full('weapon');
            continue;
          }
          car.ammo[eff.weapon] = (car.ammo[eff.weapon] ?? 0) + Math.min(eff.amount, PICKUP_RULES.weaponBay - total);
        } else if (eff.kind === 'health') {
          if (car.health >= MATCH_RULES.maxHealth) {
            full('health');
            continue;
          }
          car.health = Math.min(MATCH_RULES.maxHealth, car.health + eff.amount);
        } else if (eff.kind === 'turbo') {
          if (car.turbo >= MATCH_RULES.turboMax) {
            full('turbo');
            continue;
          }
          car.turbo = MATCH_RULES.turboMax;
        }
        const [lo, hi] = pickupRespawnRange(p.id);
        p.respawnIn = (lo * 60 + Math.floor(this.rand() * ((hi - lo) * 60 + 1))) / 60;
        this.events.push({ kind: 'pickup', car: car.id, pickupId: p.id, name: eff.kind === 'weapon' ? weaponName(eff.weapon) : eff.kind === 'health' ? 'Health' : 'Turbo' });
        break;
      }
    }
  }

  private brainOf(car: Car): BotBrain {
    if (!car.brain) {
      const t = this.ai?.tables;
      const i = car.aiIndex ?? -1;
      const profile = t?.profiles[i] ?? DEFAULT_PROFILE;
      const empty = new Array<number>(15).fill(0);
      const tables: AiTables = t ?? { profiles: [], front: [], rear: [], range: { max: [], min: [], dot: [] } };
      car.brain = new BotBrain(profile, t?.front[i] ?? empty, t?.rear[i] ?? empty, tables, this.ai?.difficulty ?? 1);
    }
    return car.brain;
  }

  /** Linha de visada entre dois carros na altura do perfil (FUN_00105520 → FUN_00229780). */
  private lineOfSight(a: Car, b: Car, height: number): boolean {
    const from = add(a.state.pos, v3(0, height, 0));
    const to = add(b.state.pos, v3(0, height, 0));
    const d = sub(to, from);
    const L = len(d);
    return L < 1e-3 || !this.world.raycast(from, scale(d, 1 / L), L);
  }

  /**
   * IA do bot (src/game/ai.ts, regras do ELF) + navegação do host: mira direto no alvo (ou na vida mais perto ao
   * recuar) e dá ré quando atola.
   */
  private botActions(car: Car, bodies: CarBody[]): CarActions {
    const brain = this.brainOf(car);
    const pos = car.state.pos;
    const fwd = forwardOf(car.state.yaw);
    const targets = bodies.filter((b) => b.alive && b.id !== car.id).map((b) => ({ id: b.id, pos: b.pos }));
    const target = pickTarget(this.center(car), fwd, targets);
    const tc = target ? this.cars[target.id] : null;
    // Recuo: vida abaixo do limiar do perfil -> vida mais perto (FUN_001049a8 → modo 2).
    const health01 = car.health / MATCH_RULES.maxHealth;
    const lowHealth = health01 < brain.retreatAt;
    let goal = target?.pos ?? null;
    if (lowHealth || !goal) {
      let best: Pickup | null = null;
      let bestD = Infinity;
      for (const p of this.pickups) {
        if (p.respawnIn > 0) continue;
        const eff = pickupEffect(p.id);
        if (lowHealth && eff.kind !== 'health') continue;
        const d = len(sub(p.pos, pos));
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best) goal = best.pos;
    }
    if (!goal) return { ...NO_ACTIONS, throttle: 0.6, steer: 0.3 };
    const to = sub(goal, pos);
    const dist = len(to);
    const right = v3(-Math.cos(car.state.yaw), 0, Math.sin(car.state.yaw));
    const f = (to.x * fwd.x + to.z * fwd.z) / Math.max(dist, 1e-6);
    const r = (to.x * right.x + to.z * right.z) / Math.max(dist, 1e-6);
    const ang = Math.atan2(r, f);
    const speed = Math.hypot(car.state.vel.x, car.state.vel.z);
    // Visão do alvo para a IA (+0x308 distância, +0x2c4 alinhamento, +0x2d4 alvo virado para mim).
    let view = { dist: 1e9, align: -1, targetFacing: -1, targetSpeedMph: 0, visible: false };
    if (tc) {
      const d = sub(tc.state.pos, pos);
      const L = Math.max(len(d), 1e-6);
      const tf = forwardOf(tc.state.yaw);
      view = {
        dist: L,
        align: (d.x * fwd.x + d.z * fwd.z) / L,
        targetFacing: -(d.x * tf.x + d.z * tf.z) / L,
        targetSpeedMph: Math.hypot(tc.state.vel.x, tc.state.vel.z) * 0.6818182,
        visible: this.lineOfSight(car, tc, brain.profile.losHeight),
      };
    }
    const out = brain.step({
      ...view,
      health01,
      turbo01: car.turbo / MATCH_RULES.turboMax,
      speed,
      steerAngle: ang,
      ammo: car.ammo,
      selected: car.selected,
      energy: car.energy,
      frozen: car.frozen > 0,
      frame: this.tick,
      shared: this.aiShared,
      // DAT_003277dc/e0 (🟡): no deathmatch do port = abates dos humanos sobre o número de bots
      rivalsDone: Math.min(this.botCount(), this.cars.filter((c) => !c.bot).reduce((n, c) => n + c.kills, 0)),
      rivalsTotal: this.botCount(),
      steerCmd: car.steer,
    });
    if (out.grant) car.ammo[out.grant] = Math.max(car.ammo[out.grant] ?? 0, 1); // FUN_00107148
    // ⚠️ host: atolado por 1,5 s (90 quadros abaixo de 4,4 pés/s) → 1 s de ré girando.
    if (car.botReverse > 0) car.botReverse -= 1 / 60;
    else if (brain.stuck > 90 && dist > 20) {
      car.botReverse = 1;
      brain.stuck = 0;
    }
    const stuck = car.botReverse > 0;
    return {
      throttle: stuck ? 0 : 1,
      brake: stuck ? 1 : 0,
      steer: stuck ? -Math.sign(ang) : Math.max(-1, Math.min(1, ang * 2)),
      handbrake: Math.abs(ang) > 1.4 && speed > 40,
      fireGun: out.fireGun && !lowHealth,
      fireSpecial: out.fireSpecial,
      nextWeapon: out.nextWeapon,
      turbo: !stuck && out.turbo,
      ctl: out.bits,
    };
  }

  private botCount() {
    return this.cars.filter((c) => c.bot).length;
  }
}
