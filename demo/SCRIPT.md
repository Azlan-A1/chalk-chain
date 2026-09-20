# Judging script — 3 minutes

Three roles. **Speaker** talks and never touches a keyboard. **Phone** does the check-in and writes
on the board. **Terminal** runs the cheat commands on the projector.

Before you start: `scripts/demo.sh`, phone registered, proof page open on the projector
(`pnpm demo:cheat projector`), backup video open in another tab, marker in hand.

Spoken lines are in quotes. Everything else is a stage direction.

---

## 0:00 — The problem (20 s)

> "In a lot of countries, about one in four teachers isn't at school on a given day. The fix is
> known: pay teachers for each day they can prove they were in class. A randomized trial in India
> did exactly that and cut absence by 21 points.
>
> The catch is the proof. It used tamper-proof cameras. Today it's phone apps, and those get
> gamed — the same selfie resubmitted for ten days. Once the proof is fake, the money is wasted."

## 0:20 — Let a judge start it (30 s)

**Speaker, to the judges:** > "Pick the moment. Say go whenever you like."

[**Phone** taps *Start check-in*. Three words appear.]

> "These three words come from a Solana block that didn't exist until a second ago. Nobody could
> have known them in advance — not us, not the teacher."

[**Phone** hands the marker over, or writes the words big on the whiteboard, then photographs the
judges with the board in frame.]

> "Now it's a photo of a real class, with words on the board that are seconds old."

## 0:50 — It lands, and it pays (25 s)

[Result screen ticks in. Read the real number off the screen.]

> "Sealed 40 seconds after those words existed. A Solana program — not our server — checked that
> against the chain's own recent blocks. The photo check read the board, counted people, and the
> bonus went out in USDC."

[Point at the projector.]

> "That's the public proof page. A parent, a head teacher or a donor can open it and check the day
> themselves. Right now nobody can: attendance records are written by the people being measured."

## 1:15 — Three cheats, live (40 s)

> "So let's cheat."

[**Terminal:** `pnpm demo:cheat late`]

> "First: take the photo, send it late. The program rejects it. That's not our code being strict —
> the chain itself says those words are too old."

[**Terminal:** `pnpm demo:cheat screen`]

> "Second: photograph a laptop screen showing today's words. The photo check catches the screen."

[**Terminal:** `pnpm demo:cheat edited`]

> "Third, the serious one: take last week's class photo and paste today's words in with AI. Caught —
> we've seen that photo before."

## 1:55 — The part that makes it hard (30 s)

[Wait for the re-check alert on the phone, or trigger it from the Demo panel.]

> "And you can't just show up for five minutes. At random moments, decided by a future block hash
> that nobody can predict, the phone demands a re-check: add three new words *under* the old ones."

[**Phone** writes the new words below the first line and photographs again.]

> "Each new set of words is derived from the previous photo. The board becomes a hash chain written
> in chalk. To fake one photo now, you'd have to fake every photo before it, taken at times you
> couldn't predict."

## 2:25 — Close (25 s)

[**Phone** taps *End school day*. Amount appears on the proof page.]

> "The day settles and the teacher is paid per verified photo, for a fraction of a cent in fees.
>
> Solana is doing something here that a database cannot: it publishes a fresh, unpredictable value
> every few hundred milliseconds, and a program can check how old it is. That's the whole trick.
>
> Everything you just saw runs on a real Solana validator, and it's verified on a real whiteboard
> through a phone camera. 174 tests, 40 end-to-end checks, and every cheat we could think of fails."

---

## If you only get 60 seconds

Do the check-in (0:20–0:50), then `pnpm demo:cheat edited`, then the close. Cut the other two cheats
and the re-check.

## If something breaks

Say what you expected, say what you'll show instead, and play the backup video. Judges forgive a
failed demo; they don't forgive pretending nothing happened. The fallback table is in README.md
in this folder.

## Questions they will ask

**"Why does this need a blockchain?"**
> "Two reasons. The challenge has to be unpredictable and publicly checkable, and Solana produces
> one every few hundred milliseconds. And the program enforces the deadline, so the people being
> paid and the people verifying aren't the same party. On a server, whoever runs it can backdate
> anything."

**"Isn't the photo check the weak point? You're trusting a model."**
> "Yes, today. It's an optimistic check: the result is recorded on-chain and could be disputed.
> Next steps are a dispute window with bonds, several independent verifiers, and random human
> audits. The freshness and the chain of words don't depend on the model at all."

**"Couldn't a teacher just get someone else to write the words?"**
> "They could — a photo proves a class happened, not who taught it. Face matching would close it,
> with consent. Today we make the cheap frauds expensive: reused photos, staged photos, and
> showing up for five minutes."

**"Isn't this surveillance of poorly paid workers?"**
> "It pays a bonus for days proven present; it never docks anyone's salary. A teacher stuck on
> census duty or a flooded road loses a bonus, not their livelihood. And the teachers who do show
> up currently earn exactly what absent colleagues earn."

**"Shouldn't attendance just be managed properly?"**
> "It should. But you can't manage what you can't see, and the register is written by the people
> being measured. This gives a district a signal it doesn't have. Paying on it is one use —
> supervision is another."

**"What's actually on-chain?"**
> "The freshness rule, the chain of words, the surprise re-checks, and the payout. The photo never
> goes on-chain — only its fingerprint. Photos stay on the phone until they're verified, then
> they're deleted."
