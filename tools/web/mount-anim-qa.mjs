// QA dos suportes de arma (FUN_00148978): seleciona a arma, fotografa fechado → abrindo → aberto, depois troca
// de arma e fotografa o fechamento. Uso: node tools/web/mount-anim-qa.mjs <carro> <arma> <outra> <saida-prefixo> [vista] [alvo]
import { chromium } from 'playwright-core';
const [car = 'sweet', weapon = 'homing', other = 'napalm', out = 'mount', view = '-14,6,-14', look = '0,1,0'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto(`http://localhost:5199/play.html?lvl=castledm&car=${car}&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
const state = () => page.evaluate(() => JSON.stringify(window.__doorsDebug().mounts[0]));
await page.evaluate(([v, l]) => {
  window.__camOverride = { pos: v.split(',').map(Number), look: l.split(',').map(Number) };
  const p = window.__game.match.cars[0];
  for (const k of Object.keys(p.ammo)) p.ammo[k] = 0;
  p.selected = null;
}, [view, look]);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}-0-fechado.png` });
await page.evaluate(([w, o]) => {
  const p = window.__game.match.cars[0];
  p.ammo[w] = 9;
  p.ammo[o] = 9;
  p.selected = w;
}, [weapon, other]);
await page.waitForTimeout(150);
console.log('abrindo', await state());
await page.screenshot({ path: `${out}-1-abrindo.png` });
await page.waitForTimeout(1500);
console.log('aberto', await state());
await page.screenshot({ path: `${out}-2-aberto.png` });
await page.evaluate((o) => (window.__game.match.cars[0].selected = o), other);
await page.waitForTimeout(150);
console.log('trocando', await state());
await page.screenshot({ path: `${out}-3-fechando.png` });
await page.waitForTimeout(2000);
console.log('outra aberta', await state());
await page.screenshot({ path: `${out}-4-outra.png` });
await browser.close();
