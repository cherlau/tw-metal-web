// QA: rastreia posição/velocidade dos bots ao longo do tempo. Uso: node tools/web/bot-trace.mjs "<query>" <amostras> <intervalo_ms>
import { chromium } from 'playwright-core';
const [query, n = '8', every = '5000'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`http://localhost:5199/play.html?${query}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
for (let i = 0; i < Number(n); i++) {
  await page.waitForTimeout(Number(every));
  console.log(await page.evaluate(() => window.__game.match.cars.map((c) => `${c.name}(${Math.round(c.state.pos.x)},${Math.round(c.state.pos.z)}) v${Math.round(Math.hypot(c.state.vel.x, c.state.vel.z))} chão${c.state.wheelsOnGround}`).join('  ')));
}
await browser.close();
