"""Converte bancos de efeitos 989snd (.BNK "SBlk") para .m4a + índice de nomes.

Usa o vgmstream-cli (r2117, %LOCALAPPDATA%/Programs/vgmstream) — ele lê o cabeçalho Sony BNK, incluindo
os NOMES dos sons (ex.: GLOBAL/W_MGUN). Nomes repetidos = variações/camadas do mesmo som. Sufixo _L = loop.

Uso: python tools/convert_sfx.py
Saída: public/assets/sfx/<banco>/<n>.m4a e public/assets/sfx/index.json
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source" / "disc" / "snd"
OUT = ROOT / "public" / "assets" / "sfx"
VGM = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "vgmstream" / "vgmstream-cli.exe"

# carro (public/assets/cars) -> banco de som do carro. ⚠️ ESCOLHA DO HOST pelo nome do piloto/veículo
# (Shadow dirige o carro funerário; Preacher/Brimstone; Darkside é o caminhão).
CAR_BANKS = {
    "axel": "axel", "cop": "copcar", "crim": "crimson", "sweet": "sweett", "twist": "twister",
    "spectre": "spectre", "thump": "thumper", "grass": "grasshop", "hamr": "hammer", "rkill": "roadkill",
    "wart": "warthog", "mrslam": "mrslam", "mrgrim": "grimm", "hearse": "shadow", "edatv": "atv",
    "edboss": "eddy", "dark1": "darkt1", "dark2": "darkt2", "hc_taxi": "taxi", "hc_suv": "suv",
    "hc_tank": "tank", "hc_preac": "brimstne", "hc_semi": "darkside",
}
# carro -> banco de armas do carro (*WP.BNK: S_DEPLOY/S_RETRACT dos suportes, FUN_001451a0/FUN_001452d8, e os
# WSP_* da arma especial). ⚠️ ESCOLHA DO HOST pelo nome do arquivo (HC: *WA.BNK).
CAR_WEAPON_BANKS = {
    "axel": "axelwp", "cop": "copcarwp", "crim": "crimwp", "sweet": "sweettwp", "twist": "twistwp",
    "spectre": "spectrwp", "thump": "thumpwp", "grass": "grasswp", "hamr": "hammerwp", "rkill": "rdkillwp",
    "wart": "wartwp", "mrslam": "mrslamwp", "mrgrim": "grimmwp", "hearse": "shadwp", "edatv": "atvwp",
    "edboss": "eddywp", "dark1": "darkt1wp", "dark2": "darkt2wp", "hc_taxi": "taxiwa", "hc_suv": "suvwa",
    "hc_tank": "tankwa", "hc_preac": "brimstwa", "hc_semi": "darksidw", "hc_derby": "crazy8wa", "hc_tow": "junkwa",
}
# Menu (SHELL.BNK: FE_AMB, S_*).
SHELL_BANKS = ["shell"]
# Bancos das arenas (sons do cenário: destruição D_*/B_*, tocados pelas ações dos nós 0x13 — FUN_001a0db8).
LEVEL_BANKS = ["arena", "castledm", "colisdm", "egyptdm", "greecedm", "parisdm", "tokyodm"]
BANKS = ["global", *sorted(set(CAR_BANKS.values())), *LEVEL_BANKS, *sorted(set(CAR_WEAPON_BANKS.values())), *SHELL_BANKS]


def info(bank: Path, i: int) -> dict:
    out = subprocess.run([str(VGM), "-m", "-s", str(i), str(bank)], capture_output=True, text=True).stdout
    name = re.search(r"stream name: (\S+)", out)
    dur = re.search(r"\(0:([\d.]+) seconds\)", out)
    rate = re.search(r"sample rate: (\d+)", out)
    return {"name": name.group(1).split("/")[-1] if name else f"S{i}", "duration": float(dur.group(1)) if dur else 0.0, "rate": int(rate.group(1)) if rate else 0}


def convert(bank_name: str) -> dict:
    bank = SRC / f"{bank_name}.bnk"
    out = subprocess.run([str(VGM), "-m", str(bank)], capture_output=True, text=True).stdout
    m = re.search(r"stream count: (\d+)", out)
    count = int(m.group(1)) if m else 1
    dest = OUT / bank_name
    dest.mkdir(parents=True, exist_ok=True)
    sounds: dict[str, list] = {}
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(1, count + 1):
            meta = info(bank, i)
            target = dest / f"{i:03d}.m4a"
            if not target.exists():
                wav = Path(tmp) / f"{i}.wav"
                # -i: ignora o loop (exporta uma volta só); o runtime faz o loop.
                subprocess.run([str(VGM), "-i", "-s", str(i), "-o", str(wav), str(bank)], check=True, capture_output=True)
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-c:a", "aac", "-b:a", "96k", str(target)], check=True)
            sounds.setdefault(meta["name"], []).append(
                {"url": f"sfx/{bank_name}/{i:03d}.m4a", "duration": meta["duration"], "loop": meta["name"].endswith("_L")}
            )
    return sounds


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if not VGM.exists():
        print(f"vgmstream-cli não encontrado em {VGM}", file=sys.stderr)
        return 2
    OUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=6) as ex:
        results = dict(zip(BANKS, ex.map(convert, BANKS)))
    for b, s in results.items():
        print(f"{b:10s} {sum(len(v) for v in s.values()):4d} sons, {len(s):3d} nomes")
    index = {"banks": results, "cars": CAR_BANKS, "carWeapons": CAR_WEAPON_BANKS}
    (OUT / "index.json").write_text(json.dumps(index, indent=1), "utf-8")
    total = sum(f.stat().st_size for f in OUT.rglob("*.m4a"))
    print(f"total {total / 2**20:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
