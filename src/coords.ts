import * as THREE from 'three';

/**
 * Regra ÚNICA de conversão de coordenadas PS2 → Three.js (SPEC §6.6).
 *
 * O jogo usa Z para cima (ondas de choque planas em XY; caminhão do Sweet Tooth alongado em Y).
 * Three usa Y para cima. Rotação de -90° em X: (x, y, z) → (x, z, -y). É uma rotação pura
 * (sem espelho) — confirmado pelo texto "A-12" legível na viatura.
 */
export const PS2_TO_THREE = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

/**
 * Veículos: a frente do modelo é +Y no PS2 (verificado: grade e faróis da viatura e do Axel).
 * Depois da conversão acima isso vira -Z; a física usa frente = +Z, então gira 180° em Y.
 */
export const VEHICLE_TO_THREE = new THREE.Matrix4().makeRotationY(Math.PI).multiply(PS2_TO_THREE);
