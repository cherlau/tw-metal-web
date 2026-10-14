// QA visual do ataque de ambiente: na ARENA, dá munição ao jogador, dispara e fotografa os bocais (câmera no mundo)
// e a chegada do raio. Uso: node tools/web/env-qa.mjs <pasta-saida> [lvl]
import { chromium } from 'playwright-core';
const [outDir = '.', lvl = 'arena'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => m.type() === 'error' && logs.push(`[error] ${m.text()}`));
await page.goto(`http://localhost:5199/play.html?lvl=${lvl}&car=axel&bots=3`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(1500);
// câmera olhando os bocais (PS2 512..536, 83..147, 34 → mundo x, 34, −y) de dentro da arena
await page.evaluate(() => {
  window.__camWorld = { pos: [380, 90, -60], look: [530, 40, -115] };
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/env-${lvl}-nozzles.png` });
await page.evaluate(() => {
  const g = window.__game;
  const me = g.match.cars[0];
  me.ammo.env = 1;
  me.selected = 'env';
  me.nextFire = 0;
});
await page.keyboard.down('KeyK');
await page.waitForTimeout(80);
await page.keyboard.up('KeyK');
for (const [i, ms] of [[1, 150], [2, 450], [3, 900]]) {
  await page.waitForTimeout(ms);
  await page.screenshot({ path: `${outDir}/env-${lvl}-fire${i}.png` });
}
const info = await page.evaluate(() => {
  const m = window.__game.match;
  return { active: m.envActive, ammo: m.cars[0].ammo.env, proj: m.projectiles.map((p) => `${p.type}→${p.target}@${p.pos.x.toFixed(0)},${p.pos.y.toFixed(0)},${p.pos.z.toFixed(0)}`), health: m.cars.map((c) => c.health) };
});
console.log(JSON.stringify(info));
await page.evaluate(() => { window.__camWorld = null; });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outDir}/env-${lvl}-after.png` });
console.log(JSON.stringify(await page.evaluate(() => window.__game.match.cars.map((c) => c.health))));
console.log(logs.join('\n') || '(sem erros)');
await browser.close();
