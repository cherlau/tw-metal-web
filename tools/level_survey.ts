// Levantamento de jogabilidade de todas as arenas (física + colisão reais em Node).
// Uso: npx tsx tools/level_survey.ts [nivel...]
import { readFileSync, readdirSync } from 'node:fs';
import * as THREE from 'three';
import { LevelCollision } from '../src/collision';
import { PS2_TO_THREE } from '../src/coords';
import type { ModelDoc } from '../src/assets';
import { createVehicle, NO_CONTROLS, stepVehicle, type VehicleShape } from '../src/physics/vehicle';
import { v3 } from '../src/physics/vec';

const DT = 1 / 60;
const SHAPE: VehicleShape = { halfWidth: 5, halfLength: 5, bottom: -4.1, top: 4.1 };
const names = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync('public/assets/lvl').filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

for (const name of names) {
  const doc = JSON.parse(readFileSync(`public/assets/lvl/${name}.json`, 'utf-8')) as ModelDoc;
  const buf = readFileSync(`public/assets/lvl/${name}.bin`);
  const collision = new LevelCollision(doc, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), PS2_TO_THREE);
  const src = doc.points?.pts?.length ? 'pts' : doc.points?.pkp?.length ? 'pkp' : 'nenhum';
  const pts = (doc.points?.pts?.length ? doc.points.pts : doc.points?.pkp ?? []).map((p) => {
    const v = new THREE.Vector3(...p.pos).applyMatrix4(PS2_TO_THREE);
    return v3(v.x, v.y, v.z);
  });
  const floor = collision.bounds.min.y - 50;
  const sample = pts.filter((_, i) => i % Math.max(1, Math.ceil(pts.length / 16)) === 0);
  let noFloor = 0, notGrounded = 0, fell = 0;
  for (const [k, p] of sample.entries()) {
    const hit = collision.raycast(v3(p.x, p.y + 40, p.z), v3(0, -1, 0), 400);
    if (!hit) { noFloor++; continue; }
    const s = createVehicle(v3(p.x, p.y + 40 - hit.distance - SHAPE.bottom + 2, p.z), k);
    for (let i = 0; i < 120; i++) stepVehicle(s, SHAPE, NO_CONTROLS, collision, DT);
    if (!s.grounded) notGrounded++;
    let minY = s.pos.y;
    for (let i = 0; i < 360; i++) {
      stepVehicle(s, SHAPE, { ...NO_CONTROLS, throttle: 1, steer: 0.3 }, collision, DT);
      minY = Math.min(minY, s.pos.y);
    }
    if (minY < floor) fell++;
  }
  const n = sample.length;
  const ok = n > 0 && noFloor + notGrounded + fell <= n * 0.15;
  console.log(`${ok ? 'OK  ' : 'RUIM'} ${name.padEnd(9)} ${src} ${String(pts.length).padStart(4)} nós · amostra ${n}: sem chão ${noFloor}, não assentou ${notGrounded}, caiu ${fell} · pkp ${doc.points?.pkp?.length ?? 0} · tri ${collision.triangleCount}`);
}
