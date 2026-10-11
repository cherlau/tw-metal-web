"""Exporta regras recuperadas do SCUS_976.21 para public/assets/rules/*.json.

Cada valor leva o endereço de origem (SPEC §8.5). Ver docs/NATIVE.md.
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from elf import ELF_SHA256, Elf  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "assets" / "rules"

# Tabela de física dos veículos: lida por FUN_00140d60 (cria o corpo rígido) com índice id*0x150 e
# base 0x2ba990; o nome (char[32]) fica em base-0x20.
VEHICLE_TABLE = 0x2BA990
VEHICLE_STRIDE = 0x150
VEHICLE_COUNT = 36
# id do carro (FUN_001409e8) -> modelo em public/assets/cars. 🟡 = inferido pelo nome, não pelo código.
VEHICLE_ASSETS = [
    "axel", "hearse", "mrgrim", "rkill", "sweet", "thump", "spectre", "twist", "mrslam", "cop",
    "crim", "hamr", "grass", "wart", "edatv", "edboss", "dark1", "dark2", "edplayer", "darkpla1",
    "darkpla2", "hc_axel", "hc_derby", "hc_hears", "hc_grim", "hc_preac", "hc_rkill", "hc_semi",
    "hc_suv", "hc_sweet", "hc_taxi", "hc_tow", "hc_vette", "hc_rock", "hc_stock", "hc_tank",
]


def vec(e: Elf, a: int) -> list[float]:
    return [round(e.f32(a + 4 * k), 4) for k in range(3)]


def vehicles(e: Elf) -> dict:
    out = {}
    for i, asset in enumerate(VEHICLE_ASSETS):
        base = VEHICLE_TABLE + i * VEHICLE_STRIDE
        out[asset] = {
            "id": i,
            "name": e.cstr(base - 0x20),
            "address": f"{base:#x}",
            # base+0x00..0x2f: 12 floats; [0..2] = escalas? (1.8, 1.0, 2.0), [7] = raio? (Axel 12, Grimm 6, Eddy 32)
            "params": [round(e.f32(base + 4 * k), 4) for k in range(12)],
            # base+0x30: copiado para o corpo +0x40 (🟡 centro/offset); base+0x40 -> corpo +0x38
            "offset": vec(e, base + 0x10),
            # base+0x30..0x6f: 4 pontos de roda; base+0x70..0xaf: 4 pontos do corpo (coords do PS2, frente = +Y)
            "wheels": [vec(e, base + 0x30 + 16 * k) for k in range(4)],
            "body": [vec(e, base + 0x70 + 16 * k) for k in range(4)],
        }
    return out


def main() -> None:
    e = Elf()
    if hashlib.sha256(e.data).hexdigest() != ELF_SHA256:
        raise SystemExit("ELF com hash diferente: endereços não valem")
    OUT.mkdir(parents=True, exist_ok=True)
    doc = {
        "elf": "SCUS_976.21",
        "sha256": ELF_SHA256,
        "source": "FUN_00140d60 lê a tabela em 0x2ba990 (id*0x150); ver docs/NATIVE.md",
        "coords": "ps2",
        "vehicles": vehicles(e),
    }
    (OUT / "vehicles.json").write_text(json.dumps(doc, indent=1), "utf-8")
    print(f"{len(doc['vehicles'])} veículos -> {OUT / 'vehicles.json'}")


if __name__ == "__main__":
    main()
