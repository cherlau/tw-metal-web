"""Testes do M3: relocação com escape, texturas com mips/PSM nativo, níveis (python -m unittest discover -s tools -p "test_*.py")."""

from __future__ import annotations

import json
import struct
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ngp  # noqa: E402
import tex  # noqa: E402
from test_m2 import tex_entry  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GAME = ROOT / "source" / "game"
ASSETS = ROOT / "public" / "assets"


class RelocationTests(unittest.TestCase):
    def test_escape_32bit(self):
        ngp_size = 0x200000
        deltas = [2, 3, 0, 0x8916, 0x0002, 1]  # 2, +3, +0x28916 (escape), +1
        ptr = struct.pack("<I", 0xFFFFFFFF) + struct.pack(f"<{len(deltas)}H", *deltas) + b"\0" * 6
        got = sorted(ngp.relocations(b"\0" * ngp_size, ptr))
        w = [2, 5, 5 + 0x28916, 6 + 0x28916]
        self.assertEqual(got, [x * 4 for x in w])

    def test_padding_zeros(self):
        ptr = struct.pack("<I", 0xFFFFFFFF) + struct.pack("<4H", 1, 0, 0, 0)
        self.assertEqual(ngp.relocations(b"\0" * 64, ptr), {4})


class TexMipTests(unittest.TestCase):
    def test_mip_chain_then_clut(self):
        """Nível 0 + 2 mips com o mesmo id (prefixo 0x0A) + CLUT: só o nível 0 vira textura."""
        lvl0 = b"\x02" * (8 * 8 * 4)  # 8x8 PSMCT32 -> PSMT8 16x16
        mip1 = b"\x03" * (4 * 4 * 4)
        mip2 = b"\x04" * 64
        clut = bytearray(1024)
        clut[2 * 4 : 2 * 4 + 4] = bytes([9, 8, 7, 128])
        blob = (
            b"\0" * 0x40
            + tex_entry(0xAB, 0xA3300, lvl0)
            + tex_entry(0xAB, 0x82200, mip1)
            + tex_entry(0xAB, 0x203313, mip2)
            + tex_entry(0, 0x884480, bytes(clut))
        )
        (t,) = tex.decode(blob)
        self.assertEqual((t.id, t.width, t.height, t.bpp), (0xAB, 16, 16, 8))
        np.testing.assert_array_equal(t.rgba[0, 0], [9, 8, 7, 255])

    def test_native_psmt4_linear(self):
        img = bytes([0x21]) * (16 * 16 // 2)  # nibble baixo 1, alto 2
        clut = bytearray(64)
        clut[4:8] = bytes([255, 0, 0, 128])
        clut[8:12] = bytes([0, 255, 0, 128])
        blob = b"\0" * 0x40 + tex_entry(0xCD, 0x404414, img) + tex_entry(0, 0x881380, bytes(clut))
        (t,) = tex.decode(blob)
        self.assertEqual((t.width, t.height, t.bpp), (16, 16, 4))
        np.testing.assert_array_equal(t.rgba[0, 0, :3], [255, 0, 0])
        np.testing.assert_array_equal(t.rgba[0, 1, :3], [0, 255, 0])

    def test_large_header(self):
        """Cabeçalho com 8 grupos ultrapassa 0x40: entradas começam em alinha16(8 + 8n)."""
        head = struct.pack("<II", 8, 0xF) + b"\0" * 64
        head += b"\0" * (-len(head) % 16)
        clut = b"\0" * 1024
        blob = head + tex_entry(0x1, 0x84400, b"\0" * 1024) + tex_entry(0, 0x884480, clut)
        self.assertEqual(len(tex.decode(blob)), 1)


@unittest.skipUnless((GAME / "lvl" / "arena" / "arena.ngp").exists(), "extração local ausente")
class RealLevelTests(unittest.TestCase):
    def test_all_tex_files_decode(self):
        total = 0
        for f in sorted(GAME.glob("*/*/*.tex")):
            total += len(tex.decode(f.read_bytes()))
        self.assertEqual(total, 5316)

    def test_relocations_all_valid(self):
        for name in ("arena", "egypt", "paris", "tokyob"):
            b = GAME / "lvl" / name / name
            d = b.with_suffix(".ngp").read_bytes()
            r = ngp.relocations(d, b.with_suffix(".ptr").read_bytes())
            bad = [q for q in r if struct.unpack_from("<I", d, q)[0] >= len(d)]
            self.assertEqual(bad, [], name)

    def test_strip_texture_selector(self):
        """Malhas multitextura da arena têm strips em mais de um slot de textura."""
        b = GAME / "lvl" / "arena" / "arena"
        meshes = ngp.find_meshes(b.with_suffix(".ngp").read_bytes(), b.with_suffix(".ptr").read_bytes())
        multi = [m for m in meshes if len(m.textures) >= 2 and m.strips]
        self.assertGreater(len(multi), 100)
        self.assertTrue(all(max(m.texture_slots()) < len(m.textures) for m in multi))
        self.assertGreater(sum(len(m.texture_slots()) > 1 for m in multi), len(multi) // 2)


@unittest.skipUnless((ASSETS / "lvl" / "arena.json").exists(), "níveis não convertidos")
class PublishedLevelTests(unittest.TestCase):
    def test_levels_clean(self):
        docs = sorted((ASSETS / "lvl").glob("*.json"))
        self.assertEqual(len(docs), 26)
        for p in docs:
            doc = json.loads(p.read_text("utf-8"))
            self.assertEqual(doc["errors"], [], p.name)
            self.assertEqual(doc["sceneUnknown"], {}, p.name)
            self.assertGreater(len(doc["scene"]), 100, p.name)
            for inst in doc["scene"]:
                for part in doc["meshes"][inst["mesh"]].get("parts", []):
                    self.assertTrue(part["texture"] is None or part["texture"] in doc["textures"], p.name)


if __name__ == "__main__":
    unittest.main()
