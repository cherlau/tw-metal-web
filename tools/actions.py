"""Nós de ação (actionDispatch.cpp) — o "efeito" que um nó 0x13 solta ao entrar num estado de dano.

RE (docs/NATIVE.md, "Ações e destroços"): FUN_00172768 → FUN_00172938 → FUN_00100f78/FUN_001010b0 → FUN_00101010,
que agenda o handler do tipo (tabela 0x2dad48) para daqui a `atraso` tiques de 1/60 s (f32 em +0x04):
  0 lista       (FUN_00101630): u32 n em +0x08, n ponteiros a partir de +0x0C
  1 transformação (FUN_00172938/FUN_001016b8): *filho em +0x08, matriz 4x4 (vetor-linha) em +0x10
  2 clipe       (FUN_00101720): +0x08 objeto, u16 +0x0C (bit 0x800 = jogador/IA, & 0x7FF categoria), u16 +0x0E clipe
  3 destroços   (FUN_00101800 → FUN_001729e0 → FUN_0016e678): ver debris()
  4 som         (FUN_00101848 → FUN_001a0db8): id em +0x08 (0 → 0x15) → nome do banco (SOUND_NAMES)
  5 tremor de câmera, 6+ — "unsupported" no próprio jogo
"""

from __future__ import annotations

import struct

import numpy as np

import ngp


def _u32(b: bytes, p: int) -> int:
    return struct.unpack_from("<I", b, p)[0]


def _f32(b: bytes, p: int) -> float:
    return struct.unpack_from("<f", b, p)[0]


# FUN_001a0db8: id -> (som, distância mínima, máxima). Nomes montados por dois u64 little-endian no código.
SOUND_NAMES = {
    10: ("D_CONCRETE_SM", 60, 300), 11: ("D_CONCRETE_LG", 80, 600),
    0x14: ("D_METALHOLLOW_SM", 60, 300), 0x15: ("D_METALHOLLOW_LG", 80, 600),
    0x16: ("D_METAL_SLD_SM", 60, 300), 0x17: ("D_METAL_SLD_LG", 80, 600), 0x19: ("D_METAL_SLD_LG", 80, 600),
    0x18: ("D_METAL_SHT_SM", 60, 300), 0x1A: ("D_METAL_MXD_SM", 60, 300), 0x1B: ("D_METAL_MXD_LG", 80, 600),
    0x28: ("D_PLASTIC", 60, 300), 0x32: ("D_TREE_HIT_SM", 60, 300), 0x33: ("D_TREE_HIT_LG", 80, 600),
    0x3C: ("D_WOOD_HOLLOW_SM", 60, 300), 0x3D: ("D_WOOD_HOLLOW_LG", 80, 600),
    0x3E: ("D_WOOD_SLD_SM", 60, 300), 0x3F: ("D_WOOD_SLD_LG", 80, 600),
    0x40: ("D_WOOD_MXD_SM", 60, 300), 0x41: ("D_WOOD_MXD_LG", 80, 600),
    0x46: ("D_GLASS_SM", 60, 300), 0x47: ("D_GLASS_LG", 80, 600),
    0x50: ("D_FENCE_BAR", 60, 300), 0x51: ("D_FENCE_CHAIN", 60, 300), 0x52: ("D_FENCE_WOOD", 60, 300),
    0x53: ("B_BARREL_CRASH", 60, 300), 0x55: ("D_SHRUB", 60, 300), 0x56: ("D_TRANSFORMER", 80, 600),
}

# FUN_0016e678: no máximo 32 peças; caixa das peças = eixos do cabeçalho da malha × 0,75, cada eixo com
# comprimento ≥ 1 (0 < |a| < 1 → normalizado).
MAX_PIECES = 32
BOX_SCALE = 0.75


def decode(data: bytes, p: int, pieces: dict[int, dict], depth: int = 0) -> dict | None:
    """Árvore de ações a partir do nó p (pieces recebe os modelos das peças de destroço, por nó)."""
    if not p or depth > 16 or p + 0x10 > len(data):
        return None
    kind = struct.unpack_from("<H", data, p)[0]
    out: dict = {"type": kind, "delay": round(_f32(data, p + 4), 4)}
    if kind == 0:
        n = _u32(data, p + 8)
        out["items"] = [x for x in (decode(data, _u32(data, p + 0x0C + 4 * i), pieces, depth + 1)
                                    for i in range(min(n, 64))) if x]
    elif kind == 1:
        out["matrix"] = [round(v, 6) for v in struct.unpack_from("<16f", data, p + 0x10)]
        out["child"] = decode(data, _u32(data, p + 8), pieces, depth + 1)
    elif kind == 2:
        out["object"] = _u32(data, p + 8)
        out["flags"], out["clip"] = struct.unpack_from("<HH", data, p + 0x0C)
    elif kind == 3:
        out.update(debris(data, p, pieces))
    elif kind == 4:
        sid = _u32(data, p + 8) or 0x15
        name = SOUND_NAMES.get(sid)
        out.update({"sound": sid, **({"name": name[0], "near": name[1], "far": name[2]} if name else {})})
    return out


def debris(data: bytes, p: int, pieces: dict[int, dict]) -> dict:
    """Ação 3 (FUN_0016e678). +0x08 f32 massa (corpo +0x18), u64 em +0x08 bits 53..61 = nº de peças, u16 +0x0E & 7 =
    modo do corpo (+0x160), +0x10 vec3 centro da explosão (direção = peça − centro), +0x1C f32 velocidade-base;
    peças de 0x14 bytes em +0x28: (u32 ?, vec3 posição, *descritor [*modelo, f32 massa, f32 (0,25), u32, *casco])."""
    n = min((struct.unpack_from("<Q", data, p + 8)[0] >> 53) & 0x1FF, MAX_PIECES)
    out = {
        "mass": round(_f32(data, p + 8), 4),
        "mode": struct.unpack_from("<H", data, p + 0x0E)[0] & 7,
        "center": [round(v, 4) for v in struct.unpack_from("<3f", data, p + 0x10)],
        "speed": round(_f32(data, p + 0x1C), 4),
        "pieces": [],
    }
    for i in range(n):
        r = p + 0x28 + 0x14 * i
        pos = struct.unpack_from("<3f", data, r + 4)
        desc = _u32(data, r + 0x10)
        model = _u32(data, desc) if desc and desc + 0x14 <= len(data) else 0
        if not model:
            continue
        pieces.setdefault(model, {"hull": _u32(data, desc + 0x10)})
        out["pieces"].append({"model": f"n{model:06x}", "pos": [round(v, 4) for v in pos]})
    return out


def piece_box(data: bytes, model: int) -> tuple[list[float], list[list[float]], list[float]] | None:
    """Caixa da peça como FUN_0016e678 (sem casco): procura a malha descendo pelos 1os filhos (0x03 → +0x1C,
    0x01 → +0x20, 0x04 → +0x50); centro = esfera do cabeçalho (+0x20) + translação do 0x03; eixos = colunas de
    (+0x30, +0x40, +0x50) × 0,75. Devolve (centro, eixos, translação do 0x03) ou None."""
    node, t3 = model, np.zeros(3)
    for _ in range(4):
        kind = _u32(data, node) & 0x1F
        if kind == 0:
            break
        if kind == 3:
            t3 = np.array(struct.unpack_from("<3f", data, node + 0x10))
            node = _u32(data, node + 0x1C)
        elif kind == 1:
            node = _u32(data, node + 0x20)
        elif kind == 4:
            node = _u32(data, node + 0x50)
        else:
            return None
    else:
        return None
    rows = np.array([struct.unpack_from("<3f", data, node + off) for off in (0x30, 0x40, 0x50)])
    axes = []
    for k in range(3):
        a = rows[:, k] * BOX_SCALE
        n = float(np.linalg.norm(a))
        axes.append([round(float(v), 5) for v in (a / n if 0.0 < n < 1.0 else a)])
    center = np.array(struct.unpack_from("<3f", data, node + 0x20)) + t3
    return [round(float(v), 5) for v in center], axes, [round(float(v), 5) for v in t3]


def piece_models(data: bytes, ptr: bytes, meshes: list[ngp.Mesh], pieces: dict[int, dict]) -> dict[int, dict]:
    """Instâncias (malhas no espaço da peça: o 0x03 do modelo leva o centro à origem) e caixa de cada peça."""
    out = {}
    for model, info in pieces.items():
        box = piece_box(data, model)
        rep = ngp.scene(data, ptr, meshes, root=model)
        if box is None or not rep.instances:
            continue
        center, axes, t3 = box
        size = max(2 * float(np.linalg.norm(a)) for a in axes)
        out[model] = {"instances": rep.instances, "offset": t3, "center": center, "axes": axes,
                      # raio da peça (FUN_0016e678: maior lado da caixa / 1,5) — espalha a direção (± 5 %)
                      "radius": round(size / 1.5, 5), "hull": info["hull"]}
    return out
