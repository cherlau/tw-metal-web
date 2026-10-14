# Formatos — Twisted Metal: Head-On (PS2, SCUS_976.21)

Referência viva dos formatos decodificados. Cada item diz o **status** e **onde está o código**.
Legenda: ✅ decodificado e testado · 🟡 parcial · ❌ desconhecido.

## `.BDD` (contêiner) ✅ — `tools/bdd.py`
Ver `docs/RECON.md §4.1`. Os nomes das seções nem sempre batem com o do arquivo (`aicars/thump.bdd` → `thumpai.ngp`): localize por **tipo**.

## `.ptr` (relocação) ✅ — `ngp.relocations()`
`u32 0xFFFFFFFF` + deltas `u16` em **words**, acumulados a partir de 0. Cada posição resultante é um word do `.ngp` que contém um ponteiro (offset relativo ao início do `.ngp`). **Delta 0 = escape**: os dois u16 seguintes formam um delta de 32 bits (`lo | hi<<16`) — necessário em níveis > 256 KB de salto. Zeros finais são padding. Validado: 100% dos ponteiros apontam para dentro do arquivo em todos os 132 `.ngp`.
Uso prático: distingue ponteiro de dado com certeza (ex.: um campo de cabeçalho de malha nunca é ponteiro).

## `.tex` (texturas) ✅ — `tools/tex.py`, `tools/gs.py`
```
0x00  u32 n, u32 0x0F, n pares (u32 contagem, u32 bytes)   (resumo por tamanho; não usado)
      entradas começam em max(0x40, alinha16(8 + 8n)); alinhadas a 16 bytes (linhas zeradas = pulos):
  +0x00 u32 (KB << 8) | 0x20
  +0x04 u32 id             ← casa com o campo +0x10 do cabeçalho de malha; 0 = CLUT
  +0x0C u32 formato        família A (bits 16..23 = 0x08+k): nibbles 8..11/12..15 = log2 do retângulo
                           PSMCT32, k = nº de níveis de mip que seguem (mesmo id); bit 23 = CLUT
                           família B (bits 16..23 = 0x20/0x40): byte baixo = PSM nativo (0x13 T8, 0x14 T4;
                           bit 6 flag), nibbles = log2 da textura; pixels LINEARES (mips pequenos e algumas texturas)
  +0x10 DMA tag RET (QWC) | +0x1C VIF DIRECT(QWC)
  +0x20 6 qwords: GIF tag + BITBLTBUF/TRXPOS/TRXREG/TRXDIR + IMAGE tag — ZERADOS (o jogo preenche)
  +0x80 pixels
```
- Sequência: imagem [+ k mips com o mesmo id — só o nível 0 é usado] [+ CLUT (id 0)].
- Família A com CLUT: 256 cores → **PSMT8** W×H = 2·cw × 2·ch, CLUT CSM1 (troca dos bits 3 e 4); 16 cores → **PSMT4** W×H = 2·cw × 4·ch.
- Sem CLUT → **PSMCT32** cor direta, linear.
- Pixels PSMT8/PSMT4 vêm **swizzled** (enviados como PSMCT32). `gs.unswizzle` emula a memória do GS (tabelas do PCSX2) — escreve como PSMCT32, lê como PSMT8/PSMT4.
- Alfa PS2 0..128 → 0..255.

## `.ngp` (modelos e níveis) ✅ — `tools/ngp.py`, `tools/vif.py`
Imagem de memória com ponteiros (ver `.ptr`).

### Cabeçalho de malha ✅
```
+0x00 0 | +0x04 u32 flags (≠0) | +0x08 f32 (0, ou escala da projeção de textura nos modos (flags>>1)&7 = 2..4, FUN_0024b170)
+0x0C f32 escala do ponto fixo (2^-4 … 2^-16; 1.0 em sprites)
+0x10..+0x1C ids de textura (0 a 4, terminados por 0; nunca ponteiros)
+0x20 vec4 bounding sphere (centro, raio)
+0x30..+0x5F 3 vec4: colunas = semi-eixos da caixa da malha (FUN_0016e678 usa para os destroços)
+0x60 um GS TEX0 de 16 bytes por textura (TW/TH/PSM corretos; TBP/CBP zerados)
flags bit 31 → mais 2 qwords: 8 × s16 canais de material do objeto 0x11 dono (−1 = nenhum; [0] U e [1] V só com a
      flag 0x800, [2..4] R/G/B, [5] alfa — FUN_0024baa8) + (f32, ?, f32 1,0, ?)
geometria em +0x60 + 0x10·nTex (+0x20 se bit 31)
```
Geometria: cadeia DMA inline (CNT…RET, com TTE: os 8 bytes altos do tag são VIFcodes) **ou** bloco apontado por um DMA **REF** de uma lista de desenho.

### Animação de material ✅ — `ngp.material_channels`, `src/texanim.ts`
Fogo, telões e água não têm quadros próprios: o pacote da malha leva à VU um deslocamento de UV e escalas de cor/alfa
lidos dos **canais do objeto 0x11 dono** (`obj+4`) pelos índices da extensão do cabeçalho (FUN_0024baa8). Os canais
vêm dos clipes `0x0B` do objeto (tabela em `obj+0x20`), como nos ossos dos carros. Ex.: fogo da Arena = atlas 4×2
(`d7214`) com U em −0,25·k e V em 0/0,5 por trilhas degrau; água de Paris DM = V de 0 a 2 em 480 quadros, em laço.

### Microprogramas da VU1 (mapa endereço → atributo) ✅
| Lote | Endereço VU | Formato | Significado |
|---|---|---|---|
| pool | 180 | S-32 | nº de vértices |
| pool | 181 | **V3-16 + ROW** (STMOD 1) × escala | posição em ponto fixo |
| pool | 181 | V4-32 | posição float (x, y, z, 1) — malhas com paleta de matrizes |
| pool | 373 | V3-8 /127 | normal |
| strip | 568 / 712 / 856 | V4-32 | GIF tag (tri-strip, regs ST/RGBAQ/XYZ2) — buffer triplo; **4º word: textura** (bits baixos `1+3i` → textura i do cabeçalho; 0 = mantém; bit 15 flag) |
| strip | base+1 | V1-8 | índice no pool |
| strip | base+2 | V1-8 / V4-8 / V4-5 | cor: intensidade, RGBA ou RGBA5551 (128 = 1,0; até ~2,0) — **é a iluminação pré-calculada: renderizar unlit** |
| strip | base+3 | V2-16 /4096 | UV (normalmente em [-1, 0]: usar RepeatWrapping) |
| strip | base+3+3i | V1-8 mascarado | **bit ADC** do vértice i (reinício de strip) |
| sprite | base+1 / +2 / +3 | V2-16 / V4-8 / V4-32 | retângulo UV / cor / centro + tamanho |
| feixe | base+1 / +2 / +3 | V4-32 ×N / V4-8 / V4-16 | polilinha (x, y, z, largura) / cor / UV |
| paleta | 856 | V4-32 ×4k | k matrizes (identidade na pose base) |

- Malhas sem lote de pool **reutilizam o pool que já está na VU** (segunda passada: brilho, reflexo).
- Strip → triângulos: triângulo no vértice k se `!ADC[k]`; winding alterna a partir do início da strip.

### Scene graph ✅ (pose base) — `ngp.scene()`
Cabeçalho do `.ngp`: `u32 n` + **n raízes**. Carros: [grupo visual, lista de objetos `0x06`]. Níveis: grupos visuais, grade de setores `0x0C`, lista de objetos `0x06` (até 8 raízes).
Tipo do nó = **6 bits baixos** do 1º word (bits 6..7 = flags, ex.: `0x41` = grupo animado).

| Tipo | Layout | Percurso |
|---|---|---|
| `0x01` grupo | `+0x04` *pacote de estado do GS (ou 0), `+0x08` nº filhos (16 bits), `+0x10` bounding sphere, filhos em `+0x20` | todos; o estado vale para os filhos (ver abaixo) |
| `0x02` LOD | `+0x04` n; entradas de 16 bytes em `+0x20`: (?, f32 distância², *filho, ?) | **opção com mais triângulos** (empate: menor distância). "Menor distância" falhava: opção vazia com d²=0 (Arena, 19 nós), carro inteiro na 2ª opção (Tank Car) |
| `0x03`, `0x12` | `+0x08` n, **translação em `+0x10..+0x18`** (FUN_0021b3c0 soma `R·t`), filhos em `+0x1C` | todos; nos carros vira osso fixo em `tools/rig.py` (Twister 0x10b10 leva a roda traseira à origem do osso); nos níveis aplica a posição às malhas modeladas na origem |
| `0x05` **seletor** | n no byte `+0x0B`, filhos em `+0x0C`; **filho desenhado = byte `+0x08`** (FUN_0022cd58; gravado por FUN_00230138); byte 3 do word = tipo; categoria = `word >> 18` (ver NATIVE "Seletores dos carros") | byte 3 = `0x06` (pose do personagem: braços/foice do Mr. Grimm): 1º filho não vazio ⚠️; byte 3 = `0x01` com 1º filho > 500 tri (carroceria do hc_sweet/hc_chrom): 1º filho ⚠️; demais: **fora da pose base** → `effects` (escudo, gelo, fogo, turbo, fachos, clarão) |
| `0x06` lista de objetos | `+0x04` n, `+0x08` n ponteiros para objetos `0x11` (nos níveis **não relocados**) | carros: o próprio objeto; níveis: exportados em `objects` (prefabs centrados na origem = instanciados pelo jogo); GLOBALS: também `categories` = 1º nó de cada categoria que o código registra (projéteis 4000..4099 / 0x1004.. por `FUN_00204778`, ícones de pickup 0x13ba+tipo / 5000+tipo por `FUN_001bdad0`), instâncias relativas ao nó |
| `0x07` BSP (níveis) | `+0x04` frente, `+0x08` trás, `+0x10` esfera, `+0x20` *plano | ambos |
| `0x0A` plano/portal (níveis) | 🟡 | ignorado |
| `0x0C` grade de setores (níveis) | `u16 w, u16 h`, f32 célula, f32 ?, 4 f32 limites, `*A`, `*B`, células `(i<<10)|1`… | nós visuais referenciados na faixa entre `min(A,B)` e a grade (Tokyo B só é alcançável assim) |
| `0x0D` osso | `+0x04/+0x08` f32 x, y (pivô); `+0x1C` flags: bits 8..15 = nº filhos, **bit 7 = inversa do bind em `+0x20`**, **bit 6 = bind em `+0x60`**, bit 5 = pivô de roda/suspensão (x, y em `+0x04/+0x08`, sem z), bits 16..22 = índice do osso. Filhos: `+0x20` (sem matrizes), `+0x60` (só bit 7 — ex.: `0x84` no Mr. Grimm), `+0xA0` (bits 7 e 6) | todos |
| `0x11` objeto | `+0x28` byte baixo = nº de partes, partes em `+0x2C` | todas |
| `0x13` estado de dano | categoria = `word >> 18` (`0x46` = ligado à vida do carro); `+0x04` u16 vida máx. (classe 0), `+0x06` u16 dano mínimo, `+0x08` n, `+0x09` classe de vida (1..5 → 1/20/60/100/300), `+0x0C` deslocamento do **byte de estado no nó `0x14` pai**; entradas de 12 bytes em `+0x10`: (*filho, *nó de ação ao entrar (tools/actions.py), u16 limiar = fração da vida × 65535: `0x7FFF` 50%, `0x3FFF` 25%, `0x28F` 1%, 0) | pose base = entrada 0; carros: todas as entradas (`damageScene`, marca `dmg`) e a regra (`damage`); entrada = 1ª com limiar ≤ vida (ver NATIVE "Estados de dano") |
| `0x12` escala | `+0x04` *? (animação), `+0x08` n, `+0x20..+0x28` escala (x, y, z), **n filhos em `+0x2C`** (antes lido em `+0x1C`: ícones Remote Bomb e Napalm saíam vazios) | todos (escala ainda não aplicada 🟡) |
| `0x14` | `+0x08` → filho (o `0x13`); `+0x0C` byte de estado (0 no arquivo, gravado pelo jogo), `+0x0E` u16 id do objeto destrutível | filho |
| `0x15` | entrada de paleta: `+0x04` n de filhos, `+0x08` slot (0..0xE no Grimm), `+0x0C` filhos, `+0x10` **inversa do bind** do osso filho (nó de 0x50 bytes) | segue os filhos. A malha que vem logo depois na memória **não** é dele (Grimm 0x2f60 = roda dianteira, filha do osso 0x38f0). A inversa não entra no desenho; serve para achar a pose de bind (`rig.rest`) |
| `0x1F` | **rotação s16 em `+0x08/+0x0A/+0x0C`** (× π/32768; mesma regra de sinal dos ossos), `+0x0E` u16 **nº de filhos**, translação `+0x10..+0x18`, filhos a partir de `+0x1C` (FUN_0021b3c0) | carros: osso fixo em `tools/rig.py` (Grimm 0x47e0 = −45° + (0, −2,68, 1,46) põe o garfo e o guidão no lugar). Níveis: matriz completa (rotação + translação, todos os filhos) → `matrix` na instância; malha "já no mundo" fica sem transformação (heurística) |
| registro `0x00F0xxxx` (carros) | **marca de lançador**: slot = `(word & 0xFFFF) >> 6` = **tipo de arma do jogo** para 1..7 (2 Fire, 3 Homing, 4 Napalm, 6 Power, 7 Ricochet… — `FUN_00120ba0`); 15 = Remote (tipo 10), 10 → 11, 11 → 12 (`FUN_00124288`, slot `carro+0x61d8`; o jogo põe ali o modelo do projétil, `FUN_00147568`); fica entre os filhos de um osso `0x0D` com **bit 31** nas flags (o lançador). Irmãos: malha base + ossos `0x0D` com matrizes = **portas** (dobradiça = translação do bind `+0x60`). O cabeçalho do osso-lançador traz y, z (`+0x08/+0x0C`); x vem do `0x00F8` do slot | `tools/launchers.py` → `launchers` |
| sprite (lote da VU1, `iu` V2-16) | retângulo de UV bruto = texel em ponto fixo 12.4 (texel·16); `uv` exportado = bruto/4096, normalizado no runtime por ×256/dimensão (`spriteUV`) | `tools/ngp.py` → `sprites` |
| registro `0x00F8xxxx` (carros) | categoria `0x3E`: **ponto de disparo** por id (`(word & 0xFFFF) >> 6`), posição em `+0x10` (FUN_00124288); nada é desenhado ali | exportado em `mounts` |
| `0x08` locator, `0x0E` vazio, `0x17` marcador, `0x18` escala (movido: ver linha `0x18`), `0x19` gatilho/emissor, `0x1A` folha de colisão (FUN_0022cd58 a trata como o tipo 9; não é animação), `0x1B`/`0x1E` colisão, registros `0x00F0xxxx/0x00F8xxxx` | — | ignorados (sem malha) |
| `0x18` escala | `+0x04` n, escala `+0x20..+0x28`, translação `+0x30..+0x38`, filhos em `+0x60` | carros: osso fixo `pre = S` (⚠️ translação como p·S + t); braços do Mr. Grimm |
| `0x0B` | **clipe** (FUN_00212290): f32 início `+0x04`, fim `+0x08` (quadros 1/60 s), u16 n `+0x0C`, u16 deslocamentos `+0x12`; bit 1 do u16 `+0x0E` = laço; tabela por objeto em `0x11+0x20`; trilhas ANTES do cabeçalho (`p −= 4·desl[i]`): u16 tipo, u16 canal; 7 amostradores (tabela `0x2c77e0`) — detalhes em `tools/rig.py` | carros: `rig.clips` (papel pela categoria, suportes de arma por `MOUNT_CLIPS`) |

**Malhas estão no espaço do modelo** (pose de bind): a matriz em `+0x20` dos ossos é a inversa do bind (`p @ invBind` leva a peça para perto da origem do osso — testado). Na pose base a transformação é a identidade; para animar: `p @ invBind @ mundoAnimado(osso)`. 🟡 `+0x60` nem sempre é o inverso de `+0x20` (rodas do Crimson Fury: Y com o mesmo sinal nas duas) — o jogo deve posicionar essas rodas por outra fonte; ver **Rodas** abaixo.

**Estado do GS por grupo** ✅: o `+0x04` de um grupo `0x01` aponta para um pacote VIF `… FLUSH, DIRECT n` + GIF tag A+D (NLOOP n, REGS=0xE) + n escritas. Nos carros (camada de reflexo e clarão): `ALPHA_1=0x44` → (Cs−Cd)·As+Cd, `TEST_1` z ≥, `ZBUF_1` **ZMSK=1** (não grava z), `CLAMP_1=0`. A camada de reflexo (malhas com flag bit 1, `…0312`) é uma **cópia da carroceria** com a textura de reflexo (`6ea3c`) e **alfa de vértice ≈ 0,15–0,30** — desenhada opaca, cobria a pintura. O conversor exporta `gs` por malha e a cor com alfa (`colorA`); o runtime usa mistura normal, sem gravar z.

**Rodas** (`tools/wheels.py`): o jogo as posiciona pela suspensão; o `.ngp` nem sempre traz a pose de repouso. Casos: A (já posicionadas — Warthog, Axel, Twister, Roadkill, Cop: intocadas); B (osso coerente, pivô x,y da suspensão ≠ osso: roda na origem → Hammerhead, Hearse, Spectre, Sweet Tooth, dianteiras do Grasshopper); C (bind ≠ inversa⁻¹, 4 rodas: Crimson Fury → pontos nativos da física); D (rodas em `0x15` com conjunto deslocado em x: ATV → recentralizado). ⚠️ altura (z) nos casos B/C/D = escolha do host. **Com o esqueleto (`tools/rig.py`), nenhum caso é usado nos carros**: as rodas saem dos ossos, nós `0x1F`/`0x03` e canais.

Escolha do host (confirmar no ELF): clarão do tiro = texturas `8a480`/`8fed0` → efeito `code:muzzle` (o runtime acende 60 ms por tiro); texturas de gelo `88a28`/`b5a20` tratadas como efeito "freeze" (`CODE_FX_TEXTURES` em `tools/convert_model.py`); flag de malha bit 15 = translúcida/aditiva.

### Coordenadas ✅
**Z para cima** (ondas de choque planas em XY; caminhão do Sweet Tooth alongado em Y), metros. Conversão para o Three: rotação de -90° em X, `(x, y, z) → (x, z, -y)`, sem espelho — confirmado pelo texto "A-12" legível no capô da viatura. Regra única em `src/coords.ts`.

## Listas de pontos das arenas (`SPT`, `PKP`, `PTS`, `GPS`) 🟡 — `convert_model.read_points`
`u32 versão` (data: `0x12282000` em SPT/PKP, `0x07162003` em PTS/GPS) · `3× u32 n` (iguais) · `n` registros com `vec3 f32` (coordenadas do PS2) no início.
| Seção | Registro | Uso conhecido |
|---|---|---|
| `PTS` | 32 B | ✅ **nós do grafo dos caminhos** (copiados como estão para o grafo `0x2f5c80`): `+0x00` vec3 + f32 0 · `+0x10` u8 ? · `+0x11` flags (**0x08 = spawn**, 16 por arena e 10 no Castelo DM; 0x10 = "usado" em runtime) · `+0x12` u8 ? · `+0x13` nº de vizinhos (≤ 6) · `+0x14` u16 ids dos vizinhos. O carro nasce virado para o 1º vizinho (`FUN_0011cd38`) |
| `PKP` | 64 B | pickups (armas, vida) — tipo nos words seguintes (🟡) |
| `SPT` | 64 B | 🟡 **não** são spawns de chão (testado: caíam no vazio) — talvez holofotes/câmeras |
| `GPS` | 80 B | grupos de pontos (bounds + índices) |
Os words após o `vec3` são exportados crus (`raw`) para decodificação futura.

## Fluxo de fichas dos roteiros ✅ — `convert_model.token_stream`
Nós `0x1B` (roteiros de abertura `0xC1C + 0x14·i` e roteiros `0xDCA`) trazem em `+0x0C` um fluxo lido por
`FUN_00231f80`/`FUN_00231fc0`/`FUN_00232170`: blocos `[tipo u8, n u8]`; tipo 1 = n `f32` (o 1º alinhado a 4 depois do
cabeçalho), tipo 2 = n strings (1º byte = tamanho), tipo 0 = fim. Roteiro = `n` e `n` trios (categoria do objeto,
índice, categoria do clipe), todos em f32.

## Clipes de objeto: bits do u16 `+0x0E` ✅
Bit 0 (`0x10000` do word `+0x0C`) = **auto**: `FUN_002111f8` toca o clipe quando o objeto é montado. Bit 1 = laço
(`FUN_00211348` → instância `0x10000`). Exportados como `auto`/`loop` em `matAnim` e `objRigs`.

## Níveis: `objRigs` e `intros` (JSON) ✅
`objRigs[nó do objeto 0x11]` = `{category, bones, clips}`: ossos `0x0D/0x1F/0x03/0x18` dos caminhos das instâncias
abaixo do objeto (`tools/rig.build`) e os clipes com só as trilhas dos canais desses ossos. As instâncias ganham
`ob`/`b` e o runtime as desenha cruas no osso (`src/objanim.ts`). `intros[]` = `{index, script}`: roteiro da
abertura (o port aplica só o estado final; a câmera seria o objeto `0xC1D + 0x14·i`, canal 0 = FOV em graus).

## Orientação dos veículos ✅
A frente dos modelos de carro é **+Y no PS2** (grade e faróis da viatura, lanternas atrás). No Three: `VEHICLE_TO_THREE = rotY(π) · PS2_TO_THREE` (frente = +Z), em `src/coords.ts`.

## Outros
| Formato | Status |
|---|---|
| `resident.rtx` | ✅ mesmo layout do `.tex` (cabeçalho com 0 grupos, entradas a partir de 0xF0); família B com PSM 0x1B (PSMT8H), 0x24 (PSMT4HL) e 0x2C (PSMT4HH), pixels lineares — fontes do HUD (0x46e98/0x46f20), explosões, fumaça (`tools/tex.py`) |
| `PTS/GPS/PKP/SPT/FPT/VPT/HLI` | 🟡 ver RECON |
| Áudio/vídeo | ver RECON §4.4–4.5 |
