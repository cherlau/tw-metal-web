// QA dos estados de dano (nós 0x13): põe a vida do jogador em cada faixa e fotografa o carro.
// Uso: node tools/web/damage-qa.mjs <carro> <saida-prefixo> [vista x,y,z]
import { chromium } from 'playwright-core';
const [car = 'cop', out = 'damage', view = '-16,8,-16'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:5199/play.html?lvl=castledm&car=${car}&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.evaluate((v) => (window.__camOverride = { pos: v.split(',').map(Number), look: [0, 1, 0] }), view);
// 100 → intacto; 45 → 2ª entrada; 20 → 3ª; 0,5 (f < 0,01 vira 0,02) → 3ª; 0 = carcaça
for (const hp of [100, 45, 20, 0.5, 0]) {
  await page.evaluate((h) => {
    const p = window.__game.match.cars[0];
    p.health = h;
    if (h === 0) p.deadFor = 1e-6;
  }, hp);
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => window.__game.damage()[0]);
  const hist = {};
  for (const v of Object.values(st ?? {})) hist[v] = (hist[v] ?? 0) + 1;
  console.log(`vida ${String(hp).padStart(4)}: entradas ${JSON.stringify(hist)}`);
  await page.screenshot({ path: `${out}-${hp}.png` });
}
if (errors.length) console.log('ERROS', errors);
await browser.close();
