# Kniffel

A LAN score sheet for playing **Kniffel** (the German name for Yahtzee) with **real dice on a real table**. No dice rolling in the app — you throw the physical dice and just tap in the result. Every phone on the same Wi-Fi joins the same table.

The page is served fully inlined (HTML + CSS + JS in one response), so there are no subresource requests for browser ad-block filter lists to break.

## Quick start

```bash
npm install
npm start
```

The console prints the addresses to open:

- **This PC:** `http://localhost:3000`
- **Phones:** `http://<your-lan-ip>:3000`

Point every player's phone at the LAN URL, each person enters a name, and the host taps **Start game**.

### Firewall

If phones can't reach the PC, allow Node.js through the Windows Firewall (private networks), or once as admin:

```powershell
netsh advfirewall firewall add rule name="kniffel" dir=in action=allow protocol=TCP localport=3000
```

## Features

- **Shared table** — up to 6 players, each device keeps its seat across reloads via a cookie.
- **Seat picker** — a round table view; tap any open seat before the game starts (occupied seats swap).
- **Smart picker** — each category only offers the point values that are actually possible, with a deficit hint for the upper section (`+2`, `−3`, …).
- **Scratch** — enter `0` to cross out a category.
- **Enforced turns** *(optional)* — clockwise by seat; off means free-for-all scoring.
- **One-device mode** *(optional)* — several players share a phone and cycle with `‹` / `›`.
- **Undo** — the player who just scored can take back their last move, even after the turn passed (edits of filled cells are always allowed; new entries follow turn order).
- **Live win-probability chart** — a chess.com-style eval graph built from the move log.
- **History & leaderboard** — finished games are archived and survive restarts.
- **Privacy peek** — hide everyone else's column with one tap.
- **Score reactions** — toasts, screen shake and confetti when someone lands a Kniffel or a straight.

## Configuration

| Env var         | Default            | Description                                  |
| --------------- | ------------------ | -------------------------------------------- |
| `PORT`          | `3000`             | HTTP port.                                   |
| `KNIFFEL_DATA`  | `data/games.json`  | Path to the game archive (JSON).             |

## Testing

Rules unit tests (no server needed):

```bash
npm test
```

End-to-end API test — start a server on port `3199` first, then run the tests in a second terminal:

```bash
# terminal 1
$env:PORT=3199; npm start

# terminal 2
npm run test:api
```

## Project layout

```
server/
  index.js    Express app: REST API, game state, archiving
  rules.js    Scoring rules, validation, win-probability model
  store.js    JSON archive (atomic writes)
  page.js     Inlines public/ assets into the single served page
public/
  index.html  Page shell with __SHEET_CSS__ / __SHEET_JS__ placeholders
  sheet.css   Styling
  sheet.js    Client: polling, rendering, animations
test-rules.js Rules unit tests
test-api.js   End-to-end API tests
data/         Runtime game archive (gitignored)
```

## Notes

- The server polls state with plain REST (`/api/state`) every 1.5 s; there is no WebSocket handshake to be blocked.
- The served page is rebuilt on every request, so editing files in `public/` shows up on a plain reload — no restart needed.

## License

No license granted. All rights reserved.
