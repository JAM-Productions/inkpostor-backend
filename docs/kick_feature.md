# Kick Feature Mechanics & States

The Inkpostor game supports two distinct types of player removal depending on the current game phase:

## 1. Lobby Kick (Admin Only)
- **Phase:** `LOBBY`
- **Trigger:** The room host clicks the kick button on a player.
- **Rules:**
  - Only the host can kick players.
  - The host cannot kick themselves.
- **Outcome:**
  - The kicked player is immediately removed from the `room.players` array.
  - The kicked player is added to `kickedFromRoom[roomId]`, an in-memory blocklist.
  - The backend emits a `kicked` socket event to the target player, who then disconnects from the room.
  - The player **cannot rejoin** the room unless the host clicks "Play Again" (which clears the blocklist).

## 2. Mid-Game Vote-Kick (Democratic)
- **Phases:** `DRAWING`, `VOTING`
- **Trigger:** A player clicks the kick button next to another player's name in the UI.
- **Rules:**
  - Any connected, active player can initiate or add a vote against another.
  - Votes act as a **toggle**: clicking again removes your vote.
  - **Threshold required:** All connected, non-ejected players (except the target) must agree.
    - Example: In a 4-player game with all active, 3 votes are required to kick someone.
- **Outcome:**
  - The target is marked `isEjected = true` and `isConnected = false`.
  - The player's current turn is immediately skipped if they were drawing.
  - The player is added to the `kickedFromRoom` blocklist so they cannot reconnect during the game.

---

## Game States and Win Conditions after Vote-Kick

When a vote-kick successfully ejects a player, the server immediately evaluates whether the game should end based on the following rules:

| Ejected Player Role | Impostor Status | Resulting State | Winning Team | Description |
|---|---|---|---|---|
| **Impostor** | N/A | `RESULTS` | 🟢 Crewmates | The Impostor was successfully identified and kicked. `ejectedId` is set to the Impostor's ID. |
| **Crewmate** | Still active | `RESULTS` | 🔴 Impostor | A crewmate was wrongly kicked, and the total active player count dropped below 3. `ejectedId` is set to the kicked crewmate. The Impostor wins. |
| **Crewmate** | Disconnected | `RESULTS` | 🟢 Crewmates | A crewmate was kicked, dropping the active count below 3, BUT the Impostor is no longer in the game. `ejectedId` is set to the Impostor's ID. Crewmates win by attrition. |
| **Crewmate** | Active, players ≥ 3 | Phase continues | None (Game Continues) | A crewmate was kicked, but there are still enough players to continue the game. The turn advances to the next player. |

## Resetting the Kick Blocklist
The in-memory blocklist (`kickedFromRoom`) is strictly scoped to a single game session.
When the host clicks **Play Again**, the blocklist for that room is cleared entirely. This allows previously kicked players to be re-invited to join a fresh game. Furthermore, players who were ejected mid-game are removed entirely from the new lobby state.
