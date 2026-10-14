// QA visual dos especiais corpo a corpo (Twister, Mr. Slam, Hammerhead, Grasshopper), ataques de energia e luz dos
// projéteis. Uso: node tools/web/specials-qa.mjs <lvl> <carros separados por vírgula> <pasta-saida>
import { chromium } from 'playwright-core';
const [lvl = 'arena', list = 'twist,mrslam,hamr,grass,axel', outDir = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const logs = [];
for (const car of list.split(',')) {
  const page = await browser.newPage({ viewport: { width: 900, height: 540 } });
  page.on('pageerror', (e) => logs.push(`[pageerror ${car}] ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && logs.push(`[error ${car}] ${m.text()}`));
  await page.goto(`http://localhost:5199/play.html?lvl=${lvl}&car=${car}&bots=1`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
  await page.waitForTimeout(1500);
  const dist = { twist: 30, mrslam: 14, hamr: 60, grass: 80, axel: 120 }[car] ?? 60;
  await page.evaluate((dist) => {
    const g = window.__game;
    const [me, bot] = g.match.cars;
    const s = me.state;
    const f = { x: Math.sin(s.yaw), z: Math.cos(s.yaw) };
    bot.state.pos = { x: s.pos.x + f.x * dist, y: s.pos.y, z: s.pos.z + f.z * dist };
    bot.state.vel = { x: 0, y: 0, z: 0 };
    bot.bot = false;
    me.selected = 'special';
    me.ammo.special = 3;
    me.nextFire = 0;
  }, dist);
  const state = () =>
    page.evaluate(() => {
      const [me, bot] = window.__game.match.cars;
      return `vida alvo ${bot.health.toFixed(1)} preso ${bot.heldBy} congelado ${bot.frozen} pose ${JSON.stringify(me.pose ?? null)} ação ${me.action?.kind ?? '-'}:${me.action?.phase ?? ''} energia ${me.energy.toFixed(2)}`;
    });
  if (car === 'axel') {
    // energia: Cima, Baixo, Cima (congelar) e depois Cima, Baixo, Esquerda, Direita (onda)
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowUp']) {
      await page.keyboard.down(k);
      await page.waitForTimeout(60);
      await page.keyboard.up(k);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outDir}/energy-freeze.png` });
    console.log(car, 'congelar →', await state());
    await page.waitForTimeout(1200);
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      await page.keyboard.down(k);
      await page.waitForTimeout(60);
      await page.keyboard.up(k);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${outDir}/energy-blast.png` });
    console.log(car, 'onda →', await state());
    // luz: um Homing disparado à noite do palco ilumina o chão (FUN_0024c350)
    await page.evaluate(() => {
      const me = window.__game.match.cars[0];
      me.ammo.homing = 3;
      me.selected = 'homing';
      me.nextFire = 0;
    });
    await page.keyboard.down('KeyK');
    await page.waitForTimeout(80);
    await page.keyboard.up('KeyK');
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${outDir}/light-homing.png` });
  } else {
    await page.keyboard.down('KeyK');
    await page.waitForTimeout(80);
    await page.keyboard.up('KeyK');
    for (const ms of [450, 900, 1600]) {
      await page.waitForTimeout(ms === 450 ? 450 : ms - (ms === 900 ? 450 : 900));
      await page.screenshot({ path: `${outDir}/special-${car}-${ms}.png` });
      console.log(car, ms, 'ms →', await state());
    }
  }
  await page.close();
}
console.log(logs.join('\n') || '(sem erros)');
await browser.close();
