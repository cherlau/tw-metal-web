"""Rodas, camada de reflexo e clarão do tiro nos carros reais (regressões de 2026-10-11).

Bugs reportados: Crimson Fury com rodas fora do carro, Grasshopper sem rodas dianteiras, Hammerhead e
Hearse sem rodas, Mr. Grimm sem partes, pintura coberta pelo reflexo, rajada de tiro sempre acesa.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ngp  # noqa: E402
import wheels  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GAME = ROOT / "source" / "game" / "cars"
RULES = ROOT / "public" / "assets" / "rules" / "vehicles.json"


def load(car: str):
    base = GAME / car / car
    d, p = base.with_suffix(".ngp").read_bytes(), base.with_suffix(".ptr").read_bytes()
    meshes = {m.offset: m for m in ngp.find_meshes(d, p)}
    return d, meshes, ngp.scene(d, p, list(meshes.values()))


def plan(car: str) -> dict[int, wheels.WheelFix]:
    d, meshes, rep = load(car)
    native = json.loads(RULES.read_text("utf-8"))["vehicles"].get(car)
    return {f.mesh: f for f in wheels.plan(d, rep, meshes, native)}


@unittest.skipUnless((GAME / "grass" / "grass.ngp").exists() and RULES.exists(), "extração local ausente")
class WheelTests(unittest.TestCase):
    def test_good_cars_untouched(self):
        """Carros que já saíam certos (relato do usuário) não podem mudar."""
        for car in ("wart", "axel", "twist", "rkill", "cop"):
            self.assertEqual(plan(car), {}, car)

    def test_mounted_wheels(self):
        """Caso B: rodas na origem vão para x, y da suspensão (Grasshopper dianteiras, Hammerhead, Hearse)."""
        cases = {
            "grass": {0x2BB0: (-2.19, 3.59), 0x3180: (2.19, 3.59)},
            "hamr": {0x2440: (4.01, 6.33), 0x2C40: (4.46, -7.53), 0x3400: (-4.01, 6.33), 0x3BD0: (-4.46, -7.53)},
            "hearse": {0x1550: (-3.28, 6.95), 0x1A60: (-3.13, -5.80), 0x20F0: (3.28, 6.95), 0x2640: (3.13, -5.80)},
        }
        for car, want in cases.items():
            got = plan(car)
            self.assertEqual(set(got), set(want), car)
            for mesh, xy in want.items():
                self.assertEqual(got[mesh].case, "B")
                np.testing.assert_allclose(got[mesh].pivot[:2], xy, atol=0.01, err_msg=f"{car} {mesh:x}")

    def test_grasshopper_front_aligned_to_rear(self):
        """Altura (escolha do host): base do pneu dianteiro na altura da base do traseiro."""
        d, meshes, _ = load("grass")
        rear = np.concatenate([np.asarray(s.pos)[:, :3] for s in meshes[0x1D60].strips])
        for mesh, f in plan("grass").items():
            pos = np.concatenate([np.asarray(s.pos)[:, :3] for s in meshes[mesh].strips]) + f.offset
            self.assertAlmostEqual(pos[:, 2].min(), rear[:, 2].min(), delta=0.05)

    def test_crimson_fury_wheels_inside_body(self):
        """Caso C: as 4 rodas soltas (y ±10,5) vão para os pontos nativos (±3, ±6) e encaixam no arco."""
        got = plan("crim")
        self.assertEqual({f.case for f in got.values()}, {"C"})
        for f in got.values():
            self.assertAlmostEqual(abs(f.pivot[0]), 3.0, delta=0.01)
            self.assertTrue(4.0 <= abs(f.pivot[1]) <= 6.0, f.pivot)  # dentro do arco, não na ponta
            self.assertTrue(-1.6 <= f.pivot[2] <= -0.9, f.pivot)

    def test_suv_stacked_wheels(self):
        """Caso E: as 4 rodas empilhadas na origem do hc_suv vão para os cantos, na altura dos arcos."""
        got = plan("hc_suv")
        self.assertEqual(len(got), 4)
        self.assertEqual({f.case for f in got.values()}, {"E"})
        self.assertEqual(sorted((round(f.pivot[0]), round(f.pivot[1])) for f in got.values()),
                         [(-3, -6), (-3, 6), (3, -6), (3, 6)])
        self.assertTrue(all(1.5 < f.pivot[2] < 2.6 for f in got.values()))  # arcos em z ≈ 4,3

    def test_relato_2_heights_and_thumper(self):
        """Relato 2 (2026-10-11): Hammerhead no cubo dos braços (z ≈ −3,8), Sweet Tooth abaixo do para-lama,
        Thumper com as rodas DENTRO da carroceria (pontos de física caíam em y ±9,7)."""
        self.assertTrue(all(-4.0 < f.pivot[2] < -3.5 for f in plan("hamr").values()))
        self.assertTrue(all(f.pivot[2] < -3.0 for f in plan("sweet").values()))
        thump = plan("thump")
        self.assertEqual(len(thump), 4)
        self.assertTrue(all(abs(f.pivot[1]) < 7.0 for f in thump.values()), [f.pivot for f in thump.values()])

    def test_atv_wheel_set_centered(self):
        """O esqueleto (com os nós 0x03 do jogo) leva as rodas do ATV, modeladas deslocadas +5,94 em x, a
        um conjunto simétrico em x = 0 — o que antes o caso D fazia por heurística."""
        import rig
        d, meshes, rep = load("edatv")
        p = (GAME / "edatv" / "edatv.ptr").read_bytes()
        bones, index = rig.build(d, rep.instances)
        ch = np.zeros(512)
        for k, v in rig.rest_channels(d, bones, rig.clips(d, p), set()).items():
            ch[k] = v
        w = rig.world(bones, ch)
        xs = []
        for i in rep.instances:
            if i.mesh in (0x250, 0x930, 0x1020, 0x1720):
                pos = np.concatenate([np.asarray(s.pos)[:, :3] for s in meshes[i.mesh].strips])
                q = (np.c_[pos, np.ones(len(pos))] @ w[rig.leaf_bone(d, i, index)])[:, 0]
                xs.append(float(q.min() + q.max()) / 2)
        self.assertEqual(len(xs), 4)
        self.assertTrue(all(1.9 < abs(x) < 2.2 for x in xs), xs)
        self.assertAlmostEqual(sum(xs), 0.0, delta=0.1)

    def test_mr_grimm_parts_reached(self):
        """Rodas (0x2480 traseira, 0x3a40 dianteira) e a moto intacta (0xaa00) entram na pose base."""
        _, _, rep = load("mrgrim")
        got = {i.mesh for i in rep.instances}
        for mesh in (0x2480, 0x3A40, 0xAA00):
            self.assertIn(mesh, got, f"{mesh:x}")
        self.assertNotIn(0xCA20, got)  # versão danificada (2ª entrada do nó 0x13)


@unittest.skipUnless((GAME / "hc_hears" / "hc_hears.ngp").exists(), "extração local ausente")
class ConditionalTests(unittest.TestCase):
    def test_event_conditional_out_of_base_pose(self):
        """Condicional 0x1F de evento (byte 3 = 0x06): a figura da escotilha do hc_hears não flutua na pose base."""
        _, _, rep = load("hc_hears")
        self.assertNotIn(0x2EBF0, {i.mesh for i in rep.instances})
        self.assertIn(0x2EBF0, {i.mesh for v in rep.effects.values() for i in v})


@unittest.skipUnless((GAME / "sweet" / "sweet.ngp").exists(), "extração local ausente")
class RenderStateTests(unittest.TestCase):
    def test_reflection_layer_state(self):
        """Camada de reflexo: grupo com pacote GS (ALPHA (Cs-Cd)*As+Cd, ZMSK) e alfa de vértice ~0,3."""
        d, meshes, rep = load("sweet")
        # (sem as aditivas, bit 15: a bolha de reflexo 0x8312 sob o nó 0x18 é outra coisa)
        refl = [i for i in rep.instances if meshes[i.mesh].flags & 2 and not meshes[i.mesh].flags & 0x8000
                and meshes[i.mesh].strips]
        self.assertTrue(refl)
        for inst in refl:
            regs = ngp.gs_state(d, inst.state)
            self.assertIsNotNone(regs, f"{inst.mesh:x}")
            self.assertEqual(regs[0x42] & 0xFF, 0x44)
            self.assertEqual((regs[0x4E] >> 32) & 1, 1)  # não grava z
            attrs, _ = meshes[inst.mesh].triangles()
            self.assertLess(float(attrs["color"][:, 3].max()), 0.5)

    def test_muzzle_flash_texture(self):
        """O clarão do tiro (textura 0x8a480) está na pose base de todos os carros — o conversor o move
        para effects['code:muzzle']; aqui só garantimos que a assinatura continua a mesma."""
        _, meshes, rep = load("wart")
        flash = [i.mesh for i in rep.instances if meshes[i.mesh].textures == [0x8A480]]
        self.assertEqual(len(flash), 4)


if __name__ == "__main__":
    unittest.main()
