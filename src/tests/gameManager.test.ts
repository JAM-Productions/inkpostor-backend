import { describe, it, expect } from 'vitest';
import {
    createRoom,
    getRoom,
    joinRoom,
    leaveRoom,
    startGame,
    nextTurn,
    addStroke,
    clearCanvas,
    proceedToDrawing,
    castVote,
    playAgain,
} from '../gameManager';
import { Player, StrokeData } from '../types';

describe('gameManager', () => {
    // Helper to create basic players
    const createPlayer = (id: string, name: string): Player => ({
        id,
        name,
        isConnected: true,
        score: 0,
        hasVoted: false,
    });

    describe('createRoom & getRoom', () => {
        it('should create a room correctly and retrieve it', () => {
            const room = createRoom('room-create', 'host1');
            expect(room).toBeDefined();
            expect(room.roomId).toBe('room-create');
            expect(room.hostId).toBe('host1');
            expect(room.phase).toBe('LOBBY');

            const fetched = getRoom('room-create');
            expect(fetched).toBe(room);

            const notFound = getRoom('invalid');
            expect(notFound).toBeUndefined();
        });
    });

    describe('joinRoom', () => {
        it('should allow player to join existing room in LOBBY phase', () => {
            createRoom('room-join', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const room = joinRoom('room-join', p1);

            expect(room).not.toBeNull();
            expect(room!.players.length).toBe(1);
            expect(room!.players[0].id).toBe('p1');
        });

        it('should return null for non-existent room', () => {
            const p1 = createPlayer('p1', 'Alice');
            const room = joinRoom('invalid-room', p1);
            expect(room).toBeNull();
        });

        it('should allow reconnection with new socket id (based on id or name)', () => {
            createRoom('room-reconnect', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            joinRoom('room-reconnect', p1);

            // Reconnect with new id but same name
            const p1Reconnect = createPlayer('p1-new', 'Alice');
            const room = joinRoom('room-reconnect', p1Reconnect);

            expect(room!.players.length).toBe(1);
            expect(room!.players[0].id).toBe('p1-new');
            expect(room!.players[0].isConnected).toBe(true);
        });

        it('should not allow joining mid-game if new player', () => {
            const room = createRoom('room-midgame', 'host1');
            room.phase = 'DRAWING'; // manually force state

            const p1 = createPlayer('p1', 'Alice');
            const result = joinRoom('room-midgame', p1);
            expect(result).toBeNull();
        });
    });

    describe('leaveRoom', () => {
        it('should set isConnected to false', () => {
            createRoom('room-leave', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            joinRoom('room-leave', p1);

            leaveRoom('room-leave', 'p1');

            const room = getRoom('room-leave');
            expect(room!.players[0].isConnected).toBe(false);
        });

        it('should do nothing if room or player not found', () => {
            createRoom('room-leave-invalid', 'host1');
            expect(() => {
                leaveRoom('room-leave-invalid', 'p1');
                leaveRoom('invalid-room', 'p1');
            }).not.toThrow();
        });
    });

    describe('startGame', () => {
        it('should return null if room not found or not enough players', () => {
            createRoom('room-start-fail', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            joinRoom('room-start-fail', p1);

            const result = startGame('room-start-fail', 'host1');
            expect(result).toBeNull();

            const invalidResult = startGame('invalid-room', 'host1');
            expect(invalidResult).toBeNull();
        });

        it('should start game correctly with 3+ players', () => {
            createRoom('room-start', 'host1');
            const players = [
                createPlayer('p1', 'Alice'),
                createPlayer('p2', 'Bob'),
                createPlayer('p3', 'Charlie'),
            ];
            players.forEach((p) => joinRoom('room-start', p));

            const result = startGame('room-start', 'host1');
            expect(result).not.toBeNull();
            expect(result!.phase).toBe('ROLE_REVEAL');
            expect(result!.impostorId).toBeDefined();
            expect(result!.secretWord).toBeDefined();
            expect(result!.secretCategory).toBeDefined();
            expect(result!.turnOrder.length).toBe(3);
            expect(result!.currentTurnPlayerId).toBeDefined();
            expect(result!.turnOrder).toContain(result!.currentTurnPlayerId);
        });
    });

    describe('nextTurn', () => {
        it('should progress turns and switch to VOTING when done', () => {
            const room = createRoom('room-turns', 'host1');
            room.turnOrder = ['p1', 'p2'];
            room.turnIndex = 0;
            room.currentTurnPlayerId = 'p1';
            room.phase = 'DRAWING';

            const r1 = nextTurn('room-turns', 'p1');
            expect(r1).not.toBeNull();
            expect(r1!.currentTurnPlayerId).toBe('p2');
            expect(r1!.turnIndex).toBe(1);

            const r2 = nextTurn('room-turns', 'p2');
            expect(r2!.phase).toBe('VOTING');
            expect(r2!.currentTurnPlayerId).toBeNull();
        });

        it('should return null for non-existent room', () => {
            expect(nextTurn('invalid', 'host1')).toBeNull();
        });
    });

    describe('proceedToDrawing', () => {
        it('should set phase to DRAWING', () => {
            createRoom('room-proceed', 'host1');
            const result = proceedToDrawing('room-proceed', 'host1');
            expect(result).not.toBeNull();
            expect(result!.phase).toBe('DRAWING');
        });

        it('should return null for invalid room', () => {
            expect(proceedToDrawing('invalid', 'host1')).toBeNull();
        });
    });

    describe('addStroke and clearCanvas', () => {
        it('should handle strokes if active player and drawing phase', () => {
            const room = createRoom('room-stroke', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            joinRoom('room-stroke', p1);

            room.phase = 'DRAWING';
            room.currentTurnPlayerId = 'p1';

            const stroke: StrokeData = {
                x: 0,
                y: 0,
                color: '#000',
                isNewStroke: true,
            };

            // Valid add
            const result1 = addStroke('room-stroke', 'p1', stroke);
            expect(result1).not.toBeNull();
            expect(result1!.canvasStrokes.length).toBe(1);

            // Invalid player add
            const result2 = addStroke('room-stroke', 'p2', stroke);
            expect(result2).toBeNull();

            // Clear valid
            const result3 = clearCanvas('room-stroke', 'p1');
            expect(result3).not.toBeNull();
            expect(result3!.canvasStrokes.length).toBe(0);

            // Clear invalid player
            const result4 = clearCanvas('room-stroke', 'p2');
            expect(result4).toBeNull();
        });

        it('should return null for add/clear if wrong phase or no room', () => {
            createRoom('room-wrong-phase', 'host1');
            const stroke: StrokeData = {
                x: 0,
                y: 0,
                color: '#000',
                isNewStroke: true,
            };

            expect(addStroke('room-wrong-phase', 'host1', stroke)).toBeNull();
            expect(clearCanvas('room-wrong-phase', 'host1')).toBeNull();
            expect(addStroke('invalid', 'host1', stroke)).toBeNull();
            expect(clearCanvas('invalid', 'host1')).toBeNull();
        });
    });

    describe('castVote', () => {
        it('should cast vote and change phase to RESULTS when all connected vote', () => {
            const room = createRoom('room-voting', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            const p2 = createPlayer('p2', 'Bob');
            joinRoom('room-voting', p1);
            joinRoom('room-voting', p2);

            room.phase = 'VOTING';

            const r1 = castVote('room-voting', 'p1', 'p2');
            expect(r1).not.toBeNull();
            expect(r1!.votes['p1']).toBe('p2');
            expect(r1!.players[0].hasVoted).toBe(true);
            expect(r1!.phase).toBe('VOTING');

            const r2 = castVote('room-voting', 'p2', 'p1');
            expect(r2!.phase).toBe('RESULTS');
        });

        it('should ignore votes if phase is not VOTING or room invalid', () => {
            createRoom('room-not-voting', 'host1');
            const r1 = castVote('room-not-voting', 'p1', 'p2');
            expect(r1).toBeNull();

            const r2 = castVote('invalid', 'p1', 'p2');
            expect(r2).toBeNull();
        });
    });

    describe('playAgain', () => {
        it('should reset state correctly', () => {
            const room = createRoom('room-playagain', 'host1');
            const p1 = createPlayer('p1', 'Alice');
            p1.hasVoted = true;
            joinRoom('room-playagain', p1);

            room.phase = 'RESULTS';
            room.impostorId = 'p1';
            room.secretWord = 'word';
            room.votes = { p1: 'p2' };
            room.turnOrder = ['p1'];

            const result = playAgain('room-playagain', 'host1');
            expect(result).not.toBeNull();
            expect(result!.phase).toBe('LOBBY');
            expect(result!.impostorId).toBeNull();
            expect(result!.secretWord).toBeNull();
            expect(result!.votes).toEqual({});
            expect(result!.turnOrder).toEqual([]);
            expect(result!.players[0].hasVoted).toBe(false);
        });

        it('should return null for invalid room', () => {
            expect(playAgain('invalid', 'host1')).toBeNull();
        });
    });
});
