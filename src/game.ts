// Deathmatch numa arena. Uso: play.html?lvl=arena&car=axel&bots=3
import * as THREE from 'three';
import { assetURL, loadModel, type ModelDoc } from './assets';
import { AudioEngine } from './audio';
import { LevelCollision } from './collision';
import { PS2_TO_THREE, VEHICLE_TO_THREE } from './coords';
import { Input } from './input';
import { Match, MATCH_RULES, type CarActions, type MatchEvent } from './game/match';
import { PICKUP_RULES, pickupEffect, WEAPON_RULES, type WeaponId } from './game/weapons';
import { basisOf, speedOf, type VehicleShape, type VehicleState } from './physics/vehicle';
import { v3, type V3 } from './physics/vec';
import { buildBatched, isAdditive, solidBox } from './render';
import { buildLevelLights, buildSky } from './levelfx';
import { CarRig, type RigDoc } from './rig';
import { DebrisSystem } from './debris';

const params = new URLSearchParams(location.search);
const levelName = params.get('lvl') ?? 'arena';
const carName = params.get('car') ?? 'axel';
const botCount = Math.max(0, Math.min(7, Number(params.get('bots') ?? 3)));
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
const hud = document.getElementById('hud')!;
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
  const { group, drawCalls } = await buildBatched(doc, bin, doc.scene);
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
  const collision = new LevelCollision(doc, bin, PS2_TO_THREE);
  console.info(`[colisão] ${collision.triangleCount} triângulos, BVH em ${Math.round(performance.now() - t0)} ms`);
  return { doc, collision, drawCalls };
}

/** Regras recuperadas do executável (tools/native/export_rules.py). */
async function loadVehicleRules(): Promise<Record<string, { wheels: number[][] }>> {
  const r = await fetch(assetURL('rules/vehicles.json'));
  return r.ok ? (await r.json()).vehicles : {};
}

type CarAsset = { template: THREE.Group; shape: VehicleShape; doc: ModelDoc; bin: ArrayBuffer };
const carCache = new Map<string, Promise<CarAsset>>();
function loadCarModel(name: string, rules: Record<string, { wheels: number[][] }>) {
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
 * Objetos do GLOBALS.BDD usados como peças de jogo (prefabs centrados na origem).
 * ⚠️ ESCOLHA DO HOST: o índice → significado foi identificado visualmente (docs/NATIVE.md).
 */
const GLOBAL_OBJECTS = { missile: 16, fireball: 36, burst: 29 } as const;

/**
 * Pickup (id do PKP / tabela 0x2c3a00) -> objeto do GLOBALS com o modelo 3D da arma + cor da aura.
 * ⚠️ ESCOLHA DO HOST: modelos identificados visualmente (16 míssil laranja, 19 roxo, 21 prateado com
 * brilho vermelho, 22 dinamite com antena, 23 arco, 24 três foguetes, 25 tanques…); cores da aura pela
 * cor do próprio modelo. 20 (placa amarela) = Environment Attack e armas sem modelo próprio.
 */
const PICKUP_MODELS: Record<number, { obj: number; aura: number }> = {
  0: { obj: 20, aura: 0xffd040 }, // Machine Gun
  1: { obj: 16, aura: 0xff7a1a }, // Fire Missile
  2: { obj: 19, aura: 0xc040ff }, // Homing
  3: { obj: 24, aura: 0xffc020 }, // Swarmer
  4: { obj: 25, aura: 0xff5010 }, // Napalm
  5: { obj: 23, aura: 0x60e0ff }, // Ricochet
  6: { obj: 21, aura: 0xff2020 }, // Power Missile
  7: { obj: 15, aura: 0x40a0ff }, // Turbo
  8: { obj: 18, aura: 0x40ff60 }, // Health 30%
  9: { obj: 20, aura: 0xffd040 }, // Environment Attack
  10: { obj: 26, aura: 0x40ff40 }, // Upgrade
  11: { obj: 22, aura: 0xff8040 }, // Remote Bomb
  12: { obj: 17, aura: 0x40ff60 }, // Full Health
  14: { obj: 20, aura: 0xffd040 }, // Mega Gun
};

/** Brilho radial para a aura dos pickups (textura gerada; o PS2 usa um sprite aditivo). */
let auraTexture: THREE.Texture | null = null;
function auraSprite(color: number): THREE.Sprite {
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
  sp.scale.setScalar(3.2); // no espaço normalizado do ícone (raio 1)
  return sp;
}

async function loadGlobalObject(doc: ModelDoc, bin: ArrayBuffer, index: number): Promise<THREE.Group> {
  const { group } = await buildBatched(doc, bin, doc.objects?.[index]?.instances ?? []);
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
  machinegun: 0, fire: 2, homing: 3, napalm: 4, power: 6, ricochet: 7, swarmer: 9, remote: 10,
};
const WEAPON_PICKUP: Record<WeaponId, number> = {
  machinegun: 0, fire: 1, homing: 2, swarmer: 3, napalm: 4, ricochet: 5, power: 6, remote: 11,
};

/**
 * Modelo do projétil pendurado no marcador 0x00F0 do lançador (FUN_00147568), em escala nativa e no quadro do
 * marcador (coordenadas do PS2). O jogo pega o modelo numa tabela por tipo (0x37cbf0+0xda24, preenchida em
 * runtime); ⚠️ ESCOLHA DO HOST: o objeto do GLOBALS é o do ícone do pickup da arma (identificação visual).
 */
async function loadProjectileModel(doc: ModelDoc, bin: ArrayBuffer, index: number): Promise<THREE.Group> {
  const { group } = await buildBatched(doc, bin, doc.objects?.[index]?.instances ?? []);
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
    out[key] = await loadGlobalObject(doc, bin, index);
  }
  const pickups = new Map<number, THREE.Group>();
  for (const [id, { obj, aura }] of Object.entries(PICKUP_MODELS)) {
    const icon = await loadGlobalObject(doc, bin, obj);
    const holder = new THREE.Group();
    holder.add(icon, auraSprite(aura));
    pickups.set(Number(id), holder);
  }
  const projectiles = new Map<WeaponId, THREE.Group>();
  for (const [w, id] of Object.entries(WEAPON_PICKUP) as [WeaponId, number][]) {
    const obj = PICKUP_MODELS[id]?.obj;
    if (obj !== undefined && obj !== 20) projectiles.set(w, await loadProjectileModel(doc, bin, obj));
  }
  return { ...out, pickups, projectiles };
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
  const [{ doc: lvl, collision, drawCalls }, globals, ...cars] = await Promise.all([
    loadLevel(),
    loadGlobals(),
    loadCarModel(carName, rules),
    ...bots.map((b) => loadCarModel(b, rules)),
  ]);
  const spawns = spawnPoints(lvl, collision);
  const match = new Match(collision, spawns, (p, s) => placeOnGround(p, s, collision));
  const player = match.addCar('Você', carName, cars[0].shape, false);
  bots.forEach((b, i) => match.addCar(b, b, cars[i + 1].shape, true));
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
  const projModels = match.cars.map(() => new Map<WeaponId, THREE.Object3D>());
  const projectileFor = (i: number, w: WeaponId) => {
    let o = projModels[i].get(w);
    const src = globals.projectiles.get(w);
    if (!o && src) projModels[i].set(w, (o = src.clone()));
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
  // Projéteis: pool de mísseis.
  const missiles: THREE.Object3D[] = [];
  const missileFor = (i: number) => {
    while (missiles.length <= i) {
      const m = globals.missile.clone();
      m.scale.multiplyScalar(2.5);
      scene.add(m);
      missiles.push(m);
    }
    return missiles[i];
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
  const explode = (pos: V3, big: boolean) => {
    for (const [src, life, grow] of [[globals.fireball, 0.6, big ? 30 : 14], [globals.burst, 0.35, big ? 40 : 18]] as const) {
      const o = src.clone();
      o.position.set(pos.x, pos.y, pos.z);
      o.scale.setScalar(1);
      scene.add(o);
      fx.push({ obj: o, age: 0, life, grow });
    }
  };

  const input = new Input(abort.signal);
  const audio = new AudioEngine(levelName, abort.signal);
  // Nomes dos sons do GLOBAL.BNK (nativos) para cada evento.
  const LAUNCH: Record<WeaponId, string> = {
    machinegun: 'W_MGUN', fire: 'W_FIREMISS_LNCH', homing: 'W_HOMMISS_LNCH', swarmer: 'W_SWARM_LNCH',
    napalm: 'W_NAP_LAUNCH', ricochet: 'W_RICO_LNCH', power: 'W_PWRMISS_LNCH', remote: 'W_REMOTE_DROP',
  };
  const EXPLO: Record<WeaponId, string> = {
    machinegun: 'W_EXPLO_SML', fire: 'W_EXPLO_MED', homing: 'W_EXPLO_MED', swarmer: 'W_EXPLO_SML',
    napalm: 'W_EXPLO_LRG', ricochet: 'W_EXPLO_MED', power: 'W_EXPLO_LRG', remote: 'W_EXPLO_LRG',
  };
  let lastGunSound = 0;
  const toasts: { text: string; t: number }[] = [];
  const toast = (text: string) => toasts.push({ text, t: 2.5 });
  const handle = (e: MatchEvent) => {
    if (e.kind === 'shot') {
      tracerList.push({ from: e.from, to: e.to, age: 0 });
      muzzleUntil[e.car] = performance.now() + 60;
      // Metralhadora: um som a cada ~3 tiros por carro para não saturar.
      if (performance.now() - lastGunSound > 90 || e.car === player.id) {
        audio.play('global', 'W_MGUN', { pos: e.from, volume: e.car === player.id ? 0.7 : 0.5 });
        lastGunSound = performance.now();
      }
    } else if (e.kind === 'launch') {
      audio.play('global', LAUNCH[e.weapon], { pos: e.pos });
    }
    else if (e.kind === 'impact') audio.play('global', e.speed > 60 ? 'V_MAJOR_COLL' : 'V_CRASH', { pos: e.pos, volume: Math.min(1, e.speed / 60) });
    else if (e.kind === 'hit') {
      // Golpe direto nas peças destrutíveis do carro (categoria ≠ 0x46; FUN_00171838). ⚠️ host: peça mais perto.
      const r = rigs[e.car];
      if (r) r.hitPart(r.group.worldToLocal(new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z)), e.amount, performance.now() / 1000, 4);
    } else if (e.kind === 'explosion') {
      explode(e.pos, e.weapon === 'power' || e.weapon === 'napalm' || e.weapon === 'remote');
      audio.play('global', EXPLO[e.weapon], { pos: e.pos });
    } else if (e.kind === 'pickup') {
      const eff = pickupEffect(e.pickupId);
      audio.play('global', eff.kind === 'health' ? 'P_PARTIALHEALTH' : eff.kind === 'turbo' ? 'P_TURBO' : 'P_WEAPON', { pos: match.center(match.cars[e.car]) });
      if (e.car === player.id) toast(e.name);
    } else if (e.kind === 'killed') {
      audio.play('global', 'W_EXPLO_HUGE1', { pos: e.pos });
      if (e.victim === player.id) audio.play('global', 'W_PLAYER_DEATH');
      const v = match.cars[e.victim];
      const k = e.killer !== null ? match.cars[e.killer] : null;
      toast(k && k !== v ? `${k.name} destruiu ${v.name}` : `${v.name} foi destruído`);
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
  let turboWas = false;
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
            const t = WEAPON_TYPE[mt.weapon];
            r.setSelector(0x1b1, t === 2 ? 1 : t === 3 ? 2 : 0);
            r.setSelector(0x1b2, t === 6 ? 1 : t === 9 ? 2 : 0);
            r.setProjectile(t, projectileFor(i, mt.weapon));
          } else if (!mine && mt.state === 1) {
            mt.state = 2; // fecha: seletores voltam a 0; o modelo sai quando o clipe termina (FUN_001474f0)
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
    // Projéteis.
    match.projectiles.forEach((p, i) => {
      const m = missileFor(i);
      m.visible = true;
      m.position.set(p.pos.x, p.pos.y, p.pos.z);
      m.lookAt(p.pos.x + p.vel.x, p.pos.y + p.vel.y, p.pos.z + p.vel.z);
    });
    for (let i = match.projectiles.length; i < missiles.length; i++) missiles[i].visible = false;
    // Traçantes (70 ms).
    tracerList = tracerList.filter((tr) => (tr.age += dt) < 0.07).slice(-64);
    tracerPos.fill(0);
    tracerList.forEach((tr, i) => tracerPos.set([tr.from.x, tr.from.y, tr.from.z, tr.to.x, tr.to.y, tr.to.z], i * 6));
    tracerGeo.attributes.position.needsUpdate = true;
    tracerGeo.setDrawRange(0, tracerList.length * 2);
    debris.update(dt, t);
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

    // Áudio: ouvinte na câmera; motores do jogador e dos bots.
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    audio.listener(camera.position, camDir);
    for (const c of match.cars) {
      const sp = speedOf(c.state) / 150;
      audio.engine(c.id, c.model, sp, c.id === player.id ? a.throttle : 0.7, match.center(c), c.deadFor === 0);
    }
    if (a.turbo && a.throttle > 0 && player.turbo > 1 && !turboWas) audio.play('global', 'V_TURBO_LAUNCH', { volume: 0.8 });
    turboWas = a.turbo && a.throttle > 0;

    skyUpdate?.(camera);
    renderer.render(scene, camera);
    renderHud(fps, drawCalls, collision.triangleCount, dt);
  });

  function renderHud(fps: number, drawCalls: number, tri: number, dt: number) {
    for (const tt of toasts) tt.t -= dt;
    while (toasts.length && toasts[0].t <= 0) toasts.shift();
    const hp = Math.round((player.health / MATCH_RULES.maxHealth) * 100);
    const turbo = Math.round((player.turbo / MATCH_RULES.turboMax) * 100);
    const weapons = (Object.entries(player.ammo) as [WeaponId, number][])
      .filter(([, n]) => n > 0)
      .map(([w, n]) => `<span class="${w === player.selected ? 'sel' : ''}">${WEAPON_RULES[w].name} ×${n}</span>`)
      .join(' ');
    const board = [...match.cars].sort((x, y) => y.kills - x.kills).map((c) => `${c.name} ${c.kills}/${c.deaths}`).join(' · ');
    hud.innerHTML = `
      <div class="bars"><div class="bar hp"><i style="width:${hp}%"></i><b>VIDA ${hp}</b></div>
      <div class="bar turbo"><i style="width:${turbo}%"></i><b>TURBO</b></div></div>
      <div>${Math.round(speedOf(player.state) * 0.6818)} mph · ${weapons || 'sem armas especiais (pegue os ícones)'}</div>
      <div class="small">${board}</div>
      ${player.deadFor > 0 ? `<div class="dead">DESTRUÍDO — renascendo…</div>` : ''}
      ${!audio.started ? `<div class="small">🔇 aperte qualquer tecla para ligar o som</div>` : audio.isMuted ? `<div class="small">🔇 mudo (M)</div>` : ''}
      ${toasts.map((tt) => `<div class="toast">${tt.text}</div>`).join('')}
      <div class="small">${levelName} · ${fps} fps · ${drawCalls} draw calls · ${tri} tri de colisão · pickups ${match.pickups.length} (renascem em ${PICKUP_RULES.respawn}s)</div>`;
  }

  // Ganchos para QA (tools/web).
  (window as any).__doorsDebug = () => ({
    mounts: mountsOf.map((ms) => ms.map((m) => ({ category: m.clip.category, weapon: m.weapon, state: m.state, t: +m.t.toFixed(2) }))),
    now: performance.now() / 1000,
    ammo: match.cars[0].ammo,
  });
  (window as any).__game = {
    audio,
    pickupObjs,
    state: () => player.state,
    setState: (s: VehicleState) => (player.state = s),
    match,
    damage: () => rigs.map((r) => r?.damageStates() ?? null),
    selectors: () => rigs.map((r) => r?.selectorStates() ?? null),
    debris: () => debris.count,
    debrisSys: debris,
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
