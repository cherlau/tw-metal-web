"""Lançadores de arma dos carros: peças que abrem (porta/tampa) quando a arma do slot dispara.

Estrutura (evidência: Sweet Tooth, Cop, Warthog — docs/FORMATS.md):
  osso 0x0D com bit 31 nas flags (LANÇADOR) — filhos: registros 0x00F0xxxx (um por slot servido,
  slot = (word & 0xFFFF) >> 6, o mesmo id dos pontos de montagem 0x00F8 e da tabela de pickups),
  malhas da base e ossos 0x0D com matrizes (PORTAS: dobradiça no pivô = translação do bind em +0x60).
  As malhas do lançador costumam estar modeladas em torno da origem; o jogo as põe no ponto de montagem
  (o cabeçalho do osso traz y, z em +0x08/+0x0C; x vem do ponto de montagem 0x00F8 do slot).

Abertura: ⚠️ ESCOLHA DO HOST até achar o código no ELF — eixo = direção no plano do painel perpendicular
à linha dobradiça→centro do painel; ângulo 100°; sentido que leva o painel para fora do carro.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

import numpy as np

import ngp

OPEN_ANGLE = np.radians(100.0)


@dataclass
class Hinge:
    pivot: list[float]
    axis: list[float]
    angle: float


@dataclass
class Launcher:
    bone: int
    slots: list[int]
    offset: list[float]  # translação aplicada às malhas (modelo -> ponto de montagem)
    meshes: list[int] = field(default_factory=list)  # malhas fixas (base)
    doors: list[tuple[int, Hinge]] = field(default_factory=list)  # (malha, dobradiça)


def _u32(b: bytes, p: int) -> int:
    return struct.unpack_from("<I", b, p)[0]


def _f32(b: bytes, p: int) -> float:
    return struct.unpack_from("<f", b, p)[0]


def find(data: bytes, ptr: bytes, meshes: dict[int, ngp.Mesh], rep: ngp.SceneReport,
         mounts: dict[str, list[float]]) -> list[Launcher]:
    relocs = ngp.relocations(data, ptr)
    out: list[Launcher] = []
    # registros F0 alcançados pela árvore: ancestral 0x0D com bit 31 mais próximo = lançador
    parents: dict[int, list[int]] = {}
    for q in relocs:
        parents.setdefault(_u32(data, q), []).append(q)
    starts = set(parents)

    def owner(q: int) -> int | None:
        for back in range(4, 0x200, 4):
            if q - back in starts:
                return q - back
        return None

    by_bone: dict[int, list[int]] = {}
    for rec in sorted({_u32(data, q) for q in relocs if _u32(data, q) + 0x20 <= len(data)}):
        w = _u32(data, rec)
        if w >> 16 != 0x00F0:
            continue
        cur = rec
        for _ in range(6):
            ps = parents.get(cur)
            n = owner(ps[0]) if ps else None
            if n is None:
                break
            if _u32(data, n) & 0x3F == 0x0D and _u32(data, n + 0x1C) & 0x80000000:
                by_bone.setdefault(n, []).append((w & 0xFFFF) >> 6)
                break
            cur = n
    in_scene = {i.mesh for i in rep.instances}
    for bone, slots in by_bone.items():
        sub = ngp.scene(data, ptr, list(meshes.values()), root=bone)
        insts = [i for i in sub.instances if i.mesh in in_scene and meshes[i.mesh].strips]
        if not insts:
            continue
        pts = np.concatenate([np.asarray(s.pos)[:, :3] for i in insts for s in meshes[i.mesh].strips])
        center = (pts.min(0) + pts.max(0)) / 2
        mount = next((mounts[str(s)] for s in slots if str(s) in mounts), None)
        offset = np.zeros(3)
        if mount is not None and np.linalg.norm(center[:2]) < 3.0 and np.linalg.norm(np.array(mount[:2])) > 3.0:
            y, z = _f32(data, bone + 8), _f32(data, bone + 0xC)
            hdr_ok = abs(y) > 1e-3 or abs(z) > 1e-3
            offset = np.array([mount[0], y if hdr_ok else mount[1], z if hdr_ok else mount[2]])
        la = Launcher(bone, sorted(set(slots)), [round(float(v), 4) for v in offset])
        for i in insts:
            b = sub.bones.get(i.bone)
            if b is not None and b.bind is not None and i.bone != bone:
                hinge = _hinge(meshes[i.mesh], b, offset)
                if hinge is not None:
                    la.doors.append((i.mesh, hinge))
                    continue
            la.meshes.append(i.mesh)
        out.append(la)
    return out


def _hinge(m: ngp.Mesh, bone: ngp.Bone, offset: np.ndarray) -> Hinge | None:
    pts = np.concatenate([np.asarray(s.pos)[:, :3] for s in m.strips])
    size = pts.max(0) - pts.min(0)
    center = (pts.min(0) + pts.max(0)) / 2
    pivot = bone.bind[3, :3].astype(np.float64)
    thin = int(np.argmin(size))
    reach = center - pivot
    reach[thin] = 0.0
    if np.linalg.norm(reach) < 1e-3:
        return None
    normal = np.zeros(3)
    normal[thin] = 1.0
    axis = np.cross(normal, reach / np.linalg.norm(reach))
    axis /= np.linalg.norm(axis)
    # sentido: o centro do painel deve se afastar do eixo do carro (x = 0) e/ou subir
    world_c = center + offset
    best = None
    for sgn in (1.0, -1.0):
        rc = _rotate(center - pivot, axis, sgn * OPEN_ANGLE) + pivot + offset
        score = abs(rc[0]) - abs(world_c[0]) + (rc[2] - world_c[2])
        if best is None or score > best[0]:
            best = (score, sgn)
    return Hinge([round(float(v), 4) for v in pivot + offset], [round(float(v), 4) for v in axis],
                 round(float(best[1] * OPEN_ANGLE), 4))


def _rotate(v: np.ndarray, axis: np.ndarray, ang: float) -> np.ndarray:
    c, s = np.cos(ang), np.sin(ang)
    return v * c + np.cross(axis, v) * s + axis * np.dot(axis, v) * (1 - c)
