// Deathmatch numa arena. Uso: play.html?lvl=arena&car=axel&bots=3
import * as THREE from 'three';
import { assetURL, loadModel, type ModelDoc } from './assets';
import { AudioEngine } from './audio';
import { LevelCollision } from './collision';
import { PS2_TO_THREE, VEHICLE_TO_THREE } from './coords';
import { Input } from './input';
import { INVENTORY_INDEX, Match, MATCH_RULES, type CarActions, type MatchEvent } from './game/match';
import { Hud, SHORT_NAMES, type HudBlip } from './hud';
import { isBullet, pickupEffect, PROJECTILES, type Projectile, type WeaponId } from './game/weapons';
import { basisOf, forwardOf, rightOf, speedOf, type DriveParams, type VehicleShape, type VehicleState } from './physics/vehicle';
import { v3, type V3 } from './physics/vec';
import { buildBatched, isAdditive, solidBox } from './render';
import { buildLevelLights, buildSky } from './levelfx';
import { CarRig, type RigDoc } from './rig';
import { DebrisSystem } from './debris';
import { LevelDestructibles, RAM_DAMAGE } from './destructibles';

const params = new URLSearchParams(location.search);
const levelName = params.get('lvl') ?? 'arena';
const carName = params.get('car') ?? 'axel';
const botCount = Math.max(0, Math.min(7, Number(params.get('bots') ?? 3)));
const debug = params.get('debug') === '1';
/** Dificuldade da IA 0..3 (FUN_00190448(0x2f4b24); opções 0x2c45b8: SUPER EASY, EASY, MEDIUM, HARD). */
const difficulty = Math.max(0, Math.min(3, Number(params.get('diff') ?? 2)));
const BOT_POOL = ['cop', 'sweet', 'twist', 'spectre', 'thump', 'grass', 'crim', 'wart', 'hamr', 'rkill'];

const STEP = 1 / 60; // tick fixo (SPEC §9.2)
const abort = new AbortController();
addEventListener('pagehide', () => abort.abort());
// Esc: volta ao menu.
addEventListener('keydown', (e) => e.code === 'Escape' && location.assign('play.html'), { signal: abort.signal });

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('game')!.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d24);
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 20000);
const hudEl = document.getElementById('hud')!;
/** Mensagens 17..34 da tabela 0x2ba4c0 ("Destroyed <carro>", índice 17 + id do veículo). */
const DESTROYED = [
  'Axel', 'Shadow', 'Mr. Grimm', 'Roadkill', 'Sweet Tooth', 'Thumper', 'Spectre', 'Twister', 'Mr. Slam', 'Outlaw',
  'Crimson Fury', 'HammerHead', 'Grasshopper', 'Warthog', 'ATV', 'Cousin Eddy', 'Dark Tooth', 'Tower Tooth',
];
const loading = document.getElementById('loading')!;

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize, { signal: abort.signal });
resize();

const ps2 = (p: number[]): V3 => {
  const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(PS2_TO_THREE);
  return v3(v.x, v.y, v.z);
};

// ---------------------------------------------------------------- carga
let skyUpdate: ((camera: THREE.Camera) => void) | null = null; // céu segue a câmera

async function loadLevel() {
  loading.textContent = `carregando arena ${levelName}…`;
  const { doc, bin } = await loadModel(`lvl/${levelName}`);
  // Objetos destrutíveis (nós 0x13) ficam fora do lote estático: LevelDestructibles troca a geometria pelo estado.
  const { group, drawCalls } = await buildBatched(doc, bin, doc.scene.filter((i) => !i.dmg?.length));
  group.add(await buildLevelLights(doc, doc.scene)); // sprites e fachos de luz
  group.matrixAutoUpdate = false;
  group.matrix.copy(PS2_TO_THREE);
  scene.add(group);
  const sky = await buildSky(doc, bin, PS2_TO_THREE, buildBatched);
  if (sky) {
    scene.add(sky.group);
    skyUpdate = sky.update;
  }
  loading.textContent = 'montando colisão…';
  await new Promise((r) => setTimeout(r));
  const t0 = performance.now();
  const collision = new LevelCollision(doc, bin, PS2_TO_THREE, [...doc.scene, ...(doc.damageScene ?? [])]);
  console.info(`[colisão] ${collision.triangleCount} triângulos, BVH em ${Math.round(performance.now() - t0)} ms`);
  return { doc, bin, collision, drawCalls };
}

/** Regras recuperadas do executável (tools/native/export_rules.py). */
async function loadVehicleRules(): Promise<Record<string, { wheels: number[][]; id?: number; drive?: DriveParams }>> {
  const r = await fetch(assetURL('rules/vehicles.json'));
  return r.ok ? (await r.json()).vehicles : {};
}

type CarAsset = { template: THREE.Group; shape: VehicleShape; doc: ModelDoc; bin: ArrayBuffer };
const carCache = new Map<string, Promise<CarAsset>>();
function loadCarModel(name: string, rules: Record<string, { wheels: number[][]; drive?: DriveParams }>) {
  let p = carCache.get(name);
  if (!p) {
    p = (async () => {
      const { doc, bin } = await loadModel(`cars/${name}`);
      const template = new THREE.Group();
      // Com esqueleto (rig), a carroceria é montada por carro (CarRig) — canais independentes.
      if (!(doc as ModelDoc & { rig?: RigDoc }).rig) {
        const { group } = await buildBatched(doc, bin, doc.scene);
        group.matrixAutoUpdate = false;
        group.matrix.copy(VEHICLE_TO_THREE);
        template.add(group);
      }
      // Clarão do tiro (efeito ligado pelo código do jogo; conversor: effects['code:muzzle']).
      const muzzleDefs = doc.effects?.['code:muzzle'] ?? [];
      if (muzzleDefs.length) {
        const { group: muzzle } = await buildBatched(doc, bin, muzzleDefs);
        muzzle.name = 'muzzle';
        muzzle.matrixAutoUpdate = false;
        muzzle.matrix.copy(VEHICLE_TO_THREE);
        muzzle.visible = false;
        template.add(muzzle);
      }
      let shape = shapeOf(doc, bin);
      const rigDoc = (doc as ModelDoc & { rig?: RigDoc }).rig;
      if (rigDoc) {
        // Caixa pela pose de repouso do esqueleto (rodas no lugar), sem malhas aditivas.
        const rest = await CarRig.build(doc as ModelDoc & { rig: RigDoc }, bin, doc.scene.filter((i) => !isAdditive(doc.meshes[i.mesh])));
        for (const cl of rest.clipsWithRole('susp')) rest.time.set(cl.category, 0.5);
        for (const cl of rest.clipsWithRole('steer')) rest.time.set(cl.category, 0.5);
        rest.update();
        rest.group.updateMatrixWorld(true);
        const box = new THREE.Box3();
        rest.group.traverse((o) => {
          let shown = true;
          o.traverseAncestors((a) => (shown &&= a.visible));
          if ((o as THREE.Mesh).isMesh && shown) box.expandByObject(o);
        });
        if (!box.isEmpty())
          shape = { ...shape, halfWidth: Math.max(-box.min.x, box.max.x), halfLength: Math.max(-box.min.z, box.max.z), bottom: box.min.y, top: box.max.y };
      }
      // Rodas da tabela nativa (coords do PS2, frente +Y) -> espaço do carro no Three: (x, y, z) -> (-x, z, y).
      const w = rules[name]?.wheels;
      if (w?.length === 4) shape.wheels = w.map(([x, y, z]) => v3(-x, z, y));
      // Direção nativa por carro (0x2b8ab0: massa, vel. máx., giro, aceleração…; ver vehicle.ts).
      if (rules[name]?.drive) shape.drive = rules[name].drive;
      return { template, shape, doc, bin };
    })();
    carCache.set(name, p);
  }
  return p;
}

/** Caixa do carro (espaço Three, origem do modelo) sem malhas aditivas (fachos de luz etc.). */
function shapeOf(doc: ModelDoc, bin: ArrayBuffer): VehicleShape {
  const box = solidBox(doc, bin, VEHICLE_TO_THREE);
  return { halfWidth: Math.max(-box.min.x, box.max.x), halfLength: Math.max(-box.min.z, box.max.z), bottom: box.min.y, top: box.max.y };
}

/**
 * Objetos do GLOBALS.BDD usados como efeito de explosão (prefabs centrados na origem).
 * ⚠️ ESCOLHA DO HOST: identificados visualmente (36 = bola de fogo, nó de categoria 0xfa8; 29 = estouro, 0xfbd).
 * As explosões nativas são sistemas de partículas por id (+0x74 da tabela de projéteis), ainda não decodificados.
 */
const GLOBAL_OBJECTS = { fireball: 36, burst: 29 } as const;

/**
 * Ícone do pickup = nó de categoria 0x13ba + tipo do PKP (FUN_00168aa8 → FUN_001bdad0 guarda o nó em 0x35a710 +
 * 4 + 4·tipo; FUN_001bd680 o pendura no pickup). Só no Head-On: o Harbor City usa 5000 + tipo, e é lá que existem
 * os ícones da metralhadora (5000) — por isso o tipo 0 cai nele. A Mega Gun (14) não tem ícone no GLOBALS.
 */
const pickupCategory = (id: number) => (id === 0 ? 5000 : 0x13ba + id);
/** Cor da aura por pickup. ⚠️ ESCOLHA DO HOST: o brilho do ícone no jogo não foi achado. */
const PICKUP_AURA: Record<number, number> = {
  0: 0xffd040, 1: 0xff7a1a, 2: 0xc040ff, 3: 0xffc020, 4: 0xff5010, 5: 0x60e0ff, 6: 0xff2020,
  7: 0x40a0ff, 8: 0x40ff60, 9: 0xffd040, 10: 0x40ff40, 11: 0xff8040, 12: 0x40ff60,
};

/**
 * Tipo de projétil → categoria do modelo no GLOBALS (FUN_00204778 grava o nó em 0x37cbf0 + 0xda24 + 4·tipo; no
 * Head-On só as categorias 4000..4099, no Harbor City as 0x1004..). Sem nó registrado o jogo não desenha malha
 * (ex.: Napalm 0xfa4 não existe no GLOBALS — só partículas e luz). Para os especiais do Harbor City, que no
 * Head-On ficariam invisíveis, o runtime usa o nó do Harbor City (⚠️ host).
 */
const PROJECTILE_CATEGORY_HO: Record<number, number> = {
  0: 0xfa0, 0x2f: 0xfa0, 2: 0xfa1, 3: 0xfa2, 5: 0xfa3, 0x30: 0xfa3, 0x31: 0xfa3, 4: 0xfa4, 7: 0xfa5, 6: 0xfa6,
  0xf: 0xfa8, 0xe: 0xfa9, 0xd: 0xfaa, 0xa: 0xfab, 9: 0xfac, 0x14: 0xfb0, 0x11: 0xfb3, 0x12: 0xfb3, 0x13: 0xfb3,
  0x26: 0xfb5, 0x27: 0xfb5, 0x28: 0xfb5, 0x1e: 0xfb6, 0x1f: 0xfb8, 0x17: 0xfbc, 0x18: 0xfbc, 0x19: 0xfbd,
  0x1a: 0xfbd, 0x1b: 0xfbe, 0x1c: 0xfbe, 0x1d: 0xfbe, 0x16: 0xfbf, 0x15: 0xfc1, 0x22: 0xfcb, 0x23: 0xfcb,
  0x24: 0xfcc, 0x25: 0xfcd, 0x20: 0xfd2, 0x21: 0xfd2, 0x2a: 0xfda,
};
const PROJECTILE_CATEGORY_HC: Record<number, number> = {
  0: 0x1004, 2: 0x1005, 3: 0x1006, 0xb: 0x1007, 4: 0x1008, 7: 0x1009, 6: 0x100a, 0xf: 0x100c, 0xd: 0x100e,
  0x32: 0x1010, 0x2d: 0x1011, 0x2b: 0x1012, 0x2f: 0x1013, 0x33: 0x1015, 0x11: 0x1017, 0x12: 0x1017, 0x13: 0x1017,
  0x35: 0x1018, 0x36: 0x1019, 0x37: 0x101a, 0x2e: 0x101f, 0x34: 0x1020, 0x2c: 0x1026,
};

/** Brilho radial para a aura dos pickups (textura gerada; o PS2 usa um sprite aditivo). */
let auraTexture: THREE.Texture | null = null;
function auraSprite(color: number, size = 3.2): THREE.Sprite {
  if (!auraTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    auraTexture = new THREE.CanvasTexture(c);
  }
  const sp = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: auraTexture, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  );
  sp.scale.setScalar(size); // no espaço normalizado do ícone (raio 1)
  return sp;
}

async function loadGlobalObject(doc: ModelDoc, bin: ArrayBuffer, instances: ModelDoc['scene']): Promise<THREE.Group> {
  const { group } = await buildBatched(doc, bin, instances);
  // Ícones são anéis de painéis semitransparentes: o PS2 desenha só a face de fora. Com os dois lados,
  // o painel de trás aparecia através do da frente (ícone "duplicado").
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = (mesh.material as THREE.Material).clone();
    mat.side = THREE.FrontSide;
    mesh.material = mat;
  });
  group.matrixAutoUpdate = false;
  group.matrix.copy(PS2_TO_THREE);
  // Normaliza o tamanho (raio ~1) — a escala original vem do jogo, aqui escolhemos no uso.
  const holder = new THREE.Group();
  holder.add(group);
  const sphere = new THREE.Box3().setFromObject(holder).getBoundingSphere(new THREE.Sphere());
  group.matrix.premultiply(new THREE.Matrix4().makeTranslation(-sphere.center.x, -sphere.center.y, -sphere.center.z));
  holder.scale.setScalar(1 / Math.max(sphere.radius, 1e-3));
  return holder;
}

/** Máquina do piloto por modelo (FUN_0011e3d0: tipo 0x67/0x7a/0x73 → FUN_00125688 'a'; 0x65/0x77 → 'b'). */
const DRIVER_VARIANT: Record<string, 'a' | 'b'> = { mrgrim: 'a', hc_axel: 'a', edatv: 'a', axel: 'b', edplayer: 'b' };

/** Arma -> tipo de arma do jogo (FUN_00120ba0; índice dos marcadores 0x00F0 e dos seletores de projétil). */
const WEAPON_TYPE: Record<WeaponId, number> = {
  machinegun: 0, special: 1, fire: 2, homing: 3, napalm: 4, power: 6, ricochet: 7, env: 8, swarmer: 9, remote: 10,
};

/**
 * Modelo de um projétil em escala nativa e coordenadas do PS2 (frente = +Y). É o mesmo nó usado no voo
 * (FUN_00203c68 → FUN_0022ff38) e pendurado no marcador 0x00F0 do lançador (FUN_00147568), pela tabela por tipo.
 */
async function loadProjectileModel(doc: ModelDoc, bin: ArrayBuffer, instances: ModelDoc['scene']): Promise<THREE.Group> {
  const { group } = await buildBatched(doc, bin, instances);
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) (mesh.material = (mesh.material as THREE.Material).clone()).side = THREE.FrontSide;
  });
  return group;
}

async function loadGlobals() {
  const { doc, bin } = await loadModel('globals/globals');
  const out: Record<keyof typeof GLOBAL_OBJECTS, THREE.Group> = {} as never;
  for (const [key, index] of Object.entries(GLOBAL_OBJECTS) as [keyof typeof GLOBAL_OBJECTS, number][]) {
    out[key] = await loadGlobalObject(doc, bin, doc.objects?.[index]?.instances ?? []);
  }
  const cat = (c: number) => doc.categories?.[c.toString(16)];
  const pickups = new Map<number, THREE.Group>();
  for (const [id, aura] of Object.entries(PICKUP_AURA)) {
    const insts = cat(pickupCategory(Number(id)));
    if (!insts) continue;
    const holder = new THREE.Group();
    holder.add(await loadGlobalObject(doc, bin, insts), auraSprite(aura));
    pickups.set(Number(id), holder);
  }
  const projectiles = new Map<number, THREE.Group>();
  for (let t = 0; t < PROJECTILES.length; t++) {
    const insts = cat(t in PROJECTILE_CATEGORY_HO ? PROJECTILE_CATEGORY_HO[t] : PROJECTILE_CATEGORY_HC[t] ?? -1);
    if (insts) projectiles.set(t, await loadProjectileModel(doc, bin, insts));
  }
  return { ...out, pickups, projectiles, doc, bin };
}

function spawnPoints(doc: ModelDoc, collision: LevelCollision): V3[] {
  // Nós do caminho da IA (PTS — superfície dirigível). ⚠️ Spawns reais do DM moram no ELF.
  const pts = doc.points ?? {};
  const raw = (pts.pts?.length ? pts.pts : pts.pkp ?? []).map((p) => ps2(p.pos));
  if (!raw.length) {
    const c = collision.bounds.getCenter(new THREE.Vector3());
    raw.push(v3(c.x, collision.bounds.max.y, c.z));
  }
  return raw;
}

function placeOnGround(p: V3, shape: VehicleShape, collision: LevelCollision): V3 {
  const hit = collision.raycast(v3(p.x, p.y + 40, p.z), v3(0, -1, 0), 400);
  const groundY = hit ? p.y + 40 - hit.distance : p.y;
  return v3(p.x, groundY - shape.bottom + 2, p.z);
}

// ---------------------------------------------------------------- efeitos visuais
interface Fx {
  obj: THREE.Object3D;
  age: number;
  life: number;
  grow: number;
}

// ---------------------------------------------------------------- jogo
async function main() {
  const rules = await loadVehicleRules();
  const bots = BOT_POOL.filter((n) => n !== carName).slice(0, botCount);
  const [{ doc: lvl, bin: lvlBin, collision, drawCalls }, globals, ...cars] = await Promise.all([
    loadLevel(),
    loadGlobals(),
    loadCarModel(carName, rules),
    ...bots.map((b) => loadCarModel(b, rules)),
  ]);
  const spawns = spawnPoints(lvl, collision);
  // HUD do jogo: peças 3D do GLOBALS presas à câmera + fonte do RESIDENT (src/hud.ts).
  const hud = await Hud.build(globals.doc as never, globals.bin);
  document.body.appendChild(hud.canvas);
  const hudResize = () => hud.resize(innerWidth, innerHeight, Math.min(devicePixelRatio, 2));
  addEventListener('resize', hudResize, { signal: abort.signal });
  hudResize();
  const match = new Match(collision, spawns, (p, s) => placeOnGround(p, s, collision));
  // Índice do veículo nas tabelas indexadas por carro+0x14 (nomes 0x2b39f0, cores do radar, perfis da IA): os
  // Head-On seguem o id da tabela de física (0..17); os Harbor City vêm depois (id 21.. → 18..).
  const vehicleId = (model: string) => {
    const id = rules[model]?.id ?? -1;
    return id >= 21 ? id - 3 : id < 18 ? id : -1;
  };
  const aiTables = await fetch(assetURL('rules/ai.json')).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (aiTables) match.ai = { tables: aiTables, difficulty };
  const player = match.addCar('Você', carName, cars[0].shape, false);
  bots.forEach((b, i) => match.addCar(b, b, cars[i + 1].shape, true, vehicleId(b)));
  match.addPickups((lvl.points?.pkp ?? []).map((p) => ({ id: parseInt(p.raw[8], 16), pos: ps2(p.pos) })));

  // Modelos dos carros (um por carro da partida).
  const models = match.cars.map((c, i) => {
    const m = (i === 0 ? cars[0] : cars[i]).template.clone();
    scene.add(m);
    return m;
  });
  // Esqueleto por carro (rodas, suspensão, esterço, lançadores e armas pelos clipes do jogo).
  const rigs = await Promise.all(
    match.cars.map(async (c, i) => {
      const asset = i === 0 ? cars[0] : cars[i];
      const doc = asset.doc as ModelDoc & { rig?: RigDoc };
      if (!doc.rig) return null;
      // Pose base + entradas de dano dos nós 0x13 (a vida escolhe qual aparece: CarRig.setHealth) + filhos dos
      // seletores 0x05 (o estado escolhe: turbo, lanternas, projétil no suporte…).
      const r = await CarRig.build(doc as ModelDoc & { rig: RigDoc }, asset.bin, [...doc.scene, ...(doc.damageScene ?? []), ...(doc.selectScene ?? [])]);
      models[i].add(r.group);
      return r;
    }),
  );
  const muzzles = models.map((m) => m.getObjectByName('muzzle') ?? null);
  const wheelPhase = match.cars.map(() => 0);
  const wasDead = match.cars.map(() => false);
  const lastYaw = match.cars.map((c) => c.state.yaw);
  // Suportes de arma (FUN_00148978): clipe que abre quando a arma é selecionada e fecha (ao contrário) quando
  // outra é escolhida; só um suporte se move por vez. Estado: 0 fechado, 1 aberto/abrindo, 2 fechando.
  const mountsOf = rigs.map((r) =>
    // Uma máquina de estado por arma (FUN_00148978 percorre as armas; as que dividem o suporte dividem o clipe).
    (r?.clipsWithRole('weapon') ?? []).flatMap((clip) => (clip.weapons ?? []).map((w) => ({ clip, weapon: w as WeaponId, state: 0, t: 0 }))),
  );
  // Modelo do projétil de cada carro no marcador do lançador (um clone por carro e arma).
  const projModels = match.cars.map(() => new Map<number, THREE.Object3D>());
  const projectileFor = (i: number, type: number) => {
    let o = projModels[i].get(type);
    const src = globals.projectiles.get(type);
    if (!o && src) projModels[i].set(type, (o = src.clone()));
    return o ?? null;
  };
  // Sombra (seletor de categoria 0 com malha plana; ⚠️ host: projetada no chão sob o carro).
  const shadows = await Promise.all(
    match.cars.map(async (c, i) => {
      const asset = i === 0 ? cars[0] : cars[i];
      const node = Object.entries(asset.doc.selectors ?? {}).find(([, d]) => d.role === 'shadow')?.[0];
      if (!node) return null;
      const list = (asset.doc.selectScene ?? []).filter((x) => x.sel?.some(([n, k]) => n === node && k === 1));
      const { group } = await buildBatched(asset.doc, asset.bin, list);
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = (mesh.material as THREE.Material).clone();
        mat.depthWrite = false;
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = -2;
        mat.polygonOffsetUnits = -2;
        mesh.material = mat;
      });
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      group.matrixAutoUpdate = false;
      group.matrix.copy(VEHICLE_TO_THREE);
      holder.add(group);
      scene.add(holder);
      return holder;
    }),
  );
  // Destroços e ações soltas pelos nós 0x13 ao piorar de estado (actionDispatch.cpp).
  const debris = new DebrisSystem(scene, collision);
  const carFrame = new THREE.Matrix4();
  const destructibles = await LevelDestructibles.build(lvl, lvlBin, collision, debris, PS2_TO_THREE);
  destructibles.group.matrixAutoUpdate = false;
  destructibles.group.matrix.copy(PS2_TO_THREE);
  scene.add(destructibles.group);
  const V = (p: V3) => new THREE.Vector3(p.x, p.y, p.z);
  const muzzleUntil = match.cars.map(() => 0);
  // Pickups: ícone girando por cima do ponto do PKP.
  const pickupObjs = match.pickups.map((p) => {
    const src = globals.pickups.get(p.id) ?? globals.pickups.get(9)!;
    const o = src.clone();
    o.scale.multiplyScalar(4);
    o.position.set(p.pos.x, p.pos.y + 5, p.pos.z);
    scene.add(o);
    return o;
  });
  // Projéteis: o modelo do tipo (nó do GLOBALS em escala nativa, frente +Y do PS2) e, com luz na tabela
  // (+0x5c, cor +0x60..+0x68), um brilho aditivo na cor nativa. ⚠️ host: brilho no lugar da luz dinâmica
  // (FUN_0024c350) e bola de fogo pequena no lugar das partículas presas (+0x6c) dos tipos sem malha (Napalm).
  const projObjs = new Map<Projectile, THREE.Object3D>();
  const projectileObj = (p: Projectile) => {
    let o = projObjs.get(p);
    if (o) return o;
    const r = PROJECTILES[p.type];
    o = new THREE.Group();
    const src = globals.projectiles.get(p.type);
    if (src) {
      const m = src.clone();
      m.matrixAutoUpdate = false;
      // FUN_00203c68: escala da instância 0,25 no tipo 0x18 e 0,65 no 0x1d; os demais em 1.
      const k = p.type === 0x18 ? 0.25 : p.type === 0x1d ? 0.65 : 1;
      m.matrix.copy(PS2_TO_THREE).multiply(new THREE.Matrix4().makeScale(k, k, k));
      o.add(m);
    } else if (!isBullet(p.type)) {
      const f = globals.fireball.clone();
      f.scale.multiplyScalar(2);
      o.add(f);
    }
    if (r?.light) o.add(auraSprite((Math.round(r.lightR) << 16) | (Math.round(r.lightG) << 8) | Math.round(r.lightB), 6));
    scene.add(o);
    projObjs.set(p, o);
    return o;
  };
  // Traçantes da metralhadora.
  const tracerGeo = new THREE.BufferGeometry();
  const tracerPos = new Float32Array(64 * 6);
  tracerGeo.setAttribute('position', new THREE.BufferAttribute(tracerPos, 3));
  const tracers = new THREE.LineSegments(tracerGeo, new THREE.LineBasicMaterial({ color: 0xffdd66 }));
  tracers.frustumCulled = false;
  scene.add(tracers);
  let tracerList: { from: V3; to: V3; age: number }[] = [];
  const fx: Fx[] = [];
  /** Explosão do tipo: tamanho pelo raio (+0x04) e escala do 1º efeito (+0x84). ⚠️ host: prefabs no lugar das partículas. */
  const explode = (pos: V3, type: number) => {
    const r = PROJECTILES[type];
    const k = (r?.explosionScale[0] ?? 1) * (r && r.blastRadius > 0 ? Math.min(3, r.blastRadius / 45) : 1);
    for (const [src, life, grow] of [[globals.fireball, 0.6, 14 * k], [globals.burst, 0.35, 18 * k]] as const) {
      const o = src.clone();
      o.position.set(pos.x, pos.y, pos.z);
      o.scale.setScalar(1);
      scene.add(o);
      fx.push({ obj: o, age: 0, life, grow });
    }
  };

  const input = new Input(abort.signal);
  const audio = new AudioEngine(levelName, abort.signal);
  // Ação 4 dos nós 0x13 (FUN_001a0db8): som de destruição do banco da arena (D_WOOD_*, D_GLASS_*…).
  debris.onSound = (name, pos) => audio.play(levelName, name, { pos: v3(pos.x, pos.y, pos.z) });
  // Nomes dos sons do GLOBAL.BNK (nativos) para cada evento.
  const LAUNCH: Partial<Record<WeaponId, string>> = {
    machinegun: 'W_MGUN', fire: 'W_FIREMISS_LNCH', homing: 'W_HOMMISS_LNCH', swarmer: 'W_SWARM_LNCH',
    napalm: 'W_NAP_LAUNCH', ricochet: 'W_RICO_LNCH', power: 'W_PWRMISS_LNCH', remote: 'W_REMOTE_DROP',
  };
  const EXPLO: Partial<Record<WeaponId, string>> = {
    machinegun: 'W_EXPLO_SML', fire: 'W_EXPLO_MED', homing: 'W_EXPLO_MED', swarmer: 'W_EXPLO_SML',
    napalm: 'W_EXPLO_LRG', ricochet: 'W_EXPLO_MED', power: 'W_EXPLO_LRG', remote: 'W_EXPLO_LRG',
  };
  /**
   * Som do especial no banco de armas do carro (*WP.BNK): nomes nativos do banco; ⚠️ host: qual nome cada
   * especial toca (o código monta os nomes em registradores, tools/native/sound_sites.py não cobre os WSP_*).
   */
  const SPECIAL_SOUND: Record<string, string> = { axel: 'WSP_ENERGYBURST', cop: 'WSP_ARC_L', mrslam: 'WSP_SLAM_UP', grass: 'WSP_JUMP', edatv: 'WSP_SHOTGUN', mrgrim: 'WSP_LAUNCH' };
  const playSpecial = (model: string, pos: V3) => {
    const wb = audio.weaponBank(model);
    if (wb) audio.play(wb, SPECIAL_SOUND[model] ?? 'WSP_LAUNCH', { pos, min: 20, max: 650 });
  };
  let lastGunSound = 0;
  let lastBulletSound = 0;
  const clock = () => performance.now() / 1000;
  const lastRam: number[] = [];
  /** Faixa das armas (W_SWARM_LNCH em FUN_001524a0: 15–650 pés). */
  const WEAPON_RANGE = { min: 15, max: 650 };
  /**
   * Som de batida (FUN_00141ca0), faixa 10–200 pés: intensidade ≤ 5 V_TAP (volume i·0,25), 5–15 V_CRASH e 15–25
   * V_MAJOR_COLL (volume (819 + 205·fração)/1024), acima disso V_MAJOR_COLL cheio. ⚠️ unidade da intensidade (mph).
   */
  const collisionSound = (speed: number, pos: V3) => {
    const i = speed * 0.6818182;
    if (i < 1) return;
    const base = { pos, min: 10, max: 200 };
    if (i > 25) audio.play('global', 'V_MAJOR_COLL', base);
    else if (i > 15) audio.play('global', 'V_MAJOR_COLL', { ...base, volume: (((i - 15) / 10) * 205 + 819) / 1024 });
    else if (i > 5) audio.play('global', 'V_CRASH', { ...base, volume: (((i - 5) / 10) * 205 + 819) / 1024 });
    else audio.play('global', 'V_TAP', { ...base, volume: i * 0.25 });
  };
  // Nome curto de cada carro (0x2b39f0) e cor no radar (0x2ba6c8), pelo índice do veículo.
  const shortName = (model: string) => SHORT_NAMES[vehicleId(model)] ?? model;
  const handle = (e: MatchEvent) => {
    if (e.kind === 'shot') {
      muzzleUntil[e.car] = performance.now() + 60;
      // Metralhadora: um som a cada ~3 tiros por carro para não saturar. ⚠️ host: faixa 15–650 (a das armas).
      if (performance.now() - lastGunSound > 90 || e.car === player.id) {
        audio.play('global', 'W_MGUN', { pos: e.from, volume: e.car === player.id ? 0.7 : 0.5, ...WEAPON_RANGE });
        lastGunSound = performance.now();
      }
    } else if (e.kind === 'bulletHit') {
      // Impacto da bala (FUN_00153ff0): metal no carro, terra no cenário (⚠️ superfície do chão não lida).
      if (performance.now() - lastBulletSound > 60) {
        audio.play('global', e.car ? 'W_BUL_METAL' : 'W_BUL_DIRT', { pos: e.pos, volume: 0.6 });
        lastBulletSound = performance.now();
      }
    } else if (e.kind === 'launch') {
      if (e.weapon === 'special') playSpecial(match.cars[e.car].model, e.pos);
      else if (LAUNCH[e.weapon]) audio.play('global', LAUNCH[e.weapon]!, { pos: e.pos, ...WEAPON_RANGE });
    } else if (e.kind === 'special') {
      playSpecial(e.model, e.pos);
      explode(e.pos, 1);
    } else if (e.kind === 'message') {
      if (e.car === player.id) hud.message(e.text);
    } else if (e.kind === 'bounce') {
      audio.play('global', 'W_RICOCHET_BNCE', { pos: e.pos, min: 100, max: 650 }); // FUN_00154720
    } else if (e.kind === 'impact') collisionSound(e.speed, e.pos);
    else if (e.kind === 'ram') {
      // Batida no cenário: o mesmo som das colisões (FUN_00142290 → FUN_00141ca0), no máximo 4 por segundo por carro.
      destructibles.hitTag(e.tag, e.speed * RAM_DAMAGE, { kind: 'ram', pos: V(e.pos) }, performance.now() / 1000);
      if (clock() - (lastRam[e.car] ?? 0) > 0.25) {
        lastRam[e.car] = clock();
        collisionSound(e.speed, e.pos);
      }
    }
    else if (e.kind === 'worldHit') {
      // Golpe direto no cenário (FUN_00171838): o dono do triângulo atingido.
      destructibles.hitTag(e.tag, e.amount, { kind: 'weapon', weapon: e.weapon, pos: V(e.pos), vel: V(e.vel) }, performance.now() / 1000);
    } else if (e.kind === 'hit') {
      // Golpe direto nas peças destrutíveis do carro (categoria ≠ 0x46; FUN_00171838). ⚠️ host: peça mais perto.
      const r = rigs[e.car];
      if (r) r.hitPart(r.group.worldToLocal(new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z)), e.amount, performance.now() / 1000, 4);
    } else if (e.kind === 'explosion') {
      explode(e.pos, e.type);
      // Área nos destrutíveis: metade do raio (FUN_00202d08 → FUN_0022c5a8(raio·0,5)).
      const w = PROJECTILES[e.type];
      if (w) destructibles.blast(V(e.pos), w.blastRadius * 0.5, w.damage, e.weapon, performance.now() / 1000);
      // FUN_00152b48: W_EXPLO_MED 60–650; FUN_00150c98: W_EXPLO_LRG 15–650. ⚠️ host: qual arma usa qual.
      const name = EXPLO[e.weapon] ?? (w && w.blastRadius > 0 ? 'W_EXPLO_LRG' : 'W_EXPLO_MED');
      const big = name === 'W_EXPLO_LRG';
      audio.play('global', name, { pos: e.pos, min: big ? 15 : 60, max: 650 });
    } else if (e.kind === 'pickup') {
      const eff = pickupEffect(e.pickupId);
      const pickupSound = eff.kind === 'health' ? (eff.amount >= 100 ? 'P_100_HEALTH' : 'P_PARTIALHEALTH') : eff.kind === 'turbo' ? 'P_TURBO' : 'P_WEAPON';
      audio.play('global', pickupSound, { pos: match.center(match.cars[e.car]) });
      // "%s Pickup" (tabela 0x2ba4c0, mensagem 1). ⚠️ host: o texto do %s.
      if (e.car === player.id) hud.message(`${e.name} Pickup`);
    } else if (e.kind === 'killed') {
      // Morte do carro: FUN_00142648 W_EXPLO_LRG, FUN_00145720 W_PLAYER_DEATH e FUN_001457b0 V_SCREAM, todos 10–2000.
      audio.play('global', 'W_EXPLO_LRG', { pos: e.pos, min: 10, max: 2000 });
      audio.play('global', 'V_SCREAM', { pos: e.pos, min: 10, max: 2000 });
      if (e.victim === player.id) audio.play('global', 'W_PLAYER_DEATH', { pos: e.pos, min: 10, max: 2000 });
      const v = match.cars[e.victim];
      const k = e.killer !== null ? match.cars[e.killer] : null;
      // Mensagens 17..34 "Destroyed <carro>" (17 + id) e 16 "%s killed by %s". ⚠️ host: quando cada uma aparece.
      const vid = vehicleId(v.model);
      if (k === player && v !== player) hud.message(`Destroyed ${DESTROYED[vid] ?? shortName(v.model)}`);
      else if (v === player && k && k !== v) hud.message(`${shortName(v.model)} killed by ${shortName(k.model)}`);
    } else if (e.kind === 'bayFull' && e.car === player.id) {
      hud.message(e.bay === 'weapon' ? 'Weapons Bay Full' : e.bay === 'health' ? 'Health Bay Full' : 'Turbo Bay Full');
    }
  };

  /** Sombra sob o carro: ponto e normal do chão abaixo do centro, girada pelo yaw do carro. ⚠️ host. */
  const shadowUp = new THREE.Vector3(0, 1, 0);
  const shadowQ = new THREE.Quaternion();
  const shadowYaw = new THREE.Quaternion();
  function placeShadow(holder: THREE.Group, st: VehicleState, dead: boolean) {
    const hit = !dead && collision.raycast(v3(st.pos.x, st.pos.y + 5, st.pos.z), v3(0, -1, 0), 60);
    holder.visible = !!hit;
    if (!hit) return;
    const n = new THREE.Vector3(hit.normal?.x ?? 0, hit.normal?.y ?? 1, hit.normal?.z ?? 0);
    if (n.y < 0) n.negate();
    shadowQ.setFromUnitVectors(shadowUp, n.normalize()).multiply(shadowYaw.setFromAxisAngle(shadowUp, st.yaw));
    holder.matrix.compose(new THREE.Vector3(st.pos.x, st.pos.y + 5 - hit.distance + 0.05, st.pos.z), shadowQ, new THREE.Vector3(1, 1, 1));
    holder.matrixWorldNeedsUpdate = true;
  }

  // Câmera.
  const shape = player.shape;
  const cams = [
    { dist: Math.max(18, shape.halfLength * 3.2), height: Math.max(7, shape.top * 1.8) },
    { dist: Math.max(35, shape.halfLength * 5.5), height: Math.max(14, shape.top * 3.5) },
  ];
  let camIndex = 0;
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  let camInit = false;

  loading.hidden = true;
  renderer.compile(scene, camera);

  let acc = 0;
  let last = performance.now();
  let fpsT = 0;
  let fpsN = 0;
  let fps = 0;
  const basisM = new THREE.Matrix4();
  const lerp = (a: V3, b: V3, t: number) => v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  let prevStates: VehicleState[] = match.cars.map((c) => structuredClone(c.state));
  const killY = collision.bounds.min.y - 300;
  let pendingSpecial = false;
  const turboState: { on: boolean; launch: number; out: number }[] = [];
  const airBefore: number[] = [];
  let lastSelected: WeaponId | null = null;
  let pendingNext = false;

  renderer.setAnimationLoop((now) => {
    const dt = Math.min((now - last) / 1000, 0.08); // evita espiral da morte
    last = now;
    fpsT += dt;
    fpsN++;
    if (fpsT > 0.5) {
      fps = Math.round(fpsN / fpsT);
      fpsT = fpsN = 0;
    }
    if (input.consume('reset') && player.deadFor === 0) match.respawn(player);
    if (input.consume('camera')) camIndex = (camIndex + 1) % cams.length;
    const a = input.actions();
    pendingSpecial ||= a.fireSpecial;
    pendingNext ||= a.nextWeapon;

    acc += dt;
    while (acc >= STEP) {
      prevStates = match.cars.map((c) => structuredClone(c.state));
      const act: CarActions = { ...a, fireSpecial: pendingSpecial, nextWeapon: pendingNext };
      pendingSpecial = pendingNext = false;
      match.step(STEP, new Map([[player.id, act]]));
      for (const c of match.cars) if (c.deadFor === 0 && c.state.pos.y < killY) match.respawn(c);
      for (const e of match.drain()) handle(e);
      hud.tick();
      acc -= STEP;
    }
    const alpha = acc / STEP;

    // Carros (pose interpolada).
    match.cars.forEach((c, i) => {
      const m = models[i];
      const r = rigs[i];
      const dead = c.deadFor > 0;
      if (wasDead[i] && !dead) r?.resetDamage(); // renasceu (FUN_0012ea48)
      wasDead[i] = dead;
      // Estado de dano dos nós 0x13 pela vida; morto (vida 0) = carcaça até renascer. Sem nós 0x13, some.
      r?.setHealth(c.health / MATCH_RULES.maxHealth, now / 1000);
      m.visible = !dead || r?.hasDamage === true;
      if (!m.visible) return;
      const prev = prevStates[i] ?? c.state;
      const pos = lerp(prev.pos, c.state.pos, alpha);
      const b = basisOf({ ...c.state, yaw: prev.yaw + (c.state.yaw - prev.yaw) * alpha, up: lerp(prev.up, c.state.up, alpha) });
      basisM.makeBasis(new THREE.Vector3(b.x.x, b.x.y, b.x.z), new THREE.Vector3(b.y.x, b.y.y, b.y.z), new THREE.Vector3(b.z.x, b.z.y, b.z.z));
      m.position.set(pos.x, pos.y, pos.z);
      m.quaternion.setFromRotationMatrix(basisM);
      if (c.spin) m.rotateY(c.spin); // especial do Twister (giro visual)
      const shadow = shadows[i];
      if (shadow) placeShadow(shadow, c.state, dead);
      if (r) {
        // Ações dos nós 0x13 (destroços) soltas neste quadro, no quadro do carro (PS2 local -> mundo).
        if (r.released.length) {
          m.updateMatrixWorld(true);
          carFrame.multiplyMatrices(m.matrixWorld, VEHICLE_TO_THREE);
          for (const rel of r.released.splice(0)) {
            const asset = i === 0 ? cars[0] : cars[i];
            const action = asset.doc.actions?.[rel.action];
            if (action) debris.dispatch(asset.doc, asset.bin, action, carFrame, now / 1000);
          }
        }
        // Seletores (FUN_00230138): chama do turbo (0x44, FUN_001238c8) e lanternas (0x41: 2 com freio,
        // FUN_0011f1e8; o filho 1 depende de um flag que o código nunca liga, como o brilho dos faróis 0x40).
        r.setSelector(0x44, c.boosting ? 1 : 0);
        r.setSelector(0x41, c.braking ? 2 : 0);
        // Rodas: giro pela distância percorrida (raio ~2 pés ⚠️), esterço pela taxa de giro, suspensão no meio.
        const spd = Math.hypot(c.state.vel.x, c.state.vel.z) * Math.sign(c.state.vel.x * Math.sin(c.state.yaw) + c.state.vel.z * Math.cos(c.state.yaw) || 1);
        wheelPhase[i] = (((wheelPhase[i] + (spd * dt) / (2 * Math.PI * 2)) % 1) + 1) % 1;
        let dyaw = c.state.yaw - lastYaw[i];
        dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
        lastYaw[i] = c.state.yaw;
        const steer = Math.max(-1, Math.min(1, -dyaw / Math.max(dt, 1e-3) / 1.6));
        for (const cl of r.clipsWithRole('spin')) r.time.set(cl.category, wheelPhase[i]);
        for (const cl of r.clipsWithRole('steer')) r.time.set(cl.category, 0.5 + 0.5 * steer);
        for (const cl of r.clipsWithRole('susp')) r.time.set(cl.category, 0.5);
        r.setDirect(wheelPhase[i], steer);
        // Piloto (FUN_0011e3d0): FUN_00125688 em Mr. Grimm/HC Axel/ATV, FUN_001258f0 em Axel/Cousin Eddy.
        if (r.hasDriver)
          r.drive({ steer01: 0.5 + 0.5 * c.steer, speed: Math.hypot(c.state.vel.x, c.state.vel.z), airFrames: c.airFrames }, dt,
            DRIVER_VARIANT[c.model] ?? 'b');
        // Suportes de arma (FUN_0014a168 → FUN_00148978): abre o da arma selecionada (com munição) só quando
        // nenhum suporte está aberto ou fechando; fecha os demais. Clipe a mountSpeed × 60 quadros/s.
        const sel = c.selected && (c.ammo[c.selected] ?? 0) > 0 ? c.selected : null;
        const mounts = mountsOf[i];
        const busy = mounts.some((mt) => mt.state !== 0);
        const speed = (r.rig.mountSpeed ?? 1) * 60;
        const clipT = new Map<number, number>();
        for (const mt of mounts) {
          const mine = sel === mt.weapon;
          if (mine && mt.state === 0 && !busy) {
            // Abre (FUN_00148978): seletores de projétil 0x1b1 (2→1, 3→2) e 0x1b2 (6→1, 9→2) e o modelo do
            // projétil no marcador 0x00F0 do tipo (FUN_00147568).
            mt.state = 1;
            // Suporte abrindo (FUN_001451a0): S_DEPLOY do banco de armas do carro. ⚠️ faixa do objeto de som do carro.
            const wb = audio.weaponBank(c.model);
            if (wb) audio.play(wb, 'S_DEPLOY', { pos: match.center(c), min: 20, max: 600 });
            const t = WEAPON_TYPE[mt.weapon];
            r.setSelector(0x1b1, t === 2 ? 1 : t === 3 ? 2 : 0);
            r.setSelector(0x1b2, t === 6 ? 1 : t === 9 ? 2 : 0);
            r.setProjectile(t, projectileFor(i, t));
          } else if (!mine && mt.state === 1) {
            mt.state = 2; // fecha: seletores voltam a 0; o modelo sai quando o clipe termina (FUN_001474f0)
            const wb = audio.weaponBank(c.model);
            if (wb) audio.play(wb, 'S_RETRACT', { pos: match.center(c), min: 20, max: 600 }); // FUN_001452d8
            r.setSelector(0x1b1, 0);
            r.setSelector(0x1b2, 0);
          }
          const len = Math.max(mt.clip.duration - (mt.clip.start ?? 0), 1);
          if (mt.state === 1) mt.t = Math.min(1, mt.t + (dt * speed) / len);
          else if (mt.state === 2) {
            mt.t = Math.max(0, mt.t - (dt * speed) / len);
            if (mt.t <= 0) {
              mt.state = 0;
              r.setProjectile(WEAPON_TYPE[mt.weapon], null);
            }
          }
          clipT.set(mt.clip.category, Math.max(clipT.get(mt.clip.category) ?? 0, mt.t));
        }
        for (const [cat, t] of clipT) r.time.set(cat, t);
        r.update();
      }
    });
    // Pickups: giram e flutuam; somem enquanto renascem.
    const t = now / 1000;
    match.pickups.forEach((p, i) => {
      const o = pickupObjs[i];
      o.visible = p.respawnIn === 0;
      o.rotation.y = t * 1.5;
      o.position.y = p.pos.y + 5 + Math.sin(t * 2 + i) * 0.8;
    });
    // Projéteis: posição interpolada e orientação pelo rumo/arfagem (frente +Z do Three = +Y do PS2).
    const live = new Set(match.projectiles);
    for (const [p, o] of projObjs) {
      if (live.has(p)) continue;
      scene.remove(o);
      projObjs.delete(p);
    }
    for (const p of match.projectiles) {
      const o = projectileObj(p);
      const at = lerp(p.prev, p.pos, alpha);
      o.position.set(at.x, at.y, at.z);
      o.rotation.set(-p.pitch, p.yaw, 0, 'YXZ');
      // Balas: traçante do trecho percorrido no tique (o modelo 0xfa0 é minúsculo).
      if (isBullet(p.type)) tracerList.push({ from: p.prev, to: p.pos, age: 0.035 });
    }
    // Traçantes (70 ms).
    tracerList = tracerList.filter((tr) => (tr.age += dt) < 0.07).slice(-64);
    tracerPos.fill(0);
    tracerList.forEach((tr, i) => tracerPos.set([tr.from.x, tr.from.y, tr.from.z, tr.to.x, tr.to.y, tr.to.z], i * 6));
    tracerGeo.attributes.position.needsUpdate = true;
    tracerGeo.setDrawRange(0, tracerList.length * 2);
    debris.update(dt, t);
    destructibles.update(t);
    // Explosões: crescem e somem.
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      f.age += dt;
      if (f.age >= f.life) {
        scene.remove(f.obj);
        fx.splice(i, 1);
        continue;
      }
      f.obj.scale.setScalar(1 + f.grow * (f.age / f.life));
    }

    const nowMs = performance.now();
    muzzles.forEach((mz, i) => mz && (mz.visible = nowMs < muzzleUntil[i] && match.cars[i].deadFor === 0));

    // Câmera de perseguição (segue os destroços quando o jogador morre).
    const ps = player.state;
    const c = cams[camIndex];
    const fwd = new THREE.Vector3(Math.sin(ps.yaw), 0, Math.cos(ps.yaw));
    const target = new THREE.Vector3(ps.pos.x, ps.pos.y + shape.top * 0.6, ps.pos.z);
    let desired = target.clone().addScaledVector(fwd, -c.dist).add(new THREE.Vector3(0, c.height + (player.deadFor > 0 ? 25 : 0), 0));
    const toCam = desired.clone().sub(target);
    const dist = toCam.length();
    const hit = collision.raycast(target, { x: toCam.x / dist, y: toCam.y / dist, z: toCam.z / dist }, dist);
    if (hit) desired = target.clone().addScaledVector(toCam.normalize(), Math.max(4, hit.distance - 2));
    const k = 1 - Math.exp(-dt * 8);
    if (!camInit) {
      camPos.copy(desired);
      camLook.copy(target);
      camInit = true;
    }
    camPos.lerp(desired, k);
    camLook.lerp(target.clone().addScaledVector(fwd, c.dist * 0.4), k);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    // QA: câmera fixa relativa ao carro do jogador (window.__camOverride = { pos: [x,y,z], look: [x,y,z] }, no espaço do carro)
    const ov = (window as any).__camOverride as { pos: number[]; look: number[] } | undefined;
    if (ov) {
      const m0 = models[0];
      camera.position.set(ov.pos[0], ov.pos[1], ov.pos[2]).applyMatrix4(m0.matrixWorld);
      camera.lookAt(new THREE.Vector3(ov.look[0], ov.look[1], ov.look[2]).applyMatrix4(m0.matrixWorld));
    }

    // QA: câmera fixa no mundo (window.__camWorld = { pos: [x,y,z], look: [x,y,z] })
    const cw = (window as any).__camWorld as { pos: number[]; look: number[] } | undefined;
    if (cw) {
      camera.position.set(cw.pos[0], cw.pos[1], cw.pos[2]);
      camera.lookAt(cw.look[0], cw.look[1], cw.look[2]);
    }

    // Áudio: ouvinte no carro do jogador (FUN_001d32d8), orientação da câmera; motores do jogador e dos bots.
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    audio.listener(match.center(player), camDir);
    const tNow = clock();
    for (const c of match.cars) {
      const alive = c.deadFor === 0;
      // FUN_00144250: altura do motor = vel. (mph) / vel. máx. da tabela (carro+0x858).
      const top = (c.shape.drive?.maxMph ?? 100) * 1.4666667;
      audio.engine(c.id, c.model, speedOf(c.state) / top, c.id === player.id ? a.throttle : 0.7, match.center(c), alive);
      // Turbo (FUN_001446d0): V_TURBO_LAUNCH ao ligar (≥ 61 quadros entre um e outro), laços V_MAXRPM_L (sobe em 180
      // quadros) e V_TURBINE_L; ao soltar, descem em 60 e 120 quadros. V_TURBO_OUT ao soltar (FUN_00141770, ≥ 15).
      const boost = alive && c.boosting;
      const ts = (turboState[c.id] ??= { on: false, launch: -9, out: -9 });
      const pos = match.center(c);
      const range = { pos, min: 20, max: 600 }; // ⚠️ host: faixa do objeto de som do carro
      if (boost && !ts.on && tNow - ts.launch > 61 / 60) {
        audio.play('global', 'V_TURBO_LAUNCH', range);
        ts.launch = tNow;
      }
      if (!boost && ts.on && c.id === player.id && tNow - ts.out > 15 / 60) {
        audio.play('global', 'V_TURBO_OUT');
        ts.out = tNow;
      }
      audio.loop(`maxrpm${c.id}`, 'global', 'V_MAXRPM_L', boost ? 1 : 0, { ...range, fade: boost ? 3 : 1 });
      audio.loop(`turbine${c.id}`, 'global', 'V_TURBINE_L', boost ? 1 : 0, { ...range, fade: boost ? 0.05 : 2 });
      ts.on = boost;
      // Pouso depois de um pulo (FUN_00143740). ⚠️ host: superfície (sempre terra) e o mínimo de quadros no ar.
      if (alive && c.state.grounded && (airBefore[c.id] ?? 0) > 20) audio.play('global', 'V_LAND_DIRT', { pos, min: 10, max: 200 });
      airBefore[c.id] = c.airFrames;
    }
    // Vida baixa (FUN_00139938 → FUN_001418b8): laço abaixo de 15 % da vida, só do jogador. ⚠️ o V_LOWHEALTH_L não
    // aparece nos nomes convertidos do GLOBAL.BNK; o host usa o HEALTHBEEP.
    const low = player.deadFor === 0 && player.health / MATCH_RULES.maxHealth < 0.15;
    audio.loop('lowhealth', 'global', 'HEALTHBEEP', low ? 0.8 : 0);
    // Troca de arma (FUN_00141580): WEAPON_CYCLE, só do jogador.
    if (player.selected !== lastSelected && player.selected && lastSelected) audio.play('global', 'WEAPON_CYCLE');
    lastSelected = player.selected;

    skyUpdate?.(camera);
    renderer.render(scene, camera);
    hud.render(renderer, hudState(), dt);
    renderHud(fps, drawCalls, collision.triangleCount);
  });

  /** Estado do HUD a partir do jogador (carro+0x4dc0 vida, +0x6894 turbo, +0x6898 energia, inventário +0x4fbc). */
  function hudState() {
    const ammo = new Array<number>(9).fill(0);
    for (const [w, n] of Object.entries(player.ammo)) {
      const i = INVENTORY_INDEX[w as WeaponId];
      if (i !== undefined) ammo[i] = n ?? 0;
    }
    const fwd = forwardOf(player.state.yaw);
    const right = rightOf(player.state.yaw);
    const blips: HudBlip[] = [];
    let target: string | null = null;
    let best = Infinity;
    for (const c of match.cars) {
      if (c === player || c.deadFor > 0) continue;
      const dx = c.state.pos.x - player.state.pos.x;
      const dy = c.state.pos.y - player.state.pos.y;
      const dz = c.state.pos.z - player.state.pos.z;
      // FUN_00137148: fora de ±50 pés de altura o ponto pisca ((rand & 0x1f) < 0xf).
      if (Math.abs(dy) < 50 || Math.random() < 15 / 32)
        blips.push({ right: dx * right.x + dz * right.z, forward: dx * fwd.x + dz * fwd.z, color: vehicleId(c.model) });
      // FUN_00139780: alvo = o mais perto num cone de cos(0,96) à frente.
      const d2 = dx * dx + dy * dy + dz * dz;
      const L = Math.sqrt(d2) || 1;
      if ((dx * fwd.x + dz * fwd.z) / L > Math.cos(0.96) && d2 < best) {
        best = d2;
        target = shortName(c.model);
      }
    }
    return {
      health: player.health / MATCH_RULES.maxHealth,
      turbo: player.turbo / MATCH_RULES.turboMax,
      energy: 1, // ⚠️ host: ataques de energia não implementados (carro+0x6898 começa em 1,0 — FUN_00123cd0)
      dead: player.deadFor > 0,
      respawnIn: MATCH_RULES.respawnDelay - player.deadFor,
      ammo,
      selected: player.selected ? INVENTORY_INDEX[player.selected] ?? 0 : 0,
      target,
      blips,
      hc: false,
    };
  }

  /** Linha de depuração (só com ?debug=1) e aviso de som — o HUD do jogo é o de src/hud.ts. */
  function renderHud(fps: number, drawCalls: number, tri: number) {
    const board = [...match.cars].sort((x, y) => y.kills - x.kills).map((c) => `${c.name} ${c.kills}/${c.deaths}`).join(' · ');
    const sound = !audio.started ? '🔇 aperte qualquer tecla para ligar o som' : audio.isMuted ? '🔇 mudo (M)' : '';
    hudEl.hidden = !debug && !sound;
    hudEl.innerHTML = debug
      ? `<div class="small">${Math.round(speedOf(player.state) * 0.6818)} mph · ${board}</div>
      ${sound ? `<div class="small">${sound}</div>` : ''}
      <div class="small">${levelName} · ${fps} fps · ${drawCalls} draw calls · ${tri} tri de colisão · pickups ${match.pickups.length}</div>`
      : `<div class="small">${sound}</div>`;
  }

  // Ganchos para QA (tools/web).
  (window as any).__doorsDebug = () => ({
    mounts: mountsOf.map((ms) => ms.map((m) => ({ category: m.clip.category, weapon: m.weapon, state: m.state, t: +m.t.toFixed(2) }))),
    now: performance.now() / 1000,
    ammo: match.cars[0].ammo,
  });
  (window as any).__game = {
    audio,
    hud,
    hudState: () => hudState(),
    pickupObjs,
    state: () => player.state,
    setState: (s: VehicleState) => (player.state = s),
    match,
    damage: () => rigs.map((r) => r?.damageStates() ?? null),
    selectors: () => rigs.map((r) => r?.selectorStates() ?? null),
    debris: () => debris.count,
    debrisSys: debris,
    destructibles,
    rigs,
    spawns,
    collision,
    THREE,
  };
  (window as any).__ready = true;
}

main().catch((e) => {
  loading.hidden = false;
  loading.textContent = `Falha: ${e}`;
  console.error(e);
});
