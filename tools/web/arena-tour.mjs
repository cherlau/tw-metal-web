// Tour visual de uma arena no visualizador: N vistas a partir de nós PTS, olhando para o centro do mapa.
// Uso: node tools/web/arena-tour.mjs <lvl> <saida-prefixo> [n=3] [altura=12]
import { chromium } from 'playwright-core';
const [lvl, out, n = '3', h = '12'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:5199/?lvl=${lvl}${process.env.Q ?? ''}`);
await page.waitForFunction(() => window.__ready === true || /Falha/.test(document.body.innerText), null, { timeout: 300000 });
await page.evaluate(() => { document.getElementById('panel').style.display = 'none'; });
const pts = await page.evaluate(async (lvl) => (await (await fetch(`/assets/lvl/${lvl}.json`)).json()).points.pts.map((p) => p.pos), lvl);
const N = Number(n);
for (let i = 0; i < N; i++) {
  const p = pts[Math.floor((i * pts.length) / N)];
  await page.evaluate(({ p, h }) => {
    const v = window.__viewer;
    // PS2 (x, y, z) -> Three (x, z, -y)
    const pos = new v.THREE.Vector3(p[0], p[2] + h, -p[1]);
    const box = new v.THREE.Box3().setFromObject(v.root);
    const c = box.getCenter(new v.THREE.Vector3());
    v.camera.position.copy(pos);
    v.controls.target.set(c.x, pos.y - h * 0.6, c.z);
    v.camera.near = 0.5; v.camera.far = 50000; v.camera.updateProjectionMatrix();
    v.controls.update();
  }, { p, h: Number(h) });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}-${i}.png` });
}
if (errors.length) console.log('ERROS', errors.slice(0, 3));
await browser.close();
