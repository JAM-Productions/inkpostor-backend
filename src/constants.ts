import { GameMode, GameOptions, TurnOrderMode } from './types';

export const MAX_NUM_PLAYERS_PER_ROOM = 10;
export const DEFAULT_ROUND_TIME = 20;
export const ALLOWED_ROUND_TIMES = [20, 25, 30, 35, 40] as const;
export const MIN_IMPOSTOR_GUESSES = 1;
export const MAX_IMPOSTOR_GUESSES = 3;
export const DEFAULT_IMPOSTOR_GUESSES = 1;
export const MIN_IMPOSTORS = 1;
export const DEFAULT_IMPOSTOR_COUNT = 1;
export const GAME_MODES = [
    'CLASSIC',
    'CUSTOM_WORD',
    'HOT_WORD',
    'ORIGINAL',
    'ORIGINAL_CHAOS',
] as const;
export const DEFAULT_GAME_MODE = 'CLASSIC';

// Modes are combinations of a few traits rather than one-offs, so the rules key
// off these predicates instead of naming modes one by one — adding a mode then
// means listing it here, not hunting down every comparison.

// Players say their words out loud instead of drawing: the round runs
// ORDER_INFO -> VOTING and DRAWING is never reached.
const SPOKEN_GAME_MODES: GameMode[] = ['ORIGINAL', 'ORIGINAL_CHAOS'];
export function isSpokenMode(mode: GameMode): boolean {
    return SPOKEN_GAME_MODES.includes(mode);
}

// The secret word is written by the players, so the game opens on
// WORD_SELECTION and the word is never treated as a translation key.
const PLAYER_WORD_GAME_MODES: GameMode[] = ['CUSTOM_WORD', 'ORIGINAL_CHAOS'];
export function isPlayerWordMode(mode: GameMode): boolean {
    return PLAYER_WORD_GAME_MODES.includes(mode);
}
export const TURN_ORDER_MODES = [
    'RANDOM_STARTER',
    'FIXED_ORDER',
    'RANDOM_ORDER',
] as const;
export const DEFAULT_TURN_ORDER_MODE: TurnOrderMode = 'RANDOM_STARTER';

// The options a fresh room starts with. Also what every "back to default" rule
// below reads from, so the two cannot drift apart.
export const DEFAULT_GAME_OPTIONS: GameOptions = {
    roundTime: DEFAULT_ROUND_TIME,
    unlimitedInk: false,
    clearCanvasEachRound: true,
    playerColorsEnabled: true,
    impostorCount: DEFAULT_IMPOSTOR_COUNT,
    revealImpostorTeammates: true,
    impostorGuessEnabled: true,
    impostorGuessAttempts: DEFAULT_IMPOSTOR_GUESSES,
    impostorLosesWhenOutOfGuesses: false,
    hideHint: false,
    turnOrderMode: DEFAULT_TURN_ORDER_MODE,
    preventRepeatImpostors: true,
};

// The guessing sub-option means nothing while the feature itself is off, so
// wherever guessing is turned off it goes back to default rather than lingering
// as a setting the host cannot see.
const GUESS_SUB_OPTION_DEFAULTS: Partial<GameOptions> = {
    impostorLosesWhenOutOfGuesses:
        DEFAULT_GAME_OPTIONS.impostorLosesWhenOutOfGuesses,
};

// Options a mode takes over: while it is selected the value is forced and the
// host cannot change it. Single source of truth for the lock, mirrored by the
// options modal in the client.
//
// Nothing is drawn in a spoken mode, so every drawing option is forced to a
// neutral value instead of lingering as a setting the host cannot see.
const SPOKEN_MODE_LOCKS: Partial<GameOptions> = {
    roundTime: DEFAULT_ROUND_TIME,
    unlimitedInk: false,
    clearCanvasEachRound: true,
    playerColorsEnabled: false,
    impostorGuessEnabled: false,
    impostorGuessAttempts: DEFAULT_IMPOSTOR_GUESSES,
    ...GUESS_SUB_OPTION_DEFAULTS,
};

export const MODE_LOCKED_OPTIONS: Record<
    (typeof GAME_MODES)[number],
    Partial<GameOptions>
> = {
    CLASSIC: {},
    // The word is written by a player, so it could simply be handed to the impostor.
    CUSTOM_WORD: {
        impostorGuessEnabled: false,
        ...GUESS_SUB_OPTION_DEFAULTS,
    },
    // Every round has a new word, so keeping the previous drawing makes no sense.
    HOT_WORD: { clearCanvasEachRound: true },
    ORIGINAL: SPOKEN_MODE_LOCKS,
    ORIGINAL_CHAOS: SPOKEN_MODE_LOCKS,
};
export const MIN_CUSTOM_WORD_LENGTH = 2;
export const MAX_CUSTOM_WORD_LENGTH = 40;
// Translation key used as the category of a player-written word.
export const SPECIAL_CATEGORY = 'Special';
