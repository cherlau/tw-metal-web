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
+0x00 0 | +0x04 u32 flags (≠0) | +0x08 f32 (0, ou velocidade de textura animada se flags & 0x04)
+0x0C f32 escala do ponto fixo (2^-4 … 2^-16; 1.0 em sprites)
+0x10..+0x1C ids de textura (0 a 4, terminados por 0; nunca ponteiros)
+0x20 vec4 bounding sphere (centro, raio)
+0x30..+0x5F 3 vec4 (🟡 planos/cone de culling?)
+0x60 um GS TEX0 de 16 bytes por textura (TW/TH/PSM corretos; TBP/CBP zerados)
flags bit 31 → mais 2 qwords (máscara 0xFFFF…, f32 distância)
geometria em +0x60 + 0x10·nTex (+0x20 se bit 31)
```
Geometria: cadeia DMA inline (CNT…RET, com TTE: os 8 bytes altos do tag são VIFcodes) **ou** bloco apontado por um DMA **REF** de uma lista de desenho.

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
| `0x01` grupo | `+0x08` nº filhos (16 bits), `+0x10` bounding sphere, filhos em `+0x20` | todos |
| `0x02` LOD | `+0x04` n; entradas de 16 bytes em `+0x20`: (?, f32 distância², *filho, ?) | menor distância = mais detalhado |
| `0x03`, `0x12` | `+0x08` n, parâmetros em `+0x10..+0x1B` (🟡 escala/animação), filhos em `+0x1C` | todos |
| `0x05` **slot de efeito** | n no byte `+0x0B`, filhos em `+0x0C` | **fora da pose base** → `effects` (escudo, gelo, fogo, turbo, fachos de farol, sombra) |
| `0x06` lista de objetos | `+0x04` n, `+0x08` n ponteiros para objetos `0x11` (nos níveis **não relocados**) | carros: o próprio objeto; níveis: exportados em `objects` (prefabs centrados na origem = instanciados pelo jogo) |
| `0x07` BSP (níveis) | `+0x04` frente, `+0x08` trás, `+0x10` esfera, `+0x20` *plano | ambos |
| `0x0A` plano/portal (níveis) | 🟡 | ignorado |
| `0x0C` grade de setores (níveis) | `u16 w, u16 h`, f32 célula, f32 ?, 4 f32 limites, `*A`, `*B`, células `(i<<10)|1`… | nós visuais referenciados na faixa entre `min(A,B)` e a grade (Tokyo B só é alcançável assim) |
| `0x0D` osso | `+0x1C` flags: bits 8..15 = nº filhos, bit 7 = tem matrizes, bits 16..22 = índice do osso; se bit 7: `+0x20` **inversa do bind**, `+0x60` pose local, filhos em `+0xA0`; senão filhos em `+0x20` | todos |
| `0x11` objeto | `+0x28` byte baixo = nº de partes, partes em `+0x2C` | todas |
| `0x13` estado de dano | `+0x08` n, `+0x0C` stride (12); entradas (*filho, ?, limiar): 0x7FFF intacto, 0x3FFF, 0x28F, 0 | 1ª entrada (intacto) |
| `0x14` | `+0x08` → filho | — |
| `0x15` | `+0x10` inversa do bind + **malha inline em `+0x50`** | — |
| `0x1F` | condição em `+0x08` (🟡), filho em `+0x1C` | segue |
| `0x08` locator, `0x0E` vazio, `0x17` marcador, `0x18` partículas, `0x19` gatilho/emissor, `0x1A` controlador de animação, `0x1B`/`0x1E` colisão, registros `0x00F0xxxx/0x00F8xxxx` | — | ignorados (sem malha) |
| `0x0B` | trilha de animação (nº de quadros f32, canais com keyframes; ex.: rotação -2π das rodas) | não usado ainda |

**Malhas estão no espaço do modelo** (pose de bind): a matriz em `+0x20` dos ossos é a inversa do bind (`p @ invBind` leva a peça para perto da origem do osso — testado). Na pose base a transformação é a identidade; para animar: `p @ invBind @ mundoAnimado(osso)`. 🟡 `+0x60` nem sempre é o inverso de `+0x20` (ex.: rodas do Crimson Fury) — provável pose local; confirmar quando as animações forem implementadas.

Escolha do host (confirmar no ELF): texturas de gelo `88a28`/`b5a20` tratadas como efeito "freeze" (`CODE_FX_TEXTURES` em `tools/convert_model.py`); flag de malha bit 15 = translúcida/aditiva.

### Coordenadas ✅
**Z para cima** (ondas de choque planas em XY; caminhão do Sweet Tooth alongado em Y), metros. Conversão para o Three: rotação de -90° em X, `(x, y, z) → (x, z, -y)`, sem espelho — confirmado pelo texto "A-12" legível no capô da viatura. Regra única em `src/coords.ts`.

## Listas de pontos das arenas (`SPT`, `PKP`, `PTS`, `GPS`) 🟡 — `convert_model.read_points`
`u32 versão` (data: `0x12282000` em SPT/PKP, `0x07162003` em PTS/GPS) · `3× u32 n` (iguais) · `n` registros com `vec3 f32` (coordenadas do PS2) no início.
| Seção | Registro | Uso conhecido |
|---|---|---|
| `PTS` | 32 B | nós do caminho da IA (em superfície dirigível — usados como spawn provisório) |
| `PKP` | 64 B | pickups (armas, vida) — tipo nos words seguintes (🟡) |
| `SPT` | 64 B | 🟡 **não** são spawns de chão (testado: caíam no vazio) — talvez holofotes/câmeras |
| `GPS` | 80 B | grupos de pontos (bounds + índices) |
Os words após o `vec3` são exportados crus (`raw`) para decodificação futura.

## Orientação dos veículos ✅
A frente dos modelos de carro é **+Y no PS2** (grade e faróis da viatura, lanternas atrás). No Three: `VEHICLE_TO_THREE = rotY(π) · PS2_TO_THREE` (frente = +Z), em `src/coords.ts`.

## Outros
| Formato | Status |
|---|---|
| `resident.rtx` | ❌ (texturas residentes, layout diferente do `.tex`) |
| `PTS/GPS/PKP/SPT/FPT/VPT/HLI` | 🟡 ver RECON |
| Áudio/vídeo | ver RECON §4.4–4.5 |
