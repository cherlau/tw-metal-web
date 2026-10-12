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
| `FUN_0022cd58` | **percurso de desenho do grafo de cena** (`switch` pelo tipo = 5 bits baixos do word; bit 5 = flag); categoria = `word >> 18`, ID = `(word >> 6) & 0xFFF` | base para tudo que é animado |
| `FUN_0022c678` | **matriz do osso `0x0D`**: translação `+0x04/+0x08/+0x0C`, rotação Euler `+0x10/+0x14/+0x18` (`FUN_00236e50`); cada componente constante ou `canal[índice]` (rotação = −canal) conforme bits 32..37 do u64 `+0x18`; bits 48..62 = canal de visibilidade (bit 63 liga); bits 38/39 = usar inversa/bind (`FUN_00236298` = multiplicação). Canais = floats em `nóObjeto0x11+4` | lançadores: canal `vis` + `tx` → aparecem e deslizam com a arma (`src/game.ts`) |
| `FUN_00210f80` / `FUN_00210fe8` | busca de nó por (categoria, ID) nos objetos do nível | — |
| `FUN_002110d8` | índice do primeiro clipe com a categoria pedida em `obj+0x20` (clipes de animação de personagem; usado com 0x3C/0x3D/0x3E em `FUN_00156948`, `FUN_0015c120`) | não confundir com lançadores |
| `FUN_00140038` | "Loading Car %s/%s id %d" (CarPager) | — |

## Escolhas do host que continuam (até achar no ELF)
Em `VEHICLE_RULES`: aceleração, vel. máxima, aderência, mola/amortecimento, raios de parede; modelo arcade em vez do corpo rígido original. (Gravidade já é nativa.)
Massa (`carro+0x848`): **origem não encontrada** — nenhum `swc1/sw` direto em `+0x848` no código do jogo (as gravações em `0x286xxx–0x287xxx` são de outro struct); provável cópia em bloco.

## Escolhas do host do combate (a trocar quando achar no ELF)
Dano, velocidade, munição e curva de cada arma, vida (100), turbo, tempos de renascimento, IA dos bots, colisão carro×carro, e o mapeamento visual dos objetos do `GLOBALS.BDD` (identificados por imagem): ícones de pickup = modelo 3D da arma — 15 Turbo, 16 Fire, 17 Full Health, 18 Health 30%, 19 Homing, 20 placa amarela (Environment Attack / Machine Gun / Mega Gun), 21 Power, 22 Remote Bomb, 23 Ricochet, 24 Swarmer, 25 Napalm, 26 Upgrade (`PICKUP_MODELS` em `src/game.ts`); aura = sprite aditivo na cor do modelo (cores escolhidas); 16 = míssil, 36 = bola de fogo, 29 = estouro.

## Montagem dos modelos (2026-10-11, revisão dos carros)
Achado no próprio `.ngp` (sem ELF): estado do GS por grupo (camada de reflexo semitransparente), layout dos ossos `0x0D` (bits 7/6/5), filho de `+0x0C` dos `0x15`, seletores `0x05`. Detalhes em `docs/FORMATS.md`.
Escolhas do host que dependem do código do jogo (a trocar quando achar no ELF):
- **Rodas** (`tools/wheels.py`): altura de repouso nos casos B/D; pontos nativos de física (`0x2ba990`) + encaixe no arco da carroceria nos casos C (Crimson Fury) e E (hc_suv); recentralização em x das rodas do ATV.
- **Rodas, relato 2**: assentamento do caso B (cubo dos braços / arco atravessado), y do Crimson Fury entre arco e ponto nativo, caso E generalizado (Thumper, hc_vette, hc_derby).
- **Lançadores**: resolvido (2026-10-12) — são clipes do próprio carro tocados pelos suportes de arma; ver "Clipes e suportes de arma" abaixo. `tools/launchers.py` só vale para modelos sem esqueleto.
- **Peças escondidas por modelo** (`HIDDEN_PARTS` em `tools/convert_model.py`): barras do Hearse, macaco do Thumper; fachos de farol `…8a00` → `code:beam`; reflexo sem grupo de estado com alfa < 0,9 → estado padrão.
- **Condicional `0x1F` de evento** (byte 3 = `0x06`): fora da pose base (figura da escotilha do hc_hears).
- **Seletores `0x05`**: filho ativo em repouso (pose do personagem = 1º filho não vazio; carroceria do hc_sweet/hc_chrom = 1º filho quando > 500 tri).
- **LOD**: opção com mais triângulos.
- **Clarão do tiro**: texturas `8a480`/`8fed0`, aceso 60 ms por tiro.
- **Spawn**: carro nasce virado para a direção mais livre (16 raios), já que os nós PTS não têm direção.

## Áudio
Nativo: os **nomes** dos sons vêm dos bancos 989snd (`GLOBAL.BNK`: `W_MGUN`, `W_HOMMISS_LNCH`, `W_EXPLO_*`, `P_*`, `V_CRASH`…; bancos de carro: `C_IDLE_L/C_MID_L/C_HIGH_L/C_REV/C_SIREN_L`), lidos pelo vgmstream; a tabela de música por fase fica em `0x2c4cb9` (registros de 0x31 bytes, nomes identificam a fase).
Escolhas do host: qual evento dispara qual nome (`src/game.ts`: `LAUNCH`, `EXPLO`, colisão > 60 pés/s = `V_MAJOR_COLL`), mistura dos 3 laços de motor pela velocidade, volumes/barramentos, espacialização (`PannerNode`), banco de som de cada carro (`CAR_BANKS`), faixas das 5 arenas DM e das fases HC, ordem aleatória da playlist.

## Próximos alvos
1. Origem de `carro+0x848` (massa), `+0x854` (giro) e `+0x858` (vel. máx. mph): **não há gravação direta** (só cópias temporárias em `FUN_001ca240`/`FUN_001cb0d8` vindas de outro objeto) → provável cópia em bloco/arquivo. Física de direção: fora das 4 etapas do jogador.
2. Tabela de atributos de jogo (velocidade/armadura/especial da tela de seleção) — strings "Armor", "Speed".
3. Armas: strings de pickups (`PKP`), "Weapons Bay Full" (`0x2ba554`, dado sem xref direta → tabela).

## Desenho do scene graph — `FUN_0021b3c0` (2026-10-12, Mr. Grimm)
Exportado em `artifacts/native/skin` (alvos `tools/native/skin-targets.txt`). É o percurso com callbacks de
desenho por categoria (`DAT_0038fd18`); `FUN_0022cd58` é outro percurso (pilha de matrizes **inversas**, consultas).
- `0x0D`: rotação = **−valor** sempre (constante ou canal) → `FUN_00236e50`; `pre`/`post` como em `FUN_0022c678`;
  translação somada depois. Antes o host negava só os canais: o hc_stock (rotação constante −π/2) caía 9 pés abaixo.
- `0x1F`: rotação s16 `+0x08/+0x0A/+0x0C` × π/32768 (`FUN_00236f48`, VU0 microprograma 0x798 — sinal conferido no
  Grimm, onde o `0x1F` 0x47e0 é exatamente a inversa do bind do garfo), translação `+0x10`, `+0x0E` filhos.
- `0x03`: soma `R·(+0x10..+0x18)` à translação.
- `0x15`: só repassa a lista de filhos de `+0x0C` (n em `+0x04`) com a matriz atual — a matriz em `+0x10` não entra.
- `0x18`: escala `+0x20..+0x28` e translação `(t + (+0x30..))/escala`; filhos em `+0x60`.
- `0x13`: entrada = byte em `(nó 0x14 atual) + (+0x0C)` → filho em `+0x10 + 12·i` (estado gravado pelo código).
Escolhas do host que restam: pose ociosa = pose de bind (`rig.rest`, das inversas dos `0x15`), canais de roda sem
clipe (`rig.direct`) girados pela distância e esterço com amplitude 0,611 rad.

## Clipes e suportes de arma (2026-10-12)
Exportados em `artifacts/native/weapclip*`, `carapi`, `mounts*`, `samplers`, `pkn` (alvos `tools/native/*-targets.txt`).
`InspectNative.java` agora cria a função em memória quando um alvo `at:` só é alcançado por tabela.

| Endereço | Evidência |
|---|---|
| `FUN_00212290` | amostra um clipe nos canais: trilhas antes do cabeçalho, amostrador `0x2c77e0[(tipo&7)·3 + ((tipo>>1)&0x1c)/4]`; bit 15 do tipo vai para a mistura (`FUN_002124b8`) |
| `0x2a62f0` / `0x2a66d0` / `0x2a6a68` / `0x213898` / `0x2a6e70` / `0x2a7238` / `0x2a7558` | amostradores dos tipos 0, 1, 2, 3, 4, 5, 6 (variantes usadas nos carros) |
| `FUN_002113c0` / `FUN_002115f8` / `FUN_00211780` | tempo normalizado da instância `[flags, clipe, ?, velocidade, início]`; clamp em [0,1] (ou laço se flag 0x10000) |
| `DAT_002f4308` (+= `DAT_002f4540` em `FUN_00210e80`) | relógio das animações em ticks de 1/60 s |
| `FUN_0011dda0` → `FUN_00127060` | instâncias do carro em carro+0x3c: cat. 0..3 / 4..7 / 8..11 = giro / suspensão / esterço da roda i (`FUN_001276a0` velocidade, `FUN_00127708` tempo, `FUN_00127608` tempo = ângulo/π + 0,5); 0x0D..0x21; 0x18, 0x19, 0x0C; 0x22..0x25 nos de piloto (0x65, 0x67, 0x73, 0x77, 0x7a) |
| `FUN_001fa2f8` | pose de repouso: amostra 0..11, 0x18, 0x19, 0x0C em t=0 |
| `0x127608..0x127ed8` | API: `FUN_00127778` toca (vel. 1; **2 se veículo < 0x76**), `FUN_00127980` toca ao contrário, `FUN_00127be8` retoma, `FUN_00127d58` volta (−2), `FUN_00127e68` congela, `FUN_00127ed8` zera |
| `FUN_00148d38` | 5 suportes (0x54 bytes em inventário+0x50): categorias 0x0D, 0x0E, 0x15, 0x16, 0x17 |
| `FUN_00148e00` | arma → suporte por veículo (tabela em `tools/rig.py: MOUNT_CLIPS`); depois marca estado 1 nos suportes de 3, 6 e 4 (🟡 efeito) |
| `FUN_0014a168` → `FUN_00148978` | por quadro: abre o suporte da arma selecionada só se nenhum suporte estiver aberto/fechando; fecha o da arma que saiu; seletores `carro+0x640c/0x6410` mostram o projétil (tipo 2→1, 3→2; 6→1, 9→2) |
| `FUN_00120ba0` | pickup → tipo de arma: 1→2 Fire, 2→3 Homing, 3→9 Swarmer (HC: 10), 4→4 Napalm, 5→7 Ricochet, 6→6 Power, 9→8 Ambiente, 11→10 Remote; 0 = metralhadora (inventário carro+0x4dc4) |
| `FUN_0014cf78` / `FUN_0014cfd8` | arma tipo 8 (ataque de ambiente) toca o clipe 0x12 e fecha 0x12/0x13/0x14 |
| `FUN_001dd1c0` | especial: zera o clipe do suporte da arma selecionada (2,3→0x15; 4→0x0E; 6→0x16; 7→0x0D) |
