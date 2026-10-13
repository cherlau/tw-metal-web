"""Gera src/game/weapon-tables.ts com as tabelas de armas do SCUS_976.21 (ver docs/NATIVE.md "Armas").

- Projéteis: 57 tipos × 0x94 bytes em 0x37cbf0 + 0xB930 (BSS). O jogo monta a tabela em runtime em
  FUN_001fd4e0 (padrões em FUN_001fd3f8); aqui a função é emulada (tools/native/mips.py) duas vezes, com a
  flag de modo DAT_002f4b14 = 0 (Head-On) e = 1 (Harbor City).
- Renascimento dos pickups: 0x2c3a70 + tipo·0x18, 6 colunas (FUN_001bcc20); máximo = mín·3/2.

Uso: python tools/native/export_weapons.py
"""

from __future__ import annotations

import hashlib
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from elf import ELF_SHA256, Elf  # noqa: E402
from mips import Cpu  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "src" / "game" / "weapon-tables.ts"

MANAGER = 0x37CBF0  # gerente de projéteis (FUN_00203b10 recebe esse ponteiro)
TABLE = MANAGER + 0xB930
STRIDE = 0x94
COUNT = 57  # FUN_00203b10: tipo < 0x39
MODE_FLAG = 0x2F4B14  # 0 = Head-On, 1 = Harbor City (FUN_001fca10)
INIT = 0x1FD4E0
MEMSET = 0x28AAF0  # 1ª chamada depois da tabela (zera os slots): para a emulação aí

# (offset, nome, tipo) — semântica em docs/NATIVE.md "Armas".
FIELDS: list[tuple[int, str, str]] = [
    (0x00, "damage", "f"),  # dano do golpe (instância +0x1c; FUN_00200e28 / FUN_00202d08)
    (0x04, "blastRadius", "f"),  # raio da explosão em pés (FUN_00202d08); 0 = sem área
    (0x08, "lifetime", "i"),  # segundos (×60 tiques em FUN_00203c68)
    (0x0C, "speedMph", "f"),  # velocidade alvo em mph (×0,024444 pés/tique em FUN_001ffc98)
    (0x10, "accel", "f"),  # fração por tique rumo à velocidade alvo
    (0x14, "groundFollow", "i"),  # mantém ≥ 5 pés do chão e afunda até ele (FUN_001ffff8)
    (0x18, "homing", "i"),  # 0 reto, 1 persegue, 2 persegue com antecipação (FUN_001ff0a8)
    (0x1C, "turn", "f"),  # fração do ângulo por tique (FUN_002537e8 em FUN_001ff5a0/FUN_001ff800)
    (0x20, "lead", "f"),  # peso da antecipação no modo 2 (FUN_001ff298)
    (0x24, "lockYaw", "f"),  # graus: fora disso perde a trava (sem oscilação)
    (0x28, "lockPitch", "f"),
    (0x2C, "turnLimit", "i"),  # limita o passo de giro (FUN_001ff5a0)
    (0x30, "turnNear", "f"),  # distância (pés) abaixo da qual usa turnMaxNear
    (0x34, "turnMaxFar", "f"),
    (0x38, "turnMaxNear", "f"),
    (0x3C, "wobble", "i"),  # oscilação do Swarmer (FUN_001ffa18)
    (0x40, "wobbleYaw", "f"),  # graus
    (0x44, "wobblePitch", "f"),
    (0x48, "wobbleFirst", "i"),  # tiques até a 1ª troca
    (0x4C, "wobbleMin", "i"),  # intervalo sorteado entre trocas (tiques)
    (0x50, "wobbleMax", "i"),
    (0x54, "ownFrame", "i"),  # orientação própria separada do modelo
    (0x58, "spin", "f"),  # instância +0x84 (rotação do modelo)
    (0x5C, "light", "i"),  # luz dinâmica (FUN_0024c350)
    (0x60, "lightR", "f"),
    (0x64, "lightG", "f"),
    (0x68, "lightB", "f"),
    (0x6C, "emitter", "i"),  # partículas presas ao projétil (FUN_00247580); −1 = nenhuma
    (0x70, "trail", "i"),  # rastro (FUN_00247580); −1 = nenhum
    (0x74, "explosion", "i4"),  # efeitos da detonação (FUN_002470c0), −1 encerra a lista
    (0x84, "explosionScale", "f4"),
]


def build(e: Elf, mode: int) -> list[dict]:
    cpu = Cpu(e)
    cpu.store(MODE_FLAG, mode)
    cpu.r[4] = MANAGER
    cpu.hooks[MEMSET] = lambda c: True
    cpu.run(INIT)

    def word(a: int, kind: str):
        v = cpu.load(a)
        if kind == "f":
            return round(struct.unpack("<f", struct.pack("<I", v))[0], 6)
        return v - (1 << 32) if v & 0x80000000 else v

    out = []
    for t in range(COUNT):
        base = TABLE + t * STRIDE
        rec: dict = {}
        for off, name, kind in FIELDS:
            if kind in ("i4", "f4"):
                rec[name] = [word(base + off + 4 * k, kind[0]) for k in range(4)]
            else:
                rec[name] = word(base + off, kind)
        out.append(rec)
    return out


def respawn(e: Elf) -> list[list[int]]:
    return [[e.u32(0x2C3A70 + i * 0x18 + 4 * c) for c in range(6)] for i in range(20)]


def ts_value(v) -> str:
    if isinstance(v, list):
        return "[" + ", ".join(ts_value(x) for x in v) + "]"
    if isinstance(v, float):
        return repr(v).rstrip("0").rstrip(".") if "." in repr(v) else repr(v)
    return str(v)


def main() -> None:
    e = Elf()
    if hashlib.sha256(e.data).hexdigest() != ELF_SHA256:
        raise SystemExit("ELF com hash diferente: endereços não valem")
    ho, hc = build(e, 0), build(e, 1)
    names = [n for _, n, _ in FIELDS]

    def table(recs: list[dict]) -> str:
        rows = [f"  [{', '.join(ts_value(r[n]) for n in names)}], // {i}" for i, r in enumerate(recs)]
        return "[\n" + "\n".join(rows) + "\n]"

    lines = [
        "// GERADO por tools/native/export_weapons.py — não editar à mão.",
        f"// SCUS_976.21 (SHA-256 {ELF_SHA256[:16]}…): tabela de projéteis 0x37cbf0+0xB930 montada por FUN_001fd4e0",
        "// (emulado com DAT_002f4b14 = 0 Head-On / 1 Harbor City) e renascimento dos pickups 0x2c3a70 (FUN_001bcc20).",
        "",
        f"export const PROJECTILE_FIELDS = [{', '.join(repr(n) for n in names)}] as const;",
        "",
        f"export const PROJECTILES_HO: (number | number[])[][] = {table(ho)};",
        "",
        f"export const PROJECTILES_HC: (number | number[])[][] = {table(hc)};",
        "",
        "/** Segundos mínimos até o pickup voltar, por tipo (linha) e coluna: [HO 1P, HO 2P a, HO 2P b, HC 1P, HC 2P a, HC 2P b]. */",
        f"export const PICKUP_RESPAWN: number[][] = {ts_value(respawn(e))};",
        "",
    ]
    OUT.write_text("\n".join(lines), "utf-8")
    print(f"{len(ho)} projéteis (HO/HC) -> {OUT}")


if __name__ == "__main__":
    main()
