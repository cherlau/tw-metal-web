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


# Direção (FUN_0012ece0 copia o registro de 0x34 bytes para o controlador em carro+0x340 → carro+0x848..+0x878):
# massa, arfagem/rolagem visuais (graus, FUN_0012f2c8), giro (rad/quadro, FUN_00132aa8), vel. máx. (mph,
# FUN_00133650), aceleração/rolagem/freio (fração da vel. máx. por quadro), dois coeficientes 🟡, dano de batida
# (FUN_001349f0), impulso de pulo 🟡 (FUN_001306b8) e alinhamento da velocidade à frente por quadro (FUN_00133078).
DRIVE_TABLE = 0x2B8AB0
DRIVE_STRIDE = 0x34
DRIVE_FIELDS = [
    ("mass", "f"), ("pitchDeg", "f"), ("rollDeg", "f"), ("turn", "f"), ("maxMph", "f"), ("accel", "f"),
    ("coast", "f"), ("brake", "f"), ("w20", "f"), ("w24", "f"), ("ramDamage", "f"), ("jump", "f"), ("grip", "f"),
]


def drive(e: Elf, i: int) -> dict:
    base = DRIVE_TABLE + i * DRIVE_STRIDE
    raw = e.data[e.off(base):][:DRIVE_STRIDE]
    ints = struct.unpack("<13i", raw)
    fl = struct.unpack("<13f", raw)
    return {"address": f"{base:#x}",
            **{name: (ints[k] if kind == "i" else round(fl[k], 5)) for k, (name, kind) in enumerate(DRIVE_FIELDS)}}


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
            "drive": drive(e, i),
        }
    return out


# IA (docs/NATIVE.md "IA dos bots"): perfil por veículo em 0x2b2d10 + i·0x40 (FUN_00102300, i = carro+0x14 =
# índice da tabela de nomes 0x2b39f0), uso desejado de cada tipo de arma de frente (0x2b1d20 + i·0x3c,
# FUN_001098b0) e de ré (0x2b2518 + i·0x3c, FUN_00109920), alcance máx./mín./alinhamento por tipo
# (0x2b35d0/0x2b3610/0x2b3650, FUN_0010ba08).
AI_PROFILES = 0x2B2D10
AI_FRONT = 0x2B1D20
AI_REAR = 0x2B2518
AI_RANGE = (0x2B35D0, 0x2B3610, 0x2B3650)
AI_COUNT = 34
# Campos do perfil: i = inteiro (quadros), f = float. Nomes pelo uso no código (🟡 = papel inferido).
AI_FIELDS = [
    ("w00", "i"), ("fleeHealth", "f"), ("fireCone", "f"), ("switchFrames", "i"), ("waitFrames", "i"),
    ("losHeight", "f"), ("timerA", "i"), ("timerB", "i"), ("aggression", "f"), ("w24", "f"), ("w28", "f"),
    ("w2c", "i"), ("retreatHealth", "f"), ("w34", "i"), ("w38", "i"), ("timerC", "i"),
]


def ai(e: Elf) -> dict:
    def floats(a: int, n: int) -> list[float]:
        return [round(v, 4) for v in struct.unpack_from(f"<{n}f", e.data, e.off(a))]

    profiles = []
    for i in range(AI_COUNT):
        raw = e.data[e.off(AI_PROFILES + 0x40 * i):][:0x40]
        ints = struct.unpack("<16i", raw)
        fl = struct.unpack("<16f", raw)
        profiles.append({name: (ints[k] if kind == "i" else round(fl[k], 4)) for k, (name, kind) in enumerate(AI_FIELDS)})
    return {
        "profiles": profiles,
        "front": [floats(AI_FRONT + 0x3C * i, 15) for i in range(AI_COUNT)],
        "rear": [floats(AI_REAR + 0x3C * i, 15) for i in range(AI_COUNT)],
        "range": {"max": floats(AI_RANGE[0], 16), "min": floats(AI_RANGE[1], 16), "dot": floats(AI_RANGE[2], 16)},
    }


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
    ai_doc = {"elf": "SCUS_976.21", "sha256": ELF_SHA256,
              "source": "perfis 0x2b2d10, armas 0x2b1d20/0x2b2518, alcances 0x2b35d0; ver docs/NATIVE.md", **ai(e)}
    (OUT / "ai.json").write_text(json.dumps(ai_doc, indent=1), "utf-8")
    print(f"{len(ai_doc['profiles'])} perfis de IA -> {OUT / 'ai.json'}")


if __name__ == "__main__":
    main()
