"""Leitura mínima do ELF do PS2 (SCUS_976.21): segmentos, endereço virtual <-> offset, strings e ponteiros."""

from __future__ import annotations

import re
import struct
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ELF_PATH = ROOT / "source" / "disc" / "scus_976.21"
ELF_SHA256 = "8619cb640b4b5263f072b8f2de9aa459a517b3e1e2f9fc732fb0856dde22a3c3"


@dataclass(frozen=True)
class Segment:
    vaddr: int
    offset: int
    filesz: int
    memsz: int
    flags: int  # 1=X, 2=W, 4=R


class Elf:
    def __init__(self, path: Path = ELF_PATH):
        self.data = path.read_bytes()
        d = self.data
        if d[:4] != b"\x7fELF" or d[4] != 1 or d[5] != 1:
            raise ValueError("não é ELF32 little-endian")
        self.entry = struct.unpack_from("<I", d, 0x18)[0]
        phoff, = struct.unpack_from("<I", d, 0x1C)
        phentsize, phnum = struct.unpack_from("<HH", d, 0x2A)
        self.segments: list[Segment] = []
        for i in range(phnum):
            p = phoff + i * phentsize
            ptype, off, vaddr, _paddr, filesz, memsz, flags = struct.unpack_from("<7I", d, p)
            if ptype == 1:  # PT_LOAD
                self.segments.append(Segment(vaddr, off, filesz, memsz, flags))

    @property
    def gp(self) -> int:
        """Valor de $gp (ri_gp_value da seção .reginfo, SHT_MIPS_REGINFO). SCUS_976.21: 0x2fa5f0."""
        d = self.data
        shoff, = struct.unpack_from("<I", d, 0x20)
        shentsize, shnum = struct.unpack_from("<HH", d, 0x2E)
        for i in range(shnum):
            sh = struct.unpack_from("<10I", d, shoff + i * shentsize)
            if sh[1] == 0x70000006:
                return struct.unpack_from("<I", d, sh[4] + 20)[0]
        raise ValueError("ELF sem .reginfo")

    def off(self, vaddr: int) -> int | None:
        for s in self.segments:
            if s.vaddr <= vaddr < s.vaddr + s.filesz:
                return s.offset + vaddr - s.vaddr
        return None

    def vaddr(self, off: int) -> int | None:
        for s in self.segments:
            if s.offset <= off < s.offset + s.filesz:
                return s.vaddr + off - s.offset
        return None

    def u32(self, vaddr: int) -> int:
        return struct.unpack_from("<I", self.data, self.off(vaddr))[0]

    def f32(self, vaddr: int) -> float:
        return struct.unpack_from("<f", self.data, self.off(vaddr))[0]

    def cstr(self, vaddr: int, limit: int = 256) -> str | None:
        o = self.off(vaddr)
        if o is None:
            return None
        end = self.data.find(b"\0", o, o + limit)
        if end < 0:
            return None
        raw = self.data[o:end]
        return raw.decode("latin-1") if all(32 <= c < 127 or c in (9, 10) for c in raw) else None

    def find_strings(self, pattern: str) -> list[tuple[int, str]]:
        """(vaddr, texto) de strings C que casam a regex (bytes ASCII imprimíveis terminados em NUL)."""
        out = []
        for m in re.finditer(rb"[\x20-\x7e]{3,}\x00", self.data):
            s = m.group()[:-1].decode("latin-1")
            if re.search(pattern, s):
                v = self.vaddr(m.start())
                if v is not None:
                    out.append((v, s))
        return out

    def pointers_to(self, target: int) -> list[int]:
        """vaddrs (alinhados a 4) cujo word é igual a target."""
        needle = struct.pack("<I", target)
        out = []
        start = 0
        while True:
            i = self.data.find(needle, start)
            if i < 0:
                return out
            if i % 4 == 0:
                v = self.vaddr(i)
                if v is not None:
                    out.append(v)
            start = i + 1
