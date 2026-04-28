# Inkpostor — Game States & Logic

## Game Phases

| Phase | Description |
|---|---|
| `LOBBY` | Players join the room. Host can kick players. Game hasn't started. |
| `ROLE_REVEAL` | Players see their role (Inkpostor or Crewmate). Must confirm before proceeding. |
| `DRAWING` | Players take turns drawing on the canvas. Vote-kick is available. |
| `VOTING` | All players vote on who they think the Inkpostor is (or skip). |
| `RESULTS` | The round or game result is revealed. |

---

## Phase Transitions

```
LOBBY → ROLE_REVEAL      (host starts the game, ≥ 3 players required)
ROLE_REVEAL → DRAWING    (all players confirm their role)
DRAWING → VOTING         (all turns used up, or emergency voting triggered)
DRAWING → RESULTS        (vote-kick causes game-ending condition)
VOTING → RESULTS         (all connected non-ejected players have voted)
RESULTS → DRAWING        (next round, all players confirm — non-ejected only)
RESULTS → LOBBY          (host clicks Play Again)
```

---

## Win / Loss Conditions

| Condition | Outcome |
|---|---|
| Inkpostor ejected via voting (`ejectedId === impostorId`) | 🟢 **Crewmates win** — Inkpostor Defeated |
| Inkpostor ejected via vote-kick (`ejectedId === impostorId`) | 🟢 **Crewmates win** — Inkpostor Defeated |
| Crewmate kicked, impostor still active, active players < 3 | 🔴 **Inkpostor wins** |
| Crewmate kicked, impostor disconnected / not in game, active players < 3 | 🟢 **Crewmates win** — impostor abandoned |
| Host manually ends game (`endGame`) | 🔴 **Inkpostor wins** (`gameEnded = true`) |
| Voting ends in a tie or everyone skips | ➡ Next round (`ejectedId = null`) |

> **Active player** = `isConnected && !isEjected`

---

## Vote-Kick Mechanics (mid-game only)

- Available during `DRAWING` and `VOTING` phases (not `LOBBY`).
- Any connected, non-ejected player can vote to kick another.
- Votes are **toggleable** — clicking again removes your vote.
- **Threshold**: all connected, non-ejected players except the target must agree.

```
requiredVotes = connectedActivePlayers.count(id ≠ target)
```

| Players | Target | Required Votes |
|---|---|---|
| 3 | 1 | 2 |
| 4 | 1 | 3 |
| 5 | 1 | 4 |

Once the threshold is met:
1. Target is marked `isEjected = true`, `isConnected = false`.
2. Win condition is evaluated immediately (see table above).
3. If no game-ending condition: turn is skipped to the next active player.
4. If no next active player exists: transition to `VOTING`.
5. Kicked player receives a `kicked` socket event and is disconnected.

---

## Turn Order

- Turn order is randomised at game start.
- Ejected players are skipped automatically.
- The current drawing player can end their turn early.
- If the current drawing player is ejected mid-turn, the turn advances immediately.
- If no valid next player exists, the game transitions to `VOTING`.

---

## Multi-Round Games

- After `RESULTS`, non-ejected players can confirm to start the next round.
- Ejected players wait silently (they cannot confirm or draw).
- A new round resets: `votes`, `kickVotes`, `canvasStrokes`, `turnIndex`.
- The impostor **remains the same** across rounds.
- `impostorId` is hidden from clients until phase = `RESULTS`.

---

## Secret Information

| Field | Visible to clients during game | Visible in RESULTS |
|---|---|---|
| `impostorId` | ❌ Hidden (`null`) | ✅ Revealed |
| `secretWord` | ✅ Crewmates only (via `roleAssignment`) | ✅ All |
| `secretCategory` | ✅ Everyone (via `roleAssignment`) | ✅ All |
| `kickVotes` | ✅ Everyone (vote counts visible) | ✅ All |

---

## Socket Events (Client → Server)

| Event | When | Description |
|---|---|---|
| `createRoom` | LOBBY | Host creates a new room |
| `joinRoom` | LOBBY | Player joins an existing room |
| `startGame` | LOBBY | Host starts the game (host only) |
| `proceedToDrawing` | ROLE_REVEAL | Player confirms role |
| `drawStroke` | DRAWING | Current turn player draws a stroke |
| `undoStroke` | DRAWING | Current turn player undoes last stroke |
| `endTurn` | DRAWING | Current turn player ends their turn |
| `startEmergencyVoting` | DRAWING | Any player triggers emergency vote |
| `vote` | VOTING | Player casts or changes vote |
| `voteKickPlayer` | DRAWING, VOTING | Any player votes to kick a target |
| `kickPlayer` | LOBBY | Host removes a player (lobby only) |
| `nextRound` | RESULTS | Player confirms ready for next round |
| `endGame` | RESULTS | Host ends the game (host only) |
| `playAgain` | RESULTS | Host returns to lobby (host only) |

---

## Socket Events (Server → Client)

| Event | Description |
|---|---|
| `gameStateUpdate` | Full (sanitised) room state broadcast to all players in room |
| `roleAssignment` | Private role info sent to each player individually at game start |
| `strokeUpdate` | Real-time stroke broadcast to other players (not the drawer) |
| `strokeUndone` | Broadcast when a stroke is undone |
| `kicked` | Sent to a player who was removed (lobby kick or vote-kick) |
| `error` | Sent on auth failure or other unrecoverable errors |
