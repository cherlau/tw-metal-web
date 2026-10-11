import * as THREE from 'three';

/**
 * Regra ÚNICA de conversão de coordenadas PS2 → Three.js (SPEC §6.6).
 *
 * O jogo usa Z para cima (ondas de choque planas em XY; caminhão do Sweet Tooth alongado em Y).
 * Three usa Y para cima. Rotação de -90° em X: (x, y, z) → (x, z, -y). É uma rotação pura
 * (sem espelho); a mão do sistema original ainda precisa ser confirmada com um decal de texto.
 */
export const PS2_TO_THREE = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
