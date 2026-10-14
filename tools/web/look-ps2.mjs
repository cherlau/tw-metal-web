// Foto de um ponto do nível em coordenadas do PS2. Uso: node tools/web/look-ps2.mjs <arena> <saida> px py pz lx ly lz
import { chromium } from 'playwright-core';
const [lvl, out, px, py, pz, lx, ly, lz] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 700, height: 450 } });
await page.goto(`http://localhost:5199/play.html?lvl=${lvl}&car=axel&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000 });
// PS2 (x,y,z) -> Three (x, z, -y)
await page.evaluate(([p, l]) => (window.__camWorld = { pos: [p[0], p[2], -p[1]], look: [l[0], l[2], -l[1]] }), [[+px, +py, +pz], [+lx, +ly, +lz]]);
await page.waitForTimeout(600);
await page.screenshot({ path: out });
await browser.close();
