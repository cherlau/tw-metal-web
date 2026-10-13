# Pendentes — o que falta para ficar fiel ao original

> Meta: o mais próximo possível de Twisted Metal: Head-On (PS2). Tudo que for visto faltando entra aqui,
> com a evidência que já existe. Itens resolvidos saem daqui e vão para `VALIDATION.md`.
> Prioridade: **A** = o jogador nota na hora · **B** = nota jogando · **C** = detalhe/acabamento.

## Carros

Feito em 2026-10-12 (ver `VALIDATION.md`): destroços dos estados de dano, peças HC por golpe, projétil no lançador
(e fim das armas de reserva), seletores (turbo, lanternas/freio), sombra, nó `0x18`, piloto (esterço do Grimm,
ociosa, no ar), hc_suv e ATV conferidos. Modelo do projétil por tipo: feito em 2026-10-13 (nós do GLOBALS por categoria).

| Pri | Pendência | O que já se sabe |
|---|---|---|
| B | Casca de fogo do carro (seletor `0x43`, 180 tiques) | `FUN_00123010`: liga pelo bit 2 de controle `+0x1C`; o evento do jogador que liga esse bit não foi achado (a IA usa o bit 4). Hoje nunca acende |
| B | Peças HC: acerto pela geometria | ⚠️ host escolhe a peça de caixa mais próxima do ponto do golpe; o jogo usa o id do objeto da colisão (`DAT_0041b71c`, nó `0x14 +0x0E`). Batidas (`FUN_00171fc8`, fator |v|·20) não danificam peças |
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
| B | Ataque de ambiente (arma tipo 8) e arma especial (tipo 1) nos suportes | tipo 8 toca o clipe 0x12 e fecha 0x12/0x13/0x14 (`FUN_0014cf78`/`FUN_0014cfd8`); o especial zera clipes (`FUN_001dd1c0`) e usa 0x1A..0x1F (Axel 0x1a/0x1c/0x1d/0x1e, Grimm 0x1b, Sweet 0x1b…); a lógica do especial existe desde 2026-10-13, os clipes não |
| C | Pontos de disparo `0x00F8` (cat. `0x3E`) | O runtime ainda dispara de um ponto do host; o jogo usa essas posições por arma (registros com passo `0x70`) |
| C | Tipo de arma 5 (só nos HC) | aparece em `FUN_00148e00` nos carros HC; nenhum pickup gera tipo 5 em `FUN_00120ba0` |
| C | Pose de repouso e esterço como o jogo | repouso = `FUN_001fa2f8` (só 0..11, 0x18, 0x19, 0x0C em t=0; o host amostra todos os clipes); esterço: tempo = ângulo/π + 0,5 (`FUN_00127608`), o host usa 0,5 + 0,5·esterço normalizado |
| C | Suportes começam "abertos" para as armas 3, 4 e 6 | `FUN_00148e00` grava estado 1 nesses suportes no início; efeito não verificado |

## Arenas

| Pri | Pendência | O que já se sabe |
|---|---|---|
| B | Destrutíveis: fogo e categorias com gerente | Napalm em árvores não as quebra (fiel), mas o fogo (`FUN_00172bb0`) não é desenhado. Categorias `0x21`, `0x12d..0x12f`, `0xeb..0xf2`, `0x33fe..`, `0x3f8`, `0x11f8..0x12c0` têm comportamento extra (NATIVE "Destrutíveis das arenas") |
| B | Destrutíveis: dano de batida e área | ⚠️ batida = velocidade normal × 0,2 (`RAM_DAMAGE`); explosão com queda linear como nos carros; o jogo calcula no código de colisão/armas |
| C | Destrutíveis: tombamento e luzes | ⚠️ contato do corpo tombado simplificado (base do tronco + topo, folga de enterramento); sprites/fachos de postes destruídos continuam acesos; som de queda escolhido pelo host (`FUN_001e2348` usa a categoria) |
| A | Animação de texturas (fogo, letreiros, água, telões) | Controladores `0x1A` (454 na Arena, 300 em Paris): `+0x08/+0x0C` *dados, `+0x34` *nó animado; formato dos quadros a decodificar |
| B | Peças que se movem (hélices, portões, bandeiras, elevadores) | Trilhas `0x0B` nos níveis |
| B | Objetos `0x1F` com malha "já no mundo" | 2026-10-12: rotação e todos os filhos aplicados; malhas cujo centro já está perto do destino seguem sem transformação (heurística por malha, ⚠️ host). Aplicar sempre punha prédios em cima da muralha do Coliseu DM (`0x125c80`) — falta saber por que o jogo não os desloca (o grid de setores desenha outra cópia? outro caminho de desenho?). Ex.: a mesma malha em `0x141530` e `0x140020` |
| B | Spawns, regras e eventos próprios de cada arena (DM) | Spawns atuais = nós PTS; os reais moram no ELF |
| B | Sem céu no Estádio e em Tóquio DM | Os arquivos não trazem cúpula; ver se o ELF define cor de fundo/névoa |
| C | Névoa/fundo por arena, cor do céu | Pacote de estado do GS por grupo pode trazer FOG |
| C | Escala dos nós `0x12` (aplicada como 1) | `+0x20..+0x28` escala |
| C | Asylum, Impound e fases da história (removidas a pedido) | Recriáveis com `tools/convert_model.py --dir lvl` |

## Armas e pickups

Feito em 2026-10-13 (ver `VALIDATION.md` e NATIVE "Armas"/"Armas especiais"): tabela nativa dos 57 projéteis
(dano, velocidade, vida, aceleração, perseguição, cone de trava, oscilação, área), voo por tique, metralhadora com
calor, Swarmer carregado, Napalm/Remote com 2º toque, Ricochete ×3, pickups (+2, compartimento 30, vida +30/+100,
renascimento 30–45 s), carga do especial, especiais dos 15 carros Head-On + ATV, ícones e modelos pelos nós nativos.

| Pri | Pendência | O que já se sabe |
|---|---|---|
| A | Ataque de ambiente (pickup 9) | Dá munição, mas disparar só mostra "Env Weapon Unavailable": o tipo 8 não cria projétil (`FUN_00203b10` devolve −1); cada arena tem seu evento (`FUN_0014cf78`, categorias `0x3304..`, `0x33cc..`, `FUN_001cc758`, posições fixas em `FUN_002024a8` por `DAT_002f4900`) |
| B | Ataques de energia (congelar, minas, escudo) | Inventário `carro+0x51b4` (`FUN_0011d340`): tipo 0xd (mina, 9999 usos), 0x10 (`FUN_0014c4e8`, 100/10/50) e 0xe (congelar, proj. 0xe azul); custam a energia `carro+0x6898`; nada disso existe |
| B | Especiais corpo a corpo | ⚠️ Twister (giro), Mr. Slam (agarrar), Hammerhead (investida), Grasshopper (pulo) usam as constantes da init com semântica suposta (`src/game/specials.ts`, tipo `melee`); ler `FUN_001e4670`, `FUN_001b1330`, `FUN_00196b60`, `FUN_001927a8` |
| B | Especiais "carregados" e pickup Upgrade (10) | O 2º estado de cada especial (`obj+0x3c`: Axel por níveis, Sweet e Crimson em rajada, Roadkill + `0x18`, Thumper lança-chamas `0x21`, Warthog `0x26`/`0x27`) depende do Upgrade/"Special Weapon Upgrade" — não feito |
| B | Especiais do Harbor City | Só o tipo de projétil e a espera foram lidos (padrão de tiro ⚠️ 1 projétil); Derby, HC Hearse, HC Grimm, HC Roadkill/Manslaughter e HC Spectre sem especial (classes `FUN_001c2cf0`, `FUN_001c8ee8`, `FUN_001d06a8`, `FUN_001dcbd8`, `FUN_001e0c58` não lidas) |
| B | Partículas das armas | Emissor preso (`+0x6c`), rastro (`+0x70`) e explosão (`+0x74..`, escala `+0x84..`) são ids do sistema de partículas (`FUN_00247580`, `FUN_002470c0`); ⚠️ host: brilho na cor da luz, bola de fogo pequena no Napalm (sem malha no GLOBALS) e prefabs 36/29 na explosão |
| C | Luz dinâmica dos projéteis | `FUN_0024c350` com a cor da tabela; ⚠️ host desenha um sprite aditivo |
| C | Trava e mira automática | ⚠️ `FUN_00147700`/`FUN_00147cf0` aproximadas (mais perto no cone / escolha ponderada); a metralhadora do humano mira num cone de 7,5° em alguns carros (`FUN_0014ae38`) — não feito |
| C | Detalhes do voo | ⚠️ colisão por esfera do carro (o jogo varre a malha de colisão, `FUN_00200ac8`); Napalm segurando o botão voa sem gravidade (`+0x08`) e mostra a retícula no chão (CS `0x38a708`); oscilação do Swarmer aproximada; tipo `0x2a` (ricochete HC) |
| C | Cor das auras dos pickups | Escolhidas pela cor do modelo (o brilho do ícone no jogo não foi achado) |

## Jogo, interface e som

Feito em 2026-10-13 (ver `VALIDATION.md`): HUD do jogo (peças 3D do GLOBALS + fonte do RESIDENT), menu com a arte
do SHELL, IA com as tabelas do ELF, direção pela tabela por carro (0x2b8ab0) e sons pelos nomes montados no código.

| Pri | Pendência | O que já se sabe |
|---|---|---|
| B | Navegação dos bots pelo grafo PTS/GPS ("ptool", `FUN_001c0398`) | ⚠️ host mira direto no objetivo e dá ré quando atola; com o volante nativo os bots batem mais nas paredes (633 contatos/45 s × 191 antes). Modos +0x280 (1..5: `FUN_00104b08`, `FUN_001044d8`, `FUN_001045f8`, `FUN_001049a8`, `FUN_0010b500`) não portados |
| B | Escolha do alvo dos bots | ⚠️ regra do jogador (`FUN_00102f50`); `FUN_001c27c0` só visto no caso de 2 humanos |
| B | Arma especial e ataque de ambiente na IA | tipos 1 e 8 têm peso alto nas tabelas (0,5 no tipo 1) e ficam de fora até existir a arma especial; `FUN_00107450` escolhe o especial de longe |
| B | Corpo rígido original | ⚠️ o corpo segue a roda até µ·g (µ = 0,8 de `FUN_00175a58`); giro = esterço·60·fator de velocidade (o jogo usa o pneu, `FUN_00134698`). Campos +0x868/+0x86c (0,038/0,027) sem papel |
| B | Motor e faixas dos sons do carro | ⚠️ o jogo usa 1 voz com altura = vel./vmáx·511 (`FUN_00144250`) e mín./máx. do objeto de som do carro (campos [0x2b]/[0x2c], não achados); host mistura 3 laços com faixa 20–600 |
| B | Sons sem chamada por nome achada | Lançamento das armas (`W_FIREMISS_LNCH`…), `W_MGUN`, `W_EXPLO_SML/HUGE*`: tocados por índice/tabela; ⚠️ host. `V_LOWHEALTH_L` não aparece nos nomes convertidos (host usa `HEALTHBEEP`); superfície do chão (V_LAND_*/W_BUL_*/V_SKID_*) não lida |
| B | Telas do menu como o jogo (UiScript.cpp) | ⚠️ arranjo do host com a arte original; transições, mapa-múndi 3D das fases (raiz 0x2db60), modelos 3D da seleção (raízes 0x60870..) e sons de personagem do SHELL.BNK não usados |
| C | HUD: pivô das barras | Nó 0x18 aplicado como p·S + t (as barras encolhem para o meio); cor da vida pelos canais 5–7 aplicada pelo host |
| C | HUD: setas do radar, número no topo (vidas?), "%d pts Damage", carga do especial | `FUN_00137620` (setas, alvo com `*carro == 1`), vfunc 0x64 do modo, `FUN_0013a0b8`, `FUN_0013c070` |
| C | Altura da tela do HUD (224 linhas) | ⚠️ inferida pelo radar circular e pelo texto dentro das molduras; posição do "PLAYER DEAD, RESPAWN IN %d" é do host |
| C | Ícones 14/15 da seleção | lista põe o trailer antes do ATV; tabela de nomes diz ATV, CousinEddy |
| C | Vídeos (PSS) | Não convertidos |
| C | Otimização para publicar (texturas WebP, compressão) | Assets hoje 213 MB |
