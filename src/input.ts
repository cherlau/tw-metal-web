// Mapa de ações unificado (SPEC §9.10): teclado, gamepad e (futuramente) toque → ações.
import type { CarActions } from './game/match';
import { DIR } from './game/energy';

export type Action = 'throttle' | 'brake' | 'left' | 'right' | 'handbrake' | 'reset' | 'camera' | 'fireGun' | 'fireSpecial' | 'nextWeapon' | 'turbo';

const KEYMAP: Record<string, Action> = {
  KeyW: 'throttle',
  ArrowUp: 'throttle',
  KeyS: 'brake',
  ArrowDown: 'brake',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'handbrake',
  KeyR: 'reset',
  KeyC: 'camera',
  KeyJ: 'fireGun',
  KeyK: 'fireSpecial',
  KeyL: 'nextWeapon',
  ShiftLeft: 'turbo',
  ShiftRight: 'turbo',
};

/** Ações que estão em botões da lista do descongelar (FUN_00123410) e botões do gamepad padrão equivalentes. */
const UNFREEZE_ACTIONS: Action[] = ['throttle', 'brake', 'left', 'right', 'handbrake', 'fireGun', 'fireSpecial', 'nextWeapon', 'turbo'];
const UNFREEZE_PAD = [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15];

const ARROW_DIR: Record<string, number> = { ArrowUp: DIR.up, ArrowDown: DIR.down, ArrowLeft: DIR.left, ArrowRight: DIR.right };

export class Input {
  private held = new Set<Action>();
  private pressed = new Set<Action>(); // edge-trigger, consumido 1x por frame
  private padWasDown = new Set<Action>();
  /** Setas = direcional do PS2 (combos de energia, FUN_0012c9b8); também dirigem, como no jogo. */
  private arrows = 0;
  /** toques do direcional desde a última leitura (um toque mais curto que o quadro não se perde) */
  private arrowsTapped = 0;

  constructor(signal: AbortSignal) {
    addEventListener(
      'keydown',
      (e) => {
        const dir = ARROW_DIR[e.code];
        if (dir) {
          this.arrows |= dir;
          this.arrowsTapped |= dir;
        }
        const a = KEYMAP[e.code];
        if (!a) return;
        e.preventDefault();
        if (!this.held.has(a)) this.pressed.add(a);
        this.held.add(a);
      },
      { signal },
    );
    addEventListener(
      'keyup',
      (e) => {
        this.arrows &= ~(ARROW_DIR[e.code] ?? 0);
        if (KEYMAP[e.code]) this.held.delete(KEYMAP[e.code]);
      },
      { signal },
    );
    addEventListener(
      'blur',
      () => {
        this.held.clear();
        this.arrows = 0;
      },
      { signal },
    );
  }

  /** Consome uma ação de toque único (reset, trocar câmera, especial…). */
  consume(a: Action): boolean {
    const had = this.pressed.has(a);
    this.pressed.delete(a);
    return had;
  }

  /** Lê teclado + primeiro gamepad. Ações de borda (especial, trocar arma) são consumidas aqui. */
  actions(): CarActions {
    let throttle = this.held.has('throttle') ? 1 : 0;
    let brake = this.held.has('brake') ? 1 : 0;
    let steer = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
    let handbrake = this.held.has('handbrake');
    let fireGun = this.held.has('fireGun');
    let turbo = this.held.has('turbo');
    let fireSpecialHeld = this.held.has('fireSpecial');
    let dirs = this.arrows | this.arrowsTapped;
    this.arrowsTapped = 0;
    // FUN_00123410: L1, L2, R1, R2, X, O, Δ, □ e o direcional (não L3, R3, Start, Select)
    let buttonsHeld = this.arrows !== 0 || UNFREEZE_ACTIONS.some((x) => this.held.has(x));
    const pad = navigator.getGamepads?.().find((g) => g?.connected);
    if (pad) {
      // d-pad (botões 12..15 do mapeamento padrão): combos de energia; qualquer borda de botão descongela
      if (pad.buttons[12]?.pressed) dirs |= DIR.up;
      if (pad.buttons[13]?.pressed) dirs |= DIR.down;
      if (pad.buttons[14]?.pressed) dirs |= DIR.left;
      if (pad.buttons[15]?.pressed) dirs |= DIR.right;
      buttonsHeld ||= UNFREEZE_PAD.some((i) => pad.buttons[i]?.pressed);
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.15) steer = Math.max(-1, Math.min(1, ax));
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0, pad.buttons[0]?.pressed ? 1 : 0); // RT / A
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0, pad.buttons[2]?.pressed ? 1 : 0); // LT / X
      fireGun ||= !!pad.buttons[5]?.pressed; // RB
      turbo ||= !!pad.buttons[4]?.pressed; // LB
      handbrake ||= !!pad.buttons[10]?.pressed; // L3
      this.padEdge('fireSpecial', !!pad.buttons[1]?.pressed); // B
      fireSpecialHeld ||= !!pad.buttons[1]?.pressed;
      this.padEdge('nextWeapon', !!pad.buttons[3]?.pressed); // Y
      this.padEdge('reset', !!pad.buttons[8]?.pressed); // Select/View
      this.padEdge('camera', !!pad.buttons[9]?.pressed); // Start
    }
    return {
      throttle, brake, steer, handbrake, fireGun, turbo, fireSpecialHeld, dirs, buttonsHeld,
      fireSpecial: this.consume('fireSpecial'),
      nextWeapon: this.consume('nextWeapon'),
    };
  }

  private padEdge(a: Action, down: boolean) {
    if (down && !this.padWasDown.has(a)) this.pressed.add(a);
    if (down) this.padWasDown.add(a);
    else this.padWasDown.delete(a);
  }
}
