"""Gera public/assets/rules/particles.json: emissores de partículas do SCUS_976.21 (ver docs/NATIVE.md "Partículas").

- Por id (0..0x53), quatro tabelas estáticas copiadas para o emissor de 0x1780 bytes por FUN_00246878:
  T1 0x2cab00 + id·0x38 (emissor+0x1480: flags, tipo de desenho, textura, mistura, 8 cores, luz),
  T2 0x2cbd60 + id·0x50 (+0x14b8: arrasto, empuxo, gravidade, curva da luz),
  T3 0x2cd8e0 + id·0x50 (+0x15f0: atraso/duração, taxa, cone, deslocamento, velocidade, espalhamento),
  T4 0x2cf320 + id·0x30 (+0x1660: tamanho, crescimento, vida em tiques).
  Conversões feitas na carga (FUN_00244b20): cone → k = (1 − cos(θ/2))/2 (FUN_00237d80 sorteia y ∈ [1 − 2k, 1]).
- Texturas: descritores 0x2c9500 + slot·0x100 (+0x90: modo, ladrilhos x/y, quadros); o slot 1 é o padrão de
  FUN_00244b20 e os slots 2.. vêm dos nós de categoria 7000..7199 do RESIDENT.BDD na ordem da coleta
  (FUN_00168aa8 → FUN_002447f0, DAT_002f3f6c começa em 2), com o id da textura em +0x10 do nó.

Uso: python tools/native/export_particles.py
"""

from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from elf import ELF_SHA256, Elf  # noqa: E402
import ngp  # noqa: E402
import tex  # noqa: E402

ROOT = HERE.parents[1]
OUT = ROOT / "public" / "assets" / "rules" / "particles.json"
RESIDENT = ROOT / "source" / "game" / "globals" / "resident"

T1, T2, T3, T4 = 0x2CAB00, 0x2CBD60, 0x2CD8E0, 0x2CF320
COUNT = 0x54  # FUN_00244b20 percorre 0x54 ids
SLOT_BASE = 0x2C9500


def main() -> int:
    e = Elf()

    def u32(a: int) -> int:
        return struct.unpack_from("<I", e.data, e.off(a))[0]

    def f32(a: int) -> float:
        return round(struct.unpack_from("<f", e.data, e.off(a))[0], 6)

    def rgba(w: int) -> list[int]:
        return [w & 0xFF, (w >> 8) & 0xFF, (w >> 16) & 0xFF, (w >> 24) & 0xFF]

    emitters = []
    for i in range(COUNT):
        a1, a2, a3, a4 = T1 + i * 0x38, T2 + i * 0x50, T3 + i * 0x50, T4 + i * 0x30
        kind = u32(a1) >> 16
        tex_ptr = u32(a1 + 4)
        cone = f32(a3 + 0x10)
        off_ptr = u32(a3 + 0x14)
        drag_split = f32(a2 + 0xC)
        life = struct.unpack_from("<i", e.data, e.off(a4 + 0x1C))[0]
        emitters.append({
            "id": i,
            # T1
            "flags": u32(a1) & 0xFFFF,
            "type": kind,
            "slot": (tex_ptr - SLOT_BASE) // 0x100 if tex_ptr else -1,
            "blend": u32(a1 + 8) & 0xFF,
            "drawDist": f32(a1 + 0xC),
            "colors": [rgba(u32(a1 + 0x10 + 4 * k)) for k in range(8)],
            "lightColor": rgba(u32(a1 + 0x34))[:3],
            # T2
            "physFlags": u32(a2),
            "drag": [f32(a2 + 4), f32(a2 + 8)],
            "dragSplit": drag_split,
            "buoyancy": f32(a2 + 0x10),
            "gravity": f32(a2 + 0x14),
            "light": [f32(a2 + 0x18), f32(a2 + 0x1C), f32(a2 + 0x20), f32(a2 + 0x24)],
            "flock": [f32(a2 + 0x28), f32(a2 + 0x2C), f32(a2 + 0x30), f32(a2 + 0x34)],
            # T3
            "emitFlags": u32(a3),
            "delay": u32(a3 + 4) & 0xFFFF,
            "duration": u32(a3 + 4) >> 16,
            "lifeRand": f32(a3 + 8),
            "rate": f32(a3 + 0xC),
            "coneDeg": cone,
            "coneK": round(0.5 - math.cos(cone * math.pi / 180 * 0.5) * 0.5, 6) if kind != 0 else cone,
            "offset": [f32(off_ptr + 4 * k) for k in range(3)] if off_ptr else [0, 0, 0],
            "axial": [f32(a3 + 0x1C), f32(a3 + 0x2C)],
            "speed": [f32(a3 + 0x20), f32(a3 + 0x24)],
            "inherit": f32(a3 + 0x28),
            "spread": [f32(a3 + 0x30), f32(a3 + 0x34)],
            "speedRate": [f32(a3 + 0x38), f32(a3 + 0x3C), f32(a3 + 0x40), f32(a3 + 0x44)],
            # T4
            "sizeFlags": u32(a4),
            "sizeBase": struct.unpack_from("<i", e.data, e.off(a4 + 4))[0],
            "size": [f32(a4 + 8), f32(a4 + 0xC)],
            "grow": [f32(a4 + 0x10), f32(a4 + 0x14)],
            "growSplit": f32(a4 + 0x18),
            "life": life,
            "fade": [f32(a4 + 0x20), f32(a4 + 0x24), f32(a4 + 0x28)],
        })

    # Texturas dos slots: nós 7000..7199 do RESIDENT na ordem do percurso de coleta.
    sys.path.insert(0, str(ROOT / "tools"))
    from convert_model import save_texture  # noqa: E402

    d = (RESIDENT / "resident.ngp").read_bytes()
    ptr = (RESIDENT / "resident.ptr").read_bytes()
    meshes = ngp.find_meshes(d, ptr)
    textures = {t.id: t for t in tex.decode((RESIDENT / "resident.rtx").read_bytes())}
    textures.update({t.id: t for t in tex.decode((RESIDENT / "resident.tex").read_bytes())})
    order: list[tuple[int, int]] = []
    for r in ngp.roots(d):
        for p in ngp.scene(d, ptr, meshes, root=r, lenient=True).visited:
            c = struct.unpack_from("<I", d, p)[0] >> 18
            if 7000 <= c < 7200 and c != 7100 and all(p != q for q, _ in order):
                order.append((p, c))
    slots: dict[str, dict] = {}
    for k, (p, c) in enumerate(order[: 0x16 - 2]):
        slot = 2 + k
        tid = struct.unpack_from("<I", d, p + 0x10)[0]
        t = textures.get(tid)
        desc = SLOT_BASE + slot * 0x100 + 0x90
        mode, tx, ty, frames = (e.data[e.off(desc) + j] for j in range(4))
        slots[str(slot)] = {
            "category": c, "texture": f"{tid:x}", "mode": mode, "tiles": [tx, ty], "frames": frames,
            **({"image": save_texture(t)} if t else {}),
        }
    desc = SLOT_BASE + 0x100 + 0x90
    slots["1"] = {"category": None, "texture": None, "mode": e.data[e.off(desc)], "tiles": [e.data[e.off(desc) + 1], e.data[e.off(desc) + 2]],
                  "frames": e.data[e.off(desc) + 3]}

    doc = {
        "elf": "SCUS_976.21", "sha256": ELF_SHA256,
        "source": "tabelas 0x2cab00/0x2cbd60/0x2cd8e0/0x2cf320 (FUN_00246878); texturas: RESIDENT.BDD cat. 7000.. (FUN_002447f0)",
        "coords": "ps2",
        "emitters": emitters,
        "slots": slots,
    }
    OUT.write_text(json.dumps(doc, indent=1), "utf-8")
    print(f"{len(emitters)} emissores, {len(slots)} slots de textura -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
