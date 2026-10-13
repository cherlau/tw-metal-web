"""HUD do jogo: peças 3D do GLOBALS.BDD presas à câmera (RE: docs/NATIVE.md "HUD").

O coletor do HUD (FUN_0013b310) guarda os nós por categoria (word >> 18) e cada widget posiciona o seu na
frente da câmera (FUN_0019e458 → FUN_0019e580: x·prof/1,5, prof, z·prof·0,5 — coordenadas normalizadas de uma
tela 4:3). Cada raiz exportada leva instâncias (com marcas de seletor 0x05), ossos (0x0D/0x18/0x1F/0x03, os
0x18 com canal de escala), seletores e os clipes do objeto 0x11 da raiz (tempo dado pelo código do widget).
"""

from __future__ import annotations

import struct

import ngp
import rig

# Categoria -> (papel, posição (x, profundidade, z) do FUN_0013b310 para 1 jogador)
HUD_ROOTS = {
    0x206D: ("radar", (-0.68, 3.0, 0.575)),  # 0xbf2e147b, 0x40400000, 0x3f133333 (widget +0xC0)
    0x206E: ("panel", (0.69, 3.5, -0.6)),  # 0x3f30a3d7, 0x40600000, 0xbf19999a (widget +0x24E0)
    0x1FFE: ("charge", (0.0, 4.02, -0.43)),  # 0, 0x4080a3d7, 0xbedc28f6 (widget +0x14D0, carga do especial)
}


def _u32(b: bytes, p: int) -> int:
    return struct.unpack_from("<I", b, p)[0]


def _first_roots(data: bytes, ptr: bytes, meshes: list[ngp.Mesh]) -> dict[int, int]:
    """1º nó de cada categoria do HUD na ordem do percurso (a 2ª cópia é a do jogador 2)."""
    rep = ngp.scene(data, ptr, meshes, selectors=True)
    found: dict[int, int] = {}
    for inst in rep.instances + rep.selected:
        for n in inst.path[:-1]:
            cat = _u32(data, n) >> 18
            if cat in HUD_ROOTS and cat not in found:
                found[cat] = n
    return found


def _object_clips(data: bytes, insts: list[ngp.Instance]) -> list[dict]:
    """Clipes do 1º objeto 0x11 da raiz (tabela em +0x20: u16 n, ponteiros em +0x10), 1º de cada categoria."""
    obj = next((n for i in insts for n in i.path[:-1] if _u32(data, n) & 0x3F == 0x11 and _u32(data, n + 0x20)), None)
    if obj is None:
        return []
    table = _u32(data, obj + 0x20)
    n = struct.unpack_from("<H", data, table)[0]
    out, seen = [], set()
    for k in range(n):
        c = _u32(data, table + 0x10 + 4 * k)
        if not c or _u32(data, c) & 0x3F != 0x0B:
            continue
        clip = rig._clip(data, c)
        if clip.category in seen:
            continue
        seen.add(clip.category)
        out.append({"category": clip.category, "start": clip.start, "duration": clip.duration, "role": "other",
                    "loop": clip.loop,
                    "tracks": [{"ch": t.channel, "kind": t.kind, "step": t.step, "base": t.base, "scale": t.scale,
                                "t0": t.t0, "keys": t.keys} for t in clip.tracks]})
    return out


def export(data: bytes, ptr: bytes, meshes: list[ngp.Mesh]) -> tuple[dict, list[ngp.Instance]]:
    """(JSON do HUD, instâncias usadas — o conversor tira delas o estado do GS de cada malha)."""
    out = {}
    used: list[ngp.Instance] = []
    for cat, node in sorted(_first_roots(data, ptr, meshes).items()):
        role, pos = HUD_ROOTS[cat]
        rep = ngp.scene(data, ptr, meshes, root=node, selectors=True)
        insts = rep.instances + rep.selected
        used += insts
        bones, index = rig.build(data, insts)

        def inst_json(i: ngp.Instance) -> dict:
            d = {"mesh": f"m{i.mesh:06x}", "bone": None, "b": rig.leaf_bone(data, i, index)}
            if i.select:
                d["sel"] = [[f"n{n:06x}", c] for n, c in i.select]
            return d

        out[role] = {
            "node": f"n{node:06x}",
            "category": cat,
            "pos": list(pos),
            "instances": [inst_json(i) for i in insts],
            "selectors": {f"n{n:06x}": {"category": sl.category, "id": sl.id, "kind": sl.kind, "state": sl.state,
                                        "count": sl.count} for n, sl in rep.selectors.items()},
            "rig": {
                "bones": [{"parent": b.parent, "const": b.const, "chan": b.chan, "vis": b.vis, "pre": b.pre,
                           "post": b.post, **({"schan": b.schan} if b.schan else {})} for b in bones],
                "clips": _object_clips(data, insts),
            },
        }
    return out, used
