"""Clipes de animação dos carros lidos como o jogo (FUN_00212290) e suportes de arma (FUN_00148e00).

Regressão de 2026-10-12: as trilhas ficam ANTES do cabeçalho do clipe; o leitor antigo as lia depois e cada
clipe recebia as trilhas do seguinte (o lançador do Fire/Homing do Sweet Tooth aparecia como clipe 0x12).
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import rig  # noqa: E402

GAME = Path(__file__).resolve().parent.parent / "source" / "game" / "cars"


def clips(car: str) -> dict[int, rig.Clip]:
    base = GAME / car / car
    d, p = base.with_suffix(".ngp").read_bytes(), base.with_suffix(".ptr").read_bytes()
    return {c.category: c for c in rig.clips(d, p)}


@unittest.skipUnless((GAME / "sweet").exists(), "dados do jogo ausentes")
class ClipTests(unittest.TestCase):
    def test_tracks_belong_to_their_clip(self):
        """Sweet Tooth: o clipe 0x15 (48 quadros) tem 9 trilhas com passo = 48/255 — antes eram as do 0x16."""
        c = clips("sweet")
        self.assertEqual(c[0x15].duration, 48.0)
        self.assertEqual(len(c[0x15].tracks), 9)
        for cat in (0x0D, 0x0E, 0x15, 0x16, 0x17):
            for t in c[cat].tracks:
                self.assertAlmostEqual(t.step * 255, c[cat].duration, places=2)

    def test_wheel_categories(self):
        """Categorias 0..3 giram a roda (0..−2π), como o código as usa (FUN_00127060 / FUN_001276a0)."""
        c = clips("sweet")
        for cat in range(4):
            t = c[cat].tracks[0]
            self.assertAlmostEqual(rig.sample(t, rig.clip_frame(c[cat], 0.0)), 0.0, places=3)
            self.assertAlmostEqual(rig.sample(t, rig.clip_frame(c[cat], 1.0)), -6.2832, places=3)

    def test_all_cars_parse(self):
        for car in sorted(p.name for p in GAME.iterdir() if (p / f"{p.name}.ngp").exists()):
            with self.subTest(car=car):
                clips(car)

    def test_mount_clips_sweet_tooth(self):
        """Sweet Tooth (veículo 0x69): suportes do jogo por arma."""
        out = {c["category"]: c.get("weapons") for c in rig.classify([], list(clips("sweet").values()), 0x69)
               if c["role"] == "weapon"}
        self.assertEqual(out, {0x0D: ["ricochet"], 0x0E: ["napalm"], 0x15: ["fire", "homing"],
                               0x16: ["remote"], 0x17: ["power", "swarmer"]})
        self.assertEqual(rig.clip_speed(0x69), 2.0)
        self.assertEqual(rig.clip_speed(0x82), 1.0)


class SamplerTests(unittest.TestCase):
    def test_kind6_smooth_and_kind5_step(self):
        keys = [[0, 0, 0.0, 0.0], [255, 255, 0.0, 0.0]]
        smooth = rig.Track(0, 0x2016, 1.0, 0.0, 1.0, keys)
        step = rig.Track(0, 0x2015, 1.0, 0.0, 1.0, keys)
        self.assertAlmostEqual(rig.sample(smooth, 127.5), 127.5)
        self.assertAlmostEqual(rig.sample(smooth, 63.75), 255 * (3 * 0.25**2 - 2 * 0.25**3))
        self.assertEqual(rig.sample(step, 200.0), 0.0)
        self.assertEqual(rig.sample(step, 255.0), 255.0)

    def test_tangent_decoding(self):
        self.assertAlmostEqual(rig.tangent(0x2000), 0.5)
        self.assertAlmostEqual(rig.tangent(0x6000), 16384 / (32768 - 0x6000))
        self.assertAlmostEqual(rig.tangent(-0x6000), 16384 / (-32768 + 0x6000))


if __name__ == "__main__":
    unittest.main()
