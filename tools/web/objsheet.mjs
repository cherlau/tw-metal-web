// Folha de objetos do GLOBALS: cada objeto enquadrado pela própria caixa, vista 3/4.
// Uso: node tools/web/objsheet.mjs <saida.png> <idx...>
import { chromium } from 'playwright-core';
const [out, ...idx] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
const shots = [];
for (const i of idx) {
  await page.goto(`http://localhost:5199/?dir=globals&car=globals&obj=${i}&front=1`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  await page.evaluate(() => {
    const v = window.__viewer;
    document.getElementById('panel').style.display = 'none';
    for (const el of document.querySelectorAll('a, select, #status')) el.style.display = 'none';
    v.scene.children.filter((c) => c.type === 'GridHelper' || c.type === 'AxesHelper').forEach((c) => (c.visible = false));
    const box = new v.THREE.Box3();
    v.root.traverse((o) => { if (o.isMesh && o.visible) box.expandByObject(o); });
    const c = box.getCenter(new v.THREE.Vector3()); const r = box.getSize(new v.THREE.Vector3()).length() / 2 || 1;
    v.controls.target.copy(c); v.camera.position.set(c.x + r * 1.6, c.y + r * 0.9, c.z + r * 1.6); v.camera.lookAt(c); v.controls.update();
  });
  await page.waitForTimeout(400);
  shots.push({ i, png: (await page.screenshot()).toString('base64') });
}
const sheet = await page.evaluate(async (shots) => {
  const w = 320, cols = 4, rows = Math.ceil(shots.length / cols);
  const c = document.createElement('canvas'); c.width = w * cols; c.height = w * rows;
  const ctx = c.getContext('2d');
  for (const [k, s] of shots.entries()) {
    const img = new Image(); img.src = `data:image/png;base64,${s.png}`; await img.decode();
    ctx.drawImage(img, (k % cols) * w, Math.floor(k / cols) * w);
    ctx.fillStyle = '#ff0'; ctx.font = 'bold 28px sans-serif'; ctx.fillText(String(s.i), (k % cols) * w + 8, Math.floor(k / cols) * w + 32);
  }
  return c.toDataURL('image/png').split(',')[1];
}, shots);
(await import('node:fs')).writeFileSync(out, Buffer.from(sheet, 'base64'));
await browser.close();
