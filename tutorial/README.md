# Tutorial clips

The editor's tutorial (`viewer/editor/tutorial.js`) shows short looping clips, one per action. They are recorded
from the real editor: `make_tutorial.js` drives headless Chrome with real mouse and key events (`rec.js`), draws
a pointer on the page, saves one screenshot per frame and encodes each clip with ffmpeg into
`viewer/editor/tutorial/*.mp4` (plus a `.jpg` poster). Nothing is saved while recording.

To record them again (needs Node 22+, ffmpeg and Chrome). Two throw-away servers are used so the recordings
start from untouched practice images and never touch your own work:

```bash
mkdir -p scratch/tutdata scratch/tutdata-hosted scratch/tut-export
DATA_DIR=$PWD/scratch/tutdata PORT=8767 .venv/bin/python serve.py &                    # as on your own computer
HOSTED=1 DATA_DIR=$PWD/scratch/tutdata-hosted PORT=8766 .venv/bin/python serve.py &   # as when hosted
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 \
  --user-data-dir=$PWD/scratch/chrome-profile-tut --hide-scrollbars about:blank &

EDITOR_URL=http://127.0.0.1:8767 node tutorial/make_tutorial.js practice                # all clips (about 10 minutes)
EDITOR_URL=http://127.0.0.1:8767 node tutorial/make_tutorial.js practice draw trim      # or just some scenes
EDITOR_URL=http://127.0.0.1:8766 EDITOR_HOSTED=1 node tutorial/make_tutorial.js practice export   # the .zip export clip
EDITOR_URL=http://127.0.0.1:8767 node tutorial/make_tutorial.js practice email          # scratch/editor-demo.gif, for an email
```

The local export clip writes a real export to `scratch/tut-export` and leaves that as the remembered export
folder in `settings.json`; delete that file afterwards to go back to Downloads.

Each scene in `make_tutorial.js` is a short script: where to look, what to click or draw (in image coordinates of
practice-01), and how long to pause. To add a step, add a scene there and an entry in `viewer/editor/tutorial.js`.
