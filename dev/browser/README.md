# Browser checks

Small Node scripts (Node 22+, built-in `fetch` and `WebSocket`) that drive the editor in headless Chrome through
the DevTools protocol. Start Chrome first, and a throw-away server with its own data folder so your own work is
never touched:

```bash
DATA_DIR=$PWD/scratch/testdata PORT=8767 .venv/bin/python serve.py &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9334 \
  --user-data-dir=$PWD/scratch/chrome-test --window-size=1400,900 about:blank &
mkdir -p scratch/export-test          # the self-test exports here
```

| Script | What it does |
|---|---|
| `selftest-run.js <url>` | Opens `<url>` (use `/editor?lib=practice&i=0&selftest=1`) and prints the self-test's JSON results and any console errors |
| `tour-run.js <url> <outdir>` | Plays the whole tour, clicking Next at set times, and saves a screenshot per step |
| `screenshot.js <url> <out.png> '<js>' [x,y,w,h]` | Loads the page, runs some JavaScript, saves a screenshot (optionally a clip) |
| `eval.js '<js>'` | Runs JavaScript in the open page and prints the result |
| `hosted-check.js` | Calls the hosted server's API as a visitor (classes, pixel size, CSV, reshape); edit the address at the top |

The self-test leaves `settings.json` pointing at `scratch/export-test`; reset it to your Downloads folder afterwards.
