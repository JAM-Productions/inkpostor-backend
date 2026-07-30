export const MAX_NUM_PLAYERS_PER_ROOM = 10;
export const DEFAULT_ROUND_TIME = 20;
export const ALLOWED_ROUND_TIMES = [20, 25, 30, 35, 40] as const;
export const MIN_IMPOSTOR_GUESSES = 1;
export const MAX_IMPOSTOR_GUESSES = 3;
export const DEFAULT_IMPOSTOR_GUESSES = 3;
export const GAME_MODES = ['CLASSIC', 'CUSTOM_WORD'] as const;
export const DEFAULT_GAME_MODE = 'CLASSIC';
export const MIN_CUSTOM_WORD_LENGTH = 2;
export const MAX_CUSTOM_WORD_LENGTH = 40;
// Translation key used as the category of a player-written word.
export const SPECIAL_CATEGORY = 'Special';
