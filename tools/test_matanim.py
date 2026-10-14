"""Animação de material das arenas (FUN_0024baa8): canais do cabeçalho de malha e clipes do objeto dono.

Regressão de 2026-10-13: os nós 0x1A, tidos como "controladores de animação de textura", são folhas de colisão
(FUN_0022cd58 os trata como o tipo 9). Fogo, telões e água são deslocamento de UV / escala de cor vindos dos canais
do objeto 0x11, escritos pelos clipes 0x0B dele.
"""

from __future__ import annotations

import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ngp  # noqa: E402
import rig  # noqa: E402

LVL = Path(__file__).resolve().parent.parent / "source" / "game" / "lvl"


def ngp_of(level: str) -> bytes:
    return (LVL / level / f"{level}.ngp").read_bytes()


@unittest.skipUnless((LVL / "arena").exists() and (LVL / "parisdm").exists(), "dados do jogo ausentes")
class MaterialChannelTests(unittest.TestCase):
    def test_node_1a_is_collision_leaf(self):
        """Arena 0xf850: nó 0x1A de 0x10 bytes com a malha logo depois — +0x0C aponta para o sólido de colisão."""
        d = ngp_of("arena")
        self.assertEqual(struct.unpack_from("<I", d, 0xF850)[0], 0x1A)
        self.assertEqual(struct.unpack_from("<I", d, 0xF860 + 4)[0], 0x00990290)  # cabeçalho de malha em seguida

    def test_fire_flipbook_channels(self):
        """Fogo da Arena (atlas d7214 4×2): flag 0x800, U no canal 7 e V no 8; sem escala de cor."""
        d = ngp_of("arena")
        self.assertEqual(ngp.material_channels(d, 0x4CCC20), [7, 8, -1, -1, -1, -1])

    def test_screen_layer_color_channels(self):
        """Telão (logo 104264): V no canal 9, R/G/B nos canais 8/7/6."""
        self.assertEqual(ngp.material_channels(ngp_of("arena"), 0x4EF230), [-1, 9, 8, 7, 6, -1])

    def test_uv_needs_flag_800(self):
        """Sem a flag 0x800 só valem cor e alfa (FUN_0024baa8 lê U/V só com ela): faixa c873c da Arena."""
        d = ngp_of("arena")
        self.assertFalse(struct.unpack_from("<I", d, 0x4D29D0 + 4)[0] & 0x800)
        self.assertEqual(ngp.material_channels(d, 0x4D29D0), [-1, -1, -1, -1, -1, 1])

    def test_static_mesh_has_none(self):
        """Malha comum (sem bit 31) não tem canais."""
        d = ngp_of("arena")
        self.assertIsNone(ngp.material_channels(d, 0xF860))

    def test_paris_water_loop(self):
        """Água de Paris DM: V no canal 0 do objeto 0x254dc0, clipe 0 em laço de 480 quadros indo de 0 a 2."""
        d = ngp_of("parisdm")
        self.assertEqual(ngp.material_channels(d, 0x2379A0), [-1, 0, -1, -1, -1, -1])
        clips = rig.object_clips(d, 0x254DC0)
        self.assertEqual(len(clips), 1)
        c = clips[0]
        self.assertEqual((c.category, c.duration, c.loop), (0, 480.0, True))
        v = {t.channel: t for t in c.tracks}[0]
        self.assertAlmostEqual(rig.sample(v, 0.0), 0.0, places=4)
        self.assertAlmostEqual(rig.sample(v, 240.0), 1.0, places=2)
        self.assertAlmostEqual(rig.sample(v, 480.0), 2.0, places=4)

    def test_fire_cells_are_atlas_steps(self):
        """O clipe da abertura (2230 quadros, sem laço) anda o fogo pelas células: U em −0,25·k, V em 0 / 0,5."""
        c = rig.object_clips(ngp_of("arena"), 0x4D2990)[0]
        self.assertFalse(c.loop)
        tr = {t.channel: t for t in c.tracks}
        us = {round(rig.sample(tr[7], f), 3) for f in range(0, 2231, 3)}
        vs = {round(rig.sample(tr[8], f), 3) for f in range(0, 2231, 3)}
        self.assertEqual(us, {0.0, -0.25, -0.5, -0.75})
        self.assertEqual(vs, {0.0, 0.5})


if __name__ == "__main__":
    unittest.main()
