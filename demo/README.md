# Demo runbook

One page for whoever presents. Everything below runs on the laptop plus one phone.

## 15 minutes before

```bash
scripts/demo.sh            # fresh chain, services, QR code for the phone
```

- [ ] Phone on the same Wi-Fi opens the QR link, accepts the certificate, and registers a teacher
      (language, school number). Do one full check-in now as a rehearsal, then `scripts/demo.sh` again
      for a clean chain.
- [ ] Laptop: `pnpm demo:cheat projector` opens that teacher's proof page. Leave it on the projector.
- [ ] Terminal ready with the four cheat commands below, font size up.
- [ ] Backup video open in another tab. Phone hotspot ready if venue Wi-Fi dies.
- [ ] Whiteboard, thick marker, and a volunteer to take the photo.
- [ ] Check the printout at the top of `scripts/demo.sh`: vision engine should be `ollama` (local, free,
      no internet needed), re-checks `automatic`.

## The 3 minutes

| Time | Do | Say |
|---|---|---|
| 0:00 | Slide: 1 in 4 teachers absent | "Paying teachers per proven day cut absence by 21 points in a randomized trial. The problem is that the proof gets faked." |
| 0:20 | A judge says "now". Tap **Start check-in**, write the 3 words, photograph the judges | "These words didn't exist until a few seconds ago. They come from Solana's latest block." |
| 0:50 | Result screen: sealed in N s, words ✓, people ✓ | "The Solana program itself checked that the photo was sealed within 95 seconds of those words existing, then paid the bonus." |
| 1:15 | `pnpm demo:cheat late` | "A photo taken earlier and sent late is rejected by the program, not by our server." |
| 1:30 | `pnpm demo:cheat screen` | "Photographing a screen gets caught by the photo check." |
| 1:45 | `pnpm demo:cheat edited` | "Last week's photo with today's words pasted on is caught as a reused photo." |
| 2:05 | Re-check alert fires on the phone: add 3 words under the old ones, photograph again | "Re-checks come at times nobody can predict, decided by a future block hash. Show up for five minutes and you don't get paid." |
| 2:25 | Proof page on the projector, then **End school day** | "Anyone can check this day: the words, the checks, the payout. It costs a fraction of a cent per photo." |

## Commands

```bash
pnpm demo:cheat late        # rejected on-chain: photo sealed after the window closed
pnpm demo:cheat screen      # photo of a laptop screen: fails the photo check
pnpm demo:cheat edited      # old photo + today's words: flagged as reused
pnpm demo:cheat projector   # open the current teacher's proof page
scripts/demo.sh --keep-chain   # restart services, keep teachers and days
scripts/stop.sh                # stop everything
```

## If something breaks

| Problem | Fix |
|---|---|
| Photo check hangs or errors | It falls back after ~75 s. Say so and keep going, or restart with `CHALK_VISION_FALLBACK=mock scripts/demo.sh --keep-chain`. |
| Model reads the words wrong | Thick marker, capitals, no glare, board fills a third of the frame. `vision/bench.py photo.jpg word1 word2 word3` shows what it saw. |
| No re-check fires in time | Phone → Demo panel → **Trigger re-check**. |
| Phone can't reach the laptop | Phone hotspot, reconnect the laptop, re-run `scripts/demo.sh --keep-chain` (the URL changes). |
| Chain or services wedged | `scripts/demo.sh` for a fresh chain (about 30 s). The phone re-registers itself. |
| Everything fails | Play the backup video and narrate it. |

## Questions judges ask

- **Why Solana, not a database?** The freshness window is enforced on-chain by the program: block hashes only a few seconds old, a check anyone can repeat, and payouts at a fraction of a cent per photo. A server that decides both the challenge and the payout is exactly what gets faked today.
- **Couldn't the ministry just run a server?** That's what exists, and photos get reused. Here the challenge comes from a public chain and every check and payment is auditable by parents and donors.
- **Is the photo check trusted?** Yes, today. It's an optimistic check. Next step is a dispute window with bonds, several independent verifiers, and random human audits.
- **What about AI-edited photos?** That's the chain of words. An edit must match every earlier photo in the day, taken at moments the cheater couldn't predict. Detection also uses perceptual hashing for reuse.
- **Privacy of children?** Photos stay on the phone until verified, then get deleted; only hashes go on-chain. Next step is blurring faces on the device before upload.
- **Offline schools?** Check-in by SMS, with the photo uploading later, is on the roadmap. The photo check already runs locally with no internet.

## Numbers worth knowing

- Window: 95 s to chalk the words and take the photo. Re-check window: 3 minutes.
- Bonus: 0.60 USDC per verified photo, paid from a program-owned vault.
- Evidence: Duflo, Hanna & Ryan (2012), absence down 21 percentage points, test scores up 0.17 SD.
- Tests: 153 unit tests, 40 end-to-end checks against a real Solana validator.
- Photo check: about 6 s per photo on this laptop, free and offline (qwen2.5vl:7b through Ollama).
