# Pendentes — o que falta para ficar fiel ao original

> Meta: o mais próximo possível de Twisted Metal: Head-On (PS2). Tudo que for visto faltando entra aqui,
> com a evidência que já existe. Itens resolvidos saem daqui e vão para `VALIDATION.md`.
> Prioridade: **A** = o jogador nota na hora · **B** = nota jogando · **C** = detalhe/acabamento.

## Carros

| Pri | Pendência | O que já se sabe |
|---|---|---|
| A | Animação de dano (estados `0x13`: intacto → amassado → destruído) | Nós `0x13` com limiares `0x7FFF/0x3FFF/0x28F/0` já decodificados; o runtime sempre usa o intacto |
| B | Escala/tamanho e orientação dos modelos de arma montados | Pontos `0x00F8` corretos; tamanho (2,8) e orientação (eixo longo à frente) são escolha do host. Modelos próprios do Axel/Thumper/hc_stock (nós `0x12`, `effects['code:weapon']`) não usados |
| B | Sirene/luzes giratórias e faróis (slots `0x05`, sprites aditivos) | Exportados em `effects`; não ligados |
| A | **ATV (edatv) sem chassi** | O nó `0x13` 0x13980 tem 2 entradas: a 1ª (0xe090, limiar 0x28f) só traz piloto, rodas e guidão; o chassi (0xe0c0, 734 vért.) e o corpo do piloto (0x10fc0) só aparecem na 2ª (0x13950). Falta saber qual entrada o jogo usa (byte em `nó 0x14 + 0x0C`, gravado pelo código) ou se o ATV desenha as duas |
| B | Nó `0x18` (escala + translação ÷ escala, FUN_0021b3c0) ignorado | ATV 0xc4a0: escala 0,2 sobre 0xb7e0 (provável bolha de escudo/efeito). Conferir em outros carros |
| B | Esterço do Mr. Grimm | ⚠️ análise feita com o leitor de clipes antigo (trilhas trocadas): refazer. Clipes 8..11 = esterço por roda no código |
| C | Animação ociosa dos personagens | Canais sem papel ficam na pose de bind (`rig.rest`, ⚠️ host); o clipe que o jogo toca parado não foi achado |
| B | Peças traseiras penduradas do hc_suv | Sem regra segura ainda |
| C | Sombra do carro no chão | Malha de sombra existe nos carros (slot de efeito) |
| C | Clarão/fumaça de turbo, fumaça de dano, fogo | Slots `0x05`; texturas identificáveis |
| C | Animações do personagem (Sweet Tooth cabeça, Mr. Grimm, motoristas) | ⚠️ "sem trilhas" foi concluído com o leitor antigo: refazer com `rig.clips` corrigido (pilotos usam 0x22..0x25, `FUN_00127060`) |

## Descoberta de RE (2026-10-12): canais de animação dos carros

`FUN_0022c678` (chamada pelo percurso de desenho `FUN_0022cd58` no caso `0x0D`) monta a matriz de cada osso:
translação `+0x04/+0x08/+0x0C`, rotação `+0x10/+0x14/+0x18` (Euler → `FUN_00236e50`); cada componente é
constante **ou** `canal[índice]` do carro (rotação = −canal), conforme os bits 32..37 do u64 em `+0x18`;
bits 48..62 = canal de **visibilidade** (bit 63 liga). Os canais são uma tabela de floats por carro
(`objeto+4`), numerada na ordem da árvore. Pendências que isso destrava:

| Pri | Pendência | Base |
|---|---|---|
| ✅ | Valores exatos dos canais ao disparar | feito 2026-10-12: são os clipes 0x0D/0x0E/0x15/0x16/0x17 do carro, tocados pelos suportes de arma (`FUN_00148978`); o leitor antigo trocava as trilhas de clipe (ver `VALIDATION.md`) |
| ✅ | Visibilidade dos lançadores + deslizar para fora (canais `vis` e `tx`) | feito 2026-10-12; desde a correção do leitor, vêm dos próprios clipes dos suportes (o deslizamento de 3/s do host saiu) |
| ✅ | Rodas girando/esterçando e suspensão | feito 2026-10-12: papel pela categoria do clipe (0..3 giro, 4..7 suspensão, 8..11 esterço — `FUN_00127060`); com o leitor corrigido todas as rodas têm clipe (`rig.direct` vazio) |
| B | Partes móveis (cabeça do Sweet Tooth, sirene, antenas, escapamentos) | demais canais |
| ✅ | Substituir a abertura "100°" do host pelos valores do jogo | feito 2026-10-12 (velocidade 2 nos carros Head-On, 1 nos HC; um suporte por vez) |
| B | Ataque de ambiente (arma tipo 8) e arma especial (tipo 1) nos suportes | tipo 8 toca o clipe 0x12 e fecha 0x12/0x13/0x14 (`FUN_0014cf78`/`FUN_0014cfd8`); o especial zera clipes (`FUN_001dd1c0`) e usa 0x1A..0x1F; nada disso existe no runtime |
| B | Pontos `0x00F8` usam o tipo de arma do jogo, não o id do pickup | `WEAPON_SLOT` em `src/game.ts` ainda usa ids de pickup (Fire 1, Swarmer 3…); o jogo indexa por tipo (Fire 2, Homing 3, Napalm 4, Power 6, Ricochet 7, Swarmer 9, Remote 10). Só afeta as armas montadas de reserva (carros sem suporte); conferir pontos 8/9/12/13 |
| C | Tipo de arma 5 (só nos HC) | aparece em `FUN_00148e00` nos carros HC; nenhum pickup gera tipo 5 em `FUN_00120ba0` |
| C | Pose de repouso e esterço como o jogo | repouso = `FUN_001fa2f8` (só 0..11, 0x18, 0x19, 0x0C em t=0; o host amostra todos os clipes); esterço: tempo = ângulo/π + 0,5 (`FUN_00127608`), o host usa 0,5 + 0,5·esterço normalizado |
| C | Suportes começam "abertos" para as armas 3, 4 e 6 | `FUN_00148e00` grava estado 1 nesses suportes no início; efeito não verificado |

## Arenas

| Pri | Pendência | O que já se sabe |
|---|---|---|
| A | **Objetos destrutíveis** (tiro quebra/derruba; troca de modelo) | 514 nós `0x13` nas 7 arenas; o jogo os chama de "interactive" (strings no ELF) |
| A | Animação de texturas (fogo, letreiros, água, telões) | Controladores `0x1A` (454 na Arena, 300 em Paris): `+0x08/+0x0C` *dados, `+0x34` *nó animado; formato dos quadros a decodificar |
| B | Peças que se movem (hélices, portões, bandeiras, elevadores) | Trilhas `0x0B` nos níveis |
| A | **Rotação dos objetos posicionados (nós `0x1F`)** | Quase todos os `0x1F` das arenas têm rotação em s16 `+0x08/+0x0A/+0x0C` (Coliseu DM: 48/48, ex. −90°, 35,8°, 144°) e nº de filhos em `+0x0E` (um com 12). Hoje os níveis só aplicam a translação e o 1º filho: props saem com a orientação errada e filhos somem. A regra já está em `tools/rig.py: fixed_of` (carros); falta levar aos níveis (`InstanceDef` com matriz) e reconverter as 7 arenas |
| B | Spawns, regras e eventos próprios de cada arena (DM) | Spawns atuais = nós PTS; os reais moram no ELF |
| B | Sem céu no Estádio e em Tóquio DM | Os arquivos não trazem cúpula; ver se o ELF define cor de fundo/névoa |
| C | Névoa/fundo por arena, cor do céu | Pacote de estado do GS por grupo pode trazer FOG |
| C | Escala dos nós `0x12` (aplicada como 1) | `+0x20..+0x28` escala |
| C | Asylum, Impound e fases da história (removidas a pedido) | Recriáveis com `tools/convert_model.py --dir lvl` |

## Armas e pickups

| Pri | Pendência | O que já se sabe |
|---|---|---|
| A | Dano, velocidade, munição, curva de cada arma | Escolha do host em `WEAPON_RULES`; procurar tabela no ELF |
| A | Arma especial de cada carro | Não implementada |
| B | Ícones de Machine Gun/Mega Gun/Environment Attack | Usam a placa amarela (objeto 20) — confirmar no original |
| B | Visual dos projéteis e explosões por arma | Hoje um míssil genérico (objeto 16) para todas |
| C | Cor das auras dos pickups | Escolhidas pela cor do modelo |

## Jogo, interface e som

| Pri | Pendência | O que já se sabe |
|---|---|---|
| A | HUD e menus com a arte original (fontes, molduras, radar) | `shell/ui` (13 MB de texturas) não convertido |
| B | IA dos bots fiel ao original | Escolha do host |
| B | Física de direção calibrada (massa, giro, vel. máx. por carro) | `+0x848/+0x854/+0x858` sem origem achada no ELF |
| B | Sons: mapeamento evento → nome, mixagem | Escolha do host; nomes vêm dos bancos |
| C | Vídeos (PSS) | Não convertidos |
| C | Otimização para publicar (texturas WebP, compressão) | Assets hoje 213 MB |
