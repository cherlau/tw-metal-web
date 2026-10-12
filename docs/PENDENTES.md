# Pendentes — o que falta para ficar fiel ao original

> Meta: o mais próximo possível de Twisted Metal: Head-On (PS2). Tudo que for visto faltando entra aqui,
> com a evidência que já existe. Itens resolvidos saem daqui e vão para `VALIDATION.md`.
> Prioridade: **A** = o jogador nota na hora · **B** = nota jogando · **C** = detalhe/acabamento.

## Carros

Feito em 2026-10-12 (ver `VALIDATION.md`): destroços dos estados de dano, peças HC por golpe, projétil no lançador
(e fim das armas de reserva), seletores (turbo, lanternas/freio), sombra, nó `0x18`, piloto (esterço do Grimm,
ociosa, no ar), hc_suv e ATV conferidos.

| Pri | Pendência | O que já se sabe |
|---|---|---|
| B | Casca de fogo do carro (seletor `0x43`, 180 tiques) | `FUN_00123010`: liga pelo bit 2 de controle `+0x1C`; o evento do jogador que liga esse bit não foi achado (a IA usa o bit 4). Hoje nunca acende |
| B | Peças HC: acerto pela geometria | ⚠️ host escolhe a peça de caixa mais próxima do ponto do golpe; o jogo usa o id do objeto da colisão (`DAT_0041b71c`, nó `0x14 +0x0E`). Batidas (`FUN_00171fc8`, fator |v|·20) não danificam peças |
| B | Modelo do projétil por tipo | Tabela `0x37cbf0+0xda24` (lida em `FUN_001fd4c8`/`FUN_00203c68`) é preenchida em runtime; ⚠️ host usa os objetos de ícone do GLOBALS (15–26, textura `5574c`). Napalm/Remote têm caminho próprio (`DAT_0038a7f4/8`) |
| C | Destroços: contato e fumaça | ⚠️ contato simplificado (plano do chão, coeficientes `+0x10`/`+0x14` interpretados como atrito/restituição); rastro de fumaça (50 %, `FUN_001738e0`) e partículas do turbo (`FUN_00247580`) não feitos |
| C | Sombra | ⚠️ host projeta a malha do seletor de cat. 0 no chão; o código que a liga não foi achado (cat. 0 não é registrada). O Axel do jogador não tem a malha (só a versão `aicars`) |
| C | Mistura dos clipes do piloto | ⚠️ interpolação a partir da pose congelada na troca (o jogo mistura duas instâncias, `FUN_00210b08`); sentido do esterço 0 = esquerda assumido como o eixo do controle |
| C | Duração da carcaça | Renascimento pelos modos de jogo (byte por jogador em `modo+0x244`, ver NATIVE "Renascimento"); o tempo ainda é o `respawnDelay` do host (3 s) |
| C | Nó `0x18`: translação | Aplicada como p·S + t; o jogo divide a translação acumulada pela escala (`FUN_0021b3c0`), semântica não fechada |
| C | Malhas sem textura | Herdam a última textura na ordem do percurso do conversor (instâncias de pose, dano e seletores em listas separadas: a ordem real pode diferir) |
| C | Seletor `0x53` (Mr. Grimm, sprite `9671c`) e `0x40` | `0x53` → `carro+0x6414`, uso não visto; `0x40` nunca liga no jogo (mantido apagado) |

## Descoberta de RE (2026-10-12): canais de animação dos carros

`FUN_0022c678` (chamada pelo percurso de desenho `FUN_0022cd58` no caso `0x0D`) monta a matriz de cada osso:
translação `+0x04/+0x08/+0x0C`, rotação `+0x10/+0x14/+0x18` (Euler → `FUN_00236e50`); cada componente é
constante **ou** `canal[índice]` do carro (rotação = −canal), conforme os bits 32..37 do u64 em `+0x18`;
bits 48..62 = canal de **visibilidade** (bit 63 liga). Os canais são uma tabela de floats por carro
(`objeto+4`), numerada na ordem da árvore. Pendências que isso destrava:

| Pri | Pendência | Base |
|---|---|---|
| B | Partes móveis (cabeça do Sweet Tooth, sirene, antenas, escapamentos) | demais canais |
| B | Ataque de ambiente (arma tipo 8) e arma especial (tipo 1) nos suportes | tipo 8 toca o clipe 0x12 e fecha 0x12/0x13/0x14 (`FUN_0014cf78`/`FUN_0014cfd8`); o especial zera clipes (`FUN_001dd1c0`) e usa 0x1A..0x1F; nada disso existe no runtime |
| C | Pontos de disparo `0x00F8` (cat. `0x3E`) | O runtime ainda dispara de um ponto do host; o jogo usa essas posições por arma (registros com passo `0x70`) |
| C | Tipo de arma 5 (só nos HC) | aparece em `FUN_00148e00` nos carros HC; nenhum pickup gera tipo 5 em `FUN_00120ba0` |
| C | Pose de repouso e esterço como o jogo | repouso = `FUN_001fa2f8` (só 0..11, 0x18, 0x19, 0x0C em t=0; o host amostra todos os clipes); esterço: tempo = ângulo/π + 0,5 (`FUN_00127608`), o host usa 0,5 + 0,5·esterço normalizado |
| C | Suportes começam "abertos" para as armas 3, 4 e 6 | `FUN_00148e00` grava estado 1 nesses suportes no início; efeito não verificado |

## Arenas

| Pri | Pendência | O que já se sabe |
|---|---|---|
| A | **Objetos destrutíveis** (tiro quebra/derruba; troca de modelo) | 514 nós `0x13` nas 7 arenas. RE feita (2026-10-12, `docs/NATIVE.md` "Estados de dano"): `FUN_00168aa8` cria um objeto por `0x13` (`FUN_00170f98`, `destruct.cpp`); vida máx. pela classe `+0x09` (1/20/60/100/300, ou u16 `+0x04`); golpes ≤ u16 `+0x06` não contam; golpe (`FUN_00171838`/`FUN_00171fc8`) → mesma escolha de entrada dos carros. Falta: conversor dos níveis exportar as entradas (`ngp.scene(damage_states=True)`, hoje só nos carros) e o runtime aplicar dano dos projéteis/colisão a esses objetos |
| A | Animação de texturas (fogo, letreiros, água, telões) | Controladores `0x1A` (454 na Arena, 300 em Paris): `+0x08/+0x0C` *dados, `+0x34` *nó animado; formato dos quadros a decodificar |
| B | Peças que se movem (hélices, portões, bandeiras, elevadores) | Trilhas `0x0B` nos níveis |
| B | Objetos `0x1F` com malha "já no mundo" | 2026-10-12: rotação e todos os filhos aplicados; malhas cujo centro já está perto do destino seguem sem transformação (heurística por malha, ⚠️ host). Aplicar sempre punha prédios em cima da muralha do Coliseu DM (`0x125c80`) — falta saber por que o jogo não os desloca (o grid de setores desenha outra cópia? outro caminho de desenho?). Ex.: a mesma malha em `0x141530` e `0x140020` |
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
