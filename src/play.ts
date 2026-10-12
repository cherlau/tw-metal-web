// Entrada de play.html: sem ?lvl= abre o menu; com parâmetros vai direto para a partida.
if (new URLSearchParams(location.search).has('lvl')) void import('./game');
else void import('./menu');
