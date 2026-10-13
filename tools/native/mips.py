"""Emulador mínimo de R5900 (subconjunto) para rodar funções de inicialização do SCUS_976.21 offline.

Usado para extrair tabelas que o jogo monta em runtime com sequências de lui/ori/sw (ex.: a tabela de armas
em FUN_001fd4e0). Só inteiros de 32 bits, sem FPU além de mtc1/mfc1/lwc1/swc1; memória esparsa por word,
leituras fora do que foi gravado caem nos bytes do ELF (ou 0 no BSS).
"""

from __future__ import annotations

import struct
from typing import Callable

from elf import Elf

M32 = 0xFFFFFFFF


def s16(v: int) -> int:
    return v - 0x10000 if v & 0x8000 else v


def s32(v: int) -> int:
    v &= M32
    return v - 0x100000000 if v & 0x80000000 else v


class Cpu:
    def __init__(self, elf: Elf):
        self.elf = elf
        self.r = [0] * 32
        self.f = [0] * 32
        self.mem: dict[int, int] = {}  # endereço alinhado a 4 -> word
        self.hooks: dict[int, Callable[["Cpu"], bool]] = {}  # jal alvo -> handler (True = para); sem hook = chama
        self.r[28] = elf.gp
        self.r[29] = 0x7FFF0000

    # ---------------------------------------------------------------- memória
    def load(self, a: int) -> int:
        a &= M32
        if a in self.mem:
            return self.mem[a]
        o = self.elf.off(a)
        return struct.unpack_from("<I", self.elf.data, o)[0] if o is not None else 0

    def store(self, a: int, v: int) -> None:
        if a & 3:
            raise ValueError(f"sw desalinhado {a:#x}")
        self.mem[a & M32] = v & M32

    def fetch(self, pc: int) -> int:
        return struct.unpack_from("<I", self.elf.data, self.elf.off(pc))[0]

    # ---------------------------------------------------------------- execução
    def run(self, pc: int, max_steps: int = 200000) -> None:
        r = self.r
        self.r[31] = 0xDEAD0000  # retorno do topo
        delay: int | None = None  # alvo de desvio pendente (executa o slot antes)
        steps = 0
        while True:
            if pc == 0xDEAD0000:
                return
            steps += 1
            if steps > max_steps:
                raise RuntimeError("limite de passos")
            w = self.fetch(pc)
            op = w >> 26
            rs, rt, rd = (w >> 21) & 31, (w >> 16) & 31, (w >> 11) & 31
            imm = w & 0xFFFF
            nxt = pc + 4
            branch: int | None = None
            likely_skip = False
            if op == 0:
                fn = w & 63
                if fn == 0x00:  # sll
                    if rd:
                        r[rd] = (r[rt] << ((w >> 6) & 31)) & M32
                elif fn in (0x21, 0x2D):  # addu/daddu
                    r[rd] = (r[rs] + r[rt]) & M32
                elif fn in (0x23, 0x2F):  # subu/dsubu
                    r[rd] = (r[rs] - r[rt]) & M32
                elif fn == 0x24:
                    r[rd] = r[rs] & r[rt]
                elif fn == 0x25:
                    r[rd] = r[rs] | r[rt]
                elif fn == 0x2A:
                    r[rd] = int(s32(r[rs]) < s32(r[rt]))
                elif fn == 0x2B:
                    r[rd] = int(r[rs] < r[rt])
                elif fn == 0x08:  # jr
                    branch = r[rs]
                else:
                    raise NotImplementedError(f"{pc:#x}: SPECIAL {fn:#x}")
            elif op == 1:
                c = s32(r[rs])
                cond = {0: c < 0, 1: c >= 0, 2: c < 0, 3: c >= 0}[rt]
                tgt = nxt + (s16(imm) << 2)
                if cond:
                    branch = tgt
                elif rt in (2, 3):
                    likely_skip = True
            elif op == 3:  # jal
                tgt = (pc & 0xF0000000) | ((w & 0x3FFFFFF) << 2)
                self._exec_slot(pc + 4)
                h = self.hooks.get(tgt)
                if h is None:  # chamada real
                    r[31] = pc + 8
                    pc = tgt
                    continue
                if h(self):
                    return
                pc = pc + 8
                continue
            elif op == 2:
                branch = (pc & 0xF0000000) | ((w & 0x3FFFFFF) << 2)
            elif op in (4, 5, 6, 7, 20, 21):
                a, b = s32(r[rs]), s32(r[rt])
                cond = {4: a == b, 5: a != b, 6: a <= 0, 7: a > 0, 20: a == b, 21: a != b}[op]
                if cond:
                    branch = nxt + (s16(imm) << 2)
                elif op in (20, 21):
                    likely_skip = True
            elif op in (9, 25):
                if rt:
                    r[rt] = (r[rs] + s16(imm)) & M32
            elif op == 10:
                r[rt] = int(s32(r[rs]) < s16(imm))
            elif op == 12:
                r[rt] = r[rs] & imm
            elif op == 13:
                r[rt] = r[rs] | imm
            elif op == 15:
                r[rt] = (imm << 16) & M32
            elif op == 17:
                if rs == 4:
                    self.f[rd] = r[rt]
                elif rs == 0:
                    r[rt] = self.f[rd]
                else:
                    raise NotImplementedError(f"{pc:#x}: COP1 {rs:#x}")
            elif op == 35:
                r[rt] = self.load(r[rs] + s16(imm))
            elif op == 49:
                self.f[rt] = self.load(r[rs] + s16(imm))
            elif op == 43:
                self.store(r[rs] + s16(imm), r[rt])
            elif op == 57:
                self.store(r[rs] + s16(imm), self.f[rt])
            elif op in (30, 31, 55, 63):  # lq/sq/ld/sd — pilha, ignorados (registradores salvos)
                pass
            else:
                raise NotImplementedError(f"{pc:#x}: op {op:#x}")
            r[0] = 0
            if branch is not None:
                self._exec_slot(nxt)
                pc = branch
            elif likely_skip:
                pc = nxt + 4
            else:
                pc = nxt

    def _exec_slot(self, pc: int) -> None:
        """Executa uma instrução de slot de atraso (sem desvios)."""
        w = self.fetch(pc)
        op = w >> 26
        if op in (1, 2, 3, 4, 5, 6, 7, 20, 21) or (op == 0 and (w & 63) in (8, 9)):
            raise NotImplementedError(f"{pc:#x}: desvio no slot")
        self._step_simple(w, pc)

    def _step_simple(self, w: int, pc: int) -> None:
        # Mesmo decodificador de run(), sem desvios (slots de atraso nunca têm desvio no código do jogo).
        r = self.r
        op = w >> 26
        rs, rt, rd = (w >> 21) & 31, (w >> 16) & 31, (w >> 11) & 31
        imm = w & 0xFFFF
        if op == 0:
            fn = w & 63
            if fn == 0x00:
                if rd:
                    r[rd] = (r[rt] << ((w >> 6) & 31)) & M32
            elif fn in (0x21, 0x2D):
                r[rd] = (r[rs] + r[rt]) & M32
            elif fn in (0x23, 0x2F):
                r[rd] = (r[rs] - r[rt]) & M32
            elif fn == 0x25:
                r[rd] = r[rs] | r[rt]
            else:
                raise NotImplementedError(f"{pc:#x}: slot SPECIAL {fn:#x}")
        elif op in (9, 25):
            if rt:
                r[rt] = (r[rs] + s16(imm)) & M32
        elif op == 13:
            r[rt] = r[rs] | imm
        elif op == 15:
            r[rt] = (imm << 16) & M32
        elif op == 17 and rs == 4:
            self.f[rd] = r[rt]
        elif op == 35:
            r[rt] = self.load(r[rs] + s16(imm))
        elif op == 49:
            self.f[rt] = self.load(r[rs] + s16(imm))
        elif op == 43:
            self.store(r[rs] + s16(imm), r[rt])
        elif op == 57:
            self.store(r[rs] + s16(imm), self.f[rt])
        elif op in (30, 31, 55, 63):
            pass
        else:
            raise NotImplementedError(f"{pc:#x}: slot op {op:#x}")
        r[0] = 0
