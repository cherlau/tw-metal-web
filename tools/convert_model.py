"""Converte um modelo .ngp+.ptr+.tex (carro, nível…) de source/game/<dir>/<nome>/ para public/assets/<dir>/<nome>.json + .bin.

Formato (SPEC §7.1): .bin little-endian com atributos float32 / índices uint32 alinhados a 4 bytes;
.json com spans [byteOffset, count]. Coordenadas ainda no espaço ORIGINAL do PS2 (sem conversão
de mão): o runtime aplica a regra única definida em src/coords.ts até a regra ser confirmada.

Uso: python tools/convert_model.py axel [--dir cars|aicars|lvl]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import struct
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ngp  # noqa: E402
import tex  # noqa: E402
import actions  # noqa: E402
import hud  # noqa: E402
import launchers  # noqa: E402
import rig  # noqa: E402
import wheels  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "source" / "game"
ASSETS = ROOT / "public" / "assets"


# Texturas de EFEITO que o código do jogo liga sob demanda e que não passam por um slot 0x05.
# ESCOLHA DO HOST (evidência: mesmas texturas de gelo em vários carros, cobrindo o carro inteiro);
# confirmar no ELF (Fase 4) e trocar por regra nativa.
CODE_FX_TEXTURES = {
    0x88A28: "freeze",  # cristais de gelo (casca do congelamento)
    0xB5A20: "freeze",  # espinhos de gelo
    # Clarão do tiro (cones aditivos nas bocas das armas, 4 por carro): ligado ao atirar.
    # Evidência: a mesma imagem (textures/533e799f…) em 66 modelos de carro, nunca nos níveis.
    0x8A480: "muzzle",
    0x8FED0: "muzzle",
    0x9DEE4: "muzzle",  # Tank Car (outra imagem de clarão, mesmos 4 cones de 3 tri)
}


# Peças sem pose de repouso no arquivo (ossos incoerentes, mecanismo animado), que flutuavam fora da
# carroceria. ⚠️ ESCOLHA DO HOST por modelo (relato do usuário, 2026-10-11): fora da pose base -> effects.
HIDDEN_PARTS = {
    "hearse": {0x6E60, 0x7180, 0x8880, 0x8C00},  # barras do mecanismo traseiro (acima do teto / abaixo do carro)
    "thump": {0x6DC0},  # macaco hidráulico central estendido (desce até z −4,1, abaixo das rodas)
}


def gs_blend(regs: dict[int, int]) -> dict:
    """ALPHA_1 (0x42) e ZBUF_1 (0x4E) do pacote de estado -> mistura/profundidade para o runtime."""
    out: dict = {}
    if 0x42 in regs:
        a = regs[0x42]
        out["alpha"] = [a & 3, (a >> 2) & 3, (a >> 4) & 3, (a >> 6) & 3, (a >> 32) & 0xFF]  # A, B, C, D, FIX
    if 0x4E in regs:
        out["zwrite"] = not (regs[0x4E] >> 32) & 1
    return out


# Listas de pontos das arenas: u32 versão (data), 3× u32 n, n registros; vec3 f32 no início de cada registro.
POINT_LISTS = {"spt": 64, "pkp": 64, "pts": 32, "gps": 80}


def read_points(path: Path, stride: int) -> list[dict]:
    d = path.read_bytes()
    _ver, n, n2, n3 = struct.unpack_from("<4I", d, 0)
    if not (n == n2 == n3) or 16 + n * stride != len(d):
        raise ValueError(f"{path.name}: lista de pontos inconsistente (n={n}, {len(d)} bytes, stride {stride})")
    out = []
    for i in range(n):
        p = 16 + i * stride
        pos = struct.unpack_from("<3f", d, p)
        raw = struct.unpack_from(f"<{(stride - 12) // 4}I", d, p + 12)
        out.append({"pos": [round(v, 4) for v in pos], "raw": [f"{w:x}" for w in raw]})  # raw: 🟡 a decodificar
    return out


class BinWriter:
    def __init__(self) -> None:
        self.buf = bytearray()

    def add(self, arr: np.ndarray) -> list[int]:
        arr = np.ascontiguousarray(arr)
        offset = len(self.buf)
        self.buf += arr.tobytes()
        self.buf += b"\0" * (-len(self.buf) % 4)
        return [offset, int(arr.size)]


def save_texture(t: tex.Texture) -> dict:
    png = io.BytesIO()
    Image.fromarray(t.rgba, "RGBA").save(png, "PNG", optimize=True)
    data = png.getvalue()
    name = f"textures/{hashlib.sha256(t.rgba.tobytes()).hexdigest()[:20]}.png"
    target = ASSETS / name
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    alpha = t.rgba[..., 3]
    return {
        "url": name,
        "width": t.width,
        "height": t.height,
        "bpp": t.bpp,
        "alpha": "opaque" if alpha.min() == 255 else ("cutout" if np.isin(alpha, (0, 255)).all() else "blend"),
    }


def token_stream(data: bytes, p: int, limit: int = 4096) -> list:
    """Fluxo de fichas dos roteiros (FUN_00231f80/FUN_00231fc0/FUN_00232170): blocos [tipo u8, n u8]; tipo 1 = n
    floats (alinhados a 4 depois do cabeçalho), 2 = n strings com tamanho no 1º byte, 0 = fim."""
    out: list = []
    while len(out) < limit and p + 2 <= len(data):
        kind, n = data[p], data[p + 1]
        if kind == 1:
            p = (p + 5) & ~3
            out.extend(struct.unpack_from(f"<{n}f", data, p))
            p += 4 * n
        elif kind == 2:
            p += 2
            for _ in range(n):
                size = data[p]
                out.append(data[p + 1:p + size].split(b"\0")[0].decode("latin-1"))
                p += size
        else:
            break
    return out


def convert(name: str, folder: str) -> dict:
    base = SOURCE / folder / name

    def section(kind: str) -> bytes:
        # O nome da seção nem sempre é o do BDD (ex.: aicars/thump.bdd -> thumpai.ngp).
        found = sorted(base.glob(f"*.{kind}"))
        if len(found) != 1:
            raise FileNotFoundError(f"{base}: esperava 1 seção .{kind}, achei {len(found)}")
        return found[0].read_bytes()

    ngp_bytes, ptr_bytes, tex_bytes = section("ngp"), section("ptr"), section("tex")

    textures = {f"{t.id:x}": save_texture(t) for t in tex.decode(tex_bytes)}
    meshes = ngp.find_meshes(ngp_bytes, ptr_bytes)
    errors: list[str] = []
    # Carros e níveis: todas as entradas dos nós 0x13 (carros: pela vida, FUN_0012e8c0; níveis: destrutíveis
    # por golpe, FUN_00168aa8 → FUN_00171838).
    # Carros: seletores 0x05 com todos os filhos (o runtime mostra o do estado; FUN_0022cd58 / FUN_00230138).
    scene_rep = ngp.scene(ngp_bytes, ptr_bytes, meshes, place_objects=folder == "lvl",
                          damage_states=folder in ("cars", "aicars", "lvl"), selectors=folder in ("cars", "aicars"))
    # GLOBALS: peças do HUD presas à câmera (tools/hud.py; FUN_0013b310 / FUN_0019e580).
    hud_json, hud_insts = hud.export(ngp_bytes, ptr_bytes, meshes) if folder == "globals" else ({}, [])
    # Estado do GS herdado do grupo (camada de reflexo: mistura pelo alfa de vértice, sem gravar z).
    mesh_state: dict[int, dict] = {}
    for inst in scene_rep.instances + scene_rep.damaged + scene_rep.selected + [i for v in scene_rep.effects.values() for i in v] + hud_insts:
        if inst.state >= 0 and inst.mesh not in mesh_state:
            regs = ngp.gs_state(ngp_bytes, inst.state)
            if regs:
                mesh_state[inst.mesh] = gs_blend(regs)
    # Camada de reflexo (flag de malha bit 1) sem grupo de estado, mas com alfa de vértice < 0,9 (Twister:
    # 0,297 como nos demais): recebe o mesmo estado dos outros carros (ALPHA_1=0x44, ZMSK). ⚠️ host.
    for inst in scene_rep.instances + scene_rep.damaged + scene_rep.selected:
        m = next((x for x in meshes if x.offset == inst.mesh), None)
        if m is None or inst.mesh in mesh_state or not m.flags & 2 or not m.strips:
            continue
        if float(m.triangles()[0]["color"][:, 3].max()) < 0.9:
            mesh_state[inst.mesh] = {"alpha": [0, 1, 0, 1, 64], "zwrite": False}
    # Rodas sem pose de repouso no .ngp (tools/wheels.py): deslocamento somado às posições da malha.
    wheel_fixes: dict[int, wheels.WheelFix] = {}
    # Carros: esqueleto e clipes do jogo (tools/rig.py) — o runtime posiciona rodas/lançadores pelos canais,
    # então as regras do host (wheels.py, launchers.py, HIDDEN_PARTS) não são aplicadas.
    use_rig = folder in ("cars", "aicars")
    if folder in ("cars", "aicars"):
        rules_path = ASSETS / "rules" / "vehicles.json"
        native = json.loads(rules_path.read_text("utf-8"))["vehicles"].get(name) if rules_path.exists() else None
        wheel_fixes = {f.mesh: f for f in wheels.plan(ngp_bytes, scene_rep, {m.offset: m for m in meshes}, native)
                       if not use_rig}  # com esqueleto as rodas vêm dos ossos (o ATV também, com os nós 0x03)
    # Malha sem textura no cabeçalho (nenhum TEX0 no pacote): o GS continua com a última textura ligada. Nos
    # carros, a ordem do percurso dá a anterior (giroflex da viatura: atlas da carroceria). Evidência: malhas
    # 0x800310 sem id de textura, com UV dentro do atlas.
    inherited: dict[int, int] = {}
    if folder in ("cars", "aicars"):
        last = 0
        for inst in scene_rep.instances + scene_rep.damaged + scene_rep.selected:
            m = next((x for x in meshes if x.offset == inst.mesh), None)
            if m is None or not m.strips:
                continue
            if m.textures:  # textura do último strip desenhado
                last = m.textures[min(m.strips[-1].texture, len(m.textures) - 1)]
            elif last and inst.mesh not in inherited:
                inherited[inst.mesh] = last
    out = BinWriter()
    mesh_json = {}
    for m in meshes:
        key = f"m{m.offset:06x}"
        tex_key = f"{m.texture_id:x}"
        for tid in m.textures:
            if tid and f"{tid:x}" not in textures:
                errors.append(f"{key}: textura {tid:x} ausente no .tex")
        entry: dict = {
            "offset": m.offset,
            "flags": m.flags,
            "texture": tex_key if m.texture_id else None,
            "texture2": f"{m.texture2:x}" if m.texture2 else None,
            "textures": [f"{t:x}" for t in m.textures],
            "scale": m.scale,
            "packed": m.packed,
            "poolOwner": f"m{m.pool_owner:06x}" if m.pool_owner >= 0 else None,
            "sphere": [round(v, 5) for v in m.sphere],
        }
        if m.offset in mesh_state:
            entry["gs"] = mesh_state[m.offset]
        if (mat := ngp.material_channels(ngp_bytes, m.offset)) is not None:
            entry["mat"] = mat  # canais do objeto dono: [U, V, R, G, B, alfa] (FUN_0024baa8)
        if m.strips:
            # Uma parte por slot de textura (o cabeçalho de cada strip escolhe a textura).
            entry["parts"] = []
            for slot in m.texture_slots():
                if slot >= max(1, len(m.textures)):
                    errors.append(f"{key}: strip usa textura #{slot}, cabeçalho tem {len(m.textures)}")
                    continue
                attrs, indices = m.triangles(slot)
                if not len(indices):
                    continue
                if m.offset in wheel_fixes:
                    attrs["position"] = (attrs["position"] + wheel_fixes[m.offset].offset).astype(np.float32)
                entry["parts"].append({
                    "texture": f"{m.textures[slot]:x}" if m.textures else
                    (f"{inherited[m.offset]:x}" if m.offset in inherited else None),
                    "attributes": {
                        "position": out.add(attrs["position"]),
                        "normal": out.add(attrs["normal"]),
                        "uv": out.add(attrs["uv"]),
                        # Com estado do GS a cor leva o alfa (128 = 1,0), que controla a mistura.
                        **({"colorA": out.add(attrs["color"])} if m.offset in mesh_state
                           else {"color": out.add(attrs["color"][:, :3])}),
                        "indices": out.add(indices.astype(np.uint32)),
                    },
                })
        if m.sprites:
            entry["sprites"] = [
                {"center": s.center, "size": s.size, "color": s.color, "uv": s.uv} for s in m.sprites
            ]
        if m.beams:
            entry["beams"] = [
                {"points": b.points, "colors": b.colors, "uvs": b.uvs} for b in m.beams
            ]
        mesh_json[key] = entry

    by_offset = {m.offset: m for m in meshes}

    def code_fx(inst) -> str | None:
        kinds = {CODE_FX_TEXTURES.get(t) for t in by_offset[inst.mesh].textures} or {None}
        return kinds.pop() if len(kinds) == 1 else None

    # Níveis: céu e modelos dinâmicos parados na origem saem da cena estática.
    sky: list[ngp.Instance] = []
    if folder == "lvl":
        for inst in list(scene_rep.instances):
            m = by_offset[inst.mesh]
            if not m.strips or any(inst.offset) or inst.matrix is not None:
                continue
            pos = np.concatenate([np.asarray(st.pos)[:, :3] for st in m.strips])
            c, size = (pos.min(0) + pos.max(0)) / 2, pos.max(0) - pos.min(0)
            # Céu (Coliseu/Transilvânia/Grécia DM): cúpula 412×412 + tampa 333×333 centradas na origem,
            # flag de malha bit 31; o PS2 desenha centrado na câmera. Evidência: mesma forma em 3 arenas.
            if m.flags & 0x80000000 and np.hypot(c[0], c[1]) < 2.0 and min(size[0], size[1]) > 300:
                scene_rep.instances.remove(inst)
                sky.append(inst)
            # Modelo dinâmico parado na origem (helicóptero da polícia, textura "POLICE"): ⚠️ host.
            elif float(np.linalg.norm(c)) < 25.0 and float(size.max()) < 40.0:
                scene_rep.instances.remove(inst)
                scene_rep.code_effects.setdefault("prefab", []).append(inst)
    for inst in list(scene_rep.instances):
        kind = code_fx(inst)
        # Fachos de farol (aditivos, flags 0x8a00): nos outros carros ficam em slots 0x05 desligados; no
        # Hammerhead caíram na pose base (feixe branco na frente do para-brisa). ⚠️ ESCOLHA DO HOST.
        if not kind and folder in ("cars", "aicars") and by_offset[inst.mesh].flags & 0xFFFF == 0x8A00:
            kind = "beam"
        if not kind and not use_rig and inst.mesh in HIDDEN_PARTS.get(name, set()):
            kind = "hidden"
        # Carros: subárvores de escala (nó 0x12) são modelos de arma com a textura dos ícones de pickup
        # (mísseis no meio do Axel) mostrados pelo código ao usar a arma -> fora da pose base. ⚠️ host.
        if not kind and folder in ("cars", "aicars") and any(
                struct.unpack_from("<I", ngp_bytes, n)[0] & 0x3F == 0x12 for n in inst.path[:-1]):
            kind = "weapon"
        if kind:
            scene_rep.instances.remove(inst)
            scene_rep.code_effects.setdefault(kind, []).append(inst)
    # Estados de dano: as mesmas peças ligadas pelo código (fachos, armas, clarão) ficam fora.
    scene_rep.damaged = [i for i in scene_rep.damaged if not code_fx(i)
                         and by_offset[i.mesh].flags & 0xFFFF != 0x8A00
                         and not any(struct.unpack_from("<I", ngp_bytes, n)[0] & 0x3F == 0x12 for n in i.path[:-1])]
    # Seletores: o clarão do tiro (texturas de código) continua ligado pelo runtime, fora do seletor.
    for inst in list(scene_rep.selected):
        kind = code_fx(inst)
        if kind:
            scene_rep.selected.remove(inst)
            scene_rep.code_effects.setdefault(kind, []).append(inst)

    def category_objects_json() -> dict[str, list[dict]]:
        """GLOBALS: 1º nó de cada categoria que o jogo registra por código — modelos dos projéteis (FUN_00204778:
        4000..4099 no Head-On, 0x1004.. no Harbor City) e ícones dos pickups (FUN_001bdad0: 0x13ba + tipo no
        Head-On, 5000 + tipo no Harbor City). Instâncias relativas ao nó da categoria."""
        if folder != "globals":
            return {}

        def wanted(c: int) -> bool:
            return 4000 <= c < 4100 or 0x1004 <= c < 0x1068 or 5000 <= c < 5050 or 0x13BA <= c < 0x13E2

        first: dict[int, int] = {}
        for inst in scene_rep.instances + scene_rep.selected:
            for n in inst.path:
                c = struct.unpack_from("<I", ngp_bytes, n)[0] >> 18
                if wanted(c) and c not in first:
                    first[c] = n
        out: dict[str, list[dict]] = {}
        for c, node in sorted(first.items()):
            rep = ngp.scene(ngp_bytes, ptr_bytes, meshes, root=node, lenient=True)
            insts = [inst_json(i) for i in rep.instances if f"m{i.mesh:06x}" in mesh_json]
            if insts:
                out[f"{c:x}"] = insts
        return out

    def level_objects_json() -> list[dict]:
        base = {i.mesh for i in scene_rep.instances}
        out = []
        for node in ngp.level_objects(ngp_bytes):
            rep = ngp.scene(ngp_bytes, ptr_bytes, meshes, root=node, lenient=True)
            insts = [{"mesh": f"m{i.mesh:06x}", "bone": f"n{i.bone:06x}" if i.bone >= 0 else None} for i in rep.instances]
            out.append({
                "node": f"n{node:06x}",
                "inScene": bool(insts) and all(int(i["mesh"][1:], 16) in base for i in insts),
                "instances": insts,
            })
        return out

    def weapon_mounts() -> dict[str, list[float]]:
        """Pontos de montagem das armas (carros): registros 0x00F8xxxx — slot = (word & 0xFFFF) >> 6, que é o
        id do pickup (4 Napalm no alto da traseira; 2/3 e 5/6 nas laterais); posição (x, y, z) em +0x10."""
        relocs = ngp.relocations(ngp_bytes, ptr_bytes)
        out: dict[str, list[float]] = {}
        for q in relocs:
            n = struct.unpack_from("<I", ngp_bytes, q)[0]
            if n + 0x20 > len(ngp_bytes):
                continue
            w = struct.unpack_from("<I", ngp_bytes, n)[0]
            if w >> 16 == 0x00F8 and w & 0x3F == 0x03:
                xyz = struct.unpack_from("<3f", ngp_bytes, n + 0x10)
                out.setdefault(str((w & 0xFFFF) >> 6), [round(float(v), 4) for v in xyz])
        return dict(sorted(out.items(), key=lambda kv: int(kv[0])))

    # Lançadores (carros): base + portas que abrem ao disparar, posicionados no ponto de montagem.
    launcher_list: list = []
    if folder in ("cars", "aicars") and not use_rig:
        launcher_list = launchers.find(ngp_bytes, ptr_bytes, by_offset, scene_rep, weapon_mounts())
        moved = {m for la in launcher_list for m in la.meshes} | {m for la in launcher_list for m, _ in la.doors}
        scene_rep.instances = [i for i in scene_rep.instances if i.mesh not in moved]

    rig_bones: list = []
    rig_index: dict[int, int] = {}
    rig_json = None
    if use_rig:
        all_insts = scene_rep.instances + scene_rep.damaged + scene_rep.selected +             [i for v in scene_rep.effects.values() for i in v] + [i for v in scene_rep.code_effects.values() for i in v]
        # Ossos sem malha que carregam marcadores 0x00F0 (ex.: ponta da garra do Ricochet no Roadkill) também
        # entram, depois dos das malhas — senão o projétil fica na origem do carro.
        marker_paths = [SimpleNamespace(path=path) for _, path in scene_rep.markers]
        rig_bones, rig_index = rig.build(ngp_bytes, all_insts + marker_paths)
        clip_list = rig.clips(ngp_bytes, ptr_bytes)
        wheel_like = set()
        for i in all_insts:
            mm = by_offset[i.mesh]
            if mm.strips:
                pos = np.concatenate([np.asarray(st.pos)[:, :3] for st in mm.strips])
                sz = pos.max(0) - pos.min(0)
                if sz[1] > 0.8 and abs(sz[1] - sz[2]) < 0.25 * sz[1] and sz[0] < sz[1] * 1.3:
                    k = rig.leaf_bone(ngp_bytes, i, rig_index)
                    while k >= 0:
                        wheel_like.add(k)
                        k = rig_bones[k].parent
        vehicle = 0x65 + native["id"] if native else None  # tipo do veículo no jogo (tabela 0x2ba990)
        clip_json = rig.classify(rig_bones, clip_list, vehicle)
        driven = {t["ch"] for c in clip_json if c["role"] != "other" for t in c["tracks"]}
        # Clipes do piloto ficam fora do repouso: a máquina do piloto os toca (o t=0 do 0x22 é esterço todo para um
        # lado; FUN_001fa2f8 só amostra 0..11, 0x18, 0x19 e 0x0C).
        drv_cats = {c["category"] for c in clip_json if c["role"] == "driver"}
        rest = rig.rest_channels(ngp_bytes, rig_bones, [c for c in clip_list if c.category not in drv_cats], driven)
        rig_json = {
            "bones": [{"parent": b.parent, "const": b.const, "chan": b.chan, "vis": b.vis,
                       "pre": b.pre, "post": b.post} for b in rig_bones],
            "clips": clip_json,
            # velocidade dos clipes de suporte de arma (FUN_00127778: 2 nos carros Head-On, 1 nos HC)
            "mountSpeed": rig.clip_speed(vehicle),
            # valor de repouso por canal (clipes em t=0; pose de bind nos ossos com nó 0x15)
            "rest": {str(k): round(float(v), 6) for k, v in sorted(rest.items())},
            "direct": rig.direct_channels(rig_bones, clip_list, wheel_like),
            # Marcadores 0x00F0 (cat. 0x3C): o modelo do projétil aparece ali com o suporte aberto (FUN_00147568).
            "launchMarks": rig.launch_marks(ngp_bytes, ptr_bytes, rig_index),
        }

    def inst_json(i: ngp.Instance) -> dict:
        out = {"mesh": f"m{i.mesh:06x}", "bone": f"n{i.bone:06x}" if i.bone >= 0 else None}
        if use_rig:
            out["b"] = rig.leaf_bone(ngp_bytes, i, rig_index)
        if i.matrix is not None:  # objeto posicionado com rotação (nó 0x1F): 4x4 vetor-linha (p' = p·M)
            out["matrix"] = [round(float(v), 6) for v in i.matrix.reshape(-1)]
        elif any(abs(v) > 1e-6 for v in i.offset):
            out["offset"] = [round(float(v), 4) for v in i.offset]  # objeto posicionado (nó 0x03/0x1F)
        if i.damage:  # entradas de nós 0x13 no caminho: visível só quando todas estão no estado atual
            out["dmg"] = [[f"n{n:06x}", e] for n, e in i.damage]
        if i.select:  # filhos de seletores 0x05 no caminho: visível só quando todos estão no filho atual
            out["sel"] = [[f"n{n:06x}", c] for n, c in i.select]
        if (obj := material_owner(i)) is not None:
            out["obj"] = f"n{obj:06x}"  # objeto 0x11 cujos canais animam o material (matAnim)
        if (ob := obj_rig_of.get((i.mesh, tuple(i.path)))) is not None:
            out["ob"], out["b"] = ob  # osso do esqueleto do objeto (objRigs): o runtime ignora offset/matrix
        return out

    # Animação de material (FUN_0024baa8): malhas com canais leem o vetor de canais do objeto 0x11 dono (obj+4),
    # alimentado pelos clipes do objeto. Carros com esqueleto ficam de fora (os canais deles são os do rig).
    mat_objects: dict[int, set[int]] = {}  # objeto -> canais lidos pelos materiais

    def material_owner(i: ngp.Instance) -> int | None:
        mat = mesh_json.get(f"m{i.mesh:06x}", {}).get("mat")
        if use_rig or mat is None:
            return None
        owners = [n for n in i.path if struct.unpack_from("<I", ngp_bytes, n)[0] & 0x3F == 0x11]
        if not owners:
            return None
        mat_objects.setdefault(owners[-1], set()).update(c for c in mat if c >= 0)
        return owners[-1]

    # Peças móveis dos níveis: objetos 0x11 cujos clipes escrevem canais de ossos 0x0D sob eles. O jogo monta o
    # objeto com FUN_002111f8 (toca na carga os clipes com o bit 0 do u16 +0x0E, "auto") e desenha os ossos pelos
    # canais (FUN_0021b3c0); os demais clipes são tocados por roteiros (0xDCA, abertura) ou pelo código.
    obj_rig_of: dict[tuple[int, tuple[int, ...]], tuple[str, int]] = {}
    obj_rigs: dict[str, dict] = {}
    if folder == "lvl":
        by_obj: dict[int, list[ngp.Instance]] = {}
        effect_insts = [i for insts in scene_rep.effects.values() for i in insts]
        for i in scene_rep.instances + scene_rep.damaged + effect_insts:
            owners = [n for n in i.path if struct.unpack_from("<I", ngp_bytes, n)[0] & 0x3F == 0x11]
            if owners:
                by_obj.setdefault(owners[-1], []).append(i)
        for obj, insts in sorted(by_obj.items()):
            clip_list = rig.object_clips(ngp_bytes, obj)
            if not clip_list:
                continue
            ob_bones, ob_index = rig.build(ngp_bytes, insts)
            driven = {c for b in ob_bones for c in b.chan + [b.vis] if c >= 0}
            if not driven & {t.channel for c in clip_list for t in c.tracks}:
                continue
            key = f"n{obj:06x}"
            obj_rigs[key] = {
                "category": struct.unpack_from("<I", ngp_bytes, obj)[0] >> 18,
                "bones": [{"parent": b.parent, "const": b.const, "chan": b.chan, "vis": b.vis,
                           "pre": b.pre, "post": b.post} for b in ob_bones],
                "clips": [{"category": c.category, "start": c.start, "duration": c.duration, "role": "other",
                           "loop": c.loop, "auto": c.auto,
                           "tracks": [{"ch": t.channel, "kind": t.kind, "step": t.step, "base": t.base,
                                       "scale": t.scale, "t0": t.t0, "keys": t.keys}
                                      for t in c.tracks if t.channel in driven]}
                          for c in clip_list],
            }
            for i in insts:
                obj_rig_of[(i.mesh, tuple(i.path))] = (key, rig.leaf_bone(ngp_bytes, i, ob_index))

    # Roteiros de abertura (FUN_002062b8 → FUN_0018fdb8): nós 0x1B com u16 +0x08 = 0xC1C + 0x14·i (i < 6); o
    # fluxo em +0x0C (FUN_00231f80) = n e n trios (categoria, índice, categoria do clipe) que FUN_001b5ab8 toca.
    # O port não mostra a cena: só aplica o estado final (objetos no fim do clipe; 0xC23 no clipe 2).
    intros: list[dict] = []
    if folder == "lvl":
        relocs = ngp.relocations(ngp_bytes, ptr_bytes)
        targets = sorted({ngp._u32(ngp_bytes, r) for r in relocs if ngp._u32(ngp_bytes, r) + 0x10 <= len(ngp_bytes)})
        for t in targets:
            w = ngp._u32(ngp_bytes, t)
            sid = struct.unpack_from("<H", ngp_bytes, t + 8)[0]
            if w & 0x3F != 0x1B or not (0xC1C <= sid < 0xC1C + 0x65) or (sid - 0xC1C) % 0x14:
                continue
            values = token_stream(ngp_bytes, t + 0x0C)
            n = int(values[0]) if values else 0
            entry = {"index": (sid - 0xC1C) // 0x14,
                     "script": [[int(v) for v in values[1 + 3 * k:4 + 3 * k]] for k in range(n)]}
            intros.append(entry)

    # Ações soltas pelos nós 0x13 (actionDispatch.cpp) e os modelos das peças de destroço (tools/actions.py).
    piece_info: dict[int, dict] = {}
    action_json = {f"n{x:06x}": actions.decode(ngp_bytes, x, piece_info)
                   for d in scene_rep.damage.values() for x in d.fx if x}
    pieces = actions.piece_models(ngp_bytes, ptr_bytes, meshes, piece_info)

    def selector_role(node: int) -> str | None:
        """Sombra: seletor de categoria 0 com 2 filhos, o 1º vazio e o 2º uma malha plana (z constante) — o jogo
        não o registra por categoria (FUN_00124288); ⚠️ host: o runtime a projeta no chão."""
        sl = scene_rep.selectors[node]
        if sl.category or sl.count != 2:
            return None
        kids = [[i for i in scene_rep.selected if (node, c) in i.select] for c in range(2)]
        if kids[0] or not kids[1]:
            return None
        zs = [np.asarray(st.pos)[:, 2] for i in kids[1] for st in by_offset[i.mesh].strips]
        return "shadow" if zs and all(float(z.max() - z.min()) < 0.01 for z in zs) else None

    def mat(m) -> list[float] | None:
        return None if m is None else [round(float(v), 6) for v in m.reshape(-1)]

    doc = {
        "version": 1,
        "name": name,
        "source": f"{folder}/{name}",
        "sha256": {
            "ngp": hashlib.sha256(ngp_bytes).hexdigest(),
            "ptr": hashlib.sha256(ptr_bytes).hexdigest(),
            "tex": hashlib.sha256(tex_bytes).hexdigest(),
        },
        "coords": "ps2",
        "counts": {
            "meshes": len(meshes),
            "triangles": sum(len(m.triangles()[1]) // 3 for m in meshes if m.strips),
            "sprites": sum(len(m.sprites) for m in meshes),
            "beams": sum(len(m.beams) for m in meshes),
            "textures": len(textures),
            "instances": len(scene_rep.instances),
        },
        "errors": errors,
        # Rodas reposicionadas (tools/wheels.py; ⚠️ altura = escolha do host).
        "wheelFixes": {f"m{f.mesh:06x}": {"case": f.case, "pivot": [round(float(v), 4) for v in f.pivot]}
                       for f in wheel_fixes.values()},
        # Pose base (LOD mais detalhado, estado intacto): malhas já no espaço do modelo.
        "scene": [inst_json(i) for i in scene_rep.instances],
        # Estados de dano (nós 0x13): instâncias das entradas ≥ 1 e a regra de cada nó. Carro: estado = 1ª
        # entrada com limiar ≤ int(vida/vidaMáx · 65535) nos nós de categoria 0x46 (FUN_0012e8c0/FUN_00171560).
        **({"damageScene": [inst_json(i) for i in scene_rep.damaged],
            "damage": {f"n{d.node:06x}": {"category": d.category, "thresholds": d.thresholds, "maxHp": d.max_hp,
                                          "minDamage": d.min_damage,
                                          "fx": [f"n{x:06x}" if x else None for x in d.fx]}
                       for d in scene_rep.damage.values()}} if scene_rep.damage else {}),
        # Seletores 0x05 (carros): filho desenhado = byte +0x08 (state); o runtime troca pelos categorias conhecidas.
        **({"selectScene": [inst_json(i) for i in scene_rep.selected],
            "selectors": {f"n{n:06x}": {"category": sl.category, "id": sl.id, "kind": sl.kind, "state": sl.state,
                                        "count": sl.count, **({"role": r} if (r := selector_role(n)) else {})}
                          for n, sl in scene_rep.selectors.items()}} if scene_rep.selectors else {}),
        **({"actions": action_json,
            "debris": {f"n{m:06x}": {"instances": [{**inst_json(i), "b": -1} for i in pc["instances"]],
                                     "offset": pc["offset"], "center": pc["center"], "axes": pc["axes"],
                                     "radius": pc["radius"]}
                       for m, pc in pieces.items()}} if action_json else {}),
        # Pontos de disparo por tipo de arma (registros 0x00F8 = categoria 0x3E; FUN_00124288), coordenadas do PS2.
        **({"mounts": weapon_mounts()} if folder in ("cars", "aicars") else {}),
        # Esqueleto (ossos 0x0D como FUN_0022c678) e clipes de animação (nós 0x0B com categoria).
        **({"rig": rig_json} if rig_json else {}),
        # Níveis: esqueleto e clipes de cada objeto com peças móveis (instâncias com "ob"/"b").
        **({"objRigs": obj_rigs} if obj_rigs else {}),
        # Roteiro da abertura (FUN_001b5ab8): o runtime aplica só o estado final.
        **({"intros": intros} if intros else {}),
        # Lançadores por slot: base fixa + portas (dobradiça: pivô, eixo, ângulo de abertura) — tools/launchers.py.
        **({"launchers": [
            {"slots": la.slots, "offset": la.offset,
             "base": [f"m{m:06x}" for m in la.meshes],
             "doors": [{"mesh": f"m{m:06x}", "pivot": h.pivot, "axis": h.axis, "angle": h.angle} for m, h in la.doors]}
            for la in launcher_list]} if folder in ("cars", "aicars") else {}),
        # HUD (GLOBALS): raízes por papel, posição na tela, instâncias com seletores, ossos/canais e clipes.
        **({"hud": hud_json} if hud_json else {}),
        # Céu: desenhado centrado na câmera, atrás de tudo (runtime).
        "sky": [inst_json(i) for i in sky],
        # Slots de efeito (nós 0x05), fora da pose base; o runtime liga cada um quando precisar.
        "effects": {
            f"n{node:06x}": [inst_json(i) for i in insts]
            for node, insts in scene_rep.effects.items()
        } | {
            f"code:{kind}": [inst_json(i) for i in insts]
            for kind, insts in scene_rep.code_effects.items()
        },
        # Pontos da arena (spawn, pickups, caminhos da IA…), coordenadas do PS2.
        "points": {
            kind: read_points(f, stride)
            for kind, stride in POINT_LISTS.items()
            for f in sorted(base.glob(f"*.{kind}"))[:1]
        },
        # Objetos do nível (cabeçalho +0x10): os que não aparecem na cena são pré-fabricados
        # (centrados na origem) instanciados pelo jogo em runtime.
        "objects": level_objects_json(),
        # GLOBALS: nós registrados por categoria (projéteis e ícones de pickup), relativos ao próprio nó.
        **({"categories": category_objects_json()} if folder == "globals" else {}),
        # Ossos para animação: matrizes 4x4 vetor-linha achatadas (= column-major do Three).
        "bones": {
            f"n{b.node:06x}": {"parent": f"n{b.parent:06x}" if b.parent >= 0 else None,
                               "invBind": mat(b.inv_bind), "bind": mat(b.bind)}
            for b in scene_rep.bones.values()
        },
        "sceneUnknown": {f"{k:x}": [f"{p:x}" for p in v] for k, v in scene_rep.unknown.items()},
        "meshes": mesh_json,
        "textures": textures,
    }
    # Depois de todas as instâncias (inst_json registra os objetos donos): clipes de cada objeto com material animado,
    # só com as trilhas dos canais que os materiais leem (o clipe da abertura da Arena tem 211 trilhas, quase todas de
    # ossos).
    if mat_objects:
        doc["matAnim"] = {
            f"n{obj:06x}": {"clips": [
                {"category": c.category, "start": c.start, "duration": c.duration, "role": "other", "loop": c.loop,
                 "auto": c.auto, "tracks": [{"ch": t.channel, "kind": t.kind, "step": t.step, "base": t.base, "scale": t.scale,
                             "t0": t.t0, "keys": t.keys} for t in c.tracks if t.channel in chans]}
                for c in rig.object_clips(ngp_bytes, obj)]}
            for obj, chans in sorted(mat_objects.items())}
    dest = ASSETS / folder
    dest.mkdir(parents=True, exist_ok=True)
    (dest / f"{name}.bin").write_bytes(bytes(out.buf))
    (dest / f"{name}.json").write_text(json.dumps(doc, indent=1), "utf-8")
    return doc


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="+")
    ap.add_argument("--dir", default="cars", choices=("cars", "aicars", "lvl", "globals", "shell"))
    args = ap.parse_args()
    failed = 0
    for name in args.names:
        doc = convert(name.lower(), args.dir)
        c = doc["counts"]
        print(f"{name}: {c['meshes']} malhas, {c['triangles']} triângulos, {c['sprites']} sprites, {c['textures']} texturas")
        for e in doc["errors"]:
            print("  ERRO", e)
        failed += bool(doc["errors"])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
