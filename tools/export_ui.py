"""Exporta a arte do HUD e do menu para public/assets/ui/ (RE: docs/NATIVE.md "HUD" e "Menu").

Fonte: páginas 512×512 em 4 bits do RESIDENT.RTX (ids 0x46e98 = PSMT4HL, 0x46f20 = PSMT4HH: duas fontes na
mesma área da VRAM), grade 16×16 de células de 32 px; a imagem vem de cabeça para baixo como as demais
texturas (UV v ∈ [-1, 0]) e é desvirada aqui.
Métricas: tabela do ELF em 0x2c7ae8 (224 registros de 0x18 bytes: código, página, coluna, linha, largura,
largura alternativa — em 1/32 da célula), lida por FUN_00223318 (largura = avanço × largura/32).
Menu (SHELL/UI.BDD): logo = malhas das raízes 0x2397/0x2398/0x2399 rasterizadas (vista da câmera da UI, quads
no plano xz); ícones de seleção = lista de objetos na ordem dos ids dos veículos (0x2b39f0); cartões de piloto
= metades das texturas 0x49904..0x49d64 (ligadas pelos pares "Car:/Driver:" das biografias do ELF).
Uso: python tools/export_ui.py
"""

from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent / "native"))

import ngp  # noqa: E402
import tex  # noqa: E402
from elf import Elf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "assets" / "ui"
RTX = ROOT / "source" / "game" / "globals" / "resident" / "resident.rtx"
UI = ROOT / "source" / "game" / "shell" / "ui" / "ui"
FONT_PAGES = {0x46E98: "font0.png", 0x46F20: "font1.png"}
GLYPHS = 0x2C7AE8

# Raízes do logo "TWISTED METAL / HEAD-ON" (categorias 0x2397, 0x2398, 0x2399 na tela de título).
LOGO_ROOTS = (0x11B20, 0x11E40, 0x11910)
# Ícones de seleção (objetos 0x6ec20.., um por veículo, na ordem da tabela de nomes 0x2b39f0). O 14º é o trailer
# do Cousin Eddy e o 15º o ATV (a tabela de nomes diz "ATV", "CousinEddy": a ordem dos dois diverge).
ICONS = {
    "axel": 0x3A7E8, "hearse": 0x3A864, "mrgrim": 0x3A8E0, "rkill": 0x3A95C, "sweet": 0x3A9D8, "thump": 0x3AA54,
    "spectre": 0x3AAD0, "twist": 0x3AB4C, "mrslam": 0x3ABC8, "cop": 0x3C590, "crim": 0x3C610, "hamr": 0x3C690,
    "grass": 0x3C710, "wart": 0x3C790, "edboss": 0x3C810, "edatv": 0x3C890, "dark1": 0x3C910, "dark2": 0x3C990,
    "hc_axel": 0x4BA10, "hc_derby": 0x4B334, "hc_hears": 0x4B4EC, "hc_grim": 0x4BCA4, "hc_preac": 0x4B874,
    "hc_rkill": 0x4BDFC, "hc_semi": 0x4BBE0, "hc_suv": 0x489D4, "hc_sweet": 0x4BEB8, "hc_taxi": 0x4C028,
    "hc_tow": 0x487C4, "hc_vette": 0x4C71C, "hc_rock": 0x4BC50, "hc_stock": 0x5033C, "hc_tank": 0x4BBF0,
}
# Cartões (textura, metade 0 = de cima / 1 = de baixo depois de desvirar), pelo piloto escrito no cartão.
CARDS = {
    "axel": (0x49904, 0), "hearse": (0x49904, 1), "mrgrim": (0x49990, 0), "rkill": (0x49990, 1),
    "sweet": (0x49A1C, 0), "thump": (0x49A1C, 1), "spectre": (0x49AA8, 0), "twist": (0x49AA8, 1),
    "mrslam": (0x49B34, 0), "cop": (0x49B34, 1), "crim": (0x49BC0, 0), "hamr": (0x49BC0, 1),
    "grass": (0x49C4C, 0), "wart": (0x49C4C, 1), "edboss": (0x49CD8, 0), "dark1": (0x49CD8, 1),
    "dark2": (0x49CD8, 1), "edatv": (0x49D64, 0),
}
# Miniaturas das arenas (mapa-múndi da seleção de fase, raiz 0x2db60). ⚠️ identificação visual: estádio,
# pirâmide com o jato, Torre Eiffel, templo grego, Coliseu, castelo; Tóquio = quarteirão com janelas acesas.
LEVEL_MINIS = {
    "arena": 0x61314, "egyptdm": 0x627F0, "parisdm": 0x6219C, "greecedm": 0x65894, "colisdm": 0x70684,
    "castledm": 0x854A4, "tokyodm": 0x8C8B8,
}
# Nomes das arenas no jogo (strings do ELF, tabela de fases).
LEVEL_NAMES = {
    "arena": 0x2E6240, "tokyodm": 0x2E6198, "parisdm": 0x2E6138, "egyptdm": 0x2E6150, "greecedm": 0x2E6180,
    "colisdm": 0x2E6168, "castledm": 0x2E61E0,
}
# Carro da biografia ("Car: X") -> modelo.
BIO_CARS = {
    "Roadkill": "rkill", "Shadow": "hearse", "Mr. Grimm": "mrgrim", "Sweet Tooth": "sweet", "Thumper": "thump",
    "Spectre": "spectre", "Twister": "twist", "Outlaw": "cop", "Grasshopper": "grass", "Warthog": "wart",
    "Axel": "axel", "Mr. Slam": "mrslam", "Crimson Fury": "crim", "Hammerhead": "hamr", "RV": "edboss",
    "ATV": "edatv", "Dark Tooth": "dark1", "Tower Tooth": "dark2",
}
BIO_CARS_HC = {
    "Roadkill": "hc_rkill", "Crazy 8": "hc_derby", "Mr. Grimm": "hc_grim", "Shadow": "hc_hears",
    "Brimstone": "hc_preac", "Axel": "hc_axel", "Darkside": "hc_semi", "Outlaw": "hc_suv", "Sweet Tooth": "hc_sweet",
    "YellowJacket": "hc_taxi", "Junkyard Dog": "hc_tow", "Spectre": "hc_vette", "Manslaughter": "hc_rock",
    "12-Pak": "hc_stock", "Warthog": "hc_tank",
}


def glyph_table(e: Elf) -> dict[str, list[int]]:
    o = e.off(GLYPHS)
    out: dict[str, list[int]] = {}
    last = -1
    for i in range(256):
        code, page, col, row, w, w2 = struct.unpack_from("<6i", e.data, o + 0x18 * i)
        if code <= last or not 0 < code < 256 or page:
            break
        out[str(code)] = [col, row, w, w2]
        last = code
    return out


def bios(e: Elf) -> dict[str, dict]:
    """Biografias (strings "Car: X\\nDriver: Y\\n----\\ntexto"): as 18 primeiras são Head-On, as demais Harbor City."""
    out: dict[str, dict] = {}
    for k, m in enumerate(re.finditer(rb"Car: ([^\n]*)\n((?:Driver: [^\n]*\n)+)-+\n?([^\0]*)\0", e.data)):
        car, drivers, text = (g.decode("latin-1") for g in m.groups())
        driver = " & ".join(line[len("Driver: "):] for line in drivers.strip().split("\n"))
        model = (BIO_CARS if k < 18 else BIO_CARS_HC).get(car)
        if model and model not in out:
            out[model] = {"car": car, "driver": driver, "bio": text.strip(), "address": f"{e.vaddr(m.start()):#x}"}
    return out


def _flip(t: tex.Texture) -> Image.Image:
    return Image.fromarray(t.rgba).transpose(Image.Transpose.FLIP_TOP_BOTTOM)


def logo(textures: dict[int, tex.Texture]) -> Image.Image:
    """Rasteriza as malhas do logo (quads no plano xz, a ~515 unidades da câmera) com mapeamento afim por triângulo."""
    data = UI.with_suffix(".ngp").read_bytes()
    ptr = UI.with_suffix(".ptr").read_bytes()
    meshes = {m.offset: m for m in ngp.find_meshes(data, ptr)}
    tris = []
    for root in LOGO_ROOTS:
        rep = ngp.scene(data, ptr, list(meshes.values()), root=root)
        for inst in rep.instances:
            m = meshes[inst.mesh]
            for slot in m.texture_slots():
                a, idx = m.triangles(slot)
                img = _flip(textures[m.textures[slot]])
                pos, uv = a["position"], a["uv"]
                for k in range(0, len(idx), 3):
                    i3 = idx[k:k + 3]
                    # perspectiva da câmera da UI: x/z escalados pela profundidade (y) relativa a 515,55
                    p = [(pos[i][0] * 515.55 / pos[i][1], -pos[i][2] * 515.55 / pos[i][1]) for i in i3]
                    t = [((uv[i][0] + 1) * img.width, -uv[i][1] * img.height) for i in i3]
                    tris.append((p, t, img))
    allp = np.array([q for p, _, _ in tris for q in p])
    lo, hi = allp.min(0), allp.max(0)
    scale = 2.0
    size = (int((hi[0] - lo[0]) * scale) + 2, int((hi[1] - lo[1]) * scale) + 2)
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    for p, t, img in tris:
        dst = [((x - lo[0]) * scale + 1, (y - lo[1]) * scale + 1) for x, y in p]
        # afim destino -> origem (PIL.Image.transform AFFINE)
        a_ = np.array([[x, y, 1] for x, y in dst])
        coef_u = np.linalg.solve(a_, np.array([q[0] for q in t]))
        coef_v = np.linalg.solve(a_, np.array([q[1] for q in t]))
        warped = img.transform(size, Image.Transform.AFFINE, (*coef_u, *coef_v), resample=Image.Resampling.BILINEAR)
        mask = Image.new("L", size, 0)
        ImageDraw.Draw(mask).polygon(dst, fill=255)
        layer = Image.new("RGBA", size, (0, 0, 0, 0))
        layer.paste(warped, (0, 0), mask)
        out.alpha_composite(layer)
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    e = Elf()
    pages = {t.id: t for t in tex.decode(RTX.read_bytes())}
    for tid, name in FONT_PAGES.items():
        _flip(pages[tid]).save(OUT / name, optimize=True)
    glyphs = glyph_table(e)
    (OUT / "font.json").write_text(json.dumps({
        "source": "resident.rtx (0x46e98, 0x46f20) + SCUS_976.21 0x2c7ae8",
        "cell": 32,
        "pages": list(FONT_PAGES.values()),
        # código -> [coluna, linha, largura/32, largura alternativa/32] (FUN_00223318)
        "glyphs": glyphs,
    }, indent=1), "utf-8")

    ui = {t.id: t for t in tex.decode(UI.with_suffix(".tex").read_bytes())}
    for sub in ("cars", "cards", "levels"):
        (OUT / sub).mkdir(exist_ok=True)
    logo(ui).save(OUT / "logo.png", optimize=True)
    for model, tid in ICONS.items():
        _flip(ui[tid]).save(OUT / "cars" / f"{model}.png", optimize=True)
    for model, (tid, half) in CARDS.items():
        img = _flip(ui[tid])
        img.crop((0, half * img.height // 2, img.width, (half + 1) * img.height // 2)).save(OUT / "cards" / f"{model}.png", optimize=True)
    for lvl, tid in LEVEL_MINIS.items():
        _flip(ui[tid]).save(OUT / "levels" / f"{lvl}.png", optimize=True)
    b = bios(e)
    (OUT / "menu.json").write_text(json.dumps({
        "source": "SHELL/UI.BDD + SCUS_976.21 (biografias)",
        "icons": {m: f"cars/{m}.png" for m in ICONS},
        "cards": {m: f"cards/{m}.png" for m in CARDS},
        "levels": {m: f"levels/{m}.png" for m in LEVEL_MINIS},
        "levelNames": {m: e.cstr(a) for m, a in LEVEL_NAMES.items()},
        "bios": b,
    }, indent=1, ensure_ascii=False), "utf-8")
    print(f"fonte: {len(glyphs)} glifos; menu: {len(ICONS)} ícones, {len(CARDS)} cartões, {len(LEVEL_MINIS)} arenas, {len(b)} biografias")
    return 0


if __name__ == "__main__":
    sys.exit(main())
