// QA do lançador: com o suporte aberto, mede a distância entre o modelo pendurado no marcador 0x00F0 e o ponto
// onde o projétil nasce (0x00F8), e fotografa antes do tiro, logo depois (modelo some) e na recarga.
// Uso: node tools/web/launcher-qa.mjs <carro> <pasta-saida> [armas] [lvl]
import { chromium } from 'playwright-core';
const [car = 'sweet', outDir = '.', list = 'fire,homing,napalm,power,ricochet,swarmer,remote', lvl = 'arena'] = process.argv.slice(2);
const TYPE = { fire: 2, homing: 3, napalm: 4, power: 6, ricochet: 7, swarmer: 9, remote: 10 };
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => m.type() === 'error' && logs.push(`[error] ${m.text()}`));
await page.goto(`http://localhost:5199/play.html?lvl=${lvl}&car=${car}&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const m = window.__game.match;
  window.__launch = [];
  const drain = m.drain.bind(m);
  m.drain = () => {
    const es = drain();
    for (const e of es) if (e.kind === 'launch' && e.car === 0) window.__launch.push(e.pos);
    return es;
  };
});
const markInfo = (type) =>
  page.evaluate((type) => {
    const g = window.__game;
    const mark = g.rigs[0]?.marks?.get(type);
    if (!mark) return null;
    const p = mark.getWorldPosition(new g.THREE.Vector3());
    return { pos: { x: p.x, y: p.y, z: p.z }, loaded: mark.children.length > 0 };
  }, type);
for (const w of list.split(',')) {
  await page.evaluate((w) => {
    const me = window.__game.match.cars[0];
    me.ammo[w] = 3;
    me.selected = w;
    me.nextFire = 0;
  }, w);
  await page.waitForTimeout(3200); // suporte anterior fecha e o desta arma abre
  const before = await markInfo(TYPE[w]);
  await page.screenshot({ path: `${outDir}/launcher-${car}-${w}-0.png` });
  await page.evaluate(() => (window.__launch.length = 0));
  await page.keyboard.down('KeyK');
  await page.waitForTimeout(w === 'swarmer' ? 300 : 40);
  await page.keyboard.up('KeyK');
  await page.waitForTimeout(60);
  await page.screenshot({ path: `${outDir}/launcher-${car}-${w}-1.png` });
  const at = await page.evaluate(() => window.__launch[0] ?? null);
  await page.waitForTimeout(700);
  const after = await markInfo(TYPE[w]);
  await page.screenshot({ path: `${outDir}/launcher-${car}-${w}-2.png` });
  const d = before && at ? Math.hypot(before.pos.x - at.x, before.pos.y - at.y, before.pos.z - at.z).toFixed(2) : '-';
  console.log(`${w}: marcador ${before ? (before.loaded ? 'carregado' : 'vazio') : 'ausente'}, saída a ${d} pés do marcador; depois: ${after ? (after.loaded ? 'recarregado' : 'vazio') : '-'}`);
  await page.waitForTimeout(600);
}
console.log(logs.join('\n') || '(sem erros)');
await browser.close();
