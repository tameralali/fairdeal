# The Aquarium

Private online poker for a home game. It plays like PokerNow (share a link, approve seats, track the ledger), only members you invite can get in, and every deal can be checked by the players themselves.

## What it does

**One club, in dollars and cents.** The site is a single club, The Aquarium, and every account is in it. All amounts are dollars and cents, down to $0.01 (blinds of $0.10/$0.25 work). The home page is the club: your balance, the games running now, every member's balance, credit limit and net from play, the ledger of every movement, and all-time stats. Admins add to or take from balances, set credit limits and settle up from there (on a phone, tap a member). The home page, the sign-in page and the hand checker wear the table's green felt, with brass buttons and cream text.

**Start a game.** Admins open games from a pop-out that sets the format, stakes and seats, players needed to start, the clock, bomb pots, running it, the rathole time, what happens to folded cards, and seating. It remembers the last game.

**Presets.** Any setup can be saved as a named preset, shared by every admin. Presets show under Start a game on the home page and at the top of the pop-out: one click fills in everything, and a preset can be updated or deleted from there.

**Players to start.** The first hand waits until a set number of players are in (2 to the table size). After that, play goes on with two or more.

**Rathole time.** A player who stands up and sits back down at the same table within the set time (30 minutes to 4 hours, or the rest of the game) has to bring at least the stack they left with, even above the maximum. The seat form fills that amount in and says until when it applies.

**Format.** No Limit Hold'em, Pot Limit Omaha (4 cards) and PLO5, played as a list of steps that repeats: each step is one game for a number of orbits (1 to 50) or a number of hands (1 to 500), on one board or two. For example 2 orbits of PLO, then 10 hands of hold'em on a double board, then back to PLO. An orbit ends when the button has gone around the table once. Quick picks cover the usual mixes. Up to 10 seats; the seat limit drops when the deck can't deal everyone (9 with PLO5, 8 with PLO5 on two boards).

**Double board.** Two boards are dealt, board 1 then board 2 on each street, and every pot is split between them. It can be set per format step and for bomb pots, and it works with running it more than once (two boards per run).

**Bomb pots.** Every N hands, a random percentage of hands, both (at least every N hands, and the chance can bring one sooner), or called by the host for the next hand. The bomb pot size is set in big blinds, a bomb pot can be played as a different game from the one running, and it can be dealt on two boards. Everyone puts the size in, there is no preflop betting, and the flop comes straight away. Random bomb pots are decided from the hand's sealed seed, so players can check they were not picked by hand. The size is the only ante there is: other hands have none, and with bomb pots off the size, game and board fields are hidden and nothing about them has to be filled in.

**Run it once to four times.** When everyone is all in before the river (preflop, on the flop or on the turn), the players in the hand pick how many times to run it, before any cards are turned over. Picks are open: each player's pick shows on their seat for the whole table and on everyone's vote buttons (the number someone else picked carries their name, and numbers nobody picked are dimmed), and anyone can change theirs while the vote is open. If everyone picks the same number, it runs that many times straight away. A pick of once settles it at once. If everyone has picked but the numbers differ, there are 8 seconds to settle on one; with no agreement by then, or after 20 seconds in all, it runs once. A player who has left or lost their connection is not waited for: the others decide between them, though a pick made before someone dropped still counts. Look and feel can pick for you: always once, or go with whatever number the others pick. The host sets the most runs allowed (2, 3 or 4). Every pot, side pots included, is split across the runs. Extra runs come off the same sealed deck, so in very full PLO5 pots the deck can limit how many runs are possible. A river all-in has nothing left to deal, so there is no vote.

**Host controls.** Approve or decline seat requests and rebuys (or approve automatically), set a player to sitting out, remove a player, adjust stacks, pause after the current hand, end the game, and change any setting between hands. Every change is written to the table log.

**Time.** Seconds per decision, a time bank per player, and a game length. A table that deals on its own starts the clock with its first hand. When the game length runs out, the hand in progress finishes and everyone is cashed out. The host can add time or remove the limit. Players who run out of time are checked or folded and sat out until they click "I'm back".

**In-game ledger.** Buy-ins, cash-outs, current stack, net, hands played, VPIP, PFR and aggression for everyone who played, and CSV download. Pick a player for their sheet: money, every stat, and their biggest wins and losses, each one a click from the replayer.

**Live stats.** VPIP, PFR, 3-bet, fold to 3-bet, ATS (attempt to steal), fold to steal, AF and AFq (aggression), c-bet, fold to c-bet, WTSD, W$SD, WWSF, net and bb/100, updated after every hand. They can be shown for this game or all games in the club, for every game type or one of them. Each seat shows VPIP / PFR / AF and the hands behind them for the game being played (Look and feel turns this off or switches it to all games). Bomb pots have no preflop betting, so they only count toward the numbers after the flop. Members see how everyone plays; other members' results follow the club's ledger setting.

**Replayer.** Every hand can be replayed step by step after it ends: blinds, each action, each street as it was dealt (when a hand is run more than once, each run goes flop, turn, river in turn), and the result, with play, step, a jump to the next street and a slider. The hand list sorts by newest, biggest pots, or anyone's biggest wins and losses (yours by default). The replayer shows cards the way the hand history does: your own, cards shown at showdown, and every card once that hand's seed is revealed.

**Club ledger.** Members hold a balance across games. Admins add or take money with a note, set a credit limit per member (how far below zero they may buy in), record settlements, and choose whether members can see everyone's balance and send money to each other. Tables seat members straight from their balance and pay back into it when they stand up, so games run without an admin present. Every movement is a ledger entry with the balance after it, downloadable as CSV.

**The table.** A green felt with The Aquarium on it, in a charcoal room. Each player is a dark box with their name and stack, their cards fanned over its left end. Cards are white with a fat-face number and a big suit low on the right; in a hand a small suit sits under the number, and other players' cards turned face up have a rose tint and a white rim. Cards are dealt one at a time: one to each player, starting left of the button, then the next round, each coming from the middle of the table, and board cards are turned over one after another, with short pauses between streets. Bets sit in front of each player on the felt, the pot is in the middle with the total including bets above it, and the dealer button rides on the dealer's box. Folded players show an X. When everyone left is all in with cards face up, each hand shows its chance of winning the run being dealt, worked out in the browser from the cards on the table (folded cards count as unknown, so nobody learns anything they could not already see). Shown hands and your own hand are labelled with what they make, chat appears in a bubble by the player's seat for a few seconds, and amounts show their cents. Sounds are made in the browser: a call when it is your turn, chips for bets and calls (a bigger push for raises and all-ins), a card slide for a fold, two knocks for a check, a flick for each card dealt, and the pot going to the winner. Browsers allow sound only after the first tap or key press on the page. The layout fits seats to the screen, from a phone held upright to a big monitor.

**Look and feel.** Four-color deck by default (spades black, hearts red, diamonds blue, clubs green) or two colors, large-index or classic card faces, felt color (the host sets the default, each player can override it), five card backs, the turn sound and the table sounds (each can be turned off), how to pick when everyone is all in, and a readout of what your hand makes. These are saved per browser. Fonts are Lato and Abril Fatface (SIL Open Font License, served from the app).

**Folded cards.** Three choices per game: hidden for good (the default), shown in the hand history after each hand, or shown when the game ends. With hidden for good, nobody ever sees another player's folded cards, and after a hand each player can show any of their cards, one at a time or all of them. The deal is still checked; see version 2 below.

**Hand history.** Every hand with its cards, results and actions, plus the full log and ledger as downloads.

**Any screen.** The table fits laptops, big monitors, tablets and phones held either way. On a phone on its side the controls move to a column at the right so the table keeps its height; on big monitors the bars grow with the table.

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

**Version 2: folded cards hidden for good.** Revealing a seed shows every card, so games where folded cards stay hidden seal each card on its own instead:

1. Before the hand the server shuffles a base deck from its secret seed and seals every position i with SHA-256 of the position, the card and a secret 128-bit salt. The published seal is SHA-256 of all 52 card seals and the fingerprint of a secret key.
2. Players add their random inputs as before. HMAC-SHA256(key, all inputs) drives a Fisher-Yates shuffle of the 52 positions, so the server could not know where any card would end up when it sealed the deck.
3. After the hand the server reveals the key and opens (position, card, salt) for every card that was seen or never dealt: the boards, cards players showed, and the rest of the deck. Folded cards are published only as their seals. Each player's own cards are opened to that player alone.
4. Every browser rebuilds the published seal from the opened cards and the sealed ones, recomputes where each card went, and checks the boards, every shown card, its own cards and its own input. A card that was moved, swapped or renamed breaks the seal.

What version 2 gives up: nobody can check another player's folded cards, so a deck with a repeated card among folded hands could not be caught. The cards that were seen are all checked.

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
docker build -t the-aquarium .
docker run -p 3000:3000 -v aquarium-data:/data the-aquarium
```

Serve it over HTTPS (Render and Fly do this automatically). Settings come from environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where accounts, clubs, ledgers, hand records and logs are stored |

## Accounts and invites

The Aquarium is invite only. Nobody can see a table, a club or the lobby without an account, and an account can only be made from an invite link.

- **The owner.** When the site has no owner, the server prints a one-time setup link in its log at every start (on Render: the service's Logs tab). Opening it creates the owner's account, or makes an existing account the owner.
- **Admins.** The owner makes and removes admins on the People page. Admins and the owner invite people by email (they join the club straight away), start games, look after the club ledger and send members password reset links. Only the owner changes admins or turns someone's access off (that signs them out everywhere; their balances stay as they are).
- **Invite links** work once, only for the email address they were sent to, and expire after 1 to 30 days. The invitee picks their own username and password. An admin can send a fresh link (the old one stops working) or cancel it.

**Sending the emails.** With these two settings the site emails invites and reset links from your Gmail:

| Variable | Value |
| --- | --- |
| `SMTP_USER` | your Gmail address |
| `SMTP_PASS` | a Gmail app password (Google Account, Security, 2-Step Verification on, then App passwords) |

Other providers also need `SMTP_HOST` and `SMTP_PORT`, and `MAIL_FROM` changes the sender name. Without them nothing is emailed: the admin gets the link to copy and send.

A forgotten owner password can also be reset on the server itself:

```
node scripts/reset-password.js <username> <new password>
```

**Moving to one club.** The first start of this version turns an older site into the single club: the owner's club (or the oldest one) becomes The Aquarium (renamed, which Club settings can change), every account becomes a member, and anyone who managed it becomes an admin. A club kept in whole chips moves to dollars with 1 chip = $1.00; games still running in chips are ended first, so everyone's chips go back to their balance. Older games keep showing the chips they were played with.

## Backups

Everything lives in the data folder: `db.json` (accounts, clubs, club ledgers, table settings and table ledgers), `hands/` (one file per table, every hand with its seed and cards) and `logs/`. Copy the folder to back it up. If the server restarts during a hand, that hand is cancelled, stacks go back to where they were when it started, and seated players are set to sitting out until they return.

## Moving to a new server

The data folder can be handed from one running server to another, for example to a new Render address. Start the old server with `MIGRATION_EXPORT=on` and a long random `MIGRATION_KEY`, and the new one with `IMPORT_FROM=<old server URL>` and the same key. On its first boot, while its data folder is empty, the new server shows a short "moving in" page, copies every account, club, ledger, table and hand from the old one, then starts. From that moment the old server forwards every visitor to the new address and accepts no more changes. Logins carry over (players sign in once on the new address). On Render, `RENDER_EXTERNAL_URL` tells the old server where to send people; elsewhere, set it on the new server yourself. Remove `IMPORT_FROM` and the key once the move is done.

## Tests

```
npm test
```

67 tests: hand rankings including the Omaha two-card rule; betting rules (heads-up order, incomplete all-in raises, pot-limit maximums, side pots, uncalled bets); the run-it vote (the same number from everyone runs it that many times, picks open to the table and changeable, once settles it, no agreement runs it once, going with the others, players who left not waited for, cards face down while voting, and on a live table the short time to settle different picks); double board pot splits and double board run several times; 6,000 random hands across all three games, on one board or two, checking that chips are conserved and every card can be rebuilt from the seed; full games against a running server with bot players covering approvals, rebuys, the format steps, double board bomb pots, multi-run all-ins, time limits and browser-side verification of every hand; the club flow with credit limits, buy-ins, cash-outs and settlements; the move to one club in dollars and cents; every stat on scripted hands and on 60 bot-played hands (hands, percentages in range, results matching the ledger); the replayer on scripted and bot-played hands (money adds up at every step and ends on the real stacks, and each run is dealt street by street); format steps by orbits and by hands; sealed hands (every player checks every hand, no copy of a record holds another player's folded cards, a partial show opens only that card, tampering fails); players to start; bomb pots on a schedule and by chance together; the rathole rule; presets; all-in chances (exact on the flop and turn, folded cards left unknown, ties and two boards split) and hand labels; the bomb pot size only checked with bomb pots on; the old default felt moving to the new one; invite-only access (refused sign-ups, the owner link, email-bound single-use invites, roles, password resets, turning access off, a failed email); and moving the data to a new server.

## Layout

```
server/        Express + Socket.io server
  engine/      one hand of poker (betting, pots, runs, showdown)
  table.js     seats, host controls, timers, ledger, commit and reveal
  clubs.js     the club: balances, credits, settlements, transfers
  stats.js     player stats from hand records
shared/        code used by both server and browser: cards, hand evaluator, fairness, money, replayer steps, all-in chances
public/        the web app: home (club balances, ledger and stats), start a game, table, verifier
scripts/       maintenance scripts
test/          automated tests
```

## Not included yet

Tournaments, straddles, antes outside bomb pots, and voice chat.
