"""Converte a trilha sonora (VAG/VPK, ADPCM do PS2) para AAC (.m4a) + índice por arena.

Uso: python tools/convert_audio.py
Saída: public/assets/music/<nome>.m4a e public/assets/music/index.json

Mapeamento arena → faixas: NATIVO em parte — o ELF tem uma tabela de registros de 0x31 bytes
(até 3 nomes de 16 bytes) por fase em 0x2c4cb9, na ordem das fases; os nomes identificam a fase
(STDM = estádio/Arena, RSQ = Red Square, TRAN = Transilvânia/Castelo, LA = Freeway…).
⚠️ A ordem das fases HC e das 5 arenas DM (TM_HIGH) é ESCOLHA DO HOST até achar o índice no ELF.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source" / "disc" / "vag"
OUT = ROOT / "public" / "assets" / "music"

# arena (public/assets/lvl) -> faixas (sem extensão)
# Só as 7 arenas de deathmatch são publicadas (pedido do usuário, 2026-10-11); as demais faixas
# não são convertidas.
LEVEL_MUSIC = {
    "arena": ["stdmelec", "stdmrock"],
    "castledm": ["tranorch", "tranrock"],
    "colisdm": ["tm_high"],
    "greecedm": ["tm_high"],
    "parisdm": ["tm_high"],
    "tokyodm": ["tm_high"],
    "egyptdm": ["tm_high"],
}
# Faixas estéreo guardadas como dois VAG mono (L, R).
STEREO_PAIRS = {"hoshell": ("hoshelll", "hoshellr"), "hcshell": ("hcshelll", "hcshellr")}
BITRATE = "128k"
MENU = ["hoshell", "hcshell"]
USED = {t for ts in LEVEL_MUSIC.values() for t in ts} | set(MENU)


def ffmpeg(args: list[str]) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


def duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return round(float(out), 3)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    tracks: dict[str, dict] = {}
    paired = {f for pair in STEREO_PAIRS.values() for f in pair}
    jobs: list[tuple[str, list[str]]] = []
    for f in sorted(SRC.iterdir()):
        name = f.stem.lower()
        if name in paired or f.suffix.lower() not in (".vag", ".vpk") or name not in USED:
            continue
        jobs.append((name, ["-i", str(f)]))
    for name, (l, r) in STEREO_PAIRS.items():
        if name not in USED:
            continue
        jobs.append((name, ["-i", str(SRC / f"{l}.vag"), "-i", str(SRC / f"{r}.vag"), "-filter_complex", "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]", "-map", "[a]"]))
    for name, inputs in jobs:
        dest = OUT / f"{name}.m4a"
        if not dest.exists():
            ffmpeg([*inputs, "-c:a", "aac", "-b:a", BITRATE, "-movflags", "+faststart", str(dest)])
        tracks[name] = {"url": f"music/{name}.m4a", "duration": duration(dest), "bytes": dest.stat().st_size}
        print(f"{name:10s} {tracks[name]['duration']:7.1f} s  {tracks[name]['bytes'] / 2**20:5.1f} MB", flush=True)
    missing = [t for ts in LEVEL_MUSIC.values() for t in ts if t not in tracks]
    if missing:
        print("ERRO: faixas sem arquivo:", missing, file=sys.stderr)
        return 1
    index = {"tracks": tracks, "levels": LEVEL_MUSIC, "menu": MENU}
    (OUT / "index.json").write_text(json.dumps(index, indent=1), "utf-8")
    print(f"{len(tracks)} faixas, {sum(t['bytes'] for t in tracks.values()) / 2**20:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
