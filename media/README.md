# Media

Images for Devpost and the pitch. The four 1600x900 graphics are rendered from `src/`:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --virtual-time-budget=6000 --window-size=1600,900 \
  --screenshot=cover.png "file://$PWD/src/cover.html"
```

`proof-*.png` are screenshots of the real app: seed a verified day with
`pnpm --filter @chalk/scripts exec tsx seed-demo-day.ts --links 3 --settle`, then screenshot
`/#/t/<wallet>/<day>`.
