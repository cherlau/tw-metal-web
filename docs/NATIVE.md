# NATIVE — engenharia reversa do SCUS_976.21

> Todos os endereços valem **só** para o ELF com SHA-256 `8619cb640b4b5263f072b8f2de9aa459a517b3e1e2f9fc732fb0856dde22a3c3` (NTSC-U, VER 1.00).

## Setup (SPEC §8.2)
- JDK 21.0.12.1 (Temurin) + **Ghidra 12.1.3** + **Emotion Engine Reloaded v2.1.37** (chaoticgd), em `%LOCALAPPDATA%\Programs` — downloads conferidos por SHA-256 (oficial da release / digest do GitHub).
- Processador `r5900:LE:32:default`. ELF sem símbolos, um único segmento PT_LOAD `0x100000` (filesz `0x1f4148`, memsz `0x5881cc`).
- ⚠️ O Ghidra mostra aliases `0x20xxxxxx`/`0x30xxxxxx` (KSEG uncached) dos mesmos endereços; ignorar nas contagens.
- Projeto: `artifacts/native/project` (fora do git). Importação: `analyzeHeadless … -import source\disc\scus_976.21 -processor r5900:LE:32:default`.
- Extração: `powershell -File tools/native/run.ps1 tools/native/<alvos>.txt artifacts/native/<saida>` → `InspectNative.java` (DSL do spec + `str:<regex>` + `refsrange:<ini>:<fim>`).
- Tabelas de dados sem Ghidra: `tools/native/elf.py` (vaddr↔offset, strings, ponteiros).

## Achados

| Endereço | Evidência | Implementação no browser |
|---|---|---|
| `0x2ba990` (+id·`0x150`, 36 registros; nome `char[32]` em base−`0x20`) | **Tabela de física dos veículos.** `FUN_00140d60` faz `id*0x150` (id de `FUN_001409e8`), lê `0x2ba9c0..0x2baa38` (pontos), `0x2ba9a0..0x2ba9b0`, e grava `base` em `corpo+0x54`. Nomes: HO_Axel, HO_Hearse, Mr Grimm … Tank Car | `tools/native/export_rules.py` → `public/assets/rules/vehicles.json`; `src/game.ts` usa `wheels` (4 rodas) na suspensão |
| base`+0x30..+0x6f` | 4 pontos de roda (x, y, z, 0) — frente = +Y; bate com o modelo em 31/36 carros | `VehicleShape.wheels` (PS2 `(x,y,z)` → Three `(−x, z, y)`) |
| base`+0x70..+0xaf` | 4 pontos do corpo; `FUN_00140d60` calcula \|p1−p0\|, \|p3−p1\|… (dimensões do corpo rígido) | exportado (`body`), ainda não usado |
| base`+0x00..+0x2f` | 12 floats; `[0..2]` ≈ (1,8, 1,0, 2,0) na maioria; `[7]` ≈ raio (Axel 12, Grimm 6, Eddy 32) | exportado (`params`), semântica 🟡 |
| `FUN_00140d60` | cria o corpo rígido do carro (`FUN_00175900` aloca, `FUN_00175ad0` inicializa); constantes `0.8` (`0x3f4ccccd`) em `corpo+0x10`, `0.25` em `+0x14`, `2·carro+0x848` em `+0x18`, `0.1` em `+0x180/+0x184` | 🟡 próximo alvo (massa/atrito/amortecimento) |
| `.reginfo` `ri_gp_value` | **$gp = `0x2fa5f0`** (variáveis globais `fGpffffXXXX` do Ghidra = gp + 0xffffXXXX) | `tools/native/elf.py` (`Elf.gp`) |
| `FUN_0016b828`, `FUN_0017d068` | constantes **1.4666667 = 88/60** (mph→pés/s): `(v_mph·1.4667 + carro+0x898)·carro+0x848`; impulsos `carro+0x848 × 293.33` (=200 mph) e `× 117.33` (=80 mph) | **unidades do jogo = pés, velocidades em mph** (`vehicle.ts`, HUD) |
| `FUN_00176548` | gravidade: força_z = `corpo+0x18` (massa) × escala × **−32.2** (g em pés/s²); escala = `gp−0x756c` (`0x2f3084`) = **2.0**, ou `gp−0x7568` (`0x2f3088`) = **4.0** se `corpo+0x2a0` | `VEHICLE_RULES.gravity = 2·32.2 = 64,4` (antes: 64, escolha do host) |
| `FUN_00175a58` (construtor do corpo) | padrões: `+0x10`=0.8, `+0x14`=0.1, `+0x18`=1.0 (massa), `+0x180`/`+0x184`=0.05, `+0x2a8`=10 | — |
| `FUN_001769a0` | `+0x180`/`+0x184` = **limiares de repouso**: corpo dorme se \|v\|² < 5·`+0x180` e \|ω\|² < 5·`+0x184` | 🟡 a usar |
| `FUN_002507e8` | inércia de caixa `I = m/12·(y²+z², x²+z², x²+y²)`, `1/m` | — (o host ainda usa modelo arcade) |
| `FUN_001409e8` | id do carro = `carro+0x10 − 0x65` (tipos começam em 101; variantes de modo somam −0x62) | índice da tabela `0x2ba990` |
| `0x2b59e0` (+`0x150`, 40 registros "HO_…/HC_…"; base `0x2b5a00`) | tabela paralela (mesmas rodas, outros 4 pontos de corpo; inclui HC_Rock e HC_Gold) — lida por `FUN_0012e238`, que monta o corpo com `corpo+0x18 = carro+0x848` (sem o ×2) | não usada (🟡 qual modo usa cada tabela) |
| `0x2c4778` | arrays de ponteiros para nomes de exibição dos carros | — |
| `FUN_001025f0` (chamada de `0x101dd4`) | **atualização do jogador por quadro**: guarda o controle anterior (`jogador+0x120..0x1c0` → `+0x1d0`), lê o controle (`FUN_0012aa60(jogador+0x120)`), limita o acúmulo de quadros a 3, roda `FUN_001026e0`, `FUN_00102f50` (alvo), `FUN_00102a88` (armas), `FUN_001032b8`; `FUN_0010cbf0` só com `(+0x478 >> 1) & 1` | estrutura conhecida; motor ainda não localizado |
| `FUN_0010cbf0` | **controlador cinemático de depuração/voo livre** (só com flag): giro alvo `±carro+0x854` suavizado; velocidade `carro+0x898` sobe **10/quadro** até `carro+0x858` **mph**×1.4667, cai 0.3/quadro (5 com freio) | 🟡 confirma `+0x858` = vel. máx. (mph) e `+0x854` = taxa de giro; não usado |
| `FUN_00102f50` | **escolha de alvo** (inimigo mais próximo, lista em `0x606840`, passo `0x140`): distância ×3 se o alvo está atrás (`dot<0`), ×2 se `dot<0.3`, ×1.5 se `dot<0.5`; grava a direção em `jogador+0x2e0..0x2e8` e a distância ponderada em `+0x30c` | regra pronta para mira/teleguiado (M armas) |
| `0x2c3a00` (ponteiros para nomes) | **tabela de pickups**: 0 Machine Gun, 1 Fire Missile, 2 Homing, 3 Swarmer, 4 Napalm, 5 Ricochet, 6 Power, 7 Turbo, 8 Health 30 Percent, 9 Environment Attack, 10 Upgrade, 11 Remote Bomb, 12 Full Health, 14 Mega Gun; a 2ª metade (15+) é a variante HC com Gas Can. **O word 8 dos registros `PKP` é esse índice** (valores 1–9 e 0xB nas arenas) | `src/game/weapons.ts` (`PICKUP_NAMES`, `pickupEffect`) |
| `FUN_00102a88` | gate de **disparo de armas**: slots `jogador[0..2]`, bit `0x800000` (segurando), limiar `jogador+0x30c > 600` (alvo longe) e munição `slot+0x12` | a usar nas armas |
| `FUN_00140038` | "Loading Car %s/%s id %d" (CarPager) | — |

## Escolhas do host que continuam (até achar no ELF)
Em `VEHICLE_RULES`: aceleração, vel. máxima, aderência, mola/amortecimento, raios de parede; modelo arcade em vez do corpo rígido original. (Gravidade já é nativa.)
Massa (`carro+0x848`): **origem não encontrada** — nenhum `swc1/sw` direto em `+0x848` no código do jogo (as gravações em `0x286xxx–0x287xxx` são de outro struct); provável cópia em bloco.

## Escolhas do host do combate (a trocar quando achar no ELF)
Dano, velocidade, munição e curva de cada arma, vida (100), turbo, tempos de renascimento, IA dos bots, colisão carro×carro, e o mapeamento visual dos objetos do `GLOBALS.BDD` (20 = ícone de arma, 17 = vida, 15 = turbo, 16 = míssil, 36 = bola de fogo, 29 = estouro — identificados por imagem).

## Áudio
Nativo: os **nomes** dos sons vêm dos bancos 989snd (`GLOBAL.BNK`: `W_MGUN`, `W_HOMMISS_LNCH`, `W_EXPLO_*`, `P_*`, `V_CRASH`…; bancos de carro: `C_IDLE_L/C_MID_L/C_HIGH_L/C_REV/C_SIREN_L`), lidos pelo vgmstream; a tabela de música por fase fica em `0x2c4cb9` (registros de 0x31 bytes, nomes identificam a fase).
Escolhas do host: qual evento dispara qual nome (`src/game.ts`: `LAUNCH`, `EXPLO`, colisão > 60 pés/s = `V_MAJOR_COLL`), mistura dos 3 laços de motor pela velocidade, volumes/barramentos, espacialização (`PannerNode`), banco de som de cada carro (`CAR_BANKS`), faixas das 5 arenas DM e das fases HC, ordem aleatória da playlist.

## Próximos alvos
1. Origem de `carro+0x848` (massa), `+0x854` (giro) e `+0x858` (vel. máx. mph): **não há gravação direta** (só cópias temporárias em `FUN_001ca240`/`FUN_001cb0d8` vindas de outro objeto) → provável cópia em bloco/arquivo. Física de direção: fora das 4 etapas do jogador.
2. Tabela de atributos de jogo (velocidade/armadura/especial da tela de seleção) — strings "Armor", "Speed".
3. Armas: strings de pickups (`PKP`), "Weapons Bay Full" (`0x2ba554`, dado sem xref direta → tabela).
