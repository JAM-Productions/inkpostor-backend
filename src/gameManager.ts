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

    const connectedPlayers = room.players.filter((p) => p.isConnected);

    // If game is active (not LOBBY or RESULTS)
    if (room.phase !== 'LOBBY' && room.phase !== 'RESULTS') {
        // Transition to RESULTS if impostor leaves
        if (playerId === room.impostorId) {
            room.phase = 'RESULTS';
            room.gameEnded = true;
            return;
        }

        // Revert to LOBBY if connected players < 3
        if (connectedPlayers.length < 3) {
            resetRoomState(room, 'LOBBY');
            return;
        }

        // If it was the disconnected player's turn in DRAWING phase, advance turn
        if (room.phase === 'DRAWING' && room.currentTurnPlayerId === playerId) {
            advanceTurn(room);
            return;
        }
    }

    // Check phase completion for other cases (ROLE_REVEAL, VOTING, RESULTS confirmation)
    checkPhaseCompletion(room);
}

export function startGame(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    const connectedPlayers = room?.players.filter((p) => p.isConnected) || [];
    if (!room || room.hostId !== playerId || connectedPlayers.length < 3)
        return null;

    // Pick Impostor from connected players
    const impostorIndex = Math.floor(Math.random() * connectedPlayers.length);
    room.impostorId = connectedPlayers[impostorIndex].id;

    // Pick Word
    const categoryIndex = Math.floor(
        Math.random() * wordData.categories.length
    );
    const category = wordData.categories[categoryIndex];
    const wordIndex = Math.floor(Math.random() * category.words.length);
    room.secretCategory = category.name;
    room.secretWord = category.words[wordIndex];

    // Setup Turns from connected players
    room.turnOrder = connectedPlayers
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
    if (!player || !player.isConnected || player.isEjected) return null;

    advanceTurn(room);

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
    if (!player || !player.isConnected || player.isEjected) return null;

    room.canvasStrokes.push(stroke);
    return room;
}

export function undoStroke(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'DRAWING') return null;
    if (room.currentTurnPlayerId !== playerId) return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || !player.isConnected || player.isEjected) return null;

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
    if (!player || !player.isConnected || player.isEjected) return null;
    player.hasRevealedRole = true;
    checkPhaseCompletion(room);
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
    if (!voter || !voter.isConnected || voter.hasVoted || voter.isEjected) return null;
    const isSkip = votedForId === 'skip';
    if (!isSkip) {
        const voted = room.players.find((p) => p.id === votedForId);
        if (!voted || voted.isEjected) return null;
    }
    room.votes[voterId] = votedForId;
    voter.hasVoted = true;

    checkPhaseCompletion(room);

    return room;
}

export function playAgain(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.hostId !== playerId) return null;
    resetRoomState(room, 'LOBBY');
    return room;
}

function resetRoomState(room: GameRoom, phase: typeof room.phase) {
    room.phase = phase;
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
    });
    room.ejectedId = null;
    room.gameEnded = false;
}

export function nextRound(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.phase !== 'RESULTS' || room.gameEnded) return null;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || !player.isConnected || player.isEjected) return null;
    player.hasConfirmedNewRound = true;

    checkPhaseCompletion(room);

    return room;
}

export function endGame(roomId: string, playerId: string): GameRoom | null {
    const room = rooms[roomId];
    if (!room || room.hostId !== playerId) return null;
    room.phase = 'RESULTS';
    room.gameEnded = true;
    return room;
}

function finalizeVoting(room: GameRoom) {
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

function startNextRound(room: GameRoom) {
    room.phase = 'DRAWING';
    room.currentRound++;
    room.turnOrder = room.turnOrder.filter((id) => {
        const player = room.players.find((p) => p.id === id);
        return player && !player.isEjected;
    });
    room.turnIndex = -1; // Set to -1 so advanceTurn moves it to 0
    room.votes = {};
    room.players.forEach((p) => {
        p.hasVoted = false;
        p.hasConfirmedNewRound = false;
    });
    room.ejectedId = null;
    room.canvasStrokes = [];
    advanceTurn(room);
}

function advanceTurn(room: GameRoom) {
    if (room.phase !== 'DRAWING') return;

    room.turnIndex++;
    while (room.turnIndex < room.turnOrder.length) {
        const pid = room.turnOrder[room.turnIndex];
        const player = room.players.find((p) => p.id === pid);
        if (player && player.isConnected && !player.isEjected) {
            room.currentTurnPlayerId = pid;
            return;
        }
        room.turnIndex++;
    }

    // Everyone connected has drawn
    room.phase = 'VOTING';
    room.currentTurnPlayerId = null;
}

function checkPhaseCompletion(room: GameRoom) {
    const connectedNonEjected = room.players.filter(
        (p) => p.isConnected && !p.isEjected
    );

    if (room.phase === 'ROLE_REVEAL') {
        const allRevealed = connectedNonEjected.every((p) => p.hasRevealedRole);
        if (allRevealed && connectedNonEjected.length > 0) {
            room.phase = 'DRAWING';
            room.turnIndex = -1;
            advanceTurn(room);
        }
    } else if (room.phase === 'VOTING') {
        const totalVotesCast = Object.keys(room.votes).length;
        if (totalVotesCast >= connectedNonEjected.length && connectedNonEjected.length > 0) {
            finalizeVoting(room);
        }
    } else if (room.phase === 'RESULTS') {
        if (room.gameEnded) return;
        const allConfirmed = connectedNonEjected.every(
            (p) => p.hasConfirmedNewRound
        );
        if (allConfirmed && connectedNonEjected.length > 0) {
            startNextRound(room);
        }
    }
}
