// QA dos clipes do disparo da especial: seleciona, dispara (K) e fotografa em 3 momentos; com BOT=1 põe um bot à frente.
// Uso: node tools/web/special-fire-qa.mjs <saida-prefixo> carro1,carro2,...
import { chromium } from 'playwright-core';
const [out = 'spfire', list = 'mrgrim'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
for (const car of list.split(',')) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  await page.goto(`http://localhost:5199/play.html?lvl=castledm&car=${car}&bots=${process.env.BOT ? 1 : 0}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
  await page.keyboard.press('KeyM');
  if (process.env.CAM) await page.evaluate((c) => (window.__camQA = JSON.parse(c)), process.env.CAM);
  await page.evaluate(() => {
    const g = window.__game;
    const c = g.match.cars[0];
    c.ammo = { special: 3 };
    c.selected = 'special';
    window.__camOverride = window.__camQA ?? { pos: [-16, 9, -12], look: [0, 3, 2] };
    const b = g.match.cars[1];
    if (b) {
      const f = { x: Math.sin(c.state.yaw), z: Math.cos(c.state.yaw) };
      b.state.pos = { x: c.state.pos.x + f.x * 40, y: c.state.pos.y, z: c.state.pos.z + f.z * 40 };
      b.bot = false; // parado
    }
  });
  await page.waitForTimeout(2500);
  await page.keyboard.down('KeyK');
  await page.waitForTimeout(60);
  await page.keyboard.up('KeyK');
  for (const t of [200, 500, 1200]) {
    await page.waitForTimeout(t === 200 ? 200 : t - (t === 500 ? 200 : 500));
    const st = await page.evaluate(() => JSON.stringify([...window.__game.rigs[0].time].filter(([k]) => k >= 0x1a).map(([k, v]) => [k.toString(16), +v.toFixed(2)])) + ' ação=' + (window.__game.match.cars[0].action?.kind ?? '-'));
    console.log(car, t, st);
    await page.screenshot({ path: `${out}-${car}-${t}.png` });
  }
  await page.close();
}
await browser.close();
