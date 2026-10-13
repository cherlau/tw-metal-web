// QA dos destrutíveis das arenas: golpe num objeto com destroços, árvore tombando, batida e tiro de verdade.
// Uso: node tools/web/destruct-qa.mjs <arena> <saida-prefixo>
import { chromium } from 'playwright-core';
const [lvl = 'castledm', out = 'destruct'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 700, height: 450 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:5199/play.html?lvl=${lvl}&car=axel&bots=0`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000 });
await page.keyboard.press('KeyM');
const info = await page.evaluate(() => {
  const d = window.__game.destructibles;
  const nodes = [...d.nodes.values()];
  const withFx = nodes.filter((n) => n.def.fx.some(Boolean));
  const topple = nodes.filter((n) => n.def.category >= 0x1196 && n.def.category <= 0x119d);
  return { total: nodes.length, withFx: withFx.length, topple: topple.length };
});
console.log('destrutíveis', JSON.stringify(info));
// Põe o carro ao lado do objeto escolhido e fotografa antes/depois do golpe.
async function scene(pick, name, ctxKind) {
  const node = await page.evaluate(([pick]) => {
    const d = window.__game.destructibles;
    const nodes = [...d.nodes.values()].filter((n) => n.hp > 0 && n.radius > 1);
    const sel = pick === 'fx' ? nodes.filter((n) => n.def.fx.some(Boolean)) : nodes.filter((n) => n.def.category >= 0x1196 && n.def.category <= 0x119d);
    const n = sel.sort((a, b) => a.radius - b.radius)[Math.floor(sel.length / 2)];
    if (!n) return null;
    const s = window.__game.state();
    const o = n.origin;
    const dist = n.radius + 25;
    window.__game.setState({ ...s, pos: { x: o.x - dist, y: o.y + 5, z: o.z }, vel: { x: 0, y: 0, z: 0 }, yaw: Math.PI / 2 });
    return { key: n.key, origin: o.toArray(), radius: n.radius, cat: n.def.category };
  }, [pick]);
  if (!node) return console.log(name, 'nenhum');
  await page.waitForTimeout(800);
  await page.evaluate(([o, r]) => (window.__camOverride = undefined, window.__camWorld = { pos: [o[0] - 1.6 * r - 25, o[1] + 1.6 * r + 25, o[2] + 0.8 * r + 10], look: o }), [node.origin, node.radius]);
  await page.screenshot({ path: `${out}-${name}-antes.png` });
  await page.evaluate(([k, kind]) => {
    const d = window.__game.destructibles;
    const n = d.nodes.get(k);
    const T = window.__game.THREE;
    const pos = n.origin.clone().add(new T.Vector3(-n.radius * 0.5, 0, 0));
    d.hit(k, 100, { kind, weapon: 'power', pos, vel: new T.Vector3(250, 0, 0) }, performance.now() / 1000);
  }, [node.key, ctxKind]);
  for (const t of [150, 1200]) {
    await page.waitForTimeout(t === 150 ? 150 : t - 150);
    const st = await page.evaluate((k) => ({ ...window.__game.destructibles.states()[k], debris: window.__game.debris() }), node.key);
    console.log(name, `+${t}ms`, JSON.stringify({ ...node, ...st }));
    await page.screenshot({ path: `${out}-${name}-${t}.png` });
  }
}
await scene('fx', 'destrocos', 'weapon');
await scene('topple', 'arvore', 'weapon');
// Tiro de verdade: metralhadora contra o objeto com destroços mais próximo.
const shot = await page.evaluate(() => {
  const d = window.__game.destructibles;
  const before = d.destroyed.length;
  return before;
});
const target = await page.evaluate(() => {
  const d = window.__game.destructibles;
  const n = [...d.nodes.values()].filter((n) => n.hp > 0 && n.def.fx.some(Boolean) && n.radius > 1.5 && n.radius < 15)[3];
  const s = window.__game.state();
  window.__game.setState({ ...s, pos: { x: n.origin.x - 40, y: n.origin.y + 5, z: n.origin.z }, vel: { x: 0, y: 0, z: 0 }, yaw: Math.PI / 2 });
  window.__camWorld = undefined;
  window.__camOverride = { pos: [0, 8, -20], look: [0, 3, 20] };
  return n.key;
});
await page.waitForTimeout(800);
await page.keyboard.down('KeyJ');
await page.waitForTimeout(1500);
await page.keyboard.up('KeyJ');
console.log('tiro', JSON.stringify(await page.evaluate((k) => ({ alvo: window.__game.destructibles.states()[k], destruidos: window.__game.destructibles.destroyed.length }), target)), 'antes', shot);
await page.screenshot({ path: `${out}-tiro.png` });
if (errors.length) console.log('ERROS', errors);
await browser.close();
