// Visualizador de modelos convertidos (M2). Uso: /?car=axel
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadModel, type InstanceDef, type ModelDoc } from './assets';
import { buildBatched, buildMeshObject } from './render';
import { buildLevelLights, buildSky } from './levelfx';
import { buildCarRest, visibleBox } from './rig';
import { PS2_TO_THREE } from './coords';

const params = new URLSearchParams(location.search);
const carName = params.get('car') ?? 'axel';
// ?lvl=arena abre um nível em vez de um carro
const levelName = params.get('lvl');
// ?novc=1 desliga as cores de vértice (diagnóstico de iluminação pré-calculada)
const vertexColors = params.get('novc') !== '1';
// Padrão: só textura × cor de vértice (a iluminação do PS2 já vem pré-calculada nas cores).
// ?lit=1 usa iluminação dinâmica (Lambert) para depurar normais.
const unlit = params.get('lit') !== '1';
// ?only=regex / ?hide=regex filtram malhas pelo nome (ex.: hide=m0122|m0129)
const only = params.get('only') ? new RegExp(params.get('only')!) : null;
const hide = params.get('hide') ? new RegExp(params.get('hide')!) : null;
// ?maxr=8 esconde malhas com bounding sphere maior que 8 m (efeitos: ondas de choque, escudos)
const maxRadius = Number(params.get('maxr') ?? Infinity);
const dir = levelName ? 'lvl' : params.get('dir') ?? 'cars';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x30343c);
scene.add(new THREE.GridHelper(20, 20, 0x666666, 0x444444));
scene.add(new THREE.AxesHelper(3)); // vermelho = +X, verde = +Y, azul = +Z
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(5, 10, 7);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 20000);
camera.position.set(9, 6, 12);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);

const root = new THREE.Group();
root.matrixAutoUpdate = false;
root.matrix.copy(PS2_TO_THREE);
scene.add(root);

// Ganchos para QA (tools/web/shot.mjs).
(window as any).__viewer = { THREE, scene, camera, controls, root };

const panel = document.getElementById('panel')!;
const status = document.getElementById('status')!;

async function main() {
  const { doc, bin } = await loadModel(`${dir}/${levelName ?? carName}`);
  status.textContent = `${doc.name} [scene=${sceneMode}, ${doc.scene.length} instâncias]: ${doc.counts.meshes} malhas · ${doc.counts.triangles} tri · ${doc.counts.sprites} sprites · ${doc.counts.textures} texturas`;
  if (doc.errors.length) status.textContent += ` · ERROS: ${doc.errors.join('; ')}`;
  await build(doc, bin);
  (window as any).__ready = true;
}

// ?scene=on (padrão: pose base pelo scene graph) | off (todas as malhas cruas)
const sceneMode = params.get('scene') ?? 'on';
// ?fx=1 mostra também os slots de efeito (escudo, gelo, fogo, turbo…)
const showFx = params.get('fx') === '1';
// ?obj=N mostra só o objeto N da lista de objetos (níveis/globals: pickups, projéteis, efeitos…)
const objIndex = params.get('obj');

const renderOpts = { unlit, vertexColors };

async function buildBatchedView(doc: ModelDoc, instances: InstanceDef[], bin: ArrayBuffer) {
  const { group, drawCalls, triangles } = await buildBatched(
    doc,
    bin,
    instances, // mantém o deslocamento dos objetos posicionados (nós 0x03/0x1F)
    { ...renderOpts, filter: (key, def) => def.sphere[3] <= maxRadius && (!only || only.test(key)) && !(hide && hide.test(key)) },
  );
  root.add(...group.children);
  status.textContent += ` · ${drawCalls} draw calls · ${triangles} tri visíveis`;
}

async function build(doc: ModelDoc, bin: ArrayBuffer) {
  // ?batch=0 desliga o batching (uma malha por instância, com nome — para depuração/raycast)
  if (levelName && params.get('batch') !== '0') {
    panel.hidden = true;
    await buildBatchedView(doc, doc.scene, bin);
    if (params.get('lights') !== '0') root.add(await buildLevelLights(doc, doc.scene));
    const sky = params.get('sky') !== '0' ? await buildSky(doc, bin, PS2_TO_THREE, buildBatched) : null;
    if (sky) {
      scene.add(sky.group);
      skyUpdate = sky.update;
    }
    frame();
    return;
  }
  // Carro com esqueleto: pose de repouso do jogo (?rig=0 mostra as malhas cruas, por malha)
  if (!levelName && (doc as ModelDoc & { rig?: unknown }).rig && params.get('rig') !== '0' && objIndex === null && sceneMode !== 'off' && !showFx) {
    const g = await buildCarRest(doc, bin);
    // a raiz do visualizador já aplica PS2_TO_THREE: tira a conversão própria do carro
    (g.children[0] as THREE.Object3D).matrix.identity();
    root.add(g);
    panel.hidden = true;
    frame();
    return;
  }
  const list = document.createElement('div');
  const entries: { key: string; bone?: string | null }[] =
    objIndex !== null
      ? (doc.objects?.[Number(objIndex)]?.instances ?? []).map((i) => ({ key: i.mesh, bone: i.bone }))
      : sceneMode === 'off'
      ? Object.keys(doc.meshes).map((key) => ({ key }))
      : [...doc.scene, ...(showFx ? Object.values(doc.effects).flat() : [])].map((i) => ({ key: i.mesh, bone: i.bone }));
  for (const [n, { key, bone }] of entries.entries()) {
    const def = doc.meshes[key];
    const group = await buildMeshObject(doc, bin, key, renderOpts);
    // ?front=1 desenha só a face de fora (como o jogo faz com os ícones de pickup)
    if (params.get('front') === '1')
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) (m.material = (m.material as THREE.Material).clone()).side = THREE.FrontSide;
      });
    group.visible = (!only || only.test(key)) && !(hide && hide.test(key)) && def.sphere[3] <= maxRadius;
    // ?pose=alt aplica a 2ª matriz do osso (+0x60) sobre a inversa (+0x20): p' = bind · invBind · p.
    // Hipótese: em ossos "incoerentes" ela é a pose alternativa (porta aberta, arma exposta).
    if (params.get('pose') === 'alt' && bone && doc.bones[bone]?.bind) {
      const b = doc.bones[bone];
      const m = new THREE.Matrix4().fromArray(b.bind!).multiply(new THREE.Matrix4().fromArray(b.invBind));
      group.applyMatrix4(m);
    }
    root.add(group);

    const row = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = group.visible;
    cb.onchange = () => (group.visible = cb.checked);
    row.append(cb, ` ${n} ${key} ${def.texture ?? ''} ${bone ?? ''}`);
    row.onmouseenter = () => highlight(group, true);
    row.onmouseleave = () => highlight(group, false);
    list.append(row);
  }
  panel.append(list);
  if (objIndex !== null) frame();
}

/** Enquadra a câmera no conteúdo (níveis são muito maiores que carros). */
function frame() {
  const box = visibleBox(root); // ignora peças escondidas (armas recolhidas)
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(0.35, 0.45, 0.6).normalize().multiplyScalar(size * 1.1));
  camera.near = size / 5000;
  camera.far = size * 4;
  camera.updateProjectionMatrix();
  controls.update();
}

function highlight(group: THREE.Object3D, on: boolean) {
  group.visible = on || group.userData.visible !== false;
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.material = on ? highlightMaterial : o.userData.material ?? o.material;
  });
}
const highlightMaterial = new THREE.MeshBasicMaterial({ color: 0xff8800, wireframe: true });

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
// Câmera livre: WASD move no plano da visão, Q/E desce/sobe, Shift acelera (move câmera e alvo juntos).
const keys = new Set<string>();
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName !== 'SELECT') keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const clock = new THREE.Clock();
const flyDir = new THREE.Vector3();
const flyRight = new THREE.Vector3();
function fly() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!keys.size) return;
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5 : 1) * Math.max(5, camera.position.distanceTo(controls.target) * 0.6);
  camera.getWorldDirection(flyDir);
  flyRight.crossVectors(flyDir, camera.up).normalize();
  const move = new THREE.Vector3();
  if (keys.has('KeyW')) move.add(flyDir);
  if (keys.has('KeyS')) move.sub(flyDir);
  if (keys.has('KeyD')) move.add(flyRight);
  if (keys.has('KeyA')) move.sub(flyRight);
  if (keys.has('KeyE')) move.y += 1;
  if (keys.has('KeyQ')) move.y -= 1;
  if (!move.lengthSq()) return;
  move.normalize().multiplyScalar(speed * dt);
  camera.position.add(move);
  controls.target.add(move);
}

// Seletor de modelo (public/assets/index.json, gerado por tools/build_index.py).
fetch(`${import.meta.env.BASE_URL}assets/index.json`)
  .then((r) => (r.ok ? r.json() : null))
  .then((index: Record<string, string[]> | null) => {
    if (!index) return;
    const select = document.createElement('select');
    select.id = 'picker';
    const current = levelName ? `lvl=${levelName}` : `${dir === 'cars' ? 'car' : `dir=${dir}&car`}=${carName}`;
    for (const [group, names] of Object.entries(index)) {
      const og = document.createElement('optgroup');
      og.label = { lvl: 'Arenas', cars: 'Carros', aicars: 'Carros (IA)' }[group] ?? group;
      for (const n of names) {
        const value = group === 'lvl' ? `lvl=${n}` : group === 'cars' ? `car=${n}` : `dir=${group}&car=${n}`;
        og.append(new Option(n, value, false, value === current));
      }
      select.append(og);
    }
    select.onchange = () => (location.search = `?${select.value}`);
    document.body.append(select);
    // Atalho para dirigir: arena atual (ou a Arena) com o carro atual (ou o Axel).
    const play = document.createElement('a');
    play.id = 'play';
    play.textContent = '▶ jogar';
    play.href = `play.html?lvl=${levelName ?? 'arena'}&car=${levelName ? 'axel' : carName}`;
    document.body.append(play);
  });

addEventListener('resize', resize);
resize();
let skyUpdate: ((camera: THREE.Camera) => void) | null = null;
renderer.setAnimationLoop(() => {
  fly();
  controls.update();
  skyUpdate?.(camera);
  renderer.render(scene, camera);
});

main().catch((e) => {
  status.textContent = `Falha: ${e}`;
  console.error(e);
});
