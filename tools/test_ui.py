"""HUD e fonte (tools/hud.py, tools/export_ui.py, RESIDENT.RTX): contagens fixadas contra o disco."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "native"))

import hud  # noqa: E402
import ngp  # noqa: E402
import tex  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GLOBALS = ROOT / "source" / "game" / "globals"


@unittest.skipUnless((GLOBALS / "resident" / "resident.rtx").exists(), "source/ não extraído")
class TestUi(unittest.TestCase):
    def test_rtx_fontes(self):
        """RESIDENT.RTX: 20 texturas; as fontes são 512×512 em PSMT4HL/PSMT4HH (0x24/0x2C)."""
        ts = {t.id: t for t in tex.decode((GLOBALS / "resident" / "resident.rtx").read_bytes())}
        self.assertEqual(len(ts), 20)
        for tid in (0x46E98, 0x46F20):
            self.assertEqual((ts[tid].width, ts[tid].height, ts[tid].bpp), (512, 512, 4))

    def test_glifos(self):
        import export_ui
        from elf import Elf
        g = export_ui.glyph_table(Elf())
        self.assertEqual(len(g), 224)
        self.assertEqual(g["32"][:3], [0, 2, 20])  # espaço: coluna 0, linha 2, largura 20/32
        self.assertEqual(g["65"][:2], [1, 4])  # 'A'

    def test_raizes_do_hud(self):
        d = (GLOBALS / "globals" / "globals.ngp").read_bytes()
        p = (GLOBALS / "globals" / "globals.ptr").read_bytes()
        out, used = hud.export(d, p, ngp.find_meshes(d, p))
        self.assertEqual(sorted(out), ["charge", "panel", "radar"])
        panel = out["panel"]
        self.assertEqual([c["category"] for c in panel["rig"]["clips"]], [0, 1, 2, 3, 0x10, 0x309, 0x30A])
        cats = sorted(s["category"] for s in panel["selectors"].values())
        self.assertIn(0x2080, cats)  # modelo da arma atual (FUN_0013aa88)
        self.assertIn(0x1FD8, cats)  # excesso de vida (FUN_00139938)
        schan = [b["schan"] for b in panel["rig"]["bones"] if "schan" in b]
        self.assertEqual(sorted(map(tuple, schan)), [(-1, -1, 4), (-1, -1, 8), (2, -1, -1), (3, -1, -1)])
        self.assertEqual(out["radar"]["pos"], [-0.68, 3.0, 0.575])


if __name__ == "__main__":
    unittest.main()
