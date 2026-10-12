// QA de todos os carros do menu: carrega cada um numa arena, acelera 4 s e confere que assentou e andou.
// Uso: node tools/web/cars-qa.mjs [arena] [carro...]
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const [lvl = 'tokyodm', ...only] = process.argv.slice(2);
const src = readFileSync('src/catalog.ts', 'utf-8');
const cars = only.length ? only : [...src.matchAll(/cars: \[([^\]]+)\]/g)].flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]));
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
let bad = 0;
for (const car of cars) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:5199/play.html?lvl=${lvl}&car=${car}&bots=0`);
  try {
    await page.waitForFunction(() => window.__ready === true || /Falha/.test(document.body.innerText), null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    const a = await page.evaluate(() => ({ ...window.__game.state().pos }));
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(4000);
    await page.keyboard.up('KeyW');
    const r = await page.evaluate(() => {
      const s = window.__game.state();
      const c = window.__game.match.cars[0];
      return { pos: { ...s.pos }, grounded: s.grounded, shape: c.shape, deaths: c.deaths };
    });
    const dist = Math.hypot(r.pos.x - a.x, r.pos.z - a.z);
    const ok = r.grounded && dist > 40 && r.deaths === 0 && !errors.length;
    if (!ok) bad++;
    const sh = r.shape;
    console.log(`${ok ? 'OK  ' : 'RUIM'} ${car.padEnd(9)} andou ${dist.toFixed(0).padStart(4)} pés · no chão ${r.grounded} · caixa ${(sh.halfWidth * 2).toFixed(1)}×${(sh.halfLength * 2).toFixed(1)}×${(sh.top - sh.bottom).toFixed(1)}${errors.length ? ' · ERRO ' + errors[0] : ''}`);
  } catch (e) {
    bad++;
    console.log(`RUIM ${car} — ${e.message.split('\n')[0]} ${errors[0] ?? ''}`);
  }
  await page.close();
}
console.log(`${cars.length - bad}/${cars.length} ok`);
await browser.close();
