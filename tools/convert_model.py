"""Converte um modelo .ngp+.ptr+.tex (carro, nível…) de source/game/<dir>/<nome>/ para public/assets/<dir>/<nome>.json + .bin.

Formato (SPEC §7.1): .bin little-endian com atributos float32 / índices uint32 alinhados a 4 bytes;
.json com spans [byteOffset, count]. Coordenadas ainda no espaço ORIGINAL do PS2 (sem conversão
de mão): o runtime aplica a regra única definida em src/coords.ts até a regra ser confirmada.

Uso: python tools/convert_model.py axel [--dir cars|aicars|lvl]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ngp  # noqa: E402
import tex  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "source" / "game"
ASSETS = ROOT / "public" / "assets"


# Texturas de EFEITO que o código do jogo liga sob demanda e que não passam por um slot 0x05.
# ESCOLHA DO HOST (evidência: mesmas texturas de gelo em vários carros, cobrindo o carro inteiro);
# confirmar no ELF (Fase 4) e trocar por regra nativa.
CODE_FX_TEXTURES = {
    0x88A28: "freeze",  # cristais de gelo (casca do congelamento)
    0xB5A20: "freeze",  # espinhos de gelo
}


class BinWriter:
    def __init__(self) -> None:
        self.buf = bytearray()

    def add(self, arr: np.ndarray) -> list[int]:
        arr = np.ascontiguousarray(arr)
        offset = len(self.buf)
        self.buf += arr.tobytes()
        self.buf += b"\0" * (-len(self.buf) % 4)
        return [offset, int(arr.size)]


def save_texture(t: tex.Texture) -> dict:
    png = io.BytesIO()
    Image.fromarray(t.rgba, "RGBA").save(png, "PNG", optimize=True)
    data = png.getvalue()
    name = f"textures/{hashlib.sha256(t.rgba.tobytes()).hexdigest()[:20]}.png"
    target = ASSETS / name
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    alpha = t.rgba[..., 3]
    return {
        "url": name,
        "width": t.width,
        "height": t.height,
        "bpp": t.bpp,
        "alpha": "opaque" if alpha.min() == 255 else ("cutout" if np.isin(alpha, (0, 255)).all() else "blend"),
    }


def convert(name: str, folder: str) -> dict:
    base = SOURCE / folder / name

    def section(kind: str) -> bytes:
        # O nome da seção nem sempre é o do BDD (ex.: aicars/thump.bdd -> thumpai.ngp).
        found = sorted(base.glob(f"*.{kind}"))
        if len(found) != 1:
            raise FileNotFoundError(f"{base}: esperava 1 seção .{kind}, achei {len(found)}")
        return found[0].read_bytes()

    ngp_bytes, ptr_bytes, tex_bytes = section("ngp"), section("ptr"), section("tex")

    textures = {f"{t.id:x}": save_texture(t) for t in tex.decode(tex_bytes)}
    meshes = ngp.find_meshes(ngp_bytes, ptr_bytes)
    errors: list[str] = []
    out = BinWriter()
    mesh_json = {}
    for m in meshes:
        key = f"m{m.offset:06x}"
        tex_key = f"{m.texture_id:x}"
        for tid in m.textures:
            if tid and f"{tid:x}" not in textures:
                errors.append(f"{key}: textura {tid:x} ausente no .tex")
        entry: dict = {
            "offset": m.offset,
            "flags": m.flags,
            "texture": tex_key if m.texture_id else None,
            "texture2": f"{m.texture2:x}" if m.texture2 else None,
            "textures": [f"{t:x}" for t in m.textures],
            "scale": m.scale,
            "packed": m.packed,
            "poolOwner": f"m{m.pool_owner:06x}" if m.pool_owner >= 0 else None,
            "sphere": [round(v, 5) for v in m.sphere],
        }
        if m.strips:
            # Uma parte por slot de textura (o cabeçalho de cada strip escolhe a textura).
            entry["parts"] = []
            for slot in m.texture_slots():
                if slot >= max(1, len(m.textures)):
                    errors.append(f"{key}: strip usa textura #{slot}, cabeçalho tem {len(m.textures)}")
                    continue
                attrs, indices = m.triangles(slot)
                if not len(indices):
                    continue
                entry["parts"].append({
                    "texture": f"{m.textures[slot]:x}" if m.textures else None,
                    "attributes": {
                        "position": out.add(attrs["position"]),
                        "normal": out.add(attrs["normal"]),
                        "uv": out.add(attrs["uv"]),
                        "color": out.add(attrs["color"][:, :3]),
                        "indices": out.add(indices.astype(np.uint32)),
                    },
                })
        if m.sprites:
            entry["sprites"] = [
                {"center": s.center, "size": s.size, "color": s.color, "uv": s.uv} for s in m.sprites
            ]
        if m.beams:
            entry["beams"] = [
                {"points": b.points, "colors": b.colors, "uvs": b.uvs} for b in m.beams
            ]
        mesh_json[key] = entry

    scene_rep = ngp.scene(ngp_bytes, ptr_bytes, meshes)
    by_offset = {m.offset: m for m in meshes}

    def code_fx(inst) -> str | None:
        kinds = {CODE_FX_TEXTURES.get(t) for t in by_offset[inst.mesh].textures} or {None}
        return kinds.pop() if len(kinds) == 1 else None

    for inst in list(scene_rep.instances):
        kind = code_fx(inst)
        if kind:
            scene_rep.instances.remove(inst)
            scene_rep.code_effects.setdefault(kind, []).append(inst)

    def level_objects_json() -> list[dict]:
        base = {i.mesh for i in scene_rep.instances}
        out = []
        for node in ngp.level_objects(ngp_bytes):
            rep = ngp.scene(ngp_bytes, ptr_bytes, meshes, root=node, lenient=True)
            insts = [{"mesh": f"m{i.mesh:06x}", "bone": f"n{i.bone:06x}" if i.bone >= 0 else None} for i in rep.instances]
            out.append({
                "node": f"n{node:06x}",
                "inScene": bool(insts) and all(int(i["mesh"][1:], 16) in base for i in insts),
                "instances": insts,
            })
        return out

    def mat(m) -> list[float] | None:
        return None if m is None else [round(float(v), 6) for v in m.reshape(-1)]

    doc = {
        "version": 1,
        "name": name,
        "source": f"{folder}/{name}",
        "sha256": {
            "ngp": hashlib.sha256(ngp_bytes).hexdigest(),
            "ptr": hashlib.sha256(ptr_bytes).hexdigest(),
            "tex": hashlib.sha256(tex_bytes).hexdigest(),
        },
        "coords": "ps2",
        "counts": {
            "meshes": len(meshes),
            "triangles": sum(len(m.triangles()[1]) // 3 for m in meshes if m.strips),
            "sprites": sum(len(m.sprites) for m in meshes),
            "beams": sum(len(m.beams) for m in meshes),
            "textures": len(textures),
            "instances": len(scene_rep.instances),
        },
        "errors": errors,
        # Pose base (LOD mais detalhado, estado intacto): malhas já no espaço do modelo.
        "scene": [{"mesh": f"m{i.mesh:06x}", "bone": f"n{i.bone:06x}" if i.bone >= 0 else None}
                  for i in scene_rep.instances],
        # Slots de efeito (nós 0x05), fora da pose base; o runtime liga cada um quando precisar.
        "effects": {
            f"n{node:06x}": [{"mesh": f"m{i.mesh:06x}", "bone": f"n{i.bone:06x}" if i.bone >= 0 else None} for i in insts]
            for node, insts in scene_rep.effects.items()
        } | {
            f"code:{kind}": [{"mesh": f"m{i.mesh:06x}", "bone": f"n{i.bone:06x}" if i.bone >= 0 else None} for i in insts]
            for kind, insts in scene_rep.code_effects.items()
        },
        # Objetos do nível (cabeçalho +0x10): os que não aparecem na cena são pré-fabricados
        # (centrados na origem) instanciados pelo jogo em runtime.
        "objects": level_objects_json(),
        # Ossos para animação: matrizes 4x4 vetor-linha achatadas (= column-major do Three).
        "bones": {
            f"n{b.node:06x}": {"parent": f"n{b.parent:06x}" if b.parent >= 0 else None,
                               "invBind": mat(b.inv_bind), "bind": mat(b.bind)}
            for b in scene_rep.bones.values()
        },
        "sceneUnknown": {f"{k:x}": [f"{p:x}" for p in v] for k, v in scene_rep.unknown.items()},
        "meshes": mesh_json,
        "textures": textures,
    }
    dest = ASSETS / folder
    dest.mkdir(parents=True, exist_ok=True)
    (dest / f"{name}.bin").write_bytes(bytes(out.buf))
    (dest / f"{name}.json").write_text(json.dumps(doc, indent=1), "utf-8")
    return doc


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="+")
    ap.add_argument("--dir", default="cars", choices=("cars", "aicars", "lvl", "globals", "shell"))
    args = ap.parse_args()
    failed = 0
    for name in args.names:
        doc = convert(name.lower(), args.dir)
        c = doc["counts"]
        print(f"{name}: {c['meshes']} malhas, {c['triangles']} triângulos, {c['sprites']} sprites, {c['textures']} texturas")
        for e in doc["errors"]:
            print("  ERRO", e)
        failed += bool(doc["errors"])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
