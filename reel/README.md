# Dive reels

Makes a vertical (1080×1920, 30 fps) Instagram reel from a wreck model: a diver's descent onto the wreck, a swim round it, a pause at a feature and an ascent. It also makes a cover image. The first one was the Euro, in October 2026.

It runs on a computer, not on the website, so nothing in `reel/` is deployed. The look is self-contained: water, fog, a dive torch and marine snow are all drawn by `render.html` with plain three.js (pinned to 0.169.0). Changes to the viewer, BelowJS, or `site/assets/underwater.js` (which only shows snow in VR) don't change the reels. The one shared piece is `site/assets/level.js`, so a reel levels the scan the same way `/view/` does.

## What you need

- Node.js with Playwright and Chromium (a GPU isn't needed; it renders in software with SwiftShader)
- Python 3 with Pillow and NumPy
- ffmpeg
- Inter fonts if you have them (`/usr/share/fonts/opentype/inter/`), otherwise DejaVu is used

A Claude Code cloud session has all of these. On a Mac: `brew install node ffmpeg && npm i -g playwright && npx playwright install chromium && pip3 install pillow numpy`.

## Making a reel for a new wreck

1. **Copy a config.** `cp reel/wrecks/euro.json reel/wrecks/<wreck>.json`, then set `name` and `model` (the plain bucket link, e.g. `https://models.southernoceanexploration.com/f/Cambridge.glb`, or a local `.glb` path).
2. **Survey it.** `python3 reel/make_reel.py survey reel/wrecks/<wreck>.json --draft`. This writes `reel/out/<wreck>-draft/survey/`:
   - `top-grid.jpg` is a plan view with a grid in the model's own coordinates, red dots for your named `points` and yellow dots for the camera keyframes
   - `from_plus_z.jpg` and the other three views show the wreck from each side
   Use them to work out where the bow, the stern and the feature you want to stop at are, and which side the deck faces.
3. **Write the route.** In `keyframes`, each entry is a time (`t`, in seconds), a camera position (`pos`) and the point it looks at (`look`). Coordinates are `[x, y, z]` in the model's own units (metres for our scans) and y is up. Name features under `points` and use the name in `look`, e.g. `"look": "boiler"`. The camera glides smoothly through the keyframes. The Euro route is a good pattern: start 30 to 35 m above the wreck, reach the bow by about 10 s, stay about 4 to 6 m off the hull, spend about 6 s at the feature, round the stern, and finish 25 to 30 m up looking back down.
4. **Preview.** `python3 reel/make_reel.py preview reel/wrecks/<wreck>.json --draft` renders 12 stills along the route into `preview.jpg`, in about 20 seconds. Adjust and repeat until each still looks right.
5. **Render.** `python3 reel/make_reel.py render reel/wrecks/<wreck>.json`. A full 45 s reel is 1,350 frames and takes about 45 minutes in a cloud session (two browsers at once; `--workers 3` if the machine has the cores). `--draft` makes a half-size 15 fps version in about 8 minutes, to check the timing of the text.
6. **Collect the files** from `reel/out/<wreck>/`: `<Name>-dive-reel.mp4` and `<Name>-dive-reel-cover.jpg`.

Frames already rendered are kept, so a stopped render picks up where it left off. Delete `reel/out/<wreck>/frames/` after changing the route or the look, or the old frames are reused.

## Text on the video

- `titles` are text blocks with `start` and `end` times. The y position is in a 1080×1920 frame, and Instagram's buttons cover roughly the top 220 px and the bottom 420 px. Lines with `"bold": true` are white and large, the rest are pale blue.
- `labels` are short single captions, such as `THE BOILER`.
- `endcard` shows the SOE logo and lines from `start` to the end.
- `cover` picks a moment (`time`) and puts the kicker, title and subtitle on it. The text stays inside the centre of the frame, so it survives Instagram's 3:4 profile grid crop.

Check every fact in the titles against the Victorian Heritage Database (vhd.heritagecouncil.vic.gov.au) or another primary source. If a feature label comes from reading the mesh rather than a survey, say so in `notes`.

## The look

Everything under `look` has a default in `make_reel.py` (`DEFAULT_LOOK`), and a config only needs the values it changes:

| Setting | Default | What it does |
| --- | --- | --- |
| `fog`, `fogDensity` | `#0d4560`, 0.038 | Water colour and haze. 0.038 leaves about half the colour at 20 m |
| `waterAbove`, `waterBelow` | `#3f93b5`, `#062536` | Water looking up and looking down |
| `torchIntensity` | 55 | The dive torch on the camera. Lower it if close-ups burn out |
| `snowCount`, `snowSize`, `snowOpacity`, `snowBox` | 3500, 0.07, 0.55, 26 | Marine snow. `snowCount: 0` turns it off |
| `fov` | 66 | Vertical field of view in degrees |
| `sway` | 1 | Diver sway and breathing bob; 0 for a steady camera |
| `sandTile`, `sandTint` | 2.5, `#ffffff` | Repeat size and tint of the sand that extends the seabed past the scan |

Levelling: the scan is turned so the sand at its edge lies flat, as in `/view/`. Set `"level": false` to keep the scan as it is.

The finished file is H.264, high profile, about 12 Mbit/s, with a silent AAC track so music can be added in Instagram.
