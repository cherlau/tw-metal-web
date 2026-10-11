"""Normalização de caminhos vindos do disco (ISO9660 e BDD).

Regras (SPEC §5): tudo em minúsculas, '\\' -> '/', rejeita absolutos, '..', ':' e NUL.
"""

from __future__ import annotations


class UnsafePathError(ValueError):
    pass


def safe_component(name: str) -> str:
    """Normaliza um único componente de caminho; falha alto se for perigoso."""
    if not name or name in (".", ".."):
        raise UnsafePathError(f"componente inválido: {name!r}")
    if any(c in name for c in ("/", "\\", ":", "\0")):
        raise UnsafePathError(f"componente com separador ou caractere proibido: {name!r}")
    if any(ord(c) < 32 for c in name):
        raise UnsafePathError(f"componente com caractere de controle: {name!r}")
    return name.lower()


def safe_relpath(path: str) -> str:
    """Normaliza um caminho relativo inteiro ('A\\B/C' -> 'a/b/c')."""
    if not path:
        raise UnsafePathError("caminho vazio")
    path = path.replace("\\", "/")
    if path.startswith("/"):
        raise UnsafePathError(f"caminho absoluto: {path!r}")
    return "/".join(safe_component(part) for part in path.split("/"))
