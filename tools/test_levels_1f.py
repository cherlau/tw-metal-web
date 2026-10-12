"""Objetos posicionados dos níveis (nós 0x1F, FUN_0021b3c0): rotação s16 e todos os filhos (+0x0E).

Regressão de 2026-10-12: os níveis aplicavam só a translação do 0x1F e visitavam só o 1º filho — props
com a orientação errada e filhos sumidos (Coliseu DM 0x14c7e0: 12 filhos). Malhas que já estão em
coordenadas do mundo continuam sem transformação (heurística por malha): aplicar sempre punha um bloco de
prédios (0x125c80) em cima da muralha do Coliseu.
"""

from __future__ import annotations

import struct
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ngp  # noqa: E402

LVL = Path(__file__).resolve().parent.parent / "source" / "game" / "lvl" / "colisdm" / "colisdm"


@unittest.skipUnless(LVL.with_suffix(".ngp").exists(), "dados do jogo ausentes")
class Level1FTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        d, p = LVL.with_suffix(".ngp").read_bytes(), LVL.with_suffix(".ptr").read_bytes()
        cls.data = d
        cls.rep = ngp.scene(d, p, ngp.find_meshes(d, p), place_objects=True)

    def test_node_with_twelve_children(self):
        node = 0x14C7E0
        self.assertEqual(struct.unpack_from("<H", self.data, node + 0x0E)[0], 12)
        under = [i for i in self.rep.instances if node in i.path]
        kids = {i.path[i.path.index(node) + 1] for i in under}
        self.assertGreater(len(kids), 1, "só o 1º filho era visitado")

    def test_local_children_get_rotation(self):
        """0x1564d0 (−12,4° em z): malhas modeladas na origem recebem a matriz do nó."""
        node = 0x1564D0
        under = [i for i in self.rep.instances if node in i.path]
        self.assertTrue(under)
        expected = ngp.fixed_matrix(self.data, node, 0x1F)
        for i in under:
            self.assertIsNotNone(i.matrix)
            self.assertTrue(np.allclose(i.matrix[:3, :3], expected[:3, :3], atol=1e-5))

    def test_rotation_sign_matches_bones(self):
        """Mesma regra dos ossos (rotação negada antes do Euler de FUN_00236e50)."""
        m = ngp.fixed_matrix(self.data, 0x14C7E0, 0x1F)
        rz = struct.unpack_from("<h", self.data, 0x14C7E0 + 0x0C)[0] * np.pi / 32768
        self.assertTrue(np.allclose(m[:3, :3], ngp.euler(0, 0, -rz)[:3, :3]))


if __name__ == "__main__":
    unittest.main()
