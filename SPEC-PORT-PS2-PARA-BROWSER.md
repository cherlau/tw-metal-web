# SPEC: Portar um jogo de PS2 para o navegador (reconstrução, sem emulação)

> Documento de referência extraído da análise completa do projeto **hit-and-run-web** (The Simpsons: Hit & Run, PS2 → Three.js). Ele tem dois usos:
> 1. **Entender** como o port do Hit & Run foi feito (seções marcadas com o rótulo **[HnR]**).
> 2. **Repetir** o processo com outro jogo (seções **[GENÉRICO]**, checklists e roadmap).
>
> **Como um agente (Claude) deve usar este doc:** leia as seções 1–3 inteiras antes de qualquer trabalho. Em cada fase, siga o checklist, adapte os pontos marcados com ⚠️ (são específicos de engine/jogo) e não pule os critérios de aceite. Quando houver dúvida entre "imitar o original" e "inventar", prefira extrair o dado do disco ou do executável.

---

## Sumário

1. [A tese: reconstrução, não emulação](#1-a-tese-reconstrução-não-emulação)
2. [Princípios de projeto (não negociáveis)](#2-princípios-de-projeto-não-negociáveis)
3. [Arquitetura de ponta a ponta](#3-arquitetura-de-ponta-a-ponta)
4. [Fase 0: Reconhecimento do jogo-alvo](#4-fase-0-reconhecimento-do-jogo-alvo)
5. [Fase 1: Extração do disco](#5-fase-1-extração-do-disco)
6. [Fase 2: Decodificação dos formatos](#6-fase-2-decodificação-dos-formatos)
7. [Fase 3: Formato de assets para o navegador](#7-fase-3-formato-de-assets-para-o-navegador)
8. [Fase 4: Engenharia reversa do executável](#8-fase-4-engenharia-reversa-do-executável)
9. [Fase 5: Runtime (motor no navegador)](#9-fase-5-runtime-motor-no-navegador)
10. [Fase 6: Scripts, missões e progressão](#10-fase-6-scripts-missões-e-progressão)
11. [Fase 7: UI original, HUD e menus](#11-fase-7-ui-original-hud-e-menus)
12. [Fase 8: Áudio, diálogos e FMVs](#12-fase-8-áudio-diálogos-e-fmvs)
13. [Fase 9: Remaster opcional (Blender)](#13-fase-9-remaster-opcional-blender)
14. [Fase 10: Testes e validação](#14-fase-10-testes-e-validação)
15. [Fase 11: Build, hospedagem e deploy](#15-fase-11-build-hospedagem-e-deploy)
16. [Ferramentas de captura (trailer/QA)](#16-ferramentas-de-captura-trailerqa)
17. [Jurídico e higiene do repositório](#17-jurídico-e-higiene-do-repositório)
18. [O que reaproveitar vs. o que refazer por jogo](#18-o-que-reaproveitar-vs-o-que-refazer-por-jogo)
19. [Armadilhas conhecidas (checklist)](#19-armadilhas-conhecidas-checklist)
20. [Roadmap sugerido com critérios de aceite](#20-roadmap-sugerido-com-critérios-de-aceite)
21. [Template de estrutura de repositório](#21-template-de-estrutura-de-repositório)
22. [Como trabalhar com agentes neste tipo de projeto](#22-como-trabalhar-com-agentes-neste-tipo-de-projeto)
23. [Apêndice A: Referência técnica do Hit & Run](#apêndice-a-referência-técnica-do-hit--run)

---

## 1. A tese: reconstrução, não emulação

O projeto **não emula o PS2 e não recompila o executável**. Ele:

1. **Lê os dados do disco** (modelos, texturas, animações, scripts de missão, áudio, vídeos, UI, colisão, malha de ruas, tuning de veículos).
2. **Converte offline** (Python + ffmpeg + Blender) para formatos simples que o navegador carrega rápido.
3. **Reescreve o motor** em TypeScript + Three.js: renderer, física, colisão, IA, missões, UI e save.
4. **Recupera do executável (via Ghidra) só as regras** que o jogador sente: constantes, máquinas de estado e fórmulas. Essas regras são reimplementadas com o endereço de origem anotado no código.

O resultado: conteúdo original (personagens, cenários, falas, roteiro das missões) rodando em um motor novo.

| Abordagem | Prós | Contras |
|---|---|---|
| Emulação (PCSX2/WASM) | Fidelidade 1:1 | Pesada, lenta no browser, juridicamente pior, não melhora nada |
| Recompilação estática (estilo N64Recomp) | Fidelidade alta | MIPS R5900 + VU microcode = enorme esforço |
| **Reconstrução (este projeto)** | Leve, roda em celular, permite remaster, código limpo e testável | Não é 1:1; física e IA são aproximações calibradas |

O próprio README do projeto declara: *"This is not yet a 1:1 port"*. Uma spec honesta deve manter essa distinção entre **regra recuperada** e **escolha do host**.

**Números do HnR**, para calibrar a escala de esforço:
- 18.754 arquivos extraídos de 11 arquivos RCF (1,6 GB)
- 7 níveis, 19 interiores, 67 personagens, 71 veículos
- 89 missões, 610 estágios, 549 falas, 16 FMVs
- 9.549 formas de colisão estáticas e 5.486 props
- cerca de 550 KB de código (TS + Python) e cerca de 1,1 GB de assets convertidos

---

## 2. Princípios de projeto (não negociáveis)

1. **O disco é a fonte da verdade.** A ISO é só lida, nunca escrita. Todo arquivo extraído entra num manifest com SHA-256.
2. **Converter offline, runtime burro.** O navegador só baixa arquivos estáticos já prontos. Nenhum parsing de formato proprietário acontece no browser.
3. **Preservar identificadores originais.** Nomes de mesh, shader, junta (`w0..w3`), locator, `interactiveId`, `p3dName` e nomes de comandos de script atravessam todo o pipeline, porque o runtime e os scripts se referem a eles.
4. **Compilar sem perdas e dar significado depois.** Scripts viram JSON com todos os comandos (`{op, args, line}`). O runtime interpreta o que suporta e ignora o resto, sem jogar dado fora.
5. **Falhar alto (fail-fast/fail-closed).** Formato desconhecido, contagem que não bate, referência não resolvida, tipo de objetivo não suportado: tudo isso dá erro, nunca é ignorado em silêncio. Cada conversor escreve um relatório com `errors: []`.
6. **Regras puras e testáveis.** Lógica de jogo (calor de perseguição, moedas, missões, steering) fica em módulos sem DOM e sem Three.js, testáveis em Node.
7. **Uma regra de handedness aplicada em todo lugar.** Um único ponto define a conversão de sistema de coordenadas.
8. **Remaster é camada opcional e nunca toca gameplay.** O byte da colisão é copiado idêntico, e um teste garante isso.
9. **Hash-pin de tudo.** ISO, ELF (endereços só valem para aquele hash), arquivos-fonte de cada conversão.
10. **Honestidade de validação.** Há um log datado do que foi verificado, e "assistido" (com teleporte ou dev tools) é declarado como tal.

---

## 3. Arquitetura de ponta a ponta

```
┌──────────────┐   7zz    ┌──────────────┐  parser do   ┌───────────────────┐
│  ISO (PAL)   │ ───────▶ │ source/disc  │ ───────────▶ │ source/game/**    │  (gitignored)
│  read-only   │          │ ELF + *.RCF  │  container   │ + manifest.json   │
└──────────────┘          └──────┬───────┘              └─────────┬─────────┘
                                 │ ELF                              │
                                 ▼                                  ▼
                     ┌─────────────────────┐      ┌──────────────────────────────────┐
                     │ Ghidra headless +   │      │ Conversores Python (numpy/PIL)   │
                     │ EE processor ext.   │      │  • modelos (chunks + VIF)        │
                     │ target files (DSL)  │      │  • texturas (CLUT/alpha)         │
                     │ → asm/pseudocódigo  │      │  • esqueleto/skin/animação       │
                     └─────────┬───────────┘      │  • colisão, ruas, locators       │
                               │ leitura humana   │  • scripts → JSON                │
                               ▼                  │  • UI (sprites/fontes/layouts)   │
                     docs/*.md (endereço →        │  • áudio/vídeo via ffmpeg        │
                     evidência → implementação)   └───────────────┬──────────────────┘
                               │                                  │
                               ▼                                  ▼
                     src/*_RULES (constantes      ┌──────────────────────────────────┐
                     com comentário de endereço)  │ public/assets/  (.json + .bin,    │
                               │                  │  PNG/WebP, m4a, mp4, glb)         │
                               │                  └───────┬───────────────┬──────────┘
                               │                          │ (opcional)    │
                               │                          ▼               │
                               │               ┌────────────────────┐     │
                               │               │ Blender headless   │     │
                               │               │ remaster → glb /   │     │
                               │               │ remaster/scenes    │     │
                               │               └─────────┬──────────┘     │
                               ▼                         ▼                ▼
                     ┌─────────────────────────────────────────────────────────────┐
                     │ Runtime TS + Three.js (Vite)                                │
                     │ loop fixo 60 Hz + interpolação, física, colisão BVH, IA,    │
                     │ engine de missões (pura), UI original em canvas 640×480     │
                     └─────────────────────────────────────────────────────────────┘
                                                 │
                                       GitHub Pages (≤ ~1 GB)
```

**Stack exata do HnR:**
- Runtime: `three@0.185.1`, `three-mesh-bvh@0.9.14`, TypeScript (strict, `noEmit`), Vite (sem `vite.config`, só a flag `--base`)
- Testes: `node --test` com `tsx` (sem framework) e `unittest` em Python
- Ferramentas: Python 3.11+ (só `numpy` e `Pillow`), `7zz`, `ffmpeg`/`ffprobe` com demuxers RSD/IPU, Blender 5.1+ headless, Ghidra 12 com a extensão *Emotion Engine Reloaded*
- CI: GitHub Actions (testes + build) e GitHub Pages (deploy)

---

## 4. Fase 0: Reconhecimento do jogo-alvo

Antes de escrever código, responda a estas perguntas e registre as respostas num `docs/RECON.md`.

| Pergunta | Por que importa | Como descobrir |
|---|---|---|
| Qual região e versão do disco (PAL/NTSC-U/NTSC-J)? SHA-256 da ISO e do ELF? | Endereços e fps (25/30) mudam | `SYSTEM.CNF` → nome do ELF (ex.: `SLES_518.97`) |
| Qual engine/middleware? (RenderWare, Pure3D, proprietária…) | Define quanto já está documentado | Strings no ELF, extensões de arquivo, magic bytes |
| Há comunidade de modding/documentação? | Pode economizar meses | Wikis (ex.: Donut Team para HnR), repositórios de BMS (Luigi Auriemma/QuickBMS), ferramentas de modding |
| Formato de arquivos-contêiner? (AFS, BIGF, RCF, TOC no ELF, LBA cru) | Primeira barreira | Hex dump dos maiores arquivos; procurar tabelas de nomes |
| Geometria em formato neutro ou em pacotes VIF/DMA nativos? | Define a complexidade do decoder | Procurar códigos VIF (`0x6x` UNPACK) nos dados |
| Texturas swizzled (GS PSMT8/PSMT4)? CLUT? | Unswizzle completo pode ser necessário | Comparar a imagem decodificada linear com o esperado |
| Scripts em texto ou bytecode? | Texto → compilador simples; bytecode → precisa de VM | Abrir arquivos de missão |
| Formato de áudio (VAG, ADS, RSD, custom ADPCM)? | O ffmpeg cobre muitos | `ffprobe` no arquivo |
| Formato de vídeo (PSS/IPU/custom)? | Pode precisar de cabeçalho sintético | Procurar `00 00 01 B3`/`00 00 01 B0` |
| O que mora só no executável? | Fase 4 vai precisar | Lista de "comportamentos que o jogador sente" |
| Escopo jurídico | Ver seção 17 | |

**Entregável:** `docs/RECON.md` com hashes, lista de formatos (cada um classificado como conhecido / parcialmente conhecido / desconhecido) e um esboço do escopo do MVP.

---

## 5. Fase 1: Extração do disco

### [GENÉRICO]
1. Extraia a ISO com `7zz x <iso> -o source/disc` (idempotente: pule se `SYSTEM.CNF` já existir).
2. Escreva um **parser do contêiner** em Python puro (`struct`) com:
   - checagem de *magic*;
   - checagem de limites (offset + tamanho dentro do arquivo);
   - **proteção contra path traversal** (rejeitar caminho absoluto, `..` e `:`);
   - normalização de caminhos (`\` → `/`, **tudo em minúsculas**);
   - detecção de conflito (dois arquivos escrevendo bytes diferentes no mesmo caminho é erro).
3. Gere `source/manifest.json` com `{path, bytes, archive, offset, sha256}` por entrada.
4. Separe conteúdo por idioma, se houver arquivos de idioma.
5. Crie um teste que fixa as contagens (nº de entradas, bytes totais, nº de arquivos). Esse teste roda só quando a extração local existe (`skipUnless`).

### [HnR]: formato RCF (Radcore Cement Library)
- Magic `b'RADCORE CEMENT LIBRARY\0'`; `u32` em `0x24` aponta a tabela de diretório.
- Entradas `(crc, offset, size)` vêm **ordenadas por CRC**. Ordene por offset para casar com a tabela de nomes, que está em ordem de offset.
- Nome: `u32 len` + ASCII com padding NUL + 4 bytes ignorados.
- Os arquivos de idioma `DIALOGF/G/S.RCF` vão para `source/languages/<lang>`; o resto vai para `source/game/`.
- Resultado: 18.754 entradas e 1.624.497.194 bytes (valores fixados em teste).

### Localização dos arquivos depois da extração
O HnR não indexa nada: os conversores usam **convenções de caminho e globs** (`art/l{N}_terra.p3d`, `art/l{N}z*.p3d`, `scripts/missions/level0N/*.mfk`…). Documente essas convenções do seu jogo num mapa (ver o Apêndice A como exemplo).

---

## 6. Fase 2: Decodificação dos formatos

Esta é a fase que mais varia de jogo para jogo. A estratégia é sempre a mesma:

1. **Container de modelo** (árvore de chunks ou equivalente): parser recursivo genérico + `walk()` em profundidade.
2. **Compressão**: implementar o descompressor e testá-lo com fixtures sintéticas.
3. **Geometria**: formato neutro ou pacotes VIF.
4. **Hierarquia e transformações**: matrizes, composites, scenegraph.
5. **Skin, esqueleto e animações**.
6. **Texturas e materiais**.
7. **Sistema de coordenadas**: uma regra global.

### 6.1 Container de chunks [HnR: Pure3D]
- Chunk = `<u32 id, u32 headerSize, u32 totalSize>`. Os dados próprios vão de 12 até `headerSize`; os filhos vão de `headerSize` até `totalSize`.
- Valide `head >= 12`, `size >= head` e que o chunk cabe no pai.
- Strings Pure3D: 1 byte de tamanho + texto latin-1 com padding NUL.
- Compressão `P3DZ` (LZ77, variante LZR):

```python
code=b[p];p+=1; length=code&15
if length==0:
    length=15
    while b[p]==0: length+=255;p+=1
    length+=b[p];p+=1
if code>15:                                   # back-reference
    offset=(code>>4)|(b[p]<<4);p+=1
    for _ in range(length): out.append(out[-offset])   # cópia byte a byte (overlap-safe)
else: out.extend(b[p:p+length]);p+=length    # literal
```

A tabela completa de IDs de chunk está no Apêndice A.

### 6.2 Geometria nativa PS2 (pacotes VIF) [GENÉRICO + ⚠️]
Muitos jogos de PS2 guardam a geometria **já formatada para upload na memória da VU1**. O walker de VIFcodes é **reaproveitável**:

```python
cmd=(code>>24)&127; n=(code>>16)&255; imm=code&65535
if cmd>=0x60:                          # UNPACK
    vn=((cmd>>2)&3)+1                  # nº de componentes 1..4
    bits=(32,16,8,5)[cmd&3]            # largura do componente
    count=n or 256
    size=(count*vn*bits+7)//8; size=(size+3)&~3   # alinhado a word
    yield cmd,count,vn,bits,imm,data[p:p+size]
else:
    p+={0x20:4,0x30:16,0x31:16}.get(cmd,0)   # STMASK, STROW, STCOL
    if cmd in (0x50,0x51): p+=imm*16         # DIRECT/DIRECTHL (dados GIF)
    if cmd==0x4a: p+=(n or 256)*8            # MPG (microprograma)
    # demais VIFcodes não têm payload; desconhecido → raise
```

⚠️ **O mapa "endereço VU → atributo" é específico do microcode de cada engine.** No HnR (`imm & 0x3ff`):

| Endereço | Formato | Atributo | Decodificação |
|---|---|---|---|
| 0 | qualquer | início de batch (GIF tag) | inicia uma parte nova |
| 2 | V2-32 | UV | float32 |
| 3 | V4-8 | cor RGBA | `min(rgb/128, 1)` (no PS2, 128 = 1.0) |
| 3 | V3-32 / V3-16 | normal (alguns meshes) | f32 ou i16/32767 |
| 4 | V3-32 | posição | float32 |
| 5 | V4-8 | índices de matriz de skin | `palette[idx//4]` |
| 6 | V4-16 | pesos de skin | i16/32767, 4º peso zerado e renormalizado |

**Como descobrir esse mapa no seu jogo:** faça um dumper de pacotes (como o `tools/inspect_vif.py`) num modelo simples e conhecido. Infira pelo formato: V3-32 costuma ser posição, V2-32/V2-16 costuma ser UV, V4-8 costuma ser cor. Confirme renderizando.

⚠️ **O que o HnR ignorou e o seu jogo provavelmente vai precisar:**
- posições em ponto fixo (V3-16/V4-16) com escala por mesh;
- STROW/STCOL com modos de máscara (offsets somados);
- o bit USN (unsigned) do `imm`;
- o **bit ADC** (W/flag do vértice) para reinício de strip.

**Strip para triângulos** (cada batch VIF é uma strip independente, sem ponte entre batches):

```python
tris=np.stack([idx[:-2],idx[1:-1],idx[2:]],axis=1)
tris[1::2]=tris[1::2][:,[1,0,2]]                              # corrige winding dos ímpares
valid=np.linalg.norm(np.cross(v1-v0,v2-v0),axis=1)>1e-8        # remove degenerados (restarts)
pos[:,2]*=-1; nrm[:,2]*=-1                                      # LH → RH
indices=tris[valid][:,[0,2,1]].flatten()                        # espelho inverte o winding de volta
```

> O HnR detecta reinício de strip removendo triângulos de área zero. É uma heurística: o correto seria ler o bit ADC. Em outra engine isso pode falhar.

### 6.3 Hierarquia, composites e instâncias
- Matrizes Pure3D: 16 floats row-major com vetor-linha. Achatada, a matriz fica idêntica ao `Matrix4.fromArray` (column-major) do Three, então **não precisa transpor**. Confirme isso no seu formato.
- Composição: `local @ parentWorld`.
- Três modos de posicionamento: mesh isolado; veículo (joints do esqueleto posicionam portas, capô e rodas `w0..w3`); mundo (scenegraph → transform nodes → drawable nodes).
- ⚠️ **Wrappers indiretos:** entidades podem apontar para drawables através de várias camadas. No HnR, não seguir essas camadas fez sumir cenário crítico de missão. Faça uma **auditoria cruzada**: toda instância de física precisa ter um objeto renderizado correspondente, e a falta é erro.
- **Cache de mesh por nome:** converta uma vez e referencie muitas vezes.
- Deduplique instâncias pela matriz arredondada (sombra e drawable podem compartilhar a mesma transformação).

### 6.4 Esqueleto, skin e animação
- Juntas: `{name, parent, matrix: S·local·S}` (matrizes locais de bind).
- Skin: `skinIndex(4)` e `skinWeight(4)`, com pesos renormalizados.
- Canais de animação [HnR]:
  - quaternion comprimido: `u16` tempos/fps, `i16×4 /32767` em ordem **w,x,y,z**, reordenado para x,y,z,w, com **x e y negados** (espelho em Z);
  - posição f32×3 com z negado;
  - canais 1-DOF/2-DOF: valor constante + eixos animados;
  - **root motion removido** (`Motion_Root` ignorado);
  - duração `(frames-1)/fps`.
- Converta só uma *whitelist* de clipes, mais os de diálogo.
- ⚠️ Texturas "placeholder" resolvidas por código (no HnR, o swatch de cor dos personagens) só aparecem via Ghidra.

### 6.5 Texturas [GENÉRICO + ⚠️]
- Formato P3DI [HnR]: cabeçalho `<6I fmt,w,h,bpp,paletteSize,pixelSize>`, paleta no offset 28.
- **Alpha PS2 vai de 0 a 128:** `a*255//128` com clamp.
- **CLUT 8bpp CSM1:** troque os bits 3 e 4 do índice (reaproveitável em qualquer jogo PS2):

```python
order=np.arange(256); order=(order&~24)|((order&8)<<1)|((order&16)>>1); colors=colors[order]
```

- 4bpp: dois índices por byte, **nibble baixo primeiro**.
- ⚠️ O HnR guardava pixels **lineares** (não swizzled). Muitos jogos guardam no formato swizzled do GS (PSMT8/PSMT4, blocos e páginas), e aí é preciso implementar o unswizzle completo.
- **Deduplicação por conteúdo:** o nome do PNG é o hash dos bytes crus (`textures/<sha256[:20]>.png`). A mesma imagem aparece em centenas de arquivos.
- Gere um gêmeo WebP de cada PNG (sem perdas até 256 px, qualidade 90 acima disso).
- Shaders são reduzidos a `{texture, alpha(ATST), blend(BLMD), lit, translucent}`.

### 6.6 Sistema de coordenadas: a regra única
O Pure3D usa mão esquerda com Y para cima; o Three.js usa mão direita. **A regra global é negar Z**:

| Item | Transformação |
|---|---|
| posições/normais | `z *= -1` |
| matrizes | `M' = S·M·S`, com `S = diag(1,1,-1,1)` |
| quaternions | negar x e y |
| triângulos | inverter o winding `[0,2,1]` |
| headings de locator | negar |
| coordenadas em scripts | mesma regra |

Some a isso o fato de que modelos olham para -Z, o que gera offsets de `+Math.PI` no heading. Documente isso num único lugar.

---

## 7. Fase 3: Formato de assets para o navegador

### 7.1 O par `.json` + `.bin` [reaproveitável]
O HnR **não usa glTF** para o mundo e os personagens. Usa um dump mínimo:

- `<nome>.bin`: um blob little-endian. Cada atributo é anexado com padding de 4 bytes. Atributos são `float32`; índices são `uint32`.
- `<nome>.json`: os spans de cada atributo são `[byteOffset, count]`.

```json
{"collision":[byteOffset,floatCount],
 "source":"art/l1z1.p3d",
 "objects":[{"name":"w0","mesh":"wShape1","matrix":[16 floats],"interactiveId":"...","movable":true}],
 "meshes":{"meshName":[{"shader":"air_cond_m",
   "attributes":{"position":[o,n],"normal":[o,n],"uv":[o,n],"color":[o,n],"indices":[o,n]}}]},
 "materials":{"air_cond_m":{"texture":"air_cond.bmp","textureUrl":"textures/dd704f....png",
   "alpha":false,"blend":0,"lit":false,"translucent":false}}}
```

- O nº de componentes é **implícito pelo nome** (`uv`=2, `skin*`=4, demais=3).
- A **colisão vai no mesmo `.bin`**: um download traz render e colisão.
- O carregamento é zero-copy:

```ts
for (const [key,[offset,length]] of Object.entries(part.attributes)) {
  if (key==='indices') geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(binary,offset,length),1));
  else geometry.setAttribute(key,new THREE.BufferAttribute(new Float32Array(binary,offset,length),key==='uv'?2:3));
}
```

**Por que não glTF?** Porque o dump preserva conceitos do formato original (nomes de shader, flags, instância por nome, colisão junto), é trivial de escrever com numpy (`tobytes()`), é legível por testes em Node sem browser e permite batching próprio. Use **glTF só onde o Blender exporta** (veículos remasterizados).

### 7.2 Unidades de streaming
- Mantenha **1:1 as unidades do jogo original**: um par `.json/.bin` por arquivo-fonte (região, zona, interior, carro, personagem, prop).
- O HnR carrega **todas as regiões do nível em paralelo** (sem streaming por distância) e depois faz batching por material. Isso basta para a densidade de um jogo de PS2. Para mundos maiores, planeje streaming e LOD.
- Interiores são carregados sob demanda.

### 7.3 Arquivos de nível e mundo [HnR]
- `level{N}.json`: lista de cenas, locais de teleporte (do script), locators, centerlines de ruas, cercas.
- `world/navigation{N}.json`: grafo de ruas completo (estradas com `maxCars`, `speedKmh`; junções; segmentos com 4 cantos, faixas, acostamento e `next`).
- `world/objects{N}.json`: props interativos com ID estável `cena:instância:sha256(nome+matriz)[:12]`, shapes físicos, classe/material/som de colisão e `terrainTypes` por triângulo.
- `collision/world-level{N}.json` e `collision/l{N}i{NN}.json`: primitivos de colisão (esfera, cilindro, OBB), com `{version, source, sha256, shapes[]}`.
- ⚠️ **Em volumes de colisão aninhados, só as folhas são sólidas.** Os pais são bounds de broad-phase. Tratar os pais como sólidos "encheu" a Kwik-E-Mart no HnR.

### 7.4 Pipeline de conversão: ordem e dependências [HnR]
```
extract → convert (níveis, interiores, colisão, personagens, áudio, frontend)
        → campaign:convert (missões → assets usados → filmes)
        → pursuit:convert (tuning, carros de polícia)
        → remaster (Blender: carros, cenário, polícia)
        → movement:convert (world_resources: precisa rodar DEPOIS do remaster)
        → vehicles:repair-uv → bus:remaster → textures:webp
```
⚠️ **Lição:** no HnR, scripts posteriores **mutam JSON escrito por scripts anteriores**, o que torna o pipeline frágil. Num projeto novo, faça cada estágio puro (hash de entrada → saída) e torne explícita a dependência entre etapas (Makefile ou um DAG simples).

---

## 8. Fase 4: Engenharia reversa do executável

### 8.1 Objetivo
Não é recompilar. É **recuperar as regras** que não estão nos arquivos de dados: constantes de física, máquinas de estado (perseguição, pulo duplo), fórmulas de força, raios de spawn, tamanhos de pool, e a semântica dos comandos de script e de tuning.

### 8.2 Setup [HnR]
- O ELF de boot vem do `SYSTEM.CNF`. **O SHA-256 dele fica registrado**, e todo endereço da documentação vale só para aquele hash.
- MIPS R5900 little-endian, **sem símbolos**.
- Ghidra headless com a extensão **Emotion Engine Reloaded** (chaoticgd), linguagem `r5900:LE:32:default`.
- ⚠️ O Ghidra mostra aliases cached/uncached dos endereços (KSEG), então a contagem de funções fica inflada. Filtre pelo intervalo físico do código.

```sh
"$GHIDRA_HOME/support/analyzeHeadless" artifacts/native/project ps2 \
  -process SLES_518.97 -noanalysis -max-cpu 2 -scriptPath tools/native \
  -postScript InspectNative.java tools/native/pursuit-rules.txt artifacts/native/pursuit
```

### 8.3 DSL de arquivos de alvo (`tools/native/*.txt`)
Cada linha é de um destes tipos (`#` é comentário):

| Forma | Significado |
|---|---|
| `<hexaddr> <label>` | **âncora** (string, nome RTTI, vtable): coleta as xrefs e sobe até as funções; se a xref está em dados, segue mais um nível |
| `at:<hexaddr> <label>` | função explícita (`getFunctionContaining`) |
| `range:<start>:<end>` | todas as funções com entrada no intervalo |

O script exporta as raízes mais os **callees diretos** (profundidade 1), com limite de 80 funções e timeout de 20 s por decompile. Para cada função ele grava `.asm`, pseudocódigo `.c` e um `report.json` (xrefs, call graph, alvos não resolvidos). **A saída fica fora do git** (`artifacts/`).

### 8.4 Metodologia (loop de afunilamento)
1. **Descoberta** por strings: nomes de comandos de script (`SetMass`, `SetHitAndRunDecay`), nomes de classe RTTI do GCC (`14HitnRunManager`) e tabelas de comandos.
2. Ler o pseudocódigo e achar vtables e callbacks.
3. Escrever arquivos de alvo mais específicos (`at:`, `range:`).
4. Verificar à mão onde o Ghidra não criou função.
5. **Registrar** cada achado numa tabela `Endereço | Evidência | Implementação no browser` em `docs/*.md`.

Escala no HnR: só a parte de movimento levou 7 passes, 459 exports e 380 endereços.

### 8.5 Como o achado vira código
```ts
// PAL SLES_518.97: constructor 0x250d68, events 0x251328, update 0x251c78.
export const HIT_RUN_RULES = {
  maxHeat:100, releaseHeat:5, warningHeat:Math.fround(.78)*100,
  decay:1, chaseDecay:6, interiorDecay:10, decayDelay:3,
  catchRadius:10, catchSpeedKmh:30, catchSeconds:.75, bustedCoins:50, poolSize:5 };
```
- Use objetos `*_RULES` nomeados, com o **endereço no comentário**.
- Use `Math.fround` quando o limiar depender de float32. No HnR, aos 78 de calor, `0.78*100` em double dá um comportamento diferente do original.
- **Trave as regras com testes unitários.**
- Documente o que é **escolha do host** (gravidade 9,81 do veículo, modelo de inércia, restituição, solver). O doc do HnR diz: *"Source force formulas … do not prove matching trajectories."*

### 8.6 Bônus: a RE também corrige bugs de dados
A análise do executável mostrou que o conversor de tuning aplicava linhas **comentadas** do script: a polícia ficava com 750 kg em vez de 1.750 kg.

---

## 9. Fase 5: Runtime (motor no navegador)

### 9.1 Boot
1. Na carga do módulo: `Scene`, `PerspectiveCamera(55°, 0.2, 900)`, `WebGLRenderer` (sRGB, ACES, PCF shadows, DPR ≤ 2) e um `EffectComposer` (Render → Bloom sutil → Output, MSAA 4).
2. `renderer.setAnimationLoop(animate)` começa já. Durante o carregamento o loop só renderiza.
3. Em paralelo: a arte da UI, `catalog.json` e os assets de campanha. O menu 3D carrega em paralelo com o nível 1.
4. `loadLevel(n)` faz o **dispose completo** do nível anterior e então: `World.load` → moedas → tráfego → polícia → `Promise.all` (carro, personagem…) → `respawn` → `renderer.compile()` (pré-aquece shaders) → esconde o loader.
5. Um único `AbortController` cuida de todos os listeners; `dispose()` roda em `pagehide` e no HMR.

### 9.2 Loop: passo fixo de 60 Hz com interpolação
```ts
dt = Math.min(frameMs/1000, 0.08);           // evita a "espiral da morte"
// inputs one-shot consumidos 1x por frame, fora do loop fixo
accumulator += dt;
while (accumulator >= 1/60) {
  motion.capture(state);                     // guarda a pose anterior
  /* simulação: jogador → objetos → tráfego → polícia → campanha */
  accumulator -= 1/60;
}
const alpha = accumulator*60;
motion.sample(state, alpha);                 // lerp da posição + heading pelo menor arco
```
- 60 Hz casa com o tick do PS2. Veículos fazem substeps de até 1/120.
- Reset de interpolação em pausa e teleporte.
- ⚠️ No HnR a orientação 3D do carro usa smoothing exponencial em vez de alpha, o que causa lag ou jitter. Num projeto novo, interpole tudo com alpha.

### 9.3 Estado e comunicação
- Sem framework e sem ECS: variáveis de módulo em `main.ts` mais um `CarState` mutável.
- Os subsistemas conversam por **callbacks** e por **filas de eventos drenadas pelo dono** (`hitAndRun.drain()`, `worldObjects.drain()`).
- Para o próximo jogo vale considerar um ECS leve se houver muitas entidades. O padrão de "regras puras + drain" deve ser mantido.

### 9.4 Carregamento de assets
- Parsing zero-copy (seção 7.1).
- **Batching estático:** objeto não-móvel e não-interativo → `applyMatrix4` → agrupado por material → `mergeGeometries` → um `Mesh` por material por região. Objetos interativos ficam como `Group` com o nome do `interactiveId`.
- **Promise maps contra download duplicado:**

```ts
let pending=this.pendingTextures.get(key);
if(!pending){
  pending=(async()=>{const t=await loadTexture(url);configure(t);this.textures.set(key,t);return t;})();
  this.pendingTextures.set(key,pending);
}
return pending;
```

- `loadTexture` tenta o `.webp` e cai para o `.png`. Não há limite de concorrência (confia no HTTP/2).
- `assetURL = ${import.meta.env.BASE_URL}assets/${path}` funciona igual em dev e em subpath do Pages.
- Barra de progresso por região ("Building X · n/total").

### 9.5 Renderização
- **Preservar o visual original primeiro:** `MeshStandardMaterial` com `vertexColors:true` (as cores de vértice carregam a iluminação pré-calculada do PS2), `DoubleSide`, `alphaTest 0.4`.
- Personagens usam `MeshLambertMaterial` (barato e fiel).
- **Sombras dinâmicas sem estragar a arte:** um mesh `ShadowMaterial` (opacidade 0,05) sobre a malha de colisão, levantado 2,5 cm. Um único shadow map de 2048², ±35 m, seguindo o jogador.
- Presets de iluminação (golden, day, night) com Sky, sol, hemisférica, fog e tint global de material.
- Modo "performance": sem composer, sem sombra, DPR 1.
- **Grama:** `InstancedMesh` de 1.600 instâncias num **ring buffer toroidal** de 40×40 células, replanejado a cada 8 m, com raycast no BVH e **trabalho espalhado entre frames** (≤ 24 células e ≤ 1 ms por frame).
- Diagnóstico F3: FPS, draw calls, triângulos, p95 e máximo do frame.

### 9.6 Colisão (three-mesh-bvh)
Patch global único:
```ts
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
```
Camadas:
1. **Triangle soup** de todas as regiões, mesclada num único BVH. É double-sided, então o chão é "virado para cima" nos testes de cápsula.
2. **Primitivos originais** (box, cilindro, esfera) triangulados num segundo BVH, respeitando a semântica nativa (meia-extensão; cilindro arredondado vira cápsula; base refletida é re-ortonormalizada).
3. **Sólidos dinâmicos** (props quebráveis) num grid uniforme de 20 m, com flag `active`.
4. **Plataformas de veículo:** caixas orientadas para o jogador poder ficar em cima de carros e ser carregado por eles.
5. **Cercas:** segmentos 2D em grid, como barreira vertical.
6. **Tipo de terreno por triângulo**, que alimenta o grip dos pneus.

Consultas: `ground()`, `support()` (raio curto, para não confundir teto com chão), `raycast()` (oclusão de câmera), `boxContact()` (shapecast com SAT de 15 eixos).

### 9.7 Personagem
- `PLAYER_RULES` vêm do executável (caminhar 4, correr 8, gravidade 25, pulo 1,9, pulo duplo 1,0…). Velocidade do pulo = `sqrt(2gh)`.
- Cápsula r=0,35, h=1,8. Sweep subdividido (anti-tunneling), até 4 iterações de push-out.
- **Input relativo à câmera "travado"**: o yaw da câmera só é lido quando a combinação de teclas muda.

### 9.8 Veículos
- **Perfil derivado do modelo:** rodas `w0..w3` (frontais ≥ 2), raio pelo bounding box, chassi = bounds encolhidos.
- **Tuning pelos nomes originais dos setters** (`SetMass`, `SetTireGrip`, `SetSpringK`, `SetDamperC`, `SetTopSpeedKmh`…), lidos dos `.con` com defaults `??`.
- Por roda: mola `k = mass*g/limit*SetSpringK`, amortecedor `2*sqrt(k*m)*SetDamperC`, contato por raio curto, força lateral limitada pelo grip, máquina de 3 estados de derrapagem.
- Corpo: integração em torno do **centro de massa** (usar a origem no chão fazia o carro grudar na parede), inércia de caixa e torque de "endireitar".
- Velocidade máxima por **equilíbrio de arrasto** em vez de clamp.
- Colisão: 3 iterações de contato com impulso angular. Carro × carro com SAT 2D de OBB.
- **Detecção de teleporte:** scripts movem carros escrevendo `state.position`.
- **Um único solver para todos:** a IA gera `Controls {steer, throttle, brake, handbrake}` e chama o mesmo `simulateVehicle` do jogador.

### 9.9 IA
- **Tráfego** (igual ao `TrafficManager` nativo): pool de 5 carros, varredura a cada 0,2 s num ponto 40 m à frente, spawn a 65 m, remoção a 75 m. Candidatos vêm da interseção entre círculo e centerline de faixa, com previsão de 1,5 s.
- `TrafficPath`: curva parametrizada por distância, centro de faixa interpolado nos cantos do quad, **Bézier cúbica nas junções**.
- `SteeringDriver`: lookahead `max(5 m, 0.8 s·v)`, ângulo dividido pelo ângulo máximo da roda (regra nativa), limite de frenagem `sqrt(2·a·d)`, ré de 0,7 s quando preso.
- **Perseguição:** `HitAndRun` é uma máquina de estados pura (calor de 0 a 100, latch em 100, libera abaixo de 5, decaimentos, ofensas, captura). `Pursuit` faz spawn atrás do jogador a 100 m e repath com A\* no grafo de ruas a cada 0,75 s.
- ⚠️ A direção das faixas **precisa vir do dado-fonte**: interpretar quads direcionais como mão dupla gerou tráfego na contramão.

### 9.10 Input, áudio e câmera
- **Input:** `Set` de `e.code` + `consume(code)` para edge-trigger. O toque usa botões DOM com `data-key="KeyW"` (o toque vira tecla virtual). O gamepad é lido por polling. Teclas são limpas no blur.
  - ⚠️ No HnR o gamepad só dirige. Num projeto novo, faça um **mapa de ações unificado** (teclado, gamepad e toque → ações) desde o início.
- **Áudio:** `HTMLAudioElement` com `.m4a`. O motor faz pitch-shift por `playbackRate` com `preservesPitch=false`. O som começa desligado (política de autoplay).
  - ⚠️ Num projeto novo, use **WebAudio** (mixagem, buses, espacialização).
- **Câmera:** modos chase, wide e hood; damping independente de frame rate `lerp(t, 1-exp(-dt*k))`; oclusão por raycast no BVH; FOV que abre com a velocidade; câmera de conversa sobrepõe as outras.

### 9.11 Ferramentas de dev
Ativas só em `import.meta.env.DEV && ?replay`:
- sequência de input scriptada (`"W 1000;W+A 500"`);
- pular para um cenário `nivel:missão:fase:estágio`;
- teleporte, forçar perseguição, adicionar moedas;
- leitura de estado ao vivo.

---

## 10. Fase 6: Scripts, missões e progressão

### 10.1 Compilador genérico de scripts [reaproveitável]
Os scripts do HnR (`.mfk`, `.con`) são listas planas de chamadas `Op(arg, "arg", 1.5);`. O parser **não conhece o conjunto de comandos**:
1. `strip_comments`: remove `//` e `/* */`, respeita aspas e **preserva as quebras de linha** (para manter os números de linha).
2. `parse`: regex `([A-Za-z_]\w*)\s*\(` seguido de varredura de argumentos (strings com escapes, números tipados, string vazia entre aspas mantida).
3. Saída: `[{op, args, line}]`.

Se o seu jogo usa **bytecode** (Lua compilado, VM proprietária), troque o parser por um disassembler. O princípio continua o mesmo: dump sem perdas, semântica depois.

### 10.2 Compilação estrutural
Uma única passada:
- `AddStage`/`CloseStage` abre e fecha estágios. **Todos os comandos** vão para `stage.commands`.
- Só o que o runtime usa para decidir é "promovido" a campo: `objective` (exatamente um por estágio, senão erro), `conditions[]`, `checkpoint` (`RESET_TO_HERE`), `message` (resolvida via tabela de textos).
- **Referências simbólicas resolvidas em build:**
  - locators (pontos nomeados do mundo, lidos dos arquivos de modelo);
  - textos via **reimplementação do hash original** (`h=(c+(h<<6))%mod`);
  - rewards;
  - convenção de nome dos arquivos de diálogo.
- **`catalog.json`:** histograma de ops, tipos de objetivo e de condição, mais a lista `missingLocators`. É o **medidor de cobertura** e o checklist do port (no HnR, 0 locators faltando).
- **Conhecimento que mora no executável** fica em tabelas pequenas e nomeadas no compilador (filmes de fim de capítulo, numeração de títulos, nomes de interiores…).

### 10.3 Engine de missões: máquina de estados pura
`CampaignEngine` não toca DOM nem Three.js.

```
Snapshot (estado do mundo)  ──▶  engine.tick(snapshot)  ──▶  Effect[]
                                                              │
runtime aplica (async: carrega modelos, posiciona) ◀──────────┘
runtime chama engine.ready()  → loading → running
```

- Status: `idle → loading → running → between-stages → … → mission-complete`, com `failed` e `complete`.
- Effects: `prepare{reason, setup, commands, replay}`, `stage-complete`, `mission-complete`, `chapter-complete`, `failed`, `purchase`, `collect`, `drop`.
- `Snapshot`: posição, a pé ou não, veículo, vida, interior, entidades, interação, colisão, `dialogueDone`, `movieDone`…
- Cada tipo de objetivo tem uma regra de conclusão simples (ex.: `goto` = 2,6 m a pé ou 6,5 m de carro; `losetail` = distância > X por 2 s; `race` = checkpoints em ordem).
- **Três níveis de suporte a comandos:**
  1. tipos de objetivo e condição desconhecidos fazem o capítulo falhar ao carregar (fail-closed);
  2. comandos interpretados (spawn, posicionamento, perseguição);
  3. o resto (música, câmera, efeitos) é preservado no JSON e ignorado. Pode ser suportado depois sem recompilar.
- Erros no runtime viram "MISSION ERROR" no HUD, sem derrubar o loop.

### 10.4 Checkpoints e save
- **Checkpoint = índice de estágio + replay de comandos**, sem serializar o mundo. Ao tentar de novo, o runtime reexecuta os comandos de spawn dos estágios anteriores e restaura o jogador salvo.
- Save em `localStorage` (uma chave, versionado):

```ts
{version:2, level, car, position, heading, onFoot, parkedPosition, money,
 campaign:{version:2, level, mission, phase, stage,
   checkpoint:{phase, stage, remaining, cargo, player:{...}},
   story?, completed:["1:m0",...], cars[], skins[], coins:{level:[idx]}, ...}}
```
- **Autosave** no início de cada estágio, ao completar missão, ao comprar e ao levar multa.
- A validação na carga é estrita (`validateProgress`): save malformado é rejeitado, nunca carregado "mais ou menos".
- Toda chamada ao `localStorage` fica em try/catch.

---

## 11. Fase 7: UI original, HUD e menus

**Lição do HnR:** a primeira versão usava menus e HUD próprios, e isso **tirou a identidade do jogo**. Depois a UI foi refeita com a arte original. Use a UI original desde o começo.

### 11.1 Extração [HnR: Scrooby]
- **Sprites:** imagens em **tiles** remontadas linha a linha, com a borda de blit de 1 texel cortada. Isso recuperou 55 imagens de briefing.
- **Fontes bitmap:** a textura vira `font-<nome>.png` e os glifos (UV → retângulo em pixels, `y=(1-v1)*H`) vão para `fonts.json`.
- **Layouts:** páginas com elementos `{name, x, y, w, h, justify, color, rotation, font|images, strings}` vão para `layouts.json` (111 páginas).

### 11.2 Runtime
- **HUD num canvas com resolução virtual de 640×480**, escalado por `min(w/640, h/480)` e pelo DPR. Desenha radar, medidor de calor (pizza recortada), moedas, barra de dano nas coordenadas originais, objetivo, timer e toasts.
- **Texto com fonte bitmap** num canvas cacheado (LRU de 256), tingido com `globalCompositeOperation='source-in'`.
- **Botões DOM acessíveis:** o conteúdo é um canvas com a fonte original, mais um `aria-label`.
- **Posicionamento direto do layout extraído** (exemplo do menu de pausa), invertendo o Y:

```ts
const l=layouts['ingame/PauseSunday.pag'].find(r=>r.name===name);
btn.style.cssText=`position:absolute;left:${l.x/640*100}%;top:${(480-l.y-l.height)/480*100}%;width:${l.width/640*100}%`;
```

- Menu 3D original (a sala da família) renderizado com câmera fixa, letterbox 4:3 e scissor.
- Uma "state bridge" DOM oculta espelha o estado do HUD, para acessibilidade e testes.
- ⚠️ No HnR, as chaves de texto dos layouts não foram resolvidas (os labels estão fixos em inglês). Num port completo, resolva-as pela tabela de textos.

---

## 12. Fase 8: Áudio, diálogos e FMVs

- **Áudio:** `ffmpeg -i x.rsd -c:a aac -b:a 112k out.m4a`. O ffmpeg já demuxa vários ADPCM de PS2 (RSD, VAG, ADS…). Verifique com `ffprobe` antes de escrever um decoder.
- **Diálogos:** o nome do arquivo segue uma convenção (`c_<conv>_<linha>_<tipo>_<ator>_l<nível><missão>.rsd`), parseada por regex. Converta **só os diálogos referenciados** pelas missões, em paralelo, e gere um índice `dialogue["nivel:conv"] = [{line, actor, file, mission}]`. No runtime, a busca segue a ordem original: específico da missão primeiro, genérico do nível depois.
- **FMVs [HnR]:** o contêiner `.rmv` (`rmvps212`) é parseado à mão. O stream **IPU** é fatiado e embrulhado num **cabeçalho sintético `ipum`** para o demuxer IPU do ffmpeg aceitar:

```
ffmpeg -i video.ipu -i audio.rsd -vf setsar=4h/3w -c:v libx264 -crf 21 -c:a aac -b:a 128k -movflags +faststart -shortest out.mp4
```
- Faça checagens de integridade: o nº de marcadores `00 00 01 B0` é igual ao nº de frames, e a duração fica dentro de 0,2 s de `frames/25` (PAL). Corrija o aspecto PAL 640×512 para 4:3.
- **Robustez:** se o `play()` for rejeitado pela política de autoplay, mostre um botão PLAY. Se faltar um clipe, mostre CONTINUAR. **O progresso do script nunca pode depender de uma mídia tocar.**

---

## 13. Fase 9: Remaster opcional (Blender)

Tudo roda **headless e determinístico**: `blender --background --factory-startup --python tools/X.py`.

- **Veículos:**
  - JSON/BIN → Blender (conversão Y-up → Z-up);
  - cada nó original vira um empty com a custom property `p3dName`;
  - rodas trocadas por geometria procedural com as medidas da original;
  - weld de duplicatas (2e-5) e bevel com weighted normals;
  - export GLB com `export_extras=True`, carregando `p3dName` e `sourceUVOrigin='top-left'`.
- **Cenário (100 cenas):**
  - 11 classes de material (asfalto, tijolo, madeira, metal…), classificadas por regex no nome;
  - **upscale de no máximo 4× (até 1024)**, preservando ilustração e letreiros, mais um **bump map de detalhe separado**. Não se fabrica detalhe em arte pintada;
  - a **iluminação PS2 pré-calculada** fica como atributo de cor por canto;
  - bevel só em peças pequenas de madeira, metal, tijolo e pintura;
  - export **de-indexado por canto**, para preservar as costuras de UV e cor.
- **Polícia:** sirene reconstruída (cores amostradas da UV original), tag `pursuitBeacon=True` para o runtime piscar, normal map de pneu.
- **Regras:**
  - o **byte da colisão é copiado idêntico** (há teste);
  - RNG com semente fixa (`default_rng(1989)`);
  - marcadores de idempotência;
  - manifest com hashes;
  - `.blend` salvo para inspeção (fora do git);
  - render de revisão.
- **Pós-processamento GLB sem Blender** (`repair_vehicle_uv.py`): flip de V nos accessors, ajuste de min/max e reempacotamento dos chunks. É idempotente pelo marcador e grava de forma atômica.
- **WebP:** `webp.py` usa multiprocessing e pula arquivos cujo gêmeo já é mais novo.

---

## 14. Fase 10: Testes e validação

### 14.1 Python (formatos), com fixtures sintéticas
- LZ: literal, overlap, tamanho estendido.
- Limites de chunk; path traversal no contêiner.
- Volumes de colisão: só folhas; formato desconhecido falha; OBB plano é aceito.
- Parser de tuning ignora comentário e a última chamada vence.
- Manifest real (só quando há extração local).

### 14.2 TypeScript (`node --test`), **contra os assets publicados**
O CI não precisa da ISO. `tests/world-fixture.ts` monta o `Terrain` real a partir dos assets em Node, e o GLB é parseado à mão, sem decoder de imagem.

| Teste | O que garante |
|---|---|
| assets | todo personagem e roupa tem textura e clipes; destrutíveis continuam endereçáveis depois do batching |
| building/interiors | não dá para sair do mundo pulando em prédios; entrada e saída dos 19 interiores ficam sobre o chão |
| campaign | semântica da engine (raio de conversa, timers, retry, compras, saves fail-closed, voltas, bônus) |
| **campaign-assets** | **todos os 610 estágios são completáveis**: um snapshot "ideal" sintético por tipo de objetivo, com os locators reais; toda referência resolve para um arquivo existente; colisão do remaster idêntica byte a byte |
| graphics | 329 sprites, 111 layouts, GLB com raiz única, todo `p3dName` presente, bounds finitos |
| hit-and-run / pursuit / traffic | constantes nativas, latch, decaimento, captura, spawn a 100 m, continuidade nas junções |
| motion | render a 120 Hz sobre física a 60 Hz dá o mesmo movimento |
| physics / vehicle-dynamics / player-world | aceleração, freio, suspensão, capotamento, rampa, pulo duplo, ficar em cima de carro |
| world-assets | integridade de faixas e junções, IDs únicos, `terrainTypes` = nº de triângulos, UV do ônibus igual ao atlas e não ao espelho |
| world-driving | **regressões de bugs reportados nas coordenadas exatas** |

### 14.3 Princípios
1. Testar os **assets publicados**, não só o código.
2. Todo bug reportado vira teste **na coordenada exata**.
3. Afirmar invariantes da conversão (colisão byte a byte, nomes preservados, raiz única).
4. Um teste do tipo "completar todo estágio com input ideal" cobre o jogo inteiro a baixo custo.
5. `VALIDATION.md` é um log datado e honesto: contagens, hashes, nº de testes ao longo do tempo, checagens no navegador marcadas como "assistidas". Inclui a frase: *"these checks do not establish 1:1 behavior"*.

---

## 15. Fase 11: Build, hospedagem e deploy

- **CI** (`checks.yml`, em push e PR): Node 24 + Python 3.12 → `npm ci` → `npm test` → `npm run build`.
- **Pages** (`pages.yml`, em push na main): `vite build --base=/<repo>/` → `prepare_site.mjs` → `upload-pages-artifact` → `deploy-pages`.
- **Caber no limite de ~1 GB do Pages:** `prepare_site.mjs` remove do `dist/` os arquivos originais que têm versão remaster e todo PNG que tem gêmeo WebP. 1,12 GB vira cerca de 790 MB.
- **Sem Git LFS:** cada arquivo fica abaixo de 100 MB (o maior é um mp4 de 54 MB). O `.gitattributes` marca os binários e `linguist-generated`.
- Docker só para dev (`node:24-slim` + `vite dev`).
- Versões das dependências fixadas exatamente.

---

## 16. Ferramentas de captura (trailer/QA)

**O código do jogo nunca é instrumentado diretamente:**
1. `prepare.py` faz `git archive HEAD` para uma pasta descartável e aplica **patches de string** no `main.ts`:
   - `preserveDrawingBuffer`;
   - **dt fixo de 1/60 por frame gravado**;
   - controles e câmera vindos do diretor;
   - hook depois de cada frame.
2. Um `vite.config.ts` gerado adiciona um middleware `POST /__capture?shot=&frame=`, que grava JPEGs e telemetria.
3. `director.ts` lê uma lista declarativa de tomadas: nível, carro, missão, posição, **passos de tecla temporizados**, caminhos de câmera. A simulação avança **um passo fixo por frame gravado**, então a captura é determinística.
4. `edit.py` (ffmpeg) monta a edição: trechos das FMVs originais, mixagem com ducking e `loudnorm`.
5. `verify.py` confere resolução, fps, nº de frames, durações e espaço de cor, e gera contact sheets dos cortes.

A mesma infraestrutura serve de harness de QA. Uma das tomadas do HnR se chama "QA / fence recovery".

---

## 17. Jurídico e higiene do repositório

> ⚠️ **Não é aconselhamento jurídico.** Avalie o risco do seu caso com um advogado.

- **Nunca** comite ISO, arquivos de contêiner crus, a extração (`source/`), a saída do Ghidra (`artifacts/`) ou os `.blend`. No `.gitignore`: `*.iso`, `*.rcf`, `*.p3d`, `*.rsd`, `*.rmv`, `source/`, `artifacts/`, `blender/`, `references/`.
- Licença **MIT só para o código**, com uma ressalva explícita de que ela não cobre o jogo, a arte, os personagens, o áudio e os scripts originais.
- Aviso de projeto não oficial e sem afiliação.
- ⚠️ **Ponto de atenção:** o HnR **redistribui os assets convertidos** (texturas, áudio, FMVs) no repositório e no Pages. É isso que permite jogar sem a ISO, e também é a maior exposição jurídica do projeto. Uma alternativa mais segura para o seu port: **não publicar os assets** e exigir que o usuário rode o pipeline com a própria ISO. Outra opção é converter no navegador a partir de um arquivo local do usuário (File System Access API). Essa segunda opção conflita com o princípio 2 e precisa ser uma decisão consciente.

---

## 18. O que reaproveitar vs. o que refazer por jogo

| Componente | Reaproveitar | Refazer / adaptar ⚠️ |
|---|---|---|
| Extração da ISO (7zz) + manifest com hash | ✅ | — |
| Parser do contêiner (RCF) | estrutura (bounds, traversal, manifest) | formato (AFS, BIGF, TOC no ELF, LBA…) |
| Container de modelo (Pure3D) | padrão de árvore de chunks e `walk()` | IDs e layouts dos chunks |
| Walker VIF (tamanhos, decode de UNPACK) | ✅ | **mapa endereço VU → atributo**; ponto fixo; STROW/máscara; bit ADC |
| Strip → triângulos | ✅ (mas prefira o bit ADC) | — |
| Texturas: alpha ×255/128, CLUT CSM1, nibble baixo primeiro | ✅ | unswizzle GS se for swizzled; formatos do cabeçalho |
| Esqueleto e animação | padrão de saída (`bones`, `tracks`) | codificação dos canais |
| Regra de handedness | padrão (S·M·S) | eixo a negar depende do engine |
| Formato `.json + .bin` e loader zero-copy | ✅ | — |
| Batching por material e promise maps | ✅ | — |
| Loop fixo + interpolação (`Motion`) | ✅ | tick nativo (50/60 Hz) |
| Colisão BVH (camadas) | ✅ | formato dos primitivos de origem |
| Solver de veículo, IA de tráfego | só se for jogo de carro | regras via RE |
| Compilador de scripts sem perdas + `catalog.json` | ✅ (texto) | gramática / disassembler de bytecode; hash da tabela de textos |
| Engine de missão pura (Snapshot → Effect) | ✅ (arquitetura) | tipos de objetivo e condição |
| Checkpoint por replay de comandos + save validado | ✅ | — |
| UI: canvas 640×480 virtual, fonte bitmap, aria | ✅ | formato da UI (Scrooby → ?) |
| ffmpeg para áudio e vídeo + checagem de integridade | ✅ | contêiner de FMV; codec de áudio |
| Ghidra headless + DSL de alvos + `*_RULES` | ✅ | alvos e endereços |
| Blender headless determinístico | ✅ (padrões) | classes de material |
| Testes contra assets publicados; regressão por coordenada | ✅ | — |
| CI + Pages + `prepare_site` (WebP-first) | ✅ | — |
| Diretor de captura | ✅ | tomadas |

---

## 19. Armadilhas conhecidas (checklist)

- [ ] **Convenção de UV/V-flip** diferente em cada pipeline (Pure3D com origem no topo; Blender e glTF invertem; Three usa `flipY`). Defina uma convenção, registre-a em metadado e teste contra o atlas original. No HnR as placas apareceram de cabeça para baixo, e o cache compartilhado de texturas misturou as configurações de personagem e de mundo.
- [ ] **Volumes de colisão pai** tratados como sólidos.
- [ ] **Drawables indiretos** através de wrappers somem (faça a auditoria física ↔ render).
- [ ] **Instâncias duplicadas** com a mesma matriz.
- [ ] **Caixa de nomes inconsistente** (normalize para minúsculas).
- [ ] **Linhas comentadas** sendo aplicadas por um parser ingênuo.
- [ ] **Faixas direcionais** interpretadas como mão dupla.
- [ ] Resposta de colisão **sem impulso angular** (carro preso de lado).
- [ ] **Quique em cerca** alternado (só quique quando estiver se aproximando).
- [ ] Integração em torno da origem no chão em vez do centro de massa.
- [ ] **Float32 vs double** nos limiares (use `Math.fround`).
- [ ] Unidades: km/h nos dados, m/s na simulação.
- [ ] Reinício de strip por área zero (heurística); prefira o bit ADC.
- [ ] Placeholder de textura resolvido só pelo executável.
- [ ] Alocação de `new Vector3` no hot loop (pressão de GC); use objetos scratch.
- [ ] Sem limite de concorrência de download (ok com HTTP/2; ruim em rede lenta).
- [ ] Sem LOD e com uma única cascata de sombra; planeje isso se o jogo tiver distâncias de visão longas.
- [ ] Gamepad só parcial e `HTMLAudio` em vez de WebAudio.
- [ ] Pipeline não idempotente (scripts mutando a saída de outros).
- [ ] FPS dos vídeos PAL (25) vs NTSC (29,97).
- [ ] Política de autoplay (áudio e vídeo exigem gesto do usuário).

---

## 20. Roadmap sugerido com critérios de aceite

Cada marco termina com algo **jogável ou verificável**. Não avance de marco com o anterior vermelho.

| # | Marco | Entregáveis | Critério de aceite |
|---|---|---|---|
| M0 | Recon | `docs/RECON.md`, hashes, mapa de formatos | todos os formatos classificados; escopo do MVP definido |
| M1 | Extração | `extract.py`, `manifest.json`, testes de contêiner | contagens fixadas em teste; path traversal rejeitado |
| M2 | Primeiro modelo | decoder de container + geometria + textura de **1 prop** | renderiza no Three com textura correta (sem flip/espelho) |
| M3 | Um nível estático | todas as regiões do nível 1, batching, câmera livre | visual reconhecível; zero `textureErrors`; draw calls < ~500 |
| M4 | Colisão + andar | soup + primitivos + BVH + personagem com `PLAYER_RULES` provisórias | não cai do mundo; teste de "pular na parede" passa |
| M5 | Personagem animado | esqueleto, skin, clipes idle/walk/run/jump | animações sem distorção; troca com crossfade |
| M6 | RE das regras-núcleo | Ghidra + DSL + `docs/*_PARITY.md` | constantes do jogador e do mecanismo principal com endereço + teste |
| M7 | Loop de gameplay principal | o sistema central do jogo (veículo, combate, plataforma…) | testes de dinâmica passando; a sensação aprovada por quem conhece o original |
| M8 | Scripts → JSON | compilador sem perdas, `catalog.json`, `missingLocators = 0` | 100% dos scripts compilam; histograma publicado |
| M9 | Engine de missões | engine pura + runtime + presentation | teste "todo estágio completável" verde |
| M10 | UI original | sprites, fontes, layouts, HUD 640×480, menus | jogo inteiro navegável só com a UI original |
| M11 | Mídia | áudio, diálogos, FMVs com checagem de integridade | todos os clipes referenciados existem; fallbacks de autoplay |
| M12 | Save | localStorage versionado + replay de checkpoint | save malformado rejeitado; carga retoma do checkpoint |
| M13 | Deploy | CI + Pages + `prepare_site` | build < 1 GB; roda no celular |
| M14 | Remaster (opcional) | Blender headless | colisão byte a byte; nomes preservados |
| M15 | Polimento/paridade | `VALIDATION.md`, regressões por coordenada | playthrough documentado por capítulo |

---

## 21. Template de estrutura de repositório

```
<jogo>-web/
├─ index.html                 # #game, #loading, #hud (state-bridge), #menu
├─ package.json               # scripts: extract, convert, campaign:convert, test, build:site…
├─ tsconfig.json              # strict, noEmit, bundler, inclui src + tests
├─ requirements.txt           # numpy, Pillow
├─ src/
│  ├─ main.ts                 # boot, loop fixo, câmera, save/load, wiring
│  ├─ assets.ts               # json/bin zero-copy, batching, texturas webp→png, patch BVH
│  ├─ world.ts                # nível, iluminação, interiores
│  ├─ physics.ts collision.ts # Terrain, camadas de colisão
│  ├─ player-movement.ts      # PLAYER_RULES
│  ├─ character.ts            # SkinnedMesh + AnimationMixer
│  ├─ motion.ts               # interpolação
│  ├─ input.ts audio.ts       # mapa de ações unificado; WebAudio
│  ├─ original-ui.ts          # HUD/menus 640×480 com arte original
│  ├─ <sistemas-do-jogo>.ts   # *_RULES puras + wiring
│  ├─ dev-tools.ts            # ?replay, cenários, teleporte
│  └─ campaign/{types,engine,runtime,presentation}.ts
├─ tools/
│  ├─ extract.py              # ISO → source/ + manifest
│  ├─ <container>.py          # parser de chunks + descompressão
│  ├─ vif.py textures.py      # geometria PS2 e texturas
│  ├─ convert.py              # níveis, carros, catálogo
│  ├─ characters.py interiors.py world_collision.py world_resources.py
│  ├─ campaign.py campaign_assets.py movies.py audio.py frontend.py
│  ├─ webp.py prepare_site.mjs
│  ├─ test_formats.py
│  ├─ native/InspectNative.java + *-targets.txt
│  ├─ *_remaster.py           # Blender headless (opcional)
│  └─ trailer/ showcase/      # diretor de captura
├─ tests/*.test.ts + world-fixture.ts
├─ docs/RECON.md PORTING.md NATIVE_ANALYSIS.md <SISTEMA>_PARITY.md
├─ VALIDATION.md
├─ public/assets/             # SAÍDA da conversão (decidir se é comitada — ver §17)
└─ .github/workflows/{checks,pages}.yml
```

---

## 22. Como trabalhar com agentes neste tipo de projeto

O próprio README do HnR credita a reconstrução e a conversão ao **Codex**, e as melhorias de carregamento (WebP, downloads concorrentes) ao **Claude**, sempre *"com os arquivos reais, scripts-fonte, checagens no navegador e saída de build"*, e não a partir de screenshots. Recomendações:

1. **Dê ao agente acesso aos dados reais** (a extração em `source/`) e a um ciclo de feedback executável (`npm test`, dev server, ferramentas F3 e `?replay`).
2. **Uma tarefa por formato ou sistema, com critério de aceite testável.** Exemplo: "decodifique o chunk X; o teste Y deve passar; a contagem Z deve bater".
3. **Paralelize por fronteira de dados:** um agente para o decoder de texturas, outro para geometria, outro para o compilador de scripts. Todos convergem no formato `.json + .bin`, que é o contrato entre as partes.
4. **Exija a tabela "endereço → evidência → implementação"** para toda regra vinda do executável, e o comentário com o endereço no código.
5. **Proíba invenção silenciosa:** se o dado não foi encontrado, o agente deve marcar o ponto como "escolha do host" no doc, e não fingir paridade.
6. **Bug reportado → teste na coordenada → correção.** Sempre nessa ordem.
7. Mantenha o `VALIDATION.md` atualizado ao fim de cada sessão.

**Prompt-semente para iniciar o port de um jogo novo:**
> "Leia `SPEC-PORT-PS2-PARA-BROWSER.md`. O jogo-alvo é <X> (<região>, ISO em <caminho>). Execute o marco M0: identifique o engine, os formatos de contêiner, modelo, textura, script, áudio e vídeo, registre os hashes e produza `docs/RECON.md` com a classificação conhecido/parcial/desconhecido para cada formato e um escopo de MVP. Não escreva conversores ainda."

---

## Apêndice A: Referência técnica do Hit & Run

### A.1 Mapa de arquivos do disco (após a extração)
| Caminho | Conteúdo |
|---|---|
| `SLES_518.97` | ELF de boot (PAL), 3.886.492 bytes, entry `0x00100008`, código em `0x00100000–0x0041f900` |
| `art/l{N}_terra.p3d` | terreno, céu, grafo de ruas, locators do nível N |
| `art/l{N}r*.p3d`, `art/l{N}z*.p3d` | regiões e zonas de streaming |
| `art/l{N}i{NN}.p3d` | interiores |
| `art/cars/*.p3d` | veículos |
| `art/chars/*_m.p3d` / `*_a.p3d` / `global.p3d` | modelos, animações, recursos compartilhados de personagens |
| `art/frontend/scrooby/*.p3d` | UI (frontend, ingame, ingamel1..7) |
| `art/frontend/scrooby/resource/txtbible/srr2.p3d` | tabela de textos |
| `scripts/missions/level0N/*.mfk` | `level.mfk` (agenda), `leveli.mfk` (estado inicial), `m*i.mfk` (estágios), `m*l.mfk` (load), `*sdi.mfk` (intro) |
| `scripts/cars/*.con` | tuning de veículos |
| `sound/**/*.rsd`, `conversations/c_*.rsd` | áudio e diálogos |
| `movies/*.rmv` | FMVs (IPU + RSD) |

### A.2 IDs de chunk Pure3D usados
| ID | Significado |
|---|---|
| `0xFF443350` | raiz |
| `0x10000` / `0x10001` | Mesh / Skin |
| `0x10002` | PrimGroup (shader, tipo 0=lista, 1=strip) |
| `0x10005/06/07/08` | posições / normais / UVs / cores (BGRA u8), caminho não nativo |
| `0x1000a` | índices u32 |
| `0x1000b/0c/0d` | matriz-lista / pesos / paleta de matrizes (skin) |
| `0x10012` | **pacote VIF nativo de PS2** |
| `0x11000/11002/11003` | Shader / parâmetro string / parâmetro int |
| `0x19000/19001/19002` | Texture / Image / ImageData (P3DI) |
| `0x19005` | Sprite (imagem em tiles) |
| `0x4500/4501` | Skeleton / Joint (matriz 4×4 em `p+24`) |
| `0x4512/4516` | Composite drawable / composite prop |
| `0x120100/120103/120107` | Scenegraph / transform node / drawable node |
| `0x121000/121001` | Animação / grupo por osso |
| `0x121102/03/04/11` | canais 1-DOF, 2-DOF, vetor 3-DOF, quaternion comprimido |
| `0x3f00000` | entidade estática |
| `0x3f00001` | StaticPhys |
| `0x3f00002/09/0a/0c/0e/10` | entidades dinâmicas, instanciadas e animadas |
| `0x3000008` | lista de instâncias |
| `0x3f00003` (+`0x300000e`) | Intersect (triangle soup) + tipos de terreno por triângulo |
| `0x3000600` | efeito de colisão (classe, material, som) |
| `0x7010000/01/02/03/04/07` | CollisionObject / Volume / Sphere / Cylinder / OBB / Vector |
| `0x3000000` | cerca |
| `0x3000002/03/04/09` | segmento de rua / rua / junção / dados de segmento |
| `0x3000005` | locator (tipo 3 = heading, 7 = interior, 9 = actionData) |
| `0x18002/18006/18007/1800b/1800e` | página Scrooby / sprite / texto / string / idioma da tabela de textos |
| `0x22000/22001` | fonte bitmap / tabela de glifos (40 bytes por glifo) |

### A.3 Cobertura de scripts (`catalog.json`)
- **Objetivos:** goto 163, dialogue 153, talkto 93, getin 35, race 35, timer 23, interior 16, destroy 15, delivery 13, dump 13, losetail 13, follow 7, buycar 6, coins 6, buyskin 4, pickupitem 4, destroyboss 4, gooutside 4, fmv 3.
- **Condições:** timeout 144, damage 109, outofvehicle 92, position 17, followdistance 11, keepbarrel 10, race 8.
- **Ops distintas:** 79.

### A.4 Referências externas usadas pelo HnR
- Donut Team, documentação de Pure3D e dos comandos de missão do HnR
- Hampo, LuaP3DLib
- Luigi Auriemma, BMS do Radcore Cement (`atg_core_cement.bms`)
- PS2SDK, documentação de VIF
- chaoticgd, extensão Emotion Engine Reloaded para Ghidra

### A.5 Leituras recomendadas no repositório
- `docs/PORTING.md`: a narrativa do port
- `docs/NATIVE_ANALYSIS.md`: setup do Ghidra e metodologia
- `docs/MOVEMENT_PHYSICS.md`, `docs/PURSUIT_PARITY.md`: tabelas endereço → regra
- `VALIDATION.md`: modelo de log de validação
- `tools/vif.py`, `tools/textures.py`, `tools/p3d.py`: decoders reaproveitáveis
- `src/campaign/engine.ts`: modelo de engine de missão pura
- `tests/campaign-assets.test.ts`: modelo de teste "todo estágio completável"
