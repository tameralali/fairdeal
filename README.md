# FairDeal

Private online poker for a home game. It plays like PokerNow (share a link, approve seats, track the ledger), and every deal can be checked by the players themselves.

## What it does

**Games.** No Limit Hold'em, Pot Limit Omaha (4 cards) and PLO5. Tick more than one to rotate them every orbit (for example one orbit of PLO, then one of hold'em) or every set number of hands. Up to 10 seats, or 9 when PLO5 is in the mix.

**Bomb pots.** Every N hands, a random percentage of hands, or called by the host for the next hand. The ante is set in big blinds and a bomb pot can be played as a different game from the one running. Everyone antes, there is no preflop betting, and the flop comes straight away. Random bomb pots are decided from the hand's sealed seed, so players can check they were not picked by hand.

**Run it once to four times.** When everyone is all in before the river, each player in the hand picks 1 to the host's maximum (2, 3 or 4). The lowest pick is used, so nobody is run more times than they agreed to. Every pot, side pots included, is split across the runs; a player who does not answer within 15 seconds counts as "once". Extra runs come off the same sealed deck, so in very full PLO5 pots the deck can limit how many runs are possible.

**Host controls.** Approve or decline seat requests and rebuys (or approve automatically), set a player to sitting out, remove a player, adjust stacks, pause after the current hand, end the game, and change any setting between hands. Every change is written to the table log.

**Time.** Seconds per decision, a time bank per player, and a game length. When the game length runs out, the hand in progress finishes and everyone is cashed out. The host can add time or remove the limit. Players who run out of time are checked or folded and sat out until they click "I'm back".

**Table ledger.** Buy-ins, cash-outs, current stacks and net for everyone who played, a "settle up" list with the fewest payments that square everyone, and CSV download.

**Clubs.** Members hold a chip balance across games. Managers add or remove chips with a note, set a credit limit per member (how far below zero they may buy in), record settlements, approve new members, and choose whether members can see everyone's balance and send chips to each other. Club tables seat members straight from their balance and pay back into it when they stand up, so games run without a manager present. Every movement is a ledger entry with the balance after it, downloadable as CSV.

**Look and feel.** Felt color (the host sets the default, each player can override it), four-color deck, large-index or classic card faces, five card backs, a turn sound, and a readout of what your hand makes. These are saved per browser.

**Hand history.** Every hand with its cards, results and actions, plus the full log and ledger as downloads.

## Proving the shuffle

Players who suspect the deal is rigged can check every hand. The scheme:

1. Before each hand the server picks a secret seed (32 random bytes) and publishes its SHA-256 fingerprint. The table shows it as a seal, a pattern drawn from the fingerprint, so players can compare it by eye.
2. After seeing that seal, each seated player's browser sends its own random input. The server committed to its seed before any input arrived, so it cannot choose a seed that favours anyone.
3. The deck is the standard 52-card order shuffled with Fisher-Yates, driven by HMAC-SHA256(seed, all inputs sorted alphabetically). Cards come off the top in order: hole cards one at a time starting left of the button, then the board, then any extra runs. No burn cards.
4. The seed is revealed after each hand, or when the game ends (host setting). Each player's browser then rebuilds the deck and checks the seal it saw before the deal, that its own input was used, its own hole cards and every board. A line appears in the log for each hand that passes.

Anyone can recheck any hand at `/verify`, which runs entirely in the browser, and can hash the revealed seed with any SHA-256 tool to compare it with the fingerprint.

What this proves: the deck was fixed before the deal, nothing was changed after the action started, every card came off that deck in order, and the players' own randomness was part of it. If the server dropped a player's input, that player's check fails.

What it does not prove: that whoever runs the server cannot read cards from memory during a hand. That is true of PokerNow and any game dealt by a server. Closing that gap needs a "mental poker" protocol where no single party knows the deck, which is much slower and more complex.

Reveal timing is a trade-off. "After every hand" lets everyone check each hand immediately, but folded cards become visible in the hand history. "When the game ends" keeps folded cards private during play and checks everything at the end. The host can also reveal on demand.

## Run it on your computer

You need Node.js 20 or newer (https://nodejs.org).

```
npm install
npm start
```

Open http://localhost:3000. People on the same Wi-Fi can join at `http://<your computer's local IP>:3000`.

## Put it online

The app is a single Node.js process that keeps live games in memory, so run exactly one instance. It needs WebSockets and a persistent disk for its data folder.

**Render.** Push this folder to a GitHub repository, then in Render choose New, Blueprint, and pick the repository. `render.yaml` creates a web service with a 1 GB disk mounted at `/data`. Use a paid instance: free instances sleep when idle and do not keep a disk, so accounts and ledgers would be lost.

**Docker** (Fly.io, Railway, or any server):

```
docker build -t fairdeal .
docker run -p 3000:3000 -v fairdeal-data:/data fairdeal
```

Serve it over HTTPS (Render and Fly do this automatically). Settings come from environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where accounts, clubs, ledgers, hand records and logs are stored |

## Accounts

Anyone can play with just a name, like PokerNow. Creating an account (username and password) keeps the same identity across devices and is required for clubs, so a balance belongs to a person and not to a browser. There is no email, so to reset a forgotten password, stop the server and run:

```
node scripts/reset-password.js <username> <new password>
```

## Backups

Everything lives in the data folder: `db.json` (accounts, clubs, club ledgers, table settings and table ledgers), `hands/` (one file per table, every hand with its seed and cards) and `logs/`. Copy the folder to back it up. If the server restarts during a hand, that hand is cancelled, stacks go back to where they were when it started, and seated players are set to sitting out until they return.

## Tests

```
npm test
```

25 tests: hand rankings including the Omaha two-card rule; betting rules (heads-up order, incomplete all-in raises, pot-limit maximums, side pots, uncalled bets); 6,000 random hands across all three games checking that chips are conserved and every card can be rebuilt from the seed; full games against a running server with bot players covering approvals, rebuys, game rotation, bomb pots, multi-run all-ins, time limits and browser-side verification of every hand; and the club flow with credit limits, buy-ins, cash-outs and settlements.

## Layout

```
server/        Express + Socket.io server
  engine/      one hand of poker (betting, pots, runs, showdown)
  table.js     seats, host controls, timers, ledger, commit and reveal
  clubs.js     club balances, credits, settlements, transfers
shared/        code used by both server and browser: cards, hand evaluator, fairness
public/        the web app: lobby and clubs, table, verifier
scripts/       maintenance scripts
test/          automated tests
```

## Not included yet

Tournaments, straddles, antes, double-board bomb pots, a hand replayer and player statistics.
