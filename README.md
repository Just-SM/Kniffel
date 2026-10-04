# Kniffel

A LAN score sheet for playing **Kniffel** (the German name for Yahtzee) with **real dice on a real table** — or with optional **3D virtual dice** in the app. Every phone on the same Wi-Fi joins the same table.

The page is served fully inlined (HTML + CSS + JS in one response), so there are no subresource requests for browser ad-block filter lists to break.

## Quick start

```bash
npm install
npm start
```

The console prints the addresses to open:

- **This PC:** `https://localhost:3000`
- **Phones:** `https://<your-lan-ip>:3000`

The server runs over **HTTPS** by default. A secure context is required for the phone accelerometer (shake to roll). The certificate is self-signed and generated automatically on first start, so each device shows a one-time warning — tap **Advanced → Proceed**. To serve plain HTTP instead, set `KNIFFEL_HTTPS=0` (shake to roll then only works on `localhost`).

Point every player's phone at the LAN URL, each person enters a name, and the host taps **Start game**.

### Shake to roll on iPhone

iPhone only exposes motion sensors to a page whose certificate the phone actually *trusts* — clicking through the warning is not enough:

1. On the phone, open `https://<lan-ip>:3000` and accept the warning.
2. **Settings → General → VPN & Device Management**, tap the downloaded profile, then **Install** it.
3. **Settings → General → About → Certificate Trust Settings**, enable full trust for it.

Android and desktop only need the warning dismissed. Where motion access is unavailable the Roll button is always there to use.

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
- **Virtual dice** *(optional)* — a shared lobby toggle turns on 3D table dice. The active player gets a floating dice button that opens a full-screen top-down table; dice are thrown across the felt and settle, roll up to three times, and tap dice to keep them. On a secure (HTTPS) connection you can **shake the phone to roll**. Falls back to flat dice if WebGL is unavailable. Results are for the table display only — scores are still entered on the sheet.

## Configuration

| Env var         | Default            | Description                                          |
| --------------- | ------------------ | ---------------------------------------------------- |
| `PORT`          | `3000`             | Listen port (HTTPS unless disabled).                 |
| `KNIFFEL_HTTPS` | `1`                | Set to `0` to serve plain HTTP instead of HTTPS.     |
| `KNIFFEL_CERT`  | `data/cert.json`   | Path to the cached self-signed certificate.          |
| `KNIFFEL_DATA`  | `data/games.json`  | Path to the game archive (JSON).                     |

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
  certs.js    Self-signed TLS certificate (generated + cached)
  page.js     Inlines public/ assets into the single served page
public/
  index.html  Page shell with __SHEET_CSS__ / __SHEET_JS__ placeholders
  sheet.css   Styling
  sheet.js    Client: polling, rendering, animations
  vendor/
    three.min.js   Three.js r0.159 (lazy-loaded for the optional 3D dice)
    cannon-es.js   cannon-es rigid-body physics (lazy-loaded for the 3D dice)
test-rules.js Rules unit tests
test-api.js   End-to-end API tests
data/         Runtime game archive + TLS cert (gitignored)
```

## Notes

- The server polls state with plain REST (`/api/state`) every 1.5 s; there is no WebSocket handshake to be blocked.
- The served page is rebuilt on every request, so editing files in `public/` shows up on a plain reload — no restart needed.

## License

No license granted. All rights reserved.
