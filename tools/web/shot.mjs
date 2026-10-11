// Screenshot do app no Edge do sistema via playwright-core (QA/validação; SPEC §16).
// Uso: node tools/web/shot.mjs <url> <saida.png> [js-para-avaliar-antes]
import { chromium } from 'playwright-core';

const [url, out, script] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.__ready === true || /Falha/.test(document.body.innerText), null, { timeout: 60000 });
if (script) await page.evaluate(script);
await page.waitForTimeout(800);
await page.screenshot({ path: out });
console.log(logs.filter((l) => !l.includes('[vite]')).join('\n') || '(sem logs)');
await browser.close();
