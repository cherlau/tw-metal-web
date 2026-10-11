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
