"""Estados de dano dos carros (nós 0x13; RE em docs/NATIVE.md "Estados de dano").

O jogo escolhe a entrada pelo byte de estado do nó 0x14 pai (FUN_0022cd58); nos carros o byte vem da vida
(FUN_0012e8c0 → FUN_00171560). O conversor exporta a entrada 0 na pose base e as demais à parte, marcadas.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ngp  # noqa: E402

CARS = Path(__file__).resolve().parent.parent / "source" / "game" / "cars"


def load(name: str):
    b = CARS / name / name
    d, p = b.with_suffix(".ngp").read_bytes(), b.with_suffix(".ptr").read_bytes()
    return d, p, ngp.find_meshes(d, p)


@unittest.skipUnless((CARS / "cop" / "cop.ngp").exists(), "dados do jogo ausentes")
class DamageTests(unittest.TestCase):
    def test_damage_node_layout(self):
        d, p, ms = load("cop")
        rep = ngp.scene(d, p, ms, damage_states=True)
        n = rep.damage[0x12970]
        self.assertEqual(n.category, 0x46)  # registrado na lista do carro (FUN_00124288)
        self.assertEqual(n.thresholds, [0x7FFF, 0x3FFF, 0x28F, 0])
        self.assertEqual(n.max_hp, 1)  # classe 1 (byte +0x09) → tabela 0x2e0ff8
        # carcaça: o 0x13 externo envolve o carro todo; a entrada de vida 0 solta um efeito (destroços)
        self.assertEqual(rep.damage[0x2F3D0].thresholds, [0x28F, 0])
        self.assertEqual(rep.damage[0x2F3D0].fx, [0, 0x31230])

    def test_hp_class_zero_uses_u16(self):
        d, p, ms = load("dark2")
        rep = ngp.scene(d, p, ms, damage_states=True)
        self.assertEqual(rep.damage[0xC320].max_hp, 0x177)
        self.assertEqual(rep.damage[0xC320].thresholds[0], 0xE665)

    def test_base_pose_unchanged_and_entries_tagged(self):
        for name in ("cop", "axel", "edatv", "hc_axel"):
            d, p, ms = load(name)
            old = ngp.scene(d, p, ms)
            new = ngp.scene(d, p, ms, damage_states=True)
            self.assertEqual([i.mesh for i in old.instances], [i.mesh for i in new.instances], name)
            self.assertTrue(all(e == 0 for i in new.instances for _, e in i.damage), name)
            self.assertTrue(new.damaged and all(any(e for _, e in i.damage) for i in new.damaged), name)


if __name__ == "__main__":
    unittest.main()
