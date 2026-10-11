// QA de partida: deixa os bots jogarem N segundos e reporta placar/vida/projéteis/pickups.
// Uso: node tools/web/match-qa.mjs "<query>" <segundos> <saida.png>
import { chromium } from 'playwright-core';
const [query, secs = '40', out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));
await page.goto(`http://localhost:5199/play.html?${query}`);
await page.waitForFunction(() => window.__ready === true || /Falha/.test(document.body.innerText), null, { timeout: 240000 });
// Conta eventos interceptando drain().
await page.evaluate(() => {
  const m = window.__game.match;
  window.__counts = {};
  const orig = m.drain.bind(m);
  m.drain = () => {
    const ev = orig();
    for (const e of ev) window.__counts[e.kind] = (window.__counts[e.kind] ?? 0) + 1;
    return ev;
  };
});
const t0 = Date.now();
await page.waitForTimeout(Number(secs) * 1000);
const r = await page.evaluate(() => {
  const m = window.__game.match;
  return {
    carros: m.cars.map((c) => `${c.name}: vida ${Math.round(c.health)} k${c.kills}/d${c.deaths} armas ${JSON.stringify(c.ammo)}`),
    projeteisNoAr: m.projectiles.length,
    pickupsRenascendo: m.pickups.filter((p) => p.respawnIn > 0).length,
    eventos: window.__counts,
  };
});
console.log(`após ${Math.round((Date.now() - t0) / 1000)} s:`, JSON.stringify(r, null, 1));
if (out) await page.screenshot({ path: out });
if (errors.length) console.log('ERROS:', errors.slice(0, 5));
await browser.close();
