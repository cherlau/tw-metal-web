// QA de áudio: liga o som com uma tecla, deixa os bots jogarem e conta sons tocados/decodificados.
// Uso: node tools/web/audio-qa.mjs "<query>" <segundos>
import { chromium } from 'playwright-core';
const [query, secs = '25'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));
const audioReq = { sfx: 0, music: 0, fail: 0 };
page.on('response', (r) => {
  const u = r.url();
  if (/\/sfx\/.+\.m4a/.test(u)) audioReq.sfx++;
  if (/\/music\/.+\.m4a/.test(u)) audioReq.music++;
  if (/\.m4a/.test(u) && r.status() >= 400) audioReq.fail++;
});
await page.goto(`http://localhost:5199/play.html?${query}`);
await page.waitForFunction(() => window.__ready === true || /Falha/.test(document.body.innerText), null, { timeout: 240000 });
await page.evaluate(() => {
  const a = window.__game.audio;
  window.__played = {};
  const orig = a.play.bind(a);
  a.play = (bank, name, opt) => {
    window.__played[name] = (window.__played[name] ?? 0) + 1;
    return orig(bank, name, opt);
  };
});
await page.keyboard.press('KeyX'); // gesto do usuário -> inicia o AudioContext
await page.keyboard.down('KeyW');
await page.waitForTimeout(Number(secs) * 1000);
await page.keyboard.up('KeyW');
const r = await page.evaluate(() => {
  const a = window.__game.audio;
  return {
    ctx: a.ctx?.state,
    motores: a.engines.size,
    musica: a.musicEl ? { src: a.musicEl.src.split('/').pop(), t: Math.round(a.musicEl.currentTime), paused: a.musicEl.paused, err: a.musicEl.error?.code } : null,
    tocados: window.__played,
  };
});
console.log(JSON.stringify({ ...r, requisicoes: audioReq }, null, 1));
if (errors.length) console.log('ERROS:', errors.slice(0, 5));
await browser.close();
