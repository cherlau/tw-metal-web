// Menu: escolha de carro (prévia 3D girando), arena e número de bots. Inicia play.html?lvl=…&car=…&bots=…
import * as THREE from 'three';
import { assetURL, loadModel } from './assets';
import { AudioEngine } from './audio';
import { CAR_GROUPS, displayName, LEVEL_GROUPS } from './catalog';
import { VEHICLE_TO_THREE } from './coords';
import { buildCarRest, visibleBox } from './rig';

const abort = new AbortController();
addEventListener('pagehide', () => abort.abort());
new AudioEngine('menu', abort.signal); // nível sem faixas -> trilha do menu

const STORE = 'tmweb.menu';
interface Choice {
  car: string;
  lvl: string;
  bots: number;
}
let choice: Choice = { car: 'axel', lvl: 'arena', bots: 3 };
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

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function main() {
  const rules: Record<string, { name?: string }> = await fetch(assetURL('rules/vehicles.json'))
    .then((r) => (r.ok ? r.json() : { vehicles: {} }))
    .then((j) => j.vehicles)
    .catch(() => ({}));
  const carName = (id: string) => displayName(rules[id]?.name, id);

  root.innerHTML = `
    <h1>TWISTED METAL <small>Head-On · Extra Twisted — port para navegador feito por fãs</small></h1>
    <div class="cols">
      <section class="cars">
        ${CAR_GROUPS.map((g) => `<h2>${esc(g.title)}</h2><div class="grid">${g.cars.map((c) => `<button data-car="${c}">${esc(carName(c))}</button>`).join('')}</div>`).join('')}
      </section>
      <section class="preview">
        <div id="preview"></div>
        <div class="carname" id="carname"></div>
        <label class="bots">Adversários (bots): <input type="range" id="bots" min="0" max="7" step="1"> <b id="botsv"></b></label>
        <button id="start" class="start">JOGAR ▶</button>
        <p class="keys">←/→ carro · Enter jogar · na partida: Esc volta ao menu</p>
      </section>
      <section class="levels">
        ${LEVEL_GROUPS.map((g) => `<h2>${esc(g.title)}</h2><div class="grid">${g.levels.map((l) => `<button data-lvl="${l.id}">${esc(l.name)}</button>`).join('')}</div>`).join('')}
      </section>
    </div>`;

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
    document.getElementById('carname')!.textContent = carName(id);
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
    (document.getElementById('bots') as HTMLInputElement).value = String(choice.bots);
    document.getElementById('botsv')!.textContent = String(choice.bots);
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
      if (b.id === 'start') return start();
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
    save();
    location.href = `play.html?lvl=${encodeURIComponent(choice.lvl)}&car=${encodeURIComponent(choice.car)}&bots=${choice.bots}`;
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
    turntable.rotation.y = t / 1600;
    renderer.render(scene, camera);
  });
}

main().catch((e) => {
  root.textContent = `Falha ao abrir o menu: ${e}`;
  console.error(e);
});
