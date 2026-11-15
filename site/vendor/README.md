# Self-hosted libraries

Everything the viewer pages need at runtime is served from this folder, so the
site doesn't depend on jsDelivr, unpkg or Google's servers. Folders are named
by version, so a new version goes in a new folder and browsers never mix old
and new cached files.

| Folder | What | From | Licence |
| --- | --- | --- | --- |
| `three/0.179.1/` | three.js (`three.module.js` imports `three.core.js`) | npm `three@0.179.1`, `build/` | MIT |
| `belowjs/1.8.0-dev.5bf0695/` | BelowJS build (JS and CSS) | `abeachsomewhere123/belowjs`, branch `claude/upbeat-volta-1lk76n`, commit 5bf0695, `npm run build` | GPL-3.0-or-later |
| `below-assets/three/basis/` | KTX2 / Basis transcoder (the scans use KTX2 textures) | npm `three@0.179.1`, `examples/jsm/libs/basis/` | Apache-2.0 |
| `below-assets/draco/1.5.6/` | Draco mesh decoder | npm `three@0.179.1`, `examples/jsm/libs/draco/gltf/` | Apache-2.0 |
| `below-assets/webxr-input-profiles/assets/1.0/profiles/` | VR controller models: Meta Quest (Touch, Touch Plus, Touch Pro) and the generic fallbacks | npm `@webxr-input-profiles/assets@1.0.20`, `dist/profiles/` (a subset; `profilesList.json` lists only these, so other headsets fall back to the generic controller) | MIT (see `LICENSE.md`) |
| `mp4-muxer/5.1.3/` | MP4 writer for video export in `/tools/animate/` | npm `mp4-muxer@5.1.3`, `build/mp4-muxer.mjs` | MIT |

The `below-assets` layout is the one BelowJS expects for its `assetBasePath`
setting, which every page passes as `/vendor/below-assets/`.

## Updating BelowJS

1. In the BelowJS repository, run `npm run build`.
2. Copy `dist/belowjs.js` and `dist/belowjs.css` into a new folder here,
   `belowjs/<version>/` (a release number, or `<version>-dev.<commit>` for a
   test build), with the `LICENSE`.
3. Change the `belowjs` line in the import map and the BelowJS stylesheet link
   in `view/`, `ar/`, `tools/position/` and `tools/animate/`.
4. Delete the old folder once nothing points at it.

## Updating three.js

BelowJS is built against a three.js version (see its `package.json`). Copy
`build/three.module.js` and `build/three.core.js` for that version into
`three/<version>/`, update the `three` line of the import maps, and copy the
matching `examples/jsm/libs/basis/` and `examples/jsm/libs/draco/gltf/` files
into `below-assets/`.
