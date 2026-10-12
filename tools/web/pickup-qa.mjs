// QA visual dos ícones de pickup: congela a partida e põe um ícone de cada tipo na frente da câmera.
// Uso: node tools/web/pickup-qa.mjs <lvl> <saida.png>
import { chromium } from 'playwright-core';
const [lvl = 'castledm', out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 600 } });
await page.goto(`http://localhost:5199/play.html?lvl=${lvl}&car=wart&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(1500);
const ids = await page.evaluate(() => {
  const g = window.__game;
  const { THREE } = g;
  // um de cada tipo (id do PKP): pega o primeiro índice de cada efeito distinto
  const seen = new Map();
  g.match.pickups.forEach((p, i) => { if (!seen.has(p.id)) seen.set(p.id, i); });
  const s = g.state();
  const fwd = new THREE.Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const list = [...seen.entries()].slice(0, 10);
  list.forEach(([id, i], k) => {
    const o = g.pickupObjs[i];
    const p = new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z).addScaledVector(fwd, 45).addScaledVector(right, (k - (list.length - 1) / 2) * 9);
    g.match.pickups[i].pos = { x: p.x, y: p.y, z: p.z };
    o.position.set(p.x, p.y + 5, p.z);
  });
  return list.map(([id]) => id);
});
await page.waitForTimeout(1200);
await page.screenshot({ path: out });
console.log('ids', ids);
await browser.close();
