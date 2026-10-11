// QA de direção (assistido por input scriptado): carrega play.html, aplica uma sequência de teclas e
// reporta a física + screenshots. Uso: node tools/web/drive.mjs "<query>" <prefixo-saida> ["W 3000;W+D 1500;S 1000"]
import { chromium } from 'playwright-core';

const [query, out, script = 'W 4000;W+D 2000;W 1500'] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.text().startsWith('[')) && logs.push(m.text()));
page.on('pageerror', (e) => logs.push(e.message));
await page.goto(`http://localhost:5199/play.html?${query}`);
await page.waitForFunction(() => window.__ready === true || /Falha/.test(document.body.innerText), null, { timeout: 240000 });
const snap = () =>
  page.evaluate(() => {
    const s = window.__game.state();
    const r = (v) => Math.round(v * 10) / 10;
    return { pos: [r(s.pos.x), r(s.pos.y), r(s.pos.z)], speed: r(Math.hypot(s.vel.x, s.vel.z)), yaw: r(s.yaw), grounded: s.grounded, wheels: s.wheelsOnGround, hud: document.getElementById('hud').textContent };
  });
await page.waitForTimeout(1500); // assentar
console.log('início ', JSON.stringify(await snap()));
await page.screenshot({ path: `${out}-0.png` });
let i = 0;
for (const step of script.split(';')) {
  const [keys, ms] = step.trim().split(/\s+/);
  const codes = keys.split('+').map((k) => ({ W: 'KeyW', A: 'KeyA', S: 'KeyS', D: 'KeyD', SPACE: 'Space' })[k.toUpperCase()] ?? k);
  for (const c of codes) await page.keyboard.down(c);
  await page.waitForTimeout(Number(ms));
  for (const c of codes) await page.keyboard.up(c);
  console.log(`${step.padEnd(10)}`, JSON.stringify(await snap()));
  await page.screenshot({ path: `${out}-${++i}.png` });
}
if (logs.length) console.log('ERROS:', logs.join('\n'));
await browser.close();
