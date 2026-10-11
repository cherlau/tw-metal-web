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
