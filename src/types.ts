export interface UserPayload {
    userId: string;
    name: string;
}

declare module 'socket.io' {
    interface Socket {
        user: UserPayload;
    }
}

export type GamePhase =
    | 'LOBBY'
    | 'WORD_SELECTION'
    | 'ROLE_REVEAL'
    | 'WORD_REVEAL'
    | 'ORDER_INFO'
    | 'DRAWING'
    | 'VOTING'
    | 'IMPOSTOR_GUESS'
    | 'RESULTS';

// CLASSIC: the secret word is drawn from the built-in word list.
// CUSTOM_WORD: every player writes a word and one of them becomes the secret.
// HOT_WORD: like CLASSIC, but a new word is drawn on every round.
// ORIGINAL: the in-person party game — players say words out loud instead of
// drawing, so there is no DRAWING phase at all (see ORDER_INFO).
// ORIGINAL_CHAOS: ORIGINAL played with a word the players write themselves, so
// it opens on WORD_SELECTION like CUSTOM_WORD does.
export type GameMode =
    | 'CLASSIC'
    | 'CUSTOM_WORD'
    | 'HOT_WORD'
    | 'ORIGINAL'
    | 'ORIGINAL_CHAOS';

// ORIGINAL mode: how much of the speaking order the game hands out.
// RANDOM_STARTER only names who opens the round and leaves the rest to the
// table; FIXED_ORDER hands out the whole order and keeps it for the whole game;
// RANDOM_ORDER draws that whole order again on every round.
export type TurnOrderMode = 'RANDOM_STARTER' | 'FIXED_ORDER' | 'RANDOM_ORDER';

export interface Player {
    id: string; // Socket ID or UUID
    name: string;
    isConnected: boolean;
    score: number;
    hasVoted?: boolean;
    isEjected?: boolean;
    hasRevealedRole?: boolean;
    // HOT_WORD mode only: confirmation of the WORD_REVEAL screen of this round.
    hasRevealedNewWord?: boolean;
    // ORIGINAL mode only: confirmation of the ORDER_INFO screen of this round.
    hasConfirmedOrder?: boolean;
    hasConfirmedNewRound?: boolean;
    hasStartedEmergencyVoting: boolean;
    language?: string;
    // CUSTOM_WORD mode only. Never broadcast to clients (see getSanitizedRoomState).
    customWord?: string | null;
    hasSubmittedWord?: boolean;
}

export interface StrokeData {
    x: number;
    y: number;
    color: string;
    isNewStroke: boolean;
}

export interface GameOptions {
    roundTime: number;
    unlimitedInk: boolean;
    clearCanvasEachRound: boolean;
    playerColorsEnabled: boolean;
    impostorGuessEnabled: boolean;
    impostorGuessAttempts: number;
    hideHint: boolean;
    turnOrderMode: TurnOrderMode;
}

export interface GameRoom {
    roomId: string;
    hostId: string;
    phase: GamePhase;
    players: Player[];
    impostorId: string | null;
    secretWord: string | null;
    secretCategory: string | null;
    currentTurnPlayerId: string | null;
    turnOrder: string[]; // Array of player IDs
    turnIndex: number;
    votes: Record<string, string>; // Voter ID -> Voted Player ID (or 'skip')
    kickVotes: Record<string, string[]>; // Target Player ID -> Array of Voter IDs
    canvasStrokes: StrokeData[];
    currentRound: number;
    ejectedId: string | null;
    gameEnded: boolean;
    gameOptions: GameOptions;
    // Kept out of gameOptions on purpose: the mode is applied immediately when the
    // host moves the lobby carousel, while gameOptions are staged until confirmed.
    gameMode: GameMode;
    // Words already drawn in this game, so a rotating mode doesn't repeat them.
    usedWords: string[];
    // Impostor guess feature
    impostorGuessesUsed: number; // In-phase guesses spent (DRAWING/VOTING), persists across rounds
    impostorGuessedCorrectly: boolean; // True if the impostor won by guessing the word
}

export interface WordList {
    categories: {
        name: string;
        words: string[];
    }[];
}
