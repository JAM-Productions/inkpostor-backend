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
}

export type StrokeData = z.infer<typeof StrokeDataSchema>;

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
    canvasStrokes: StrokeData[];
    currentRound: number;
    ejectedId: string | null;
    gameEnded: boolean;
}

export interface WordList {
    categories: {
        name: string;
        words: string[];
    }[];
}
