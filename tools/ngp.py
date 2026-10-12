"""Decoder do .ngp (geometria) + .ptr (relocação) do Twisted Metal: Head-On (PS2).

Estado do conhecimento (docs/FORMATS.md):
- .ngp é uma imagem de memória; .ptr = u32 0xFFFFFFFF + deltas u16 (em words) marcando as
  posições que contêm ponteiros (offsets relativos ao início do .ngp).
- Cada bloco de malha tem um cabeçalho de 0x90 bytes seguido da geometria:
    +0x04 u32 flags (≠ 0)                        +0x0C f32 escala do ponto fixo (2^-14, 2^-15…)
    +0x10..+0x1C ids de textura (1 a 4; casam com o .tex), terminados por 0
    +0x20 vec4 bounding sphere
    +0x60 u64 GS TEX0 (TBP/CBP zerados)
    +0x60 um GS TEX0 (16 bytes) por textura
    se flags bit 31: mais 2 qwords (máscara e f32 distância). Geometria = +0x60 + 0x10*nTex (+0x20 se bit 31).
    geometria: cadeia DMA inline (CNT…RET) ou bloco apontado por um DMA REF
- Geometria = lotes VIF para um microprograma da VU1:
    lote "pool":  @180 S-32 nº de vértices | @181 V3-16+ROW (STMOD offset) ou V4-32 posições | @373 V3-8 normais
    lote "strip": @base (568/712/856, buffer triplo) GIF tag ou cabeçalho | @base+1 V1-8 índice no pool
                  | @base+2 cor (V1-8 intensidade, V4-8 RGBA ou V4-5) | @base+3 V2-16 UV
                  | V1-8 mascarados no slot XYZ2 (base+3+3i) = bit ADC (reinício de strip)
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

import numpy as np

import vif

HEADER_SHORT, HEADER_LONG = 0x70, 0x90
POOL_COUNT, POOL_POS, POOL_NRM = 180, 181, 373
STRIP_BASES = (568, 712, 856)


class NgpFormatError(ValueError):
    pass


def relocations(ngp: bytes, ptr: bytes) -> set[int]:
    """Posições (em bytes) dos words do .ngp que são ponteiros.

    .ptr = u32 0xFFFFFFFF + deltas u16 em words, acumulados a partir de 0. Um delta 0 é escape:
    os dois u16 seguintes formam um delta de 32 bits (lo, hi) — saltos > 65535 words (níveis grandes).
    Zeros finais são padding.
    """
    if len(ptr) < 4 or struct.unpack_from("<I", ptr, 0)[0] != 0xFFFFFFFF:
        raise NgpFormatError("tabela .ptr sem marcador 0xFFFFFFFF")
    deltas = struct.unpack_from(f"<{(len(ptr) - 4) // 2}H", ptr, 4)
    out: set[int] = set()
    pos = 0
    i = 0
    while i < len(deltas):
        d = deltas[i]
        i += 1
        if d == 0:
            if i + 1 >= len(deltas) or deltas[i] == 0 and deltas[i + 1] == 0:
                break  # padding
            d = deltas[i] | deltas[i + 1] << 16
            i += 2
        pos += d * 4
        if pos + 4 > len(ngp):
            break
        out.add(pos)
    return out


@dataclass
class Strip:
    pos: np.ndarray  # (n,3) float
    nrm: np.ndarray  # (n,3) float
    uv: np.ndarray  # (n,2) float, cru (unidades/4096)
    color: np.ndarray  # (n,4) float 0..1
    adc: np.ndarray  # (n,) bool
    texture: int = 0  # índice na lista de texturas do cabeçalho


@dataclass
class Sprite:
    """Billboard (brilho de farol, fogo…): microprograma de sprite da VU."""

    center: tuple[float, float, float]
    size: float
    color: tuple[float, float, float, float]
    uv: tuple[float, float, float, float]  # u0, v0, u1, v1 (unidades/4096 como nas strips)


@dataclass
class Beam:
    """Feixe/rastro: polilinha de N pontos (x, y, z, largura) com cor e UV por ponto (microprograma próprio)."""

    points: list[list[float]]  # (n, 4)
    colors: list[list[float]]  # (n, 4)
    uvs: list[list[float]]  # (n, 2 ou 4): unidades/4096


@dataclass
class Mesh:
    offset: int  # offset do cabeçalho no .ngp
    flags: int
    scale: float
    texture_id: int
    tex0: int
    sphere: tuple[float, float, float, float]
    strips: list[Strip] = field(default_factory=list)
    sprites: list[Sprite] = field(default_factory=list)
    beams: list[Beam] = field(default_factory=list)
    packed: str = "fixed16"  # ou "float32"
    texture2: int = 0  # 2ª textura (multitextura) ou 0
    textures: list[int] = field(default_factory=list)  # todas as texturas do cabeçalho
    pool_owner: int = -1  # cabeçalho que enviou o pool (≠ offset: segunda passada sobre os mesmos vértices)

    def texture_slots(self) -> list[int]:
        return sorted({s.texture for s in self.strips})

    def triangles(self, texture: int | None = None) -> tuple[dict[str, np.ndarray], np.ndarray]:
        """Atributos por vértice de strip + índices de triângulos (winding coerente por strip).

        `texture` filtra as strips de um slot de textura (malhas multitextura viram uma parte por slot).
        """
        attrs = {k: [] for k in ("position", "normal", "uv", "color")}
        idx: list[np.ndarray] = []
        base = 0
        for s in self.strips:
            if texture is not None and s.texture != texture:
                continue
            n = len(s.pos)
            attrs["position"].append(s.pos)
            attrs["normal"].append(s.nrm)
            attrs["uv"].append(s.uv)
            attrs["color"].append(s.color)
            tris = []
            start = 0
            for k in range(n):
                if s.adc[k]:
                    if k == 0 or not s.adc[k - 1]:
                        start = k
                    continue
                if k - start < 2:
                    continue
                a, b, c = k - 2, k - 1, k
                tris.append((a, b, c) if (k - start) % 2 == 0 else (b, a, c))
            if tris:
                idx.append(np.array(tris, dtype=np.uint32) + base)
            base += n
        out = {k: (np.concatenate(v).astype(np.float32) if v else np.zeros((0, 3), np.float32)) for k, v in attrs.items()}
        indices = np.concatenate(idx).reshape(-1) if idx else np.zeros(0, np.uint32)
        return out, indices


def _color(u: vif.Unpack) -> np.ndarray:
    v = u.values().astype(np.float32)
    # PS2: 0x80 = 1,0; valores acima sobre-expõem (até ~2,0) — sem clamp, como o GS (TFX MODULATE).
    if u.vn == 1:  # intensidade
        g = v[:, 0] / 128.0
        return np.stack([g, g, g, np.ones_like(g)], axis=1)
    if u.vl == 5:  # RGBA5551
        rgb = v[:, :3] / 31.0
        return np.concatenate([rgb, np.ones((len(v), 1), np.float32)], axis=1)
    if u.vn == 4 and u.vl == 8:
        return v / 128.0
    raise NgpFormatError(f"formato de cor desconhecido V{u.vn}-{u.vl} em 0x{u.offset:x}")


@dataclass
class Pool:
    pos: np.ndarray
    nrm: np.ndarray | None
    packed: str
    owner: int  # offset do cabeçalho que enviou o pool


def decode_packets(
    packets: list[vif.Packet], scale: float, where: int, inherited: Pool | None = None
) -> tuple[list[Strip], list[Sprite], list[Beam], Pool | None]:
    """Decodifica os lotes. Sem lote de pool, a malha usa o pool que já está na VU (`inherited`)."""
    strips: list[Strip] = []
    sprites: list[Sprite] = []
    beams: list[Beam] = []
    pool_pos = inherited.pos if inherited else None
    pool_nrm = inherited.nrm if inherited else None
    packed = inherited.packed if inherited else "fixed16"
    owner = inherited.owner if inherited else where
    tex_slot = 0
    for pk in packets:
        by_addr: dict[int, list[vif.Unpack]] = {}
        for u in pk.unpacks:
            by_addr.setdefault(u.addr, []).append(u)
        if POOL_POS in by_addr:
            u = by_addr[POOL_POS][0]
            if u.vn == 3 and u.vl == 16:
                pool_pos = u.ints_with_row().astype(np.float64) * scale
            elif u.vn == 4 and u.vl == 32:
                pool_pos = u.floats()[:, :3].astype(np.float64)
                packed = "float32"
            else:
                raise NgpFormatError(f"posição em formato desconhecido V{u.vn}-{u.vl} (0x{where:x})")
            pool_nrm = None
            owner = where
            if POOL_NRM in by_addr:
                nu = by_addr[POOL_NRM][0]
                if not (nu.vn == 3 and nu.vl == 8):
                    raise NgpFormatError(f"normal em formato desconhecido V{nu.vn}-{nu.vl}")
                pool_nrm = nu.values().astype(np.float64) / 127.0
        for base in STRIP_BASES:
            if base + 1 not in by_addr:
                continue
            hdr = by_addr.get(base)
            if hdr and hdr[0].vn == 4 and hdr[0].vl == 32:
                # 4º word do cabeçalho da strip: bits baixos 1 + 3*i selecionam a textura i, 0 mantém a
                # atual; bit 15 = flag (🟡 visto em níveis)
                sel = int(hdr[0].values()[0][3]) & 0x7FFF
                if sel:
                    if (sel - 1) % 3:
                        raise NgpFormatError(f"seletor de textura {sel} inesperado (0x{where:x})")
                    tex_slot = (sel - 1) // 3
            iu = by_addr[base + 1][0]
            if iu.vn == 2 and iu.vl == 16 and base + 3 in by_addr and by_addr[base + 3][0].vl == 32:
                c = by_addr[base + 3][0].floats()[0]
                col = _color(by_addr[base + 2][0])[0] if base + 2 in by_addr else np.ones(4)
                uvr = iu.values().astype(np.float64).reshape(-1) / 4096.0
                sprites.append(Sprite(tuple(map(float, c[:3])), float(c[3]), tuple(map(float, col)), tuple(map(float, uvr[:4]))))
                continue
            if iu.vn == 4 and iu.vl == 32:
                pts = iu.floats()
                n = len(pts)
                col = _color(by_addr[base + 2][0]) if base + 2 in by_addr else np.ones((n, 4))
                uvu = by_addr.get(base + 3)
                uvs = uvu[0].values().astype(np.float64) / 4096.0 if uvu else np.zeros((n, 2))
                beams.append(Beam(np.round(pts, 5).tolist(), np.round(col, 4).tolist(), np.round(uvs, 5).tolist()))
                continue
            if not (iu.vn == 1 and iu.vl == 8):
                raise NgpFormatError(f"lote desconhecido em @{base + 1}: V{iu.vn}-{iu.vl} (0x{where:x})")
            if pool_pos is None:
                raise NgpFormatError(f"strip sem pool de vértices (0x{where:x})")
            index = iu.values()[:, 0]
            n = len(index)
            if index.max(initial=0) >= len(pool_pos):
                raise NgpFormatError(f"índice {index.max()} >= pool {len(pool_pos)} (0x{where:x})")
            cu = by_addr.get(base + 2)
            color = _color(cu[0]) if cu else np.ones((n, 4), np.float32)
            uu = by_addr.get(base + 3)
            uv = uu[0].values().astype(np.float64) / 4096.0 if uu else np.zeros((n, 2))
            adc = np.zeros(n, bool)
            for addr, lst in by_addr.items():
                rel = addr - base - 1
                if rel < 3 or rel % 3 != 2:
                    continue
                for u in lst:
                    if u.masked and u.vn == 1:
                        i = rel // 3
                        adc[i : i + u.count] = True
            for arr, name in ((color, "cor"), (uv, "uv")):
                if len(arr) != n:
                    raise NgpFormatError(f"{name}: {len(arr)} != {n} índices (0x{where:x})")
            nrm = pool_nrm[index] if pool_nrm is not None else np.zeros((n, 3))
            strips.append(Strip(pool_pos[index], nrm, uv, color, adc, tex_slot))
    pool = Pool(pool_pos, pool_nrm, packed, owner) if pool_pos is not None else None
    return strips, sprites, beams, pool


def _ref_targets(ngp: bytes, relocs: set[int]) -> dict[int, int]:
    """addr -> qwc de todo DMA tag REF cujo campo ADDR é um ponteiro relocado."""
    out: dict[int, int] = {}
    for p in sorted(relocs):
        if p % 16 != 4:
            continue
        tag = vif.read_tag(ngp, p - 4)
        if tag.id == 3 and tag.qwc and tag.addr % 16 == 0 and tag.addr < len(ngp):
            out[tag.addr] = max(out.get(tag.addr, 0), tag.qwc)
    return out


def _texture_ids(ngp: bytes, p: int) -> list[int]:
    """Ids de textura em +0x10..+0x1C (até 4; termina no primeiro zero)."""
    out = []
    for k in range(4):
        v = struct.unpack_from("<I", ngp, p + 0x10 + 4 * k)[0]
        if not v:
            break
        out.append(v)
    return out


def _is_header(ngp: bytes, p: int, relocs: set[int], targets: set[int]) -> bool:
    if any(p + k in relocs for k in range(0, 0x20, 4)):
        return False  # campos do cabeçalho nunca são ponteiros
    z0, flags, anim, scale_bits = struct.unpack_from("<4I", ngp, p)
    if z0 and p not in targets:
        return False  # +0x00 ≠ 0 (🟡 visto em níveis HC) só quando um ponteiro aponta para cá
    if not flags or (anim and not flags & 0x04):
        return False  # +0x08 só é não-zero (f32 velocidade de textura animada) quando flags & 0x04
    ids = _texture_ids(ngp, p)
    if any(struct.unpack_from("<I", ngp, p + 0x10 + 4 * k)[0] for k in range(len(ids) + 1, 4)):
        return False  # buraco na lista de texturas
    if any(i >= 0x1000000 for i in ids):
        return False  # ids de textura observados ficam abaixo de 0x200000
    exp = (scale_bits >> 23) & 0xFF
    return (scale_bits & 0x807FFFFF) == 0 and 0x60 <= exp <= 0x7F  # potência de 2 entre 2^-31 e 1


def find_meshes(ngp: bytes, ptr: bytes) -> list[Mesh]:
    relocs = relocations(ngp, ptr)
    refs = _ref_targets(ngp, relocs)
    targets = {struct.unpack_from("<I", ngp, q)[0] for q in relocs}
    meshes: list[Mesh] = []
    pool: Pool | None = None
    for p in range(0, len(ngp) - HEADER_LONG - 16, 16):
        if not _is_header(ngp, p, relocs, targets):
            continue
        flags = struct.unpack_from("<I", ngp, p + 4)[0]
        ids = _texture_ids(ngp, p)
        tex_id = ids[0] if ids else 0
        tex2 = ids[1] if len(ids) > 1 else 0
        # Um TEX0 (16 bytes, a partir de +0x60) por textura; malha sem textura não tem TEX0.
        g = p + 0x60 + 0x10 * len(ids) + (0x20 if flags & 0x80000000 else 0)
        tag = vif.read_tag(ngp, g)
        try:
            if g in refs:
                packets = vif.walk(ngp, g, g + refs[g] * 16)
            elif tag.id in (1, 6, 7) and tag.addr == 0 and tag.qwc:
                packets, _ = vif.walk_chain(ngp, g)
            else:
                continue
        except vif.VifError:
            continue
        scale = struct.unpack_from("<f", ngp, p + 12)[0]
        sphere = struct.unpack_from("<4f", ngp, p + 0x20)
        tex0 = struct.unpack_from("<Q", ngp, p + 0x60)[0]
        strips, sprites, beams, pool = decode_packets(packets, scale, p, pool)
        if strips or sprites or beams:
            meshes.append(Mesh(p, flags, scale, tex_id, tex0, sphere, strips, sprites, beams,
                               packed=pool.packed if pool else "none",
                               pool_owner=pool.owner if pool else -1, texture2=tex2, textures=ids))
    return meshes


# ---------------------------------------------------------------------------
# Scene graph
# ---------------------------------------------------------------------------
# Tipo do nó = byte baixo do primeiro word. Matrizes são 4x4 vetor-linha (translação na 4ª linha).
#
# As malhas já estão no espaço do MODELO (pose de bind). Os nós 0x0D/0x15 guardam a INVERSA do
# bind (modelo -> osso) e os 0x0D também o bind (+0x60). Na pose base a transformação final é a
# identidade; para animar uma peça: p_final = p @ inv_bind @ mundo_animado_do_osso.


@dataclass
class Instance:
    mesh: int  # offset do cabeçalho da malha
    bone: int  # nó de transformação mais próximo (0x0D/0x15) ou -1
    path: list[int]  # nós percorridos (para depuração)
    state: int = -1  # pacote de estado do GS do grupo mais próximo (grupo 0x01 com +0x04 ≠ 0) ou -1
    offset: tuple[float, float, float] = (0.0, 0.0, 0.0)  # translação acumulada dos nós 0x03 (níveis)


@dataclass
class Bone:
    node: int
    parent: int  # osso pai ou -1
    inv_bind: np.ndarray  # (4,4) modelo -> osso (+0x20 nos 0x0D, +0x10 nos 0x15)
    bind: np.ndarray | None  # (4,4) osso -> modelo (+0x60 nos 0x0D)


@dataclass
class SceneReport:
    instances: list[Instance] = field(default_factory=list)
    bones: dict[int, Bone] = field(default_factory=dict)
    # Slots de efeito (nós 0x05): escudo, gelo, fogo, turbo, faróis, sombra… ligados pelo código do jogo.
    effects: dict[int, list[Instance]] = field(default_factory=dict)
    code_effects: dict[str, list[Instance]] = field(default_factory=dict)  # preenchido pelo conversor
    unknown: dict[int, list[int]] = field(default_factory=dict)  # word de tipo -> nós não interpretados


def _u32(b: bytes, p: int) -> int:
    return struct.unpack_from("<I", b, p)[0]


def _mat(b: bytes, p: int) -> np.ndarray:
    return np.array(struct.unpack_from("<16f", b, p), dtype=np.float64).reshape(4, 4)


def scene(data: bytes, ptr: bytes, meshes: list[Mesh], root: int | None = None, lenient: bool = False,
          _lod_cache: dict[int, int] | None = None, place_objects: bool = False) -> SceneReport:
    """Percorre o grafo a partir da raiz (.ngp+0x08): LOD mais detalhado, estado intacto."""
    relocs = relocations(data, ptr)
    mesh_at = {m.offset for m in meshes}
    rep = SceneReport()

    def ptr_at(p: int) -> int | None:
        if p in relocs:
            return _u32(data, p)
        if lenient:  # objetos fora da tabela .ptr: o campo é ponteiro pelo layout do nó
            v = _u32(data, p)
            if v and v % 4 == 0 and v + 4 <= len(data):
                return v
        return None

    def children(p: int, base: int, n: int, bone: int, path: list[int], depth: int) -> None:
        for i in range(n):
            c = ptr_at(base + 4 * i)
            if c is not None:
                visit(c, bone, path, depth + 1)

    tri_of = {m.offset: sum(max(0, len(st.pos) - 2) for st in m.strips) for m in meshes}
    lod_cache: dict[int, int] = {} if _lod_cache is None else _lod_cache

    def _subtree_tris(c: int) -> int:
        if c not in lod_cache:
            lod_cache[c] = 0  # contra ciclos
            sub = scene(data, ptr, meshes, root=c, lenient=lenient, _lod_cache=lod_cache)
            lod_cache[c] = sum(tri_of.get(i.mesh, 0) for i in sub.instances)
        return lod_cache[c]

    sink: list[list[Instance]] = [rep.instances]  # destino atual (pose base ou um slot de efeito)
    states: list[int] = [-1]  # estado do GS em vigor (grupos 0x01 com +0x04 -> pacote VIF/GIF)
    offsets: list[tuple[float, float, float]] = [(0.0, 0.0, 0.0)]  # translação dos objetos (nós 0x03)
    mesh_by_off = {m.offset: m for m in meshes}
    local_cache: dict[int, bool] = {}

    def _is_local(c: int, t: tuple[float, float, float]) -> bool:
        """A subárvore é um modelo centrado na origem (objeto a posicionar) e não geometria já no mundo?"""
        if c not in local_cache:
            sub = scene(data, ptr, meshes, root=c, lenient=lenient, _lod_cache=lod_cache)
            pts = [np.asarray(st.pos)[:, :3] for i in sub.instances for st in mesh_by_off[i.mesh].strips]
            if not pts:
                local_cache[c] = False
            else:
                allp = np.concatenate(pts)
                lo, hi = allp.min(0), allp.max(0)
                center, half = (lo + hi) / 2, (hi - lo) / 2
                # centro perto da origem em x,y (comparado ao tamanho) e longe do ponto de destino
                # Local = bem mais perto da origem que do destino (telhados do Coliseu DM a 48 da origem e
                # destino a 1400); já no mundo = perto do destino (pivôs, segmentos de Tóquio DM).
                d0 = float(np.hypot(center[0], center[1]))
                dt = float(np.hypot(center[0] - t[0], center[1] - t[1]))
                local_cache[c] = bool(d0 < 0.25 * dt and dt > 20.0)
        return local_cache[c]

    def visit(p: int, bone: int, path: list[int], depth: int) -> None:
        if depth > 64 or p in path:
            return
        path = path + [p]
        if p in mesh_at:
            off = offsets[-1]
            if any(off):
                # Decide por malha: o mesmo posicionador mistura peças locais (estátua intacta, centrada na
                # origem) e peças já no mundo (destroços no destino) — Grécia DM.
                m = mesh_by_off[p]
                if m.strips:
                    allp = np.concatenate([np.asarray(st.pos)[:, :3] for st in m.strips])
                    c = (allp.min(0) + allp.max(0)) / 2
                    if np.hypot(c[0], c[1]) >= 0.5 * np.hypot(c[0] - off[0], c[1] - off[1]):
                        off = (0.0, 0.0, 0.0)
            sink[-1].append(Instance(p, bone, path, states[-1], off))
            return
        word = _u32(data, p)
        if word >> 24 == 0 and (word >> 16) & 0xFF in (0xF0, 0xF8):
            return  # registro de localizador 0x00F0xxxx/0x00F8xxxx (pontos de montagem), não é nó
        t = word & 0x3F  # bits 6..7 do byte baixo = flags (ex.: 0x41 = grupo animado)
        if t == 0x06:  # raiz: +0x08 -> objeto
            c = _u32(data, p + 8)
            if c + 4 <= len(data):
                visit(c, bone, path, depth + 1)
        elif t == 0x11:  # objeto: partes em +0x2C, contagem no byte baixo de +0x28
            children(p, p + 0x2C, _u32(data, p + 0x28) & 0xFF, bone, path, depth)
        elif t == 0x01:  # grupo: filhos em +0x20, contagem em +0x08 (16 bits baixos); +0x04 -> estado do GS
            st = ptr_at(p + 4)
            states.append(st if st is not None and gs_state(data, st) is not None else states[-1])
            children(p, p + 0x20, _u32(data, p + 8) & 0xFFFF, bone, path, depth)
            states.pop()
        elif t == 0x02:  # LOD: n entradas de 16 bytes em +0x20: (?, f32 distância², *filho, ?)
            opts = []
            for i in range(_u32(data, p + 4)):
                q = p + 0x20 + 16 * i
                c = ptr_at(q + 8)
                if c is not None:
                    opts.append((struct.unpack_from("<f", data, q + 4)[0], c))
            if opts:
                # Mais detalhado = mais triângulos (empate: menor distância). "Menor distância" sozinha
                # falha: opção vazia com d²=0 (Arena, 19 nós) e carro inteiro na 2ª opção (Tank Car).
                best = max(opts, key=lambda o: (_subtree_tris(o[1]), -o[0]))
                visit(best[1], bone, path, depth + 1)
        elif t == 0x0D:  # transformação/osso: +0x1C flags (bits 8..15 = nº de filhos)
            # bit 7 = inversa do bind em +0x20; bit 6 = bind em +0x60; filhos logo depois das matrizes.
            # Sem o bit 6 (ex.: 0x84 no Mr. Grimm) só há a inversa e os filhos começam em +0x60.
            flags = _u32(data, p + 0x1C)
            n = (flags >> 8) & 0xFF
            if flags & 0x80:
                has_bind = bool(flags & 0x40)
                rep.bones.setdefault(p, Bone(p, bone, _mat(data, p + 0x20), _mat(data, p + 0x60) if has_bind else None))
                children(p, p + (0xA0 if has_bind else 0x60), n, p, path, depth)
            else:
                children(p, p + 0x20, n, bone, path, depth)
        elif t == 0x15:
            # Entrada de paleta de pele (FUN_0021b3c0): u32 nº de filhos, u32 slot da paleta, filhos a partir
            # de +0x0C, inversa do bind do osso filho em +0x10. O nó tem 0x50 bytes: a malha que costuma vir
            # logo depois NÃO é dele (no Mr. Grimm 0x2f60 é a roda dianteira, filha do osso 0x38f0).
            rep.bones.setdefault(p, Bone(p, bone, _mat(data, p + 0x10), None))
            children(p, p + 0x0C, max(1, min(_u32(data, p + 4), 16)), p, path, depth)
        elif t == 0x14:  # invólucro -> +0x08
            c = ptr_at(p + 8)
            if c is not None:
                visit(c, bone, path, depth + 1)
        elif t == 0x05 and (word >> 24) == 0x06:
            # Seletor de pose (byte 3 = 0x06; ex.: braços/foice do Mr. Grimm): o filho ativo é estado do jogo
            # (campos +0x04..+0x0A zerados no arquivo). ⚠️ ESCOLHA DO HOST: pose base = 1º filho não vazio.
            for i in range(data[p + 0x0B]):
                c = ptr_at(p + 0x0C + 4 * i)
                if c is not None and _u32(data, c) & 0x3F != 0x08:
                    visit(c, bone, path, depth + 1)
                    break
        elif t == 0x05 and (word >> 24) == 0x01 and (c0 := ptr_at(p + 0x0C)) is not None                 and _u32(data, c0) & 0x3F != 0x08 and _subtree_tris(c0) > 500:
            # Seletor cujo 1º filho é a carroceria (hc_sweet/hc_chrom: forma normal × transformada).
            # ⚠️ ESCOLHA DO HOST: 1º filho = estado padrão, só quando é grande (> 500 tri); os pequenos
            # (14–38 tri, um por carro) ficam como efeito até achar o significado no ELF.
            visit(c0, bone, path, depth + 1)
        elif t == 0x05:  # slot de efeito: N filhos a partir de +0x0C (N no byte +0x0B); fora da pose base
            if p not in rep.effects:
                rep.effects[p] = []
                sink.append(rep.effects[p])
                children(p, p + 0x0C, data[p + 0x0B], bone, path, depth)
                sink.pop()
        elif t == 0x03 and place_objects:
            # Objeto posicionado (níveis): +0x10..+0x18 = posição (x, y, z); a malha filha costuma estar
            # centrada na origem (prédios/cúpula do Coliseu DM empilhados no centro sem isto). Quando a
            # subárvore já está no mundo (segmentos de Tóquio DM, pivôs), a posição não é aplicada.
            tr = struct.unpack_from("<3f", data, p + 0x10)
            n = _u32(data, p + 8)
            first = ptr_at(p + 0x1C)
            if any(abs(v) > 1.0 for v in tr) and first is not None:
                o = offsets[-1]
                offsets.append((o[0] + tr[0], o[1] + tr[1], o[2] + tr[2]))
                children(p, p + 0x1C, n, bone, path, depth)
                offsets.pop()
            else:
                children(p, p + 0x1C, n, bone, path, depth)
        elif t == 0x12:  # escala: +0x04 *animação?, +0x08 n, +0x20..+0x28 escala (x, y, z), n filhos em +0x2C
            children(p, p + 0x2C, _u32(data, p + 8), bone, path, depth)
        elif t == 0x03:  # N filhos a partir de +0x1C (parâmetros em +0x10..+0x1B: 🟡)
            children(p, p + 0x1C, _u32(data, p + 8), bone, path, depth)
        elif t == 0x1F and (word >> 24) == 0x06:
            # Condicional "de evento" (byte 3 = 0x06): figura que sai pela escotilha do hc_hears, peças do
            # hc_suv. Visível só quando o jogo liga a condição -> slot de efeito, fora da pose base. ⚠️
            if p not in rep.effects:
                rep.effects[p] = []
                sink.append(rep.effects[p])
                children(p, p + 0x1C, max(1, min(struct.unpack_from("<H", data, p + 0x0E)[0], 16)), bone, path, depth)
                sink.pop()
        elif t == 0x1F and place_objects:
            # Níveis: objeto posicionado com distância de desenho (+0x0C ≈ distância², ex. 0x1bf81 ≈ 338²)
            # e posição em +0x10..+0x18, como o 0x03 (prédios da cidade do Coliseu DM empilhados no centro).
            tr = struct.unpack_from("<3f", data, p + 0x10)
            first = ptr_at(p + 0x1C)
            if any(abs(v) > 1.0 for v in tr) and first is not None:
                o = offsets[-1]
                offsets.append((o[0] + tr[0], o[1] + tr[1], o[2] + tr[2]))
                children(p, p + 0x1C, 1, bone, path, depth)
                offsets.pop()
            else:
                children(p, p + 0x1C, 1, bone, path, depth)
        elif t == 0x1F:
            # FUN_0021b3c0: rotação s16 em +0x08/+0x0A/+0x0C, translação +0x10..+0x18 (aplicadas em tools/rig.py)
            # e u16 em +0x0E filhos a partir de +0x1C (Mr. Grimm 0x47e0: roda dianteira + 0x42b0).
            children(p, p + 0x1C, max(1, min(struct.unpack_from("<H", data, p + 0x0E)[0], 16)), bone, path, depth)
        elif t == 0x07:  # BSP (níveis): +0x04 frente, +0x08 trás, +0x10 esfera, +0x20 *plano
            children(p, p + 0x04, 2, bone, path, depth)
        elif t == 0x0A:  # plano/portal (níveis; 🟡 água/espelho?) — sem malha
            pass
        elif t == 0x13:  # estado de dano: entradas de 12 bytes (*filho, ?, limiar) em +0x10; 1ª = intacto
            children(p, p + 0x10, 1, bone, path, depth)
        elif t in (0x08, 0x0E, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1E):
            pass  # localizador, vazio (0x0E), marcador (0x17), partículas, gatilho (0x19), animação, colisão (0x1B, 0x1E)
        else:
            rep.unknown.setdefault(word, []).append(p)

    if root is not None:
        visit(root, -1, [], 0)
    else:
        # Cabeçalho do .ngp: u32 n + n raízes. Carros: [grupo visual, lista de objetos (0x06)];
        # níveis: grupos visuais, grade de colisão (0x0C), lista de objetos (0x06)…
        for r in roots(data):
            kind = _u32(data, r) & 0x3F
            if kind == 0x0C:
                # Grade de setores: u32 0x0C, u16 w, u16 h, f32 célula, f32 ?, 4 f32 limites, *A, *B, células…
                # Alguns níveis (ex.: Tokyo B) só alcançam o cenário pela lista de nós da grade, que fica
                # na memória entre min(A, B) e a grade. 🟡 layout das células ainda não decodificado.
                a, b = _u32(data, r + 0x20), _u32(data, r + 0x24)
                lo = min(x for x in (a, b) if x) if (a or b) else r
                for q in range(lo & ~3, r, 4):
                    if q in relocs:
                        c = _u32(data, q)
                        if c + 4 <= len(data) and _u32(data, c) & 0x3F in (0x01, 0x02, 0x07):
                            visit(c, -1, [], 0)
                continue
            if kind == 0x06:
                continue  # lista de objetos: exportada à parte (level_objects)
            visit(r, -1, [], 0)
    # A mesma malha pode ser alcançada por caminhos diferentes; como está no espaço do modelo, uma basta.
    # A varredura da grade de setores também alcança os filhos dos nós 0x03 pelos ponteiros, sem a
    # posição: a cópia na origem de uma malha que foi posicionada é descartada.
    placed = {i.mesh for i in rep.instances if any(i.offset)}
    rep.instances = [i for i in rep.instances if any(i.offset) or i.mesh not in placed]
    seen: set[tuple] = set()
    keyf = lambda i: (i.mesh, tuple(round(v, 2) for v in i.offset))  # noqa: E731
    rep.instances = [i for i in rep.instances if not (keyf(i) in seen or seen.add(keyf(i)))]
    return rep


def gs_state(data: bytes, p: int) -> dict[int, int] | None:
    """Pacote de estado do GS de um grupo: VIF (… FLUSH, DIRECT/DIRECTHL n) + GIF tag A+D + n escritas.

    Ex. (carros, camada de reflexo e clarão): ALPHA_1=0x44 (Cs-Cd)*As+Cd, TEST_1 (z ≥), ZBUF_1 ZMSK=1
    (não grava profundidade), CLAMP_1=0. Devolve {registrador: valor de 64 bits} ou None se não for um.
    """
    for q in range(p, min(p + 0x20, len(data) - 4), 4):
        code = _u32(data, q)
        if (code >> 24) & 0x7F in (0x50, 0x51) and code & 0xFFFF:
            g = q + 4
            g += -g % 16  # GIF tag alinhado em 16 bytes
            if g + 16 > len(data):
                return None
            lo, hi = struct.unpack_from("<QQ", data, g)
            nloop, flg, nreg, regs = lo & 0x7FFF, (lo >> 58) & 3, (lo >> 60) & 0xF, hi & 0xF
            if flg != 0 or nreg != 1 or regs != 0xE or not 1 <= nloop <= 16 or g + 16 * (nloop + 1) > len(data):
                return None
            out = {}
            for i in range(nloop):
                val, reg = struct.unpack_from("<QQ", data, g + 16 * (i + 1))
                out[reg & 0xFF] = val
            return out
    return None


def roots(data: bytes) -> list[int]:
    n = _u32(data, 0)
    if not 1 <= n <= 64:
        raise NgpFormatError(f"nº de raízes inválido: {n}")
    out = [_u32(data, 4 + 4 * i) for i in range(n)]
    return [r for r in out if 0 < r and r + 4 <= len(data)]


def level_objects(data: bytes) -> list[int]:
    """Objetos (tipo 0x11) das listas 0x06 entre as raízes: {u32 6, u32 n, n offsets} (nos níveis, não relocados).

    Nos carros a lista tem só o próprio objeto do carro — já coberto pela raiz visual.
    """
    out: list[int] = []
    for r in roots(data):
        if _u32(data, r) & 0xFF != 0x06:
            continue
        for i in range(_u32(data, r + 4)):
            o = _u32(data, r + 8 + 4 * i)
            if 0 < o and o + 4 <= len(data) and _u32(data, o) & 0xFF == 0x11:
                out.append(o)
    return out
