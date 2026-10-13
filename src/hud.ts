// HUD do jogo (RE: docs/NATIVE.md "HUD"): peças 3D do GLOBALS presas à câmera + texto com a fonte original.
//
// Widgets do objeto do HUD (FUN_0013b060, vtables 0x2d62a0..0x2d64b0) e o que cada um faz por quadro:
//   +0x00C0 radar (cat. 0x206d, FUN_00137148): inimigos a < 900 pés em pontos coloridos (cor por veículo, tabela
//           0x2ba6c8), deslocamento = (direita·0,054, frente·0,028)·12,5/16 px a partir do centro do radar
//   +0x2210 vida (FUN_00139938): clipe 0 do objeto 0x206e com tempo = vida/vidaMáx; pisca abaixo de 15 %;
//           nome do alvo em (142, 9), tamanho 14, cor (0x46, 100, 0x46), sem sombra (FUN_00139780)
//   +0x22d0 turbo/energia (FUN_00139de0): clipe 2 = carro+0x6894 (turbo), clipe 1 = carro+0x6898 (energia)
//   +0x2280 aquecimento da metralhadora (FUN_0013a378): seletor 0x1f52 (calor < 10 → 1)
//   +0x2330 mensagens (FUN_0013a0b8): fila de 4, 120 quadros cada, centradas em (320, 6), tamanho 14,
//           cor (0xdd, 0xdb, 0x0a)
//   +0x24e0 armas (FUN_0013aa88): seletores 0x2080 (modelo 3D da arma atual), 0x2082 (próxima), 0x2081
//           (anterior); nome em (538, 152) e munição em (538, 186), tamanho 12, cor (0x46, 0x46, 0x46)
// Posição de cada raiz (FUN_0019e580): câmera + (x·prof/1,5, prof, z·prof·0,5) com a rotação da câmera.
import * as THREE from 'three';
import type { InstanceDef, ModelDoc, SelectorDef } from './assets';
import { PS2_TO_THREE } from './coords';
import { HudFont, SCREEN_H, SCREEN_W, type Rgba } from './font';
import { CarRig, type RigDoc } from './rig';

interface HudRootDef {
  node: string;
  category: number;
  /** (x, profundidade, z) de FUN_0013b310 para 1 jogador */
  pos: [number, number, number];
  instances: InstanceDef[];
  selectors: Record<string, SelectorDef>;
  rig: RigDoc;
}

/** Inventário do jogo (carro+0x4fbc; nomes 0x2ba680): índice → nome no painel. A metralhadora fica fora. */
export const INVENTORY_NAMES = ['Special', 'Fire', 'Homing', 'Napalm', 'Power', 'Rico', 'Env', 'Swarm', 'Remote'];
/** Variante Harbor City (0x2ba6a8). */
export const INVENTORY_NAMES_HC = ['Special', 'Fire', 'Homing', 'GasCan', 'Power', 'Rico', 'Remote'];

/** Cor do ponto no radar por veículo (0x2ba6c8 + id·16, RGBA; id = categoria do modelo − 0x65). */
export const RADAR_COLORS: [number, number, number][] = [
  [104, 92, 224], [184, 107, 255], [227, 47, 55], [215, 215, 215], [255, 202, 213], [180, 76, 126], [59, 82, 160],
  [250, 0, 255], [255, 250, 12], [255, 255, 255], [173, 74, 83], [115, 223, 255], [100, 186, 77], [202, 255, 142],
  [200, 125, 75], [164, 164, 164], [255, 202, 213], [255, 202, 213], [104, 92, 224], [168, 95, 42], [184, 107, 255],
  [227, 47, 55], [244, 232, 255], [215, 215, 215], [100, 255, 95], [34, 52, 166], [255, 202, 213], [255, 239, 58],
  [176, 150, 83], [59, 82, 150], [156, 130, 83], [59, 82, 130], [136, 180, 53], [255, 202, 213],
];

/** Nomes curtos dos veículos (0x2b39f0 + i·0x20) — nome do alvo no topo da tela. */
export const SHORT_NAMES = [
  'Axel', 'Shadow', 'Mr. Grimm', 'Roadkill', 'SweetTooth', 'Thumper', 'Spectre', 'Twister', 'Mr. Slam', 'Outlaw',
  'Crimson', 'Hammer', 'Grasshop', 'Warthog', 'ATV', 'CousinEddy', 'DarkTooth', 'TowerTooth', 'Axel', 'Crazy 8',
  'Shadow', 'Mr. Grimm', 'Brimstone', 'Roadkill', 'Darkside', 'Outlaw', 'SweetTooth', 'Yellow J', 'Junk Dog', 'Spectre',
  'Manslghtr', '12-Pak', 'Warthog', 'Gold Tooth',
];

export interface HudBlip {
  /** posição relativa ao jogador no quadro do carro (pés): direita, frente */
  right: number;
  forward: number;
  /** índice em RADAR_COLORS */
  color: number;
}

export interface HudState {
  health: number; // 0..1
  turbo: number; // 0..1
  energy: number; // 0..1
  dead: boolean;
  respawnIn: number; // s
  /** munição por índice do inventário (INVENTORY_NAMES) e índice selecionado */
  ammo: number[];
  selected: number;
  target: string | null;
  blips: HudBlip[];
  hc: boolean;
}

const MSG_FRAMES = 0x78; // FUN_0013a0b8: 120 quadros por mensagem
const RADAR_RANGE = 900; // pés (FUN_00137620)

export class Hud {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera((2 * Math.atan(0.5) * 180) / Math.PI, 4 / 3, 0.05, 50);
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private holders = new Map<string, { holder: THREE.Group; rig: CarRig; def: HudRootDef }>();
  private messages: { text: string; frames: number }[] = [];
  private spin = 0;
  private tinted: THREE.MeshBasicMaterial[] = [];
  private frame = 0;

  private constructor(private readonly font: HudFont) {
    this.ctx = this.canvas.getContext('2d')!;
    Object.assign(this.canvas.style, { position: 'fixed', inset: '0', pointerEvents: 'none', width: '100%', height: '100%' });
  }

  static async build(globals: ModelDoc & { hud?: Record<string, HudRootDef> }, bin: ArrayBuffer): Promise<Hud> {
    const hud = new Hud(await HudFont.load(0));
    for (const [role, def] of Object.entries(globals.hud ?? {})) {
      const doc = { ...globals, rig: def.rig, selectors: def.selectors, damage: {} } as ModelDoc & { rig: RigDoc };
      const rig = await CarRig.build(doc, bin, def.instances);
      // CarRig monta no quadro do carro; o HUD fica no quadro da câmera do PS2 (x direita, y frente, z cima).
      (rig.group.children[0] as THREE.Group).matrix.copy(PS2_TO_THREE);
      // O HUD é desenhado por cima de tudo (pacotes do GS com ZMSK); sem teste de profundidade contra o mundo.
      rig.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh || (o as THREE.Sprite).isSprite) (o as THREE.Mesh).renderOrder = 10;
      });
      // Medidor de vida (osso 0x18 com escala no canal 4): o clipe 0 também anima os canais 5, 6, 7, que o host usa
      // como B, G, R da barra (verde cheio → amarelo → vermelho). ⚠️ ESCOLHA DO HOST: onde o jogo aplica esses canais.
      def.rig.bones.forEach((b, i) => {
        if (!b.schan?.includes(4)) return;
        rig.boneGroup(i)?.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.material = (mesh.material as THREE.MeshBasicMaterial).clone();
          hud.tinted.push(mesh.material as THREE.MeshBasicMaterial);
        });
      });
      const holder = new THREE.Group();
      holder.add(rig.group);
      hud.scene.add(holder);
      hud.holders.set(role, { holder, rig, def });
    }
    return hud;
  }

  /** Enfileira uma mensagem da tabela 0x2ba4c0 (FUN_0013a0b8 mostra uma a cada 120 quadros). */
  message(text: string): void {
    if (this.messages.length >= 4) this.messages.shift();
    this.messages.push({ text, frames: MSG_FRAMES });
  }

  get currentMessage(): string | null {
    return this.messages[0]?.text ?? null;
  }

  resize(w: number, h: number, dpr: number): void {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Avança um tique de 1/60 s (fila de mensagens, giro do modelo da arma). */
  tick(): void {
    this.frame++;
    const m = this.messages[0];
    if (m && --m.frames <= 0) this.messages.shift();
  }

  private place(): void {
    const aspect = this.camera.aspect;
    for (const { holder, def } of this.holders.values()) {
      const [x, depth, z] = def.pos;
      // FUN_0019e580 numa tela 4:3: x·prof/1,5 = x·prof·0,5·(4/3). Aqui a largura acompanha o aspecto da janela.
      holder.position.set(x * depth * 0.5 * aspect, z * depth * 0.5, -depth);
    }
  }

  private setSelectors(role: string, values: Record<number, number>): void {
    const r = this.holders.get(role)?.rig;
    if (r) for (const [cat, child] of Object.entries(values)) r.setSelector(Number(cat), child);
  }

  /** Atualiza os widgets e desenha: 3D por cima do mundo (renderer) e texto no canvas 2D. */
  render(renderer: THREE.WebGLRenderer, s: HudState, dt: number): void {
    this.place();
    const radar = this.holders.get('radar');
    const panel = this.holders.get('panel');
    const charge = this.holders.get('charge');
    // Radar: some com o carro morto (carro+0x6394, FUN_00137148); setas de inimigo distante desligadas (filho 1).
    if (radar) {
      radar.holder.visible = !s.dead;
      this.setSelectors('radar', { 0x1fcb: 1, 0x1fcc: 1, 0x1fcd: 1, 0x1fce: 1 });
    }
    // Carga do especial (FUN_0013c070): só com a arma especial selecionada e carregando — sem especial, apagada.
    if (charge) charge.holder.visible = false;
    if (panel) {
      const r = panel.rig;
      // Vida (FUN_00139938): abaixo de 15 % some em metade dos quadros ((rand & 0x3f) ≥ 0x20).
      let f = Math.max(0, Math.min(1, s.health));
      if (f < 0.15 && Math.random() < 0.5) f = 0;
      r.time.set(0, f);
      r.time.set(0x10, 0);
      r.time.set(2, s.turbo);
      r.time.set(1, s.energy);
      this.spin = (this.spin + dt * 60) % 150;
      r.time.set(0x309, this.spin / 150);
      r.time.set(0x30a, this.spin / 150);
      // Armas (FUN_0013aa88): atual / próxima (FUN_0014a3a8) / anterior (FUN_0014a430), índice + 1; 0 = nada.
      const has = (i: number) => (s.ammo[i] ?? 0) > 0;
      const n = s.ammo.length;
      const cur = !s.dead && has(s.selected) ? s.selected : -1;
      let next = -1;
      let prev = -1;
      if (cur >= 0) {
        for (let k = 1; k < n && next < 0; k++) if (has((cur + k) % n)) next = (cur + k) % n;
        for (let k = 1; k < n && prev < 0; k++) if (has((cur - k + n) % n)) prev = (cur - k + n) % n;
      }
      const sel = (i: number, ...not: number[]) => (i >= 0 && !not.includes(i) ? i + 1 : 0);
      this.setSelectors('panel', {
        0x208a: s.hc ? 1 : 0,
        [s.hc ? 0x2085 : 0x2080]: sel(cur),
        [s.hc ? 0x2087 : 0x2082]: sel(next, cur),
        [s.hc ? 0x2086 : 0x2081]: sel(prev, cur, next),
        0x1f48: s.dead ? 1 : 0, // FUN_0013aec0
        0x1f52: 1, // FUN_0013a378: calor da metralhadora < 10
        0x1fd8: 0, // FUN_00139938 sem o bit 0x40 de carro+0x63f0
        0x2076: 0,
      });
    }
    for (const { rig } of this.holders.values()) rig.update();
    const ch = panel?.rig.channels;
    if (ch) for (const m of this.tinted) m.color.setRGB(Math.min(1, ch[7]), Math.min(1, ch[6]), Math.min(1, ch[5]));
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
    this.drawText(s);
  }

  /** Centro do radar na tela do PS2 (FUN_00137148: origem do objeto + 0,015 abaixo, projetada). */
  private radarCenter(): [number, number] | null {
    const radar = this.holders.get('radar');
    if (!radar) return null;
    const p = new THREE.Vector3(0, -0.015, 0);
    radar.holder.updateMatrixWorld(true);
    p.applyMatrix4(radar.holder.matrixWorld).project(this.camera);
    return [((p.x + 1) / 2) * SCREEN_W, ((1 - p.y) / 2) * SCREEN_H];
  }

  private drawText(s: HudState): void {
    const cv = this.canvas;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.setTransform(cv.width / SCREEN_W, 0, 0, cv.height / SCREEN_H, 0, 0);
    // Glifos e pontos mantêm a proporção da tela 4:3 do PS2; as posições acompanham a largura da janela.
    const squash = (cv.height * 4) / 3 / cv.width;
    this.font.squash = squash;
    g.imageSmoothingEnabled = true;
    // Radar: pontos de 2,75 px (±0x16/16) por inimigo vivo a menos de 900 pés.
    const c = !s.dead ? this.radarCenter() : null;
    if (c) {
      for (const b of s.blips) {
        if (Math.hypot(b.right, b.forward) >= RADAR_RANGE) continue;
        const x = c[0] + ((b.right * 0.054 * 12.5) / 16) * squash;
        const y = c[1] - (b.forward * 0.028 * 12.5) / 16;
        const [r, gg, bb] = RADAR_COLORS[b.color] ?? [255, 255, 255];
        g.fillStyle = `rgb(${r},${gg},${bb})`;
        g.fillRect(x - 1.375 * squash, y - 1.375, 2.75 * squash, 2.75);
      }
    }
    // Nome do alvo (FUN_00139938 → FUN_00139780).
    if (!s.dead && s.target) this.font.draw(g, s.target, 142, 9, 14, [0x46, 100, 0x46, 0xff], 'center', false);
    // Arma atual (FUN_0013aa88): nome e munição.
    if (!s.dead && (s.ammo[s.selected] ?? 0) > 0) {
      const names = s.hc ? INVENTORY_NAMES_HC : INVENTORY_NAMES;
      const col: Rgba = [0x46, 0x46, 0x46, 0xff];
      this.font.draw(g, names[s.selected] ?? '', 538, 152, 12, col, 'center');
      this.font.draw(g, String(s.ammo[s.selected]), 538, 186, 12, col, 'center');
    }
    // Mensagens (FUN_0013a0b8).
    const m = this.messages[0];
    if (m) this.font.draw(g, m.text, 320, 6, 14, [0xdd, 0xdb, 0x0a, 0xff], 'center');
    // "PLAYER DEAD, RESPAWN IN %d" (tabela 0x2c49a8). ⚠️ ESCOLHA DO HOST: posição e cor (quem desenha não achado).
    if (s.dead) this.font.draw(g, `PLAYER DEAD, RESPAWN IN ${Math.max(0, Math.ceil(s.respawnIn))}`, 320, 105, 14, [0xdd, 0xdb, 0x0a, 0xff], 'center');
  }
}
