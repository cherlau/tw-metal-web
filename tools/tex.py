"""Decoder do .tex do Twisted Metal: Head-On (PS2). Ver docs/FORMATS.md.

Seção = cabeçalho (u32 n, u32 0xF, n pares; ≥ 0x40 bytes, alinhado a 16) + entradas alinhadas a 16 bytes:
  +0x00 u32 (tamanho em KB << 8) | 0x20      +0x04 u32 id (0 para CLUT)
  +0x0C u32 formato: nibbles 8..11 = log2(largura) e 12..15 = log2(altura) do retângulo PSMCT32
  +0x10 DMA tag RET (QWC) + VIF DIRECT        +0x20 6 qwords de registradores GS (zerados)
  +0x80 pixels "swizzled" (PSMT8/PSMT4 escritos como PSMCT32)
Imagem [+ níveis de mip com o mesmo id] [+ CLUT (id 0): 256 cores CSM1 → 8 bpp; 16 → 4 bpp]. Sem CLUT → PSMCT32.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np

import gs

_CSM1 = np.arange(256)
_CSM1 = (_CSM1 & ~24) | ((_CSM1 & 8) << 1) | ((_CSM1 & 16) >> 1)


class TexFormatError(ValueError):
    pass


@dataclass
class Texture:
    id: int
    width: int
    height: int
    bpp: int
    rgba: np.ndarray  # (h, w, 4) uint8


def _entries(t: bytes) -> list[tuple[int, int, int, bytes]]:
    out = []
    groups = struct.unpack_from("<I", t, 0)[0]
    p = max(0x40, (8 + 8 * groups + 15) & ~15)  # cabeçalho: u32 n, u32 0xF, n pares (contagem, bytes)
    while p < len(t):
        if p + 16 > len(t):
            raise TexFormatError(f"lixo no fim do .tex em 0x{p:x}")
        if not any(t[p : p + 16]):
            p += 16
            continue
        _w0, tid, _z, fmt = struct.unpack_from("<4I", t, p)
        tag, _a, _v0, direct = struct.unpack_from("<4I", t, p + 16)
        qwc = tag & 0xFFFF
        if (tag >> 28) & 7 != 6 or (direct >> 24) & 0x7F != 0x50 or (direct & 0xFFFF) != qwc or qwc < 6:
            raise TexFormatError(f"entrada inválida em 0x{p:x}")
        end = p + 32 + qwc * 16
        if end > len(t):
            raise TexFormatError(f"entrada em 0x{p:x} ultrapassa o arquivo")
        out.append((p, tid, fmt, t[p + 32 + 96 : end]))
        p = end
    return out


def _is_clut(entry: tuple[int, int, int, bytes]) -> bool:
    return entry[1] == 0 and len(entry[3]) in (64, 1024)


def _geometry(fmt: int) -> tuple[str, int, int, int]:
    """(família, largura, altura, psm) a partir do word de formato.

    Família A (bits 16..23 = 0x08..0x0F, byte baixo 0x00/0x40): retângulo PSMCT32 "swizzled";
      nibbles 8..11/12..15 = log2 do retângulo; bits 16..19 - 8 = nº de mips que seguem (mesmo id).
    Família B (bits 16..23 = 0x20/0x40, byte baixo = PSM | 0x40?): enviado no PSM nativo (pixels
      lineares); nibbles = log2 da textura. Usado por mips pequenos e algumas texturas inteiras.
    """
    hi = (fmt >> 16) & 0xFF
    if hi in (0x20, 0x40) or (fmt & 0x3F):
        return "B", 1 << ((fmt >> 8) & 15), 1 << ((fmt >> 12) & 15), fmt & 0x3F
    return "A", 1 << ((fmt >> 8) & 15), 1 << ((fmt >> 12) & 15), 0


def decode(t: bytes) -> list[Texture]:
    ents = _entries(t)
    out = []
    i = 0
    while i < len(ents):
        p, tid, fmt, img = ents[i]
        if _is_clut(ents[i]):
            raise TexFormatError(f"0x{p:x}: CLUT sem imagem")
        family, gw, gh, psm = _geometry(fmt)
        i += 1
        while i < len(ents) and ents[i][1] == tid and tid:  # níveis de mip: só o nível 0 é usado
            i += 1
        pal = None
        if i < len(ents) and _is_clut(ents[i]):
            pal = np.frombuffer(ents[i][3], np.uint8).reshape(-1, 4).copy()
            i += 1
        if family == "A":
            if gw * gh * 4 != len(img):
                raise TexFormatError(f"0x{p:x}: retângulo {gw}x{gh} não bate com {len(img)} bytes")
            if pal is None:  # PSMCT32: cor direta, escrita e lida no mesmo formato -> linear
                bpp, w, h = 32, gw, gh
                rgba = np.frombuffer(img, np.uint8).reshape(h, w, 4).copy()
            else:
                bpp = 8 if len(pal) == 256 else 4
                w, h = gw * 2, gh * (2 if bpp == 8 else 4)
                rgba = _apply_clut(pal, gs.unswizzle(img, w, h, bpp))
        else:
            w, h = gw, gh
            bpp = {0x13: 8, 0x14: 4, 0x1B: 8, 0x24: 4, 0x2C: 4, 0x00: 32}.get(psm)
            if bpp is None or pal is None and bpp != 32:
                raise TexFormatError(f"0x{p:x}: PSM 0x{psm:x} não suportado (ou sem CLUT)")
            if w * h * bpp // 8 != len(img):
                raise TexFormatError(f"0x{p:x}: {w}x{h}@{bpp} não bate com {len(img)} bytes")
            if bpp == 32:
                rgba = np.frombuffer(img, np.uint8).reshape(h, w, 4).copy()
            else:
                raw = np.frombuffer(img, np.uint8)
                idx = raw if bpp == 8 else np.stack([raw & 15, raw >> 4], axis=1).reshape(-1)
                rgba = _apply_clut(pal, idx.reshape(h, w))
        rgba[..., 3] = np.minimum(rgba[..., 3].astype(np.uint16) * 255 // 128, 255).astype(np.uint8)
        out.append(Texture(tid, w, h, bpp, rgba))
    return out


def _apply_clut(pal: np.ndarray, idx: np.ndarray) -> np.ndarray:
    if len(pal) == 256:
        pal = pal[_CSM1]
    return pal[idx]
