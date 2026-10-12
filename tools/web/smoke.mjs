// Teste de fumaça do visualizador: câmera livre (WASD) e seletor de modelos. Uso: node tools/web/smoke.mjs <saida.png>
import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader','--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto('http://localhost:5199/?lvl=parisdm');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
const before = await p.evaluate(() => window.__viewer.camera.position.toArray().map((v) => v.toFixed(0)));
await p.mouse.click(640, 400);
await p.keyboard.down('KeyW'); await p.waitForTimeout(1500); await p.keyboard.up('KeyW');
const after = await p.evaluate(() => window.__viewer.camera.position.toArray().map((v) => v.toFixed(0)));
const opts = await p.evaluate(() => document.querySelectorAll('#picker option').length);
console.log('câmera antes', before, 'depois', after, '| opções no seletor', opts);
await p.screenshot({ path: process.argv[2] });
await b.close();
