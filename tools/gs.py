"""Emulação mínima da memória local do GS (4 MB) para desfazer o swizzle de texturas.

Os jogos de PS2 costumam enviar texturas PSMT8/PSMT4 já "swizzled" como um retângulo PSMCT32
(mais rápido). Para recuperar a imagem linear basta repetir o que o hardware faz: escrever o
retângulo como PSMCT32 e ler os pixels como PSMT8/PSMT4.  SPEC §6.5.

Unidades: bp em blocos (256 bytes), bw em unidades de 64 pixels.
"""

from __future__ import annotations

import numpy as np

import gs_tables as T

MEM_BYTES = 4 << 20

_BT32 = np.array(T.BLOCK_TABLE_32)
_BT8 = np.array(T.BLOCK_TABLE_8)
_BT4 = np.array(T.BLOCK_TABLE_4)
_CT32 = np.array(T.COLUMN_TABLE_32)
_CT8 = np.array(T.COLUMN_TABLE_8)
_CT4 = np.array(T.COLUMN_TABLE_4)


def addr32(x: np.ndarray, y: np.ndarray, bp: int, bw: int) -> np.ndarray:
    """Endereço em words (32 bits) de um pixel PSMCT32. Página 64x32, bloco 8x8."""
    page = (y >> 5) * bw + (x >> 6)
    return (bp + page * 32 + _BT32[(y >> 3) & 3, (x >> 3) & 7]) * 64 + _CT32[y & 7, x & 7]


def addr8(x: np.ndarray, y: np.ndarray, bp: int, bw: int) -> np.ndarray:
    """Endereço em bytes de um pixel PSMT8. Página 128x64, bloco 16x16."""
    page = (y >> 6) * (bw >> 1) + (x >> 7)
    return (bp + page * 32 + _BT8[(y >> 4) & 3, (x >> 4) & 7]) * 256 + _CT8[y & 15, x & 15]


def addr4(x: np.ndarray, y: np.ndarray, bp: int, bw: int) -> np.ndarray:
    """Endereço em nibbles de um pixel PSMT4. Página 128x128, bloco 32x16."""
    page = (y >> 7) * (bw >> 1) + (x >> 7)
    return (bp + page * 32 + _BT4[(y >> 4) & 7, (x >> 5) & 3]) * 512 + _CT4[y & 15, x & 31]


class GSMemory:
    def __init__(self) -> None:
        self.words = np.zeros(MEM_BYTES // 4, dtype=np.uint32)

    def write_ct32(self, data: bytes, w: int, h: int, bp: int, bw: int) -> None:
        src = np.frombuffer(data, "<u4", count=w * h).reshape(h, w)
        y, x = np.mgrid[0:h, 0:w]
        self.words[addr32(x, y, bp, bw)] = src

    def read_t8(self, w: int, h: int, bp: int, bw: int) -> np.ndarray:
        y, x = np.mgrid[0:h, 0:w]
        return self.words.view(np.uint8)[addr8(x, y, bp, bw)]

    def read_t4(self, w: int, h: int, bp: int, bw: int) -> np.ndarray:
        y, x = np.mgrid[0:h, 0:w]
        n = addr4(x, y, bp, bw)
        b = self.words.view(np.uint8)[n >> 1]
        return np.where(n & 1, b >> 4, b & 15).astype(np.uint8)


def unswizzle(data: bytes, w: int, h: int, bpp: int) -> np.ndarray:
    """Imagem (h, w) de índices a partir de dados PSMT8/PSMT4 enviados como retângulo PSMCT32.

    PSMT8 WxH ocupa um retângulo PSMCT32 (W/2)x(H/2); PSMT4 WxH ocupa (W/2)x(H/4).
    """
    if bpp == 8:
        cw, ch = w // 2, h // 2
    elif bpp == 4:
        cw, ch = w // 2, h // 4
    else:
        raise ValueError(f"bpp {bpp} não suportado")
    if cw * ch * 4 != len(data):
        raise ValueError(f"{w}x{h}@{bpp}bpp espera {w * h * bpp // 8} bytes, recebeu {len(data)}")
    mem = GSMemory()
    mem.write_ct32(data, cw, ch, 0, max(1, cw // 64))
    tbw = max(1, w // 64)
    return mem.read_t8(w, h, 0, tbw) if bpp == 8 else mem.read_t4(w, h, 0, tbw)
