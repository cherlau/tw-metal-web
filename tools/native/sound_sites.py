"""Acha no SCUS_976.21 cada lugar que toca um som pelo nome (RE: docs/NATIVE.md "Som").

O jogo não guarda os nomes como strings: monta cada nome em registradores de 128 bits do R5900 com
ori/dsll/dsll32 e pcpyld (ex.: "D_CONCRETE_SM" em FUN_001a0db8) e chama a rotina de tocar (FUN_001a1660 e
irmãs). Este script decodifica só essas instruções (o capstone não conhece as MMI do R5900), palavra a palavra,
e em cada jal/jalr anota os nomes ASCII nos registradores de argumento (as instruções de 64 bits preservam os
64 bits altos do destino). Saída: JSON {endereço da chamada: {alvo, nomes, a2, a3}}.
Uso: python tools/native/sound_sites.py [saida.json]
"""

from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from elf import Elf  # noqa: E402

NAME = re.compile(rb"^[A-Z][A-Z0-9]?_[A-Z0-9_]+$|^[A-Z]{3,}[A-Z0-9_]*$")
MASK = (1 << 64) - 1
ARGS = (4, 5, 6, 7, 8, 9, 10, 11)  # a0..a3, t0..t3


def ascii_of(lo: int, hi: int) -> str | None:
    raw = (lo & MASK).to_bytes(8, "little") + (hi & MASK).to_bytes(8, "little")
    raw = raw.split(b"\0", 1)[0]
    if len(raw) < 3 or not NAME.match(raw):
        return None
    return raw.decode("ascii")


def scan(e: Elf) -> dict[str, dict]:
    seg = e.segments[0]
    d = e.data
    lo: dict[int, int] = {}  # registrador -> 64 bits baixos conhecidos
    hi: dict[int, int] = {}  # registrador -> 64 bits altos
    sites: dict[str, dict] = {}
    pending: tuple[int, int] | None = None
    stack: dict[int, tuple[int, int]] = {}  # deslocamento em sp -> (baixo, alto) gravados por sq/sd
    sp_ptr: dict[int, int] = {}  # registrador -> sp + deslocamento (addiu rX, sp, imm)
    stores: dict[str, dict] = {}  # nomes gravados em objetos (sq fora da pilha)

    def kill(r: int) -> None:
        lo.pop(r, None)
        hi.pop(r, None)

    for off in range(seg.offset, seg.offset + seg.filesz, 4):
        w, = struct.unpack_from("<I", d, off)
        va = seg.vaddr + off - seg.offset
        op, rs, rt, rd, sa, fn = w >> 26, (w >> 21) & 31, (w >> 16) & 31, (w >> 11) & 31, (w >> 6) & 31, w & 63
        imm = w & 0xFFFF
        call = None
        if op == 0x0D:  # ori
            if rs == 0 or rs in lo:
                lo[rt] = (lo.get(rs, 0) if rs else 0) | imm
            else:
                kill(rt)
        elif op == 0x0F:  # lui
            lo[rt] = (imm << 16) & 0xFFFFFFFF
        elif op in (0x09, 0x19) and rs == 29 and rt != 29:  # addiu rX, sp, imm: ponteiro para a pilha
            kill(rt)
            sp_ptr[rt] = imm - 0x10000 if imm & 0x8000 else imm
        elif op == 0x1F and rs == 29 and rt in lo:  # sq rX, off(sp)
            stack[imm] = (lo[rt], hi.get(rt, 0))
        elif op == 0x1F and rt in lo and (n := ascii_of(lo[rt], hi.get(rt, 0))):  # sq rX, off(obj): nome guardado
            stores[f"{va:#x}"] = {"name": n, "base": rs, "offset": imm}
        elif op == 0x3F and rs == 29 and rt in lo:  # sd rX, off(sp)
            stack[imm] = (lo[rt], stack.get(imm, (0, 0))[1])
        elif op in (0x09, 0x19):  # addiu / daddiu
            if rs == 0 or rs in lo:
                lo[rt] = ((lo.get(rs, 0) if rs else 0) + (imm - 0x10000 if imm & 0x8000 else imm)) & MASK
            else:
                kill(rt)
        elif op == 0 and fn in (0x38, 0x3C, 0x00) and rt in lo:  # dsll / dsll32 / sll
            lo[rd] = (lo[rt] << (sa + (32 if fn == 0x3C else 0))) & (0xFFFFFFFF if fn == 0 else MASK)
        elif op == 0 and fn in (0x25, 0x2D, 0x21) and (rs == 0 or rt == 0):  # or/daddu/addu com zero = move
            src = rt if rs == 0 else rs
            if src == 0:
                lo[rd] = 0
            elif src in lo:
                lo[rd] = lo[src]
                if src in hi:
                    hi[rd] = hi[src]
            else:
                kill(rd)
        elif op == 0x1C and fn == 0x09 and sa == 0x0E:  # pcpyld rd, rs, rt: rd.hi = rs.lo, rd.lo = rt.lo
            if (rs == 0 or rs in lo) and (rt == 0 or rt in lo):
                h = lo.get(rs, 0) if rs else 0
                lo[rd] = lo.get(rt, 0) if rt else 0
                hi[rd] = h
            else:
                kill(rd)
        elif op == 0x03:  # jal
            call = (seg.vaddr & 0xF0000000) | ((w & 0x3FFFFFF) << 2)
        elif op == 0 and fn == 0x09:  # jalr
            call = -1
        elif op == 0 and fn == 0x08:  # jr
            pending_after = True
        else:
            # destino genérico: R-type (SPECIAL/MMI) -> rd; I-type que escreve (loads, aritmética) -> rt
            if op in (0, 0x1C):
                kill(rd)
            elif op not in (0x01, 0x02, 0x04, 0x05, 0x06, 0x07, 0x14, 0x15, 0x16, 0x17, 0x28, 0x29, 0x2B, 0x3F, 0x1F,
                            0x39, 0x3D, 0x2C, 0x2D, 0x2E, 0x2A, 0x10, 0x11, 0x12):
                kill(rt)
        if pending is not None:  # slot de atraso executado
            addr, target = pending
            names = [n for r in ARGS if r in lo and (n := ascii_of(lo[r], hi.get(r, 0)))]
            for r in ARGS:  # ponteiro para um nome montado na pilha
                if r in sp_ptr and sp_ptr[r] in stack:
                    lo_hi = stack[sp_ptr[r]]
                    if sp_ptr[r] + 8 in stack and not lo_hi[1]:
                        lo_hi = (lo_hi[0], stack[sp_ptr[r] + 8][0])
                    if (n := ascii_of(*lo_hi)) and n not in names:
                        names.append(n)
            if names:
                sites[f"{addr:#x}"] = {"target": f"{target:#x}" if target >= 0 else "jalr", "names": names,
                                       "a2": lo.get(6), "a3": lo.get(7)}
            pending = None
            for r in (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 31):
                kill(r)
                sp_ptr.pop(r, None)
        if call is not None:
            pending = (va, call)
        if op == 0 and fn == 0x08:
            lo.clear()
            hi.clear()
            stack.clear()
            sp_ptr.clear()
    sites["stores"] = stores
    return sites


def main() -> int:
    sites = scan(Elf())
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("artifacts/native/sound_sites.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(sites, indent=1), "utf-8")
    names = sorted({n for k, s in sites.items() if k != "stores" for n in s["names"]} |
                   {s["name"] for s in sites["stores"].values()})
    print(f"{len(sites)} chamadas, {len(names)} nomes -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
