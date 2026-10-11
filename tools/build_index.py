"""Gera public/assets/index.json com os modelos convertidos (para o seletor do visualizador)."""

from __future__ import annotations

import json
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "public" / "assets"


def main() -> None:
    index = {d: sorted(p.stem for p in (ASSETS / d).glob("*.json")) for d in ("lvl", "cars", "aicars") if (ASSETS / d).is_dir()}
    (ASSETS / "index.json").write_text(json.dumps(index, indent=1), "utf-8")
    print({k: len(v) for k, v in index.items()})


if __name__ == "__main__":
    main()
