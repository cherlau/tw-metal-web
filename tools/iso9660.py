"""Leitor ISO9660 mínimo, somente leitura, em Python puro.

Lê o Primary Volume Descriptor e percorre a árvore de diretórios. Não usa Joliet/Rock Ridge:
o disco do TM:HO usa nomes 8.3 em maiúsculas com sufixo ';1'.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import BinaryIO, Iterator

SECTOR = 2048
PVD_SECTOR = 16


class IsoFormatError(ValueError):
    pass


@dataclass(frozen=True)
class IsoFile:
    path: str  # caminho original, com '/' e sem ';1' (caixa preservada)
    lba: int
    size: int

    @property
    def offset(self) -> int:
        return self.lba * SECTOR


def _read(f: BinaryIO, offset: int, size: int) -> bytes:
    f.seek(offset)
    data = f.read(size)
    if len(data) != size:
        raise IsoFormatError(f"leitura curta em 0x{offset:x} (+{size})")
    return data


def _records(block: bytes) -> Iterator[tuple[int, int, int, str]]:
    """Itera registros de diretório: (lba, size, flags, name)."""
    p = 0
    while p < len(block):
        length = block[p]
        if length == 0:
            # Registros não cruzam setor: pula para o próximo setor.
            p = (p // SECTOR + 1) * SECTOR
            continue
        if length < 34 or p + length > len(block):
            raise IsoFormatError(f"registro de diretório inválido em +0x{p:x}")
        rec = block[p : p + length]
        lba = struct.unpack_from("<I", rec, 2)[0]
        size = struct.unpack_from("<I", rec, 10)[0]
        flags = rec[25]
        if flags & 0x80:
            raise IsoFormatError("arquivo multi-extent não suportado")
        name_len = rec[32]
        name = rec[33 : 33 + name_len].decode("ascii")
        yield lba, size, flags, name
        p += length


def walk(f: BinaryIO) -> list[IsoFile]:
    pvd = _read(f, PVD_SECTOR * SECTOR, SECTOR)
    if pvd[0] != 1 or pvd[1:6] != b"CD001":
        raise IsoFormatError("Primary Volume Descriptor não encontrado")
    block_size = struct.unpack_from("<H", pvd, 128)[0]
    if block_size != SECTOR:
        raise IsoFormatError(f"logical block size inesperado: {block_size}")
    volume_blocks = struct.unpack_from("<I", pvd, 80)[0]
    root = pvd[156 : 156 + 34]
    root_lba = struct.unpack_from("<I", root, 2)[0]
    root_size = struct.unpack_from("<I", root, 10)[0]

    files: list[IsoFile] = []
    seen_dirs: set[int] = set()

    def visit(lba: int, size: int, prefix: str) -> None:
        if lba in seen_dirs:
            raise IsoFormatError(f"ciclo de diretório em LBA {lba}")
        seen_dirs.add(lba)
        for rlba, rsize, flags, name in _records(_read(f, lba * SECTOR, size)):
            if name in ("\x00", "\x01"):
                continue  # '.' e '..'
            if (rlba + (rsize + SECTOR - 1) // SECTOR) > volume_blocks:
                raise IsoFormatError(f"{prefix}{name} ultrapassa o volume")
            if flags & 0x02:
                visit(rlba, rsize, f"{prefix}{name}/")
            else:
                clean = name.split(";", 1)[0].rstrip(".")
                files.append(IsoFile(f"{prefix}{clean}", rlba, rsize))

    visit(root_lba, root_size, "")
    return files


def read_file(f: BinaryIO, entry: IsoFile) -> bytes:
    return _read(f, entry.offset, entry.size)
