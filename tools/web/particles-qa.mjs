// QA visual das partículas (src/particles.ts): explosões das armas num ponto fixo, fogo num carro e o ataque de
// ambiente da ARENA. Uso: node tools/web/particles-qa.mjs <pasta-saida>
import { chromium } from 'playwright-core';
const [outDir = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => m.type() === 'error' && logs.push(`[error] ${m.text()}`));
await page.goto('http://localhost:5199/play.html?lvl=arena&car=axel&bots=1');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(1500);
// Disparos: Power, Fire, Homing, Napalm, Ricochet contra o bot parado à frente
const shots = ['power', 'fire', 'homing', 'napalm', 'ricochet', 'swarmer'];
for (const w of shots) {
  await page.evaluate((w) => {
    const g = window.__game;
    const [me, bot] = g.match.cars;
    bot.bot = false;
    bot.state.pos = { x: me.state.pos.x + Math.sin(me.state.yaw) * 120, y: me.state.pos.y, z: me.state.pos.z + Math.cos(me.state.yaw) * 120 };
    bot.state.vel = { x: 0, y: 0, z: 0 };
    bot.health = 100;
    me.ammo[w] = 5;
    me.selected = w;
    me.nextFire = 0;
    window.__camOverride = { pos: [25, 18, -10], look: [0, 4, 80] };
  }, w);
  await page.keyboard.down('KeyK');
  await page.waitForTimeout(w === 'swarmer' ? 600 : 60);
  await page.keyboard.up('KeyK');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outDir}/p-${w}-fly.png` });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/p-${w}-boom.png` });
  console.log(w, JSON.stringify(await page.evaluate(() => ({ n: window.__game.particles?.count, hp: window.__game.match.cars[1].health }))));
  await page.waitForTimeout(1200);
}
// Fogo no carro (Thumper acende; aqui direto pelo Match)
await page.evaluate(() => {
  const g = window.__game;
  g.match['ignite'](g.match.cars[1], 0);
});
await page.waitForTimeout(700);
await page.screenshot({ path: `${outDir}/p-burn.png` });
console.log(logs.join('\n') || '(sem erros)');
await browser.close();
