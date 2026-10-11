"""Testes dos formatos (python -m unittest discover -s tools -p "test_*.py")."""

from __future__ import annotations

import io
import json
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import bdd  # noqa: E402
import iso9660  # noqa: E402
from safe_path import UnsafePathError, safe_component, safe_relpath  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "source" / "manifest.json"


def make_bdd(sections: list[tuple[str, str, bytes]], align: int = 16) -> bytes:
    dir_size = (len(sections) + 1) * 44
    offset = (dir_size + align - 1) // align * align
    header = bytearray()
    body = bytearray()
    for name, typ, data in sections:
        header += bdd.ENTRY.pack(name.encode(), typ.encode(), offset + len(body), len(data), 0x01C836D1C38B2BDE)
        body += data + b"\0" * (-len(data) % align)
    header += b"\0" * 44
    header += b"\0" * (offset - len(header))
    return bytes(header + body)


class BddTests(unittest.TestCase):
    def test_roundtrip(self):
        blob = make_bdd([("arena", "ngp", b"geom"), ("arena", "tex", b"pixels!"), ("ARENA", "PTS", b"pts")])
        entries = bdd.parse(blob)
        self.assertEqual([e.filename for e in entries], ["arena.ngp", "arena.tex", "ARENA.PTS"])
        self.assertEqual(bdd.section(blob, entries[1]), b"pixels!")
        self.assertTrue(entries[0].timestamp.startswith("2007") or entries[0].timestamp.startswith("2008"))

    def test_out_of_bounds(self):
        blob = bytearray(make_bdd([("a", "ngp", b"1234")]))
        struct.pack_into("<I", blob, 0x20, 9999)
        with self.assertRaises(bdd.BddFormatError):
            bdd.parse(bytes(blob))

    def test_overlap(self):
        blob = bytearray(make_bdd([("a", "ngp", b"12345678"), ("a", "tex", b"abcd")]))
        struct.pack_into("<I", blob, 44 + 0x1C, struct.unpack_from("<I", blob, 0x1C)[0] + 2)
        with self.assertRaises(bdd.BddFormatError):
            bdd.parse(bytes(blob))

    def test_duplicate_names(self):
        with self.assertRaises(bdd.BddFormatError):
            bdd.parse(make_bdd([("a", "ngp", b"1"), ("A", "NGP", b"2")]))

    def test_empty(self):
        with self.assertRaises(bdd.BddFormatError):
            bdd.parse(b"\0" * 64)


class SafePathTests(unittest.TestCase):
    def test_normalizes(self):
        self.assertEqual(safe_relpath("LVL\\ARENA.BDD"), "lvl/arena.bdd")

    def test_rejects(self):
        for bad in ["/etc/passwd", "a/../b", "c:x", "a//b", "", "a/\0"]:
            with self.assertRaises(UnsafePathError, msg=bad):
                safe_relpath(bad)
        with self.assertRaises(UnsafePathError):
            safe_component("..")


def make_iso(files: dict[str, bytes]) -> bytes:
    """ISO9660 sintética: raiz com um subdiretório 'DIR' e os arquivos dados ('DIR/X' ou 'X')."""
    S = iso9660.SECTOR

    def rec(lba: int, size: int, flags: int, name: bytes) -> bytes:
        length = 33 + len(name) + (len(name) % 2 == 0)
        r = bytearray(length)
        r[0] = length
        struct.pack_into("<I", r, 2, lba)
        struct.pack_into(">I", r, 6, lba)
        struct.pack_into("<I", r, 10, size)
        struct.pack_into(">I", r, 14, size)
        r[25] = flags
        r[32] = len(name)
        r[33 : 33 + len(name)] = name
        return bytes(r)

    root_lba, sub_lba, data_lba = 18, 19, 20
    sectors: dict[int, bytes] = {}
    lba = data_lba
    root_recs = [rec(root_lba, S, 2, b"\0"), rec(root_lba, S, 2, b"\1"), rec(sub_lba, S, 2, b"DIR")]
    sub_recs = [rec(sub_lba, S, 2, b"\0"), rec(root_lba, S, 2, b"\1")]
    for path, data in files.items():
        name = path.split("/")[-1].encode() + b";1"
        (sub_recs if path.startswith("DIR/") else root_recs).append(rec(lba, len(data), 0, name))
        sectors[lba] = data
        lba += max(1, (len(data) + S - 1) // S)
    total = lba
    img = bytearray(total * S)
    pvd = bytearray(S)
    pvd[0] = 1
    pvd[1:6] = b"CD001"
    struct.pack_into("<I", pvd, 80, total)
    struct.pack_into("<H", pvd, 128, S)
    pvd[156 : 156 + 34] = rec(root_lba, S, 2, b"\0")
    img[16 * S : 17 * S] = pvd
    img[root_lba * S : root_lba * S + len(b"".join(root_recs))] = b"".join(root_recs)
    img[sub_lba * S : sub_lba * S + len(b"".join(sub_recs))] = b"".join(sub_recs)
    for at, data in sectors.items():
        img[at * S : at * S + len(data)] = data
    return bytes(img)


class IsoTests(unittest.TestCase):
    def test_walk_and_read(self):
        img = io.BytesIO(make_iso({"SYSTEM.CNF": b"BOOT2", "DIR/A.BDD": b"x" * 3000}))
        files = {e.path: e for e in iso9660.walk(img)}
        self.assertEqual(set(files), {"SYSTEM.CNF", "DIR/A.BDD"})
        self.assertEqual(iso9660.read_file(img, files["DIR/A.BDD"]), b"x" * 3000)

    def test_not_iso(self):
        with self.assertRaises(iso9660.IsoFormatError):
            iso9660.walk(io.BytesIO(b"\0" * 40000))


@unittest.skipUnless(MANIFEST.exists(), "extração local ausente (rode tools/extract.py)")
class RealManifestTests(unittest.TestCase):
    """Contagens fixadas da ISO NTSC-U SCUS_976.21 (docs/RECON.md)."""

    @classmethod
    def setUpClass(cls):
        cls.m = json.loads(MANIFEST.read_text("utf-8"))

    def test_hashes(self):
        self.assertEqual(self.m["iso"]["sha256"], "e6c23917c9f0f98fc2a9faa66a93e16d4669075c1c5d314de8c5743af8c4cf0e")
        self.assertEqual(self.m["elf"]["sha256"], "8619cb640b4b5263f072b8f2de9aa459a517b3e1e2f9fc732fb0856dde22a3c3")

    def test_counts(self):
        c = self.m["counts"]
        self.assertEqual(self.m["errors"], [])
        self.assertEqual(c["discFiles"], 405)
        self.assertEqual(c["discBytes"], 4174627390)
        self.assertEqual(c["bddSectionBytes"], 267418997)
        self.assertEqual(c["bddArchives"], 106)
        self.assertEqual(c["bddSections"], 419)
        self.assertEqual(c["discBytes"], sum(d["bytes"] for d in self.m["disc"]))

    def test_paths_lowercase_and_unique(self):
        paths = [d["path"] for d in self.m["disc"]] + [g["path"] for g in self.m["game"]]
        self.assertEqual(paths, [p.lower() for p in paths])
        self.assertEqual(len(paths), len(set(paths)))

    def test_every_bdd_has_ngp(self):
        archives = {g["archive"] for g in self.m["game"]}
        with_ngp = {g["archive"] for g in self.m["game"] if g["type"] == "ngp"}
        self.assertEqual(archives, with_ngp)


if __name__ == "__main__":
    unittest.main()
