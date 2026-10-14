// QA das explosões (partículas pela tabela de projéteis): cria a detonação de cada tipo num ponto fixo à frente
// do carro e fotografa 3 instantes. Uso: node tools/web/explosions-qa.mjs <pasta-saida> [tipos separados por vírgula]
import { chromium } from 'playwright-core';
const [outDir = '.', list = '2,3,4,6,7,9,10,22,0,14,19'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => m.type() === 'error' && logs.push(`[error] ${m.text()}`));
await page.goto('http://localhost:5199/play.html?lvl=arena&car=axel&bots=0');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  window.__camOverride = { pos: [0, 12, -30], look: [0, 6, 60] };
});
for (const t of list.split(',').map(Number)) {
  await page.evaluate((t) => {
    const g = window.__game;
    const me = g.match.cars[0];
    const f = { x: Math.sin(me.state.yaw), z: Math.cos(me.state.yaw) };
    const pos = { x: me.state.pos.x + f.x * 60, y: me.state.pos.y, z: me.state.pos.z + f.z * 60 };
    g.match['events'].push({ kind: 'explosion', pos, weapon: 'power', type: t, vel: { x: f.x * 500, y: -50, z: f.z * 500 }, normal: { x: -f.x, y: 0.3, z: -f.z }, hitCar: false });
  }, t);
  for (const [i, ms] of [[1, 70], [2, 250], [3, 700]]) {
    await page.waitForTimeout(ms);
    await page.screenshot({ path: `${outDir}/x-${t}-${i}.png` });
  }
  console.log(t, await page.evaluate(() => window.__game.particles.count));
  await page.waitForTimeout(2500);
}
console.log(logs.join('\n') || '(sem erros)');
await browser.close();
