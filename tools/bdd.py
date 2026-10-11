"""Contêiner .BDD do Twisted Metal: Head-On (PS2). Ver docs/RECON.md §4.1.

Diretório no início do arquivo, entradas de 44 bytes:
  0x00 char[20] nome | 0x14 char[8] tipo | 0x1C u32 offset | 0x20 u32 size | 0x24 u64 FILETIME
Termina com nome vazio ou ao alcançar o offset do primeiro dado.
"""

from __future__ import annotations

import datetime as dt
import struct
from dataclasses import dataclass

ENTRY = struct.Struct("<20s8sIIQ")
assert ENTRY.size == 44

_FILETIME_EPOCH = dt.datetime(1601, 1, 1, tzinfo=dt.timezone.utc)


class BddFormatError(ValueError):
    pass


@dataclass(frozen=True)
class BddEntry:
    name: str
    type: str
    offset: int
    size: int
    filetime: int

    @property
    def filename(self) -> str:
        return f"{self.name}.{self.type}"

    @property
    def timestamp(self) -> str:
        return (_FILETIME_EPOCH + dt.timedelta(microseconds=self.filetime // 10)).isoformat()


def _cstr(raw: bytes, field: str) -> str:
    text, _, rest = raw.partition(b"\0")
    if any(rest):
        raise BddFormatError(f"lixo após NUL no campo {field}: {raw!r}")
    try:
        return text.decode("ascii")
    except UnicodeDecodeError as exc:
        raise BddFormatError(f"campo {field} não-ASCII: {raw!r}") from exc


def parse(data: bytes) -> list[BddEntry]:
    entries: list[BddEntry] = []
    dir_end = len(data)
    p = 0
    while p + ENTRY.size <= dir_end:
        raw_name, raw_type, offset, size, filetime = ENTRY.unpack_from(data, p)
        name = _cstr(raw_name, "nome")
        if not name:
            break
        typ = _cstr(raw_type, "tipo")
        if not typ:
            raise BddFormatError(f"entrada {name!r} sem tipo")
        if offset + size > len(data):
            raise BddFormatError(f"{name}.{typ}: 0x{offset:x}+{size} fora do arquivo ({len(data)})")
        entries.append(BddEntry(name, typ, offset, size, filetime))
        dir_end = min(dir_end, offset)
        p += ENTRY.size
    if not entries:
        raise BddFormatError("BDD sem entradas")
    if p > dir_end:
        raise BddFormatError("diretório sobrepõe a área de dados")

    ordered = sorted(entries, key=lambda e: e.offset)
    for a, b in zip(ordered, ordered[1:]):
        if a.offset + a.size > b.offset:
            raise BddFormatError(f"seções sobrepostas: {a.filename} e {b.filename}")
    names = [e.filename.lower() for e in entries]
    if len(set(names)) != len(names):
        raise BddFormatError(f"nomes de seção duplicados: {names}")
    return entries


def section(data: bytes, entry: BddEntry) -> bytes:
    return data[entry.offset : entry.offset + entry.size]
