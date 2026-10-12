// Colisão da arena: um BVH (three-mesh-bvh) sobre a geometria visível da pose base.
// ⚠️ ESCOLHA DO HOST: a grade de colisão original (raiz 0x0C do .ngp) ainda não foi decodificada;
// usamos os triângulos de render, sem os translúcidos/aditivos (fogo, brilhos, vidro de efeito).
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, MeshBVH } from 'three-mesh-bvh';
import { buildGeometry, type ModelDoc } from './assets';
import { isAdditive } from './render';
import type { CollisionWorld, Hit } from './physics/vehicle';
import type { V3 } from './physics/vec';

// Patch global único (SPEC §9.6).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export class LevelCollision implements CollisionWorld {
  readonly bvh: MeshBVH;
  readonly geometry: THREE.BufferGeometry;
  readonly bounds: THREE.Box3;
  private readonly ray = new THREE.Ray();
  private readonly tmp = new THREE.Vector3();
  private readonly tri = new THREE.Triangle();
  private readonly normal = new THREE.Vector3();
  private readonly hitInfo = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };

  constructor(doc: ModelDoc, bin: ArrayBuffer, toWorld: THREE.Matrix4) {
    const geos: THREE.BufferGeometry[] = [];
    for (const { mesh, offset } of doc.scene) {
      const def = doc.meshes[mesh];
      if (isAdditive(def)) continue;
      for (const part of def.parts ?? []) {
        const g = buildGeometry(part, bin);
        const only = new THREE.BufferGeometry();
        only.setAttribute('position', g.getAttribute('position').clone());
        only.setIndex(g.getIndex()!.clone());
        if (offset) only.translate(offset[0], offset[1], offset[2]); // objeto posicionado (nó 0x03)
        only.applyMatrix4(toWorld);
        geos.push(only);
      }
    }
    // Junta tudo num único índice (sem mergeGeometries para não exigir atributos iguais além da posição).
    let vCount = 0;
    let iCount = 0;
    for (const g of geos) {
      vCount += g.getAttribute('position').count;
      iCount += g.getIndex()!.count;
    }
    const pos = new Float32Array(vCount * 3);
    const idx = new Uint32Array(iCount);
    let vo = 0;
    let io = 0;
    for (const g of geos) {
      pos.set(g.getAttribute('position').array as Float32Array, vo * 3);
      const src = g.getIndex()!.array;
      for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
      vo += g.getAttribute('position').count;
      io += src.length;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    this.bvh = new MeshBVH(this.geometry);
    this.geometry.boundsTree = this.bvh;
    this.geometry.computeBoundingBox();
    this.bounds = this.geometry.boundingBox!.clone();
  }

  get triangleCount() {
    return this.geometry.getIndex()!.count / 3;
  }

  raycast(origin: V3, dir: V3, maxDist: number): Hit | null {
    this.ray.origin.set(origin.x, origin.y, origin.z);
    this.ray.direction.set(dir.x, dir.y, dir.z);
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide, 0, maxDist);
    if (!hit || hit.distance > maxDist) return null;
    const n = hit.face!.normal.clone();
    // Geometria double-sided: a normal sempre "contra" o raio.
    if (n.dot(this.ray.direction) > 0) n.negate();
    return { distance: hit.distance, normal: { x: n.x, y: n.y, z: n.z } };
  }

  closestPoint(p: V3, maxDist: number): { point: V3; distance: number } | null {
    this.tmp.set(p.x, p.y, p.z);
    const target = this.bvh.closestPointToPoint(this.tmp, this.hitInfo, 0, maxDist);
    if (!target || target.distance > maxDist) return null;
    return { point: { x: target.point.x, y: target.point.y, z: target.point.z }, distance: target.distance };
  }

  /** Normal do triângulo mais próximo (para depuração). */
  faceNormal(faceIndex: number): THREE.Vector3 {
    const i = this.geometry.getIndex()!;
    const p = this.geometry.getAttribute('position');
    this.tri.setFromAttributeAndIndices(p, i.getX(faceIndex * 3), i.getX(faceIndex * 3 + 1), i.getX(faceIndex * 3 + 2));
    return this.tri.getNormal(this.normal);
  }
}
