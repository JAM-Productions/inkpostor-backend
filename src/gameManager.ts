import { GameRoom, Player, StrokeData } from './types';
import wordData from './data.json';
import { MAX_NUM_PLAYERS_PER_ROOM } from './constants';

const rooms: Record<string, GameRoom> = {};

export function createRoom(roomId: string, hostId: string): GameRoom {
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
        canvasStrokes: [],
        currentRound: 1,
        ejectedId: null,
        gameEnded: false,
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
    const player = room.players.find((p) => p.id === playerId);
    if (player) {
        player.isConnected = false;
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

    room.phase = 'ROLE_REVEAL';
    return room;
}

export function nextTurn(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (room.currentTurnPlayerId !== playerId) return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;

    room.turnIndex++;
    if (room.turnIndex >= room.turnOrder.length) {
        // Everyone has drawn, start voting phase!
        room.phase = 'VOTING';
        room.currentTurnPlayerId = null;
    } else {
        room.currentTurnPlayerId = room.turnOrder[room.turnIndex];
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

    // Check if everyone has voted
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
        }
        room.phase = 'RESULTS';
    }

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
    return room;
}

export function nextRound(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'RESULTS' || room.gameEnded) return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isEjected) return null;
    player.hasConfirmedNewRound = true;
    const allConfirmed = room.players.every(
        (p) => p.isEjected || p.hasConfirmedNewRound
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
        room.players.forEach((p) => {
            p.hasVoted = false;
            p.hasConfirmedNewRound = false;
        });
        room.ejectedId = null;
        room.canvasStrokes = [];
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
