# soe-3dwrecks

3D shipwreck viewer for https://3dwrecks.southernoceanexploration.com, built on [BelowJS](https://github.com/abeachsomewhere123/belowjs).

| Page | What it is |
| --- | --- |
| [`/`](https://3dwrecks.southernoceanexploration.com/) | Front page: a card per wreck with View in browser, VR headset and AR buttons |
| [`/view/`](https://3dwrecks.southernoceanexploration.com/view/) | The browser/VR viewer. `?model=euro` picks a wreck, `&mode=vr` shows the Enter VR prompt. Old `/?model=` links redirect here |
| [`/ar/`](https://3dwrecks.southernoceanexploration.com/ar/) | AR viewer for the same bucket models. Starts in front of you at 5%; point a controller at a table and pull the trigger to put the wreck on it, sized to fit, then use the thumbstick to turn (left/right) and resize (up/down). Tables come from the headset's room setup (Space Setup on a Quest); without it, the trigger uses any flat surface. `&mode=ar` shows the Start AR prompt. Needs a WebXR AR device (Quest 3, Android Chrome) |

| Folder | What it is | Deploys to |
| --- | --- | --- |
| `site/` | The front page, viewers and tools | Cloudflare Pages project `soe-3dwrecks`, automatically on every push to `main`. (It used to build only when `site/` changed, but Cloudflare left those builds stuck at "queued", so the filter is off.) Pushes to `dev` go to https://dev.soe-3dwrecks.pages.dev, which https://test.southernoceanexploration.com/3d-wrecks shows |
| `worker/` | `shipwreck-models` Cloudflare Worker: lists and serves the `.glb` files in the `soeglb` R2 bucket | Cloudflare, with `npx wrangler deploy` from `worker/` |

## Underwater look

`site/assets/underwater.js` adds blue water that fades with distance, a sandy seabed out to the horizon to the browser/VR viewer, plus drifting marine snow in VR. It finds the seabed height from the edge of each scan, so new models need no settings. Colours, haze and snow are constants at the top of the file. Where the edge of a scan is all sand but the sand inside dips lower (scour round the wreck, as on the Batman), the seabed is cut to the scan's outline and a second, lower seabed fills the cut just under the scanned sand, so the scan's own sand isn't buried. Where the wreck runs to the edge of the scan (the Euro), there is one seabed at the edge's height. Add `&water=off` to a `/view/` link to see the bare scan.

## Seabed passthrough (off)

The BelowJS build in `site/vendor/belowjs/` can show the real room when you stand on the sand in VR on a passthrough headset (`vr: { passthroughOnSeabed: true, passthroughEyeHeight: 3 }` in the viewer config). It is switched off on `/view/` and `/then-now/`: VR stays underwater throughout. Add that line back to `viewerConfig` to turn it on again.

## Caching of site scripts

Cloudflare tells browsers to keep files under `/assets/` for 4 hours. Pages load `wreck-extras.js` (and `wreck-extras.css`) with `?v=` and the first 8 characters of the file's SHA-256, so a changed file is fetched at once. After editing either file, update the `?v=` in `then-now/`, `view/` and `ar/`: `sha256sum site/assets/wreck-extras.js | cut -c1-8`. The wreck data files (`assets/wrecks/*.json`) are fetched with `cache: 'no-cache'`, so they always revalidate.

## Then and now page (test site)

`/then-now/?model=euro` is a cut-down, browser-only page: the wreck fills the screen with a slider down it, the reconstruction to the left and the scan to the right, rendered from one camera so the halves line up. Drag the handle (or use the arrow keys on it) to compare; drag anywhere else to spin the wreck, which turns slowly on its own until touched. It only offers wrecks with a reconstruction in `site/assets/wrecks/`, and uses `addWreckExtras(viewer, { ui: false, dimWreck: false, inside: false })`. The scanned sand shows on both sides.

On a VR headset the page shows an Enter VR button (top right). A split can't work in stereo, so in VR it behaves like the main viewer: you start beside the wreck as it is now, a hint says to click a thumbstick, and each click fades the reconstruction in (dimming the scan) or back out. The depth gauge and the wrist Exit VR button work as on `/view/`, and standing on the sand shows the room on passthrough headsets. Leaving VR puts the slider view back as it was.

## Self-hosted libraries (test site)

On `dev` nothing loads from a CDN: three.js, BelowJS, the KTX2 transcoder and Draco decoder, the Quest controller models and the animate tool's MP4 writer are all served from `site/vendor/`, with versioned folders cached for a year. Every page passes `assetBasePath: '/vendor/below-assets/'` to BelowJS. `site/vendor/README.md` lists versions, sources and licences, and how to update them.

## Wreck extras (test site only)

`site/assets/wreck-extras.js` adds three things to `/view/` for any model with a data file at `site/assets/wrecks/<model key>.json` (the key is the one in `?model=`):

- **Points of interest** (off for the Euro). The code still supports numbered markers with cards (a `pois` list in the data file), but `euro.json` has none.
- **Depth gauge.** In VR, a watch face on the left controller shows depth, maximum depth, dive time and ascent rate (red above 9 m/min). Depth is `seabedDepth` from the data file less your height above the sand. The browser shows depth only. It is not a dive computer and shows no decompression information.
- **Then and now.** A painted, textured model of the ship as built, drawn from the registered dimensions and placed on the scan. The browser has a slider; in VR, click either thumbstick to fade between the wreck and the model. Textures are drawn in the browser (plating, planking, timber, paint), so there are no image files. The colour scheme follows the photographs' tones where they show them (black hull with a white line, light funnel with a black top, dark deckhouses) and tugs of the period elsewhere; the Euro's actual colours are not in our sources. It is labelled indicative.

- **The wheelhouse.** The reconstruction's wheelhouse has an interior: a spoked wheel on its steering column, a binnacle with the compass, correcting spheres and Flinders bar, an engine room telegraph, a voice pipe to the engine room, a chart table, clock, barometer, oil lamp and a bell outside, with the master at the wheel. "Step into the wheelhouse" (in the panel) brings the reconstruction fully in and puts you on the bridge through the doorway. While you are inside, the scanned wreck is hidden; zoom or fly out (or use "Step back out") to leave. All of it is indicative, after tugs of the period.

The towing gear follows British-built steam tugs of the period: the towing hook (spring buffered, slip type) on a beam at the after end of the deckhouse, amidships just abaft the funnel, so the tug pivots about her middle under tow and resists being girded; a clear after deck with only the low engine room casing and skylight, under four towing bows that carry the rope clear; quarter bitts for mooring; and the steering quadrant on deck at the stern (where dive reports place it), worked by rods and chains from the wheelhouse. The boat and mainmast sit forward of the hook, out of the tow's sweep. Glass is see-through, so you can look into the wheelhouse and out of it.

**Exit VR / Exit AR** (`site/assets/vr-exit.js`, all models, on `/view/` and `/ar/`): a button on the back of the right wrist. Look at it for about a second and a half, or touch it with the left controller for about a second, and the VR session ends. The headset's own menu button still works too.

**On the AR page** (`/ar/`), the same file adds the reconstruction to the tabletop wreck: click a thumbstick to fade between the wreck and the reconstruction. The depth gauge and stepping inside are left out at that scale.

The Euro's layout follows three photographs confirmed as her on Clydeships (the Caledonian Maritime Research Trust's register): two by Allan C. Green in the State Library of Victoria and one from the Tug Talk forum. Measured along the hull (130 ft between the stern and the stem), they show an engine casing from about a third of the way along to just forward of midships, with a boat in chocks under two pairs of davits aft of the funnel; the funnel just abaft midships, over the boiler in the scan; a bridge house on the casing forward of it with lifebuoys and ladders down to the deck, and on it a small wheelhouse under a flat awning; a single mast through a small forward house, with cowl vents and a windlass on the foredeck and a wire from the masthead to the funnel; three towing bows over the after deck; a large rope pudding over the stem and along both bows; rope fenders on lanyards along the sides; and a white line along the hull at deck level. They can't give colours: the funnel shows light with a black top, the hull black. The earlier reconstruction used a State Library of Western Australia photograph we thought might show her; its layout (two masts, the wheelhouse well forward) doesn't match these, so it is not used. Paint colours are set in `ghost.colours`.

The data file holds the seabed depth, any marker positions (in the `.glb` file's own coordinates) with card text and sources, and the ghost: its keel point and forward, up and starboard directions (which carry the wreck's list; the Euro lies about 36 degrees to port), an optional `twist` that bends the ghost to follow changes in list and position along the hull (the Euro eases to about 30 degrees at the bow), the bow's length and fullness, the hull dimensions, and the indicative layout of the casing, wheelhouse, funnel, masts, boat and towing gear. Optional parts: `bridgeHouse` (a second tier on the casing, with `ladders`), `wheelhouse.awning`, `deckhouses` (with `portholes`), `windlass`, `name` (position of her name on the bows), vents `on` the `deck` or a `house` with a `size`, `boat.davits: "both"` and `boat.cover`, a sized bow pudding (`fenders.bow` with `radius`, `length`, `drop`, `stem`), and `colours.rubbing` / `colours.canvas`. `euro.json` is the worked example. Wrecks without a file show none of this.

## Tools

| Page | What it does |
| --- | --- |
| [`/tools/position/`](https://3dwrecks.southernoceanexploration.com/tools/position/) | Drag & drop a `.glb`, frame it, and copy the `initialPositions` camera snippet for `metadata.json` |
| [`/tools/animate/`](https://3dwrecks.southernoceanexploration.com/tools/animate/) | Keyframe camera animations and export video |

`reel/` (not deployed) makes Instagram dive reels and covers from a model. See [`reel/README.md`](reel/README.md).

The tools are copies of the BelowJS examples, pinned to the same BelowJS version as the viewer so captured positions match. Not indexed by search engines.

## Adding a model

Upload a `.glb` to the `soeglb` bucket. It appears on the site within a minute, named after the file (`Euro.glb` shows as "Euro"). Credits, camera start positions and ordering go in an optional `metadata.json` in the same bucket.

For a card picture, add `site/thumbnails/<file>.jpg` (e.g. `Euro.jpg`, 800×500). Without one, the card shows the wreck's name on a dark gradient.

Replacing a file under the same name reaches returning visitors within a day.

## Deploying the Worker

```sh
cd worker
npx wrangler deploy
```

`wrangler.toml` owns the Worker's bindings and domains. Change them there, not in the dashboard, or the next deploy will undo the dashboard change.
