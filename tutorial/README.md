# Tutorial clips

The editor's **Tutorial** panel (`viewer/editor/tutorial.js`) shows short looping clips, one per action. They are
recorded from the real editor: `make_tutorial.js` drives headless Chrome with real mouse and key events
(`rec.js`), draws a pointer on the page, saves one screenshot per frame and encodes each clip with ffmpeg into
`viewer/editor/tutorial/*.mp4` (plus a `.jpg` poster). Nothing is saved while recording, and exports go to `scratch/`.

To record them again (needs Node 22+, ffmpeg, Chrome, and `data/cases` from `make_cases.py`):

```bash
.venv/bin/python serve.py &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 \
  --user-data-dir=$PWD/scratch/chrome-profile-tut --hide-scrollbars about:blank &

# a clean six-image library, so the recordings never touch your own work
B=http://127.0.0.1:8765/api/editor/library
ID=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"Sample slides"}' $B/begin | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
i=1; for c in fibrocystic-mid gynecomastoid-mid prolif-fibrocystic-mid sclerosing-adenosis-mid sclerosing-adenosis-low pash-low; do
  n=$(printf "slide-%02d" $i); i=$((i+1))
  curl -s -X POST --data-binary @data/cases/${c}__regions/tissue.png "$B/put?id=$ID&path=${n}_image.png" >/dev/null
  curl -s -X POST --data-binary @data/cases/${c}__regions/prob.tif   "$B/put?id=$ID&path=${n}_prob.tif"  >/dev/null
done
curl -s -X POST -H 'Content-Type: application/json' -d "{\"id\":\"$ID\"}" $B/finish
mkdir -p scratch/tut-export

node tutorial/make_tutorial.js $ID            # all clips (about 9 minutes)
node tutorial/make_tutorial.js $ID draw trim  # or just some scenes
```

Each scene in `make_tutorial.js` is a short script: where to look, what to click or draw (in image coordinates of
slide-06), and how long to pause. To add a step, add a scene there and an entry in `viewer/editor/tutorial.js`.
