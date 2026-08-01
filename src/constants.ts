import { GameOptions } from './types';

export const MAX_NUM_PLAYERS_PER_ROOM = 10;
export const DEFAULT_ROUND_TIME = 20;
export const ALLOWED_ROUND_TIMES = [20, 25, 30, 35, 40] as const;
export const MIN_IMPOSTOR_GUESSES = 1;
export const MAX_IMPOSTOR_GUESSES = 3;
export const DEFAULT_IMPOSTOR_GUESSES = 3;
export const GAME_MODES = ['CLASSIC', 'CUSTOM_WORD', 'HOT_WORD'] as const;
export const DEFAULT_GAME_MODE = 'CLASSIC';
// Options a mode takes over: while it is selected the value is forced and the
// host cannot change it. Single source of truth for the lock, mirrored by the
// options modal in the client.
export const MODE_LOCKED_OPTIONS: Record<
    (typeof GAME_MODES)[number],
    Partial<GameOptions>
> = {
    CLASSIC: {},
    // The word is written by a player, so it could simply be handed to the impostor.
    CUSTOM_WORD: { impostorGuessEnabled: false },
    // Every round has a new word, so keeping the previous drawing makes no sense.
    HOT_WORD: { clearCanvasEachRound: true },
};
export const MIN_CUSTOM_WORD_LENGTH = 2;
export const MAX_CUSTOM_WORD_LENGTH = 40;
// Translation key used as the category of a player-written word.
export const SPECIAL_CATEGORY = 'Special';
