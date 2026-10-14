// QA visual da animação de material (src/texanim.ts): câmera parada num alvo, duas fotos com intervalo; a diferença
// de pixels mostra se o material anda. Uso: node tools/web/matanim-qa.mjs <pasta-saida>
import { chromium } from 'playwright-core';
const [outDir = '.'] = process.argv.slice(2);
// alvo em coordenadas do PS2 (centro da esfera da malha) → mundo do Three (x, z, −y)
const SHOTS = [
  { lvl: 'parisdm', name: 'agua', at: [-73, 2221, -9], from: [60, 120, 60] },
  { lvl: 'arena', name: 'faixa-b7c60', at: [552, 126, 43], from: [-80, 20, 40] },
  { lvl: 'greecedm', name: 'mar', at: [61, -400, -164], from: [0, 150, 150] },
];
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
for (const s of SHOTS) {
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:5199/play.html?lvl=${s.lvl}&car=axel&bots=0`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
  const look = [s.at[0], s.at[2], -s.at[1]];
  const pos = [look[0] + s.from[0], look[1] + s.from[1], look[2] + s.from[2]];
  await page.evaluate(([p, l]) => { window.__camWorld = { pos: p, look: l }; }, [pos, look]);
  await page.waitForTimeout(1000);
  const a = await page.screenshot({ path: `${outDir}/matanim-${s.lvl}-${s.name}-a.png` });
  await page.waitForTimeout(2000);
  const b = await page.screenshot({ path: `${outDir}/matanim-${s.lvl}-${s.name}-b.png` });
  console.log(`${s.lvl} ${s.name}: ${a.equals(b) ? 'IGUAIS' : 'diferentes'}${errors.length ? ' erros: ' + errors.join(' | ') : ''}`);
  await page.close();
}
await browser.close();
