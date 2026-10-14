// Catálogo do menu. Nomes dos carros: tabela nativa (rules/vehicles.json, ELF 0x2ba990).
// ⚠️ ESCOLHA DO HOST: nomes de exibição das arenas, agrupamento e quais entram no menu.
// Só as arenas de deathmatch (pedido do usuário, 2026-10-11): as fases da história e de Harbor City
// foram removidas do menu e dos assets publicados (recriáveis com tools/convert_model.py --dir lvl).
// Fora do menu: chefes (dark1/dark2/edboss) e a forma gigante do Dark Tooth (darkpla2). Entram as versões jogáveis
// (pedido do usuário, 2026-10-14): Cousin Eddy (edplayer, "Cousin Eddy P") e Dark Tooth (darkpla1, "Dark1 P").
// Carros do Harbor City removidos do menu e dos assets publicados (pedido do usuário, 2026-10-14); recriáveis com
// tools/convert_model.py hc_<nome> (--dir cars / aicars) e tools/convert_sfx.py.

export interface LevelEntry {
  id: string;
  name: string;
}

export const LEVEL_GROUPS: { title: string; levels: LevelEntry[] }[] = [
  {
    title: 'Deathmatch',
    levels: [
      { id: 'arena', name: 'Estádio' },
      { id: 'tokyodm', name: 'Tóquio (DM)' },
      { id: 'parisdm', name: 'Paris (DM)' },
      { id: 'egyptdm', name: 'Egito (DM)' },
      { id: 'greecedm', name: 'Grécia (DM)' },
      { id: 'colisdm', name: 'Coliseu (DM)' },
      { id: 'castledm', name: 'Transilvânia (DM)' },
    ],
  },
];

export const CAR_GROUPS: { title: string; cars: string[] }[] = [
  { title: 'Head-On', cars: ['axel', 'sweet', 'cop', 'crim', 'grass', 'hamr', 'hearse', 'mrgrim', 'mrslam', 'rkill', 'spectre', 'thump', 'twist', 'wart', 'edatv', 'edplayer', 'darkpla1'] },
];

/** Nome legível a partir do nome nativo (HO_Axel -> Axel). */
export const displayName = (native: string | undefined, id: string) => (native ?? id).replace(/^(HO|HC)_/, '');
