# Inkpostor — Game States & Logic

## Game Phases

| Phase | Description |
|---|---|
| `LOBBY` | Players join the room. Host can kick players. Game hasn't started. |
| `ROLE_REVEAL` | Players see their role (Inkpostor or Crewmate). Must confirm before proceeding. |
| `DRAWING` | Players take turns drawing on the canvas. Vote-kick is available. |
| `VOTING` | All players vote on who they think the Inkpostor is (or skip). |
| `IMPOSTOR_GUESS` | The ejected Inkpostor gets one final guess at the secret word. Everyone else waits. Only reached when the impostor-guess option is enabled. |
| `RESULTS` | The round or game result is revealed. |

---

## Phase Transitions

```
LOBBY → ROLE_REVEAL          (host starts the game, ≥ 3 players required)
ROLE_REVEAL → DRAWING        (all players confirm their role)
DRAWING → VOTING             (all turns used up, or emergency voting triggered)
DRAWING → RESULTS            (vote-kick causes game-ending condition)
DRAWING → RESULTS            (impostor guesses the word correctly — impostor wins)
VOTING → RESULTS             (voting ends and the impostor is NOT ejected, or the guess option is off)
VOTING → RESULTS             (impostor guesses the word correctly — impostor wins)
VOTING → IMPOSTOR_GUESS      (impostor ejected by vote AND the impostor-guess option is enabled)
IMPOSTOR_GUESS → RESULTS     (impostor submits their final guess, or skips it)
RESULTS → DRAWING            (next round, all connected non-ejected players confirm)
RESULTS → LOBBY              (host clicks Play Again)
```

### Disconnect-driven transitions

A player dropping (socket `disconnect`, or leaving by switching rooms) is handled
in `leaveRoom`. In `LOBBY` the player is removed; otherwise they are marked
`isConnected = false`. Because a disconnected player no longer counts towards the
phase's completion condition, the phase is **re-evaluated immediately** so the
game never hangs waiting on someone who left:

```
VOTING → RESULTS / IMPOSTOR_GUESS   (last expected voter disconnects → the vote resolves)
IMPOSTOR_GUESS → RESULTS            (the impostor disconnects → counts as a surrender, crewmates win)
RESULTS → DRAWING                   (last unconfirmed player disconnects → next round starts)
```

> A disconnected impostor can never make a final guess. So if a `VOTING`
> resolution would push a now-disconnected impostor into `IMPOSTOR_GUESS`, it is
> short-circuited straight to `RESULTS` (surrender). In every surrender path
> `ejectedId` is already `impostorId`, so the result reads as 🟢 Crewmates win.

---

## Win / Loss Conditions

| Condition | Outcome |
|---|---|
| Inkpostor ejected via voting (`ejectedId === impostorId`) | 🟢 **Crewmates win** — Inkpostor Defeated *(unless the guess option is on → first goes to `IMPOSTOR_GUESS`)* |
| Inkpostor ejected via vote-kick (`ejectedId === impostorId`) | 🟢 **Crewmates win** — Inkpostor Defeated |
| Crewmate kicked, impostor still active, connected players < 3 | 🔴 **Inkpostor wins** |
| Crewmate kicked, impostor disconnected / not in game, connected players < 3 | 🟢 **Crewmates win** — impostor abandoned |
| Host manually ends game (`endGame`) | 🔴 **Inkpostor wins** (`gameEnded = true`) |
| Voting ends in a tie or everyone skips | ➡ Next round (`ejectedId = null`) |
| Inkpostor guesses the secret word (any phase: DRAWING / VOTING / IMPOSTOR_GUESS) | 🔴 **Inkpostor wins** (`impostorGuessedCorrectly = true`) |
| Inkpostor ejected, then fails or skips their final guess | 🟢 **Crewmates win** — Inkpostor Defeated |
| Inkpostor disconnects while ejected and owing a final guess (in `IMPOSTOR_GUESS`, or a `VOTING` resolution that would enter it) | 🟢 **Crewmates win** — counts as a surrender (`ejectedId === impostorId`) |

> **Active player** = `isConnected && !isEjected`

---

## Vote-Kick Mechanics (mid-game only)

- Available during the `DRAWING` phase (not `LOBBY` or `VOTING`).
- Any connected player (even if ejected in a previous round) can vote to kick another.
- Votes are **toggleable** — clicking again removes your vote.
- **Threshold**: all connected players except the target must agree (ejected players who are connected count towards this threshold and can vote, while disconnected players are pruned/ignored).

```
requiredVotes = connectedPlayers.count(id ≠ target)
```

| Players | Target | Required Votes |
|---|---|---|
| 3 | 1 | 2 |
| 4 | 1 | 3 |
| 5 | 1 | 4 |

Once the threshold is met:
1. Target is removed from `room.players` and blocklisted for the current game session.
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

- After `RESULTS`, connected non-ejected players can confirm to start the next round (disconnected players are ignored).
- Ejected players wait silently (they cannot confirm or draw).
- A new round resets: `votes`, `kickVotes`, `canvasStrokes`, `turnIndex`.
- The impostor **remains the same** across rounds.
- `impostorId` is hidden from clients until phase = `RESULTS`.

---

## Impostor Guess (optional feature)

Lets the Inkpostor win by guessing the secret word. Configured by the host in the lobby:

| Option | Default | Range | Meaning |
|---|---|---|---|
| `impostorGuessEnabled` | `false` | boolean | Turns the whole feature on/off |
| `impostorGuessAttempts` | `3` | `1`–`3` | Size of the shared in-phase guess pool |

**In-phase guesses (`DRAWING` / `VOTING`)**

- The impostor can guess at any point during these phases, bounded by the shared pool (`impostorGuessesUsed`).
- The pool **persists across rounds** within the same game; it is reset only on `startGame` / `playAgain`.
- A correct guess ends the game immediately → `RESULTS`, `impostorGuessedCorrectly = true` (🔴 Inkpostor wins).
- A wrong in-phase guess consumes one attempt and is broadcast **only to the impostor's socket** (so crewmates don't learn that guessing is happening).

**Final guess (`IMPOSTOR_GUESS` phase)**

- When the impostor is ejected by vote and the feature is on, voting resolves into `IMPOSTOR_GUESS` instead of `RESULTS`.
- The impostor gets **one** final guess (independent of the in-phase pool) plus a **skip** option. Everyone else sees a waiting screen.
- Correct → 🔴 Inkpostor wins. Wrong or skipped → 🟢 Crewmates win (`ejectedId` already = `impostorId`).

**Validation (server-side, language-aware)**

- The guess is validated **on the server**; the impostor never receives `secretWord`.
- The secret word is stored as its canonical English key. The guess is compared against the **translation for the player's selected language** (sent with the guess), **case- and accent-insensitive**. Only that language is accepted.

---

## Secret Information

| Field | Visible to clients during game | Visible in RESULTS |
|---|---|---|
| `impostorId` | ❌ Hidden (`null`) — including during `IMPOSTOR_GUESS` | ✅ Revealed |
| `secretWord` | ✅ Crewmates only (via `roleAssignment`); never sent to the impostor | ✅ All |
| `secretCategory` | ✅ Everyone (via `roleAssignment`) | ✅ All |
| `kickVotes` | ✅ Everyone (vote counts visible) | ✅ All |
| `impostorGuessesUsed` | ✅ Sent privately to the impostor (not broadcast on wrong guesses) | ✅ All |

> During `IMPOSTOR_GUESS` the broadcast state stays sanitised (`impostorId` / `secretWord` hidden); clients decide what to render from their local `amIImpostor` flag.

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
| `submitImpostorGuess` | DRAWING / VOTING / IMPOSTOR_GUESS | Impostor guesses the secret word (payload: `{ guess, language }`) |
| `skipImpostorGuess` | IMPOSTOR_GUESS | Ejected impostor declines their final guess (crewmates win) |
| `voteKickPlayer` | DRAWING | Any player votes to kick a target |
| `kickPlayer` | LOBBY | Host removes a player (lobby only) |
| `nextRound` | RESULTS | Player confirms ready for next round |
| `endGame` | RESULTS | Host ends the game (host only) |
| `playAgain` | RESULTS | Host returns to lobby (host only) |

---

## Socket Events (Server → Client)

| Event | Description |
|---|---|
| `gameStateUpdate` | Full (sanitised) room state broadcast to all players in room |
| `roleAssignment` | Private role info sent to each player individually at game start, **and re-sent to a player who reconnects mid-game** so they recover `amIImpostor` / `secretWord` / `secretCategory` |
| `strokeUpdate` | Real-time stroke broadcast to other players (not the drawer) |
| `strokeUndone` | Broadcast when a stroke is undone |
| `kicked` | Sent to a player who was removed (lobby kick or vote-kick) |
| `error` | Sent on auth failure or other unrecoverable errors |
