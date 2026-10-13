// Colisão da arena: um BVH (three-mesh-bvh) sobre a geometria visível da pose base.
// ⚠️ ESCOLHA DO HOST: a grade de colisão original (raiz 0x0C do .ngp) ainda não foi decodificada;
// usamos os triângulos de render, sem os translúcidos/aditivos (fogo, brilhos, vidro de efeito).
// Objetos destrutíveis (nós 0x13): entram todas as entradas; as que não estão no estado atual têm os vértices
// recolhidos para longe (hideInstances) e o BVH é reajustado (refit) — o jogo usa a geometria do estado atual.
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, MeshBVH } from 'three-mesh-bvh';
import { buildGeometry, instanceMatrix, type InstanceDef, type ModelDoc } from './assets';
import { isAdditive } from './render';
import type { CollisionWorld, Hit } from './physics/vehicle';
import type { V3 } from './physics/vec';

// Patch global único (SPEC §9.6).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Ponto para onde vão os vértices escondidos (fora de qualquer arena). */
const FAR = -1e6;

export class LevelCollision implements CollisionWorld {
  readonly bvh: MeshBVH;
  readonly geometry: THREE.BufferGeometry;
  readonly bounds: THREE.Box3;
  /** Instâncias na ordem da geometria e o 1º vértice de cada uma (faixas contíguas). */
  readonly instances: InstanceDef[];
  private readonly original: Float32Array;
  private readonly ray = new THREE.Ray();
  private readonly tmp = new THREE.Vector3();
  private readonly tri = new THREE.Triangle();
  private readonly normal = new THREE.Vector3();
  private readonly hitInfo = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };

  /** `instances`: padrão doc.scene; com destrutíveis, doc.scene + doc.damageScene. */
  constructor(doc: ModelDoc, bin: ArrayBuffer, toWorld: THREE.Matrix4, instances: InstanceDef[] = doc.scene) {
    const geos: THREE.BufferGeometry[] = [];
    const owner: number[] = [];
    instances.forEach((inst, k) => {
      const def = doc.meshes[inst.mesh];
      const xf = instanceMatrix(inst);
      if (isAdditive(def)) return;
      for (const part of def.parts ?? []) {
        const g = buildGeometry(part, bin);
        const only = new THREE.BufferGeometry();
        only.setAttribute('position', g.getAttribute('position').clone());
        only.setIndex(g.getIndex()!.clone());
        if (xf) only.applyMatrix4(xf); // objeto posicionado (nós 0x03/0x1F)
        only.applyMatrix4(toWorld);
        geos.push(only);
        owner.push(k);
      }
    });
    // Junta tudo num único índice (sem mergeGeometries para não exigir atributos iguais além da posição).
    let vCount = 0;
    let iCount = 0;
    for (const g of geos) {
      vCount += g.getAttribute('position').count;
      iCount += g.getIndex()!.count;
    }
    const pos = new Float32Array(vCount * 3);
    const idx = new Uint32Array(iCount);
    this.instances = instances;
    const ranges: [number, number][] = instances.map(() => [Infinity, -1]);
    let vo = 0;
    let io = 0;
    geos.forEach((g, n) => {
      const count = g.getAttribute('position').count;
      pos.set(g.getAttribute('position').array as Float32Array, vo * 3);
      const src = g.getIndex()!.array;
      for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
      const r = ranges[owner[n]];
      r[0] = Math.min(r[0], vo);
      r[1] = Math.max(r[1], vo + count);
      vo += count;
      io += src.length;
    });
    this.ranges = ranges;
    this.original = pos.slice();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    this.bvh = new MeshBVH(this.geometry);
    this.geometry.boundsTree = this.bvh;
    this.geometry.computeBoundingBox();
    this.bounds = this.geometry.boundingBox!.clone();
    // vértice -> instância: como as faixas seguem a ordem das peças, um vetor de dono por vértice é direto
    this.vertexOwner = new Int32Array(vCount);
    ranges.forEach(([a, b], k) => {
      for (let v = a; v < b; v++) this.vertexOwner[v] = k;
    });
  }

  private readonly ranges: [number, number][];
  private readonly vertexOwner: Int32Array;

  get triangleCount() {
    return this.geometry.getIndex()!.count / 3;
  }

  /** Instância dona de um triângulo (índice em `instances`). */
  ownerOfFace(faceIndex: number): number {
    return this.vertexOwner[this.geometry.getIndex()!.getX(faceIndex * 3)];
  }

  /** Caixa (mundo) da geometria original de uma instância (vazia se ela não tem triângulos sólidos). */
  instanceBox(k: number, belowY = Infinity): THREE.Box3 {
    const box = new THREE.Box3();
    const [a, b] = this.ranges[k] ?? [Infinity, -1];
    const v = new THREE.Vector3();
    for (let i = a; i < b; i++) if (v.fromArray(this.original, i * 3).y < belowY) box.expandByPoint(v);
    return box;
  }

  /** Esconde/mostra instâncias (vértices recolhidos para longe) e reajusta o BVH. */
  setVisible(list: number[], visible: boolean): void {
    const pos = this.geometry.getAttribute('position').array as Float32Array;
    let any = false;
    for (const k of list) {
      const [a, b] = this.ranges[k] ?? [Infinity, -1];
      if (b <= a) continue;
      any = true;
      if (visible) pos.set(this.original.subarray(a * 3, b * 3), a * 3);
      else for (let v = a; v < b; v++) pos.set([0, FAR, 0], v * 3);
    }
    if (any) {
      this.geometry.getAttribute('position').needsUpdate = true;
      this.bvh.refit();
    }
  }

  raycast(origin: V3, dir: V3, maxDist: number): Hit | null {
    this.ray.origin.set(origin.x, origin.y, origin.z);
    this.ray.direction.set(dir.x, dir.y, dir.z);
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide, 0, maxDist);
    if (!hit || hit.distance > maxDist) return null;
    const n = hit.face!.normal.clone();
    // Geometria double-sided: a normal sempre "contra" o raio.
    if (n.dot(this.ray.direction) > 0) n.negate();
    return { distance: hit.distance, normal: { x: n.x, y: n.y, z: n.z }, tag: this.ownerOfFace(hit.faceIndex!) };
  }

  closestPoint(p: V3, maxDist: number): { point: V3; distance: number; tag?: number } | null {
    this.tmp.set(p.x, p.y, p.z);
    const target = this.bvh.closestPointToPoint(this.tmp, this.hitInfo, 0, maxDist);
    if (!target || target.distance > maxDist) return null;
    return { point: { x: target.point.x, y: target.point.y, z: target.point.z }, distance: target.distance, tag: this.ownerOfFace(target.faceIndex) };
  }

  /** Normal do triângulo mais próximo (para depuração). */
  faceNormal(faceIndex: number): THREE.Vector3 {
    const i = this.geometry.getIndex()!;
    const p = this.geometry.getAttribute('position');
    this.tri.setFromAttributeAndIndices(p, i.getX(faceIndex * 3), i.getX(faceIndex * 3 + 1), i.getX(faceIndex * 3 + 2));
    return this.tri.getNormal(this.normal);
  }
}
