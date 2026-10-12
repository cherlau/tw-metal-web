# RECON — Twisted Metal: Head-On – Extra Twisted Edition (PS2, NTSC-U)

> Marco **M0** do `SPEC-PORT-PS2-PARA-BROWSER.md`. Nenhum conversor foi escrito ainda.
> Ferramentas usadas: montagem read-only da ISO (Windows `Mount-DiskImage`), `ffprobe`, scripts Node descartáveis (hex dump, walker de VIF, scanner de strings).
> Data: 2026-10-10.

## 1. Identificação e hashes

| Item | Valor |
|---|---|
| Título | Twisted Metal: Head-On – Extra Twisted Edition |
| Região | NTSC-U (`VMODE = NTSC`) → vídeo a 30 fps, tick de jogo provável 60 Hz (a confirmar no ELF) |
| ELF de boot | `SCUS_976.21` (2.087.528 bytes) — `BOOT2 = cdrom0:\SCUS_976.21;1`, `VER = 1.00` |
| SHA-256 ISO | `e6c23917c9f0f98fc2a9faa66a93e16d4669075c1c5d314de8c5743af8c4cf0e` (4.197.416.960 bytes) |
| SHA-256 ELF | `8619cb640b4b5263f072b8f2de9aa459a517b3e1e2f9fc732fb0856dde22a3c3` |
| SHA-256 SYSTEM.CNF | `92e497865d8f6304b528b42d512b273767759020184a32ddeb243eb2f197da01` |

Todo endereço de função documentado nas fases seguintes vale **só** para o ELF com o hash acima.

## 2. Engine e toolchain

- **Engine proprietária** (Incognito / Eat Sleep Play), derivada da versão PSP do Head-On (strings `PSP TOKYO Nitro3`, `lbtokyo*`).
- **C++ compilado com GCC** (RTTI `9type_info`, `bad_alloc`). Sem símbolos, mas o ELF contém **nomes de arquivos-fonte** usáveis como âncoras no Ghidra: `CarPager.cpp`, `CarSound.cpp`, `GameModeScript.cpp`, `GameOptions.cpp`, `gameunlocks.cpp`, `McPersist.cpp`, `MenuFactory.cpp`, `RbInteract.cpp`, `destruct.cpp`, `debris.cpp`, `actionDispatch.cpp`, `PappyTarget.cpp`, `*bonus.cpp` (um por arena), `SoundMgr.cpp`, `loadbar.cpp`.
- Bibliotecas Sony: `libgraph`, `libmc`, `libmpeg` (`_pictureTemporalScalableExtension…`), driver de som **989snd** (`MOD/989SND.IRX`).
- **Não há scripts de missão em disco.** Textos (bios dos personagens, menus, unlocks, legendas de extras) e a lógica de modos de jogo moram **no executável** (`GameModeScript.cpp`, "action nodes"). → A Fase 4 (Ghidra) terá peso maior que no Hit & Run; a Fase 6 (compilador de scripts) praticamente não existe — vira "extrair tabelas do ELF".
- Comunidade/documentação: nenhuma referência pública confirmada nesta sessão para o formato BDD/NGP. **Pesquisar** (fóruns de modding de TM:Black/Head-On, XeNTaX/ZenHAX arquivados, vgmstream para áudio) antes de M2.

## 3. Mapa do disco

| Pasta | Arquivos | Tamanho | Conteúdo |
|---|---|---|---|
| `/` | 2 | 2 MB | `SYSTEM.CNF`, ELF |
| `CARS/` | 38 `.BDD` | 15,7 MB | veículos jogáveis (Head-On + `HC_*` = Harbor City / "Lost") |
| `AICARS/` | 38 `.BDD` | 14,1 MB | versões de IA (mesmos nomes; algumas menores → provável LOD/menos texturas) |
| `LVL/` | 26 `.BDD` | 207,5 MB | arenas (`ARENA`, `CASTLE`, `COLISEUM`, `EGYPT`, `FWAY`, `GREECE`, `MONACO`, `PARIS`, `ROOFTOPS`, `RUSSIA`, `TOKYO`, `ASYLUM`, `IMPOUND`, `HC_*`), versões `*DM` (deathmatch) e bosses (`FWAYBOSS`, `TOKYOB`) |
| `GLOBALS/` | 2 `.BDD` | 1,3 MB | recursos globais (`GLOBALS`, `RESIDENT` com seção extra `.rtx`) |
| `SHELL/` | 34 | 20,7 MB | UI (`UI.BDD` 17 MB), `SWIRL.BDD`, 32 telas de loading `LB*.TEX` (132.592 bytes cada) |
| `SND/` | 171 | 20,3 MB | bancos de efeitos `.BNK` (989snd) + `.XFX` (`XFDX`) |
| `VAG/` | 43 | 343,6 MB | música: `.VAG` (mono) e `.VPK` (estéreo) |
| `MOV/` | 25 `.PSS` | 2,36 GB | FMVs: intro, finais por personagem, créditos, documentário (`DOC35368.PSS`, 589 MB) |
| `TM1/` | 12 `.PSS` | 997 MB | vídeos extras (a identificar) |
| `MOD/` | 13 | 0,7 MB | módulos IOP (`.IRX`), ícones do memory card — irrelevantes para o port |
| `MEMCRD/` | 1 | — | ícone do save |

**Escopo útil para o port (sem vídeos):** ~640 MB. Com vídeos convertidos para H.264 em resolução nativa, estimar +1 GB → acima do limite do GitHub Pages; ver §7.

## 4. Formatos

Legenda: ✅ conhecido · 🟡 parcialmente conhecido · ❌ desconhecido

### 4.1 Contêiner `.BDD` — ✅ conhecido
Validado nos 106 arquivos `.BDD` (419 seções, todas dentro dos limites, sem erros).

```
entrada (44 bytes), repetida até o offset do primeiro dado:
  0x00 char[20] nome        (NUL-padded; caixa inconsistente → normalizar p/ minúsculas)
  0x14 char[8]  tipo        ("ngp", "tex", "ptr", "rtx", "PTS", "GPS", ...)
  0x1C u32      offset
  0x20 u32      size
  0x24 u64      timestamp   (FILETIME do Windows, ~2007-2008)
lista termina com nome vazio; dados alinhados.
```

Seções encontradas:

| Tipo | Onde | Hipótese |
|---|---|---|
| `ngp` | todos | imagem de memória com geometria, hierarquia e pacotes VIF (ver 4.2) |
| `tex` | todos (menos `DUMMY`) | bloco de texturas GS (ver 4.3) |
| `ptr` | todos | **tabela de relocação** do `ngp` (começa com `ffffffff`, seguido de deltas `u16`) |
| `rtx` | `RESIDENT` | texturas residentes (string no ELF: `file: %s.rtx in archive %s`) |
| `PTS` | níveis | pontos de navegação da IA (strings `ptool::%s (group %d to %d)`) — registros de 32 B com `xyz` float |
| `GPS` | níveis | grupos de pontos / grafo (bounds float + índices u8) |
| `PKP` | níveis | posições de pickups (armas, vida) |
| `SPT` | alguns níveis | spawn points |
| `FPT`, `VPT` | alguns níveis | ❌ (pontos de voo? pedestres/veículos de fundo?) |
| `HLI` | alguns níveis | ❌ (hotspots / iluminação?) |

PTS/PKP/SPT/GPS compartilham um cabeçalho `u32 magic(?) + 3×u32 contagem` seguido de registros com `vec3 float` — 🟡.

### 4.2 Geometria (`ngp`) — 🟡 parcialmente conhecido
- Cabeçalho: `u32 versão(=2)`, `u32 offset`, `u32 tamanho`, seguido de nós com ponteiros internos (offsets relativos ao início da seção, corrigidos em runtime pela tabela `ptr`). Bounding boxes em float32 (ex.: Axel ≈ ±5,0 × ±2,5 × 1,7).
- **Sem nomes legíveis** dentro do `ngp` (diferente do Pure3D). Identificação de partes (rodas, armas, destrutíveis) terá de vir da estrutura + ELF.
- **Pacotes VIF nativos para VU1** (scan: Arena tem ~10.500 UNPACK V4-32, ~9.000 V4-5, ~4.100 V3-16, ~10.000 MSCNT). Layout de um lote (Axel @ `ngp+0x3f8`), já decodificado com o walker:

| VIFcode | Formato | Endereço VU | Interpretação provável |
|---|---|---|---|
| `UNPACK` | S-32 n=1 | 180 | contador / header do lote |
| `STROW` + `STMOD 1` | — | — | **offset somado às posições** (modo offset) |
| `UNPACK` | **V3-16** n=8 | 181 | **pool de vértices em ponto fixo** (+ STROW) |
| `STCYCL 1,3` | — | — | escrita intercalada |
| `UNPACK` | V4-32 n=1 | 568 | GIF tag (NLOOP=10, EOP) |
| `UNPACK` | V1-8 (usn) n=10 | 569 | **índices de strip** no pool |
| `UNPACK` | V4-8 (usn) n=10 | 570 | cor RGBA por canto (128 = 1.0) |
| `UNPACK` | V2-16 + máscara n=10 | 571 | UV em ponto fixo |
| `UNPACK` | V1-8 + máscara | 586 | flags (ADC / restart?) |
| `MSCNT` | — | — | dispara o microprograma |

  Também aparecem V3-8 (`0x6a`, provável normal), V4-5 (`0x6f`, cor RGBA5551) e `DIRECT` (GIF para registradores — troca de textura). ⚠️ Escala do ponto fixo, origem das matrizes de transformação e o mapa completo VU-endereço → atributo ainda precisam ser confirmados renderizando (M2).
- **Colisão:** nenhuma seção dedicada encontrada → provavelmente embutida no `ngp` dos níveis ❌.

### 4.3 Texturas (`tex`, `LB*.TEX`, `rtx`) — 🟡
- Cabeçalho: `u32 nGrupos`, `u32 0xf`, depois pares `(u32 contagem/flags, u32 bytes)` — parece agrupar texturas por tamanho de bloco (`0x800`, `0x1000`, `0x2000`, `0x4000`, `0x8000`, `0x10000`…).
- Provavelmente dados prontos para upload no GS (PSMT8/PSMT4 + CLUT, possivelmente **swizzled**). As trocas de textura no `ngp` vêm via `DIRECT` (TEX0) — o cruzamento TEX0 → bloco de `tex` é o caminho para ligar material a imagem.
- `LB*.TEX` (telas de loading): 132.592 bytes = cabeçalho + provável 512×256 8bpp + CLUT 256×4.

### 4.4 Áudio
| Formato | Status | Conversão |
|---|---|---|
| `.VAG` (`VAGp`, mono 44,1 kHz) | ✅ | `ffmpeg` direto (`adpcm_psx`) |
| `.VPK` (` KPV`, estéreo 44,1 kHz) | ✅ | `ffmpeg` direto |
| `.BNK` (989snd `SBlk`) | 🟡 | ffmpeg não lê; vgmstream suporta bancos 989snd/SCREAM (avaliar) ou parser próprio (VAG crus dentro) |
| `.XFX` (`XFDX`) | ❌ | parâmetros de efeito/mixagem do 989snd |

### 4.5 Vídeo (`.PSS`) — ✅ (vídeo) / 🟡 (áudio)
- MPEG-PS com **MPEG-2 640×368, 30 fps, DAR 16:9** — o ffmpeg decodifica o vídeo direto.
- Áudio em **private stream 1 (`0xBD`) com cabeçalho `SShd`/`SSbd`** (ADPCM PS2 intercalado), que o ffmpeg não expõe. Solução: demux próprio do stream 0xBD → VAG intercalado → ffmpeg, ou vgmstream (suporta PSS).
- Volume: ~3,35 GB em 37 arquivos. Precisa de escolha de bitrate/resolução e/ou não publicar (§7).

### 4.6 Executável — 🟡
Mora só no ELF (alvo da Fase 4):
- física dos veículos (massa, aceleração, turbo, salto, giro), dano e armadura por carro;
- armas: dano, munição, velocidade, homing, **combos de botão das armas especiais e congelamento**;
- IA (uso de `PTS/GPS`), regras de pickups (`PKP`), respawn;
- regras dos modos (Story, Challenge, Deathmatch), `*bonus.cpp` por arena (eventos destrutíveis);
- **todos os textos** (menus, bios, legendas), unlocks (`gameunlocks.cpp`), save (`McPersist.cpp`).

## 5. Comportamentos "que o jogador sente" (lista para a Fase 4)
1. Direção/derrapagem, turbo, salto, giro de 180° e dano de colisão.
2. Armas básicas: metralhadora, mísseis (fire, homing, power, napalm, ricochet, remote, mine…) — dano, velocidade, homing.
3. Especial de cada carro e ataques de energia (congelar, mina, invisibilidade, escudo).
4. Pickups: tempo de respawn, quantidades, vida.
5. IA dos oponentes (seguir PTS, mirar, fugir).
6. Destrutíveis e eventos de cada arena (`*bonus.cpp`, `destruct.cpp`).
7. Câmera de perseguição.

## 6. Decisões de projeto propostas
- **Ferramentas offline em Python 3.12** (numpy + Pillow), como no spec. Instalado em 2026-10-10 (instalação de usuário, `%LOCALAPPDATA%\Programs\Python\Python312`).
- **Extração sem copiar a ISO inteira** (desvio consciente do spec §5.1): o disco tem só ~5,8 GB livres. `tools/iso9660.py` lê a ISO direto; os `.PSS` (3,35 GB) ficam só indexados no manifest com `offset` na ISO e serão convertidos lendo dela (`--include-video` copia se houver espaço).
- Coordenadas: a definir em M2 (provável mão esquerda, Y para cima, como a maioria das engines PS2).

## 7. Jurídico (ver §17 do spec)
- Nada de ISO, `source/` ou `artifacts/` no git (`.gitignore` já cobre).
- **Decisão do dono do projeto (2026-10-10): publicar o site jogável com os assets convertidos**, como o HnR fez. Riscos aceitos: takedown (DMCA) do repositório/Pages pela Sony. Mitigações: aviso de projeto de fã não oficial, licença MIT só para o código, não publicar a ISO/arquivos crus, e manter o pipeline reproduzível para republicar se preciso.
- Limite de ~1 GB do GitHub Pages: os vídeos precisam de recorte (ex.: só intro + finais em 480p) ou hospedagem separada — decidir em M11.

## 8. Escopo do MVP proposto
"Um carro, uma arena, deathmatch contra 1 IA":
1. **Arena:** `LVL/ARENA.BDD` (8,9 MB, tem PTS/GPS/PKP/SPT completos).
2. **Carro do jogador:** `CARS/AXEL.BDD` (menor modelo); oponente: `AICARS/SWEET.BDD`.
3. Geometria + texturas + colisão da arena; direção com regras provisórias; metralhadora + 1 míssil; pickups do `PKP`; IA seguindo `PTS`.
4. Música `VAG/` de fundo; sem FMVs, sem menus (entram em M10/M11).

**Riscos principais:** (a) texturas swizzled + ligação TEX0 → imagem; (b) colisão sem seção dedicada; (c) todo o gameplay depende de RE do ELF (sem scripts em disco).

## 9. M1 — Extração ✅ (2026-10-10)
- `python tools/extract.py` → `source/disc/` (368 arquivos, sem `.PSS`) + `source/game/<pasta>/<bdd>/<nome>.<tipo>` + `source/manifest.json`. Idempotente (2ª execução: 0 escritos), escrita atômica, conflito de caminho é erro, ISO e ELF hash-pinados.
- Contagens fixadas em `tools/test_formats.py`: 405 arquivos no disco (4.174.627.390 bytes), 106 BDDs, 419 seções (267.418.997 bytes): `ngp` 106, `ptr` 106, `tex` 104, `pts` 26, `pkp` 24, `gps` 19, `hli` 13, `fpt` 9, `spt` 7, `vpt` 4, `rtx` 1. `source/` ocupa 883 MB.
- Testes: `python -m unittest discover -s tools -p "test_*.py"` (13 testes: BDD sintético, ISO9660 sintética, path traversal, manifest real).

## 10. M2 — Primeiro modelo 🟡 (2026-10-10)
Detalhes em `docs/FORMATS.md`; log em `VALIDATION.md`.
- ✅ Texturas (`tex` + unswizzle por emulação da memória do GS), geometria VIF (pool + strips com bit ADC, sprites, feixes), relocação `ptr`.
- ✅ 74 carros convertidos para `public/assets/{cars,aicars}/*.json+.bin` sem erros; visualizador `npm run dev` → `/?car=axel&maxr=6`.
- ✅ Scene graph: pose base automática (LOD, estado de dano, slots de efeito, ossos exportados para animação); coordenadas Z-up confirmadas sem espelho. **M2 concluído** (pendências menores em `VALIDATION.md`).

## 11. M3 — Arenas ✅ (2026-10-10)
Todas as 26 arenas convertidas e visualizáveis (`/?lvl=<nome>`), 0 erros, 57–219 draw calls, câmera livre. Detalhes em `VALIDATION.md` e `docs/FORMATS.md`.

## 12. M4 — Colisão + dirigir ✅ (2026-10-11)
`play.html` sem parâmetros abre o **menu** (carro com prévia 3D, arena, nº de bots; catálogo em `src/catalog.ts`); `play.html?lvl=<arena>&car=<carro>&bots=N` vai direto para a partida (Esc volta ao menu) — física arcade provisória, BVH, câmera de perseguição, teclado + gamepad. Detalhes em `VALIDATION.md`.

## 13. Próximo marco (M5/M6 — regras reais e armas)
Recuperar do ELF (Ghidra + Emotion Engine Reloaded) as constantes de física/dano e a tabela de armas; animar rodas/ossos com as trilhas `0x0B`.

### (registro do plano original do M4)
Malha de colisão (BVH com three-mesh-bvh sobre a geometria visível da arena, já que a grade `0x0C` ainda não está decodificada) + um carro com física provisória (`*_RULES` marcadas como escolha do host até a Fase 4/Ghidra). Critério: dirigir pela arena sem atravessar o chão/paredes.
