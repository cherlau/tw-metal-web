// Vista fixa de um nível no visualizador (para comparar antes/depois de uma mudança no conversor).
// Uso: node tools/web/level-view.mjs <lvl> <saida.png> <câmera x,y,z PS2> <alvo x,y,z PS2>
import { chromium } from 'playwright-core';
const [lvl, out, cam, look] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:5199/?lvl=${lvl}`);
await page.waitForFunction(() => window.__ready === true || /Falha/.test(document.body.innerText), null, { timeout: 300000 });
await page.evaluate(([cam, look]) => {
  document.getElementById('panel').style.display = 'none';
  const v = window.__viewer;
  const [cx, cy, cz] = cam.split(',').map(Number);
  const [lx, ly, lz] = look.split(',').map(Number);
  v.camera.position.set(cx, cz, -cy); // PS2 (x, y, z) -> Three (x, z, -y)
  v.controls.target.set(lx, lz, -ly);
  v.camera.near = 1; v.camera.far = 50000; v.camera.updateProjectionMatrix();
  v.controls.update();
}, [cam, look]);
await page.waitForTimeout(800);
await page.screenshot({ path: out });
if (errors.length) console.log('ERROS', errors.slice(0, 3));
await browser.close();
