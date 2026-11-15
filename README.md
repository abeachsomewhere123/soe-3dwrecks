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

`site/assets/underwater.js` adds blue water that fades with distance, a sandy seabed out to the horizon to the browser/VR viewer, plus drifting marine snow in VR. It finds the seabed height from the edge of each scan, so new models need no settings. Colours, haze and snow are constants at the top of the file. Add `&water=off` to a `/view/` link to see the bare scan.

## Seabed passthrough (test site only)

On `dev`, `/view/` uses a BelowJS build of the `claude/upbeat-volta-1lk76n` branch of abeachsomewhere123/belowjs (served from `site/vendor/belowjs/`), with `vr: { passthroughOnSeabed: true }`. On a passthrough headset (Quest 3), coming down onto the sand in VR fades the water out so the room shows, with the wreck around you at full scale; rising off the sand brings the water back. `underwater.js` hides the extended seabed and marine snow while you stand on the sand. `main` still uses `belowjs@1.8.0` and three.js from the jsDelivr CDN.

Before merging `dev` into `main`, ideally publish a BelowJS release with this feature and host that in `site/vendor/belowjs/<version>/` in place of the branch build (see `site/vendor/README.md`).

## Self-hosted libraries (test site)

On `dev` nothing loads from a CDN: three.js, BelowJS, the KTX2 transcoder and Draco decoder, the Quest controller models and the animate tool's MP4 writer are all served from `site/vendor/`, with versioned folders cached for a year. Every page passes `assetBasePath: '/vendor/below-assets/'` to BelowJS. `site/vendor/README.md` lists versions, sources and licences, and how to update them.

## Wreck extras (test site only)

`site/assets/wreck-extras.js` adds three things to `/view/` for any model with a data file at `site/assets/wrecks/<model key>.json` (the key is the one in `?model=`):

- **Points of interest.** Numbered markers. In the browser, click one or pick it from the "Explore the wreck" list; in VR, look at one for about a second. A card shows what it is, the build date, a picture and the source. Look at the same marker again to close the VR card.
- **Depth gauge.** In VR, a watch face on the left controller shows depth, maximum depth, dive time and ascent rate (red above 9 m/min). Depth is `seabedDepth` from the data file less your height above the sand. The browser shows depth only. It is not a dive computer and shows no decompression information.
- **Then and now.** A painted, textured model of the ship as built, drawn from the registered dimensions and placed on the scan. The browser has a slider; in VR, click either thumbstick to fade between the wreck and the model. Textures are drawn in the browser (plating, planking, timber, paint), so there are no image files. The colour scheme (black topsides, red antifouling, white deckhouse, varnished wheelhouse, buff funnel with a black top) follows tugs of the period; the Euro's own colours are not in our sources. It is labelled indicative.

- **The wheelhouse.** The reconstruction's wheelhouse has an interior: a spoked wheel on its steering column, a binnacle with the compass, correcting spheres and Flinders bar, an engine room telegraph, a voice pipe to the engine room, a chart table, clock, barometer, oil lamp and a bell outside, with the master at the wheel. "Step into the wheelhouse" (in the panel, or the Wheelhouse marker; in VR, look at the marker) brings the reconstruction fully in and puts you on the bridge through the doorway. While you are inside, the scanned wreck and the markers are hidden; zoom or fly out (or use "Step back out") to leave. All of it is indicative, after tugs of the period.

The towing gear follows British-built steam tugs of the period: the towing hook (spring buffered, slip type) on a beam at the after end of the deckhouse, amidships just abaft the funnel, so the tug pivots about her middle under tow and resists being girded; a clear after deck with only the low engine room casing and skylight, under four towing bows that carry the rope clear; quarter bitts for mooring; and the steering quadrant on deck at the stern (where dive reports place it), worked by rods and chains from the wheelhouse. The boat and mainmast sit forward of the hook, out of the tow's sweep. Glass is see-through, so you can look into the wheelhouse and out of it.

**Exit VR / Exit AR** (`site/assets/vr-exit.js`, all models, on `/view/` and `/ar/`): a button on the back of the right wrist. Look at it for about a second and a half, or touch it with the left controller for about a second, and the VR session ends. The headset's own menu button still works too.

**On the AR page** (`/ar/`), the same file adds the markers and the reconstruction to the tabletop wreck: click a thumbstick to fade between the wreck and the reconstruction, and look at a marker for its card. Marker sizes scale to the table; the depth gauge and stepping inside are left out at that scale.

The data file holds marker positions in the `.glb` file's own coordinates (BelowJS centres the model and `underwater.js` levels it; the markers move with it), the card text with sources, and the ghost: its keel point and forward, up and starboard directions (which carry the wreck's list; the Euro lies about 36 degrees to port), an optional `twist` that bends the ghost to follow changes in list and position along the hull (the Euro eases to about 30 degrees at the bow), the bow's length and fullness, the hull dimensions, and the indicative layout of the casing, wheelhouse, funnel, masts, boat and towing gear. `euro.json` is the worked example; its pictures in `site/assets/wrecks/euro/` are renders of the scan. Wrecks without a file show none of this.

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
