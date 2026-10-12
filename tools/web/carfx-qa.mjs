// QA dos efeitos do carro: seletores 0x05 (lanternas/freio, turbo, projétil no suporte), sombra e destroços.
// Uso: node tools/web/carfx-qa.mjs <carro> <saida-prefixo>
import { chromium } from 'playwright-core';
const [car = 'cop', out = 'carfx'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`http://localhost:5199/play.html?lvl=castledm&car=${car}&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
const cam = (pos, look = [0, 1, 0]) => page.evaluate(([p, l]) => (window.__camOverride = { pos: p, look: l }), [pos, look]);
const sel = () => page.evaluate(() => window.__game.selectors()[0]);
const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}-${name}.png` });
};
await page.keyboard.press('KeyM'); // sem som
// 1) parado, vista de trás: lanternas no filho 0
await cam([0, 7, -22]);
await shot('traseira');
console.log('parado', JSON.stringify(await sel()));
// 2) freio: lanternas no filho 2 (brilho vermelho)
await page.keyboard.down('KeyS');
await page.waitForTimeout(200);
console.log('freio', JSON.stringify(await sel()));
await shot('freio');
await page.keyboard.up('KeyS');
// 3) turbo: chama (0x44 = 1)
await page.keyboard.down('KeyW');
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(250);
console.log('turbo', JSON.stringify(await sel()));
await shot('turbo');
await page.keyboard.up('ShiftLeft');
await page.keyboard.up('KeyW');
await page.waitForTimeout(1500);
// 4) arma: suporte abre, seletor de projétil e modelo no marcador
for (const w of ['power', 'homing', 'fire']) {
  await page.evaluate((w) => {
    const c = window.__game.match.cars[0];
    c.ammo = { [w]: 3 };
    c.selected = w;
  }, w);
  await page.waitForTimeout(1200);
  console.log('arma', w, JSON.stringify(await sel()));
  await cam([14, 9, 4]);
  await shot(`arma-${w}`);
}
await page.evaluate(() => (window.__game.match.cars[0].ammo = {}));
await page.waitForTimeout(1200);
// 5) sombra (vista de cima, de lado)
await cam([18, 14, 0]);
await shot('sombra');
// 6) morte: carcaça + destroços
await cam([-26, 14, -26]);
await page.evaluate(() => {
  const p = window.__game.match.cars[0];
  p.health = 0;
  p.deadFor = 1e-6;
});
for (const t of [60, 250, 700, 2400]) {
  await page.waitForTimeout(t === 60 ? 60 : t - 60);
  console.log(`morte +${t}ms: destroços ${await page.evaluate(() => window.__game.debris())}`, await page.evaluate(() => JSON.stringify(window.__game.debrisSys.pieces.slice(0, 2).map((p) => [Math.round(p.body.age), +p.body.alpha.toFixed(2), p.body.pos.toArray().map((v) => +v.toFixed(1))]))));
  await shot(`morte-${t}`);
}
if (errors.length) console.log('ERROS', errors);
await browser.close();
