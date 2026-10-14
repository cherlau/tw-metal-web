// QA do fogo nos destrutíveis (FUN_00172bb0 / FUN_001730b8): napalm numa árvore, ela queima, escurece e cai.
// Uso: node tools/web/fire-qa.mjs <arena> <saida-prefixo>
import { chromium } from 'playwright-core';
const [lvl = 'castledm', out = 'fire'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 700, height: 450 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:5199/play.html?lvl=${lvl}&car=axel&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000 });
await page.keyboard.press('KeyM');
const node = await page.evaluate(() => {
  const d = window.__game.destructibles;
  const sel = [...d.nodes.values()].filter((n) => n.hp > 0 && ((n.def.category >= 0x1196 && n.def.category <= 0x119d) || n.def.category === 0x11a3));
  const n = sel.sort((a, b) => a.radius - b.radius)[Math.floor(sel.length / 2)];
  const s = window.__game.state();
  const o = n.origin;
  window.__game.setState({ ...s, pos: { x: o.x - n.radius - 60, y: o.y + 5, z: o.z }, vel: { x: 0, y: 0, z: 0 }, yaw: Math.PI / 2 });
  window.__camWorld = { pos: [o.x - 3 * n.radius - 60, o.y + 2.5 * n.radius + 60, o.z], look: [o.x, o.y, o.z] };
  const T = window.__game.THREE;
  d.hit(n.key, 10, { kind: 'weapon', weapon: 'napalm', pos: o.clone(), vel: new T.Vector3(100, 0, 0) }, performance.now() / 1000);
  return { key: n.key, cat: n.def.category.toString(16), radius: n.radius };
});
console.log('alvo', JSON.stringify(node));
let last = 0;
for (const t of [1500, 6000, 8000, 9000, 10000, 12000]) {
  await page.waitForTimeout(t - last);
  last = t;
  const st = await page.evaluate((k) => window.__game.destructibles.states()[k], node.key);
  console.log(`+${t}ms`, JSON.stringify(st));
  await page.screenshot({ path: `${out}-${t}.png` });
}
console.log('erros', errors.length ? errors : 'nenhum');
await browser.close();
