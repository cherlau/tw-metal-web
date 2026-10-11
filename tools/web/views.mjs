// Contact sheet de 4 vistas (frente, lado, topo, 3/4) de um modelo no visualizador.
// Uso: node tools/web/views.mjs "<query>" <saida-prefixo> [distancia]
import { execFileSync } from 'node:child_process';
const [query, out, dist = '14'] = process.argv.slice(2);
const d = Number(dist);
const views = { x: [d, 0, 0], y: [0, d, 0], z: [0, 0, d], q: [d * 0.6, d * 0.5, d * 0.6] };
for (const [name, [x, y, z]] of Object.entries(views)) {
  const js = `(() => { const v = window.__viewer; v.controls.target.set(0,0,0); v.camera.position.set(${x},${y},${z}); v.camera.up.set(${name === 'y' ? '0,0,-1' : '0,1,0'}); v.camera.lookAt(0,0,0); v.controls.update(); document.getElementById('panel').style.display='none'; })()`;
  execFileSync('node', ['tools/web/shot.mjs', `http://localhost:5199/?${query}`, `${out}-${name}.png`, js], { stdio: 'inherit' });
}
