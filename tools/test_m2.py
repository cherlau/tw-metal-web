"""Testes do M2: VIF, memória do GS, .tex e .ngp (python -m unittest discover -s tools -p "test_*.py")."""

from __future__ import annotations

import json
import struct
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import gs  # noqa: E402
import ngp  # noqa: E402
import tex  # noqa: E402
import vif  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GAME = ROOT / "source" / "game"
ASSETS = ROOT / "public" / "assets"


def code(cmd: int, num: int = 0, imm: int = 0) -> bytes:
    return struct.pack("<I", (cmd << 24) | (num << 16) | imm)


class VifTests(unittest.TestCase):
    def test_unpack_sizes(self):
        self.assertEqual(vif.unpack_size(0x69, 8)[3], 48)  # V3-16 x8
        self.assertEqual(vif.unpack_size(0x62, 10)[3], 12)  # V1-8 x10 -> alinhado a word
        self.assertEqual(vif.unpack_size(0x6F, 3)[3], 8)  # V4-5 x3
        self.assertEqual(vif.unpack_size(0x6C, 0)[2], 256)  # num 0 = 256

    def test_row_offset_mode(self):
        buf = (
            code(0x30) + struct.pack("<4i", 100, -200, 300, 0)  # STROW
            + code(0x05, 0, 1)  # STMOD offset
            + code(0x69, 1, 181) + struct.pack("<3h", 1, 2, -3) + b"\0\0"
            + code(0x17)  # MSCNT
        )
        (pk,) = vif.walk(buf, 0, len(buf))
        self.assertEqual(pk.kick, "MSCNT")
        np.testing.assert_array_equal(pk.unpacks[0].ints_with_row(), [[101, -198, 297]])

    def test_unknown_code_fails(self):
        with self.assertRaises(vif.VifError):
            vif.walk(code(0x7F & 0x2F), 0, 4)

    def test_dma_chain(self):
        body = code(0x17) + code(0x00) + b"\0" * 8  # completa 1 qword
        tag = struct.pack("<II", (6 << 28) | 1, 0) + code(0x00) + code(0x00)
        packets, end = vif.walk_chain(tag + body, 0)
        self.assertEqual(end, 32)
        self.assertEqual(packets[0].kick, "MSCNT")


class GsTests(unittest.TestCase):
    def test_t8_roundtrip(self):
        """Escrever PSMT8 pelo endereçamento do hardware e ler de volta é identidade."""
        rng = np.random.default_rng(1)
        w = h = 64
        img = rng.integers(0, 256, (h, w), dtype=np.uint8)
        mem = gs.GSMemory()
        y, x = np.mgrid[0:h, 0:w]
        mem.words.view(np.uint8)[gs.addr8(x, y, 0, 1)] = img
        # O jogo envia esses bytes como um retângulo PSMCT32 (W/2)x(H/2) linear:
        cy, cx = np.mgrid[0 : h // 2, 0 : w // 2]
        swizzled = mem.words[gs.addr32(cx, cy, 0, 1)].tobytes()
        np.testing.assert_array_equal(gs.unswizzle(swizzled, w, h, 8), img)

    def test_t4_roundtrip(self):
        rng = np.random.default_rng(2)
        w = h = 64
        img = rng.integers(0, 16, (h, w), dtype=np.uint8)
        mem = gs.GSMemory()
        y, x = np.mgrid[0:h, 0:w]
        n = gs.addr4(x, y, 0, 1)
        b = mem.words.view(np.uint8)
        for (nn, v) in zip(n.reshape(-1), img.reshape(-1)):
            b[nn >> 1] = (b[nn >> 1] & (0x0F if nn & 1 else 0xF0)) | (v << 4 if nn & 1 else v)
        cy, cx = np.mgrid[0 : h // 4, 0 : w // 2]
        swizzled = mem.words[gs.addr32(cx, cy, 0, 1)].tobytes()
        np.testing.assert_array_equal(gs.unswizzle(swizzled, w, h, 4), img)

    def test_size_mismatch(self):
        with self.assertRaises(ValueError):
            gs.unswizzle(b"\0" * 100, 64, 64, 8)


def tex_entry(tid: int, fmt: int, payload: bytes) -> bytes:
    qwc = 6 + len(payload) // 16
    return (
        struct.pack("<4I", 0x20, tid, 0, fmt)
        + struct.pack("<4I", (6 << 28) | qwc, 0, 0, (0x50 << 24) | qwc)
        + b"\0" * 96
        + payload
    )


class TexTests(unittest.TestCase):
    def test_ct32_and_clut(self):
        ct32 = bytes(range(256)) * 4  # 16x16 RGBA (fmt 0x4400)
        pix8 = b"\x01" * (8 * 8 * 4)  # retângulo 8x8 PSMCT32 -> PSMT8 16x16
        clut = b"\0" * 4 + bytes([10, 20, 30, 128]) + b"\0" * (1024 - 8)
        blob = b"\0" * 0x40 + tex_entry(0xAA, 0x84400, ct32) + tex_entry(0xBB, 0x83300, pix8) + tex_entry(0, 0x884480, clut)
        a, b = tex.decode(blob)
        self.assertEqual((a.id, a.bpp, a.width, a.height), (0xAA, 32, 16, 16))
        self.assertEqual((b.id, b.bpp, b.width, b.height), (0xBB, 8, 16, 16))
        np.testing.assert_array_equal(b.rgba[0, 0], [10, 20, 30, 255])  # alfa 128 -> 255

    def test_orphan_clut(self):
        with self.assertRaises(tex.TexFormatError):
            tex.decode(b"\0" * 0x40 + tex_entry(0, 0x884480, b"\0" * 1024))


class StripTests(unittest.TestCase):
    def test_adc_restart(self):
        n = 7
        pos = np.arange(n * 3, dtype=float).reshape(n, 3)
        adc = np.zeros(n, bool)
        adc[3:5] = True  # nova strip começa no vértice 3
        s = ngp.Strip(pos, np.zeros((n, 3)), np.zeros((n, 2)), np.ones((n, 4)), adc)
        m = ngp.Mesh(0, 1, 1.0, 0, 0, (0, 0, 0, 1), [s])
        _, idx = m.triangles()
        self.assertEqual(idx.reshape(-1, 3).tolist(), [[0, 1, 2], [3, 4, 5], [5, 4, 6]])


@unittest.skipUnless((GAME / "cars" / "axel" / "axel.ngp").exists(), "extração local ausente")
class RealCarTests(unittest.TestCase):
    def test_axel_counts(self):
        b = GAME / "cars" / "axel" / "axel"
        meshes = ngp.find_meshes(b.with_suffix(".ngp").read_bytes(), b.with_suffix(".ptr").read_bytes())
        textures = tex.decode(b.with_suffix(".tex").read_bytes())
        self.assertEqual(len(meshes), 79)
        self.assertEqual(sum(len(m.triangles()[1]) // 3 for m in meshes if m.strips), 4584)
        self.assertEqual(len(textures), 13)
        ids = {t.id for t in textures}
        self.assertTrue(all(t in ids for m in meshes for t in m.textures))

    def test_scene_graph(self):
        """Pose base: contagens fixadas e nenhum tipo de nó desconhecido no caminho."""
        expected = {"axel": (21, 6, 17), "sweet": (55, 7, 31), "cop": (70, 7, 41)}
        for car, (inst, fx, bones) in expected.items():
            b = GAME / "cars" / car / car
            d, p = b.with_suffix(".ngp").read_bytes(), b.with_suffix(".ptr").read_bytes()
            rep = ngp.scene(d, p, ngp.find_meshes(d, p))
            self.assertEqual((len(rep.instances), len(rep.effects), len(rep.bones)), (inst, fx, bones), car)
            self.assertEqual(rep.unknown, {}, car)

    def test_meshes_in_model_space(self):
        """invBind leva cada malha do Sweet Tooth para perto da origem do seu osso (malhas no espaço do modelo)."""
        b = GAME / "cars" / "sweet" / "sweet"
        d, p = b.with_suffix(".ngp").read_bytes(), b.with_suffix(".ptr").read_bytes()
        meshes = {m.offset: m for m in ngp.find_meshes(d, p)}
        rep = ngp.scene(d, p, list(meshes.values()))
        node = 0xE830  # osso com T=(-2.31, 9.39, -0.83) e malha em x 0..2.31, y ≈ -9.4
        inst = next(i for i in rep.instances if i.bone == node)
        pos = np.concatenate([s.pos for s in meshes[inst.mesh].strips])
        local = np.c_[pos, np.ones(len(pos))] @ rep.bones[node].inv_bind
        self.assertLess(np.abs(local[:, :3].mean(0)).max(), 2.5)


@unittest.skipUnless((ASSETS / "cars" / "axel.json").exists(), "assets não convertidos")
class PublishedCarTests(unittest.TestCase):
    def test_all_cars_clean(self):
        for folder in ("cars", "aicars"):
            docs = sorted((ASSETS / folder).glob("*.json"))
            self.assertEqual(len(docs), 37, folder)
            for p in docs:
                doc = json.loads(p.read_text("utf-8"))
                self.assertEqual(doc["errors"], [], p.name)
                for key, m in doc["meshes"].items():
                    for t in m["textures"]:
                        self.assertIn(t, doc["textures"], f"{p.name}:{key}")
                self.assertGreater(len(doc["scene"]), 0, p.name)
                for inst in doc["scene"]:
                    self.assertIn(inst["mesh"], doc["meshes"], p.name)


if __name__ == "__main__":
    unittest.main()
