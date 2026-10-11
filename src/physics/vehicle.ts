// Física de veículo ARCADE — módulo puro (sem DOM/Three), testado em tests/vehicle.test.ts.
//
// ⚠️ Constantes de VEHICLE_RULES: ESCOLHA DO HOST, exceto as marcadas NATIVO (com endereço).
// Espaço: coordenadas do Three (Y para cima, frente do carro = +Z com yaw 0).
// Unidades: PÉS e mph — NATIVO: o jogo converte mph→pés/s com 1.4666667 (=88/60) em FUN_0016b828.
import { add, cross, dot, len, norm, scale, sub, v3, type V3 } from './vec';

export const VEHICLE_RULES = {
  // NATIVO (SCUS_976.21): FUN_00176548 aplica força = massa × escala × -32.2 (pés/s²); escala = 2.0 em
  // gp-0x756c (0x2f3084) → 64,4 pés/s². Com corpo+0x2a0 ligado a escala é 4.0 (0x2f3088) — 🟡 quando.
  gravity: Math.fround(2.0) * Math.fround(32.2),
  accel: 70, // aceleração do motor (unidades/s²)
  maxSpeed: 150, // velocidade máxima à frente por equilíbrio de arrasto (≈ 100 mph)
  maxReverse: 45,
  brakeDecel: 140,
  rollingDrag: 0.35, // 1/s, desaceleração sem acelerador
  grip: 9, // 1/s, quanto da velocidade lateral é removida por segundo
  handbrakeGrip: 1.5,
  turnRate: 2.4, // rad/s na velocidade de referência
  turnSpeedRef: 35, // abaixo disso a direção perde força (carro parado não gira)
  airControl: 0.25,
  springK: 220, // 1/s² — suspensão (por unidade de massa)
  springC: 26, // 1/s — amortecimento
  probeUp: 3, // raio da roda começa acima do fundo do carro
  suspensionReach: 6, // alcance abaixo do fundo do carro
  restitution: 0.15, // quique em parede
  wallNormalMaxY: 0.65, // normais mais "deitadas" que isso são chão (tratadas pela suspensão)
} as const;

export interface Hit {
  distance: number;
  normal: V3;
}

export interface CollisionWorld {
  /** Primeiro triângulo ao longo de dir (normalizado) até maxDist. */
  raycast(origin: V3, dir: V3, maxDist: number): Hit | null;
  /** Ponto mais próximo da geometria dentro de maxDist. */
  closestPoint(p: V3, maxDist: number): { point: V3; distance: number } | null;
}

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1 (freio; com o carro parado vira ré)
  steer: number; // -1 (esquerda) .. 1 (direita)
  handbrake: boolean;
}

export const NO_CONTROLS: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false };

/** Dimensões derivadas da caixa do modelo (espaço do carro: origem do modelo, frente +Z). */
export interface VehicleShape {
  halfWidth: number;
  halfLength: number;
  bottom: number; // y do fundo do carro em relação à origem do modelo (negativo)
  top: number;
  /** Pontos das 4 rodas no espaço do carro (Three), da tabela nativa 0x2ba990 (rules/vehicles.json). */
  wheels?: V3[];
}

export interface VehicleState {
  pos: V3;
  vel: V3;
  yaw: number;
  up: V3; // normal do chão suavizada (para a orientação visual)
  grounded: boolean;
  wheelsOnGround: number;
}

export function createVehicle(pos: V3, yaw = 0): VehicleState {
  return { pos: { ...pos }, vel: v3(), yaw, up: v3(0, 1, 0), grounded: false, wheelsOnGround: 0 };
}

export const forwardOf = (yaw: number): V3 => v3(Math.sin(yaw), 0, Math.cos(yaw));
/** Lado direito do carro = forward × up (com frente +Z, a direita é -X). */
export const rightOf = (yaw: number): V3 => v3(-Math.cos(yaw), 0, Math.sin(yaw));

/** Pontos de contato (rodas) no espaço do carro. */
export function wheelOffsets(shape: VehicleShape): V3[] {
  if (shape.wheels?.length === 4) return shape.wheels.map((w) => v3(w.x, 0, w.z));
  const x = shape.halfWidth * 0.8;
  const z = shape.halfLength * 0.7;
  return [v3(-x, 0, z), v3(x, 0, z), v3(-x, 0, -z), v3(x, 0, -z)];
}

const R = VEHICLE_RULES;

export function stepVehicle(s: VehicleState, shape: VehicleShape, c: Controls, world: CollisionWorld, dt: number): void {
  const fwd = forwardOf(s.yaw);
  const right = rightOf(s.yaw);

  // 1) Suspensão: um raio para baixo por roda.
  const down = v3(0, -1, 0);
  let hits = 0;
  let groundY = 0;
  let nSum = v3();
  for (const o of wheelOffsets(shape)) {
    const anchor = add(s.pos, add(add(scale(right, o.x), scale(fwd, o.z)), v3(0, shape.bottom + R.probeUp, 0)));
    const h = world.raycast(anchor, down, R.probeUp + R.suspensionReach);
    if (h && h.normal.y > R.wallNormalMaxY) {
      hits++;
      groundY += anchor.y - h.distance;
      nSum = add(nSum, h.normal);
    }
  }
  s.wheelsOnGround = hits;
  s.grounded = hits >= 2;

  if (s.grounded) {
    groundY /= hits;
    const n = norm(nSum);
    // Mola vertical até o fundo do carro encostar no chão médio.
    const targetY = groundY - shape.bottom;
    s.vel.y += (R.springK * (targetY - s.pos.y) - R.springC * s.vel.y - R.gravity) * dt;

    let vf = dot(s.vel, fwd);
    let vs = dot(s.vel, right);
    // Motor, freio e ré.
    if (c.throttle > 0) vf += R.accel * c.throttle * dt;
    if (c.brake > 0) {
      if (vf > 1) vf = Math.max(0, vf - R.brakeDecel * c.brake * dt);
      else vf = Math.max(-R.maxReverse, vf - R.accel * 0.6 * c.brake * dt);
    }
    // Velocidade máxima por equilíbrio de arrasto (não por clamp — SPEC §9.8).
    vf -= (R.accel / R.maxSpeed) * vf * dt * (vf > 0 ? 1 : 0);
    if (!c.throttle && !c.brake) vf -= vf * R.rollingDrag * dt;
    if (vf < 0) vf = Math.max(vf, -R.maxReverse);
    // Aderência lateral.
    vs *= Math.exp(-(c.handbrake ? R.handbrakeGrip : R.grip) * dt);
    if (c.handbrake) vf *= Math.exp(-0.8 * dt);
    // Direção proporcional à velocidade; invertida em ré.
    const speedFactor = Math.min(1, Math.abs(vf) / R.turnSpeedRef) * Math.sign(vf);
    s.yaw -= c.steer * R.turnRate * speedFactor * dt;

    const nf = forwardOf(s.yaw);
    const nr = rightOf(s.yaw);
    s.vel = v3(nf.x * vf + nr.x * vs, s.vel.y, nf.z * vf + nr.z * vs);
    s.up = norm(add(scale(s.up, 0.85), scale(n, 0.15)));
  } else {
    s.vel.y -= R.gravity * dt;
    s.yaw -= c.steer * R.turnRate * R.airControl * dt;
    s.up = norm(add(scale(s.up, 0.97), v3(0, 0.03, 0)));
  }

  // 2) Integração.
  s.pos = add(s.pos, scale(s.vel, dt));

  // 3) Paredes: esferas ao longo do comprimento, empurradas para fora da geometria.
  const radius = Math.max(1, shape.halfWidth * 0.9);
  const midY = (shape.bottom + shape.top) * 0.5 + radius * 0.25;
  for (const k of [-0.55, 0, 0.55]) {
    const center = add(s.pos, add(scale(forwardOf(s.yaw), shape.halfLength * k), v3(0, midY, 0)));
    const cp = world.closestPoint(center, radius);
    if (!cp || cp.distance >= radius) continue;
    const n = norm(sub(center, cp.point));
    if (n.y > R.wallNormalMaxY) continue; // é chão: a suspensão cuida
    const push = radius - cp.distance;
    s.pos = add(s.pos, scale(n, push));
    const vn = dot(s.vel, n);
    if (vn < 0) s.vel = sub(s.vel, scale(n, vn * (1 + R.restitution)));
  }

  // 4) Anti-túnel: se o fundo afundou no chão (queda rápida), sobe de volta.
  const probe = world.raycast(add(s.pos, v3(0, shape.top, 0)), v3(0, -1, 0), shape.top - shape.bottom + 1);
  if (probe && probe.normal.y > R.wallNormalMaxY) {
    const floorY = s.pos.y + shape.top - probe.distance;
    const bottomY = s.pos.y + shape.bottom;
    if (bottomY < floorY - 0.5) {
      s.pos = v3(s.pos.x, floorY - shape.bottom, s.pos.z);
      if (s.vel.y < 0) s.vel = v3(s.vel.x, 0, s.vel.z);
    }
  }
}

export const speedOf = (s: VehicleState): number => len(v3(s.vel.x, 0, s.vel.z));

/** Eixos do modelo no mundo (para Matrix4.makeBasis): +X do modelo = esquerda do carro, +Y = up, +Z = frente. */
export function basisOf(s: VehicleState): { x: V3; y: V3; z: V3 } {
  const up = s.up;
  const left = norm(cross(up, forwardOf(s.yaw)));
  const forward = norm(cross(left, up));
  return { x: left, y: up, z: forward };
}
