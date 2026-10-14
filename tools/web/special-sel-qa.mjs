// QA dos clipes da especial: fotografa o carro com outra arma e com a especial selecionada (src/game/specialclips.ts).
// Uso: node tools/web/special-sel-qa.mjs <saida-prefixo> carro1,carro2,...
import { chromium } from 'playwright-core';
const [out = 'specsel', list = 'sweet,crim'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
for (const car of list.split(',')) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  await page.goto(`http://localhost:5199/play.html?lvl=castledm&car=${car}&bots=0`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
  await page.keyboard.press('KeyM');
  if (process.env.CAM) await page.evaluate((c) => (window.__camQA = JSON.parse(c)), process.env.CAM);
  const pick = (w) => page.evaluate((w) => {
    const c = window.__game.match.cars[0];
    c.ammo = { special: 3, fire: 3 };
    c.selected = w;
    window.__camOverride = window.__camQA ?? { pos: [-14, 8, -16], look: [0, 2, 0] };
  }, w);
  await pick('fire');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}-${car}-a.png` });
  await pick('special');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}-${car}-b.png` });
  console.log(car, await page.evaluate(() => JSON.stringify([...window.__game.rigs[0].time].filter(([k]) => k >= 0x1a))));
  await page.close();
}
await browser.close();
