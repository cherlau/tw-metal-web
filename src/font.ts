// Fonte do HUD como o jogo a desenha (RE: docs/NATIVE.md "HUD"). Coordenadas da tela do PS2 (640×224).
//   tamanho (FUN_00221e78 → FUN_00222ce8): glifo = s × s px, avanço = 1,125·s (s·16 + s·2 em 1/16 px)
//   glifo (FUN_00223318/FUN_00223040): célula 32×32 da página, largura w/32 da tabela 0x2c7ae8 (u = coluna·32 até
//     +w texels; quad s·w/32 × s), avanço × w/32; espaço = avanço × 0,625 (FUN_00222de0, caso 0x18)
//   cor (FUN_00221d78): RGBA do PS2, 0x80 = 1,0 (modula a textura e satura)
//   sombra (FUN_002224a0 / FUN_00222660 com último parâmetro 0): 4 cópias em (±1, ±1) px, preto com alfa 0x40
//   centrado (FUN_00222660): x − largura/2 (FUN_00222020)
import { assetURL } from './assets';

export const SCREEN_W = 640;
/** Linhas do buffer do PS2 (modo campo, 640×224): o radar 0,054/0,028 px por pé só é circular com 224 linhas e o
 * nome/munição da arma (y 152/186) ficam acima e abaixo do modelo do painel (FUN_0013aa88). ⚠️ inferido. */
export const SCREEN_H = 224;

interface FontDoc {
  cell: number;
  pages: string[];
  glyphs: Record<string, [number, number, number, number]>;
}

export type Rgba = [number, number, number, number];

export class HudFont {
  /** Fator horizontal dos glifos em relação às posições (tela mais larga que 4:3: as letras não esticam). */
  squash = 1;
  private tinted = new Map<string, HTMLCanvasElement>();

  private constructor(
    private readonly doc: FontDoc,
    private readonly page: HTMLImageElement,
  ) {}

  static async load(page = 0): Promise<HudFont> {
    const doc: FontDoc = await fetch(assetURL('ui/font.json')).then((r) => r.json());
    const img = new Image();
    img.src = assetURL(`ui/${doc.pages[page]}`);
    await img.decode();
    return new HudFont(doc, img);
  }

  /** Página da fonte modulada pela cor do PS2 (texel · c/128, saturado), em cache por cor. */
  private atlas(c: Rgba): HTMLCanvasElement {
    const key = c.join(',');
    let cv = this.tinted.get(key);
    if (cv) return cv;
    cv = document.createElement('canvas');
    cv.width = this.page.width;
    cv.height = this.page.height;
    const g = cv.getContext('2d')!;
    g.drawImage(this.page, 0, 0);
    const im = g.getImageData(0, 0, cv.width, cv.height);
    const d = im.data;
    const [r, gr, b, a] = c.map((v) => v / 128);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.min(255, d[i] * r);
      d[i + 1] = Math.min(255, d[i + 1] * gr);
      d[i + 2] = Math.min(255, d[i + 2] * b);
      d[i + 3] = Math.min(255, d[i + 3] * a);
    }
    g.putImageData(im, 0, 0);
    this.tinted.set(key, cv);
    return cv;
  }

  private glyph(ch: number): [number, number, number] | null {
    const code = ch >= 0x61 && ch <= 0x7a && !this.doc.glyphs[ch] ? ch - 0x20 : ch;
    const g = this.doc.glyphs[code];
    return g ? [g[0], g[1], g[2]] : null;
  }

  /** Largura do texto em px da tela do PS2 (FUN_00222020). */
  width(text: string, size: number): number {
    const adv = size * 1.125;
    let w = 0;
    let best = 0;
    for (const chr of text) {
      const ch = chr.charCodeAt(0);
      if (ch === 0x20) w += adv * 0.625;
      else if (ch === 0x0a) {
        best = Math.max(best, w);
        w = 0;
      } else w += (adv * (this.glyph(ch)?.[2] ?? 32)) / 32;
    }
    return Math.max(best, w) * this.squash;
  }

  /**
   * Desenha `text` em (x, y) da tela do PS2 (topo da célula). `ctx` já escalado para 640×448 lógicos.
   * align 'center' = FUN_00222660; 'left' = FUN_002224a0. shadow = sombra de 4 cópias (parâmetro 0 do jogo).
   */
  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: Rgba, align: 'left' | 'center' = 'left', shadow = true): void {
    if (shadow && color[3] !== 0) {
      for (const dy of [-1, 1]) for (const dx of [-1, 1]) this.run(ctx, text, x + dx, y + dy, size, [0, 0, 0, 0x40], align);
    }
    this.run(ctx, text, x, y, size, color, align);
  }

  private run(ctx: CanvasRenderingContext2D, text: string, x0: number, y: number, size: number, color: Rgba, align: 'left' | 'center'): void {
    const atlas = this.atlas(color);
    const cell = this.doc.cell;
    const adv = size * 1.125 * this.squash;
    let x = align === 'center' ? x0 - this.width(text, size) / 2 : x0;
    for (const chr of text) {
      const ch = chr.charCodeAt(0);
      if (ch === 0x20) {
        x += adv * 0.625;
        continue;
      }
      const g = this.glyph(ch);
      if (!g) continue;
      const [col, row, w] = g;
      const qw = (size * w * this.squash) / 32;
      ctx.drawImage(atlas, col * cell, row * cell, w, cell, x, y, qw, size);
      x += (adv * w) / 32;
    }
  }
}
