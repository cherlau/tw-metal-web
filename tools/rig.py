"""Esqueleto e clipes de animação dos carros, como o jogo os avalia (RE: docs/NATIVE.md).

Osso 0x0D (FUN_0022c678): u64 em +0x18 — bits 32..37 dizem se rx,ry,rz,tx,ty,tz vêm de CANAL (o campo
guarda o índice) ou são constantes (rx,ry,rz em +0x10/+0x14/+0x18, tx,ty,tz em +0x04/+0x08/+0x0C);
rotação = −valor (constante ou canal; FUN_0021b3c0). Bits 38/39 = matriz em +0x20 / +0x60 ("inversa"/"bind"); bits 40..47 = nº de
filhos; bits 48..62 = visibilidade (constante, ou índice do canal se bit 63). Matriz final (vetor-linha):
  p' = p · A(+0x20) · R · A(+0x60) + t        (A ausente = identidade)
Clipe (nó tipo 0x0B com categoria = word >> 18; FUN_00212290): f32 início em +0x04 e fim em +0x08 (quadros
  de 1/60 s), u16 nº de trilhas em +0x0C, u16 deslocamentos em +0x12. As trilhas ficam ANTES do cabeçalho:
  trilha[i] = trilha[i-1] − 4·desl[i] (trilha[-1] = cabeçalho). (Antes eram lidas DEPOIS do cabeçalho: cada
  clipe recebia as trilhas do clipe seguinte.) Na trilha p: u16 tipo, u16 canal em p+2; o amostrador vem da
  tabela 0x2c77e0[tipo & 7][(tipo >> 1) & 0x1c] (nos carros só aparecem as variantes usadas abaixo):
  0 (FUN_002a62f0): s16 n em p+4, segmentos de 0x14 bytes em p+8 (t, v, c3, c2, c1): v + c1·d + c2·d² + c3·d³
  3 (FUN_00213898): constante f32 em p+4
  1/2/4/5/6: s16 n em p+4, chaves em p+6; antes da trilha f32 t0, passo, base, escala (p−0x10..p−4);
    tempo da chave = t0 + byte·passo, valor = base + byte·escala; tangente s16 r → r/16384 se |r| ≤ 0x4000,
    senão 16384/(±32768 − r)
  1 (FUN_002a66d0): chaves de 6 bytes (t, v, m0, m1), Hermite com as DUAS tangentes da chave da esquerda,
    em unidades de valor
  2 (FUN_002a6a68): 1 byte por amostra (passo fixo), linear
  4 (FUN_002a6e70): chaves de 4 bytes (t, v, m), Hermite com m × duração do segmento (unidades por quadro)
  5 (FUN_002a7238): chaves de 2 bytes, degrau
  6 (FUN_002a7558): chaves de 2 bytes, suavizado: v0 + Δ·(3s² − 2s³)
"""

from __future__ import annotations

import bisect
import struct
from dataclasses import dataclass, field

import numpy as np

import ngp

COMP = ("rx", "ry", "rz", "tx", "ty", "tz")
OFFS = (0x10, 0x14, 0x18, 0x04, 0x08, 0x0C)


def _u32(b: bytes, p: int) -> int:
    return struct.unpack_from("<I", b, p)[0]


def _f32(b: bytes, p: int) -> float:
    return struct.unpack_from("<f", b, p)[0]


@dataclass
class Bone:
    node: int
    parent: int  # índice no vetor de ossos, -1 = raiz
    const: list[float]  # rx, ry, rz, tx, ty, tz (constantes; usadas quando não há canal)
    chan: list[int]  # índice do canal por componente, -1 = constante
    vis: int  # >= 0: índice do canal de visibilidade; -1: sempre visível; -2: nunca
    pre: list[float] | None  # matriz +0x20 (16 floats, vetor-linha)
    post: list[float] | None  # matriz +0x60
    # Nó 0x18: canal de cada componente da escala (u16 em +0x12/+0x14/+0x16, 0xFFFF = constante +0x20..+0x28);
    # medidores do HUD (globals 0x206e: turbo = canal 2 em x, vida = canal 4 em z). None = sem canal.
    schan: list[int] | None = None


@dataclass
class Track:
    channel: int
    kind: int
    step: float
    base: float
    scale: float
    # tipos 1/4/5/6: [t (byte), v (byte), m0, m1] (tangentes decodificadas; tipo 4: m0 = m1 = m da chave);
    # tipo 2: [i, v, 0, 0]; tipo 0: [t, v, c3, c2, c1] em quadros/valores; tipo 3: [] (valor em base)
    keys: list[list[float]]
    t0: float = 0.0


@dataclass
class Clip:
    category: int
    duration: float  # fim (+0x08), em quadros
    start: float = 0.0  # início (+0x04)
    tracks: list[Track] = field(default_factory=list)
    # bit 1 do u16 em +0x0E: a instância toca em laço (FUN_00211348 copia para o bit 0x10000 da instância)
    loop: bool = False
    # bit 0 do u16 em +0x0E: o objeto toca o clipe ao ser montado (FUN_002111f8 testa 0x10000 do word +0x0C e
    # chama FUN_002107e8: instância começando no relógio da carga)
    auto: bool = False


def bone_of(data: bytes, node: int, parent: int) -> Bone:
    flags64 = struct.unpack_from("<Q", data, node + 0x18)[0]
    hi = flags64 >> 32
    const, chan = [], []
    for i, off in enumerate(OFFS):
        if hi & (1 << i):
            const.append(0.0)
            chan.append(_u32(data, node + off))
        else:
            const.append(0.0 if off == 0x18 and hi & 4 else _f32(data, node + off))
            chan.append(-1)
    # rz em +0x18 compartilha os 32 bits baixos do u64 de flags
    if not hi & 4:
        const[2] = _f32(data, node + 0x18)
    visfield = (flags64 >> 48) & 0x7FFF
    vis = visfield if flags64 >> 63 else (-1 if visfield else -2)
    pre = list(np.round(struct.unpack_from("<16f", data, node + 0x20), 6)) if hi & 0x40 else None
    post_off = 0x60 if hi & 0x40 else 0x20
    post = list(np.round(struct.unpack_from("<16f", data, node + post_off), 6)) if hi & 0x80 else None
    return Bone(node, parent, [round(float(c), 6) for c in const], chan, vis, pre, post)


def build(data: bytes, instances: list[ngp.Instance]) -> tuple[list[Bone], dict[int, int]]:
    """Ossos 0x0D dos caminhos das instâncias, em ordem de árvore; devolve (ossos, nó-osso -> índice)."""
    bones: list[Bone] = []
    index: dict[int, int] = {}
    for inst in instances:
        parent = -1
        for n in inst.path[:-1]:
            kind = _u32(data, n) & 0x3F
            if kind not in (0x0D, 0x1F, 0x03, 0x18):
                continue
            if n not in index:
                index[n] = len(bones)
                bones.append(bone_of(data, n, parent) if kind == 0x0D else
                             scale_of(data, n, parent) if kind == 0x18 else fixed_of(data, n, parent, kind))
            parent = index[n]
    return bones, index


def fixed_of(data: bytes, node: int, parent: int, kind: int = 0x1F) -> Bone:
    """Transformação fixa (FUN_0021b3c0), translação em +0x10..+0x18 nos dois casos:
    - 0x1F: rotação em s16 +0x08/+0x0A/+0x0C (× π/32768, mesma regra de sinal dos ossos), filhos (u16 +0x0E)
      em +0x1C. Ex.: Mr. Grimm 0x47e0 = −45° em x e (0, −2,68, 1,46) — encaixa a roda dianteira (modelada no
      espaço do carro) no garfo inclinado 0x4810;
    - 0x03: só translação. Ex.: Twister 0x10b10 = (−3,12, 5,08, 0,19) leva a roda traseira (modelada no
      lugar) à origem do osso 0x11110, que a devolve ao lugar."""
    ang = [v * np.pi / 32768 for v in struct.unpack_from("<3h", data, node + 8)] if kind == 0x1F else [0.0] * 3
    t = list(struct.unpack_from("<3f", data, node + 0x10))
    return Bone(node, parent, [round(float(c), 6) for c in ang + t], [-1] * 6, -1, None, None)


def scale_of(data: bytes, node: int, parent: int) -> Bone:
    """Nó 0x18 (FUN_0021b3c0): escala em +0x20..+0x28 como matriz `pre`, translação +0x30..+0x38."""
    sx, sy, sz = struct.unpack_from("<3f", data, node + 0x20)
    t = list(struct.unpack_from("<3f", data, node + 0x30))
    pre = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]
    # Canais da escala: u16 em +0x12/+0x14/+0x16 (0xFFFF = constante). Evidência: nos medidores do HUD o canal
    # cai sempre no componente cuja constante é 0,01 (turbo: +0x12 ↔ sx = 0,01; vida: +0x16 ↔ sz = 0,01) e os
    # clipes 0..2 do objeto 0x206e levam esse canal de 0,01 a 1 (FUN_00139938 / FUN_00139de0 dão o tempo).
    raw = struct.unpack_from("<3H", data, node + 0x12)
    schan = [c if c != 0xFFFF else -1 for c in raw]
    return Bone(node, parent, [0.0, 0.0, 0.0] + [round(float(c), 6) for c in t], [-1] * 6, -1,
                [round(float(v), 6) for v in pre], None, schan if any(c >= 0 for c in schan) else None)


def leaf_bone(data: bytes, inst: ngp.Instance, index: dict[int, int]) -> int:
    for n in reversed(inst.path[:-1]):
        if n in index:
            return index[n]
    return -1


KEY_SIZE = {1: 6, 2: 1, 4: 4, 5: 2, 6: 2}


def tangent(raw: int) -> float:
    """Tangente s16 dos tipos 1 e 4 (FUN_002a66d0/FUN_002a6e70)."""
    if raw > 0x4000:
        return 16384.0 / (32768.0 - raw)
    if raw < -0x3FFF:
        # −32768: divisão por zero; a FPU do EE não tem infinito e satura em +MAX
        return 16384.0 / (-32768.0 - raw) if raw != -32768 else 3.4028234e38
    return raw / 16384.0


def _track(data: bytes, p: int) -> Track:
    kind, channel = struct.unpack_from("<HH", data, p)
    k = kind & 7
    if k == 3:
        return Track(channel, kind, 0.0, round(_f32(data, p + 4), 6), 0.0, [])
    n = struct.unpack_from("<h", data, p + 4)[0]
    if k == 0:
        segs = [[round(v, 7) for v in struct.unpack_from("<5f", data, p + 8 + 0x14 * i)] for i in range(n)]
        return Track(channel, kind, 0.0, 0.0, 0.0, segs)
    if k not in KEY_SIZE or n < 1:
        raise ValueError(f"trilha em {p:#x}: tipo {kind:#x} com {n} chaves")
    t0, step, base, scale = struct.unpack_from("<4f", data, p - 0x10)
    ks = KEY_SIZE[k]
    keys = []
    for i in range(n):
        q = p + 6 + ks * i
        if k == 2:
            keys.append([i, data[q], 0.0, 0.0])
        elif k == 1:
            m0, m1 = struct.unpack_from("<hh", data, q + 2)
            keys.append([data[q], data[q + 1], round(tangent(m0), 7), round(tangent(m1), 7)])
        elif k == 4:
            m = round(tangent(struct.unpack_from("<h", data, q + 2)[0]), 7)
            keys.append([data[q], data[q + 1], m, m])
        else:
            keys.append([data[q], data[q + 1], 0.0, 0.0])
    return Track(channel, kind, round(step, 7), round(base, 7), round(scale, 8), keys, round(t0, 6))


def _clip(data: bytes, n: int) -> Clip:
    clip = Clip(_u32(data, n) >> 18, round(_f32(data, n + 8), 4), round(_f32(data, n + 4), 4),
                loop=bool((_u32(data, n + 0x0C) >> 17) & 1), auto=bool((_u32(data, n + 0x0C) >> 16) & 1))
    p = n
    for i in range(struct.unpack_from("<H", data, n + 0x0C)[0]):
        p -= 4 * struct.unpack_from("<H", data, n + 0x12 + 2 * i)[0]
        clip.tracks.append(_track(data, p))
    return clip


def object_clip_table(data: bytes, obj: int) -> list[int] | None:
    """Tabela de clipes de um objeto 0x11: objeto+0x20 → u16 n, n ponteiros em +0x10. É a lista que FUN_002110d8
    percorre (o 1º clipe de cada categoria vence)."""
    t = _u32(data, obj + 0x20) if obj + 0x24 <= len(data) else 0
    if not t or t + 0x10 > len(data):
        return None
    n = struct.unpack_from("<H", data, t)[0]
    return [_u32(data, t + 0x10 + 4 * i) for i in range(n)]


def object_clips(data: bytes, obj: int) -> list[Clip]:
    """Clipes de um objeto 0x11 na ordem da tabela, só o 1º de cada categoria (FUN_002110d8)."""
    out, seen = [], set()
    for n in object_clip_table(data, obj) or []:
        if not n or n + 0x14 > len(data) or _u32(data, n) & 0x3F != 0x0B or _u32(data, n) >> 18 in seen:
            continue
        seen.add(_u32(data, n) >> 18)
        out.append(_clip(data, n))
    return out


def clip_table(data: bytes) -> list[int] | None:
    """Tabela de clipes do objeto do carro (1º objeto da lista 0x06; ver object_clip_table)."""
    for r in ngp.roots(data):
        if _u32(data, r) & 0xFF != 0x06 or not _u32(data, r + 4):
            continue
        return object_clip_table(data, _u32(data, r + 8))
    return None


def clips(data: bytes, ptr: bytes) -> list[Clip]:
    """Clipes do carro na ordem da tabela do objeto (clip_table), só o 1º de cada categoria (FUN_002110d8), com as
    trilhas lidas como FUN_00212290 (ver topo). Sem tabela: os nós 0x0B alcançados por ponteiro. A categoria 0x63
    (120 quadros, fora da tabela de instâncias do carro, FUN_00127060) fica de fora."""
    table = clip_table(data)
    if table is None:
        relocs = ngp.relocations(data, ptr)
        table = sorted({_u32(data, q) for q in relocs
                        if _u32(data, q) + 0x14 <= len(data) and _u32(data, _u32(data, q)) & 0x3F == 0x0B})
    out, seen = [], set()
    for n in table:
        if not n or _u32(data, n) & 0x3F != 0x0B:
            continue
        cat = _u32(data, n) >> 18
        if cat == 0x63 or cat in seen:
            continue
        seen.add(cat)
        out.append(_clip(data, n))
    return out


def _segment(track: Track, frame: float, last: int) -> int:
    """Busca binária dos amostradores: maior i em [0, last) com byte de tempo ≤ int((t − t0)/passo)."""
    u = int((frame - track.t0) / track.step) if track.step else 0
    lo, hi = 0, last
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if track.keys[mid][0] <= u:
            lo = mid
        else:
            hi = mid
    return lo


def sample(track: Track, frame: float) -> float:
    """Valor da trilha no quadro `frame` do clipe (FUN_00212290 → amostrador do tipo; ver topo)."""
    k = track.kind & 7
    keys = track.keys
    if k == 3 or not keys:
        return track.base
    if k == 0:
        i = 0  # busca em [0, n−1): o último segmento só marca o fim
        while i + 2 < len(keys) and keys[i + 1][0] <= frame:
            i += 1
        t, v, c3, c2, c1 = keys[i]
        d = frame - t
        return v + c1 * d + c2 * d * d + c3 * d * d * d
    val = lambda key: track.base + key[1] * track.scale  # noqa: E731
    tim = lambda key: track.t0 + key[0] * track.step  # noqa: E731
    if k == 2:
        i = int((frame - track.t0) / track.step) if track.step else 0
        i = min(max(i, 0), len(keys) - 1)
        nxt = keys[min(i + 1, len(keys) - 1)]  # o jogo lê o byte seguinte mesmo na última amostra
        return val(keys[i]) + (val(nxt) - val(keys[i])) * ((frame - track.t0) / track.step - i)
    if k == 5:
        if len(keys) == 1 or frame >= tim(keys[-1]):
            return val(keys[-1])
        return val(keys[_segment(track, frame, len(keys) - 1)])
    if len(keys) == 1:
        return val(keys[0])
    i = _segment(track, frame, len(keys) - 1)
    a, b = keys[i], keys[i + 1]
    span = tim(b) - tim(a)
    s = (frame - tim(a)) / span if span else 0.0
    va, d = val(a), val(b) - val(a)
    if k == 6:
        return va + s * s * 3 * d - s * s * s * 2 * d
    if k == 1:
        m0, m1 = a[2], a[3]
    else:  # 4
        m0, m1 = a[2] * span, b[2] * span
    return va + s * m0 + s * s * (3 * d - 2 * m0 - m1) + s * s * s * (m0 + m1 - 2 * d)


def clip_frame(clip: Clip, t01: float) -> float:
    """Tempo normalizado (FUN_002113c0, 0..1) -> quadro do clipe (FUN_00212170)."""
    return clip.start + t01 * (clip.duration - clip.start)


_euler = ngp.euler  # FUN_00236e50 (vetor-linha)


def local(bone: Bone, ch: np.ndarray) -> np.ndarray:
    # FUN_0021b3c0: a rotação é sempre negada (constante ou canal) antes do Euler de FUN_00236e50
    vals = [ch[c] if c >= 0 else bone.const[i] for i, c in enumerate(bone.chan)]
    vals[:3] = [-v for v in vals[:3]]
    m = _euler(*vals[:3])
    if bone.pre is not None:
        m = np.array(bone.pre).reshape(4, 4) @ m
    if bone.post is not None:
        m = m @ np.array(bone.post).reshape(4, 4)
    m = m.copy()
    m[3, :3] += vals[3:]
    return m


def world(bones: list[Bone], ch: np.ndarray) -> list[np.ndarray]:
    out: list[np.ndarray] = []
    for b in bones:
        loc = local(b, ch)
        out.append(loc @ out[b.parent] if b.parent >= 0 else loc)
    return out


def launcher_slots(data: bytes, ptr: bytes) -> dict[int, list[int]]:
    """Osso (nó 0x0D) -> slots de arma: registros 0x00F0xxxx (slot = (word & 0xFFFF) >> 6) logo abaixo dele."""
    relocs = ngp.relocations(data, ptr)
    parents: dict[int, list[int]] = {}
    for q in relocs:
        parents.setdefault(_u32(data, q), []).append(q)
    starts = set(parents)

    def owner(q: int) -> int | None:
        for back in range(4, 0x200, 4):
            if q - back in starts:
                return q - back
        return None

    out: dict[int, list[int]] = {}
    for rec in sorted({_u32(data, q) for q in relocs if _u32(data, q) + 0x20 <= len(data)}):
        w = _u32(data, rec)
        if w >> 16 != 0x00F0:
            continue
        cur = rec
        for _ in range(6):
            ps = parents.get(cur)
            n = owner(ps[0]) if ps else None
            if n is None:
                break
            if _u32(data, n) & 0x3F == 0x0D:
                out.setdefault(n, []).append((w & 0xFFFF) >> 6)
                break
            cur = n
    return out


def launch_marks(data: bytes, ptr: bytes, index: dict[int, int]) -> list[dict]:
    """Marcadores de projétil (registros 0x00F0xxxx = categoria 0x3C, id = tipo de arma): FUN_00124288 os guarda em
    carro+0x61d8 + 4·tipo e FUN_00147568 pendura neles o modelo do projétil ao abrir o suporte (tipo 3/0x1F: filho em
    +0x1C, na translação +0x10; tipo 1: filho em +0x20, na origem do quadro). Devolve [{type, bone, pos}] com o osso
    do esqueleto mais próximo acima do marcador (ou -1)."""
    relocs = ngp.relocations(data, ptr)
    parent: dict[int, int] = {}
    starts = sorted({_u32(data, q) for q in relocs if _u32(data, q) + 4 <= len(data)})
    owners = starts
    for q in relocs:
        c = _u32(data, q)
        k = bisect.bisect_right(owners, q) - 1
        if k >= 0 and q - owners[k] < 0x200 and c != owners[k]:
            parent.setdefault(c, owners[k])
    out = []
    for rec in starts:
        w = _u32(data, rec)
        if w >> 16 != 0x00F0 or rec + 0x20 > len(data):
            continue
        kind = w & 0x1F
        pos = list(struct.unpack_from("<3f", data, rec + 0x10)) if kind in (3, 0x1F) else [0.0, 0.0, 0.0]
        bone, cur = -1, rec
        for _ in range(8):
            cur = parent.get(cur, -1)
            if cur < 0:
                break
            if cur in index:
                bone = index[cur]
                break
        out.append({"type": (w & 0xFFFF) >> 6, "bone": bone, "pos": [round(float(v), 4) for v in pos]})
    return out


# Tipo de arma do jogo (FUN_00120ba0: pickup -> tipo; o mesmo índice dos marcadores 0x00F0/0x00F8 do .ngp).
# 0 = metralhadora (inventário à parte), 1 = especial, 5 = só nos HC (🟡 desconhecida), 8 = ataque de ambiente.
WEAPON_TYPES = {2: "fire", 3: "homing", 4: "napalm", 6: "power", 7: "ricochet", 9: "swarmer", 10: "remote"}
_HO = {2: 0x15, 3: 0x15, 4: 0x0E, 6: 0x17, 7: 0x0D, 9: 0x17, 10: 0x16}
_HC = {2: 0x15, 3: 0x15, 4: 0x0E, 5: 0x16, 6: 0x16}
# Suporte de cada tipo de arma por veículo (FUN_00148e00) -> categoria do clipe do suporte (FUN_00148d38:
# suportes 0..4 = 0x0D, 0x0E, 0x15, 0x16, 0x17). Veículo = 0x65 + id da tabela 0x2ba990.
MOUNT_CLIPS: dict[int, dict[int, int]] = {
    **{v: _HO for v in range(0x65, 0x76)},
    **{v: _HC for v in (0x77, 0x79, 0x7C, 0x7D, 0x7E, 0x7F, 0x80, 0x83, 0x85, 0x86)},
    **{v: {**_HC, 5: 0x15, 6: 0x15} for v in (0x78, 0x82)},
    **{v: {**_HC, 5: 0x15} for v in (0x7A, 0x7B, 0x81)},
    0x84: {**_HC, 6: 0x17},
}  # 0x76 (Dark2), 0x87 (StockCar), 0x88 (Tank Car) e desconhecidos: nenhum suporte


# Veículos com piloto animado (FUN_00127060 cria as instâncias 0x22..0x25; FUN_0011e3d0 roda a máquina do piloto:
# FUN_00125688 em 0x67/0x7a/0x73, FUN_001258f0 em 0x65/0x77).
DRIVER_VEHICLES = {0x65: "b", 0x77: "b", 0x67: "a", 0x7A: "a", 0x73: "a"}
DRIVER_CLIPS = {0x22: "steer", 0x23: "air", 0x24: "land", 0x25: "ride"}


def clip_speed(vehicle: int | None) -> float:
    """Velocidade dos clipes de suporte (FUN_00127778): 2 nos veículos < 0x76, senão 1."""
    return 2.0 if vehicle is not None and vehicle < 0x76 else 1.0


def classify(bones: list[Bone], clip_list: list[Clip], vehicle: int | None) -> list[dict]:
    """Papel de cada clipe pela categoria, como o código do carro os usa (FUN_00127060 e a API em
    0x127608..0x127ed8): 0..3 giro da roda i (velocidade), 4..7 suspensão da roda i−4 (tempo direto),
    8..11 esterço da roda i−8 (tempo = ângulo/π + 0,5); suportes de arma por MOUNT_CLIPS (abrem quando a
    arma é selecionada, FUN_00148978). Demais: other."""
    mounts: dict[int, list[str]] = {}
    for wtype, cat in MOUNT_CLIPS.get(vehicle, {}).items():
        if wtype in WEAPON_TYPES:
            mounts.setdefault(cat, []).append(WEAPON_TYPES[wtype])
    out = []
    for c in clip_list:
        cat = c.category
        role, wheel = "other", None
        if cat < 4:
            role, wheel = "spin", cat
        elif cat < 8:
            role, wheel = "susp", cat - 4
        elif cat < 12:
            role, wheel = "steer", cat - 8
        elif cat in mounts:
            role = "weapon"
        elif cat in DRIVER_CLIPS and vehicle in DRIVER_VEHICLES:
            role = "driver"
        entry = {"category": cat, "start": c.start, "duration": c.duration, "role": role, "loop": c.loop,
                 "tracks": [{"ch": t.channel, "kind": t.kind, "step": t.step, "base": t.base,
                             "scale": t.scale, "t0": t.t0, "keys": t.keys} for t in c.tracks]}
        if wheel is not None:
            entry["wheel"] = wheel
        if role == "weapon":
            entry["weapons"] = sorted(mounts[cat])
        if role == "driver":
            entry["driver"] = DRIVER_CLIPS[cat]
        out.append(entry)
    return out


def _skin_binds(data: bytes) -> dict[int, np.ndarray]:
    """osso 0x0D -> inversa do bind (nós 0x15: [0x15, 1, slot, *osso, matriz 4x4 em +0x10])."""
    out: dict[int, np.ndarray] = {}
    for q in range(0, len(data) - 0x50, 0x10):
        if _u32(data, q) == 0x15 and _u32(data, q + 4) == 1:
            n = _u32(data, q + 0x0C)
            if n + 0x20 <= len(data) and _u32(data, n) & 0x3F == 0x0D:
                out[n] = np.array(struct.unpack_from("<16f", data, q + 0x10), dtype=np.float64).reshape(4, 4)
    return out


def _euler_inv(m: np.ndarray) -> tuple[float, float, float]:
    """Ângulos (rx, ry, rz) com _euler(rx, ry, rz) == m (3x3)."""
    ry = float(np.arcsin(np.clip(m[0, 2], -1, 1)))
    rz = float(np.arctan2(-m[0, 1], m[0, 0]))
    rx = float(np.arctan2(-m[1, 2], m[2, 2]))
    return rx, ry, rz


def rest_channels(data: bytes, bones: list[Bone], clip_list: list[Clip], driven: set[int]) -> dict[int, float]:
    """Valor de repouso de cada canal: o dos clipes em t=0 e, nos ossos com inversa do bind (nós 0x15), o
    que reproduz a pose de bind (= a malha como foi modelada). Os canais em `driven` (clipes de roda,
    esterço, suspensão e armas, tocados pelo runtime) ficam com o valor do clipe.
    ⚠️ ESCOLHA DO HOST: sem o código que escolhe a animação ociosa, a pose de bind é a referência."""
    rest: dict[int, float] = {}
    for c in clip_list:
        for t in c.tracks:
            rest[t.channel] = sample(t, clip_frame(c, 0.0))  # como o runtime antigo: o último clipe vence
    binds = _skin_binds(data)
    bind_world: dict[int, np.ndarray] = {}
    ch = np.zeros(1 + max([0] + [c for b in bones for c in b.chan] + [t.channel for c in clip_list for t in c.tracks]))
    for k, v in rest.items():
        ch[k] = v
    for bi, b in enumerate(bones):
        parent_w = bind_world.get(b.parent) if b.parent >= 0 else np.eye(4)
        if b.node in binds and parent_w is not None and any(c >= 0 for c in b.chan):
            target = np.linalg.inv(binds[b.node]) @ np.linalg.inv(parent_w)  # local de bind
            pre = np.array(b.pre).reshape(4, 4) if b.pre is not None else np.eye(4)
            post = np.array(b.post).reshape(4, 4) if b.post is not None else np.eye(4)
            r = np.linalg.inv(pre[:3, :3]) @ target[:3, :3] @ np.linalg.inv(post[:3, :3])
            ang = _euler_inv(r)
            rot_part = (pre @ _euler(*ang) @ post)[3, :3]
            vals = [-a for a in ang] + list(target[3, :3] - rot_part)
            for i, c in enumerate(b.chan):
                if c >= 0 and c not in driven:
                    rest[c] = ch[c] = float(vals[i])
        if b.parent < 0 or b.parent in bind_world:
            w = local(b, ch)
            bind_world[bi] = w @ bind_world[b.parent] if b.parent >= 0 else w
    return rest


def direct_channels(bones: list[Bone], clip_list: list[Clip], wheel_bones: set[int]) -> dict[str, list[int]]:
    """Canais de roda que nenhum clipe escreve (o código do jogo escreve direto): rx de osso de roda = giro,
    rz = esterço. Ex.: Mr. Grimm — giro 1 (traseira) e 4 (dianteira), esterço 2 (garfo 0x4810).
    ⚠️ Papel deduzido pela posição na árvore (osso de roda ou ancestral dela)."""
    in_clip = {t.channel for c in clip_list for t in c.tracks}
    has_wheel_child = {bones[bi].parent for bi in wheel_bones}
    leaves = [bi for bi in wheel_bones if bi not in has_wheel_child]  # osso mais próximo da malha da roda
    spin: set[int] = set()
    steer: set[int] = set()
    for leaf in leaves:
        chain, k = [], leaf
        while k >= 0 and len(chain) < 4:
            chain.append(bones[k])
            k = bones[k].parent
        if any(b.chan[0] in in_clip for b in chain if b.chan[0] >= 0):
            continue  # esta roda já gira por clipe
        k, depth = leaf, 0
        while k >= 0 and bones[k].parent >= 0 and depth < 4:  # nunca a raiz (carroceria)
            b = bones[k]
            if depth == 0 and b.chan[0] >= 0 and b.chan[0] not in in_clip:
                spin.add(b.chan[0])
            if b.chan[2] >= 0 and b.chan[2] not in in_clip:
                steer.add(b.chan[2])
            k, depth = b.parent, depth + 1
    return {"spin": sorted(spin), "steer": sorted(steer)}
