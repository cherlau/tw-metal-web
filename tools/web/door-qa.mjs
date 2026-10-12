// QA das portas dos lançadores: dá a arma, dispara (K) e fotografa antes/durante a abertura.
// Uso: node tools/web/door-qa.mjs <carro> <arma> <saida-prefixo>
import { chromium } from 'playwright-core';
const [car = 'sweet', weapon = 'homing', out, view = '-14,6,-14', look = '0,1,0'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto(`http://localhost:5199/play.html?lvl=castledm&car=${car}&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.evaluate(([w, v, l]) => {
  const p = window.__game.match.cars[0]; p.ammo[w] = 9; p.selected = w;
  window.__camOverride = { pos: v.split(',').map(Number), look: l.split(',').map(Number) };
}, [weapon, view, look]);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}-0.png` });
await page.keyboard.down('KeyK'); await page.waitForTimeout(80); await page.keyboard.up('KeyK');
await page.waitForTimeout(350);
await page.screenshot({ path: `${out}-1.png` });
await browser.close();
