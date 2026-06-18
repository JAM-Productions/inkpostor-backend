import { z } from 'zod';
import { UserPayloadSchema, StrokeDataSchema } from './schemas';

export type UserPayload = z.infer<typeof UserPayloadSchema>;

declare module 'socket.io' {
    interface Socket {
        user: UserPayload;
    }
}

export type GamePhase =
    | 'LOBBY'
    | 'ROLE_REVEAL'
    | 'DRAWING'
    | 'VOTING'
    | 'IMPOSTOR_GUESS'
    | 'RESULTS';

export interface Player {
    id: string; // Socket ID or UUID
    name: string;
    isConnected: boolean;
    score: number;
    hasVoted?: boolean;
    isEjected?: boolean;
    hasRevealedRole?: boolean;
    hasConfirmedNewRound?: boolean;
    hasStartedEmergencyVoting: boolean;
}

export type StrokeData = z.infer<typeof StrokeDataSchema>;

export interface GameOptions {
    roundTime: number;
    unlimitedInk: boolean;
    clearCanvasEachRound: boolean;
    impostorGuessEnabled: boolean;
    impostorGuessAttempts: number;
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
