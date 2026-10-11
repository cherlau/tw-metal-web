"""Walker de VIFcodes do PS2 (VIF1) e de cadeias DMA.  SPEC §6.2.

Reaproveitável: só conhece o formato do hardware, não o microcode do jogo.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

import numpy as np

# VIFcodes sem payload aceitos. Desconhecido -> erro (fail-fast).
_NO_PAYLOAD = {0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x10, 0x11, 0x13, 0x14, 0x15, 0x17}

DMA_IDS = {0: "refe", 1: "cnt", 2: "next", 3: "ref", 4: "refs", 5: "call", 6: "ret", 7: "end"}


class VifError(ValueError):
    pass


@dataclass
class Unpack:
    offset: int  # offset do VIFcode no buffer
    vn: int  # componentes 1..4
    vl: int  # bits por componente: 32, 16, 8, 5
    count: int
    addr: int  # endereço VU (qwords), sem o bit FLG
    usn: bool  # unsigned
    flg: bool  # endereço relativo a TOPS
    masked: bool
    data: bytes
    # Estado do VIF no momento do UNPACK
    mode: int = 0  # STMOD: 0 normal, 1 offset, 2 difference
    row: tuple[int, int, int, int] = (0, 0, 0, 0)
    cycle: tuple[int, int] = (1, 1)  # (CL, WL)

    def values(self) -> np.ndarray:
        """Componentes como inteiros/float SEM aplicar ROW/máscara. Formato (count, vn)."""
        if self.vl == 5:
            raw = np.frombuffer(self.data, "<u2", count=self.count)
            out = np.stack([(raw >> s) & m for s, m in ((0, 31), (5, 31), (10, 31), (15, 1))], axis=1)
            return out.astype(np.int64)
        if self.vl == 32:
            return np.frombuffer(self.data, "<u4", count=self.count * self.vn).reshape(-1, self.vn).copy()
        dt = {16: ("<u2", "<i2"), 8: ("u1", "i1")}[self.vl][0 if self.usn else 1]
        return np.frombuffer(self.data, dt, count=self.count * self.vn).reshape(-1, self.vn).astype(np.int64)

    def floats(self) -> np.ndarray:
        if self.vl != 32:
            raise VifError("floats() só vale para componentes de 32 bits")
        return np.frombuffer(self.data, "<f4", count=self.count * self.vn).reshape(-1, self.vn).copy()

    def ints_with_row(self) -> np.ndarray:
        """Inteiros de 32 bits como a VU recebe em modo offset (STMOD=1): valor + ROW."""
        v = self.values().astype(np.int64)
        if self.mode == 1:
            v = v + np.array(self.row[: self.vn], dtype=np.int64)
        elif self.mode == 2:
            raise VifError("STMOD difference não suportado")
        return ((v + 2**31) % 2**32 - 2**31).astype(np.int64)


@dataclass
class Packet:
    """Uma sequência de VIFcodes executada até MSCAL/MSCNT (= um lote para a VU)."""

    unpacks: list[Unpack] = field(default_factory=list)
    directs: list[bytes] = field(default_factory=list)
    kick: str | None = None
    kick_addr: int | None = None


def unpack_size(cmd: int, num: int) -> tuple[int, int, int, int]:
    vn = ((cmd >> 2) & 3) + 1
    vl = (32, 16, 8, 5)[cmd & 3]
    count = num or 256
    if vl == 5 and vn != 4:
        raise VifError(f"UNPACK V{vn}-5 inválido")
    size = (count * vn * vl + 7) // 8 if vl != 5 else count * 2
    return vn, vl, count, (size + 3) & ~3


def walk(buf: bytes, start: int, end: int) -> list[Packet]:
    """Executa os VIFcodes em buf[start:end] e agrupa em pacotes (um por MSCAL/MSCNT)."""
    packets: list[Packet] = []
    cur = Packet()
    mode = 0
    row = (0, 0, 0, 0)
    cycle = (1, 1)
    p = start
    while p < end:
        if p + 4 > end:
            raise VifError(f"VIFcode truncado em 0x{p:x}")
        code = struct.unpack_from("<I", buf, p)[0]
        cmd = (code >> 24) & 0x7F
        num = (code >> 16) & 0xFF
        imm = code & 0xFFFF
        p += 4
        if cmd >= 0x60:
            vn, vl, count, size = unpack_size(cmd, num)
            if p + size > end:
                raise VifError(f"UNPACK em 0x{p - 4:x} ultrapassa o fim (0x{end:x})")
            cur.unpacks.append(
                Unpack(p - 4, vn, vl, count, imm & 0x3FF, bool(imm & 0x4000), bool(imm & 0x8000),
                       bool(cmd & 0x10), bytes(buf[p : p + size]), mode, row, cycle)
            )
            p += size
        elif cmd == 0x01:
            cycle = (imm & 0xFF, (imm >> 8) & 0xFF)
        elif cmd == 0x05:
            mode = imm & 3
        elif cmd == 0x20:
            p += 4
        elif cmd == 0x30:
            row = struct.unpack_from("<4I", buf, p)
            p += 16
        elif cmd == 0x31:
            p += 16
        elif cmd in (0x50, 0x51):
            n = (imm or 65536) * 16
            cur.directs.append(bytes(buf[p : p + n]))
            p += n
        elif cmd == 0x4A:
            p += (num or 256) * 8
        elif cmd in (0x14, 0x15, 0x17):
            cur.kick = {0x14: "MSCAL", 0x15: "MSCALF", 0x17: "MSCNT"}[cmd]
            cur.kick_addr = imm if cmd != 0x17 else None
            packets.append(cur)
            cur = Packet()
        elif cmd in _NO_PAYLOAD:
            pass
        else:
            raise VifError(f"VIFcode desconhecido 0x{cmd:02x} em 0x{p - 4:x}")
    if cur.unpacks or cur.directs:
        packets.append(cur)
    return packets


@dataclass
class DmaTag:
    offset: int
    qwc: int
    id: int
    addr: int

    @property
    def name(self) -> str:
        return DMA_IDS[self.id]


def read_tag(buf: bytes, p: int) -> DmaTag:
    lo, addr = struct.unpack_from("<II", buf, p)
    return DmaTag(p, lo & 0xFFFF, (lo >> 28) & 7, addr)


def walk_chain(buf: bytes, p: int, limit: int = 10000) -> tuple[list[Packet], int]:
    """Segue uma cadeia DMA local (cnt ... ret/end) com TTE: os 8 bytes altos do tag são VIFcodes.

    Retorna (pacotes, offset logo após o fim da cadeia).
    """
    packets: list[Packet] = []
    for _ in range(limit):
        tag = read_tag(buf, p)
        if tag.id not in (1, 6, 7):
            raise VifError(f"DMA tag {tag.name} não suportado em 0x{p:x}")
        end = p + 16 + tag.qwc * 16
        if end > len(buf):
            raise VifError(f"DMA tag em 0x{p:x} ultrapassa o buffer")
        packets += walk(buf, p + 8, end)
        p = end
        if tag.id in (6, 7):
            return packets, p
    raise VifError("cadeia DMA longa demais")
