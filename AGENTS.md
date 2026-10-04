# AGENTS.md

Guidance for agentic coding tools working in this repo. See `README.md` for the
product overview; this file is about how to build, test, and change the code.

## Project

LAN score sheet for playing **Kniffel** (Yahtzee) with real dice, plus an
optional 3D virtual-dice table. Node + Express backend, vanilla-JS frontend,
no build step, no framework, no bundler. The server inlines `public/sheet.css`
and `public/sheet.js` into `public/index.html` and serves one self-contained
HTML response.

## Commands

```bash
npm install            # install deps (express, selfsigned)
npm start              # run server on https://localhost:3000
npm test               # rules unit tests (test-rules.js) — no server needed
npm run test:rules     # alias of npm test
npm run test:api       # end-to-end API tests — needs a live server on 3199
```

End-to-end API tests require a server first:

```powershell
# terminal 1
$env:PORT=3199; npm start
# terminal 2
npm run test:api
```

There is no lint or typecheck script. Use `node --check <file>` for a syntax
check on any JS file you edit.

### Env vars

| Var             | Default           | Meaning                                    |
| --------------- | ----------------- | ------------------------------------------ |
| `PORT`          | `3000`            | Listen port (HTTPS unless disabled).       |
| `KNIFFEL_HTTPS` | `1`               | `0` = serve plain HTTP.                    |
| `KNIFFEL_CERT`  | `data/cert.json`  | Cached self-signed cert.                   |
| `KNIFFEL_DATA`  | `data/games.json` | Game archive (JSON).                       |

## Architecture

```
server/
  index.js    Express app: REST API, game state, archiving
  rules.js    Scoring rules, validation, win-probability model
  store.js    JSON archive (atomic writes)
  certs.js    Self-signed TLS cert (generated + cached)
  page.js     Inlines public/ assets into the single served page
public/
  index.html  Page shell with __SHEET_CSS__ / __SHEET_JS__ placeholders
  sheet.css   Styling
  sheet.js    Client: polling, rendering, dice, animations
  vendor/     three.min.js (r0.159) + cannon-es.js (0.20.0), lazily loaded
test-rules.js Rules unit tests
test-api.js   End-to-end API tests
data/         Runtime archive + TLS cert (gitignored)
```

## Key facts / gotchas

- **No build step.** The served page is rebuilt on every request, so edits in
  `public/` show up on a plain reload — no server restart needed.
- **Vanilla JS only.** Follow existing style: 2-space indent, single quotes,
  semicolons, no comments unless they add real value.
- **Classic scripts, not ES modules**, on the client. Vendor libs are loaded via
  `loadScript()` to keep it LAN/offline safe (avoids ESM/CORS issues).
- **cannon-es is vendored as an IIFE** exposing `window.CANNON` (the npm dist is
  pure ESM with no global). Don't replace it with an ESM import.
- **Virtual dice are display-only.** Scores are always entered manually on the
  sheet. Physics decides faces; `readTopFace()` reads whichever face points up
  when the body sleeps — there are no scripted target faces.
- **HTTPS is required** for phone motion sensors (shake to roll). Self-signed
  cert is generated on first start.
- **Port 3000** may be occupied by a dev server; use `$env:PORT=3199` for tests.
- On Windows, old PowerShell `Invoke-WebRequest` lacks `-SkipCertificateCheck`.
  Use `node -e` with `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` + `fetch`
  to hit the HTTPS dev server programmatically.
- Dice face mapping (BoxGeometry order `[+X,-X,+Y,-Y,+Z,-Z]`):
  `faceValues = [3, 4, 2, 5, 1, 6]` (opposite faces sum to 7).

## Testing guidance

- Rules logic → `test-rules.js` (`npm test`). Add cases here for scoring changes.
- REST behavior → `test-api.js` (`npm run test:api`), server on port 3199.
- Both suites exit non-zero on failure and print `PASS`/`FAIL` lines.
- Always run the relevant suite plus `node --check` on edited JS before finishing.
