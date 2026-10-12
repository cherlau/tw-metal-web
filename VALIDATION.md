# VALIDATION — log datado e honesto

> Estas checagens **não** estabelecem comportamento 1:1 com o original.

## 2026-10-10 — M0, M1, M2 (parcial)

**Ambiente:** Windows 10, Python 3.12.10 (numpy 2.5.4, Pillow 12.3.0), Node 24.14.0, Edge headless via playwright-core 1.63.0 (WebGL por SwiftShader).
**Entrada:** ISO SHA-256 `e6c23917…cf0e`, ELF `SCUS_976.21` SHA-256 `8619cb64…a3c3`.

| Item | Resultado |
|---|---|
| Extração (`tools/extract.py`) | 405 arquivos no disco, 106 BDDs, 419 seções, 0 erros; idempotente (2ª execução: 0 escritos) |
| Testes Python | 25/25 (`python -m unittest discover -s tools -p "test_*.py"`) |
| Texturas do Axel | 13/13 decodificadas; 11 PSMT8 batem pixel a pixel com o unswizzle de fórmula conhecida; 2 PSMT4 64×64 conferidas visualmente |
| Conversão de carros | 37/37 `cars` + 37/37 `aicars`, 0 erros, toda malha texturizada aponta para textura existente |
| Axel | 77 malhas, 4.016 triângulos, 9 sprites; pose base reconhecível no visualizador (rodas, homem no eixo, escapes, faróis); texturas sem flip (banda de rodagem e cubo corretos) |
| Sweet Tooth | peças decodificadas com textura correta, **mas fora do lugar** — falta aplicar as matrizes do scene graph |

**Assistido / não verificado:**
- A seleção "pose base" do Axel foi feita à mão (esconder efeitos por textura e destroços por nome).
- Espelhamento (handedness) não confirmado.
- Malha do personagem com paleta de matrizes renderizada com matrizes identidade.

## 2026-10-10 (tarde) — M2: scene graph

| Item | Resultado |
|---|---|
| Testes Python | 27/27 (inclui: contagens do scene graph de Axel/Sweet Tooth/viatura sem tipos desconhecidos; malhas no espaço do modelo via invBind) |
| Conversão | 37/37 `cars` + 37/37 `aicars`, 0 erros; toda instância aponta para malha existente |
| Pose base automática | Galeria de 12 carros (viatura, Axel, Sweet Tooth, Twister, Spectre, Hammerhead, Thumper, Harbor City Taxi, Grasshopper, Crimson Fury, Mr. Grimm, Warthog) montados **sem seleção manual**: LOD mais detalhado, estado intacto, slots de efeito separados |
| Coordenadas | Z-up → Y-up por rotação; texto "A-12" da viatura legível (sem espelho) |
| Cabeçalho de malha | 0–4 texturas; geometria em `+0x60 + 0x10·nTex (+0x20 se bit 31)` |

**Pendências conhecidas:**
- Crimson Fury: 4 malhas de roda rotacionadas/fora do lugar na pose base (pose `+0x60` ≠ inverso de `+0x20`).
- ~~Tipos de nó desconhecidos em poucos carros~~ — resolvido no M3 (tipo = 6 bits baixos; 0 desconhecidos nos 74 carros).
- Gelo tratado como efeito por tabela de texturas (escolha do host).
- Iluminação/brilho: modelos escuros; falta calibrar contra o jogo (cor de vértice 128 = 1,0 está aplicada).

## 2026-10-10 (noite) — M3: arenas

| Item | Resultado |
|---|---|
| Texturas | **104/104** `.tex` do jogo decodificados (5.316 texturas): cadeias de mip, PSM nativo (família B), cabeçalho de tamanho variável |
| Relocação | escape de 32 bits (delta 0) — **100%** dos ponteiros válidos em todos os `.ngp` |
| Conversão | 26/26 níveis + 37 + 37 carros, **0 erros**, 0 tipos de nó desconhecidos nos níveis |
| Testes Python | 36/36 (inclui escape da relocação, mips, PSM4 linear, seletor de textura por strip, todos os `.tex` reais) |
| Visual | Galeria de 9 arenas reconhecíveis (`docs/validation/m3-arenas.png`): Arena, Egito, Paris, Tóquio, Grécia, Rússia, Mônaco, Castelo, Freeway |
| Draw calls | 57–219 por arena (batching por material); meta < 500 ✅ |
| Câmera livre | WASD/QE + órbita; teste de fumaça `tools/web/smoke.mjs` (câmera se move, seletor com 100 modelos) |
| Iluminação | **unlit** (textura × cor de vértice): o Lambert escurecia triângulos com normais invertidas; o PS2 traz a luz pré-calculada nas cores |

**Pendências / escolhas do host:**
- Cobertura da cena 43–100% dos triângulos; o restante são LODs menos detalhados, estados de dano e prefabs — não verificado triângulo a triângulo.
- Sprites (luzes) e feixes não são desenhados no modo nível (batching).
- Prefabs dos níveis (objetos fora da cena) exportados mas não instanciados (posições virão do jogo/ELF ou dos `.PTS/.PKP`).
- Grade de setores `0x0C`: só a lista de nós é usada; as células não foram decodificadas.
- Tamanho: níveis somam 435 MB (float32 sem compressão) — otimizar antes do deploy (M13).

## 2026-10-11 — M4: colisão + dirigir

| Item | Resultado |
|---|---|
| Física | `src/physics/vehicle.ts` puro (sem DOM/Three); 6 testes sintéticos (assentar, vel. máxima, freio/ré, direção, parede, não girar parado) |
| Colisão | BVH (three-mesh-bvh 0.9.15) sobre os triângulos da pose base sem aditivos: 137 k (Arena), 159 k (Rússia), 260 k (Paris) triângulos, 108–261 ms para montar |
| Assets reais em Node | `tests/world.test.ts`: Arena e Tokyo DM, 12 spawns cada — assenta e dirige 6 s sem cair do mundo |
| QA assistido (input scriptado, `tools/web/drive.mjs`) | Tokyo DM (Axel, viatura), Arena (Axel), Rússia (Sweet Tooth), Paris (Twister): acelera, vira, para em parede, 4 rodas no chão |
| Orientação | frente dos carros = +Y no PS2 (grade/faróis vistos de frente na 1ª tentativa); `VEHICLE_TO_THREE` |
| Testes | TS 8/8 · Python 36/36 |

**Escolhas do host (provisórias, a substituir pela Fase 4/Ghidra):** todas as constantes de `VEHICLE_RULES` (gravidade 64 u/s², vel. máx. 150 u/s ≈ 100 mph assumindo unidade = pé), modelo arcade (sem rigid body), spawns nos nós PTS, colisão pelos triângulos de render (a grade 0x0C original não foi decodificada).

**Não verificado:** sensação de direção contra o jogo original (requer comparação humana); fps em GPU real (o headless usa SwiftShader, 12–20 fps).

## 2026-10-11 (tarde) — Verificação pós-travamento + início da Fase 4

**Integridade após o travamento do PC:** extração (787 arquivos, 0 reescritos pelo hash), assets (100 modelos + 2.893 PNGs, `tools/verify_assets.py`), código (tsc, TS 8/8, Python), documentos e memória — **nada perdido**. Jogo no Chrome real (RTX 3050): 85 fps na Arena.

**Fase 4 (RE):** Ghidra 12.1.3 + EE Reloaded v2.1.37 instalados (downloads conferidos por SHA-256); ELF analisado em headless. Primeiro achado: **tabela de física dos veículos** em `0x2ba990` (36 × `0x150`), lida por `FUN_00140d60`. Rodas da tabela batem com os modelos em 31/36 carros e substituem a estimativa por bounding box (`rules/vehicles.json`). Teste `NativeRulesTests`. Detalhes: `docs/NATIVE.md`.

## 2026-10-11 (noite) — Combate: armas, pickups e bots

| Item | Resultado |
|---|---|
| Nativo usado | ids/nomes dos pickups (tabela `0x2c3a00` = word 8 do `PKP`), regra de escolha de alvo (`FUN_00102f50`), unidades pés/mph, gravidade |
| Regras puras | `src/game/weapons.ts` + `src/game/match.ts`; testes TS **19/19** (alvo nativo, míssil reto/teleguiado, ricochete, dano em área, pickups, munição, morte/renascimento, bots se movem e atiram, carros não se atravessam) |
| QA headless (`tools/web/match-qa.mjs`, `bot-trace.mjs`) | bots andam (até 164 pés/s com turbo), pegam pickups (Remote, Napalm, Ricochet), causam dano |
| Chrome real (RTX 3050) | 85 fps com 5 carros na Arena; 4 Homing disparados pelo jogador derrubaram a viatura de 100 → 61 (4×10) |
| Bugs achados e corrigidos | bots presos (detecção de "atolado" sem memória de tempo); bots atirando através de paredes (sem linha de visão); carros se atravessando (sem colisão carro×carro) |

**Escolhas do host:** ver `docs/NATIVE.md` (dano/velocidade/munição, vida, turbo, IA, mapeamento visual dos objetos do GLOBALS). **Não verificado:** sensação de combate contra o original.

## 2026-10-11 (noite) — Música e efeitos

| Item | Resultado |
|---|---|
| Música (`tools/convert_audio.py`) | 41 faixas VAG/VPK → AAC 128k (136 MB); pares mono L/R do menu unidos em estéreo; índice por arena |
| Efeitos (`tools/convert_sfx.py`) | 24 bancos 989snd (global + 23 carros) → 469 sons AAC 96k (4,9 MB) com os nomes originais |
| Runtime (`src/audio.ts`) | WebAudio: barramentos master/música/efeitos, efeitos 3D com ouvinte na câmera, motor de 3 laços por carro + sirene da viatura; liga no 1º gesto, **M** silencia |
| QA headless (`tools/web/audio-qa.mjs`) | Arena (5 carros): contexto `running`, 5 motores, `stdmrock` tocando 30 s, 33× `W_MGUN`, `W_RICO_LNCH`, `P_WEAPON`, `V_MAJOR_COLL`; Rússia: `rsqelec`; **0 falhas** de carregamento de áudio |
| Bug achado e corrigido | se o gesto chegasse antes do índice da música, ela nunca começava |
| Testes | TS 19/19 |

**Não verificado:** escuta humana (mixagem, volume, se o som do motor lembra o original); áudio no Safari/iOS. Escolhas do host listadas em `docs/NATIVE.md` (Áudio).

## 2026-10-11 (noite) — Menu de seleção

| Item | Resultado |
|---|---|
| Arenas (`tools/level_survey.ts`, física real em Node) | **24/26 jogáveis** (amostra de até 16 nós PTS por arena: assenta e dirige 6 s sem cair). Fora: `asylum` e `impound` — 13/14 nós sem chão sob eles (o caminho PTS não corresponde à geometria) |
| Carros (`tools/web/cars-qa.mjs`, Tóquio DM) | **30/30** do menu carregam, assentam e andam 80–93 pés em 4 s (15 Head-On + 15 Harbor City); chefes fora do menu |
| Menu (`tools/web/menu-qa.mjs`) | 30 carros, 24 arenas; prévia 3D enquadrada; ←/→ troca carro, Enter inicia `play.html?lvl=russia&car=cop&bots=3`; sem rolagem horizontal a 390 px; 0 erros de console |
| Bugs achados e corrigidos | prévia enquadrava uma roda (caixa incluía malhas aditivas — agora `solidBox`, a mesma do jogo); 404 do `favicon.ico` |

**Escolhas do host:** nomes de exibição das arenas e agrupamento (`src/catalog.ts`); fases HC identificadas só pela sigla. **Não verificado:** música do menu tocando (mesmo código das arenas, sem QA próprio); navegação do menu com gamepad (código escrito, sem controle para testar).

## 2026-10-11 (noite) — Revisão dos modelos (relato do usuário) + só arenas de deathmatch

Relato: "todos os modelos quebrados, o mais completo é o Warthog" — rajada de tiro sempre acesa, rodas do Crimson Fury fora do carro, Grasshopper sem roda dianteira, Hammerhead/Hearse sem rodas e com textura "zoada", Mr. Grimm sem partes. Referências de rodas certas: Warthog, Axel, Twister, Roadkill.

| Causa encontrada (no próprio `.ngp`) | Correção | Carros |
|---|---|---|
| Camada de reflexo (cópia da carroceria, textura `6ea3c`, alfa de vértice 0,15–0,30) desenhada opaca; o grupo traz um pacote de estado do GS (`ALPHA_1=0x44`, `ZBUF` ZMSK) | estado do GS exportado por malha (`gs`) + cor com alfa (`colorA`); runtime mistura sem gravar z | Spectre, Hearse, Thumper, Cop, Sweet Tooth, Hammerhead… |
| Clarão do tiro (textura `8a480`) na pose base | efeito `code:muzzle`, aceso 60 ms por tiro | todos |
| Rodas sem pose de repouso (pivô da suspensão não aplicado / bind incoerente) | `tools/wheels.py` casos A–D | Hammerhead, Hearse, Spectre, Sweet Tooth, Grasshopper, Crimson Fury, ATV |
| `0x15`: filho em `+0x0C` ignorado; `0x0D` sem bind (bit 6) com filhos em `+0x60` | walker corrigido | Mr. Grimm (19 → 33 peças), Axel, ATV |
| Seletores `0x05` tratados como efeito | pose do personagem / carroceria padrão | Mr. Grimm, hc_sweet, hc_chrom |
| LOD por "menor distância" | opção com mais triângulos | Tank Car (1 → 64 peças); Arena (19 nós vazios) |
| Spawn de frente para paredão (Egito) | nasce para a direção mais livre | todos os mapas |

**Verificação:** galerias antes/depois de 33 carros (viewer headless); referências intactas (teste `test_good_cars_untouched`); 30/30 carros do menu dirigem (`cars-qa.mjs`); testes Python **46/46** (novos: `tools/test_wheels.py`), TS **21/21** (novo: spawn virado para espaço livre).

**Só arenas de deathmatch** (pedido do usuário): menu e assets publicados com 7 arenas (arena, tokyodm, parisdm, egyptdm, greecedm, colisdm, castledm); 19 fases removidas de `public/assets/lvl` (391 → 49 MB; recriáveis com `tools/convert_model.py --dir lvl`). 7/7 jogáveis (`level_survey.ts`).

**Pendentes resolvidos na sequência:**
- Músicas: só as 7 faixas das arenas de deathmatch + menu (136 → 16 MB). Assets publicados: **213 MB** (antes > 1 GB).
- hc_hears: figura flutuante sobre o teto estava sob um condicional `0x1F` de evento (byte 3 = `0x06`, sai pela escotilha) → slot de efeito.
- Tank Car: clarão com outra imagem (`9dee4`) → `code:muzzle`.
- hc_suv: 4 rodas empilhadas na origem (ossos sem pivô; cabeçalho = índices de canal) → caso E, pontos nativos + **encaixe no arco** (`_fit_arch`: topo do pneu = ponto mais baixo da carroceria acima dele, num pico de h(y)); Crimson Fury também passou a encaixar no arco (dianteira estava à frente dele).
- Testes Python **48/48**, TS **21/21**, 30/30 carros dirigem.

**Ainda pendente:** peças traseiras penduradas no hc_suv (eixo/engate abaixo da carroceria); altura das rodas corrigidas é escolha do host; comparação contra o jogo original requer olho humano.

## 2026-10-11 (noite) — Relato 2 dos modelos

| Relato | Causa | Correção |
|---|---|---|
| Sweet Tooth: rodas acima do para-lama | altura do caso B estimada pela tabela nativa | `_settle`: arco atravessado → topo do pneu encosta nele (só abaixa) |
| Crimson Fury: traseira um pouco atrás, dianteira um pouco à frente | encaixe no arco puxou para o centro | y no meio do caminho entre arco e ponto nativo (±5,25 / −5,55) |
| Hammerhead: rodas altas demais (monster truck) + feixe branco | cubo ignorado; fachos de farol (`…8a00`) na pose base | `_settle`: pontas dos braços de suspensão (z ≈ −3,8) = cubo; fachos → `code:beam` |
| Hearse: objetos flutuando acima e abaixo | 4 barras de mecanismo com osso incoerente | `HIDDEN_PARTS` → `code:hidden` |
| Thumper: sem rodas + objeto embaixo | rodas empilhadas na origem (caso E com tamanhos diferentes); macaco hidráulico estendido | caso E generalizado (lado pelo deslocamento, frente pelo bit 2 do osso, busca do arco na metade do carro, platô da saia); macaco → `code:hidden` |
| Twister: textura "zoada" | camada de reflexo sem grupo de estado | malha de reflexo com alfa de vértice < 0,9 recebe o estado padrão (mistura, sem z) |
| (encontrados na revisão) hc_vette e hc_derby | 4 rodas empilhadas na origem | caso E |

Rodas simétricas por eixo nos casos C/E (`_symmetric`). Testes Python **49/49**, TS **21/21**, 30/30 carros dirigem. Galerias de todos os carros Head-On revisadas.

**Escolhas do host (por relato visual, sem dado do jogo):** alturas/posições das rodas nos casos B–E, `HIDDEN_PARTS` (hearse, thump). **Pendente:** peças traseiras do hc_suv.

## 2026-10-11 (noite) — Arenas: objetos posicionados, céu e luzes

Relato: "mapa vazio, só chão e paredes; o Coliseu está todo destruído e tem uma cúpula que parece o céu dentro".

| Causa (no `.ngp`) | Correção |
|---|---|
| Nós `0x03` e `0x1F` dos níveis carregam a **posição do objeto** em `+0x10..+0x18`; as malhas filhas são modeladas na origem. Ignorada, todos os objetos (prédios, colunas, estátuas, telhados) eram desenhados empilhados no centro | `ngp.scene(place_objects=True)`: translação acumulada por instância (`offset`), decidida por malha (peça na origem → aplica; peça já no destino → não); render, colisão e luzes aplicam o deslocamento |
| Céu = cúpula 412×412 + tampa (flag bit 31) modelada pequena na origem | exportado em `sky`; o runtime desenha ampliado, centrado na câmera, atrás de tudo |
| Modelos dinâmicos parados na origem (helicóptero "POLICE" etc.) | `effects['code:prefab']` |
| Sprites (157) e fachos de luz (62 malhas) não desenhados | `src/levelfx.ts` |

Posicionadas: arena 492, tokyodm 116, parisdm 259, egyptdm 54, greecedm 389, colisdm 354, castledm 670 instâncias. 7/7 arenas jogáveis (`level_survey.ts`), Python 49/49, TS 21/21. Capturas no jogo das 7 arenas revisadas.

**Escolhas do host:** escala/posição do céu; critério "local vs. já no mundo"; classificação de prefabs. **Pendente:** animação de texturas (`0x1A`), destrutíveis (estados `0x13`), animações de peças (`0x0B`).

## 2026-10-11 (noite) — Ícones de pickup

Relato: ícones "desconfigurados", principalmente os de arma. Causa: o ícone de arma (GLOBALS objeto 20) é um anel de 4 painéis semitransparentes com a placa amarela (atlas `5574c`, região u 0,75–1, v 0,75–1) dobrada em dois painéis de cada lado; desenhado com as duas faces, o painel de trás aparecia através do da frente ("M" duplicado). Correção: materiais dos pickups só com a face de fora (`FrontSide`; o winding das faces é para fora — conferido). QA: `tools/web/pickup-qa.mjs` (um ícone de cada tipo na frente da câmera). TS 21/21.
- Relato seguinte: "cada arma tem um ícone diferente — a própria arma em 3D com uma aura da cor dela". Os objetos 15–26 do GLOBALS são esses modelos (identificados visualmente; `PICKUP_MODELS`); o nó `0x12` tem filhos em `+0x2C` (Remote Bomb e Napalm vinham vazios). Aura: sprite aditivo colorido. QA `pickup-qa.mjs` em Arena e Coliseu DM.
- Armas montadas no carro (relato: "missel do lado do carro, napalm na parte de trás"): registros `0x00F8xxxx` do `.ngp` dos carros = pontos de montagem, slot = `(word & 0xFFFF) >> 6` = id do pickup (4 Napalm no alto da traseira, 2/3 lateral esquerda, 5/6 direita, 1 e 15 traseira baixa), posição em `+0x10`. Exportados em `mounts`; o jogo mostra o modelo 3D de cada arma com munição no seu slot. Escolha do host: tamanho (2,8), orientação (eixo longo para a frente) e Remote no slot 15 quando não há 11. QA `tools/web/mount-qa.mjs` (Warthog, Sweet Tooth). Testes 49/49 e 21/21.

## 2026-10-11 (noite) — Lançadores que abrem ao disparar (RE)

Relato: "modelos que abrem com a arma (porta abre e sai o míssil)". RE nos dados: não há trilha de animação nem pose alternativa (a 2ª matriz dos ossos foi testada no visualizador, `?pose=alt`: não é a pose aberta). A estrutura está nos registros `0x00F0xxxx` (slot = id do pickup) sob ossos com bit 31 = **lançadores**; os ossos-filhos com matriz são as **portas** (dobradiça = bind `+0x60`). Lançadores encontrados em 27 dos 37 carros. Implementado: base + portas montadas no ponto do slot; ao disparar a arma do slot a porta abre (100°, 0,9 s) e fecha. Bug achado: lançador com 2 slots (2 e 3) abria e fechava a mesma porta no mesmo quadro → alvo por porta. QA `tools/web/door-qa.mjs`: Sweet Tooth (tubos se erguem) ✅; Hearse (braço do napalm gira para fora) ⚠️ eixo/ângulo do host. Testes 49/49, 21/21, 30/30 carros dirigem. Pendente em `docs/PENDENTES.md`.

## 2026-10-12 — RE do sistema de animação dos carros

Achado no ELF: `FUN_0022cd58` (desenho do grafo) → `FUN_0022c678` (matriz do osso a partir de constantes **ou canais** do carro). Os ossos dos lançadores têm canais de visibilidade, translação x e rotação y; as portas, rotação y. Aplicado: lançadores invisíveis sem arma, aparecem e deslizam do centro ao ponto de montagem ao pegar munição (QA: Sweet Tooth de cima, sem arma vs. com Homing/Ricochet). **Não achado:** o código que escreve os valores dos canais (ângulos e tempos reais) — varreduras por escrita direta e por ponteiro sem resultado; ver `docs/PENDENTES.md`. Testes 49/49, 21/21, 30/30.

## 2026-10-12 — Mr. Grimm: peças faltando e fora do lugar

Relato: "o mr grimm tem muita peça faltando e fora do lugar". RE no renderizador (`FUN_0021b3c0`, ver `docs/NATIVE.md`):

| Sintoma | Causa | Correção |
|---|---|---|
| Roda dianteira sumida | a malha 0x2f60 vem logo depois do nó `0x15` 0x2f10 e era lida como "malha inline" dele; a deduplicação descartava a instância real (filha do osso 0x38f0, giro canal 4) | `0x15` = só lista de filhos; a malha seguinte não é dele |
| Garfo/guidão fora do lugar, guidão (0x42b0) faltando | nó `0x1F` 0x47e0 tem rotação (−45°) e translação que encaixam a peça no garfo inclinado, e **2 filhos** (`+0x0E`); o host lia só o 1º e sem transformação | `0x1F` vira osso fixo no esqueleto; todos os filhos |
| Braços/mãos flutuando | canais dos braços em t=0 dos clipes ≠ pose modelada | `rig.rest`: canais sem papel ficam na pose de bind, resolvida pelas inversas dos `0x15` (erro 0 em todos os ossos do Grimm e do Axel) |
| Rodas paradas | nenhum clipe escreve os canais de giro (1 e 4) | `rig.direct`: canais de roda sem clipe, girados pela distância |

Achados no caminho: rotação **constante** dos ossos também é negada (hc_stock: peça ia 9 pés para baixo); nós `0x03` nos carros somam translação (roda traseira do Twister estava duplicada para fora do carro); 2 das 4 rodas da maioria dos carros giram por código (agora giram). Testes Python 47/47 em tools/test_*.py (teste do ATV agora mede o esqueleto, não a heurística D), TS ok, galerias revisadas. Pendentes novos em `docs/PENDENTES.md`: chassi do ATV (`0x13`), rotação dos `0x1F` nas arenas, nó `0x18`, esterço do Grimm (clipe 0x1E).

## 2026-10-12 — Suportes de arma: movimento exato do jogo (RE)

Pendência A "peças que abrem com a arma — falta o movimento exato". Achado no ELF:

| Peça | Evidência |
|---|---|
| Leitor de clipe | `FUN_00212290`: as trilhas ficam **antes** do cabeçalho (`trilha[i] = trilha[i−1] − 4·desl[i]`, desl. u16 em `+0x12`, n em `+0x0C`). `tools/rig.py` lia depois do cabeçalho → **cada clipe recebia as trilhas do seguinte** (o lançador de Fire/Homing do Sweet Tooth aparecia como clipe 0x12 com passo 64/255 ≠ 48/255). Prova: passo × 255 = duração em todas as trilhas dos suportes |
| Amostradores | tabela `0x2c77e0[tipo&7]`: 0 cúbica explícita, 1 Hermite com as 2 tangentes da chave esquerda, 2 linear uniforme, 3 constante, 4 Hermite × duração do segmento, 5 degrau, 6 `3s²−2s³` (era tratado como degrau; o tipo 1 era suavização do host). Tangente s16 não linear acima de 0x4000. Tempo em quadros (`t0 + byte·passo`) |
| Instâncias por carro | `FUN_00127060` (carro+0x3c): categorias 0..3 giro, 4..7 suspensão, 8..11 esterço (roda i), 0x0D..0x21, 0x18, 0x19, 0x0C; API `FUN_00127778` (abrir, vel. 1 → **2 nos carros < 0x76**), `FUN_00127980` (fechar, vel. negativa), `FUN_00127ed8` (zerar) |
| Suportes | `FUN_00148d38`: 5 suportes = clipes 0x0D, 0x0E, 0x15, 0x16, 0x17; `FUN_00148e00`: arma → suporte por veículo; `FUN_00148978` (por quadro): abre o suporte da arma **selecionada**, fecha os outros, só um se move por vez |
| Tipo de arma | `FUN_00120ba0` (pickup → tipo): Fire 2, Homing 3, Napalm/Gas Can 4, Power 6, Ricochet 7, Ambiente 8, Swarmer 9, Remote 10 (1 = especial). Os marcadores `0x00F0` dos lançadores usam esse índice (`FUN_00147568`: carro+0x61d8+tipo·4) |
| Relógio | `DAT_002f4540` = delta em ticks de 1/60 s (temporizadores comparam com 0x78 = 2 s) |

Implementado: `tools/rig.py` (leitor + 7 amostradores + papéis por categoria + `MOUNT_CLIPS`), `src/rig.ts` (mesmos amostradores), `src/game.ts` (máquina de estados do `FUN_00148978`; saíram as portas de 100°/0,9 s e o deslizamento de 3/s do host). Efeito colateral: todos os carros têm clipe de giro nas 4 rodas (`rig.direct` vazio). QA `tools/web/mount-anim-qa.mjs` no Sweet Tooth: Homing abre a janela de sorvete da direita mostrando o suporte de mísseis; ao trocar para Napalm o suporte fecha e as portas traseiras abrem. Python 55/55 (novo `tools/test_clips.py`), TS 21/21.
