// Catálogo do menu. Nomes dos carros: tabela nativa (rules/vehicles.json, ELF 0x2ba990).
// ⚠️ ESCOLHA DO HOST: nomes de exibição das arenas, agrupamento e quais entram no menu.
// Só as arenas de deathmatch (pedido do usuário, 2026-10-11): as fases da história e de Harbor City
// foram removidas do menu e dos assets publicados (recriáveis com tools/convert_model.py --dir lvl).
// Fora do menu: chefes (dark1/dark2/edboss).

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
  { title: 'Head-On', cars: ['axel', 'sweet', 'cop', 'crim', 'grass', 'hamr', 'hearse', 'mrgrim', 'mrslam', 'rkill', 'spectre', 'thump', 'twist', 'wart', 'edatv'] },
  { title: 'Harbor City', cars: ['hc_axel', 'hc_sweet', 'hc_derby', 'hc_grim', 'hc_hears', 'hc_preac', 'hc_rkill', 'hc_rock', 'hc_semi', 'hc_stock', 'hc_suv', 'hc_taxi', 'hc_tank', 'hc_tow', 'hc_vette'] },
];

/** Nome legível a partir do nome nativo (HO_Axel -> Axel). */
export const displayName = (native: string | undefined, id: string) => (native ?? id).replace(/^(HO|HC)_/, '');
