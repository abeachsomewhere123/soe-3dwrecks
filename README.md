# soe-3dwrecks

3D shipwreck viewer for https://3dwrecks.southernoceanexploration.com, built on [BelowJS](https://github.com/abeachsomewhere123/belowjs).

| Page | What it is |
| --- | --- |
| [`/`](https://3dwrecks.southernoceanexploration.com/) | Front page: a card per wreck with View in browser, VR headset and AR buttons |
| [`/view/`](https://3dwrecks.southernoceanexploration.com/view/) | The browser/VR viewer. `?model=euro` picks a wreck, `&mode=vr` shows the Enter VR prompt. Old `/?model=` links redirect here |
| [`/ar/`](https://3dwrecks.southernoceanexploration.com/ar/) | AR viewer for the same bucket models, scaled to 5% for tabletop viewing. `&mode=ar` shows the Start AR prompt. Needs a WebXR AR device (Quest 3, Android Chrome) |

| Folder | What it is | Deploys to |
| --- | --- | --- |
| `site/` | The front page, viewers and tools | Cloudflare Pages project `soe-3dwrecks`, automatically on push to `main` when something under `site/` changes |
| `cloudflare/` | `soe-3dwrecks-test` Worker: serves `site/` from the `ar-dev` branch at https://test-3dwrecks.southernoceanexploration.com for AR development | Cloudflare, automatically on push to `ar-dev` (needs the `CLOUDFLARE_API_TOKEN` repo secret) |
| `worker/` | `shipwreck-models` Cloudflare Worker: lists and serves the `.glb` files in the `soeglb` R2 bucket | Cloudflare, with `npx wrangler deploy` from `worker/` |

## Tools

| Page | What it does |
| --- | --- |
| [`/tools/position/`](https://3dwrecks.southernoceanexploration.com/tools/position/) | Drag & drop a `.glb`, frame it, and copy the `initialPositions` camera snippet for `metadata.json` |
| [`/tools/animate/`](https://3dwrecks.southernoceanexploration.com/tools/animate/) | Keyframe camera animations and export video |

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
