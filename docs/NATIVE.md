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
Vida (100), turbo, tempo da carcaça, colisão carro×carro, e no visual: aura dos pickups (sprite aditivo, cores escolhidas), brilho aditivo no lugar da luz dinâmica dos projéteis, prefabs 36 (bola de fogo) e 29 (estouro) no lugar das partículas de explosão. Armas, pickups e especiais: ver "Armas" abaixo (o que ainda é aproximação está marcado ⚠️ lá e em `docs/PENDENTES.md`).

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
| `0x43` (casca de fogo, textura `7dcf4`) | `+0x62c0` (+`0x62c4` no 0x83) | `FUN_00123010`: bit 2 de controle `+0x1C` liga por `gp−0x7e28` = 180 tiques e toca a instância `0x19`; gatilho do jogador não identificado (a IA liga o bit 4, `FUN_00104b28`) |
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
| Twister | `FUN_001e42d0` / `FUN_001e4670` | giro: preparo 25, giro 150 tiques a −0,6 rad/tique, dano 13 por toque, recuperação 45 (⚠️ host aproxima) |
| Mr. Slam | `FUN_001b1058` / `FUN_001b1330` | agarra e bate (⚠️ host aproxima: 15 a ≤ 30 pés) |
| Cop Car | `FUN_001b7a58` / `FUN_001b7c50` (`FUN_001b83f0`, `FUN_001b8220`, `FUN_001b88c0`) | choque no mais perto a ≤ 250 pés por 4 s (240 tiques), 0,025 por tique |
| Crimson Fury | `FUN_00169890` / `FUN_00169ea0` | tipo `0x19` |
| Hammerhead | `FUN_00196848` / `FUN_00196b60` | investida (⚠️ host aproxima: 15 por toque) |
| Grasshopper | `FUN_00192498` / `FUN_001927a8` | pulo e queda em área (⚠️ host aproxima: 18 em 61 pés); carregado atira `0x25` |
| Warthog | `FUN_001fcc10` / `FUN_001fcd00` | 3 × `0x28` (±5°), espera 70 |
| ATV | `FUN_00115960` / `FUN_00115b78` | 2 rajadas de 10 chumbos `0x24` (dano 1) a 15 tiques; espera 6 (humano) / 120 (bot) |
| HC | `FUN_001b0b40` (0x2c), `FUN_001dbbc0` (0x2e), `FUN_001dd878` (0x32), `FUN_001e3120` (0x33), `FUN_001d67f0` (0x34), `FUN_001c9a38` (0x35+), `FUN_001d88e8` (0xb) | só o tipo de projétil e a espera (`+0x5c`) foram lidos; Derby, HC Hearse, HC Grimm, HC Roadkill/Manslaughter e HC Spectre não atiram projéteis (não lidos); StockCar e Tank Car não têm classe |
