# The Aquarium

Private online poker for a home game. It plays like PokerNow (share a link, approve seats, track the ledger), only members you invite can get in, and every deal can be checked by the players themselves.

## What it does

**One club, in dollars and cents.** The site is a single club, The Aquarium, and every account is in it. All amounts are dollars and cents, down to $0.01 (blinds of $0.10/$0.25 work). The home page is the club: your balance, the games running now, every member's balance, credit limit and net from play, the ledger of every movement, and all-time stats. Admins add to or take from balances, set credit limits and settle up from there (on a phone, tap a member). The home page, the sign-in page and the hand checker are dark, with the felt's green in the buttons, highlights and a faint glow at the top. Each game opens in its own tab, so the club page stays open in the first one; starting a game opens it in a new tab too. Admins can end a game from the club page (End game on its row) or at the table (End game at the bottom of Options): the hand in progress finishes, then everyone is cashed out to their balance.

**Start a game.** Admins open games from a pop-out that sets the format, stakes and seats, players needed to start, the clock, bomb pots, running it, the rathole time, what happens to folded cards, and seating. It remembers the last game.

**Presets.** Any setup can be saved as a named preset, shared by every admin. Presets show under Start a game on the home page and at the top of the pop-out: one click fills in everything, and a preset can be updated or deleted from there.

**Players to start.** The first hand waits until a set number of players are in (2 to the table size). After that, play goes on with two or more.

**Rathole time.** A player who stands up and sits back down at the same table within the set time (30 minutes to 4 hours, or the rest of the game) has to bring at least the stack they left with, even above the maximum. The seat form fills that amount in and says until when it applies.

**Format.** No Limit Hold'em, Pot Limit Omaha (4 cards) and PLO5, played as a list of steps that repeats: each step is one game for a number of orbits (1 to 50) or a number of hands (1 to 500), on one board or two. For example 2 orbits of PLO, then 10 hands of hold'em on a double board, then back to PLO. An orbit ends when the button has gone around the table once. Quick picks cover the usual mixes. Up to 10 seats; the seat limit drops when the deck can't deal everyone (9 with PLO5, 8 with PLO5 on two boards).

**Double board.** Two boards are dealt, board 1 then board 2 on each street, and every pot is split between them. It can be set per format step and for bomb pots. A double board hand is run once only, bomb pot or not: the two boards already split the pot two ways, so there is no vote to run it again. (Hand records from before this rule, run twice on two boards, still replay and check.)

**Bomb pots.** Every N hands, a random percentage of hands, both (at least every N hands, and the chance can bring one sooner), or called by the host for the next hand. The bomb pot size is set in big blinds, a bomb pot can be played as a different game from the one running, and it can be dealt on two boards. Everyone puts the size in, there is no preflop betting, and the flop comes straight away. Random bomb pots are decided from the hand's sealed seed, so players can check they were not picked by hand. The size is the only ante there is: other hands have none, and with bomb pots off the size, game and board fields are hidden and nothing about them has to be filled in.

**Run it once to four times.** When everyone is all in before the river (preflop, on the flop or on the turn), the players in the hand pick how many times to run it, before any cards are turned over. Picks are open: each player's pick shows on their seat for the whole table and on everyone's vote buttons (the number someone else picked carries their name, and numbers nobody picked are dimmed), and anyone can change theirs while the vote is open. If everyone picks the same number, it runs that many times straight away. A pick of once settles it at once. If everyone has picked but the numbers differ, there are 15 seconds to settle on one; with no agreement by then, or after 45 seconds in all, it runs once, so a big pot has time to be talked over. A player who has left or lost their connection is not waited for: the others decide between them, though a pick made before someone dropped still counts. Look and feel can pick for you: always once, or go with whatever number the others pick. The host sets the most runs allowed (2, 3 or 4). Every pot, side pots included, is split across the runs. Extra runs come off the same sealed deck, so in very full PLO5 pots the deck can limit how many runs are possible. A river all-in has nothing left to deal, so there is no vote.

**Host controls.** Approve or decline seat requests and rebuys (or approve automatically), set a player to sitting out, remove a player, adjust stacks, pause after the current hand, end the game, and change any setting between hands. Every change is written to the table log.

**Time.** Seconds per decision, a time bank per player (20 seconds by default, refilled 5 seconds for every 10 hands dealt to that player; presets and saved settings still on the old 60-second default move to 20), and a game length. The time bank is used only when you ask for it, as on PokerNow: Activate extra time (or T) on your turn adds 10 seconds from it, or what is left if less. When the seconds to act run out, you are checked or folded. A table that deals on its own starts the clock with its first hand. When the game length runs out, the hand in progress finishes and everyone is cashed out. The host can add time or remove the limit. Players who run out of time are checked or folded and marked Away until they click "I'm back". After a hand there is a short pause before the next one (4 seconds when everyone folded, 7.5 after a showdown), time to show cards. The host can also start a clock in the middle of a game (30 minutes, 1, 1½ or 2 hours, from Clock in the top bar or Options, Time), then add time or remove it; clicking the countdown in the top bar opens the same controls.

**In-game ledger.** Buy-ins, cash-outs, current stack, net, hands played, VPIP, PFR and aggression for everyone who played, and CSV download. Pick a player for their sheet: money, every stat, and their biggest wins and losses, each one a click from the replayer.

**Live stats.** VPIP, PFR, 3-bet, fold to 3-bet, ATS (attempt to steal), fold to steal, AF and AFq (aggression), c-bet, fold to c-bet, WTSD, W$SD, WWSF, net and bb/100, updated after every hand. They can be shown for this game or all games in the club, for every game type or one of them. Each seat shows VPIP / PFR / AF and the hands behind them for the game being played (Look and feel turns this off or switches it to all games). Bomb pots have no preflop betting, so they only count toward the numbers after the flop. Members see how everyone plays; other members' results follow the club's ledger setting.

**Hand history and replayer.** Hands opens one screen: every hand of the game in a list on the left, and the replayer on the right. Player picks whose hands to list: Everyone, or one player, which lists only the hands they were dealt into, with their result in each. The list sorts by newest, oldest, biggest pots, biggest wins or biggest losses (for one player, theirs; for everyone, the biggest single win or loss in each hand), can show only showdowns, all-ins or bomb pots, and can be narrowed to one game; each row has the hand number, the chosen player's result for that hand in green or red (for everyone, the pot and who won the most), their cards and the time, and the total for the hands listed sits at the top. The replayer goes step by step: blinds, each action, each street as it was dealt (when a hand is run more than once, each run goes flop, turn, river in turn) and the result, with a bar of steps marked F, T and R to jump to. Stepping past the end of a hand carries on into the next hand of the list, Play does the same after a short pause on the result, and the buttons either side go straight to the previous or next hand (arrow keys: left and right step, up and down change hands, space plays). Details shows the full record and this browser's deck check for the same hand. A finished game opens on its hand history. On a phone the replay fills the screen and Hands brings up the list. The replayer shows cards the way the hand history does: your own, cards shown at showdown, and every card once that hand's seed is revealed.

**Straddle.** With Allow a straddle on (Options or Start a game), each player can turn on Straddle in the bar at the bottom: whenever they are under the gun they post twice the big blind before the deal, a live blind, so action starts after them and they act last before the flop with the option to raise. Three players at least, not in bomb pots, and only with more than the straddle behind. Their seat shows Straddle and the replayer says who straddled.

**The 7-2 game.** Set a bounty (Options or Start a game) and a Hold'em hand won, all of the pot or part of it, holding a 7 and a 2 of any suits, with both cards shown, collects that bounty from every other player dealt in, up to what each has. Won at a showdown, it is paid at once; won when everyone folded, it is paid the moment the winner shows both cards (the bar reminds them). Two winners holding 7-2 collect nothing. The bounty is announced on the table, logged, kept with the hand, and counted in every result and stat. The top bar shows the bounty while the game is on.

**A game's page.** A finished game opens its own page from the club's games and from Results: who won the game, each player's net, buy-in, what they took home, hands played and pots won, highlights (biggest pot, biggest win and loss, best hand shown, most pots won, 7-2 bounties, hands run more than once), the biggest hands largest pot first (each opens the replayer on that hand), and the game's stats. A game still going shows the same page with the numbers so far.

**Settling up.** Settle on a member asks who they paid, or who paid them: pick that player and the amount (it suggests the smaller of the two balances) and one settlement is written as a pair of entries, plus for one player and minus for the other, each naming the other and how it was paid. Settling with the club in cash, which sets the balance to zero, is still there.

**Results.** The club page has a results leaderboard that adds up every game: each player's net, games played and won, hands, best and worst game and when they last played, biggest winner first. Results and stats both take a period: all time, the last 7, 30 or 90 days, this year, or any two dates. Other members' results follow the same rule as the ledger: admins see them, members only when the club settings allow it.

**Clearing history.** The owner can clear everything played from Club settings, after typing CLEAR: every game with its hands and log, the club ledger and all stats go, and every balance is set to zero. Accounts, roles, credit limits, presets, invites and the join link stay. Anyone at a game is told it was removed.

**Club ledger.** Members hold a balance across games. Admins add or take money with a note, set a credit limit per member (how far below zero they may buy in), record settlements, and choose whether members can see everyone's balance and send money to each other. Tables seat members straight from their balance and pay back into it when they stand up, so games run without an admin present. Every movement is a ledger entry with the balance after it, downloadable as CSV.

**The table.** A green felt with The Aquarium on it, in a charcoal room. Each player is a dark box with their name and stack, their cards fanned over its left end. Cards are drawn like PokerNow's: white, with a heavy serif number (Abril Fatface in bold) and a big suit low on the right, red and black by default; in a hand a small suit sits under the number. Amounts on the table, in its log and in the hand history have no dollar sign (the club pages keep it). Cards are dealt one at a time: one to each player, starting left of the button, then the next round, each coming from the middle of the table, and board cards are turned over one after another, with short pauses between streets. Bets sit in front of each player on the felt, the pot is in the middle with the total including bets above it, and the dealer button rides on the dealer's box. Folded players show an X. Free seats are dashed boxes with the seat number in the corner, as on PokerNow, with SIT in the middle for someone who can take one; once you are seated they are not drawn at all. No box, name or card ever covers the board: on a computer, seats keep above or below it where there is room, as on PokerNow, and wherever a box, its cards or a bet would still reach over it, the middle of the table is drawn just small enough to keep clear (checked for every table size, from heads-up to ten, on one board or two). The board stays put when the results come in under it. When everyone left is all in with cards face up, each hand shows its chance of winning the run being dealt, worked out in the browser from the cards on the table (folded cards count as unknown, so nobody learns anything they could not already see). Shown hands and your own hand are labelled with what they make; when a hand is run more than once (or dealt on two boards) each player gets one small numbered label per board, green where they won it, and each run names its winner beside its board (on two boards a run, under each board). Once a hand is over, tapping your own cards shows them, one at a time, as well as the Show buttons. Chat appears in a bubble by the player's seat for a few seconds, and amounts show their cents. Card and chip sounds are recordings from Kenney's Casino Audio pack (CC0, kenney.nl; the license is in `public/sounds`): a card slid to each player as it is dealt, a card placed for each board card, cards shoved away for a fold, chips stacked for a call, a clink for a bet, a handful for a raise, a big push for an all-in, and the pot swept to the winner, each with a few takes picked at random. Every take is cut to start on its hit and kept short, most under a tenth of a second, and your own action sounds the moment you press it rather than when the table answers. The call when it is your turn, two knocks for a check and the host's request chime are made in the browser, and stand in for any recording that has not loaded yet. Browsers allow sound only after the first tap or key press on the page. The layout fits seats to the screen, from a phone held upright to a big monitor.

**On a computer.** As on PokerNow, there is no bar across the top: the table spreads across the window and everything else sits in its corners, sized with the window. Top left, The Aquarium (back to the club) and a menu down the side: Options (game options, ledger, stats, look and feel, the sealed deck), Hands, and, once you are seated, Away or I'm back, Add chips, Straddle (when the game has it), Call 30 (or the time left and Stay) and Leave seat. Top right, the game, the next game when they take turns (with the orbit), the blinds and the bomb pot count, with the 7-2 game, the straddle and the game clock under them, beside the sealed deck and a button that turns the sounds off and on. Bottom left, Log / Ledger (L) with the table's name beside it, the chat (M to write, the arrows to make it taller) and the voice box. Bottom right, the buttons.

**The action bar.** PokerNow's buttons: Call and the amount, Raise (or Bet), Check and Fold, dark and outlined in their colour (green, red for fold, grey when they do nothing), each with its key in a gap in the top edge (C, R, K, F). Above them on your turn, Your turn with the seconds left, and Activate extra time (T). Raise opens a panel over the table with the amount, the bet sizes (min, half pot, three quarters, pot, and all in at no limit), a big slider and Raise to; Enter raises and Escape or Back closes it. For a seated player the buttons stay where they are all game, so the table never shifts as the turn moves round: when it is not your turn the same places hold pre-clicks while you are in the hand (Call and the amount or Call any, Check, Check/Fold or Fold), carried out the moment it is your turn and dropped once they no longer fit, or sit greyed out. After a hand a green panel shows your cards, all of them (Show all cards, S) or one at a time (1 to 5). While you are away, one big I'm back button takes their place. On a phone the buttons under the table give way to your turn in the same space, and the mute button comes along into the row. The run-it vote sits over the same space.

**Chat.** On a computer the chat sits bottom left, as on PokerNow: the latest messages, the balloon (or M) to write one, and Log / Ledger (or L) above it to open the log with the ledger over the right of the table. In a narrower window it is on the right, with Chat (a conversation, yours on the right) and Log (everything that happened, chat included) as two tabs, and Hide to close it; Chat in the top bar shows how many messages came in while it was closed. On a phone a chat button sits on the table with the same count, and opens the chat as a sheet from the bottom that keeps the table in view above it and stays above the keyboard.

**Look and feel.** Two colors by default (red and black, as on PokerNow) or four colors (diamonds blue, clubs green), large-index or classic card faces, felt color (the host sets the default, each player can override it), five card backs, the turn sound and the table sounds (each can be turned off), how to pick when everyone is all in, and a readout of what your hand makes. These are saved per browser. Fonts are Mulish (PokerNow's) and Abril Fatface for the card numbers (both SIL Open Font License, served from the app).

**Folded cards.** Three choices per game: hidden for good (the default), shown in the hand history after each hand, or shown when the game ends. With hidden for good, nobody ever sees another player's folded cards, and after a hand each player can show any of their cards, one at a time or all of them. The deal is still checked; see version 2 below.

**Downloads.** Every hand with its cards, results and actions, plus the full log and ledger as downloads.

**Voice chat.** Join voice (in the box beside the chat on a computer, in the bar at the bottom on a phone) asks for the microphone, then Mute and Unmute turn it off and on, and Leave voice ends it. Players and watchers can both join, up to 10 people per table. A microphone on a seat shows who is in voice (crossed out when muted), and the seat glows green while that person is talking; the bar says who else is in. The audio goes straight between browsers (WebRTC, with echo cancellation and noise suppression); the server only says who is in and passes on the messages that set up each connection, so it never hears anything. Joining on a second page or device takes over from the first, and after a reconnect the page joins again by itself. Most home and mobile connections reach each other directly through public STUN servers. Some networks block that; for them, set `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL` to a TURN relay (one on port 443 over TLS gets through most firewalls) and the audio goes through it.

**Calling 30.** Call 30 (in the menu down the left on a computer, in the bar at the bottom on a phone) tells the table a player is leaving in 30 minutes. A countdown shows on their seat for everyone and where Call 30 was, a pot won over 1,000 starts the 30 minutes again (no winning big and walking), and when it runs out they stand up after the hand in progress, their chips going back to their balance. Stay takes it back. Calling it is announced across the top of the table for everyone, with a chime and a clock that sweeps round, and so are a big pot starting it again and Stay. The countdown survives a server restart.

**Fair dealing page.** The club page, the sign-in page and the table's Sealed deck link to /fair, a page anyone can open without an account. It walks a player through checking a hand step by step: at the table (the seal for the next hand, the running count of hands the browser has checked, and Details for one hand), on their own computer with nothing from the site (Copy fingerprint before the deal, Download this hand, then `scripts/verify-hand.js` from a downloaded copy of the code), and a whole game in the verifier. It then explains how each hand is sealed and what the checks do and do not prove, and links the public code on GitHub along with the exact commit the site is running (Render's `RENDER_GIT_COMMIT`; `SOURCE_URL` points the link elsewhere).

**Leaving the page.** A seated player whose page closes (the tab is closed, they go to another page or the connection drops) and who is not back within 5 seconds checks when it costs nothing and folds otherwise, without their clock running down, and sits out from the next hand until they come back and press I'm back. Switching to another tab keeps the page connected, so it does not count, and a quick reload is not leaving.

**Any screen.** The table fits laptops, big monitors, tablets and phones held either way. On a computer the corners grow and shrink with the window; on a phone on its side the controls move to a column at the right so the table keeps its height.

## Proving the shuffle

Players who suspect the deal is rigged can check every hand. The scheme:

1. Before each hand the server picks a secret seed (32 random bytes) and publishes its SHA-256 fingerprint. The table shows it as a seal, a pattern drawn from the fingerprint, so players can compare it by eye.
2. After seeing that seal, each seated player's browser sends its own random input. The server committed to its seed before any input arrived, so it cannot choose a seed that favours anyone.
3. The deck is the standard 52-card order shuffled with Fisher-Yates, driven by HMAC-SHA256(seed, all inputs sorted alphabetically). Cards come off the top in order: hole cards one at a time starting left of the button, then the board, then any extra runs. No burn cards.
4. The seed is revealed after each hand, or when the game ends (host setting). Each player's browser then rebuilds the deck and checks the seal it saw before the deal, that its own input was used, its own hole cards and every board. A line appears in the log for each hand that passes.

Anyone can recheck any hand at `/verify`, which runs entirely in the browser, and can hash the revealed seed with any SHA-256 tool to compare it with the fingerprint. To leave the site out completely, download the hand from Details and check it from a copy of the code (GitHub's Download ZIP is enough, with Node.js 20 or newer):

```
node scripts/verify-hand.js hand-<table>-<number>.json --seal <fingerprint copied before the deal>
```

It runs the same checks with `shared/fairness.js` and Node's built-in cryptography, prints the rebuilt deal (folded cards that stay sealed show as ??), takes several files at once, and exits with 1 if any check fails.

What this proves: the deck was fixed before the deal, nothing was changed after the action started, every card came off that deck in order, and the players' own randomness was part of it. If the server dropped a player's input, that player's check fails.

A hand number only ever gets one seal. The seal for the next hand, and the inputs browsers have already sent for it, are saved with the table, so a restart (every deploy restarts the server) deals that hand from the seal everyone saw, and a browser whose input was lost in the restart sends the same input again. If the host changes how folded cards are kept, the next hand has to be sealed the other way: it takes the next number and the skipped number is noted in the log, so no browser sees two seals for one hand. A browser that saw one seal and was dealt from another would rightly report a failed check.

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

The Aquarium is invite only. Nobody can see a table, a club or the lobby without an account, and an account can only be made from an invite link or approved from the join link.

- **The owner.** When the site has no owner, the server prints a one-time setup link in its log at every start (on Render: the service's Logs tab). Opening it creates the owner's account, or makes an existing account the owner.
- **Admins.** The owner makes and removes admins on the People page. Admins and the owner invite people by email (they join the club straight away), start games, look after the club ledger and send members password reset links. Only the owner changes admins or turns someone's access off (that signs them out everywhere; their balances stay as they are).
- **Invite links** work once, only for the email address they were sent to, and expire after 1 to 30 days. The invitee picks their own username and password. An admin can send a fresh link (the old one stops working) or cancel it.
- **The join link** is one reusable link to post in a group chat, for when invites are not emailed. Anyone who opens it picks a name, username and password (email optional) and asks to join; the request waits under Waiting to join on the club page and on the People page until an admin approves it (the account turns on and joins the club with a zero balance) or declines it (the account is removed, so the username is free again). Until then it cannot sign in. Admins make the link from Invite or the People page, can replace it (the old one stops working) or turn it off. Requests are limited to 5 per 10 minutes from one address and 50 waiting at once.
- **Roles from the club page.** The owner can open any member from Balances and switch them between Member and Admin.

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

85 tests: hand rankings including the Omaha two-card rule; betting rules (heads-up order, incomplete all-in raises, pot-limit maximums, side pots, uncalled bets); the run-it vote (the same number from everyone runs it that many times, picks open to the table and changeable, once settles it, no agreement runs it once, going with the others, players who left not waited for, cards face down while voting, and on a live table the short time to settle different picks); double board pot splits, a double board running once only, and older double board hands run several times still rebuilding and checking; 6,000 random hands across all three games, on one board or two, checking that chips are conserved and every card can be rebuilt from the seed; full games against a running server with bot players covering approvals, rebuys, the format steps, double board bomb pots, multi-run all-ins, time limits and browser-side verification of every hand; the club flow with credit limits, buy-ins, cash-outs and settlements; the move to one club in dollars and cents; every stat on scripted hands and on 60 bot-played hands (hands, percentages in range, results matching the ledger); the replayer on scripted and bot-played hands (money adds up at every step and ends on the real stacks, and each run is dealt street by street); format steps by orbits and by hands; sealed hands (every player checks every hand, no copy of a record holds another player's folded cards, a partial show opens only that card, tampering fails); players to start; bomb pots on a schedule and by chance together; the rathole rule; presets; all-in chances (exact on the flop and turn, folded cards left unknown, ties and two boards split) and hand labels; the bomb pot size only checked with bomb pots on; the old default felt moving to the new one; the next hand's seal and the inputs already sent kept through a restart, for both kinds of seal, and a hand number skipped rather than sealed twice when the seal cannot be kept or the folded-card setting changes; an admin ending a game from the club page (the hand in progress finishes first, members cannot); a player who leaves the page checking or folding at once and sitting out, and a quick reload not counting; the join link (requests, no sign-in until approved, approve, decline freeing the username, replaced and turned-off links, members cannot approve); the hand list never holding another player's folded cards; voice (calls set up only between people in voice, nothing to anyone outside it, only offers, answers and candidates passed on, mutes shown, one page per person, leaving lets go); settling one player against another (a pair of entries, amounts checked, admins only), results over a period adding up each player's hands, stats following the period, and the owner clearing all history (games, hand files, ledger and balances gone, accounts kept, pages at a game told); calling 30 (the countdown for everyone, once only, Stay, a big pot starting it again, standing up when it runs out); the command-line checker (a downloaded hand passes, with or without the seal; a moved card or a wrong seal fails); the straddle (twice the big blind under the gun, action after them, the option, a raise to twice the straddle, none heads-up, short, in bomb pots or for another seat, and on a live table for the player who turned it on); the 7-2 game (paid at showdown, or once both cards are shown after everyone folded, only what each player has, once a hand, not in Omaha, not without 7-2, counted in the hand's results); invite-only access (refused sign-ups, the owner link, email-bound single-use invites, roles, password resets, turning access off, a failed email); and moving the data to a new server.

## Layout

```
server/        Express + Socket.io server
  engine/      one hand of poker (betting, pots, runs, showdown)
  table.js     seats, host controls, timers, ledger, commit and reveal
  clubs.js     the club: balances, credits, settlements, transfers
  stats.js     player stats from hand records
shared/        code used by both server and browser: cards, hand evaluator, fairness, money, replayer steps, all-in chances
public/        the web app: home (club balances, ledger and stats), start a game, table, verifier
scripts/       maintenance scripts, and verify-hand.js to check hands away from the site
test/          automated tests
```

## Not included yet

Tournaments, straddles, and antes outside bomb pots.
