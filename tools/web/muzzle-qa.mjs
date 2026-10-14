// QA dos pontos de disparo (0x00F8): dispara a metralhadora e cada arma, registra a saída no espaço do carro
// (PS2: x direita, y frente, z cima) e fotografa a rajada logo depois do tiro.
// Uso: node tools/web/muzzle-qa.mjs <carro> <pasta-saida> [lvl]
import { chromium } from 'playwright-core';
const [car = 'sweet', outDir = '.', lvl = 'arena'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => m.type() === 'error' && logs.push(`[error] ${m.text()}`));
await page.goto(`http://localhost:5199/play.html?lvl=${lvl}&car=${car}&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const m = window.__game.match;
  window.__origins = [];
  const drain = m.drain.bind(m);
  m.drain = () => {
    const es = drain();
    for (const e of es) {
      const at = e.kind === 'shot' ? e.from : e.kind === 'launch' ? e.pos : null;
      if (!at || e.car !== 0) continue;
      const s = m.cars[0].state;
      const d = { x: at.x - s.pos.x, y: at.y - s.pos.y, z: at.z - s.pos.z };
      const r = [d.x * -Math.cos(s.yaw) + d.z * Math.sin(s.yaw), d.x * Math.sin(s.yaw) + d.z * Math.cos(s.yaw), d.y].map((v) => +v.toFixed(1));
      window.__origins.push(`${e.weapon}: [${r.join(', ')}]`);
    }
    return es;
  };
});
// Metralhadora: segura ~0,4 s e fotografa com as balas ainda perto do carro.
await page.keyboard.down('KeyJ');
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/muzzle-${car}-mg.png` });
await page.keyboard.up('KeyJ');
await page.waitForTimeout(600);
for (const w of ['fire', 'homing', 'napalm', 'power', 'ricochet', 'swarmer', 'remote', 'special']) {
  await page.evaluate((w) => {
    const me = window.__game.match.cars[0];
    me.ammo[w] = 5;
    me.selected = w;
    me.nextFire = 0;
  }, w);
  await page.keyboard.down('KeyK');
  await page.waitForTimeout(w === 'swarmer' ? 600 : 60);
  await page.keyboard.up('KeyK');
  await page.waitForTimeout(90);
  if (w === 'fire' || w === 'napalm') await page.screenshot({ path: `${outDir}/muzzle-${car}-${w}.png` });
  await page.waitForTimeout(900);
}
const origins = await page.evaluate(() => window.__origins);
const mounts = await page.evaluate(() => window.__game.match.cars[0].shape.mounts);
console.log('mounts', JSON.stringify(mounts));
console.log([...new Set(origins)].join('\n'));
console.log(logs.join('\n') || '(sem erros)');
await browser.close();
