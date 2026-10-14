# Pendentes — o que falta para ficar fiel ao original

> Meta: o mais próximo possível de Twisted Metal: Head-On (PS2). Tudo que for visto faltando entra aqui,
> com a evidência que já existe. Itens resolvidos saem daqui e vão para `VALIDATION.md`.
> Prioridade: **A** = o jogador nota na hora · **B** = nota jogando · **C** = detalhe/acabamento.

## Carros

> Carros do Harbor City fora do menu e dos assets (pedido do usuário, 2026-10-14): itens só de HC ficam em espera.

Feito em 2026-10-12 (ver `VALIDATION.md`): destroços dos estados de dano, peças HC por golpe, projétil no lançador
(e fim das armas de reserva), seletores (turbo, lanternas/freio), sombra, nó `0x18`, piloto (esterço do Grimm,
ociosa, no ar), hc_suv e ATV conferidos. Modelo do projétil por tipo: feito em 2026-10-13 (nós do GLOBALS por categoria). Casca de fogo: feita
em 2026-10-13 (combo de energia Dir., Dir., Baixo, Baixo — `FUN_0012d1b8` liga o bit 2).

| Pri | Pendência | O que já se sabe |
|---|---|---|
| A | Vida máxima por veículo | `FUN_00125b80` (tabela em `gp−0x7e14…`, ver NATIVE "Arenas…"): de 50 (0x73) a 220 (0x86), por id de veículo; ×1,15 com o bit 0x40 de `+0x63f0`. O port usa 100 para todos |
| B | Peças HC: acerto pela geometria | ⚠️ host escolhe a peça de caixa mais próxima do ponto do golpe; o jogo usa o id do objeto da colisão (`DAT_0041b71c`, nó `0x14 +0x0E`). Batidas (`FUN_00171fc8`, fator |v|·20) não danificam peças |
| C | Destroços: contato e fumaça | ⚠️ contato simplificado (plano do chão, coeficientes `+0x10`/`+0x14` interpretados como atrito/restituição); rastro de fumaça (50 %, `FUN_001738e0`) e chama do turbo (emissor 0x2c via `FUN_00247580`) ainda não ligados — o sistema de partículas já existe (`src/particles.ts`), falta só chamar |
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
| B | Ataque de ambiente (arma tipo 8) e arma especial (tipo 1) nos suportes | tipo 8 toca o clipe 0x12 e fecha 0x12/0x13/0x14 (`FUN_0014cf78`/`FUN_0014cfd8`); o especial zera clipes (`FUN_001dd1c0`) e usa 0x1A..0x1F (Axel 0x1a/0x1c/0x1d/0x1e, Grimm 0x1b, Sweet 0x1b…); a lógica do especial e do ambiente existe desde 2026-10-13, os clipes não |
| C | Tipo de arma 5 (só nos HC) | aparece em `FUN_00148e00` nos carros HC; nenhum pickup gera tipo 5 em `FUN_00120ba0` |
| C | Pose de repouso e esterço como o jogo | repouso = `FUN_001fa2f8` (só 0..11, 0x18, 0x19, 0x0C em t=0; o host amostra todos os clipes); esterço: tempo = ângulo/π + 0,5 (`FUN_00127608`), o host usa 0,5 + 0,5·esterço normalizado |
| C | Suportes começam "abertos" para as armas 3, 4 e 6 | `FUN_00148e00` grava estado 1 nesses suportes no início; efeito não verificado |

## Arenas

Feito em 2026-10-14 (ver `VALIDATION.md` e NATIVE "Arenas: fogo, batida, abertura…"): fogo nos destrutíveis
(emissores 0x41, escurecimento, `W_FIRE_BURN_L`, queda), dano nativo de batida e explosão, poeira/folhas/brasas e som
da queda, luzes dos postes somem com eles, materiais animados nos destrutíveis, auto-play dos clipes (água das DM,
telões, hélices), peças móveis pelos ossos dos objetos, estado pós-abertura da Arena (a cena foi retirada a pedido,
2026-10-14), escala dos nós `0x12`, névoa por fase (fórmula do GS) e spawns nativos (nós PTS 0x08, 800/300 pés, virado
para o vizinho).

| Pri | Pendência | O que já se sabe |
|---|---|---|
| B | Carros de figuração (fodder) da Arena | Gerentes `0x3493d0` (grupos 200..0xf2: 0xe9 ×2 e 0xea, destrutível 0x12d) e `0x351620` (0x136..0x14c: 0x139..0x13e, destrutíveis 0x12e/0x12f); só com < 2 jogadores; IA de trânsito (`FUN_0017f9b8`, `FUN_00182078`, grafo `0x349800`), alvo da trava com vida `+0x138`/`+0x150` (`FUN_00147cf0`). Hoje as malhas ficam paradas no lugar do arquivo |
| B | Ator do destrutível `0x3f8` (Coliseu e Grécia DM) | Gerente `0x358040` (`FUN_0019cd88`/`FUN_0019cf50`): nasce num ponto de caminho (nós 0x3f6/0x3f7/0x3f9) 500 pés acima, vida restaurada; movimento não lido |
| B | Objetos clonados `0x1130`/`0x1132` (gerente `0x37c230`) | `FUN_001df928`: clona os objetos nos pontos 0x1131/0x1133 e controla os clipes 0/1/2 por código; cruz cinza no radar a < 900 pés (`FUN_00137968`). Função no jogo não identificada; hoje só o original aparece (0x1132 com auto-play) |
| B | Quem dispara os roteiros `0xDCA` | Castelo DM (0x1451..0x1453, portões) e Grécia DM (0x1464/0x1465, 0xdc8/0xdc9): `FUN_00115348` (vtable `0x2d5ea8`) toca os clipes ao receber mensagem; o remetente não foi achado. Os objetos ficam no quadro 0 (já no lugar certo pelo esqueleto) |
| B | Objetos `0x1F` com malha "já no mundo" | 2026-10-14: no Coliseu DM os prédios formam um anel e o `0x1F` (giro em z + translação) leva cada um à posição de outro; a grade de setores (`0x0C`, 38×17 × 100 pés) não aponta para eles. Na Arena, um `0x03` com z = −2001,5 sob o grupo de categoria 7 (`DAT_002f466c = 2`) cobre geometria já no mundo. Falta o caminho de desenho que explica (⚠️ heurística por malha continua) |
| B | Slots de efeito dos níveis (nós `0x05`) não são desenhados | `doc.effects` dos níveis (Arena 20/10 filhos, Coliseu DM ~140 pares) não entram na cena; o código que escolhe o filho não foi lido |
| C | Fundo onde nada é desenhado (Arena, Tóquio DM) | ⚠️ host usa a cor da névoa da fase; a limpeza da tela do jogo não foi achada |
| C | Luzes direcionais por fase | `FUN_001a8540`: 3 luzes (cor + 2 ângulos) por `DAT_002f4900` (`FUN_0024d0e0`, `FUN_00244f58`, ambiente `FUN_002346c8`) — iluminam carros e partículas; não aplicadas |
| C | Destrutíveis: tombamento | ⚠️ contato do corpo tombado simplificado (base do tronco + topo, folga de enterramento); na queda pelo fogo o empurrão vai no topo (o corpo do jogo tomba com 3 pés/s na origem, centro de massa `FUN_00250658(0,0,6)`); batida em poste não empurra o carro (`FUN_00136048`, normal × 60) |
| C | Explosão nos destrutíveis: consulta | ⚠️ `FUN_0022c5a8` consulta a forma de colisão a raio/2; o port usa a esfera do objeto |
| C | Peças móveis: colisão | A colisão continua na pose do arquivo (o jogo move os sólidos `0x1A` com o osso) |
| C | Escala `0x12` sob o grupo de categoria 7 | As peças 0x40d7b0.. da Arena (escala 0,918 + translação que compensa) ficam sem a escala porque o caminho é descartado pela heurística acima |
| C | Projeção de textura dos modos 1–4 da malha | `(flags >> 1) & 7` (`FUN_0024b170`): 1 = coordenadas da tela (reflexo dos carros), 2 = `FUN_00267400` matriz de projeção pela direção da câmera × velocidade `+0x08` (água/lava/mar das DM — o UV "escorrega" ao girar a câmera), 3/4 = `FUN_00267a08`. O port usa só o UV da malha + os canais; falta o microcódigo da VU (programas em `0x30e0..0x30ec` do scratchpad) |
| C | Objetivo/placar das categorias `0x11f8..0x12c0` | Egito DM 0x11f9..0x11fc, Paris DM 0x120c: ao morrer avisam `FUN_00113b28` (`0x2f5c80`, grafo/objetivos) |
| C | Asylum, Impound e fases da história (removidas a pedido) | Recriáveis com `tools/convert_model.py --dir lvl` |

## Armas e pickups

Feito em 2026-10-13 (ver `VALIDATION.md` e NATIVE "Armas"/"Armas especiais"): tabela nativa dos 57 projéteis
(dano, velocidade, vida, aceleração, perseguição, cone de trava, oscilação, área), voo por tique, metralhadora com
calor, Swarmer carregado, Napalm/Remote com 2º toque, Ricochete ×3, pickups (+2, compartimento 30, vida +30/+100,
renascimento 30–45 s), carga do especial, especiais dos 15 carros Head-On + ATV, ícones e modelos pelos nós nativos.
Feito em 2026-10-13 (2ª rodada, NATIVE "Especiais corpo a corpo", "Ataques de energia", "Especiais do Harbor City",
"Trava", "Luzes dinâmicas"): Twister/Mr. Slam/Hammerhead/Grasshopper pelo código, congelar/mina/onda/casca de fogo
com os combos e a energia, trava sem reserva ponderada, mira de 7,5° da metralhadora, 5 especiais HC, luz dos projéteis,
Napalm sem gravidade segurando o botão. Upgrade/"carregados": só por trapaça no Head-On (ver NATIVE) — não é pendência
do deathmatch.
Feito em 2026-10-13 (3ª rodada, NATIVE "Partículas", "Controle e combos", "Energia da IA", "Golpe por tipo e fogo no
carro", "Especiais do Harbor City", "Pickups: brilho"): sistema de partículas do jogo (84 emissores, 21 texturas do
RESIDENT.BDD, efeitos compostos) nas explosões, balas, rastros, ataque de ambiente e fogo; energia nos bots e tiro para
trás; míssil de energia (bit 0x40); mapeamento dos combos confirmado; carros pegando fogo; clipes 0x18/0x19 do congelado e
da casca; descongelar como o jogo; impulsos do golpe por tipo; Derby, canhão do Roadkill/Manslaughter, raio do Spectre
HC, anel do Semi (e disparo ao bater), Preacher, Taxi, Tow; captura do Twister; luz do Hammerhead; trava em objetos do
cenário; auras dos pickups = malha do próprio ícone.

| Pri | Pendência | O que já se sabe |
|---|---|---|
| C | Partículas: desenho e casos à parte | ⚠️ host: o desenho (microcódigo da VU1) — tipo 6 como sprite de lado = tamanho, tipo 3 como risco do último tique, tipo 1 (fitas em spline, `FUN_00243140`) como sprites ao longo do rastro com largura tamanho + grow[1]·idade; textura do slot 1 (id 1) gerada; luz com raio 8·intensidade; força entre vizinhas (T2 flag 0x20) e o emissor 0x28 (`FUN_0021e070`) não portados. Não ligados ainda: chama do turbo (`FUN_001238c8`, emissor 0x2c, tabela `0x2b3fe0`), fogo dos destrutíveis (`FUN_00172bb0`), fumaça dos destroços (`FUN_001738e0`), explosão da morte (o host usa a do Power) e os especiais sem partícula própria (onda do Axel, choque do Cop: ainda o clarão-prefab) |
| C | Especiais do Harbor City: detalhes | ⚠️ tempos de clipe: Derby preso 60 tiques (fim do clipe do objeto), canhão ergue em 30 tiques (clipe 0x1a até 0,95), raio do Spectre HC sem esperar o clipe; o objeto do Derby (`FUN_0021abf0(0x356108)`) é desenhado só como rastro 0x16; ângulo +0x80 do Taxi (U(−25°, −35°)) ignorado; dano do Semi ao bater (+0x68/+0x6c da classe) e a condição `FUN_001d87b8` do Tow não lidos; mira de luneta do canhão (+0xb8 = 0,125) sem efeito na câmera |
| C | Energia da IA: globais | 🟡 `DAT_003277dc`/`e0` (struct `0x327798` +0x44/+0x48) tratados como rivais abatidos/total; quando lento sem alvo perto o jogo reposiciona o bot no grafo (não portado) |
| C | Tiro para trás: velocidade | ⚠️ de ré o projétil parte parado (o jogo passa a velocidade do carro em `FUN_00147ec8` — sentido não confirmado) |
| C | Congelado: chefes | Dark1/Dark2 tocam o clipe 0x21 e não congelam (`FUN_0011f280` caso 0xe) — chefes fora do menu |
| C | Especiais corpo a corpo: física | ⚠️ impulsos aplicados direto na velocidade (o jogo usa o ponto de aplicação, `FUN_00136128`/`FUN_001360b8`, com torque); Hammerhead 14 pés acima da origem do alvo (semântica da origem 🟡). Upgrade do Slam/Hammerhead só por trapaça (não se aplica ao deathmatch) |
| C | Luz dinâmica | ⚠️ queda (1 − d/r)² e escala 255 = 1,0 do host — o termo `+0x2c = r²/(+0x34·16)` e o microcódigo não foram lidos |
| C | Fogo no carro: água | `FUN_0011e3d0` apaga o fogo com a superfície das rodas tipo 2 (`FUN_001d0c90`): o port não lê o tipo de superfície |
| C | Ataques de ambiente das fases que o port não tem | `FUN_0014d040` → COLISEUM `FUN_001cab28` (0x3730e0), EGYPT `FUN_0017c5e8` (0x348d40), FWAY `FUN_0018cf60` (0x355960), PARIS `FUN_001b9d50` (0x35a5f0; "Destroy Eiffel Tower First" antes da torre cair), RUSSIA `FUN_001cfc78` (0x373b20, espera 240), GREECE `FUN_00194618` (0x3572c0); CASTLE e as DM: "Unavailable". Só faz sentido se as fases voltarem ao port |
| C | Ataque de ambiente da ARENA: bocais | ⚠️ os raios saem de cima do aparelho e ignoram tudo a 6 pés dos bocais (com a malha visual como colisão explodiriam no próprio aparelho, objetos 836–850); bocal do 7º carro em diante lê memória fora da lista (host usa o ponto do clarão) |
| C | Colisão dos projéteis | O jogo varre geometria própria (`FUN_00226c08`): nós 9 = sólidos convexos (u16 n em +4, id em +8, planos (n, d) em +0x20, teste `FUN_0022b758`) e nós 0x1A = malhas de colisão (ponteiros em +0x0c, `FUN_0022a500`). ⚠️ host: malha visual sem as peças que não escrevem profundidade; falta converter essa geometria |
| C | Detalhes do voo | ⚠️ colisão por esfera do carro (o jogo varre a malha de colisão, `FUN_00200ac8`); Napalm segurando o botão para de subir no ápice (semântica do `+0x08` 🟡) e a retícula no chão (CS `0x38a708`) não é desenhada; oscilação do Swarmer aproximada |
| C | Modelos de projétil: estado do GS | ⚠️ host (2026-10-14): as malhas de projétil do GLOBALS **sem** pacote de estado do GS (corpos dos mísseis) são desenhadas opacas (as que têm pacote — bala 0xfa0/0xfb3, brilhos — já seguem a mistura dele) com recorte no alfa 0 (antes saíam semitransparentes/aditivos pelo atlas `5574c` "blend" e pelo bit 15 das flags). Evidência: os mesmos mísseis embutidos no Mr. Grimm (seletor 0x1b1) são opacos. Falta ler o estado padrão do GS no desenho de objetos (`FUN_0022ff38`) e se a luz do próprio projétil (+0x5c) ilumina a malha dele (hoje não ilumina) |
| C | Marcadores 0x00F0 sem osso | Feito em 2026-10-14: ossos sem malha que levam aos marcadores entram no esqueleto (Ricochet do Roadkill/Wart/Spectre etc.). Ainda sem osso: id 11 (HC: hc_derby, hc_hears, hc_rkill, hc_vette — slot 12, tipo não usado pelo port) e a 2ª cópia do id 10 do hc_suv (slot 11, não é o Remote: o Remote é o id 15, `FUN_00124288`). Napalm no suporte: feito em 2026-10-14 (modelo próprio 0x1002) |
| C | Especiais: detalhes que faltam | Feito em 2026-10-14: clipes de seleção e disparo (`src/game/specialclips.ts`), tiro grande do ATV nos bots, Cousin Eddy e Dark Tooth jogáveis no menu (chefes fora; só documentados em NATIVE). ⚠️ Falta: versões carregadas (0x1d/0x1e do Axel, 0x1e do Grimm), fator por distância `+0x58` do 0x23 do ATV; Dark Tooth: o relâmpago (FUN_0021e1e8, emissor 0x28) — o host usa o feixe 0x1e azulado e não foi confirmado na QA que aparece —, a mira exata de FUN_00170c30 e o giro do arco sem alvo; menu: ícone/cartão/biografia do chefe para as versões jogáveis; hc_rock/hc_rkill: 2ª instância de 0x1a (+0x76) |
| C | Pickups: giro | ⚠️ o port gira e balança os ícones; no Head-On `FUN_001bcf70` não gira (só no Harbor City, 2°/tique) — falta ver se os ícones têm clipe próprio |

## Jogo, interface e som

Feito em 2026-10-13 (ver `VALIDATION.md`): HUD do jogo (peças 3D do GLOBALS + fonte do RESIDENT), menu com a arte
do SHELL, IA com as tabelas do ELF, direção pela tabela por carro (0x2b8ab0) e sons pelos nomes montados no código.

| Pri | Pendência | O que já se sabe |
|---|---|---|
| B | Navegação dos bots pelo grafo PTS/GPS ("ptool", `FUN_001c0398`) | ⚠️ host mira direto no objetivo e dá ré quando atola; com o volante nativo os bots batem mais nas paredes (633 contatos/45 s × 191 antes). Modos +0x280 (1..5: `FUN_00104b08`, `FUN_001044d8`, `FUN_001045f8`, `FUN_001049a8`, `FUN_0010b500`) não portados |
| B | Escolha do alvo dos bots | ⚠️ regra do jogador (`FUN_00102f50`); `FUN_001c27c0` só visto no caso de 2 humanos |
| B | Arma especial na IA | o tipo 1 tem peso 0,5 nas tabelas e entra na escolha desde 2026-10-13; `FUN_00107450` escolhe o especial de longe. (O tipo 8, ambiente, tem peso 0 em todas as tabelas: bot nunca usa — fiel) |
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
