"""M1 — Extração: ISO -> source/disc + source/game + source/manifest.json.

Lê a ISO direto (ISO9660, somente leitura), sem montar nem copiar a imagem inteira.
Os vídeos (*.PSS, ~3,35 GB) NÃO são copiados por padrão: ficam indexados no manifest
com o offset na ISO e as ferramentas de vídeo leem direto dela (use --include-video para copiar).

Uso:
  python tools/extract.py [--iso CAMINHO] [--out source] [--include-video]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import bdd  # noqa: E402
import iso9660  # noqa: E402
from safe_path import safe_component, safe_relpath  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ISO = ROOT / "Twisted Metal - Head-On - Extra Twisted Edition (USA).iso"

# Hash-pin (SPEC princípio 9). Endereços do ELF só valem para estes hashes.
EXPECTED_ISO_SHA256 = "e6c23917c9f0f98fc2a9faa66a93e16d4669075c1c5d314de8c5743af8c4cf0e"
EXPECTED_ELF = "SCUS_976.21"
EXPECTED_ELF_SHA256 = "8619cb640b4b5263f072b8f2de9aa459a517b3e1e2f9fc732fb0856dde22a3c3"

VIDEO_SUFFIXES = (".pss",)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(8 << 20):
            h.update(chunk)
    return h.hexdigest()


def iso_hash(iso: Path, cache: Path) -> str:
    """SHA-256 da ISO, com cache por (tamanho, mtime) porque são 4 GB."""
    st = iso.stat()
    key = {"path": str(iso), "bytes": st.st_size, "mtime_ns": st.st_mtime_ns}
    if cache.exists():
        cached = json.loads(cache.read_text("utf-8"))
        if {k: cached.get(k) for k in key} == key:
            return cached["sha256"]
    print(f"calculando SHA-256 da ISO ({st.st_size / 2**30:.1f} GB)...", flush=True)
    digest = sha256_file(iso)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({**key, "sha256": digest}, indent=2), "utf-8")
    return digest


class Writer:
    """Escrita idempotente e atômica, com detecção de conflito de caminho."""

    def __init__(self, out: Path):
        self.out = out
        self.claimed: dict[str, str] = {}
        self.written = 0
        self.skipped = 0

    def put(self, relpath: str, data: bytes) -> str:
        digest = sha256_bytes(data)
        prev = self.claimed.get(relpath)
        if prev is not None and prev != digest:
            raise RuntimeError(f"conflito: dois conteúdos diferentes para {relpath}")
        self.claimed[relpath] = digest
        target = self.out / relpath
        if target.exists() and target.stat().st_size == len(data) and sha256_file(target) == digest:
            self.skipped += 1
            return digest
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, target)
        self.written += 1
        return digest


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--iso", type=Path, default=DEFAULT_ISO)
    ap.add_argument("--out", type=Path, default=ROOT / "source")
    ap.add_argument("--include-video", action="store_true", help="também copia os .PSS para source/disc")
    ap.add_argument("--allow-other-iso", action="store_true", help="aceita ISO com hash diferente do pinado")
    args = ap.parse_args()

    t0 = time.time()
    iso: Path = args.iso.resolve()
    out: Path = args.out.resolve()
    if not iso.is_file():
        print(f"ISO não encontrada: {iso}", file=sys.stderr)
        return 2

    digest = iso_hash(iso, out / "iso-hash.json")
    if digest != EXPECTED_ISO_SHA256 and not args.allow_other_iso:
        print(f"SHA-256 da ISO não confere:\n  esperado {EXPECTED_ISO_SHA256}\n  obtido   {digest}", file=sys.stderr)
        return 3

    writer = Writer(out)
    disc_entries: list[dict] = []
    game_entries: list[dict] = []
    errors: list[str] = []
    elf_sha = None

    with iso.open("rb") as f:
        files = iso9660.walk(f)
        for entry in sorted(files, key=lambda e: e.path.lower()):
            rel = safe_relpath(entry.path)
            is_video = rel.endswith(VIDEO_SUFFIXES)
            record = {"path": rel, "bytes": entry.size, "lba": entry.lba, "offset": entry.offset}

            if is_video and not args.include_video:
                # Hash por streaming sem guardar em memória nem em disco.
                h = hashlib.sha256()
                f.seek(entry.offset)
                remaining = entry.size
                while remaining:
                    chunk = f.read(min(remaining, 8 << 20))
                    if not chunk:
                        raise iso9660.IsoFormatError(f"leitura curta em {rel}")
                    h.update(chunk)
                    remaining -= len(chunk)
                record |= {"sha256": h.hexdigest(), "extracted": False}
                disc_entries.append(record)
                continue

            data = iso9660.read_file(f, entry)
            record |= {"sha256": writer.put(f"disc/{rel}", data), "extracted": True}
            disc_entries.append(record)

            if rel == EXPECTED_ELF.lower():
                elf_sha = record["sha256"]

            if rel.endswith(".bdd"):
                parts = rel.split("/")
                stem = safe_component(parts[-1].rsplit(".", 1)[0])
                base = "/".join(parts[:-1] + [stem])
                try:
                    sections = bdd.parse(data)
                except bdd.BddFormatError as exc:
                    errors.append(f"{rel}: {exc}")
                    continue
                for s in sections:
                    srel = f"{base}/{safe_component(s.filename)}"
                    game_entries.append(
                        {
                            "path": srel,
                            "bytes": s.size,
                            "archive": rel,
                            "offset": s.offset,
                            "type": s.type.lower(),
                            "timestamp": s.timestamp,
                            "sha256": writer.put(f"game/{srel}", bdd.section(data, s)),
                        }
                    )

    if elf_sha is None:
        errors.append(f"ELF {EXPECTED_ELF} não encontrado")
    elif elf_sha != EXPECTED_ELF_SHA256 and not args.allow_other_iso:
        errors.append(f"SHA-256 do ELF não confere: {elf_sha}")

    type_counts: dict[str, int] = {}
    for g in game_entries:
        type_counts[g["type"]] = type_counts.get(g["type"], 0) + 1

    manifest = {
        "version": 1,
        "iso": {"file": iso.name, "bytes": iso.stat().st_size, "sha256": digest},
        "elf": {"path": EXPECTED_ELF.lower(), "sha256": elf_sha},
        "counts": {
            "discFiles": len(disc_entries),
            "discBytes": sum(d["bytes"] for d in disc_entries),
            "discExtracted": sum(1 for d in disc_entries if d["extracted"]),
            "bddArchives": len({g["archive"] for g in game_entries}),
            "bddSections": len(game_entries),
            "bddSectionBytes": sum(g["bytes"] for g in game_entries),
            "sectionTypes": dict(sorted(type_counts.items())),
        },
        "errors": errors,
        "disc": disc_entries,
        "game": game_entries,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1), "utf-8")

    c = manifest["counts"]
    print(
        f"disco: {c['discFiles']} arquivos ({c['discExtracted']} copiados) | "
        f"BDD: {c['bddArchives']} arquivos, {c['bddSections']} seções, {c['bddSectionBytes'] / 2**20:.1f} MB | "
        f"escritos {writer.written}, inalterados {writer.skipped} | {time.time() - t0:.0f}s"
    )
    if errors:
        print("ERROS:\n  " + "\n  ".join(errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
