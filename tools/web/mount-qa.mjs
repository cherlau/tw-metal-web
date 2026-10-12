// QA das armas montadas: dá todas as armas ao jogador e fotografa o carro em cada câmera (tecla C).
// Uso: node tools/web/mount-qa.mjs <carro> <saida-prefixo>
import { chromium } from 'playwright-core';
const [car = 'wart', out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto(`http://localhost:5199/play.html?lvl=castledm&car=${car}&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.evaluate(() => {
  const p = window.__game.match.cars[0];
  for (const w of ['fire', 'homing', 'swarmer', 'napalm', 'ricochet', 'power', 'remote']) p.ammo[w] = 3;
});
await page.waitForTimeout(1500);
for (let k = 0; k < 3; k++) {
  await page.screenshot({ path: `${out}-${k}.png` });
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(1500);
}
await browser.close();
