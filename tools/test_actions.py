"""Ações dos nós 0x13 (destroços) e seletores 0x05 dos carros (RE em docs/NATIVE.md, "Ações e destroços" e
"Seletores dos carros")."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import actions  # noqa: E402
import ngp  # noqa: E402
import rig  # noqa: E402

CARS = Path(__file__).resolve().parent.parent / "source" / "game" / "cars"


def load(name: str):
    b = CARS / name / name
    d, p = b.with_suffix(".ngp").read_bytes(), b.with_suffix(".ptr").read_bytes()
    return d, p, ngp.find_meshes(d, p)


@unittest.skipUnless((CARS / "cop" / "cop.ngp").exists(), "dados do jogo ausentes")
class ActionTests(unittest.TestCase):
    def test_cop_carcass_debris(self):
        d, p, ms = load("cop")
        pieces: dict[int, dict] = {}
        a = actions.decode(d, 0x31230, pieces)
        # lista → transformação (identidade) → destroços com 6 peças (u64 +0x08 bits 53..61)
        self.assertEqual(a["type"], 0)
        x = a["items"][0]
        self.assertEqual(x["type"], 1)
        self.assertEqual(x["matrix"], [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0])
        deb = x["child"]
        self.assertEqual(deb["type"], 3)
        self.assertEqual(len(deb["pieces"]), 6)
        self.assertEqual(deb["mass"], 1.0)
        self.assertAlmostEqual(deb["center"][2], -11.4323, places=3)  # centro abaixo do carro: peças sobem
        self.assertEqual(deb["pieces"][0]["model"], "n02c2f0")

    def test_piece_box_from_mesh_header(self):
        d, p, ms = load("cop")
        # malha direta: caixa = colunas de (+0x30, +0x40, +0x50) × 0,75, eixos curtos normalizados para 1
        c, axes, t3 = actions.piece_box(d, 0x2C2F0)
        self.assertEqual(t3, [0.0, 0.0, 0.0])
        lens = sorted(round(sum(v * v for v in a) ** 0.5, 3) for a in axes)
        self.assertEqual(lens[0], 1.0)  # 0,435 × 0,75 < 1 → normalizado
        self.assertAlmostEqual(lens[2], 2.375 * 0.75, places=2)
        # nó 0x03: translação = −centro da malha → caixa centrada na origem da peça
        c, axes, t3 = actions.piece_box(d, 0x2DC70)
        self.assertAlmostEqual(t3[1], -5.289, places=2)
        self.assertLess(max(abs(v) for v in c), 0.05)

    def test_sound_names(self):
        self.assertEqual(actions.SOUND_NAMES[10][0], "D_CONCRETE_SM")
        self.assertEqual(actions.SOUND_NAMES[0x53][0], "B_BARREL_CRASH")


@unittest.skipUnless((CARS / "cop" / "cop.ngp").exists(), "dados do jogo ausentes")
class SelectorTests(unittest.TestCase):
    def test_cop_selectors(self):
        d, p, ms = load("cop")
        rep = ngp.scene(d, p, ms, damage_states=True, selectors=True)
        cats = sorted(s.category for s in rep.selectors.values())
        # 0x40 brilho dos faróis, 0x41 lanternas, 0x43 fogo, 0x44 turbo, 0x1b2 projétil, 0 sombra/vazio
        for c in (0x40, 0x41, 0x43, 0x44, 0x1B2):
            self.assertIn(c, cats)
        self.assertTrue(all(s.state == 0 for s in rep.selectors.values()))  # byte +0x08 no arquivo
        tail = next(s for s in rep.selectors.values() if s.category == 0x41)
        self.assertEqual(tail.count, 3)
        # lanternas: filho 0 (aceso normal) é desenhado pelo jogo e antes ficava de fora
        self.assertTrue(any((tail.node, 0) in i.select for i in rep.selected))

    def test_base_pose_unchanged(self):
        for name in ("cop", "axel", "mrgrim"):
            d, p, ms = load(name)
            old = ngp.scene(d, p, ms, damage_states=True)
            new = ngp.scene(d, p, ms, damage_states=True, selectors=True)
            base_old = {i.mesh for i in old.instances}
            base_new = {i.mesh for i in new.instances}
            self.assertTrue(base_new <= base_old, name)  # nada novo na pose base: seletores vão para selected

    def test_launch_marks(self):
        d, p, ms = load("axel")
        rep = ngp.scene(d, p, ms, damage_states=True, selectors=True)
        bones, index = rig.build(d, rep.instances + rep.damaged + rep.selected)
        marks = rig.launch_marks(d, p, index)
        self.assertEqual(sorted(m["type"] for m in marks), [2, 3, 4, 5, 6, 7, 15])
        self.assertTrue(all(m["bone"] >= 0 for m in marks))


if __name__ == "__main__":
    unittest.main()
