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
Massa, giro e vel. máx. (`carro+0x848/+0x854/+0x858`): **achados em 2026-10-13** — tabela 0x2b8ab0 copiada por `FUN_0012ece0` (ver "Direção").

## Escolhas do host do combate (a trocar quando achar no ELF)
Vida (100), turbo, tempo da carcaça, colisão carro×carro, e no visual: aura dos pickups (sprite aditivo, cores escolhidas), prefabs 36 (bola de fogo) e 29 (estouro) no lugar das partículas de explosão. Armas, pickups e especiais: ver "Armas" abaixo (o que ainda é aproximação está marcado ⚠️ lá e em `docs/PENDENTES.md`).

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
3. ~~Armas~~: feito em 2026-10-13 (seção "Armas").

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

## Clipes da arma especial na troca de arma (2026-10-14)
Exportados em `artifacts/native/specsel*`, `specstate*` (alvos `tools/native/specsel*-targets.txt`, `specstate*-targets.txt`). Tabela pronta em `src/game/specialclips.ts`.

| Endereço | Evidência |
|---|---|
| `FUN_0014a4e0` | troca de arma: chama a vtable `+0x1c` da arma que sai (desselecionar); a que entra passa pelo `+0x14` (selecionar → estado 0 da classe) |
| `FUN_00148e00` | a especial (tipo 1) não tem suporte em nenhum veículo — o movimento da carroceria vem só da classe |
| vtables (`+0x54` da classe, gravada pelo construtor de `FUN_0011d340`) | HO: 0x60 bytes por classe (Axel `0x2d6038`, Sweet `0x2d95b0`, Crimson `0x2d7448`…); os HC ficam logo depois na mesma área |
| estado 0 | com munição (`FUN_001485d8` > 0): `FUN_00127be8(0x1a)` (retoma +1) em Roadkill, Spectre, Twister, Crimson, Warthog, Thumper (sem teste), Hammerhead (zera 0x1b); `FUN_00127778(0x1a)` (do início, +2) no Sweet; Hearse 0x1a+0x1b; Axel/Eddy 0x1b+0x1f; Cop zera e retoma 0x1a no `+0x14`; Slam inverte 0x1c e toca 0x1a; HC: `FUN_00127778(0x1a)` (+1) |
| `+0x1c` | `FUN_00127d58(0x1a)` (volta a −2) na maioria; `FUN_00127980(0x1a)` (−k) no Sweet, Slam e HC |
| API | `FUN_00127778` toca do 0 a +1 (+2 se veículo < 0x76); `FUN_00127be8` retoma a +1; `FUN_00127980` −1 (−2 se < 0x76); `FUN_00127d58` −2; `FUN_00127ed8` zera; `FUN_00127d08` liga 0x40 (termina o laço) |
| Hammerhead | 0x1a só gira o osso 10 (canal 24: −1,58 → 0); a turbina (ossos 9/11, visibilidade 22/27 = 1 em todos os quadros) é fixa; 0x1b (disparo) liga a chama (osso 43) e gira a turbina (canal 31) |

## Clipes do disparo das especiais e especiais dos chefes (2026-10-14)
Exportados em `artifacts/native/boss`, `boss2`, `boss3` (alvos `tools/native/boss*-targets.txt`). Tabelas em `src/game/specialclips.ts` (clipes) e `src/game/specials.ts` (`edplayer`, `darkpla1`). Os chefes (`dark1`, `dark2`, `edboss`) ficam só documentados: o port joga com as versões jogáveis (pedido do usuário, 2026-10-14).

| Endereço | Evidência |
|---|---|
| disparo (vtable `+0x44`) | Axel `FUN_001165a8` estado 2: zera/retoma 0x1a, zera/toca 0x1c (carregada 0x1d, 0x1e > 0,25); Grimm `FUN_001b07f0(1)` toca 0x1b (0x1e carregada); Sweet `FUN_001dc078` zera/toca 0x1b; Cop `FUN_001b8318` 1: retoma 0x1b (laço), 2: `FUN_00127d08`; Hammerhead `FUN_00196b60` com alvo → estado 1 (`FUN_00197da0`: toca 0x1b), sem alvo → 4 (termina e zera 0x1b); Slam `FUN_001b3278` 4/5: zera 0x1a/0x1b, toca 0x1b; 7 → 0: toca 0x1a e inverte 0x1c |
| ATV `FUN_00115b78` | estado 1: 10 × 0x24 + toca 0x1c; 15 tiques depois `FUN_001161d8` + toca 0x1d (o modelo não tem 0x1c/0x1d). Estado 2 (bots: `FUN_00237d20(0,2) == 0`): `FUN_00116358(2)` toca 0x1b a vel. 2 (`FUN_00127b68`); com ele > 0,4 trava a 15° (0x3e860a92) em 4000 pés (0x4b742400) e atira 0x23 (bot) / 0x22; fator por distância no projétil `+0x58` (0,75 / 1,5 / 2 / 2,5 por 300/750/1500 pés) |
| HC | hc_axel `FUN_001b0e90(1)` 0x1b/0x1e; hc_hears `FUN_001c93c8` 0: toca 0x1a, 3: inverte; hc_taxi `FUN_001c9918` 1: 0x1c, 2: 0x1b, 0: zera e toca 0x1a; hc_preac `FUN_001db178`: congela 0x1b, toca 0x1c; 2: toca 0x1b; 3: zera; canhão `FUN_001dcc6c` toca 0x1a, `FUN_001dd3c0(2)` 0x1b, `FUN_001dce7c` termina 0x1b; hc_semi 1: zera 0x1a; hc_suv `FUN_001e39b0(1)` zera/toca 0x1a |
| Dark Tooth 1 `FUN_0016b6f0` / `FUN_0016c708` / `FUN_0016c1a8` / `FUN_0016b828` / `FUN_0016c0a8` | aperto: zera e toca 0x1b (216 quadros a vel. 2); ponto carro + R·(0, 19,9, 11,26) (bot: (0, 36,27, 19,5)); agarra o mais perto a < `+0xc0` = 50 pés (×2 se o alvo é 0x76); sem alvo procura até o clipe 0,78 (fração 0,5); preso vai ao ponto (fração → 0,99 a 0,15); em 0,78 `FUN_0016bea8` (efeitos 0x36/0x3e/0x3b/0x3c) e arremesso: parede → normal·73,3; senão pitch `+0xc8` = 33°, (`+0xcc` = 200 mph — 30 no 0x76; 275 − mph se passar de 403,3)·1,4667 + vel., × `+0x848` do alvo; `+0x5c` = 0x30 / 0x78 (bot); `+0x60` = 20 / 12 não lido |
| Dark Tooth 2 `FUN_0016ca80` / `FUN_0016dfa0` / `FUN_0016d298` / `FUN_0016d540` / `FUN_0016d768` / `FUN_0016dc20` | modo `+0x60` (2 no humano; bots 2 na fase 3 de `DAT_003281d8`, senão 3); modo 2 com o alvo de `FUN_0013dfe8` < 75 pés acima: raio (`FUN_00247580` efeito 0x1f) de `+0x78` = 250 pés, golpe 0x29 de `+0x74` = 0,1 por tique, `+0x70` = 300 tiques; senão tempestade em carro + R·(0, 9, 122 | 145 humano): prende quem está a < `+0xe4` = 400 pés (impulso 58,67 pés/s, giro U(±3), golpe tipo 1 de `+0xdc` = 10), preso leva `+0xe0` = 0,01 por tique e 1/61 de impulso 29,33; `+0xd8` = 300 tiques |
| Eddy chefe `FUN_0017a898` / `FUN_0017b1a0` / `FUN_0017ae10` | estado 1: no chão (4 rodas com normal > 0,707) rumo a `+0x68` = 250 mph (fração `+0x70` = 0,25) por `+0x64` = 120 tiques, seletor `+0x62d4` = 1; bots no estado 0 sorteiam 1/2 o carregado: retoma 0x1a e, com ele ≥ 0,9, retoma e congela 0x1b; estado 2: raio 13 pés acima, `+0x84` = 300 pés, golpe 0x29 de `+0x80` = 0,12 por `+0x7c` = 300 tiques |
| Cousin Eddy jogável (0x77, "Cousin Eddy P") `FUN_001174a0` / `FUN_001176b8` / init `FUN_001173a8` | estado 1: zera/retoma 0x1a, zera/toca 0x1c, onda de `FUN_00116940` com `+0x60` = 100 pés, golpe tipo 1 de `+0x64` = 23 e impulso `+0x68` = 80 mph·massa; `+0x5c` = 0x30 |
| Dark Tooth jogável (0x78, "Dark1 P") `FUN_0016fe00` / `FUN_00170360` / `FUN_00170688` / `FUN_00170a30` / init `FUN_0016fc40` | estado 0: toca 0x1a (laço de 636 quadros) se < 1; aperto → estado 1 por `+0x68` = 5 s: trava (`FUN_00170c30`, cone `+0x84` = cos 45°, `+0x78` = 300 pés) e golpe tipo 1 de `+0x7c` = 5; com o botão segurado (`+0x21` = 1) golpe de `+0x80` = 1 por tique (`FUN_00170d30`); alvo a ≥ 300 pés é solto e o arco gira à frente (raio 50); relâmpago `FUN_0021e1e8` (emissor 0x28) do carro ao alvo; fim `FUN_00170dc8` (gasta, espera `+0x5c` = 0x30). `darkpla2` (0x79, "Dark2 P") é a forma gigante (140 pés), fora do menu |

## Estados de dano — nós `0x13` (2026-10-12)
Exportados em `artifacts/native/dmg*` (alvos `tools/native/dmg-targets.txt`, reescrito a cada rodada).

| Endereço | Evidência |
|---|---|
| `FUN_0022cd58` / `FUN_0022c978` | escolha da entrada: `byte[(nó 0x14 atual) + nó0x13[+0x0C]]` → filho em `+0x10 + 12·i`; o u16 seguinte (`0x14 + 0x0E`) vira o id do objeto atingido (`DAT_0041b71c`) |
| `FUN_0021b3c0` caso `0x13` | chama o callback do topo da pilha (`DAT_0038fd18`) com o nó e empilha **todas** as entradas — é o percurso de **coleta** na criação dos objetos, não o desenho |
| `FUN_00168aa8` (níveis) / `FUN_00124288` (carros) | callbacks desse percurso: cada `0x13` vira um objeto de `0xE0` bytes (`FUN_00170f98`, vtable `0x2d75c8`, `destruct.cpp`): `+0x90` = nó `0x13`, `+0x94` = nó `0x14`, `+0xA4` → vida (float). Nos carros, categoria (`word >> 18`) **`0x46`** → lista em `carro+0x6190` (`FUN_0012e9e0`, até 16) |
| `FUN_00171650` | vida máxima: classe = byte `+0x09`; 1..5 → tabela `0x2e0ff8` = **1, 20, 60, 100, 300**; 0 → u16 `+0x04` (dark2: 375); outra → 1 |
| `FUN_001715c0` → `FUN_00171560` | fração = vida/máx; entrada = **1ª com limiar (u16 `+0x18 + 12·i`) ≤ int(f·65535)**, senão a última. Limiares vistos: `0xE665` 90%, `0x7FFF` 50%, `0x5999` 35%, `0x3FFF` 25%, `0x3332` 20%, `0x28F` 1%, `0` |
| `FUN_00172768` | piora: se acima do alvo `+0xA2`, agenda `FUN_00172908` (grava `+0xA2` no byte) para **agora + 2 tiques** (`FUN_0025e918`; `0x2e1010`/`0x424` = "destruct.cpp", linha) e solta o efeito da entrada (`+0x14 + 12·i`, `FUN_00172938`); melhora: grava na hora |
| `DAT_002f4548` | relógio dos temporizadores: +1 a cada 9600 contagens do timer do EE (576 kHz) = **60 Hz** (`0x264380`, `0x2644dc`) |
| `FUN_0012e8c0` (`FUN_0011e3d0`, `FUN_00122620`) | por quadro: `f = carro+0x4dc0 / FUN_002a0670(carro+0x4db0)` (vida/vida máx.); **0 < f < 0,01 → 0,02** (vivo nunca chega à última entrada); se mudou, `FUN_00171498(f)` em cada parte: vida = f·máx → seleção acima |
| `FUN_0012ea48` (renascer) | `FUN_00171410` (zera `+0xA2`, libera efeitos presos no byte `+1` do estado) e vida cheia → entrada 0 |
| `FUN_00171838` / `FUN_00171fc8` (vtable `+0x10`/`+0x20`) | golpe nos destrutíveis (arenas, peças HC): ignora dano ≤ u16 `+0x06`; tipos 4/0x29 e categorias `0x4658..0x4674` têm regras próprias; `0x468C` só a ≤ 10 pés |

Implementação: `tools/ngp.py` (`DamageNode`, `scene(damage_states=True)`), `tools/convert_model.py` (`damageScene`, `damage`, marca `dmg` nas instâncias; só carros), `src/rig.ts` (`damageEntry`, `CarRig.setHealth`/`resetDamage`), `src/game.ts` (vida por quadro; carcaça visível enquanto morto).

## Ações e destroços (2026-10-12)
Exportados em `artifacts/native/fx`, `fx2` (alvos `tools/native/fx*-targets.txt`).

| Endereço | Evidência |
|---|---|
| `FUN_00172938` | solta o `fx` do nó `0x13`: tipo 1 → recursa no filho `+0x08` com a matriz `+0x10`; senão `FUN_00100f78` (normal, com atraso) ou `FUN_001010b0` (imediato) no gerenciador `0x2f4b70`, na posição do objeto (`+0xB0`) |
| `FUN_00101010` | agenda o handler para daqui a `(int) f32 +0x04` tiques (`FUN_0025e918`, "actionDispatch.cpp") |
| `0x2dad48` | handlers por u16 tipo: 0 lista (`+0x08` n, ponteiros em `+0x0C`), 1 transformação, 2 clipe (`FUN_00101720`), 3 destroços (`FUN_00101800`), 4 som (`FUN_00101848` → `FUN_001a0db8`: id → `D_CONCRETE_SM`…, `tools/actions.py: SOUND_NAMES`), 5 tremor de câmera e 6+ "unsupported" |
| `FUN_001729e0` → `FUN_0016e678` | destroços: n peças = (u64 `+0x08` >> 53) & 0x1FF (≤ 32); peças de 0x14 bytes em `+0x28` (pos `+4`, descritor `+0x10` = [*modelo, massa, 0,25, ?, *casco]); caixa = esfera/eixos do cabeçalho da malha (`+0x20`, colunas de `+0x30/+0x40/+0x50`) × 0,75, eixos < 1 normalizados; direção = peça − centro (`+0x10`) girada, ± 5 % do raio; impulso = (vel. `+0x1C` + fator) × 1000 (`gp−0x75e4`) / 60 (`DAT_002f4544`) / massa, aplicado no canto máximo; fator = 1 sem golpe, peso por arma (2,25/2,5/4,5…) com golpe direto, \|v\|·20 em batida |
| `FUN_00173a80` | por quadro: idade em tiques; a partir de vida (180) − 60 (`gp−0x75a4`) o alfa cai 1/s; voo livre `FUN_00251dc8(dt, −128)` |
| `FUN_001738e0` | corpo: `+0x10` = 0,8, `+0x14` = 0,25 (🟡 atrito/restituição), inércia de caixa; 50 % de rastro de fumaça se o objeto se movia (não implementado) |

## Seletores dos carros (2026-10-12)
`FUN_00124288` (coleta) guarda cada nó por categoria no carro; `FUN_00230138(nó, i)` grava o filho (byte `+0x08`, só se < n). Exportados em `artifacts/native/sel*`.

| Categoria | Campo | Quem troca |
|---|---|---|
| `0x40` (brilho dos faróis, sprites `bc9c8`) | `+0x62d0` | `FUN_0011f110`: 1 se `carro+0x62e0` bit 32 — **nunca ligado no código** (só zerado em `FUN_0011b670`/`FUN_0011c6e0`) |
| `0x41` (lanternas) | `+0x62cc` | `FUN_0011f1e8`: 2 se controle `+0x10` (freio) > 0, 1 com o bit acima, senão 0 |
| `0x43` (casca de fogo, textura `7dcf4`) | `+0x62c0` (+`0x62c4` no 0x83) | `FUN_00123010`: bit 2 de controle `+0x1C` liga por `gp−0x7e28` = 180 tiques e toca a instância `0x19`; o bit 2 vem do combo de energia `FUN_0012d1b8` (casca de fogo, ver "Ataques de energia"); a IA liga o bit 4 (`FUN_00104b28`) |
| `0x44` (chama do turbo) | `+0x62d4` | `FUN_001238c8`: 1 enquanto controle `+0x0C` (turbo) ≠ 0, com emissores de partículas (não implementados) |
| `0x1b1` / `0x1b2` | `+0x640c` / `+0x6410` | `FUN_00148978`: ao abrir o suporte, tipo 2→1, 3→2 / 6→1, 9→2; ao fechar, 0 |
| `0x53` | `+0x6414` | 🟡 |
| `0x3C` (registros `0x00F0`) | `+0x61d8 + 4·tipo` | `FUN_00147568` pendura o modelo da tabela `0x37cbf0+0xda24` (mesma do projétil em voo, `FUN_00203c68`) |
| `0x3E` (registros `0x00F8`) | posições em registros de arma (passo `0x70`) | pontos de disparo — nada desenhado |

## Piloto (2026-10-12)
`FUN_00127060` cria `0x25` (+0xad), `0x22` (+0xb2, tempo direto), `0x23` (+0xb6), `0x24` (+0xbb) só nos veículos 0x65, 0x67, 0x73, 0x77, 0x7a. `FUN_0011e3d0`: `FUN_00125688` em 0x67/0x7a/0x73 (exige `carro+0x68c0` bit 49, desligado só durante a arma especial), `FUN_001258f0` em 0x65/0x77. Estado `+0x6338`: no ar (`+0x7c1`, `+0x7c8` > 5) → `0x23`; ao pousar → `0x24` e, no fim, `0x25`; esterço `+0x4a8` = 0,5 → `0x25`; senão `0x22` com tempo = esterço suavizado (`FUN_00253128`: 0,1/0,001 ou 0,09/1e-5). `0x25` a 0,25 (0,15) × abaixo de 7,33 pés/s, senão 1×. Trocas com mistura `FUN_00210b08` de 15 quadros (30 no esterço). Laço do clipe: bit 1 do u16 `+0x0E` (`FUN_00211348`). Tabela de clipes: objeto `+0x20` (u16 n, ponteiros em `+0x10`), 1º de cada categoria (`FUN_002110d8`).

## Renascimento (parcial, 2026-10-12)
`FUN_0011c6e0` (renasce o carro) é chamado pelos modos de jogo (`FUN_001b5478`, `FUN_001e8280`) quando o byte por jogador em `modo+0x244`/`+0x248` vale 2 (vira 3). Mensagem "PLAYER DEAD, RESPAWN IN %d" via tabela de textos `0x2c49a8`. Quem põe o 2 e o tempo ainda não achados.

## Destrutíveis das arenas (2026-10-12)
`FUN_00168aa8` (coleta dos níveis): cada `0x13` vira objeto `FUN_00170f98` com posição (`+0xB0`) e rotação (`+0xC0`) do percurso; categorias com gerente próprio: `0x21` (`FUN_0011b608`), `0x12d`/`0xeb..0xf2` (`FUN_001834e8`), `0x12e`/`0x12f`, `0x33fe..0x3404` (`DAT_0037c134`), `0x3f8` (`FUN_0019b8c0`) — 🟡 comportamento extra não implementado.
`FUN_00171838` (golpe): `0x1194..0x119d` tombam ao morrer (`FUN_001e2000`: cópia como corpo rígido, pool de 15, velocidade do golpe × 0,05; `FUN_001e2348` som/efeito por categoria); `0x1196..0x1198` e `0x119a..0x119d` pegam fogo com golpe tipo 4/0x29 (`FUN_00172bb0`: emissores de fogo, vida volta a cheia) em vez de quebrar; `0x11a3` só aceita golpe a ≤ 10 pés; `0x11f8..0x12c0` avisam `FUN_00113b28` ao morrer (🟡 objetivo/placar).
Levantamento: Arena 156 nós, Castelo DM 475 (378 árvores `0x1198`), Coliseu DM 149, Egito DM 13, Grécia DM 88, Paris DM 138 (66 postes `0x1194`), Tóquio DM 0; quase todos classe 1 (vida 1), Coliseu/Egito/Grécia com alguns classe 2 (20). As entradas destruídas costumam não ter malha: o objeto some, solta destroços e toca `D_*` do banco da arena (`snd/<nível>.bnk`; grafia do jogo `D_WOOD_HOLOW_*`, `D_METALHOLOW_*`).

## HUD (2026-10-13)
Exportados em `artifacts/native/hud*`, `screen` (alvos `tools/native/hud*-targets.txt`). Implementação: `tools/hud.py`, `tools/export_ui.py`, `src/hud.ts`, `src/font.ts`.

| Endereço | Evidência |
|---|---|
| `FUN_0013b060` | objeto do HUD com 12 widgets (vtables 0x2d62a0..0x2d64b0; slot 7 = atualização) |
| `FUN_0013b310` | coletor por categoria do GLOBALS: 0x206d radar (+0xC0), 0x206e painel (+0x24E0), 0x1ffe carga do especial (+0x14D0); 0x1fcb..0x1fce setas do radar, 0x1f48/0x1f52/0x1fd8/0x2076 seletores do painel; 0x2080..0x208a por `FUN_0013a610` (0x2080 modelo da arma, 0x2081/0x2082 ícones, 0x2085..0x2087 HC) |
| `FUN_0019e458` / `FUN_0019e580` | posição na frente da câmera: (x·prof/1,5, prof, z·prof·0,5) com a rotação da câmera — radar (−0,68; 3,0; 0,575), painel (0,69; 3,5; −0,6), carga (0; 4,02; −0,43) |
| `FUN_00139678` / `FUN_00139938` | clipe 0 do objeto 0x206e = vida/vidaMáx (pisca < 15 %), clipe 0x10 + seletor 0x1fd8 acima de 86,957 % com o bit 0x40 de carro+0x63f0 |
| `FUN_00139cd8` / `FUN_00139de0` | clipe 2 = carro+0x6894 (turbo), clipe 1 = carro+0x6898 (energia) |
| nó 0x18 | u16 em +0x12/+0x14/+0x16 = canal da escala x/y/z (turbo canal 2, energia 3, vida 4, excesso 8) |
| `FUN_00137148` / `FUN_00137620` | radar: inimigos < 900 pés, (direita·0,054, frente·0,028)·12,5 em 1/16 px, quadrado ±0x16; cor 0x2ba6c8 + id·16 |
| `FUN_00139780` | alvo do topo: o mais perto num cone cos(0,96); nome curto 0x2b39f0 + i·0x20, em (142, 9), tamanho 14 |
| `FUN_0013aa88` | nome da arma (0x2ba680 / HC 0x2ba6a8) em (538, 152) e munição "%d" em (538, 186), tamanho 12 |
| `FUN_0013a0b8` | mensagens (tabela 0x2ba4c0): 120 quadros cada, (320, 6), cor (0xdd, 0xdb, 0x0a) |
| `FUN_00221e78` / `FUN_00223318` / `FUN_00223040` | fonte: glifo s×s, avanço 1,125·s × largura/32 da tabela 0x2c7ae8; espaço 0,625; sombra de 4 cópias alfa 0x40 (`FUN_002224a0`/`FUN_00222660`) |

## Menu (2026-10-13)
Arte do SHELL/UI.BDD: logo = raízes 0x2397..0x2399; ícones de seleção na ordem da tabela 0x2b39f0; cartões de piloto 0x49904..0x49d64 ligados pelas biografias "Car:/Driver:" do ELF; nomes das fases (0x2e6138..0x2e6240); dificuldades SUPER EASY/EASY/MEDIUM/HARD (0x2c45b8). Túnel do SWIRL.BDD ao fundo.

## IA dos bots (2026-10-13)
Exportados em `artifacts/native/ai`, `ai2` (alvos `tools/native/ai*-targets.txt`). Tabelas em `rules/ai.json` (`tools/native/export_rules.py`); implementação `src/game/ai.ts`.

| Endereço | Evidência |
|---|---|
| `FUN_00102300` | perfil 0x2b2d10 + i·0x40 (i = carro+0x14); dificuldade multiplica +0x18 (×5/×4/×2) e +0x1c (×3/×2/÷2) |
| `FUN_0013d800` / `FUN_001027f8` | habilidade = mín(0,72 / 0,85 / 1, base + (1 − base)·prog·k), k = 0,33/0,4/0,5/1 |
| `FUN_00106f80` | máquina das armas +0x288: 1 escolhe, 2 troca, 3 espera, 4/5 alcance, 6 dispara, 7/8 especiais |
| `FUN_00107500` / `FUN_00107600` / `FUN_001098b0` | escolha pela proporção de uso desejada (0x2b1d20 frente, 0x2b2518 ré) |
| `FUN_00107148` → `FUN_00148638` | se não tem munição da arma escolhida, ganha 1 |
| `FUN_0010ba08` | alcance máx./mín./alinhamento por tipo (0x2b35d0/0x2b3610/0x2b3650) |
| `FUN_00105970` | cone da metralhadora (perfil +0x08, estreita até 500 pés, ajustado pela habilidade) |
| `FUN_00105520` | visada na altura do perfil (+0x14), contadores +0x3e0/+0x3e4 |
| `FUN_001034a0` | turbo (+0x12c) só com |esterço| < 10° e carga > 0,2; até esvaziar |
| `FUN_001049a8` | recua (modo 2) com vida < +0x32c (perfil +0x30 · U(0,75; 1,25)) |

## Direção (2026-10-13)
`FUN_0012ece0` copia 0x2b8ab0 + id·0x34 para o controlador em carro+0x340 (campos [0x142..0x14e] = carro+0x848..+0x878): massa, arfagem/rolagem visuais (`FUN_0012f2c8`), giro (`FUN_00132aa8`: alvo = entrada·giro, taxa 0,02 virado / 0,25 solto, ×1,75 no freio de mão), vel. máx. mph, aceleração/rolagem/freio por quadro (`FUN_00133650`; turbo ×3 aceleração, ×1,25 vel. máx.), dano de batida (`FUN_001349f0`: campo·mín(v − 100, 100)/100, a cada 60 quadros), impulso de pulo 🟡 (`FUN_001306b8`), alinhamento da velocidade 0,03/quadro (`FUN_00133078`). Constantes em gp−0x7c58.. (`tools/native` + `rules/vehicles.json` → `drive`). `FUN_00253128` = passo exponencial com mínimo.

## Som (2026-10-13)
Os nomes não são strings: o código monta cada nome em registradores de 128 bits (ori/dsll/pcpyld) — `tools/native/sound_sites.py` acha 240 chamadas e ~190 nomes. Atenuação `FUN_001d32d8` → `FUN_00216b78`: cheio até a mínima, linear até 0 na máxima; ouvinte = carro do jogador.

| Endereço | Som |
|---|---|
| `FUN_00141ca0` | batida: ≤ 5 V_TAP (vol. i·0,25), 5–15 V_CRASH, 15–25 V_MAJOR_COLL ((819 + 205·frac)/1024), > 25 cheio; faixa 10–200 |
| `FUN_001446d0` | turbo: V_TURBO_LAUNCH (≥ 61 quadros), V_MAXRPM_L (sobe em 180), V_TURBINE_L; saída 60/120 quadros |
| `FUN_00141770` / `FUN_001418b8` | V_TURBO_OUT; V_LOWHEALTH_L abaixo de 15 % (chamado pelo HUD) |
| `FUN_00142648` / `FUN_00145720` / `FUN_001457b0` | morte: W_EXPLO_LRG, W_PLAYER_DEATH, V_SCREAM (10–2000) |
| `FUN_00152b48` / `FUN_00150c98` / `FUN_001524a0` / `FUN_00154720` | W_EXPLO_MED 60–650, W_EXPLO_LRG 15–650, W_SWARM_LNCH 15–650, W_RICOCHET_BNCE 100–650 |
| `FUN_001451a0` / `FUN_001452d8` | S_DEPLOY / S_RETRACT dos suportes (bancos *WP.BNK) |
| `FUN_00141580` / `FUN_00153ff0` | WEAPON_CYCLE; W_BUL_DIRT/METAL/GLASS |

## Armas (2026-10-13)
Exportados em `artifacts/native/wtype`, `wtab`, `wfire`, `wclass`, `wball`, `pkr`, `hp`, `sw`, `appr`, `proj3` (alvos `tools/native/w*-targets.txt`, `pkr-`, `hp-`, `sw-`, `appr-`). A tabela de projéteis mora no BSS e é montada por código: `tools/native/mips.py` (emulador mínimo de R5900) roda `FUN_001fd4e0` e `tools/native/export_weapons.py` gera `src/game/weapon-tables.ts` (Head-On e Harbor City).

| Endereço | Evidência |
|---|---|
| `FUN_00203b10` (fábrica, "Invalid weapon type.") | 150 slots de `0x130` em `0x37cbf0+0x710`; tipo < `0x39`; tipo 8 (ambiente) devolve −1 |
| `FUN_00203c68` | instância: tabela `0x37cbf0+0xB930 + tipo·0x94`; vida = `+0x08`·60 tiques; velocidade `+0x0C` (mph; tipo 7 no HC soma a vel. máx. do carro); dano da instância `+0x1c` = `+0x00` (1000 com "Killer Weapons"; ×2 nas balas com munição de metralhadora > 1); luz `+0x5c` (RGB float `+0x60..+0x68`); partículas `+0x6c`/`+0x70`; modelo = `0x37cbf0+0xDA24 + 4·tipo`; escala 0,25 (`0x18`), 0,65 (`0x1d`); `0x24` sorteia ±100 mph |
| `FUN_001fd4e0` / `FUN_001fd3f8` | monta os 57 registros (padrões: cone de trava 40/75°, oscilação 10–20 tiques, efeitos −1, escalas 1); `DAT_002f4b14` = 0 Head-On / 1 Harbor City (`FUN_001fca10`) |
| `FUN_001fef00` | por tique: direção (`FUN_001ff0a8`), movimento (`FUN_001ffc98`), idade em tiques → fim da vida detona (`FUN_002024a8(p,0,1)`), senão colisão (`FUN_00200e28`) |
| `FUN_001ff0a8` → `FUN_001ff238`/`FUN_001ff298` → `FUN_001ff3a8` | modo `+0x18`: 0 reto (giro amortece), 1 persegue o alvo, 2 antecipa (alvo + vel. do alvo × dist/(vel·1,4667) × `+0x20`); só depois de 2 tiques |
| `FUN_001ff5a0` / `FUN_001ff800` | rumo/arfagem por `FUN_002537e8` (fração `+0x1c` por tique, mínimo 1e-4); fora de `+0x24`/`+0x28` graus perde a trava (sem oscilação); `+0x2c` limita o passo (`+0x34` longe, `+0x38` a menos de `+0x30` pés); tipo `0x12` acelera o giro 5 %/tique perto |
| `FUN_001ffa18` | oscilação (`+0x3c`): troca a cada U(`+0x4c`,`+0x50`) tiques, desvio ±`+0x40`/±`+0x44` graus; a < 300 pés amortece (giro → 0,25), a < 30 pés solta a trava |
| `FUN_001ffc98` | velocidade escalar rumo a mph·0,024444 pés/tique (fração `+0x10` abaixo dela, 1e-4 acima); despacha os movimentos especiais (`0xe` ricochete, `0x18`, `0x2c`, balísticos…) |
| `FUN_001ffff8` | rente ao chão (`+0x14`): ≥ 5 pés; sem alvo afunda a −0,5 pé/tique entre 5 e 300 pés |
| `FUN_002003f8` / `FUN_00201878` | Ricochete: rola a 5 pés do chão; parede (normal z ≤ 0,866) reflete (`FUN_002037d8`); depois do 1º quique o golpe vale ×3 no Head-On (30 fixo no HC) |
| `FUN_00191880` / `FUN_00191be8` / `FUN_001916b8` | balísticos (4, 10, 13, 0x33): gravidade 0,02 pé/tique² (exceto com `+0x08`); Napalm sai a 2,5 pés/tique para cima, vive 300 tiques, pousa a 2 pés e espera contato (raio 5); Remote/mina caem quase parados (0,2445 mph) e só explodem com carro (o dono depois de 180 tiques) ou no 2º toque |
| `FUN_002009d0` | 2º toque do Napalm: vertical −30 pés/tique, para de andar |
| `FUN_00201178` | fantasma (`0x15`, `0x34`): com alvo travado só colide com ele |
| `FUN_00200e28` | colisão: balas (0, 0x11, 0x12, 0x14) por raio, demais por varredura; golpe direto = dano da instância |
| `FUN_002024a8` / `FUN_00202d08` | detonação: efeitos `+0x74..+0x80` (escala `+0x84..`); área se `+0x04` > 0: carros no raio levam dano·máx(0, 1 − d/raio), mínimo 0,33·dano; cheio para 4/10/13/0x2b/0x33; Napalm ×1,5 a ≥ 85 %; destrutíveis em raio/2; só o tipo `0x16` poupa o dono |
| `FUN_00204778` (via `FUN_00168aa8`) | modelo por tipo = nó da categoria: Head-On 4000..4099 (0xfa0 bala, 0xfa1 Fire, 0xfa2 Homing, 0xfa4 Napalm — ausente no GLOBALS, 0xfa5 Ricochet, 0xfa6 Power, 0xfab Remote, 0xfac Swarmer…), Harbor City 0x1004.. |
| `FUN_0011d340` | inventários: metralhadora (`+0x4dc4`), armas (`+0x4fbc`: especial, Fire, Homing, Napalm, Power, Ricochet, Env, Swarmer, Remote = nomes `0x2ba680`), energia (`+0x51b4`: tipos 0xd, 0x10, 0xe — não implementados) |
| `FUN_0014b7d0` / `FUN_0014bc28` / `FUN_0014d7b0` / `FUN_00147420` | trava (cos do cone, alcance²): Fire 14,5°, Homing 30,5°, Napalm 5°, Swarmer 30°, 7000 pés; Power/Ricochet sem trava; munição inicial Fire 1, Homing 1; espera entre disparos 48 tiques (Swarmer 120) |
| `FUN_00124288` (cat. `0x3E`) / `FUN_00147ec8` | **pontos de disparo**: o registro `0x00F8` de id n vai para `obj+0x10` da classe — 1 especial (`+0x5f90`), 2 Fire (`+0x5520`), 3 Homing (`+0x54b0`), 4 Napalm (`+0x56d0`), 5 Swarmer (`+0x58f0`), 6 Power (`+0x5590`, também `+0x5a10`/`+0x5a88`), 7 Ricochet (`+0x5600`), 15 Remote (`+0x5990`), 8/9 metralhadora (`+0x53b0`+0x84/+0x88), 14 copiado para `+0x5bb0`. Saída = linhas `+0x40..+0x60` do nó do carro × ponto + `+0x20`; sem ponto, a origem do carro. Fixos: Ricochet (7) de 0x74 (9,28; 29,64 / ré −24,7; −5,88), 0x75 (8,65; ±25,15; −3,49), 0x76 (9,28; ±160; −5,88); 0x1f do 0x67 em (0, 10, 0). Energia/Remote têm ponto próprio em `obj+0x60`: congelar (0, 0, 5,172) `FUN_0014d478`, 0x10 (0, 0, 5) `FUN_0014c4e8`, mina `FUN_0014c0d0` e Remote `FUN_0014de98` (0, −3, −1) ou (0, 0, −1) em 0x65/0x67/0x6b/0x6c/0x71/0x73/0x77/0x7a/0x82 |
| `FUN_001474f0` / `FUN_00147568` / `FUN_00148978` | lançador: o modelo do projétil mora no slot `carro+0x61d8 + 4·tipo` (marcadores `0x00F0` gravados por `FUN_00124288`: ids 1..7 → tipo igual, 15 → 10 Remote, 10 → 11, 11 → 12; slot 9 Swarmer nunca preenchido). No disparo `FUN_00147ec8` chama `FUN_001474f0` (tira o modelo) e, com munição sobrando (≥ 2 antes de gastar no Napalm/Swarmer, que gastam depois), grava suporte+4 = 1: `FUN_00148978` pendura outro modelo e `FUN_00127778` recomeça o clipe do suporte em 0 (`FUN_002115f8(0, agora)`) com S_DEPLOY |
| `FUN_00148978` (modelo do lançador) | Head-On: tipo 4 (Napalm) usa a tabela+`0xdc04` e tipo 10 (Remote) +`0xdc08` (se gravados), não o modelo do projétil (`FUN_001fd4c8`). `FUN_00204778` grava `0xdc04` ← categoria **0x1002** e `0xdc08` ← **0x1001** (e `0xdc00` ← 0x1021, do especial `FUN_001e3120`) |
| `FUN_0014ae38` (saída) | metralhadora: com os pontos 8 e 9 alterna pela flag `obj+0x80` (1 ao soltar/superaquecer → começa no 9); com um só, usa ele; sem nenhum, (0, 0, 1) sem girar |
| `FUN_0014ad00` / `FUN_0014ae38` / `FUN_0014b738` | metralhadora: 1 tiro a cada 10 tiques (6 melhorada/Mega Gun); calor 100, −0,2 por tique segurando, +0,4 por tique 60 tiques depois de soltar; < 0,1 trava 300 tiques |
| `FUN_0014d970` / `FUN_0014dd00` | Swarmer: +1 míssil a cada 22 tiques segurando (máx. 6), solta sozinho em 132 + 78 tiques (`FUN_0014fe08` grava 22·6); arfagem U(1°, 20°), rumo ±20°; 1 munição por rajada |
| `FUN_001bc6f8` / `FUN_00120ba0` | pickup: +2 (HC: 1 para Swarmer/Napalm/Power/Remote; metralhadora 30, máx. 60); soma do compartimento ≤ 30; vida +30 (`FUN_001bcbe0` grava 30 em `0x35b4d4`) ou +100 só se faltar; turbo só se < 1; recusado = mensagem a cada 120 tiques |
| `0x2c3a70` (`FUN_001bcc20`, `FUN_001bc970`) | renascimento por tipo: U(mín, mín·3/2) s; colunas HO 1P/2P/2P, HC 1P/2P/2P; HO 1P: 30 s (Remote 60) |
| `FUN_001bdad0` / `FUN_001bd680` | ícone do pickup = nó de categoria `0x13ba + tipo` (Head-On) ou `5000 + tipo` (Harbor City) → objetos 15 = Ambiente (raio), 20 = Napalm, 25 = Turbo (o host tinha 15/20/25 trocados); a metralhadora (0) e a Mega Gun (14) só existem no HC |
| `FUN_0011ef10` | +1 carga do especial a cada `carro+0x62f0` tiques até 5 (1800; ATV-P 2160, Dark1-P 2400, HC Hearse/Grimm 2100, SUV 1620, Taxi 2160) |

## Armas especiais (2026-10-13)
Exportados em `artifacts/native/spec`, `spechc`, `cop` (alvos `tools/native/spec*-targets.txt`, `cop-targets.txt`). `FUN_0011d340` cria a classe por id de veículo; disparo = vtable `+0x44`. Tabela pronta em `src/game/specials.ts`.

| Carro | Classe / disparo | Comportamento (não carregado) |
|---|---|---|
| Axel | `FUN_00116498` / `FUN_001165a8` → `FUN_00116940` | onda: carros a ≤ 100 pés levam 15 e sobem a 80 mph·massa; carregado: 15 + 3 por nível a cada 35 tiques |
| Hearse | `FUN_00199170` / `FUN_00199350` | tipo `0x16` (raio 150); 2º toque detona |
| Mr. Grimm | `FUN_001b00a8` / `FUN_001b0298` | tipo `0x1e` quando o clipe 0x1b passa de 0,75; dano 25; espera 25 |
| Roadkill | `FUN_001c7f80` / `FUN_001c8070` | tipo `0x17` (trava 22,5°); carregado solta `0x18` |
| Sweet Tooth | `FUN_001dbed0` / `FUN_001dc078` | tipo `0x1b`, trava 30,5°, dano 18 |
| Thumper | `FUN_001e1360` / `FUN_001e1550` | 4 × `0x20` em 0/30/60/90 tiques (o lança-chamas `0x21` é a versão carregada; bots sorteiam 1/4) |
| Spectre | `FUN_001d5c98` / `FUN_001d62e8` | tipo `0x15` (+4° de arfagem), fantasma |
| Twister | `FUN_001e42d0` / `FUN_001e4670` | tornado: ver "Especiais corpo a corpo" |
| Mr. Slam | `FUN_001b1058` / `FUN_001b1330` | garra: ver "Especiais corpo a corpo" |
| Cop Car | `FUN_001b7a58` / `FUN_001b7c50` (`FUN_001b83f0`, `FUN_001b8220`, `FUN_001b88c0`) | choque no mais perto a ≤ 250 pés por 4 s (240 tiques), 0,025 por tique |
| Crimson Fury | `FUN_00169890` / `FUN_00169ea0` | tipo `0x19` |
| Hammerhead | `FUN_00196848` / `FUN_00196b60` | pisão: ver "Especiais corpo a corpo" |
| Grasshopper | `FUN_00192498` / `FUN_001927a8` | salto e mergulho: ver "Especiais corpo a corpo"; carregado atira `0x25` |
| Warthog | `FUN_001fcc10` / `FUN_001fcd00` | 3 × `0x28` (±5°), espera 70 |
| ATV | `FUN_00115960` / `FUN_00115b78` | 2 rajadas de 10 chumbos `0x24` (dano 1) a 15 tiques; espera 6 (humano) / 120 (bot) |
| HC | ver "Especiais do Harbor City" | StockCar e Tank Car não têm classe |

## Ataque de ambiente (2026-10-13)
Exportados em `artifacts/native/env`, `envlvl`, `envarena`, `envarena2`, `lvlid`, `sweep`, `tri` (alvos `tools/native/env*-targets.txt`, `lvlid-`, `sweep-`, `tri-`). Tabela pronta em `src/game/environment.ts`.

| Endereço | Evidência |
|---|---|
| vtable `0x2d67c8` (classe do tipo 8), disparo `+0x44` = `FUN_0014d040` | estado 0 → 1 com munição (`FUN_001485d8`); no 1 escolhe pela fase `DAT_002f4900`; sucesso gasta 1 (`FUN_00148748`); objeto ocupado → mensagem 0x4f "Env Weapon Already Active"; fase sem objeto (`default`, CASTLE = 7) → 0x50 "Env Weapon Unavailable"; os dois sem gastar; espera = `+0x5c` (RUSSIA 0xf0) |
| `0x2f4900` (struct da partida, campo 0) | índice do nome da fase na tabela `0x2c37d0` (`FUN_00100b08` compara o nome): 0 COLISEUM, 1 EGYPT, 2 FWAY, 3 PARIS, 4 RUSSIA, 5 GREECE, 6 MONACO, 7 CASTLE, … 11 EGYPTDM, 12 PARISDM, 13 COLISDM, 14 GREECEDM, 15 TOKYODM, 16 ARENA, 18 CASTLEDM. Das arenas do port só a ARENA tem ataque — e só ela tem pickup 9 nos PKP |
| `FUN_001d7a80` / `FUN_001d7f50` | ARENA (objeto `0x37bee0`): dono, estado 1, tempo `+0x64` = 120 tiques; som `L_ENV_PYRO` no ponto `+0xa0` (`FUN_001a4548`, distância 100..2500) |
| `FUN_001d7970` (construtor, vtable `0x2d9468`) | pontos PS2: bocais (512,147,34), (517,130,34), (522,114,34), (529,98,34), (536,83,34) e clarão (557,127,97) — os bocais ficam nos aparelhos destrutíveis 836–850 do palco |
| `FUN_001d7b48` (atualização) | estado 1: cada bocal solta os efeitos 0x3e (para cima) e 0x3b na cor `0x2c4058` (verde, azul, vermelho, azul, verde), o clarão 0x3c/0x3b branco; para cada carro da lista `0x327798` com `+0x68c0` bit 40 e `+0x34 == 4` (vivo: `FUN_0011dda0` grava 4, a lista de mortos grava 1) que não é o dono, projétil `0x13` (dano 7, 900 mph, antecipa) do ponto `+0x70 + 16·índice do carro` rumo a carro+8 `+0x20`, velocidade inicial 0. Estado 2: tempo −= tiques; `FUN_00237d20(0,6) == 0` (sorteio inclusivo: 1/7) → faísca e `L_ENV_ZAP` (`FUN_001a45c0`, 5..2500) em clarão + U(±30, ±100, −50..30) com cor U{0..4}; fim → estado 0 |
| `FUN_0022bfe0` → `FUN_00226c08` → `FUN_0022b758` | varredura dos projéteis: sólidos convexos por planos (n·p ≤ d + raio); começar dentro de um sólido conta como golpe |

## Especiais corpo a corpo (2026-10-13)
Exportados em `artifacts/native/spec`, `melee` (alvos `tools/native/melee-targets.txt`). Vtables: Twister `0x2d97f0`,
Mr. Slam `0x2d8750`, Hammerhead `0x2d7d20`, Grasshopper `0x2d7c38` (entradas de 8 bytes: s16 delta + ponteiro; disparo em
`+0x44`, chamado a cada quadro para a arma selecionada). Implementação: `src/game/specials.ts` + `Match.stepAction`.

| Carro | Evidência |
|---|---|
| Twister | Estados `+0x58`: 0 pronto (botão ≥ 2, `+0x68c0` bit 43 livre) → 1 preparo `+0x64` = 25 tiques (inclinação `+0xa0` → −1,309 rad, giro `+0x78` → `+0x7c` = −0,6 rad/tique a 0,04, subida `+0x8c` → 9 pés a 0,04) → 2 giro `+0x6c` = 150 (giro a 0,05; `FUN_001e4d30` busca em `+0xa0` = 50 pés: carros → `FUN_001e5198`, destrutíveis levam `+0x80` e empurrão 220) → 3 recuperação `+0x74` = 45 (endireita, desce a 0,08; no fim gasta a carga e espera `+0x5c` = 48). Captura (`FUN_001e5198`): visada, raio/ângulo atuais viram a órbita, impulso (0, 0, 95,33) e dano `+0x80` = 13. Órbita (`FUN_001e54b0`, até 8): ângulo −0,15/tique, raio → `+0xa4` = 20 a 0,03, altura → centro + `+0xf4` = 35 a 0,05, dano `+0x84` = 0,035/tique por `+0xf0` = 180 tiques; batida no cenário: dano 5 e solta; soltar: 80 mph·massa na direção (20°, ângulo); recaptura só `+0xcc` = 300 tiques depois. Ao entrar no estado 3 todos os tempos zeram (soltura geral) |
| Mr. Slam | Sem Upgrade, o disparo procura a cada quadro (`FUN_001b2c48`): ponto da garra = carro + R·(0, 12, 13); o carro mais perto dele a < `+0xd0` = 30 pés (×2 nos 0x74/0x75, ×3 no 0x76), com alguém no cone de 90° a 50 pés (`FUN_00147700`) e visada → agarra (`FUN_0011eb20`), dano `+0x70` = 10, clipe 0x1b (120 quadros a vel. 2 = 60 tiques). `FUN_001b1fc0`: nas fases 0,08/0,31/0,5/0,7/0,93 do clipe bate (dano `+0x74` = 3, + `+0x78`·nível com Upgrade; impulso (0, 0, 11,73) no Slam); até 0,93 a vítima vai ao gancho (fração → 0,99 a 0,15) de cabeça para baixo (+π). No fim: espera 48, gasta, arremessa a (`+0xe4` = 200 mph [30 no 0x76, 60 no 0x74]·1,4667 + vel. do Slam)·massa a `+0xe0` = 15° — ou, com parede entre os dois, pela normal a 73,33 |
| Hammerhead | `FUN_001977b8`: carro vivo, no chão, não preso, mais perto a < `+0x84` = 175 pés (+40 com Upgrade), com visada; liga o seletor 0x40 (2) e uma luz (25,5; 51; 204). Disparo no chão: sem alvo, impulso (0, 0, 58,67) no ponto (0, 10, 0) e espera 48 **sem gastar**; com alvo, (0, 0, 88), estado 1 por 31 tiques → 2 (`FUN_00197da0`: dano `+0x78` = 15 via `FUN_00197c68`) ou 3 (sem alvo: 30 tiques procurando de novo). Estado 2 por `+0x74` = 30 tiques: posição → alvo + R·(0, 0, 10) a 0,15 (altura +4 a 0,1), inclinação limitada a ±60°/±30°, rodas a 13, alvo com velocidade só vertical; fim (ou > 250 pés): pulo (0, 0, 88) com giro, gasta, espera 48 |
| Grasshopper | Trava cone 22,5° (cos 0,3927) em `+0x74` = 230 pés (285 com Upgrade) e pula: velocidade = (0, 0, `+0x6c` = 61 mph) (×0,6 com `FUN_001472a0`). Estado 1 por `+0x68` = 45 tiques mira o alvo; sem alvo gasta e acaba. Depois zera a velocidade; estado 2: posição → alvo com fração → 0,5 a 0,09; parede no caminho: volta a 88 pés/s sem gastar; > 300 tiques desiste; a < 5 pés `FUN_00193198`: dano `+0x70` = 18 (1000 com bit 53), alvo com (½ vel. do Grasshopper, 176 pés/s para cima), Grasshopper ×0,25, gasta, espera 48 |

## Upgrade e especiais "carregados" (2026-10-13)
`FUN_001267a0(carro, nível)`: nível = `carro+0x63f0 & 7`; ≥ 1 liga `0x20` (energia ×1,15, `FUN_0011bde0`), ≥ 2 `0x08`, ≥ 3 `0x10`,
≥ 4 metralhadora com 1.000.000 balas (dano ×2), ≥ 5 `0x40` (vida acima de 100 %, HUD), ≥ 6 especial com `obj+0x3c = 1` (carregado).
Só é chamado no renascimento com os bits 51/54 de `+0x68c0` (trapaça: bit 0x1000000 do controle em `FUN_00123cd0`), com
nível 6. O pickup 10 (Upgrade) cai no `default` de `FUN_00120ba0` (consumido sem efeito) e nenhum PKP do Head-On o tem:
no deathmatch os especiais nunca ficam carregados.

## Ataques de energia (2026-10-13)
Exportados em `artifacts/native/energy`, `energy2`, `freeze`, `combo` (alvos `tools/native/energy*-targets.txt`, `freeze-`,
`combo-`). Implementação: `src/game/energy.ts`, `Match.energyAttacks`, `src/input.ts` (setas / d-pad).

| Endereço | Evidência |
|---|---|
| `FUN_0012c9b8` | por quadro: no Head-On roda os combos `FUN_0012ce60` (bit 0), `FUN_0012d6b0` (bit 0x10), `FUN_0012cfa8` (bit 1), `FUN_0012d1b8` (bit 2), `FUN_0012d7c0` (bit 5), `FUN_0012d910` (bit 0x40) sobre o histórico do controle (`FUN_00224088`, toque `FUN_00223d58`, soltura `FUN_00223e18`); no Harbor City botões únicos (0xf → bit 0, 0x10 → 0x10, 0xd → 1, 0xe → 2) |
| combos | índices 0xd..0x10 = Esquerda, Direita, Cima, Baixo (confirmado: ver "Controle e combos"); sequências: congelar 0xf, 0x10, 0xf; mina 0xe, 0xd, 0x10; casca 0xe, 0xe, 0x10, 0x10; onda 0xf, 0x10, 0xd, 0xe; tiro para trás 0xf, 0x10, 0x10; míssil de energia 0xe, 0xd, 0xf, 0xf |
| `0x2f28e4` / `0x2f28e8` / `0x2f28fc` / `gp−0x7d04` | custo/limiar de energia: congelar 0,4, mina 0,1, onda 0,3, casca 0,6 (`FUN_0011bd48` subtrai, piso 0; nada com o bit 51) |
| `FUN_0011e3d0` → `FUN_0011bde0` | recarga por tique = `0x2b3e30[carro+0x14]` (0,000205 nos jogáveis) ×1,15 com `+0x63f0` bit 0x20; teto 1 |
| `FUN_0014d478` / `FUN_0014d588` | congelar (inv. `+0x5860`): trava 30° a 7000 pés, projétil 0xe, espera `+0x84` = 48 |
| `FUN_0011f280` caso 0xe → `FUN_00120838(1)` | congela (bit 42): desliga armas, `+0x6308` = 300 tiques (gp−0x7e2c); Dark1/Dark2 tocam o clipe 0x21 e não congelam |
| `FUN_00123410` | congelado: cada botão de uma lista de 12 tira 13 tiques; o tempo cai 1/tique; zero → `FUN_00120838(0)` |
| `FUN_0014c0d0` / `FUN_0014c208` | mina (inv. `+0x5740`): só no chão, projétil 0xd com deslocamento (0, −3, −1) ((0, 0, −1) em 0x65/0x67/0x6b/0x6c/0x71/0x73/0x77/0x7a/0x82), espera 48 |
| `FUN_0014c4e8` / `FUN_0014c648` / `FUN_0014ca00` | onda (inv. `+0x57c0`, modelo 0xfdc): raio `+0x78` = 100 (150 no 0x76, ×1,5 no teste); carros no raio levam `+0x7c` = 10 (tipo 0x10) e, no chão abaixo de 7,33 pés/s, sobem a `+0x80` = 50 mph·massa (chefes não); destrutíveis a raio/2 levam 10 e empurrão 1100; todos os projéteis no raio detonam; espera `+0x74` = 120; som E_FLAK_COMBO (`FUN_00151170`) |
| `FUN_00123010` | casca de fogo: bit 2 → `+0x62e8` = 180 tiques, seletor 0x43 = 1 (2 no HC Roadkill/Manslaughter), clipe 0x19; enquanto ligada `FUN_00120778` não acende fogo no carro |

## Especiais do Harbor City (2026-10-13)
Disparo = vtable `+0x44` da classe criada em `FUN_0011d340` (construtor → vtable): hc_axel `0x2d86f0` → `FUN_001b0b40`,
Derby `0x2d8fb8` → `FUN_001c2cf0`, HC Hearse `0x2d9110` → `FUN_001c8ee8`, HC Grimm `0x2d9308` → `FUN_001d06a8`, Preacher
`0x2d9550` → `FUN_001db178`, Manslaughter `0x2d9610` → `FUN_001dcbd8`, Semi `0x2d9670` → `FUN_001dd5e8`, SUV `0x2d9790` →
`FUN_001e3120`, HC Sweet `0x2d93e0` → `FUN_001d64a8`, Taxi `0x2d9170` → `FUN_001c9730`, Tow `0x2d94c8` → `FUN_001d8160`,
Spectre HC (0x85; antes anotado como HC Roadkill) `0x2d96d0` → `FUN_001e0c58`, Dark2 P `0x2d7e40` → `FUN_0019a0a0`;
HC Roadkill (0x7f) usa a mesma classe do Manslaughter (0x86). As funções antes listadas como "classe"
(`FUN_001dbbc0`, `FUN_001dd878`, `FUN_001d67f0`, `FUN_001c9a38`, `FUN_001d88e8`) são os ajudantes de tiro.

| Carro | Evidência |
|---|---|
| hc_axel | 0x2c quando o clipe 0x1b (0x1e para trás) passa de 0,26; espera `+0x5c` = 25 |
| HC Hearse | segurar: n = mín(6, tiques/32 + 1), desiste depois de `+0x64` + 180 = 340 tiques; soltar: n × 0x2d (`FUN_001c9450`: arfagem U(2,5°, 15°), rumo U(±10°), deslocamentos laterais ±0,273/±0,546/±2,002, trava 30,5° a 7000) |
| HC Grimm | 120 tiques (`+0x64`) no chão: velocidade → `+0x68` = 250 mph pela frente com `+0x7c` = 0,25; chama do turbo ligada |
| Preacher | estado 2 por 300 tiques: 0x2f a cada 15 (`FUN_001dbbc0`), 0x2e a cada novo toque; espera 90 |
| SUV | 0x33 quando o clipe 0x1a passa de 0,1; 2º toque derruba (`FUN_002009d0`); espera 48 |
| Semi | `FUN_001dd878`: anel de 8 × 0x32 dos pontos `0x2eb5a0` com rumos `0x2eb620` (−45°, 0, 45°, 90°, 135°, 180°, −135°, −90°); dispara sozinho ao bater num carro (`+0x902` em 0x65..0x86) acima de 4 pés/s; espera 90 |
| Derby | init `FUN_001c2bb0` (+0x64 = 2, +0x68 = 250 mph, +0x6c = 20, espera 48); trava 22,5° a 7000 → `FUN_00196608` → `FUN_00195548`: objeto por jogador `0x3573f0 + i·0xe0` (cópia `FUN_0021abf0(0x356108)`), atualização `FUN_00195638`: estado 2 voa 240 tiques a mph·0,024444 pés/tique rumo ao alvo (sem alvo cai), `FUN_00196290` varre (cenário acaba, outro carro leva o golpe); ao alcançar: alvo com casca → estado 4 (desvia 45 tiques para um ponto sorteado a ±50..55 pés), senão estado 3 (preso; golpe de +0x18 = 20 no fim do clipe) |
| Roadkill HC / Manslaughter | classe `0x2d9610` (`FUN_001dca30`: espera 48, +0x6c = 10 tiros); `FUN_001dcbd8` despacha pela tabela `0x2eb540` (`FUN_001dcc6c` … `FUN_001dcfe0`): segurar toca o clipe 0x1a (canhão sobe; mira de luneta +0xb8 = 0,125 no humano); a 0,95 dispara 0x30 (Roadkill) / 0x31 (Manslaughter) a cada 0x13 tiques com trava cos(0,533) em 7000 (`FUN_001dce7c`) |
| Spectre HC (0x85) | init `FUN_001e0a68` (+0x64 = 225 tiques, +0x70 = 0,11, +0x74 = 200 pés); com o clipe 0x1a ≥ 0,95 liga o raio (`FUN_001e11a8`: emissor 0x1e cor 0x800020ff); `FUN_001e0ee0` varre 200 pés à frente e manda golpe tipo 0x29 (acende fogo) de 0,11 por tique |
| Taxi | `FUN_001c9a38`: 10 × (0x35 + U{0..2}) dos pontos `0x2c3e90` (de ré `0x2c3f30`) com rumos `0x2c3fd0` (−4,5..4,5°), instância +0x80 = U(−25°, −35°) 🟡 |
| Tow | `FUN_001d8160`: 1º toque abre 600 tiques de trava (`FUN_001d7fd8(60, 1000)`) que acumulam carga; 2º toque → `FUN_001d88e8`: n = carga/60 + 1 tiros 0xb com rumo ±7°·i |
| Sweet Tooth HC | `FUN_001d67f0`: 0x34 com +4°, trava o bit 0x10 (tiro para trás) |

## Trava (2026-10-13)
`FUN_00147700(cos, alcance²)`: frente = coluna Y da matriz (negada com `obj+0x44`, tiro para trás); o **carro** mais perto com
cos > limiar e d² < alcance² (sem os bits 41 e 47; Dark2 com mais de 50 % de vida é mirado 120 pés acima). Sem carro, os
lançadores chamam `FUN_00147cf0` (portado: `Match.sceneLock`, destrutíveis vivos): o **objeto** do cenário mais alinhado (destrutíveis de categoria 200..0xf2 / 0x136..0x14c com
vida). Não há reserva pela escolha ponderada de `FUN_00102f50`. Metralhadora (`FUN_0014ae38`): balas 0x12/0x1b/0x28 travam a
45° (objetos a 2000 pés); o humano em 0x69/0x6d/0x70/0x75/0x76/0x7f/0x86 trava a 7,5° em 7000 pés e só aponta a bala
(`FUN_00237480`).

## Luzes dinâmicas (2026-10-13)
Exportados em `artifacts/native/light`. Pool de 32 luzes de 0x40 bytes em `0x585880` (`FUN_0024c448` aloca e põe raio 250 por
`FUN_0024c300`, que também grava `+0x2c = r²/(+0x34·16)`); `FUN_0024c350` cor, `FUN_0024c2c8` posição; `FUN_0024c740` escolhe as
8 mais perto do carro de cada jogador (`0x606840 + i·0x140`) para o desenho. Implementação: `src/render.ts` (`dynLights`,
⚠️ queda e escala do host) e `src/game.ts`.

## Partículas (2026-10-13)
Exportados em `artifacts/native/part`, `parttex`, `burn*` (alvos `tools/native/part-targets.txt`, `parttex-`). Dados:
`tools/native/export_particles.py` → `rules/particles.json`; runtime `src/particles.ts`.

| Endereço | Evidência |
|---|---|
| `FUN_002470c0(escala, pos, id, dir, cor, vel, p7)` / `FUN_00247580(escala, *pos, *matriz, id, *deslocamento, …, cor)` | emissor avulso / preso; id < 0x55 → `FUN_00246878`; 0x55..0x64 → efeitos compostos (`FUN_00248278` 0x55, 0x59 → 0xe, `FUN_00248b68` 0x5a, `FUN_00248e98` 0x5b, `FUN_00248628` 0x5c, `FUN_00248410` 0x5d, `FUN_00248798` 0x5e, `FUN_00248c70` 0x5f, `FUN_00248d78` 0x60, `FUN_002489e8` 0x61, `FUN_00249008` 0x62, `FUN_002492a0` 0x63, `FUN_002494f8` 0x64); 0x28 à parte (`FUN_0021e070`) |
| `FUN_00246878` | emissor de 0x1780 bytes no pool `0x527580` (64, lista `0x585580`): copia T1 `0x2cab00 + id·0x38` (+0x1480: flags, tipo de desenho, textura, mistura GS, alcance, 8 cores 0xAABBGGRR, cor da luz), T2 `0x2cbd60 + id·0x50` (+0x14b8: arrasto, empuxo, gravidade, curva da luz), T3 `0x2cd8e0 + id·0x50` (+0x15f0: atraso, duração, taxa, cone, deslocamento, axial, velocidade, herança, espalhamento), T4 `0x2cf320 + id·0x30` (+0x1660: tamanho, crescimento, vida em tiques); escala: √ na duração/taxa/velocidade/vida, linear no tamanho/espalhamento (por flags de T3) |
| `FUN_00244b20` (carga) | cone → (1 − cos(θ/2))/2; T2+0x40 = 1/T2+0xc; T4+0x2c = 1/vida |
| `FUN_00245288` (nascimento, VU0) | n = taxa·quadros (resto em +0x1650); direção = cone em torno do eixo Y da matriz (`FUN_00237d80`); D1/D2 = linhas X,Z + Y·axial; vel = herdada + D1·U(vel); pos = anterior + desloc.·i/n + D2·U(espalh.) + D1·vel·(1 − i/n); vida por partícula = (1/vida)/(1 − lifeRand·U) |
| `FUN_00245d48` (física, VU0) | idade += taxa; pos += v; v = A + (v − A)/(1 + \|v − A\|·k); k = drag[0]→drag[1] até dragSplit; v.z += gravidade; A = (0,1; 0; empuxo); tamanho dos tipos 6/3 cresce grow[0]→grow[1] até growSplit (tipos 1/2 não) |
| `FUN_00246620` / `FUN_00249828` | fim: atraso → duração → para; parar = duração 0; some sem partículas |
| `FUN_002464e8` → `FUN_002347d8` | luz (T1 flags & 6): intensidade em rampa T2+0x18 → +0x1c até +0x20, cai até 0 em +0x24 (ou cintila, flag 8) |
| `FUN_002024a8` | detonação: até 4 efeitos de +0x74 com escala +0x84; no ar dir (0,0,1); no contato normal da superfície, velocidade do projétil e p7 = "atingiu carro" (faíscas 0x36 em vez da fumaça 1) |
| `FUN_00203c68` | em voo: emissor +0x6c e rastro +0x70 presos à posição/matriz do projétil (0x17/0x2d em 0,5; rastro do Power cor 0x804b96ff) |
| `FUN_002447f0` ← `FUN_00168aa8` | texturas: nós de categoria 7000..7199 do RESIDENT.BDD (seções ngp/tex/rtx/ptr) na ordem da coleta → slots 2.. (`DAT_002f3f6c` = 2) de `0x2c9500 + slot·0x100`; +0x90 = modo, ladrilhos x/y, quadros (`FUN_00244650`); slot 1 = textura 1 (não achada) |
| `FUN_001d7b48` | ARENA: jatos 0x3e (2) + 0x3b (2) na cor `0x2c4058`; clarão 0x3c (1) + 0x3b (2) brancos; faíscas idem com cor sorteada |

## Controle e combos (2026-10-13)
Exportados em `artifacts/native/pad`, `pad2`, `combo`. Registro de 0x18 bytes por quadro (`FUN_00223908`), anel de 90 em
`+0x0..+0x870` (`FUN_00223c90` ← `FUN_0023e1a8` / `FUN_001be818`): botão i = pressão da máscara do libpad lida como
`~(data[2]<<8 | data[3])` (`FUN_00233a90`): 1 L1, 2 L2, 3 L3, 4 R1, 5 R2, 6 R3, 7 X, 8 O, 9 Δ, 10 □, 0xb Start, 0xc Select,
**0xd Esquerda, 0xe Direita, 0xf Cima, 0x10 Baixo**; sem direcional, o analógico esquerdo preenche 0xd..0x10 (eixos 2/3).
`FUN_00223d58` / `FUN_00223e18` buscam o 1º quadro apertado / solto num intervalo (0 = atual).

| Combo | Bit | Consumidor |
|---|---|---|
| Cima, Baixo, Baixo (`FUN_0012d6b0`, sem borda: vale até 20 quadros do último Baixo) | 0x10 | obj+0x44 travado no disparo (`FUN_0014b900` Fire/Homing/Power/Ricochet, `FUN_0014bd60` Napalm, ATV, Thumper, Spectre, Sweet HC, Taxi); `FUN_00147ec8` gira 180° e nega a arfagem; Remote sempre (`FUN_0014e030`) |
| Direita, Esquerda, Cima, Cima (`FUN_0012d910`, sem Baixo em 60 quadros) | 0x40 | `FUN_00147ec8` / `FUN_0014dd00`: com energia > 0,3 gasta 0,3 e `FUN_00148300` solta o 0xf (trava 22,5° em 7000; +5°/+15°/+30° pela distância) |
| descongelar (`FUN_00123410`) | — | só o humano: soltar os 12 botões (1, 2, 4, 5, 7..10, 0xd..0x10) arma; o próximo aperto tira 13 tiques |

## Energia da IA (2026-10-13)
A IA escreve os bits direto em jogador+0x13c (= controle+0x1c). Exportados em `artifacts/native/ai`, `pad`, `aiglob*`.

| Endereço | Evidência |
|---|---|
| `FUN_00106a88` + `FUN_00104b28` | casca: visada ≥ 8 quadros (+0x3e8), +0x3dc > perfil+0x1c, global > 1200 (`DAT_002f4194`), energia > 0,6, vida < (1 − perfil+4)·+0x328; U(0,1) > progresso + 0,5 → conta U(k, 4k), k = perfil+0xc·7/5/3/1; em 0 liga o bit 4 e +0x328 ×= habilidade (a IA não paga a energia) |
| `FUN_00106cf0` | congelar: habilidade ≥ 0,1, arma em preparo (estados 2..6), alvo < 300 pés, \|esterço\| < 0,4, +0x3d8 > perfil+0x18, global > 1200 (`DAT_002f41a0`), alinhamento > 0,95, U < progresso + 0,5 e `DAT_003277dc` > 0,25·`DAT_003277e0` → U < habilidade |
| `FUN_00103ca8` | lento (< 58,67 pés/s) acumula +0x448; > 1200 → onda se o alvo está a < 200 pés ou virado para mim (senão reposiciona no grafo) |
| `FUN_001088e0` | armas de ré 1, 2, 3, 4, 6, 7, 10 → bit 0x10; 0xd → mina |
| `FUN_00102300` / `FUN_001027f8` | perfil+0x18 ×5/×4/×2/×1, +0x1c ×3/×2/×1/÷2; contadores sorteados; intervalos globais 1200 |
| `0x327798` (+0x44/+0x48/+0x50) | `DAT_003277dc`/`e0` 🟡 (rivais abatidos/total, pelo uso); `e8` = progresso do modo (o mesmo da habilidade) |

## Golpe por tipo e fogo no carro (2026-10-13)
`FUN_0011f280` (mensagem: +0 tipo, +4 atacante, +8 dano, +0x10 velocidade do projétil ×60, +0x20 ponto): impulsos =
massa·k via `FUN_00136048`/`FUN_001360b8` (só com carro+0x6400 < 1, que vira 12, e o carro abaixo de 73,33 pés/s):
Power (0,25·v, z 44), Ricochete (0,45·v no chão / 0,0035 no ar, z + 50), Remote (no chão e < 7,33 pés/s: 110 a partir da
explosão com +50 em z), Hearse/0x2b (73,33; partículas 0x3c/0x3e/0x3b se o clipe ≥ 0,75), Grimm/0x2c (z 58,67), SUV 0x33
(58,67). Tipos 0x20/0x21/0x29 → `FUN_00120778` (fogo: sem casca, não no Dark2): gerente `0x349150` (10 slots de 0x40,
`FUN_0017f1e8`), `FUN_0017f400` manda por tique um golpe 0x29 de 0,01 por 300 tiques, emissor 0x42; apagam o turbo
(`FUN_001238c8`), água sob as rodas (`FUN_0011e3d0`) e a morte. Congelado: `FUN_00120838` toca o clipe 0x18 (`FUN_00127fc0`),
volta a −1 nos últimos 30 tiques (`FUN_00128078`); casca: clipe 0x19 em laço (`FUN_001281e8` / `FUN_00128298`).

## Pickups: brilho (2026-10-13)
Cada ícone de arma (nó 0x13ba + tipo) já traz uma malha aditiva `(Cs − 0)·As + Cd` sem escrita de profundidade — é a
"aura". Vida e Upgrade não têm. `FUN_001bcf70` só gira os pickups no Harbor City (2°/tique); no Head-On não há giro por
código (⚠️ o port gira e balança).

## Animação de material (2026-10-13)
Exportado em `artifacts/native/texanim*` (alvos `tools/native/texanim*-targets.txt`).
- `0x1A` **não** é controlador de animação: `FUN_0022cd58` (consultas) o devolve como folha junto do tipo 9; o nó tem
  0x10 bytes (`+0x08` dados u16, `+0x0C` → sólido de colisão) e a malha vem logo depois.
- Desenho real dos níveis/carros: `FUN_00230998` (scratchpad `0x7000xxxx`, tipo 0 = malha). Por textura chama
  `PTR_FUN_002f40b4` = `FUN_00260bb0` (id → cache de VRAM `0x5dd640`, sem troca de quadros). Pacote: `FUN_0024baa8`.
- `FUN_0024baa8`: 2 qwords para a VU (UNPACK em 4): `[U, V, +0x3C, ext+0x78, R, G, B, alfa]`, padrão (0, 0, …, 1, 1,
  1, +0x5C). Com o bit 31 das flags, a extensão (depois dos TEX0) traz s16 índices de canal do objeto (`obj+4`): [0]→U
  e [1]→V só com a flag 0x800; [2], [3], [4] → R, G, B; [5] multiplica o alfa; −1 = mantém o padrão. Alfa também ×
  `obj38+0xb8` e × tabela `0x4ecd50` pelo byte `+0xb3` do contexto.
- Modo da malha `(flags >> 1) & 7` (`FUN_0024b170`): 1 = coordenadas da tela (escala 1/2^n da tela; camada de
  reflexo), 2 = `FUN_00267400` (matriz pela direção da câmera, `+0x08` × 0,375 / × 1, câmera `0x606840`), 3/4 =
  `FUN_00267a08`. Programa da VU escolhido em `0x30e0/0x30e4/0x30e8` do scratchpad.
- Disparo de clipes de objeto: roteiro de categoria `0xDCA` (grupo cujo 1º filho é `0x1B`; `FUN_00168aa8` →
  `FUN_001151e0` amostra em t=0; vtable `0x2d5ea8`[7] = `FUN_00115348` toca com `FUN_00210590`); stream lido por
  `FUN_00231f80`/`FUN_00232020` a partir de `+0x0C` (contagem, depois trios categoria, índice, categoria do clipe, em
  f32). Abertura da Arena: `FUN_00165cc0` (câmera do objeto `0xC1D + 0x14·i`). Ação tipo 2: `FUN_00101720`.
- `FUN_00210590` cria a instância (`FUN_00211348`: laço = bit 1 do u16 `+0x0E` do clipe → flag 0x10000), velocidade
  1, início no relógio atual.


## Arenas: fogo, batida, abertura, peças móveis, névoa e spawn (2026-10-14)
Exportados em `artifacts/native/arenafire`, `topple*`, `mgr`, `objclip`, `intro`, `autoclip`, `autoplay`, `stream`,
`fog*`, `envlight`, `spawn`, `m37c` (alvos `tools/native/<nome>-targets.txt`).

| Endereço | Evidência | Port |
|---|---|---|
| `FUN_00172bb0` | fogo nos destrutíveis (uma vez por objeto; slot de cor `FUN_002302f0`): vida cheia (`FUN_00171498(1)`), emissor 0x41 em base + U(1, 8) pés e um 2º por categoria (0x1196: 3 e 5 a +40; 0x1197: 1,5 e 3 a +U(30,35); 0x1198: 1,5 e 5 a +25; 0x119a: 1,5 e 3 a +U(23,26); 0x119b: 1,5 e 3,5 a +38; 0x119c: 2 e 5 a +53; 0x119d: 3 a +8; 0x11a3: 6 a −8); o 1º recebe vida `+0x167c` = 90/120 tiques e cone `+0x1600` = 0,05; os 2º cone 0,5/0,05/0,03/0,01 | `src/destructibles.ts` (`FIRE`) |
| `FUN_001730b8` (via `FUN_002a3460`, agendado a cada tique) | som `W_FIRE_BURN_L` (100..350, `FUN_001d2b10`); cor do objeto (tabela `0x4ecd50`) perde U(0,0011; 0,0018)·tiques em R, G, B (0x11a3: faixa dobrada e R pela metade); com R ≤ 0,2: 0x11a3 apaga o 1º emissor; os outros apagam os dois e mandam a si mesmos golpe tipo 0 de 100 com velocidade = uma de 5 direções horizontais × 60 | idem (`burnTick`) |
| `FUN_00171838` | 0x1196..0x119d com golpe 4/0x29 não perdem vida (pula a subtração) e acendem; 0x11a3 acende com qualquer golpe que não seja tipo 0 nem 0xe; 0x1198 morto sem fogo solta 0x2f 20 pés acima | idem |
| `FUN_001e2348` | ao tombar: poeira 0x34 no ponto do golpe (napalm/remote: no objeto) — postes 0,2 cor 0x80c0c0c0; árvores 1,0 cor 0x80405060; 0x1198 mais folhas 0x2f a +20; não toca som | idem (`fallFx`) |
| `FUN_001e2770` / `FUN_001e2e70` / `FUN_001a7630` | pool de 15 corpos: ponto de prova do topo = base + eixo z × 25 (0x119b: 35, 0x119c: 50, 0x119d: 7); ao chegar a ≤ 3 pés do chão: poeira (0,5 nos postes, 2 nas árvores), brasas 0x35 e folhas 0x2f se não queimava; som `D_LPOST_SIM_FAL` (0x1194) ou `D_TREE_FALL_LG` (árvores), 60..800 pés, volume × \|v\|²/6 abaixo de 6 | `DebrisBody.landTip/onLand`, `landFx` |
| `FUN_001e2000` / `FUN_001e21b8` | tombar por golpe: velocidade × 0,05; por batida: velocidade da mensagem (pés/tique = v/60) × 30, no ponto de contato | `topple` |
| `FUN_001349f0` | batida em objeto que não é carro: dano = máx(1, \|v\|·0,6818/`carro+0x858`·\|v̂·n\|·10), velocidade da mensagem = v × 1/60 (`gp−0x7c08`) | `ramDamage` |
| `FUN_00202d08` | explosão em objetos (tipo 3): consulta a raio/2 (`FUN_0022c5a8`), dano·máx(0, 1 − d/raio) com d até a origem (+0xB0); sem o mínimo 0,33 nem o ×1,5 do napalm (só carros); empurrão (dir + 0,25 z)·1100, ponto +7,5 z | `LevelDestructibles.blast` |
| `FUN_00183470` / `FUN_001834e8` (`0x3493d0`) | **fodder cars** ("Too many fodder cars added"): grupos de categoria 200..0xf2 (só com < 2 jogadores); `0x12d` = destrutível do último carro registrado. Arena: 0xe9 ×2, 0xea, com 0x12c/0x12d | ❌ pendente |
| `FUN_0018ad48` / `FUN_0018adb8` / `FUN_0018add0` (`0x351620`) | **fodder vehicles** 0x136..0x14c com destrutíveis 0x12e/0x12f (Arena: 0x139..0x13e) | ❌ pendente |
| `FUN_00147cf0` | trava em objetos: percorre todos; tipo 5 (fodder) exige vida (`+0x138`/`+0x150`) | — |
| `FUN_0019b8c0` / `FUN_0019b8f0` / `FUN_0019cd88` (`0x358040`) | ator com destrutível `0x3f8` (Coliseu e Grécia DM): nasce em pontos de caminho (`0x3f6/0x3f7/0x3f9`) 500 pés acima | ❌ pendente |
| `FUN_001ddb88` / `FUN_001df928` / `FUN_00137968` (`0x37c230`) | categorias 0x1131/0x1133/0x1134: clona os objetos 0x1130/0x1132 em pontos e toca os clipes 0 (velocidade 1), 1 e 2 (amostrado); cruz cinza no radar a < 900 pés | ❌ pendente |
| `FUN_002111f8` → `FUN_002107e8` | **auto-play**: ao montar o objeto, toca todo clipe com o bit `0x10000` do word `+0x0C` (bit 0 do u16 `+0x0E`) — água de Paris DM, mar da Grécia DM, telões, hélices, `0xC23` clipe 2 | `ObjectClips.autoStart` |
| `FUN_002062b8` → `FUN_0018fdb8` | roteiros de abertura: nós `0x1B` com id `0xC1C + 0x14·i` (i < 6) em `modo+0x1d0+8·i`, raiz do desenho em `+0x1d4` | `intros` no JSON |
| `FUN_001b5ab8` / `FUN_001b5d88` / `FUN_001b5a20` | abertura: toca os trios do roteiro (FUN_00211190 + FUN_002110d8), câmera = objeto `0xC1D + 0x14·i` (FOV = canal 0, `FUN_002668a0(largura/2/tan(fov/2))`), velocidade dos clipes acompanha a posição do stream de áudio; termina quando o clipe da câmera acaba ou no X (`FUN_00233cc0(…, 0x40)`: tudo vai ao tempo 1 com flag 0x40); fim na ARENA: clipe 2 do 0xC23 | só o estado final (cena retirada a pedido) |
| `FUN_001da9a0` | música da abertura: ARENA `CALYPSO.VAG`; Eddy/Dark Tooth `EDDYBOSS.VPK`/`DARKT1.VPK`… | — (cena retirada) |
| `FUN_001151e0` / `FUN_00115348` (vtable `0x2d5ea8`) | roteiros `0xDCA` (Castelo DM 0x1451..0x1453; Grécia DM 0x1464/0x1465 + 0xdc8/0xdc9): amostra t=0 na carga; toca os clipes quando o objeto recebe a mensagem (quem manda: ❌) | objetos ficam no quadro 0 |
| `FUN_0021b3c0` caso `0x12` | escala (+0x20..+0x28) e translação (t + (+0x10..+0x18))/escala, n filhos (+0x08) em +0x2C | `tools/ngp.py` (como o 0x18) |
| `FUN_001a8540` | ambiente por fase (`DAT_002f4900`): 3 luzes direcionais (cor + 2 ângulos, `FUN_0024d0e0`/`FUN_00244f58`) e a névoa | luzes ❌ (carros) |
| `FUN_001a8b68` → `FUN_00221218` | névoa por fase: EGYPTDM (70,55,30) 900..5000; PARISDM (105,90,75) 1200..4000; COLISDM (40,35,30) 2000..10000; GREECEDM (16,17,22) 1200..4000; TOKYODM (0,0,0) 5000..10000; ARENA (25,25,30) 400..10000; CASTLEDM padrão (50,50,60) 5000..10000 | `LEVEL_FOG` |
| `FUN_00220de0` / `FUN_00221010` / `FUN_0022e3a8` | coeficiente f = A + B/z (B = 254·n·l/(l − n), A = 1 − B/l): 255 em `near`, 1 em `far`; FOGCOL = cor por câmera (`0x398038`) | `installPs2Fog` |
| `FUN_0013d9b8` → `FUN_001123d8` / `FUN_0011cd38` | renascer: lista de spawns do grafo `0x2f5c80` (ids em `+0x1020`, n em `+0x2cb24`) a partir de um índice sorteado; fica com o 1º a > 300 pés do carro mais perto (senão o mais distante), marca o vizinho com 0x10; o carro é posto no nó virado para o 1º vizinho (`+0x14`) | `Match.pickSpawn` |
| `FUN_00112110` | entrada na partida: igual com 800 pés e pulando nós com 0x10 | idem |
| `FUN_00125b80` (`gp−0x7e14…`) | **vida máxima por veículo** (×1,15 com o bit 0x40 de `+0x63f0`): 0x65 120, 0x66 110, 0x67 85, 0x68 100, 0x69 125, 0x6a 105, 0x6b 95, 0x6c 90, 0x6d 135, 0x6e 100, 0x6f 95, 0x70 120, 0x71 95, 0x72 130, 0x73 50, 0x74 100, 0x75 150/200, 0x76 310, 0x77 108, 0x78 100, 0x79 110, 0x7a 85, 0x7b..0x86 (HC) 100, 100, 135, 120, 125, 110, 120, 95, 145, 110, 138, 220 (0x86) | ❌ pendente (Carros) |

Observações sem conclusão: as malhas "já no mundo" do Coliseu DM sob `0x1F` (0x141530, 0x140020, 0x125c80) formam um
anel de prédios em que o `0x1F` (giro de −35°/−65° em z + translação) leva cada um à posição de outro; a grade de
setores (`0x0C`, 38×17 células de 100 pés) não aponta para eles. Na Arena, um `0x03` com z = −2001,5 sob o grupo de
categoria 7 (que `FUN_00168aa8` registra à parte: `DAT_002f466c = 2`) cobre geometria já no mundo — o desenho não pode
estar aplicando essa translação ao caminho normal.
