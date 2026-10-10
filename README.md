# soe-3dwrecks

3D shipwreck viewer for https://3dwrecks.southernoceanexploration.com, built on [BelowJS](https://github.com/abeachsomewhere123/belowjs).

| Folder | What it is | Deploys to |
| --- | --- | --- |
| `site/` | The viewer page | Netlify, automatically on push to `main` |
| `worker/` | `shipwreck-models` Cloudflare Worker: lists and serves the `.glb` files in the `soeglb` R2 bucket | Cloudflare, with `npx wrangler deploy` from `worker/` |

## Tools

| Page | What it does |
| --- | --- |
| [`/ar/`](https://3dwrecks.southernoceanexploration.com/ar/) | AR viewer for the same bucket models, scaled to 5% for tabletop viewing. Needs a WebXR AR device (Quest, Android Chrome) |
| [`/tools/position/`](https://3dwrecks.southernoceanexploration.com/tools/position/) | Drag & drop a `.glb`, frame it, and copy the `initialPositions` camera snippet for `metadata.json` |
| [`/tools/animate/`](https://3dwrecks.southernoceanexploration.com/tools/animate/) | Keyframe camera animations and export video |

Both are copies of the BelowJS examples, pinned to the same BelowJS version as the viewer so captured positions match. Not indexed by search engines.

## Adding a model

Upload a `.glb` to the `soeglb` bucket. It appears on the site within a minute, named after the file (`Euro.glb` shows as "Euro"). Credits, camera start positions and ordering go in an optional `metadata.json` in the same bucket.

Replacing a file under the same name reaches returning visitors within a day.

## Deploying the Worker

```sh
cd worker
npx wrangler deploy
```

`wrangler.toml` owns the Worker's bindings and domains. Change them there, not in the dashboard, or the next deploy will undo the dashboard change.
