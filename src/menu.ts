// Menu com a arte original (SHELL/UI.BDD, SHELL/SWIRL.BDD, fonte do RESIDENT; tools/export_ui.py): logo montado
// das malhas da tela de título, ícones de seleção, cartão do piloto, biografia do ELF, miniaturas das arenas do
// mapa-múndi e o túnel verde do SWIRL ao fundo. Inicia play.html?lvl=…&car=…&bots=…
// ⚠️ ESCOLHA DO HOST: o arranjo das telas (o jogo monta cada tela pelo UiScript.cpp — não reproduzido).
import * as THREE from 'three';
import { assetURL, loadModel } from './assets';
import { AudioEngine } from './audio';
import { CAR_GROUPS, displayName, LEVEL_GROUPS } from './catalog';
import { HudFont, type Rgba } from './font';
import { PS2_TO_THREE } from './coords';
import { buildBatched } from './render';
import { buildCarRest, visibleBox } from './rig';

const abort = new AbortController();
addEventListener('pagehide', () => abort.abort());
const audio = new AudioEngine('menu', abort.signal); // nível sem faixas -> trilha do menu
/** Prefixo dos sons de seleção do SHELL.BNK (<CARRO>_REV, <CARRO>_IDLE_L). ⚠️ host: quando o jogo os toca. */
const SHELL_CAR: Record<string, string> = {
  axel: 'AXEL', cop: 'COP', crim: 'CRIMSON', sweet: 'SWEETT', twist: 'TWISTER', spectre: 'SPECTRE', thump: 'THUMPER',
  grass: 'GRASS', hamr: 'HAMMER', rkill: 'ROADKILL', wart: 'WARTHOG', mrslam: 'MRSLAM', mrgrim: 'GRIMM', hearse: 'SHADOW',
  edatv: 'ATV', edboss: 'EDDY', dark1: 'DARKT1', dark2: 'DARKT2', edplayer: 'EDDY', darkpla1: 'DARKT1',
};
/** Versões jogáveis usam ícone, cartão e biografia do chefe (o UI.BDD só os tem com o id do chefe). ⚠️ host */
const UI_ID: Record<string, string> = { edplayer: 'edboss', darkpla1: 'dark1' };
const uiId = (id: string) => UI_ID[id] ?? id;
let idleKey = '';
/** Som da seleção: S_SCROLL, ronco do carro e marcha lenta em laço; ambiente FE_AMB por baixo. */
function selectSound(car: string | null) {
  audio.loop('fe', 'shell', 'FE_AMB', 0.6);
  audio.play('shell', 'S_SCROLL');
  const pre = car ? SHELL_CAR[car] : undefined;
  if (idleKey && idleKey !== pre) audio.loop(`idle${idleKey}`, 'shell', `${idleKey}_IDLE_L`, 0, { fade: 0.3 });
  if (!pre) return;
  if (idleKey !== pre) audio.play('shell', `${pre}_REV`);
  audio.loop(`idle${pre}`, 'shell', `${pre}_IDLE_L`, 0.7);
  idleKey = pre;
}

const STORE = 'tmweb.menu';
interface Choice {
  car: string;
  lvl: string;
  bots: number;
  diff: number;
}
let choice: Choice = { car: 'axel', lvl: 'arena', bots: 3, diff: 2 };
/** Dificuldades do jogo (ponteiros em 0x2c45b8; valor 0..3 de FUN_00190448(0x2f4b24)). */
const DIFFICULTIES = ['SUPER EASY', 'EASY', 'MEDIUM', 'HARD'];
try {
  choice = { ...choice, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') };
} catch {
  /* armazenamento indisponível: usa o padrão */
}
const save = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify(choice));
  } catch {
    /* ignora */
  }
};

const allCars = CAR_GROUPS.flatMap((g) => g.cars);
if (!allCars.includes(choice.car)) choice.car = 'axel';
if (!LEVEL_GROUPS.some((g) => g.levels.some((l) => l.id === choice.lvl))) choice.lvl = 'arena';

document.getElementById('hud')!.hidden = true;
document.getElementById('help')!.hidden = true;
document.getElementById('loading')!.hidden = true;
const root = document.getElementById('menu')!;
root.hidden = false;

interface MenuDoc {
  icons: Record<string, string>;
  cards: Record<string, string>;
  levels: Record<string, string>;
  levelNames: Record<string, string>;
  bios: Record<string, { car: string; driver: string; bio: string }>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Texto na fonte do jogo como <canvas> (2× para nitidez); cor no formato do PS2 (0x80 = 1,0). */
function label(font: HudFont, text: string, size: number, color: Rgba, cls = ''): HTMLCanvasElement {
  const k = 2;
  const c = document.createElement('canvas');
  font.squash = 1;
  c.width = Math.ceil(font.width(text, size) * k) + 4;
  c.height = Math.ceil(size * k) + 4;
  c.style.width = `${c.width / k}px`;
  c.style.height = `${c.height / k}px`;
  if (cls) c.className = cls;
  const g = c.getContext('2d')!;
  g.setTransform(k, 0, 0, k, 1, 1);
  font.draw(g, text, 0, 0, size, color, 'left');
  c.setAttribute('aria-label', text);
  return c;
}

/** Túnel do SWIRL.BDD girando atrás do menu. ⚠️ host: o clipe do objeto 0x239c anima canais sem osso (rolagem de
 *  textura, presume-se); aqui as texturas rolam ao longo do túnel no tempo do clipe (1994 quadros). */
async function swirlBackground(holder: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  holder.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 2000);
  const { doc, bin } = await loadModel('shell/swirl');
  const { group } = await buildBatched(doc, bin, doc.scene);
  group.matrixAutoUpdate = false;
  group.matrix.copy(PS2_TO_THREE);
  scene.add(group);
  const maps: THREE.Texture[] = [];
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (m?.map && !maps.includes(m.map)) maps.push(m.map);
  });
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize, { signal: abort.signal });
  resize();
  return (t: number) => {
    const u = (t / 1000) * (60 / 1994);
    maps.forEach((m, i) => (i === 0 ? m.offset.set(0, -u) : m.offset.set(u, -u * 0.5)));
    group.rotation.z = 0;
    camera.rotation.z = t / 9000;
    renderer.render(scene, camera);
  };
}

async function main() {
  const [rules, menu, font]: [Record<string, { name?: string }>, MenuDoc, HudFont] = await Promise.all([
    fetch(assetURL('rules/vehicles.json'))
      .then((r) => (r.ok ? r.json() : { vehicles: {} }))
      .then((j) => j.vehicles)
      .catch(() => ({})),
    fetch(assetURL('ui/menu.json')).then((r) => r.json()),
    HudFont.load(0),
  ]);
  const carName = (id: string) => menu.bios[uiId(id)]?.car ?? displayName(rules[id]?.name, id);
  const levelName = (id: string) => menu.levelNames[id] ?? id;

  root.innerHTML = `
    <div id="menu-bg"></div>
    <div class="menu-shade"></div>
    <header><img class="logo" src="${assetURL('ui/logo.png')}" alt="Twisted Metal Head-On"></header>
    <div class="cols">
      <section class="cars">
        ${CAR_GROUPS.map((g) => `<div class="title" data-label="${esc(g.title)}"></div><div class="grid">${g.cars
          .map((c) => `<button data-car="${c}" title="${esc(carName(c))}"><img src="${assetURL(`ui/${menu.icons[uiId(c)] ?? ''}`)}" alt="${esc(carName(c))}"></button>`)
          .join('')}</div>`).join('')}
      </section>
      <section class="preview">
        <div id="preview"></div>
        <div class="carname" id="carname"></div>
        <img class="card" id="card" alt="">
        <p class="bio" id="bio"></p>
        <label class="bots"><span data-label="OPPONENTS"></span> <input type="range" id="bots" min="0" max="7" step="1"> <b id="botsv"></b></label>
        <div class="diff">${DIFFICULTIES.map((d, i) => `<button data-diff="${i}"><span data-label="${d}" data-size="12"></span></button>`).join('')}</div>
        <button id="start" class="start" data-label="START"></button>
        <p class="keys">←/→ carro · Enter jogar · na partida: Esc volta ao menu</p>
      </section>
      <section class="levels">
        ${LEVEL_GROUPS.map((g) => `<div class="title" data-label="${esc(g.title)}"></div><div class="grid">${g.levels
          .map((l) => `<button data-lvl="${l.id}"><img src="${assetURL(`ui/${menu.levels[l.id] ?? ''}`)}" alt=""><span data-label="${esc(levelName(l.id))}" data-size="12"></span></button>`)
          .join('')}</div>`).join('')}
      </section>
    </div>`;
  // Rótulos na fonte do jogo.
  for (const el of root.querySelectorAll<HTMLElement>('[data-label]')) {
    const size = Number(el.dataset.size ?? 16);
    el.append(label(font, el.dataset.label!, size, el.classList.contains('start') ? [0x10, 0x10, 0x10, 0x80] : [0xdd, 0xdb, 0x0a, 0x80]));
  }

  const bg = await swirlBackground(document.getElementById('menu-bg')!).catch((e) => {
    console.error(e);
    return null;
  });

  // ------------------------------------------------------------ prévia 3D
  const holder = document.getElementById('preview')!;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  holder.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  const turntable = new THREE.Group();
  scene.add(turntable);
  const resize = () => {
    const w = holder.clientWidth;
    const h = holder.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize, { signal: abort.signal });
  resize();

  const cache = new Map<string, Promise<THREE.Object3D>>();
  const loadCar = (id: string) => {
    let p = cache.get(id);
    if (!p) {
      p = (async () => {
        const { doc, bin } = await loadModel(`cars/${id}`);
        const group = await buildCarRest(doc, bin); // esqueleto do jogo: rodas e peças no lugar
        const wrap = new THREE.Group();
        wrap.add(group);
        const box = visibleBox(group);
        const c = box.getCenter(new THREE.Vector3());
        group.position.set(-c.x, -c.y, -c.z);
        wrap.userData.radius = box.getSize(new THREE.Vector3()).length() / 2;
        return wrap;
      })();
      cache.set(id, p);
    }
    return p;
  };

  let shown = '';
  const showCar = async (id: string) => {
    shown = id;
    const nameEl = document.getElementById('carname')!;
    nameEl.replaceChildren(label(font, carName(id), 22, [0xdd, 0xdb, 0x0a, 0x80]));
    const bio = menu.bios[uiId(id)];
    const card = document.getElementById('card') as HTMLImageElement;
    card.hidden = !menu.cards[uiId(id)];
    if (menu.cards[uiId(id)]) card.src = assetURL(`ui/${menu.cards[uiId(id)]}`);
    card.alt = bio ? `${bio.car} — ${bio.driver}` : '';
    document.getElementById('bio')!.textContent = bio ? `${bio.driver}: ${bio.bio}` : '';
    try {
      const obj = await loadCar(id);
      if (shown !== id) return;
      turntable.clear();
      turntable.add(obj);
      const r = obj.userData.radius as number;
      camera.position.set(0, r * 0.7, r * 2.6);
      camera.lookAt(0, 0, 0);
    } catch (e) {
      console.error(e);
    }
  };

  // ------------------------------------------------------------ seleção
  const refresh = () => {
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-car]')) b.classList.toggle('on', b.dataset.car === choice.car);
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-lvl]')) b.classList.toggle('on', b.dataset.lvl === choice.lvl);
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-diff]')) b.classList.toggle('on', Number(b.dataset.diff) === choice.diff);
    (document.getElementById('bots') as HTMLInputElement).value = String(choice.bots);
    document.getElementById('botsv')!.replaceChildren(label(font, String(choice.bots), 16, [0xdd, 0xdb, 0x0a, 0x80]));
    if (shown !== choice.car) void showCar(choice.car);
    save();
  };
  root.addEventListener(
    'click',
    (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.car) choice.car = b.dataset.car;
      if (b.dataset.lvl) choice.lvl = b.dataset.lvl;
      if (b.dataset.diff) choice.diff = Number(b.dataset.diff);
      if (b.id === 'start') return start();
      selectSound(b.dataset.car ?? null);
      refresh();
    },
    { signal: abort.signal },
  );
  document.getElementById('bots')!.addEventListener(
    'input',
    (e) => {
      choice.bots = Number((e.target as HTMLInputElement).value);
      refresh();
    },
    { signal: abort.signal },
  );
  const stepCar = (d: number) => {
    choice.car = allCars[(allCars.indexOf(choice.car) + d + allCars.length) % allCars.length];
    selectSound(choice.car);
    refresh();
  };
  addEventListener(
    'keydown',
    (e) => {
      if (e.code === 'ArrowLeft') stepCar(-1);
      else if (e.code === 'ArrowRight') stepCar(1);
      else if (e.code === 'Enter') start();
    },
    { signal: abort.signal },
  );
  const start = () => {
    audio.play('shell', 'S_ACCEPT');
    save();
    location.href = `play.html?lvl=${encodeURIComponent(choice.lvl)}&car=${encodeURIComponent(choice.car)}&bots=${choice.bots}&diff=${choice.diff}`;
  };

  // Gamepad: direcional/analógico troca o carro, A/Start joga.
  let padPrev = { l: false, r: false, a: false };
  const pollPad = () => {
    const p = [...(navigator.getGamepads?.() ?? [])].find((g) => g);
    if (!p) return;
    const l = p.buttons[14]?.pressed || p.axes[0] < -0.6;
    const r = p.buttons[15]?.pressed || p.axes[0] > 0.6;
    const a = p.buttons[0]?.pressed || p.buttons[9]?.pressed;
    if (l && !padPrev.l) stepCar(-1);
    if (r && !padPrev.r) stepCar(1);
    if (a && !padPrev.a) start();
    padPrev = { l: !!l, r: !!r, a: !!a };
  };

  refresh();
  (window as any).__menu = { choice, ready: () => turntable.children.length > 0 };
  renderer.setAnimationLoop((t) => {
    if (abort.signal.aborted) return renderer.setAnimationLoop(null);
    pollPad();
    bg?.(t);
    turntable.rotation.y = t / 1600;
    renderer.render(scene, camera);
  });
}

main().catch((e) => {
  root.textContent = `Falha ao abrir o menu: ${e}`;
  console.error(e);
});
