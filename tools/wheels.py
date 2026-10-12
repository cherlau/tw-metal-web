"""Posição de repouso das rodas dos carros (o jogo as move pela suspensão; o .ngp nem sempre traz a pose).

Estrutura no scene graph (evidência: Grasshopper, Hammerhead, Warthog, Crimson Fury — docs/FORMATS.md):
  nó 0x0D SEM matrizes, flags baixos 0x20/0x22 = SUSPENSÃO: +0x04 f32 x, +0x08 f32 y (sem z: vem da suspensão)
    └─ nó 0x0D COM matrizes (osso da roda): +0x20 inversa do bind, +0x60 bind
  (ou um só nó 0x0D com matrizes E bit 0x20, flags 0x1e1/0x1e5: x, y no próprio cabeçalho — Hearse)
         └─ malha da roda (vértices no espaço do modelo segundo a inversa: p_local = p + inv_t)

Casos:
  A. osso coerente (bind = inversa⁻¹) e perto da suspensão (ou sem suspensão): a malha já está no lugar.
  B. osso coerente, suspensão com x,y e osso fora dela (bind identidade/só o deslocamento do pneu): roda ficava na
     origem, escondida na carroceria (Hammerhead, dianteiras do Grasshopper) -> p + inv_t + (x, y, z).
  C. osso incoerente (bind ≠ inversa⁻¹) sem suspensão (Crimson Fury): roda solta fora do carro ->
     x, y do ponto de roda da tabela nativa de física (ELF 0x2ba990) no mesmo quadrante. Só vale
     com as 4 rodas (uma por quadrante); peça avulsa incoerente fica como está.
  D. rodas em nós 0x15 com o conjunto deslocado em x (ATV): recentraliza o conjunto em x = 0.
  E. 4 rodas empilhadas na origem sem pivô no arquivo (hc_suv, Thumper): pontos nativos da física + arco.

⚠️ ESCOLHA DO HOST (até achar no ELF o código que monta as rodas): a altura (z) nos casos B/C —
alinha a base do pneu com as rodas do caso A (com suspensão) do mesmo carro; sem nenhuma, z da tabela nativa
menos o deslocamento vertical nativo do corpo (`offset`).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np

import ngp

TOL_BIND = 0.05  # bind e inversa coerentes (por componente)
TOL_MOUNT = 1.0  # osso "em cima" da suspensão (o pneu pode ter deslocamento lateral)
MIN_MOUNT = 1.0  # suspensão no centro do carro não é roda (estepe, peças girantes)


@dataclass
class WheelFix:
    mesh: int
    case: str  # "B" | "C"
    offset: np.ndarray  # somado às posições da malha (coords do PS2)
    pivot: np.ndarray  # centro de repouso da roda


def _u32(b: bytes, p: int) -> int:
    return struct.unpack_from("<I", b, p)[0]


def _f32(b: bytes, p: int) -> float:
    return struct.unpack_from("<f", b, p)[0]


def _mount(data: bytes, path: list[int], bone: int) -> tuple[float, float] | None:
    """Nó de suspensão logo acima do osso da roda — ou o próprio osso, se tiver o bit 0x20 (Hearse)."""
    if bone not in path:
        return None
    flags = _u32(data, bone + 0x1C)
    if flags & 0x80 and flags & 0x20:
        x, y = _f32(data, bone + 4), _f32(data, bone + 8)
        if np.hypot(x, y) > MIN_MOUNT:
            return (x, y)
    for node in reversed(path[: path.index(bone)]):
        if _u32(data, node) & 0x3F != 0x0D:
            continue
        flags = _u32(data, node + 0x1C)
        if flags & 0x80:
            return None  # outro osso com matrizes antes da suspensão
        if flags & 0xFF in (0x20, 0x22):
            x, y = _f32(data, node + 4), _f32(data, node + 8)
            return (x, y) if np.hypot(x, y) > MIN_MOUNT else None
        return None
    return None


def _wheel_shaped(pos: np.ndarray) -> bool:
    """Cilindro com eixo em X (roda): y ≈ z e largura menor que o diâmetro."""
    size = pos.max(0) - pos.min(0)
    return size[1] > 0.8 and abs(size[1] - size[2]) < 0.2 * size[1] and size[0] < size[1] * 1.2


def plan(data: bytes, rep: ngp.SceneReport, meshes: dict[int, ngp.Mesh], native: dict | None) -> list[WheelFix]:
    pending: list[tuple[int, str, np.ndarray, np.ndarray, float]] = []  # mesh, caso, inv_t, pivô xy, raio
    good_bottoms: list[float] = []
    for inst in rep.instances:
        bone = rep.bones.get(inst.bone)
        m = meshes[inst.mesh]
        if bone is None or bone.bind is None or not m.strips:
            continue
        pos = np.concatenate([np.asarray(s.pos)[:, :3] for s in m.strips])
        if not _wheel_shaped(pos):
            continue
        radius = float((pos[:, 1].max() - pos[:, 1].min()) / 2)
        inv_t, bind_t = bone.inv_bind[3, :3], bone.bind[3, :3]
        coherent = bool(np.all(np.abs(bind_t + inv_t) < TOL_BIND))
        mount = _mount(data, inst.path, inst.bone)
        if coherent and (mount is None or np.all(np.abs(bind_t[:2] - mount) < TOL_MOUNT)):
            if mount is not None:  # caso A numa suspensão: referência de altura (estepe etc. não contam)
                good_bottoms.append(float(pos[:, 2].min()))
        elif coherent and mount is not None:
            pending.append((inst.mesh, "B", inv_t, np.array(mount), radius))
        elif not coherent and native:
            q = -inv_t  # onde os vértices estão hoje: dá o quadrante
            w = next((w for w in native["wheels"] if np.sign(w[0]) == np.sign(q[0]) and np.sign(w[1]) == np.sign(q[1])), None)
            if w is not None:
                pending.append((inst.mesh, "C", inv_t, np.array(w[:2], dtype=np.float64), radius))
    # Caso C só como conjunto completo: 4 rodas incoerentes, uma por quadrante (senão é outra peça).
    c = [x for x in pending if x[1] == "C"]
    if len(c) != 4 or len({(np.sign(x[3][0]), np.sign(x[3][1])) for x in c}) != 4:
        pending = [x for x in pending if x[1] != "C"]
    fixes: list[WheelFix] = []
    # D. rodas embutidas em nós 0x15 (só inversa, sem bind) com o conjunto todo deslocado em x (ATV do
    # Eddy: centros em x 3,8/8,0 e y ±2,87 simétricos). Os carros são simétricos em x, então o conjunto
    # é recentralizado em x = 0. ⚠️ ESCOLHA DO HOST até achar a origem do deslocamento na decodificação.
    d_set = []
    for inst in rep.instances:
        bone = rep.bones.get(inst.bone)
        m = meshes[inst.mesh]
        if bone is None or bone.bind is not None or not m.strips:
            continue
        pos = np.concatenate([np.asarray(s.pos)[:, :3] for s in m.strips])
        if _wheel_shaped(pos):
            d_set.append((inst.mesh, (pos.max(0) + pos.min(0)) / 2, float(pos[:, 1].max() - pos[:, 1].min())))
    if d_set:  # só o grupo de rodas: mesma altura e diâmetro (descarta torso/peças redondas)
        mz = float(np.median([c[2] for _, c, _ in d_set]))
        md = float(np.median([dia for _, _, dia in d_set]))
        d_set = [(m, c) for m, c, dia in d_set if abs(c[2] - mz) < 0.5 and abs(dia - md) < 0.3 * md]
    if len(d_set) >= 4:
        cx = float(np.mean([c[0] for _, c in d_set]))
        ys = sorted(c[1] for _, c in d_set)
        if abs(cx) > 1.0 and ys[0] < -1.0 < 1.0 < ys[-1]:
            for mesh, c in d_set:
                fixes.append(WheelFix(mesh, "D", np.array([-cx, 0.0, 0.0]), c - np.array([cx, 0.0, 0.0])))
    # E. 4 rodas empilhadas na origem, ossos sem pivô (hc_suv, Thumper: o cabeçalho traz índices de canal,
    # não coordenadas) -> pontos de roda da tabela nativa de física. Canto: lado pelo sinal do pequeno
    # deslocamento lateral do pneu (±0,1); frente/trás pelo bit 2 das flags do osso (0x1fd frente, 0x1f9
    # trás — hipótese; rodas iguais na frente e atrás tornam o erro invisível). ⚠️ ESCOLHA DO HOST.
    taken = {x[0] for x in pending} | {f.mesh for f in fixes}
    stack = []
    for inst in rep.instances:
        m = meshes[inst.mesh]
        if inst.mesh in taken or not m.strips or inst.bone not in rep.bones:
            continue
        pos = np.concatenate([np.asarray(s.pos)[:, :3] for s in m.strips])
        c = (pos.max(0) + pos.min(0)) / 2
        if _wheel_shaped(pos) and np.all(np.abs(c) < 0.3):
            front = bool(_u32(data, inst.bone + 0x1C) & 0x04) if _u32(data, inst.bone) & 0x3F == 0x0D else None
            stack.append((inst.mesh, float(np.ptp(pos[:, 1])), float(c[0]), front))
    if native and len(stack) == 4:
        dias = [s[1] for s in stack]
        if max(dias) <= 1.1 * min(dias):
            corners = []
            for i, (mesh, dia, cx, front) in enumerate(stack):
                sx = np.sign(cx) if abs(cx) > 0.02 else (1 if i % 2 == 0 else -1)
                sy = (1 if front else -1) if front is not None else (1 if i < 2 else -1)
                corners.append((sx, sy))
            if len(set(corners)) != 4:  # sem pistas confiáveis: ordem da tabela
                corners = [(np.sign(w[0]), np.sign(w[1])) for w in native["wheels"]]
            for (mesh, dia, _, _), (sx, sy) in zip(stack, corners):
                w = next((w for w in native["wheels"] if np.sign(w[0]) == sx and np.sign(w[1]) == sy), None)
                if w is not None:
                    pending.append((mesh, "E", np.zeros(3), np.array(w[:2], dtype=np.float64), dia / 2))
    skip = {x[0] for x in pending} | {f.mesh for f in fixes}
    body = _body_vertices(rep, meshes, skip)
    tris = _body_triangles(rep, meshes, skip)
    b_fixes: list[WheelFix] = []
    fitted: list[tuple[int, str, np.ndarray, np.ndarray, tuple[float, float] | None]] = []
    for mesh, case, inv_t, xy, radius in pending:
        if case in ("C", "E"):
            # Pontos nativos são de física (arredondados): encaixa a roda no arco da carroceria.
            hw = float(np.ptp(np.concatenate([np.asarray(s.pos)[:, 0] for s in meshes[mesh].strips]))) / 2
            # E: sem nenhuma pista no arquivo, o ponto de física pode cair fora da carroceria (Thumper:
            # y ±9,7 num carro de meio-comprimento 8,65) -> procura o arco mais longe.
            fit = _fit_arch(body, float(xy[0]), float(xy[1]), radius, hw)
            if fit is None and case == "E":
                # Ponto de física fora da carroceria (Thumper: y ±9,7 num carro de meio-comprimento 8,65):
                # procura o arco na metade inteira do carro (frente ou trás), com o pneu por dentro da lateral.
                xin = float(np.sign(xy[0])) * min(abs(float(xy[0])), float(np.abs(body[:, 0]).max()) - hw)
                end = float(body[:, 1].max() if xy[1] > 0 else body[:, 1].min())
                # rodas ficam entre 30% e 100% do meio-comprimento (fora disso: portas, bico)
                fit = _fit_arch(body, xin, end * 0.65, radius, hw, reach=abs(end) * 0.35)
            if fit is not None and case == "C":
                # Relato do usuário (2026-10-11): o encaixe deixou a dianteira atrás e a traseira à frente
                # do lugar; fica no meio do caminho entre o arco e o ponto nativo. ⚠️ ESCOLHA DO HOST.
                fit = ((fit[0] + float(xy[1])) / 2, fit[1])
            fitted.append((mesh, case, inv_t, xy, fit))
            continue
        if good_bottoms:
            z = min(good_bottoms) + radius
        elif native:
            z = native["wheels"][0][2] - native.get("offset", [0, 0, 0])[2]
        else:
            continue
        pivot = np.array([xy[0], xy[1], z])
        (b_fixes if case == "B" else fixes).append(WheelFix(mesh, case, inv_t + pivot, pivot))
    # Altura vinda das rodas certas do próprio carro (Grasshopper) é evidência melhor: só assenta sem elas.
    fixes += b_fixes if good_bottoms else _settle(b_fixes, meshes, body, tris)
    fixes += _symmetric(fitted, native)
    return fixes


def _symmetric(fitted, native: dict | None) -> list[WheelFix]:
    """Rodas encaixadas no arco (casos C/E): o carro é simétrico, então cada eixo (frente/trás) usa a
    mediana de |y| e de z das rodas que encaixaram; eixo sem encaixe usa o z do outro (ou o nativo)."""
    out = []
    axes: dict[float, list] = {}
    for item in fitted:
        axes.setdefault(float(np.sign(item[3][1])), []).append(item)
    zs_all = [f[4][1] for f in fitted if f[4] is not None]
    for sy, items in axes.items():
        ok = [f[4] for f in items if f[4] is not None]
        if ok:
            y = sy * float(np.median([abs(o[0]) for o in ok]))
            z = float(np.median([o[1] for o in ok]))
        elif zs_all:
            y, z = float(items[0][3][1]), float(np.median(zs_all))
        elif native:
            y, z = float(items[0][3][1]), native["wheels"][0][2] - native.get("offset", [0, 0, 0])[2]
        else:
            continue
        for mesh, case, inv_t, xy, _ in items:
            pivot = np.array([xy[0], y, z])
            out.append(WheelFix(mesh, case, inv_t + pivot, pivot))
    return out


def _settle(b_fixes: list[WheelFix], meshes: dict[int, ngp.Mesh], body: np.ndarray, tris: np.ndarray) -> list[WheelFix]:
    """Caso B: a altura vinha de uma estimativa (rodas do caso A / tabela nativa). Só ABAIXA, com evidência:
    1. cubo: pontas de geometria na coluna do pneu > 1,5 abaixo do centro (braços do Hammerhead) -> centro lá;
    2. arco atravessado: superfície acima do centro mas abaixo do topo do pneu (Sweet Tooth) -> topo encosta nela.
    As rodas do carro descem juntas (mediana), preservando as alturas relativas. ⚠️ ESCOLHA DO HOST."""
    dzs = []
    for f in b_fixes:
        pos = np.concatenate([np.asarray(s.pos)[:, :3] for s in meshes[f.mesh].strips]) + f.offset
        r = float(np.ptp(pos[:, 1])) / 2
        x0, x1 = float(pos[:, 0].min()), float(pos[:, 0].max())
        cz = float(f.pivot[2])
        col = body[(body[:, 0] > x0 - 0.2) & (body[:, 0] < x1 + 0.2) & (np.abs(body[:, 1] - f.pivot[1]) < 0.6)]
        low = col[col[:, 2] < cz - 1.5][:, 2]
        if len(low):
            dzs.append(float(np.mean(low[low < low.min() + 0.5])) - cz)
            continue
        above = [h for h in _ray_up(tris, (x0 + x1) / 2, float(f.pivot[1])) if cz + 0.3 * r < h < cz + r]
        dzs.append(min(0.0, above[0] - ARCH_GAP - (cz + r)) if above else 0.0)
    dz = float(np.median(dzs)) if dzs else 0.0
    if dz > -0.05:
        return b_fixes
    move = np.array([0.0, 0.0, dz])
    return [WheelFix(f.mesh, f.case, f.offset + move, f.pivot + move) for f in b_fixes]


def _body_triangles(rep: ngp.SceneReport, meshes: dict[int, ngp.Mesh], skip: set[int]) -> np.ndarray:
    out = []
    for inst in rep.instances:
        m = meshes[inst.mesh]
        if inst.mesh in skip or not m.strips or m.flags & 0x8000:
            continue
        attrs, idx = m.triangles()
        if not len(idx) or _wheel_shaped(attrs["position"]):
            continue
        out.append(attrs["position"][idx.reshape(-1, 3)])
    return np.concatenate(out) if out else np.zeros((0, 3, 3))


def _ray_up(tris: np.ndarray, x: float, y: float) -> list[float]:
    """Alturas (z) em que a vertical por (x, y) cruza a carroceria, de baixo para cima."""
    if not len(tris):
        return []
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    v0, v1, v2 = c[:, :2] - a[:, :2], b[:, :2] - a[:, :2], np.array([x, y]) - a[:, :2]
    d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
    d20, d21 = (v2 * v0).sum(1), (v2 * v1).sum(1)
    den = d00 * d11 - d01 * d01
    ok = np.abs(den) > 1e-12
    safe = np.where(ok, den, 1.0)
    u = (d11 * d20 - d01 * d21) / safe
    v = (d00 * d21 - d01 * d20) / safe
    inside = ok & (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1 + 1e-6)
    z = a[:, 2] + u * (c[:, 2] - a[:, 2]) + v * (b[:, 2] - a[:, 2])
    return sorted(float(h) for h in z[inside])


ARCH_GAP = 0.1  # folga entre o topo do pneu e o arco (Cop/Grasshopper: 0–0,2)


def _body_vertices(rep: ngp.SceneReport, meshes: dict[int, ngp.Mesh], skip: set[int]) -> np.ndarray:
    """Vértices sólidos da pose base, sem as rodas (para achar os arcos)."""
    out = []
    for inst in rep.instances:
        m = meshes[inst.mesh]
        if inst.mesh in skip or not m.strips or m.flags & 0x8000:
            continue
        pos = np.concatenate([np.asarray(s.pos)[:, :3] for s in m.strips])
        if not _wheel_shaped(pos):
            out.append(pos)
    return np.concatenate(out) if out else np.zeros((0, 3))


def _fit_arch(body: np.ndarray, x: float, y: float, radius: float, hw: float, reach: float = 1.5) -> tuple[float, float] | None:
    """Arco da roda perto de (x, y). Na coluna do pneu, o ponto mais baixo da carroceria é o topo do arco
    dentro da abertura e a borda do para-lama fora dela: o arco é um PICO de h(y) com a carroceria mais
    baixa dos dois lados (antes e depois da abertura). Entre os picos a até ±1,5 do ponto nativo, fica o
    mais alto; topo do pneu = arco − folga. Evidência: nos carros certos o topo do pneu encosta no arco."""
    if not len(body):
        return None
    limit = float(np.percentile(body[:, 2], 75))  # ignora colunas que só pegam teto/aerofólio
    near_x = body[np.abs(body[:, 0] - x) < max(hw, 0.3)]
    ys = np.round(np.arange(y - reach - 1.5, y + reach + 1.51, 0.1), 2)
    h = {}
    for yy in ys:
        col = near_x[np.abs(near_x[:, 1] - yy) < 0.3]
        if len(col):
            h[float(yy)] = float(col[:, 2].min())
    best = None
    for yy, hh in h.items():
        if abs(yy - y) > reach or hh >= limit:
            continue
        lower_before = any(v < hh - 0.2 for k, v in h.items() if yy - 2.5 <= k < yy)
        lower_after = any(v < hh - 0.2 for k, v in h.items() if yy < k <= yy + 2.5)
        if lower_before and lower_after and (best is None or hh > best[1] + 1e-6):
            best = (yy, hh)
    if best is None:
        return None
    # Arco em platô (saia do para-lama do Thumper): centro do trecho contínuo com a mesma altura.
    plateau = [best[0]]
    for direction in (-0.1, 0.1):
        yy = round(best[0] + direction, 2)
        while yy in h and abs(h[yy] - best[1]) < 0.05:
            plateau.append(yy)
            yy = round(yy + direction, 2)
    return float(np.mean(plateau)), best[1] - ARCH_GAP - radius
