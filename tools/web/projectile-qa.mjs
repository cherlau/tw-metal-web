// QA visual dos modelos de projétil: cria um projétil de cada tipo pedido parado no ar ao lado do carro e
// fotografa de perto (câmera no mundo). Uso: node tools/web/projectile-qa.mjs <saida.png> [tipos,separados]
import { chromium } from 'playwright-core';
const [out = 'proj.png', list = '2,3,6,9,7,10,22,30,27,21,40'] = process.argv.slice(2);
const types = list.split(',').map(Number);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 500 } });
await page.goto('http://localhost:5199/play.html?lvl=arena&car=axel&bots=0');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(1000);
await page.evaluate((types) => {
  const g = window.__game;
  const s = g.state();
  const f = { x: Math.sin(s.yaw), z: Math.cos(s.yaw) };
  const r = { x: -f.z, z: f.x };
  const base = { x: s.pos.x + f.x * 40, y: s.pos.y + 6, z: s.pos.z + f.z * 40 };
  // projéteis congelados (simulação parada), apontando para a direita da tela
  g.match.step = () => {};
  g.match.projectiles.length = 0;
  types.forEach((t, k) => {
    const off = (k - (types.length - 1) / 2) * 6;
    const pos = { x: base.x + r.x * off, y: base.y, z: base.z + r.z * off };
    g.match.projectiles.push({ type: t, weapon: 'special', owner: 99, pos, prev: { ...pos }, yaw: Math.atan2(-r.x, -r.z) + 0.6, pitch: 0, speed: 0, vy: 0, age: 0, life: 1e9,
      target: null, homing: 0, damage: 0, bounces: 0, landed: true, detonate: false, wobbleIn: 1e9, wobbleAmp: 0, wobbleGoal: [0, 0], wobbleRate: [0, 0], turnRate: 0, alive: true, vel: { x: 0, y: 0, z: 0 } });
  });
  window.__camWorld = { pos: [base.x - f.x * 22, base.y + 4, base.z - f.z * 22], look: [base.x, base.y, base.z] };
}, types);
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
console.log('tipos', types.join(' '));
await browser.close();
