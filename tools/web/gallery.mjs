// Galeria de QA: uma screenshot por modelo, montadas numa grade (PNG).
// Uso: node tools/web/gallery.mjs <saida.png> <query1> <query2> ...   (ex.: "lvl=arena" "car=axel")
// Requer o dev server em http://localhost:5199. A câmera usa o enquadramento automático do visualizador.
import { chromium } from 'playwright-core';

const [out, ...queries] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const shots = [];
for (const q of queries) {
  await page.goto(`http://localhost:5199/?${q}`);
  try {
    await page.waitForFunction(() => window.__ready === true || /Falha/.test(document.body.innerText), null, { timeout: 180000 });
  } catch {
    console.log(`${q}: timeout`);
  }
  await page.evaluate(() => {
    for (const id of ['panel']) document.getElementById(id).style.display = 'none';
  });
  await page.waitForTimeout(500);
  shots.push({ q, png: (await page.screenshot()).toString('base64') });
  console.log(`${q}: ${await page.evaluate(() => document.getElementById('status').textContent)}`);
}
// Monta a grade no próprio navegador (sem dependências de imagem no Node).
const cols = Math.min(3, shots.length);
const sheet = await page.evaluate(
  async ({ shots, cols }) => {
    const w = 640, h = 400, rows = Math.ceil(shots.length / cols);
    const c = document.createElement('canvas');
    c.width = w * cols;
    c.height = h * rows;
    const ctx = c.getContext('2d');
    for (const [i, s] of shots.entries()) {
      const img = new Image();
      img.src = `data:image/png;base64,${s.png}`;
      await img.decode();
      ctx.drawImage(img, (i % cols) * w, Math.floor(i / cols) * h);
      ctx.fillStyle = '#ff0';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText(s.q, (i % cols) * w + 8, Math.floor(i / cols) * h + 44);
    }
    return c.toDataURL('image/png').split(',')[1];
  },
  { shots, cols },
);
const fs = await import('node:fs');
fs.writeFileSync(out, Buffer.from(sheet, 'base64'));
await browser.close();
