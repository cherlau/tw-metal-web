// QA do menu: abre play.html sem parâmetros, troca carro/arena, confere a prévia e o link de início.
// Uso: node tools/web/menu-qa.mjs <saida.png> [largura]
import { chromium } from 'playwright-core';
const [out, width = '1280'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(width), height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
await page.goto('http://localhost:5199/play.html');
await page.waitForFunction(() => window.__menu?.ready(), null, { timeout: 60000 });
await page.click('[data-car="sweet"]');
await page.click('[data-lvl="parisdm"]');
await page.waitForTimeout(300);
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() => window.__menu.ready(), null, { timeout: 60000 });
await page.waitForTimeout(1500);
const r = await page.evaluate(() => ({ choice: window.__menu.choice, nome: document.querySelector('#carname canvas')?.getAttribute('aria-label') ?? '', carros: document.querySelectorAll('[data-car]').length, arenas: document.querySelectorAll('[data-lvl]').length, scrollX: document.documentElement.scrollWidth > innerWidth }));
console.log(JSON.stringify(r));
await page.screenshot({ path: out });
await Promise.all([page.waitForURL(/lvl=parisdm.*diff=/), page.keyboard.press('Enter')]);
console.log('foi para', page.url().split('/').pop());
if (errors.length) console.log('ERROS:', errors.slice(0, 5));
await browser.close();
