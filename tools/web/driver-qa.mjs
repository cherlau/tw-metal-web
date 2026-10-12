// QA da animação do piloto (clipes 0x22..0x25, FUN_001258f0/FUN_00125688): parado, virando para cada lado, no ar.
// Uso: node tools/web/driver-qa.mjs <carro> <saida-prefixo> [vista x,y,z]
import { chromium } from 'playwright-core';
const [car = 'mrgrim', out = 'driver', view = '0,7,16'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 700, height: 450 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:5199/play.html?lvl=castledm&car=${car}&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.keyboard.press('KeyM');
await page.evaluate((v) => (window.__camOverride = { pos: v.split(',').map(Number), look: [0, 3, 0] }), view);
const drv = () => page.evaluate(() => JSON.stringify({ ...window.__game.rigs[0].drv, time: Object.fromEntries([...window.__game.rigs[0].time].filter(([k]) => k >= 0x22 && k <= 0x25)) }));
await page.waitForTimeout(1500);
console.log('parado', await drv());
await page.screenshot({ path: `${out}-parado.png` });
for (const [key, name] of [['KeyA', 'esquerda'], ['KeyD', 'direita']]) {
  await page.keyboard.down(key);
  await page.waitForTimeout(1500);
  console.log(name, await drv());
  await page.screenshot({ path: `${out}-${name}.png` });
  await page.keyboard.up(key);
  await page.waitForTimeout(600);
}
// no ar: sobe o carro 30 pés
await page.evaluate(() => {
  const s = window.__game.state();
  window.__game.setState({ ...s, pos: { ...s.pos, y: s.pos.y + 30 }, vel: { x: 0, y: 0, z: 0 }, grounded: false });
});
await page.waitForTimeout(500);
console.log('no ar', await drv());
await page.screenshot({ path: `${out}-ar.png` });
await page.waitForTimeout(2500);
console.log('depois', await drv());
if (errors.length) console.log('ERROS', errors);
await browser.close();
