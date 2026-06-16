import { GameOptions, GameRoom, Player, StrokeData } from './types';
import wordData from './data.json';
import wordTranslations from './wordTranslations.json';
import {
    ALLOWED_ROUND_TIMES,
    DEFAULT_IMPOSTOR_GUESSES,
    DEFAULT_ROUND_TIME,
    MAX_IMPOSTOR_GUESSES,
    MAX_NUM_PLAYERS_PER_ROOM,
    MIN_IMPOSTOR_GUESSES,
} from './constants';

const rooms: Record<string, GameRoom> = {};
const kickedFromRoom: Record<string, Set<string>> = {}; // roomId -> Set<playerId>

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeGameOptionsUpdate(
    options: unknown,
    currentOptions: GameOptions
): GameOptions | null {
    if (!isPlainObject(options)) return null;

    const nextOptions = { ...currentOptions };

    if (
        typeof options.roundTime === 'number' &&
        Number.isFinite(options.roundTime)
    ) {
        const normalizedRoundTime = Math.round(options.roundTime);
        if (
            ALLOWED_ROUND_TIMES.includes(
                normalizedRoundTime as (typeof ALLOWED_ROUND_TIMES)[number]
            )
        ) {
            nextOptions.roundTime = normalizedRoundTime;
        }
    }
    if (typeof options.unlimitedInk === 'boolean') {
        nextOptions.unlimitedInk = options.unlimitedInk;
    }
    if (typeof options.clearCanvasEachRound === 'boolean') {
        nextOptions.clearCanvasEachRound = options.clearCanvasEachRound;
    }
    if (typeof options.impostorGuessEnabled === 'boolean') {
        nextOptions.impostorGuessEnabled = options.impostorGuessEnabled;
    }
    if (
        typeof options.impostorGuessAttempts === 'number' &&
        Number.isFinite(options.impostorGuessAttempts)
    ) {
        const rounded = Math.round(options.impostorGuessAttempts);
        nextOptions.impostorGuessAttempts = Math.min(
            MAX_IMPOSTOR_GUESSES,
            Math.max(MIN_IMPOSTOR_GUESSES, rounded)
        );
    }

    return nextOptions;
}

export function createRoom(roomId: string, hostId: string): GameRoom {
    if (kickedFromRoom[roomId]) delete kickedFromRoom[roomId];
    const newRoom: GameRoom = {
        roomId,
        hostId,
        phase: 'LOBBY',
        players: [],
        impostorId: null,
        secretWord: null,
        secretCategory: null,
        currentTurnPlayerId: null,
        turnOrder: [],
        turnIndex: 0,
        votes: {},
        kickVotes: {},
        canvasStrokes: [],
        currentRound: 1,
        ejectedId: null,
        gameEnded: false,
        gameOptions: {
            roundTime: DEFAULT_ROUND_TIME,
            unlimitedInk: false,
            clearCanvasEachRound: true,
            impostorGuessEnabled: false,
            impostorGuessAttempts: DEFAULT_IMPOSTOR_GUESSES,
        },
        impostorGuessesUsed: 0,
        impostorGuessedCorrectly: false,
    };
    rooms[roomId] = newRoom;
    return newRoom;
}

export function getRoom(roomId: string): GameRoom | undefined {
    return rooms[roomId];
}

export function joinRoom(roomId: string, player: Player): GameRoom | null {
    const room = rooms[roomId];
    if (!room) return null;

    // Check if player was kicked from this room (lobby kick)
    if (kickedFromRoom[roomId]?.has(player.id)) return null;

    // Check if player already exists (reconnecting via same UUID)
    const existingPlayerIndex = room.players.findIndex(
        (p) => p.id === player.id
    );
    if (existingPlayerIndex >= 0) {
        room.players[existingPlayerIndex].isConnected = true;
    } else {
        // Cannot join mid-game unless reconnecting
        if (room.phase !== 'LOBBY') return null;
        // Enforce maximum players per room
        if (room.players.length >= MAX_NUM_PLAYERS_PER_ROOM) return null;

        room.players.push(player);
    }
    return room;
}

export function leaveRoom(roomId: string, playerId: string) {
    const room = rooms[roomId];
    if (!room) return;
    const playerIndex = room.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== -1) {
        if (room.phase === 'LOBBY') {
            room.players.splice(playerIndex, 1);
        } else {
            room.players[playerIndex].isConnected = false;
        }
    }

    // If no players are connected, we could delete the room after a timeout, but for MVP we just keep it
}

export function startGame(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.hostId !== playerId || room.players.length < 3)
        return null;

    // Pick Impostor
    const impostorIndex = Math.floor(Math.random() * room.players.length);
    room.impostorId = room.players[impostorIndex].id;

    // Pick Word
    const categoryIndex = Math.floor(
        Math.random() * wordData.categories.length
    );
    const category = wordData.categories[categoryIndex];
    const wordIndex = Math.floor(Math.random() * category.words.length);
    room.secretCategory = category.name;
    room.secretWord = category.words[wordIndex];

    // Setup Turns
    room.turnOrder = room.players
        .map((p) => p.id)
        .sort(() => Math.random() - 0.5);
    room.turnIndex = 0;
    room.currentTurnPlayerId = room.turnOrder[0];

    // Reset state
    room.votes = {};
    room.kickVotes = {};
    room.canvasStrokes = [];
    room.players.forEach((p) => {
        p.hasVoted = false;
        p.isEjected = false;
        p.hasRevealedRole = false;
        p.hasConfirmedNewRound = false;
        p.hasStartedEmergencyVoting = false;
    });
    room.ejectedId = null;
    room.gameEnded = false;
    room.impostorGuessesUsed = 0;
    room.impostorGuessedCorrectly = false;

    room.phase = 'ROLE_REVEAL';
    return room;
}

export function nextTurn(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (room.currentTurnPlayerId !== playerId) return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;

    let foundNext = false;
    while (room.turnIndex < room.turnOrder.length - 1) {
        room.turnIndex++;
        const nextId = room.turnOrder[room.turnIndex];
        const nextP = room.players.find((p) => p.id === nextId);
        if (nextP && nextP.isConnected && !nextP.isEjected) {
            room.currentTurnPlayerId = nextId;
            foundNext = true;
            break;
        }
    }
    if (!foundNext) {
        // Everyone has drawn, start voting phase!
        room.phase = 'VOTING';
        room.currentTurnPlayerId = null;
    }

    return room;
}

export function addStroke(
    roomId: string,
    playerId: string,
    stroke: StrokeData
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (room.currentTurnPlayerId !== playerId) return null; // Only active player can draw
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;

    room.canvasStrokes.push(stroke);
    return room;
}

export function undoStroke(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (room.currentTurnPlayerId !== playerId) return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;

    if (room.canvasStrokes.length > 0) {
        // Find the last index where isNewStroke is true
        let lastNewStrokeIndex = room.canvasStrokes.length - 1;
        while (
            lastNewStrokeIndex >= 0 &&
            !room.canvasStrokes[lastNewStrokeIndex].isNewStroke
        ) {
            lastNewStrokeIndex--;
        }

        if (lastNewStrokeIndex >= 0) {
            room.canvasStrokes = room.canvasStrokes.slice(
                0,
                lastNewStrokeIndex
            );
        } else {
            room.canvasStrokes = [];
        }
    }

    return room;
}

export function proceedToDrawing(
    roomId: string,
    playerId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'ROLE_REVEAL') return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player) return null;
    player.hasRevealedRole = true;
    const allRevealed = room.players.every((p) => p.hasRevealedRole);
    if (allRevealed) {
        room.phase = 'DRAWING';
    }
    return room;
}

function checkVotingComplete(room: GameRoom) {
    // Prune stale votes from ejected/disconnected players
    Object.keys(room.votes).forEach((voterId) => {
        const voter = room.players.find((p) => p.id === voterId);
        if (!voter || voter.isEjected || !voter.isConnected) {
            delete room.votes[voterId];
        }
    });

    const totalConnected = room.players.filter(
        (p) => p.isConnected && !p.isEjected
    ).length;
    const totalVotesCast = Object.keys(room.votes).length;

    if (totalVotesCast >= totalConnected && totalConnected > 0) {
        const counts: Record<string, number> = {};
        Object.values(room.votes).forEach((vote) => {
            counts[vote] = (counts[vote] || 0) + 1;
        });

        let maxVotes = 0;
        let ejectedId: null | string = null;
        let isTie = false;

        Object.entries(counts).forEach(([id, count]) => {
            if (count > maxVotes) {
                maxVotes = count;
                ejectedId = id;
                isTie = false;
            } else if (count === maxVotes) {
                isTie = true;
            }
        });

        if (isTie || ejectedId === 'skip') {
            room.ejectedId = null;
        } else {
            room.ejectedId = ejectedId;
            const ejectedPlayer = room.players.find((p) => p.id === ejectedId);
            if (ejectedPlayer) ejectedPlayer.isEjected = true;
            // If the impostor is ejected and the guess feature is on, give them
            // one final chance to guess the word before the game resolves.
            if (
                ejectedId === room.impostorId &&
                room.gameOptions.impostorGuessEnabled
            ) {
                room.phase = 'IMPOSTOR_GUESS';
                return; // Defer RESULTS until the final guess is submitted/skipped
            }
        }
        room.phase = 'RESULTS';
    }
}

export function castVote(
    roomId: string,
    voterId: string,
    votedForId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'VOTING' || voterId === votedForId) return null;
    const voter = room.players.find((p) => p.id === voterId);
    if (!voter || voter.hasVoted || voter.isEjected) return null;
    const isSkip = votedForId === 'skip';
    if (!isSkip) {
        const voted = room.players.find((p) => p.id === votedForId);
        if (!voted || voted.isEjected) return null;
    }
    room.votes[voterId] = votedForId;
    voter.hasVoted = true;

    checkVotingComplete(room);

    return room;
}

// Case- and accent-insensitive normalization for word comparison.
function normalizeWord(value: string): string {
    return value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

type TranslationMap = Record<string, Record<string, string>>;

function resolveLanguage(language: unknown): string {
    const translations = wordTranslations as TranslationMap;
    if (typeof language !== 'string') return 'en';
    // Accept region-tagged codes such as "es-ES" by taking the base language.
    const base = language.split('-')[0].toLowerCase();
    return base in translations ? base : 'en';
}

// The secret word is stored as its canonical English key. The impostor guesses
// in the language they have selected, so we ONLY accept the translation for that
// language.
function isWordMatch(
    guess: string,
    secretWord: string | null,
    language: string
): boolean {
    if (!secretWord) return false;
    const normalizedGuess = normalizeWord(guess);
    const translations = wordTranslations as TranslationMap;
    const translated = translations[language]?.[secretWord];
    return !!translated && normalizedGuess === normalizeWord(translated);

    // To additionally accept the canonical English key as a fallback (e.g. for
    // missing translations or words identical across languages), uncomment:
    // return normalizedGuess === normalizeWord(secretWord);
}

export function submitImpostorGuess(
    roomId: string,
    playerId: string,
    guess: unknown,
    language: unknown
): GameRoom | null {
    const room = rooms[roomId];
    if (!room) return null;
    // Only the impostor may guess, and only when the feature is enabled.
    if (room.impostorId !== playerId) return null;
    if (!room.gameOptions.impostorGuessEnabled) return null;
    if (typeof guess !== 'string') return null;
    const normalizedGuess = guess.trim();
    if (!normalizedGuess) return null;

    // The post-ejection final guess is its own phase (single shot, can skip).
    const isFinalGuess = room.phase === 'IMPOSTOR_GUESS';
    if (!isFinalGuess) {
        // In-phase guess (DRAWING/VOTING), bounded by the shared attempt pool.
        if (room.phase !== 'DRAWING' && room.phase !== 'VOTING') return null;
        if (room.impostorGuessesUsed >= room.gameOptions.impostorGuessAttempts)
            return null;
        room.impostorGuessesUsed++;
    }

    if (
        isWordMatch(normalizedGuess, room.secretWord, resolveLanguage(language))
    ) {
        // Correct guess: the impostor wins and the game ends immediately.
        room.impostorGuessedCorrectly = true;
        room.phase = 'RESULTS';
        room.gameEnded = true;
        return room;
    }

    // Wrong guess.
    if (isFinalGuess) {
        // The ejected impostor used their last chance -> crewmates win.
        room.phase = 'RESULTS';
        room.gameEnded = true;
    }
    return room;
}

export function skipImpostorGuess(
    roomId: string,
    playerId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room) return null;
    if (room.impostorId !== playerId) return null;
    if (room.phase !== 'IMPOSTOR_GUESS') return null;
    // The ejected impostor declined their final guess -> crewmates win.
    room.phase = 'RESULTS';
    room.gameEnded = true;
    return room;
}

export function playAgain(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.hostId !== playerId) return null;
    room.phase = 'LOBBY';
    room.currentRound = 1;
    room.impostorId = null;
    room.secretWord = null;
    room.secretCategory = null;
    room.currentTurnPlayerId = null;
    room.turnOrder = [];
    room.turnIndex = 0;
    room.votes = {};
    room.kickVotes = {};
    room.canvasStrokes = [];
    room.players.forEach((p) => {
        p.hasVoted = false;
        p.isEjected = false;
        p.hasRevealedRole = false;
        p.hasConfirmedNewRound = false;
        p.hasStartedEmergencyVoting = false;
    });
    room.ejectedId = null;
    room.gameEnded = false;
    room.impostorGuessesUsed = 0;
    room.impostorGuessedCorrectly = false;
    // Clear the lobby-kick blocklist for a fresh game
    delete kickedFromRoom[roomId];
    return room;
}

export function nextRound(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'RESULTS' || room.gameEnded) return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;
    player.hasConfirmedNewRound = true;
    const allConfirmed = room.players.every(
        (p) => p.isEjected || !p.isConnected || p.hasConfirmedNewRound
    );
    if (allConfirmed) {
        room.phase = 'DRAWING';
        room.currentRound++;
        room.turnOrder = room.turnOrder.filter((id) => {
            const player = room.players.find((p) => p.id === id);
            return player && !player.isEjected;
        });
        if (room.turnOrder.length === 0) {
            room.currentTurnPlayerId = null;
        } else {
            room.currentTurnPlayerId = room.turnOrder[0];
        }
        room.turnIndex = 0;
        room.votes = {};
        room.kickVotes = {};
        room.players.forEach((p) => {
            p.hasVoted = false;
            p.hasConfirmedNewRound = false;
        });
        room.ejectedId = null;
        if (room.gameOptions.clearCanvasEachRound) {
            room.canvasStrokes = [];
        }
    }
    return room;
}

export function endGame(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.hostId !== playerId) return null;
    room.phase = 'RESULTS';
    room.gameEnded = true;
    return room;
}

export function startEmergencyVoting(
    roomId: string,
    playerId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;
    player.hasStartedEmergencyVoting = true;
    room.currentTurnPlayerId = null;
    room.phase = 'VOTING';
    return room;
}

export function kickPlayer(
    roomId: string,
    hostId: string,
    playerId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'LOBBY' || room.hostId !== hostId) return null;
    if (playerId === hostId) return null;
    const playerIndex = room.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) return null;
    room.players.splice(playerIndex, 1);
    // Block this player from rejoining the same room
    if (!kickedFromRoom[roomId]) kickedFromRoom[roomId] = new Set();
    kickedFromRoom[roomId].add(playerId);
    return room;
}

function executeKick(room: GameRoom, playerId: string) {
    const playerIndex = room.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) return;

    const wasCurrentTurn = room.currentTurnPlayerId === playerId;
    const wasImpostor = playerId === room.impostorId;
    const previousTurnIndex = room.turnIndex;

    room.players.splice(playerIndex, 1);
    room.turnOrder = room.turnOrder.filter((id) => id !== playerId);
    delete room.votes[playerId];
    Object.keys(room.votes).forEach((voterId) => {
        if (room.votes[voterId] === playerId) {
            delete room.votes[voterId];
        }
    });
    delete room.kickVotes[playerId];
    Object.keys(room.kickVotes).forEach((targetId) => {
        room.kickVotes[targetId] = room.kickVotes[targetId].filter(
            (voterId) => voterId !== playerId
        );
    });

    if (wasImpostor) {
        room.ejectedId = playerId;
        room.phase = 'RESULTS';
        room.gameEnded = true;
        return;
    }

    const activePlayers = room.players.filter((p) => p.isConnected);
    if (activePlayers.length < 3) {
        room.phase = 'RESULTS';
        room.gameEnded = true;
        // If the impostor is no longer actively playing (disconnected, kicked or ejected),
        // crewmates win by attrition â€” signal this by setting ejectedId to impostorId
        const impostorActive = room.players.some(
            (p) => p.id === room.impostorId && p.isConnected
        );
        room.ejectedId = impostorActive ? playerId : room.impostorId;
        return;
    }

    if (wasCurrentTurn) {
        let foundNext = false;
        room.turnIndex = previousTurnIndex;
        while (room.turnIndex >= 0 && room.turnIndex < room.turnOrder.length) {
            const nextId = room.turnOrder[room.turnIndex];
            const nextP = room.players.find((p) => p.id === nextId);
            if (nextP && nextP.isConnected && !nextP.isEjected) {
                room.currentTurnPlayerId = nextId;
                foundNext = true;
                break;
            }
            room.turnIndex++;
        }
        if (!foundNext) {
            room.phase = 'VOTING';
            room.currentTurnPlayerId = null;
        }
    } else if (room.currentTurnPlayerId) {
        const currentTurnIndex = room.turnOrder.indexOf(
            room.currentTurnPlayerId
        );
        if (currentTurnIndex !== -1) {
            room.turnIndex = currentTurnIndex;
        }
    }

    if (room.phase === 'VOTING') {
        checkVotingComplete(room);
    }
}

export function voteKickPlayer(
    roomId: string,
    voterId: string,
    targetId: string
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (voterId === targetId) return null;

    const voter = room.players.find((p) => p.id === voterId);
    if (!voter || !voter.isConnected) return null;

    if (!room.kickVotes) room.kickVotes = {};
    if (!room.kickVotes[targetId]) room.kickVotes[targetId] = [];

    // Prune stale votes before evaluating
    room.kickVotes[targetId] = room.kickVotes[targetId].filter((vid) => {
        const v = room.players.find((p) => p.id === vid);
        return v && v.isConnected;
    });

    const votes = room.kickVotes[targetId];
    const voteIndex = votes.indexOf(voterId);

    if (voteIndex !== -1) {
        votes.splice(voteIndex, 1);
    } else {
        votes.push(voterId);
    }

    // Check if threshold is met
    // Threshold is all connected, non-ejected players EXCEPT the target
    const requiredVotes = room.players.filter(
        (p) => p.isConnected && p.id !== targetId
    ).length;

    if (votes.length >= requiredVotes && requiredVotes > 0) {
        executeKick(room, targetId);
        // Clear votes so we don't accidentally re-trigger
        room.kickVotes[targetId] = [];
        // Block from reconnecting for the rest of this game session
        if (!kickedFromRoom[roomId]) kickedFromRoom[roomId] = new Set();
        kickedFromRoom[roomId].add(targetId);
    }

    return room;
}

export function updateGameOptions(
    roomId: string,
    userId: string,
    options: unknown
): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'LOBBY') return null;
    if (room.hostId !== userId) return null;
    const sanitizedOptions = sanitizeGameOptionsUpdate(
        options,
        room.gameOptions
    );
    if (!sanitizedOptions) return null;
    room.gameOptions = sanitizedOptions;
    return room;
}
