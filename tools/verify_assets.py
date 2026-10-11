"""Verifica a integridade de public/assets (útil depois de travamentos/interrupções).

Para cada modelo: o .json abre, o .bin existe e cobre todos os spans, índices < nº de vértices,
toda textura referenciada existe e é um PNG válido; index.json bate com os arquivos.
Uso: python tools/verify_assets.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / "public" / "assets"


def check_model(path: Path, checked_png: set[str]) -> list[str]:
    errs: list[str] = []
    try:
        doc = json.loads(path.read_text("utf-8"))
    except Exception as exc:  # JSON truncado/corrompido
        return [f"{path.name}: JSON inválido ({exc})"]
    binp = path.with_suffix(".bin")
    if not binp.exists():
        return [f"{path.name}: .bin ausente"]
    bin_size = binp.stat().st_size
    data = binp.read_bytes()
    for key, m in doc["meshes"].items():
        for part in m.get("parts", []):
            a = part["attributes"]
            for name, (off, count) in a.items():
                end = off + count * 4
                if end > bin_size:
                    errs.append(f"{path.name}:{key}:{name} fora do .bin ({end} > {bin_size})")
            if not errs:
                nverts = a["position"][1] // 3
                idx = np.frombuffer(data, "<u4", a["indices"][1], a["indices"][0])
                if len(idx) and idx.max() >= nverts:
                    errs.append(f"{path.name}:{key}: índice {idx.max()} >= {nverts} vértices")
        if m.get("parts"):
            for part in m["parts"]:
                if part["texture"] and part["texture"] not in doc["textures"]:
                    errs.append(f"{path.name}:{key}: textura {part['texture']} sem entrada")
    for tid, t in doc["textures"].items():
        url = t["url"]
        if url in checked_png:
            continue
        png = ASSETS / url
        try:
            with Image.open(png) as im:
                im.verify()
            with Image.open(png) as im:
                if im.size != (t["width"], t["height"]):
                    errs.append(f"{url}: tamanho {im.size} != {t['width']}x{t['height']}")
                im.load()
            checked_png.add(url)
        except Exception as exc:
            errs.append(f"{path.name}: textura {tid} ({url}) inválida: {exc}")
    for inst in doc.get("scene", []):
        if inst["mesh"] not in doc["meshes"]:
            errs.append(f"{path.name}: instância de malha inexistente {inst['mesh']}")
    return errs


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    errs: list[str] = []
    checked_png: set[str] = set()
    counts = {}
    for folder in ("cars", "aicars", "lvl"):
        files = sorted((ASSETS / folder).glob("*.json"))
        counts[folder] = len(files)
        for f in files:
            errs += check_model(f, checked_png)
    try:
        index = json.loads((ASSETS / "index.json").read_text("utf-8"))
        for folder, names in index.items():
            have = sorted(p.stem for p in (ASSETS / folder).glob("*.json"))
            if names != have:
                errs.append(f"index.json desatualizado em {folder}")
    except Exception as exc:
        errs.append(f"index.json inválido: {exc}")
    print(f"modelos: {counts} · PNGs verificados: {len(checked_png)}")
    for e in errs[:50]:
        print("ERRO", e)
    print("OK" if not errs else f"{len(errs)} erro(s)")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
