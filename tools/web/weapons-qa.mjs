// QA visual das armas: dispara cada arma (ou o especial) contra um alvo parado e fotografa o voo.
// Uso: node tools/web/weapons-qa.mjs <lvl> <carro> <pasta-saida> [armas separadas por vírgula]
import { chromium } from 'playwright-core';
const [lvl = 'arena', car = 'axel', outDir = '.', list = 'fire,homing,power,napalm,swarmer,ricochet,remote,special'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => m.type() === 'error' && logs.push(`[error] ${m.text()}`));
await page.goto(`http://localhost:5199/play.html?lvl=${lvl}&car=${car}&bots=1`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(1500);
for (const w of list.split(',')) {
  await page.evaluate((w) => {
    const g = window.__game;
    const [me, bot] = g.match.cars;
    // alvo parado 160 pés à frente, um pouco à direita
    const s = me.state;
    const f = { x: Math.sin(s.yaw), z: Math.cos(s.yaw) };
    bot.state.pos = { x: s.pos.x + f.x * 160 + f.z * 25, y: s.pos.y, z: s.pos.z + f.z * 160 - f.x * 25 };
    bot.state.vel = { x: 0, y: 0, z: 0 };
    bot.bot = false; // fica parado
    me.ammo[w] = 5;
    me.selected = w;
    me.nextFire = 0;
  }, w);
  await page.keyboard.down('KeyK');
  await page.waitForTimeout(w === 'swarmer' ? 1300 : 80);
  await page.keyboard.up('KeyK');
  await page.waitForTimeout(w === 'napalm' || w === 'remote' ? 700 : 220);
  await page.screenshot({ path: `${outDir}/weapon-${car}-${w}.png` });
  const info = await page.evaluate(() => window.__game.match.projectiles.map((p) => `${p.type}@${p.pos.x.toFixed(0)},${p.pos.y.toFixed(0)},${p.pos.z.toFixed(0)}`).join(' '));
  console.log(w, '→', info || '(nenhum projétil vivo)');
  await page.waitForTimeout(1200);
}
console.log(logs.join('\n') || '(sem erros)');
await browser.close();
