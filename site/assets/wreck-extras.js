// Extras for wrecks that have a data file in /assets/wrecks/<model key>.json:
//
//  - Points of interest: numbered markers on the wreck. Click one (or pick
//    it from the list) in the browser, or look at it for a moment in VR, to
//    open a card with what it is, the date and a picture.
//  - Depth gauge: a dive watch on the left controller in VR showing depth,
//    maximum depth, dive time and ascent rate. Depth is the seabed depth from
//    the data file less your height above the sand. The browser shows depth
//    only. It is not a dive computer and shows no decompression information.
//  - Then and now: a ghost of the ship as built, drawn from the registered
//    dimensions and fitted to the scan. The slider (or a thumbstick click in
//    VR) fades the wreck down and the ghost up. It is labelled indicative.
//
// Positions in the data file are in the model file's own coordinates, so
// everything here is added to the model and moves with it when BelowJS
// centres it and underwater.js levels it.

import * as THREE from 'three';
import { fitSeabed } from '/assets/level.js';

const DATA_URL = (key) => `/assets/wrecks/${encodeURIComponent(key)}.json`;

const MARKER_SIZE = 0.8;          // metres across, at least, in VR
const VR_MARKER_ANGLE = 0.045;    // radians across, beyond 18 m
const DESKTOP_MARKER_PX = 30;     // pixels across in the browser
const GAZE_ANGLE = THREE.MathUtils.degToRad(5);
const GAZE_RANGE = 40;            // metres
const DWELL_SECONDS = 1.2;
const PANEL_DISTANCE = 1.5;       // metres from your eyes in VR
const PANEL_WIDTH = 0.9;
const PANEL_CLOSE_DISTANCE = 4;   // the VR card closes once you move this far
const BLEND_SECONDS = 1.5;
const WRECK_DIM = 0.75;           // how far the wreck darkens at full "then"
const ASCENT_WARN = 9;            // metres per minute
const THUMBSTICK_BUTTON = 3;      // xr-standard gamepad: thumbstick press


export function addWreckExtras(viewer) {
    const below = viewer.belowViewer;
    const renderer = below.renderer;
    const scene = below.sceneManager.scene;
    const cache = new Map();

    const ui = makeDesktopUi(viewer.container || document.body);
    const card = makeCard(viewer.container || document.body);
    const gauge = makeGauge();
    const vrCard = makeVrCard();
    scene.add(vrCard.mesh);

    let state = null;          // everything for the loaded model
    let loading = null;        // the model whose data file is on its way
    let blend = 0;             // 0 now, 1 then
    let blendTarget = 0;
    let tween = null;          // desktop camera fly-to
    const dive = { start: 0, max: 0, smoothed: null, rate: 0, lastDraw: 0 };
    const stickWasDown = new Map();
    const handedness = new Map();

    // Know which controller is in which hand, even before BelowJS does.
    for (let i = 0; i < 2; i++) {
        const controller = renderer.xr.getController(i);
        controller.addEventListener('connected', (e) => handedness.set(i, e.data?.handedness));
        controller.addEventListener('disconnected', () => handedness.delete(i));
    }

    renderer.xr.addEventListener('sessionstart', () => {
        dive.start = performance.now();
        dive.max = 0;
        dive.smoothed = null;
        dive.rate = 0;
        card.hide();
    });
    renderer.xr.addEventListener('sessionend', () => {
        gauge.mesh.removeFromParent();
        vrCard.hide();
    });

    viewer.on('modelLoaded', async ({ model }) => {
        // ModelViewer can report the same load twice.
        if (model && (state?.model === model || loading === model)) return;
        clear();
        loading = model;
        if (!model) return;
        const key = viewer.currentModelKey;
        let data = cache.get(key);
        if (data === undefined) {
            try {
                const res = await fetch(DATA_URL(key));
                data = res.ok ? await res.json() : null;
            } catch {
                data = null;
            }
            cache.set(key, data);
        }
        // Another model may have loaded while the file was on its way.
        if (loading !== model) return;
        loading = null;
        if (!data) return;
        state = build(model, data);
        ui.show(state, {
            onPoi: (poi) => openDesktop(poi),
            onBlend: (value) => { blendTarget = value; blend = value; },
            hasGhost: !!state.ghost
        });
    });

    function clear() {
        if (state) {
            state.root.removeFromParent();
            setWreckDim(state, 0);
        }
        state = null;
        blend = blendTarget = 0;
        tween = null;
        ui.hide();
        card.hide();
        vrCard.hide();
    }

    function build(model, data) {
        // The sand plane, in world space, after levelling. Fit it before the
        // ghost is added so the masts don't count as scan.
        const seabed = fitSeabed(model);

        const root = new THREE.Group();
        root.name = 'wreck-extras';
        model.add(root);

        const markers = data.pois?.map((poi, i) => {
            const sprite = makeMarker(i + 1);
            sprite.position.fromArray(poi.position);
            sprite.userData.poi = { ...poi, number: i + 1, built: poi.built || data.built };
            root.add(sprite);
            return sprite;
        }) || [];

        const ghost = data.ghost ? makeGhost(data.ghost) : null;
        if (ghost) root.add(ghost.group);

        // Remember the wreck's own colours so "then" can darken them.
        const materials = new Set();
        // The scanned sand round the wreck stays as it is, to match the seabed.
        model.traverse((o) => {
            if (!o.isMesh || isInside(o, root)) return;
            for (const m of [].concat(o.material)) {
                if (m?.color && !/sand/i.test(m.name || '')) materials.add(m);
            }
        });
        for (const m of materials) m.userData.extrasBase ??= m.color.clone();

        return { model, root, markers, ghost, materials, seabed, data, dwell: null, dwellTime: 0, openPoi: null, openAt: new THREE.Vector3() };
    }

    // ── Desktop ─────────────────────────────────────────────────────────

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downAt = null;
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
        if (!state || !downAt || renderer.xr.isPresenting) return;
        const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
        downAt = null;
        if (moved > 6) return;
        const rect = canvas.getBoundingClientRect();
        pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        const camera = below.cameraManager.camera;
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(state.markers.filter((m) => m.visible), false)[0];
        if (hit) openDesktop(hit.object.userData.poi, hit.object);
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!state || renderer.xr.isPresenting || e.buttons) return;
        const rect = canvas.getBoundingClientRect();
        pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(pointer, below.cameraManager.camera);
        const over = raycaster.intersectObjects(state.markers, false).length > 0;
        canvas.style.cursor = over ? 'pointer' : '';
    });

    function openDesktop(poi, sprite) {
        if (!state) return;
        sprite ??= state.markers.find((m) => m.userData.poi.id === poi.id);
        card.show(poi);
        ui.select(poi.id);
        // Phones have room for the card or the list, not both.
        if (window.matchMedia('(max-width: 640px)').matches) ui.collapse();
        // Fly the orbit camera to look at the marker from where it is now,
        // closing in to about 12 m.
        const camera = below.cameraManager.camera;
        const controls = below.cameraManager.getControls?.();
        if (!controls?.target || !sprite) return;
        const to = sprite.getWorldPosition(new THREE.Vector3());
        const offset = camera.position.clone().sub(controls.target);
        const distance = Math.min(offset.length(), 12);
        const camTo = to.clone().add(offset.setLength(distance));
        tween = {
            t: 0,
            fromTarget: controls.target.clone(), toTarget: to,
            fromCam: camera.position.clone(), toCam: camTo
        };
    }

    // ── Every frame ─────────────────────────────────────────────────────

    const eye = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const toMarker = new THREE.Vector3();
    const markerWorld = new THREE.Vector3();

    below.on('before-render', (deltaTime) => {
        if (!state) return;
        const dt = Math.min(deltaTime || 0.016, 0.1);
        const xr = renderer.xr.isPresenting;
        const camera = below.cameraManager.camera;
        headPose(eye, forward);

        // Then and now.
        if (xr) pollThumbsticks();
        if (blend !== blendTarget) {
            const step = dt / BLEND_SECONDS;
            blend = blendTarget > blend ? Math.min(blendTarget, blend + step) : Math.max(blendTarget, blend - step);
            ui.setBlend(blend);
        }
        applyBlend(state, blend);

        // Desktop camera fly-to.
        if (tween && !xr) {
            const controls = below.cameraManager.getControls?.();
            tween.t = Math.min(1, tween.t + dt / 1.2);
            const k = tween.t * tween.t * (3 - 2 * tween.t);
            controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
            below.cameraManager.camera.position.lerpVectors(tween.fromCam, tween.toCam, k);
            controls.update?.();
            if (tween.t >= 1) tween = null;
        }

        // Markers keep a readable size: a fixed size on screen in the
        // browser, and at least a set angle across in VR. They fade out up
        // close so they never fill the view.
        const perPixel = xr ? 0 : 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov || 50) / 2) / Math.max(1, renderer.domElement.clientHeight);
        for (const m of state.markers) {
            m.getWorldPosition(markerWorld);
            const d = markerWorld.distanceTo(eye);
            m.scale.setScalar(xr ? Math.max(MARKER_SIZE, d * VR_MARKER_ANGLE) : d * perPixel * DESKTOP_MARKER_PX);
            m.material.opacity = THREE.MathUtils.clamp((d - 0.6) / 1.5, 0, 1) * (0.95 - 0.5 * blend);
        }

        // Depth: seabed depth less the eyes' height above the sand plane.
        const { a, b, c } = state.seabed;
        const sandY = a * eye.x + b * eye.z + c;
        const depth = Math.max(0, (state.data.seabedDepth || 0) - (eye.y - sandY));
        updateDive(depth, dt);

        if (xr) {
            updateGaze(dt);
            updateGauge(depth);
        } else {
            ui.setDepth(depth, state.data.seabedDepth);
        }
    });

    function updateDive(depth, dt) {
        if (dive.smoothed === null) { dive.smoothed = depth; return; }
        const k = 1 - Math.exp(-dt / 1.5);
        const previous = dive.smoothed;
        dive.smoothed += (depth - dive.smoothed) * k;
        const rate = ((previous - dive.smoothed) / Math.max(dt, 1e-3)) * 60; // up is positive
        dive.rate += (rate - dive.rate) * k;
        dive.max = Math.max(dive.max, depth);
    }

    function pollThumbsticks() {
        const session = renderer.xr.getSession();
        if (!session || !state?.ghost) return;
        for (const source of session.inputSources) {
            const pressed = source.gamepad?.buttons?.[THUMBSTICK_BUTTON]?.pressed === true;
            if (pressed && !stickWasDown.get(source)) blendTarget = blendTarget > 0.5 ? 0 : 1;
            stickWasDown.set(source, pressed);
        }
    }

    // Where the eyes are and which way they look, in the scene. In VR, at
    // this point in the frame three's XR camera holds the headset pose in the
    // room, and the BelowJS rig (the camera's parent) places the room in the
    // scene. The rig's camera itself still has the orbit controls' aim.
    const rigQuaternion = new THREE.Quaternion();
    function headPose(position, direction) {
        const camera = below.cameraManager.camera;
        const rig = camera.parent;
        if (!renderer.xr.isPresenting || !rig) {
            camera.getWorldPosition(position);
            camera.getWorldDirection(direction);
            return;
        }
        const head = renderer.xr.getCamera();
        rig.updateWorldMatrix(true, false);
        position.copy(head.position).applyMatrix4(rig.matrixWorld);
        direction.set(0, 0, -1).applyQuaternion(head.quaternion)
            .applyQuaternion(rig.getWorldQuaternion(rigQuaternion)).normalize();
    }

    function updateGaze(dt) {
        let best = null;
        let bestAngle = GAZE_ANGLE;
        for (const m of state.markers) {
            m.getWorldPosition(markerWorld);
            toMarker.subVectors(markerWorld, eye);
            const d = toMarker.length();
            if (d > GAZE_RANGE || d < 0.3) continue;
            // Allow a bigger target for markers that are close.
            const angle = forward.angleTo(toMarker) - Math.atan(MARKER_SIZE / 2 / d) * 0.5;
            if (angle < bestAngle) { bestAngle = angle; best = m; }
        }

        if (best !== state.dwell) {
            if (state.dwell) setMarkerProgress(state.dwell, 0);
            state.dwell = best;
            state.dwellTime = 0;
        }
        if (best) {
            state.dwellTime += dt;
            setMarkerProgress(best, Math.min(1, state.dwellTime / DWELL_SECONDS));
            if (state.dwellTime >= DWELL_SECONDS && state.dwellTime - dt < DWELL_SECONDS) {
                const poi = best.userData.poi;
                if (state.openPoi === poi.id) {
                    vrCard.hide();
                    state.openPoi = null;
                } else {
                    vrCard.show(poi, eye, forward);
                    state.openPoi = poi.id;
                    state.openAt.copy(eye);
                }
            }
        }
        if (state.openPoi && eye.distanceTo(state.openAt) > PANEL_CLOSE_DISTANCE) {
            vrCard.hide();
            state.openPoi = null;
        }
    }

    function updateGauge(depth) {
        const grip = findGrip();
        if (!grip) return;
        if (gauge.mesh.parent !== grip) grip.add(gauge.mesh);
        const now = performance.now();
        if (now - dive.lastDraw < 250) return;
        dive.lastDraw = now;
        gauge.draw({
            depth,
            max: dive.max,
            seconds: (now - dive.start) / 1000,
            rate: dive.rate
        });
    }

    function findGrip() {
        let fallback = null;
        for (let i = 0; i < 2; i++) {
            const hand = renderer.xr.getController(i).userData?.handedness || handedness.get(i);
            const grip = renderer.xr.getControllerGrip(i);
            if (hand === 'left') return grip;
            if (hand && !fallback) fallback = grip;
        }
        return fallback;
    }

    // Exposed for testing and for setting up photos.
    const api = {
        viewer,
        get state() { return state; },
        get blend() { return blend; },
        gauge: gauge.mesh,
        vrCard: vrCard.mesh,
        setBlend(value) { blend = blendTarget = value; ui.setBlend(value); },
        open: (id) => {
            const poi = state?.markers.find((m) => m.userData.poi.id === id)?.userData.poi;
            if (poi) openDesktop(poi);
        },
        renderVrCard: (id) => {
            const poi = state?.markers.find((m) => m.userData.poi.id === id)?.userData.poi;
            return poi ? vrCard.render(poi) : null;
        },
        renderGauge: (values) => gauge.draw(values)
    };
    window.wreckExtras = api;
    return api;
}

function isInside(object, ancestor) {
    for (let o = object; o; o = o.parent) if (o === ancestor) return true;
    return false;
}

// Fade the wreck down and the ghost up.
function applyBlend(state, blend) {
    setWreckDim(state, blend);
    if (!state.ghost) return;
    state.ghost.group.visible = blend > 0.005;
    state.ghost.setOpacity(blend);
}

function setWreckDim(state, blend) {
    if (state.lastDim === blend) return;
    state.lastDim = blend;
    const f = 1 - WRECK_DIM * blend;
    for (const m of state.materials) {
        if (m.userData.extrasBase) m.color.copy(m.userData.extrasBase).multiplyScalar(f);
    }
}

// ── Markers ──────────────────────────────────────────────────────────────

function makeMarker(number) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true, fog: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(MARKER_SIZE);
    sprite.renderOrder = 20;
    sprite.userData.canvas = canvas;
    sprite.userData.number = number;
    drawMarker(sprite, 0);
    return sprite;
}

function drawMarker(sprite, progress) {
    const canvas = sprite.userData.canvas;
    const ctx = canvas.getContext('2d');
    const s = canvas.width;
    ctx.clearRect(0, 0, s, s);
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 24, 40, 0.75)';
    ctx.fill();
    ctx.lineWidth = s * 0.05;
    ctx.strokeStyle = '#ffd36b';
    ctx.stroke();
    if (progress > 0) {
        ctx.beginPath();
        ctx.arc(s / 2, s / 2, s * 0.42, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.lineWidth = s * 0.07;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${s * 0.32}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(sprite.userData.number), s / 2, s / 2 + s * 0.02);
    sprite.material.map.needsUpdate = true;
}

function setMarkerProgress(sprite, progress) {
    const step = Math.round(progress * 24);
    if (sprite.userData.progressStep === step) return;
    sprite.userData.progressStep = step;
    drawMarker(sprite, step / 24);
}

// ── Ghost hull ───────────────────────────────────────────────────────────
//
// Built in the ship's own frame (x forward, y up from the keel, z to
// starboard, metres; x matches distance along the scanned wreck), then placed
// with the keel point and the forward, up and starboard directions measured
// from the scan, so it takes the wreck's list. The hull is sized from the
// registered dimensions. The deckhouse, wheelhouse, funnel, masts and towing
// gear follow the layout steam tugs of the period share; their sizes and
// positions are set in the data file and are indicative.

function makeGhost(g) {
    const group = new THREE.Group();
    group.name = 'ghost-as-built';
    const h = g.hull || {};
    const L = g.bow - g.stern;
    const halfBeam = g.beam / 2;
    const deckSide = h.deckAtSide ?? g.depth;
    const bulwark = h.bulwark ?? 0.85;
    const sheerBow = h.sheerBow ?? 1.2;
    const sheerStern = h.sheerStern ?? 0.4;
    const counter = h.counter ?? 2.5;          // round stern overhang aft of the sternpost
    const sternpost = g.stern + counter;
    const midship = g.stern + 0.45 * L;

    // Plan: a round stern (half circle about the half beam), parallel body,
    // and a bow whose length and fullness are set in the data (a higher
    // fullness keeps the beam further forward, as on a tug).
    const bowStart = g.bow - (h.bowLength ?? 0.42) * L;
    const bowFullness = h.bowFullness ?? 1.8;
    const breadth = (x) => {
        let f = 1;
        if (x < g.stern + halfBeam) f = Math.sqrt(Math.max(0, 1 - ((g.stern + halfBeam - x) / halfBeam) ** 2));
        else if (x > bowStart) f = 1 - ((x - bowStart) / (g.bow - bowStart)) ** bowFullness;
        return halfBeam * Math.max(f, 0.015);
    };

    // The wreck's list changes along its length and the hull has shifted a
    // little. g.twist gives, at stations along the hull, the change in list
    // (degrees, more to port is positive) and the shift (up and starboard,
    // metres) from the overall placement. Everything is bent to follow it.
    const twist = g.twist;
    const twistAt = (x) => {
        if (!twist?.at?.length) return [0, 0, 0];
        const at = twist.at;
        let i = 0;
        while (i < at.length - 2 && x > at[i + 1]) i++;
        const t = THREE.MathUtils.clamp((x - at[i]) / (at[i + 1] - at[i] || 1), 0, 1);
        const lerp = (arr) => arr[i] + (arr[i + 1] - arr[i]) * t;
        return [THREE.MathUtils.degToRad(lerp(twist.roll)), lerp(twist.up), lerp(twist.starboard)];
    };
    const warp = (arr) => {
        for (let k = 0; k < arr.length; k += 3) {
            const [d, du, ds] = twistAt(arr[k]);
            if (!d && !du && !ds) continue;
            const y = arr[k + 1], z = arr[k + 2], cos = Math.cos(d), sin = Math.sin(d);
            arr[k + 1] = du + y * cos + z * sin;
            arr[k + 2] = ds - y * sin + z * cos;
        }
        return arr;
    };
    // Deck at side with sheer rising to both ends, more at the bow.
    const deck = (x) => deckSide + (x > midship
        ? sheerBow * ((x - midship) / (g.bow - midship)) ** 2
        : sheerStern * ((midship - x) / (midship - g.stern)) ** 2);
    // Stern of a single screw steamer: the hull runs aft to a thin
    // propeller post; aft of it is the open aperture for the propeller, then
    // the rudder hung on the sternpost, all under the counter, which
    // overhangs to the round stern. The keel runs on under the aperture as
    // the sole piece. The forefoot rounds up into a near plumb stem.
    const aperture = h.aperture ?? 1.5;            // propeller post to sternpost
    const propPost = sternpost + aperture;
    const counterBottom = h.counterBottom ?? 3.0;  // underside of the counter above the keel
    const run = h.run ?? 7;                        // length over which the lower hull fines to the propeller post
    const forefoot = 3.5;
    const bottom = (x) => {
        if (x < sternpost) {
            const k = (sternpost - x) / (sternpost - g.stern);
            return counterBottom + (deck(x) - 0.35 - counterBottom) * (1 - Math.sqrt(Math.max(0, 1 - k * k)));
        }
        if (x < propPost) return counterBottom;
        if (x > g.bow - forefoot) return deck(x) * (1 - Math.sqrt(Math.max(0, 1 - ((x - (g.bow - forefoot)) / forefoot) ** 2)));
        return 0;
    };
    // The lower hull fines away towards the propeller post below the counter.
    const smooth = (t) => { t = THREE.MathUtils.clamp(t, 0, 1); return t * t * (3 - 2 * t); };
    const runFactor = (x, y) => {
        if (x < propPost || x > propPost + run) return 1;
        const f = 0.04 + 0.96 * smooth((x - propPost) / run);
        return f + (1 - f) * smooth((y - (counterBottom - 1.2)) / 1.2);
    };
    // Section: rounded bilge low down, wall sided above.
    const section = (eta) => (eta < 0.42 ? Math.pow(1 - Math.pow(1 - eta / 0.42, 2.2), 1 / 2.2) : 1);

    // Stations: evenly spaced, plus either side of the propeller post so
    // the aperture has a clean edge.
    const XS = [];
    for (let i = 0; i <= 80; i++) XS.push(g.stern + (i / 80) * L);
    XS.push(propPost - 0.002, propPost + 0.002, sternpost);
    XS.sort((a, b) => a - b);
    const STATIONS = XS.length - 1;
    const ROWS = 16;
    const xAt = (i) => XS[i];
    const hullPoint = (x, side, eta) => {
        const yb = bottom(x);
        const y = yb + (deck(x) - yb) * eta;
        return [x, y, side * breadth(x) * section(eta) * runFactor(x, y)];
    };

    // ── Surfaces ──────────────────────────────────────────────────────
    // Painted, planked and varnished materials with textures drawn in the
    // browser. UVs are in metres in the ship's frame, set before the twist
    // is applied, so paint lines (the waterline, plating seams) stay level
    // with the ship.
    const mats = shipMaterials(h.waterline ?? 2.9);
    const meshes = [];
    const addMesh = (geo, material, uv = 'box') => {
        if (uv === 'box') boxUV(geo);
        warp(geo.attributes.position.array);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.raycast = () => {};
        meshes.push(mesh);
        return mesh;
    };
    const gridGeo = (rows, point, uvOf) => {
        const pos = [], uv = [], idx = [];
        for (let i = 0; i <= STATIONS; i++) {
            for (let j = 0; j < rows; j++) {
                const p = point(xAt(i), j);
                pos.push(...p);
                uv.push(...uvOf(p));
            }
        }
        for (let i = 0; i < STATIONS; i++) {
            for (let j = 0; j < rows - 1; j++) {
                const q = i * rows + j;
                idx.push(q, q + rows, q + 1, q + 1, q + rows, q + rows + 1);
            }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.setIndex(idx);
        return geo;
    };
    const sideUV = (p) => [p[0], p[1]];

    // Shell: port deck edge, round the keel, starboard deck edge; then the
    // bulwarks and the deck.
    const cols = ROWS * 2 + 1;
    addMesh(gridGeo(cols, (x, j) => {
        const side = j < ROWS ? -1 : 1;
        return hullPoint(x, side, j < ROWS ? 1 - j / ROWS : (j - ROWS) / ROWS);
    }, sideUV), mats.hull, 'given');
    for (const side of [-1, 1]) {
        addMesh(gridGeo(2, (x, j) => [x, deck(x) + j * bulwark, side * breadth(x)], sideUV), mats.hull, 'given');
    }
    addMesh(gridGeo(2, (x, j) => [x, deck(x), (j ? 1 : -1) * breadth(x)], (p) => [p[0], p[2]]), mats.deck, 'given');

    // Round bars between two points, and tubes along a run of points.
    const up = new THREE.Vector3(0, 1, 0);
    const bar = (a, b, radius, material, sides = 8) => {
        const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
        const dir = B.clone().sub(A);
        const geo = new THREE.CylinderGeometry(radius, radius, dir.length(), sides, 1, false);
        geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize()));
        geo.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
        return addMesh(geo, material);
    };
    const tube = (pts, radius, material, segments = 64) => {
        const curve = new THREE.CatmullRomCurve3(pts.map((q) => new THREE.Vector3(...q)));
        return addMesh(new THREE.TubeGeometry(curve, segments, radius, 8, false), material);
    };
    const along = (fn) => { const pts = []; for (let i = 0; i <= STATIONS; i += 2) pts.push(fn(xAt(i))); return pts; };

    // Rubbing strake at deck level and a timber cap rail on the bulwarks.
    for (const side of [-1, 1]) {
        tube(along((x) => [x, deck(x) - 0.12, side * (breadth(x) + 0.07)]), 0.11, mats.blackSteel, 160);
        tube(along((x) => [x, deck(x) + bulwark + 0.03, side * breadth(x)]), 0.06, mats.timber, 160);
    }

    // Her name on both bows.
    const nameAt = g.bow - 3.2;
    for (const side of [-1, 1]) {
        const slope = (breadth(nameAt + 0.1) - breadth(nameAt - 0.1)) / 0.2;
        const plane = new THREE.PlaneGeometry(2.6, 0.65);
        // Face out from the hull side as it narrows towards the stem.
        plane.rotateY(side > 0 ? -Math.atan(slope) : Math.PI + Math.atan(slope));
        plane.translate(nameAt, deck(nameAt) - 0.55, side * (breadth(nameAt) + 0.03));
        addMesh(plane, mats.name, 'given');
    }

    const box = (x0, x1, y0, height, width, material) => {
        const geo = new THREE.BoxGeometry(x1 - x0, height, width);
        geo.translate((x0 + x1) / 2, y0 + height / 2, 0);
        return addMesh(geo, material);
    };

    // Engine and boiler casing, with the wheelhouse on its forward end.
    let casingTop = deckSide;
    if (g.casing) {
        const c = g.casing;
        const base = deck((c.from + c.to) / 2);
        box(c.from, c.to, base - 0.3, c.height + 0.3, c.width, mats.paint);
        casingTop = base + c.height;
        // Brass portholes along both sides.
        for (let x = c.from + 1.2; x < c.to - 0.6; x += c.portholeSpacing ?? 1.8) {
            for (const side of [-1, 1]) {
                const y = base + c.height * 0.6, z = side * (c.width / 2 + 0.02);
                const rim = new THREE.TorusGeometry(0.19, 0.035, 8, 20);
                rim.translate(x, y, z);
                addMesh(rim, mats.brass);
                const glass = new THREE.CircleGeometry(0.17, 20);
                if (side < 0) glass.rotateY(Math.PI);
                glass.translate(x, y, z);
                addMesh(glass, mats.glass);
            }
        }
        // Engine room skylight: timber frame, glazed top.
        if (c.skylight) {
            const k = c.skylight;
            box(k.from, k.to, casingTop, 0.55, k.width ?? 1.8, mats.timber);
            box(k.from + 0.08, k.to - 0.08, casingTop + 0.55, 0.04, (k.width ?? 1.8) - 0.16, mats.glass);
        }
        // Ship's boat on the after end of the casing, in chocks.
        if (c.boat) {
            const b = c.boat;
            const geo = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
            geo.scale(b.length / 2, 0.75, (b.beam ?? 1.6) / 2);
            geo.translate(b.at, casingTop + 1.0, 0);
            addMesh(geo, mats.boat);
            const rim = new THREE.TorusGeometry(1, 0.05, 6, 40);
            rim.rotateX(Math.PI / 2);
            rim.scale(b.length / 2, 1, (b.beam ?? 1.6) / 2);
            rim.translate(b.at, casingTop + 1.0, 0);
            addMesh(rim, mats.timber);
            for (const dx of [-b.length * 0.3, b.length * 0.3]) box(b.at + dx - 0.15, b.at + dx + 0.15, casingTop, 0.45, (b.beam ?? 1.6) * 0.8, mats.timber);
        }
    }
    let roof = casingTop;
    if (g.wheelhouse) {
        const w = g.wheelhouse, hw = w.width / 2;
        box(w.from, w.to, casingTop, w.height, w.width, mats.timber);
        roof = casingTop + w.height;
        box(w.from - 0.12, w.to + 0.12, roof, 0.1, w.width + 0.24, mats.paint);
        // Windows: a row across the front and down each side.
        const winY = casingTop + w.height * 0.68, winH = w.height * 0.36;
        const pane = (x, z, rotY, width) => {
            const geo = new THREE.PlaneGeometry(width, winH);
            geo.rotateY(rotY);
            geo.translate(x, winY, z);
            addMesh(geo, mats.glass, 'given');
        };
        const across = Math.max(3, Math.floor(w.width / 0.6));
        for (let k = 0; k < across; k++) pane(w.to + 0.015, -hw + (k + 0.5) * (w.width / across), Math.PI / 2, w.width / across - 0.1);
        const aft = Math.max(2, Math.floor((w.to - w.from) / 0.7));
        for (const side of [-1, 1]) {
            for (let k = 0; k < aft; k++) pane(w.from + (k + 0.5) * ((w.to - w.from) / aft), side * (hw + 0.015), side > 0 ? 0 : Math.PI, (w.to - w.from) / aft - 0.12);
        }
        // Open bridge rail on the roof.
        const r = roof + 0.1 + 0.95, corners = [[w.from, r, -hw], [w.to, r, -hw], [w.to, r, hw], [w.from, r, hw]];
        for (let k = 0; k < 4; k++) bar(corners[k], corners[(k + 1) % 4], 0.025, mats.paint, 6);
        for (const [x, , z] of corners) bar([x, roof + 0.1, z], [x, r, z], 0.025, mats.paint, 6);
    }

    // Funnel over the boiler, raked aft, black topped.
    let funnelTop = roof;
    if (g.funnel) {
        const f = g.funnel;
        const rake = THREE.MathUtils.degToRad(f.rake ?? 6);
        const base = casingTop - 0.2;
        const length = deckSide + f.height - base;
        const geo = new THREE.CylinderGeometry(f.radius, f.radius, length, 32, 1, true);
        geo.translate(0, length / 2, 0);
        geo.rotateZ(rake);
        geo.translate(f.at, base, 0);
        addMesh(geo, mats.funnel, 'given');
        funnelTop = base + Math.cos(rake) * length;
        const lip = new THREE.TorusGeometry(f.radius, 0.05, 6, 32);
        lip.rotateX(Math.PI / 2);
        lip.rotateZ(rake);
        lip.translate(f.at - Math.sin(rake) * length, funnelTop, 0);
        addMesh(lip, mats.blackSteel);
        // Cowl ventilators either side, abaft the funnel, mouths forward.
        for (const side of [-1, 1]) {
            const vx = f.at - (f.radius + 0.6), vz = side * (f.radius + 0.25);
            const pipe = new THREE.CylinderGeometry(0.2, 0.2, 2.0, 16, 1, true);
            pipe.translate(vx, casingTop + 1.0, vz);
            addMesh(pipe, mats.paint);
            const cowl = new THREE.CylinderGeometry(0.42, 0.24, 0.6, 18, 1, true);
            cowl.rotateZ(Math.PI / 2);
            cowl.translate(vx + 0.2, casingTop + 2.15, vz);
            addMesh(cowl, mats.paint);
        }
    }

    // Masts with standing rigging. Schooner rig: a foremast and a mainmast.
    const masts = g.masts || [];
    masts.forEach((m, k) => {
        const base = deck(m.at);
        const geo = new THREE.CylinderGeometry(0.09, 0.16, m.height, 14, 1, true);
        geo.translate(m.at, base + m.height / 2, 0);
        addMesh(geo, mats.mast);
        const head = [m.at, base + m.height, 0];
        bar([m.at, base + m.height * 0.72, -1.0], [m.at, base + m.height * 0.72, 1.0], 0.05, mats.mast);   // crosstrees
        for (const side of [-1, 1]) bar(head, [m.at - 1.2, deck(m.at - 1.2) + bulwark, side * breadth(m.at - 1.2)], 0.014, mats.wire, 4);
        if (k === 0) bar(head, [g.bow, deck(g.bow) + bulwark, 0], 0.014, mats.wire, 4);
        if (k === masts.length - 1 && masts.length > 1) bar(head, [masts[0].at, deck(masts[0].at) + masts[0].height * 0.85, 0], 0.014, mats.wire, 4);
    });

    // Towing arches over the after deck, and towing bitts.
    for (const x of g.towingArches || []) {
        const hw = breadth(x) - 0.15, top = deck(x) + bulwark + 0.9;
        const pts = [];
        for (let k = 0; k <= 16; k++) {
            const a = Math.PI * (k / 16);
            pts.push([x, deck(x) + bulwark + (top - deck(x) - bulwark) * Math.sin(a), -hw * Math.cos(a)]);
        }
        tube(pts, 0.07, mats.blackSteel, 32);
    }
    for (const b of g.bitts || []) {
        for (const side of [-1, 1]) {
            const geo = new THREE.CylinderGeometry(0.17, 0.17, 0.9, 16);
            geo.translate(b, deck(b) + 0.45, side * 0.45);
            addMesh(geo, mats.blackSteel);
            const cap = new THREE.CylinderGeometry(0.24, 0.24, 0.06, 16);
            cap.translate(b, deck(b) + 0.93, side * 0.45);
            addMesh(cap, mats.blackSteel);
        }
    }

    // Rudder on the sternpost, propeller in the aperture, sole piece below.
    if (h.rudder !== false) {
        const rudderLength = h.rudderLength ?? 1.2;
        box(sternpost - rudderLength, sternpost, 0.25, counterBottom - 0.35, 0.14, mats.hull);
        box(sternpost - rudderLength - 0.3, propPost, 0, 0.2, 0.2, mats.hull);
        const px = (propPost + sternpost) / 2;
        const py = counterBottom / 2 + 0.1;
        const radius = Math.min(1.25, counterBottom / 2 - 0.2);
        const hub = new THREE.CylinderGeometry(0.22, 0.22, 0.5, 16);
        hub.rotateZ(Math.PI / 2);
        hub.translate(px, py, 0);
        addMesh(hub, mats.bronze);
        for (let k = 0; k < 4; k++) {
            const blade = new THREE.CircleGeometry(1, 20);
            blade.scale(radius * 0.42, 0.3, 1);
            blade.translate(radius * 0.55, 0, 0);
            blade.rotateX(0.35);                       // pitch
            blade.rotateZ(Math.PI / 4 + (k * Math.PI) / 2);
            blade.rotateY(Math.PI / 2);
            blade.translate(px, py, 0);
            addMesh(blade, mats.bronze);
        }
    }

    const label = makeTextSprite(g.label || 'As built, indicative');
    label.position.fromArray(warp([g.funnel ? g.funnel.at : 0, Math.max(funnelTop, roof) + 1.4, 0]));

    const ship = new THREE.Group();
    ship.add(...meshes, label);

    // Ship frame to model coordinates.
    const forward = new THREE.Vector3().fromArray(g.forward).normalize();
    const shipUp = new THREE.Vector3().fromArray(g.up).normalize();
    const starboard = new THREE.Vector3().fromArray(g.starboard).normalize();
    ship.matrixAutoUpdate = false;
    ship.matrix.makeBasis(forward, shipUp, starboard).setPosition(new THREE.Vector3().fromArray(g.keel));
    group.add(ship);
    group.visible = false;

    const materials = Object.values(mats);
    return {
        group,
        setOpacity(o) {
            // Blend while fading; fully opaque (and correctly depth sorted)
            // once it is all the way in.
            const opaque = o >= 0.999;
            for (const m of materials) {
                if (m.transparent === opaque) { m.transparent = !opaque; m.needsUpdate = true; }
                m.opacity = o;
            }
            label.material.opacity = o;
        }
    };
}

// UVs in metres from each vertex's position, projected along its main
// normal direction: sides get (along, up), tops get (along, across).
function boxUV(geo) {
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const p = geo.attributes.position, n = geo.attributes.normal;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
        const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
        if (ax >= ay && ax >= az) { uv[i * 2] = p.getZ(i); uv[i * 2 + 1] = p.getY(i); }
        else if (ay >= az) { uv[i * 2] = p.getX(i); uv[i * 2 + 1] = p.getZ(i); }
        else { uv[i * 2] = p.getX(i); uv[i * 2 + 1] = p.getY(i); }
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// ── Materials for the reconstruction ────────────────────────────────────
//
// Paint schemes follow steam tugs of the period: black topsides, red
// antifouling below the waterline, a white deckhouse, a varnished timber
// wheelhouse, a scrubbed timber deck and a black-topped buff funnel. The
// Euro's actual colours are not recorded in our sources.

let shipMaterialCache = null;
function shipMaterials(waterline) {
    if (shipMaterialCache?.waterline === waterline) return shipMaterialCache.mats;
    const texture = (canvas, repeatU, repeatV, colour = true) => {
        const t = new THREE.CanvasTexture(canvas);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(repeatU, repeatV);
        t.anisotropy = 8;
        if (colour) t.colorSpace = THREE.SRGBColorSpace;
        return t;
    };
    const standard = (options) => new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide, ...options });

    const hull = drawHull(waterline);
    const deck = drawDeck();
    const paint = drawPaint();
    const timber = drawTimber();
    const mats = {
        hull: standard({ map: texture(hull.colour, 1 / 16, 1 / 8), bumpMap: texture(hull.bump, 1 / 16, 1 / 8, false), bumpScale: 1.5, roughnessMap: texture(hull.rough, 1 / 16, 1 / 8, false), roughness: 1, metalness: 0.2 }),
        deck: standard({ map: texture(deck.colour, 1 / 8, 1 / 4), bumpMap: texture(deck.bump, 1 / 8, 1 / 4, false), bumpScale: 1.2, roughness: 0.85, metalness: 0 }),
        paint: standard({ map: texture(paint, 1 / 4, 1 / 4), roughness: 0.55, metalness: 0.05 }),
        timber: standard({ map: texture(timber, 1 / 2, 1 / 2), roughness: 0.45, metalness: 0 }),
        mast: standard({ map: texture(timber, 1 / 2, 1 / 2), color: '#d9b98c', roughness: 0.5, metalness: 0 }),
        funnel: standard({ map: texture(drawFunnel(), 1, 1), roughness: 0.6, metalness: 0.1 }),
        blackSteel: standard({ color: '#1c1c1c', roughness: 0.55, metalness: 0.3 }),
        wire: standard({ color: '#2b2b2b', roughness: 0.6, metalness: 0.4 }),
        brass: standard({ color: '#c09444', roughness: 0.35, metalness: 0.55 }),
        bronze: standard({ color: '#a8733f', roughness: 0.4, metalness: 0.55 }),
        glass: standard({ color: '#1a2a33', roughness: 0.08, metalness: 0.4 }),
        boat: standard({ color: '#eeebe2', roughness: 0.5, metalness: 0 }),
        name: standard({ map: drawName('EURO'), alphaTest: 0.3, roughness: 0.6, metalness: 0 })
    };
    shipMaterialCache = { waterline, mats };
    return mats;
}

const PX = 128; // texture pixels per metre

function seededRandom(seed) {
    return () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
    };
}

function noiseFill(ctx, w, h, amount, seed) {
    const random = seededRandom(seed);
    const image = ctx.getImageData(0, 0, w, h);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
        const n = (random() - 0.5) * amount;
        d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(image, 0, 0);
}

function blotches(ctx, w, h, count, colours, seed, size = [20, 120]) {
    const random = seededRandom(seed);
    for (let i = 0; i < count; i++) {
        const x = random() * w, y = random() * h, r = size[0] + random() * (size[1] - size[0]);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, colours[Math.floor(random() * colours.length)]);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
}

// Hull plating 16 m long by 8 m high (v = height above the keel): black
// above the waterline, red antifouling below, riveted lapped strakes.
function drawHull(waterline) {
    const W = 16 * PX, H = 8 * PX;
    const make = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const colour = make(), bump = make(), rough = make();
    const c = colour.getContext('2d'), b = bump.getContext('2d'), r = rough.getContext('2d');
    const yPx = (y) => H - y * PX; // canvas rows run downwards; texture v runs up
    const wl = yPx(waterline);

    c.fillStyle = '#18191b'; c.fillRect(0, 0, W, wl);
    c.fillStyle = '#6b2419'; c.fillRect(0, wl, W, H - wl);
    blotches(c, W, wl, 160, ['rgba(70,70,72,0.10)', 'rgba(0,0,0,0.18)'], 3);
    c.save(); c.translate(0, wl);
    blotches(c, W, H - wl, 120, ['rgba(120,50,35,0.18)', 'rgba(40,14,10,0.2)'], 4);
    c.restore();
    // A little light scum and staining along the waterline.
    const scum = c.createLinearGradient(0, wl - 10, 0, wl + 14);
    scum.addColorStop(0, 'rgba(0,0,0,0)'); scum.addColorStop(0.5, 'rgba(150,140,120,0.18)'); scum.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = scum; c.fillRect(0, wl - 10, W, 24);

    b.fillStyle = '#808080'; b.fillRect(0, 0, W, H);
    r.fillStyle = '#7a7a7a'; r.fillRect(0, 0, W, wl);
    r.fillStyle = '#b4b4b4'; r.fillRect(0, wl, W, H - wl);

    const strake = 0.85, butt = 5.4, pitch = 0.075;
    const random = seededRandom(9);
    for (let k = 0, y = strake; y < 8; k++, y += strake) {
        const py = yPx(y);
        // Lap: the upper plate's edge casts a fine line and stands proud.
        c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(0, py, W, 2);
        c.fillStyle = 'rgba(255,255,255,0.05)'; c.fillRect(0, py - 2, W, 1);
        b.fillStyle = '#9a9a9a'; b.fillRect(0, py - 10, W, 10);
        b.fillStyle = '#5a5a5a'; b.fillRect(0, py, W, 2);
        for (let x = 0; x < W; x += pitch * PX) {
            for (const dy of [-6, -16]) {
                b.fillStyle = '#c8c8c8'; b.beginPath(); b.arc(x + (dy === -16 ? pitch * PX / 2 : 0), py + dy, 2.2, 0, Math.PI * 2); b.fill();
            }
        }
        // Butts, staggered strake to strake.
        const offset = (k % 2) * butt / 2;
        for (let x = offset; x < 16; x += butt) {
            const px = x * PX, top = yPx(y + strake);
            c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(px, top, 2, py - top);
            b.fillStyle = '#606060'; b.fillRect(px, top, 2, py - top);
            for (let yy = top + 6; yy < py - 6; yy += pitch * PX) {
                b.fillStyle = '#c8c8c8';
                for (const dx of [-7, 9]) { b.beginPath(); b.arc(px + dx, yy, 2.2, 0, Math.PI * 2); b.fill(); }
            }
        }
        if (random() < 0.3) { r.fillStyle = 'rgba(255,255,255,0.05)'; r.fillRect(0, yPx(y + strake), W, strake * PX); }
    }
    noiseFill(c, W, H, 10, 11);
    noiseFill(b, W, H, 14, 12);
    return { colour, bump, rough };
}

// Deck planking 8 m along by 4 m across, planks running fore and aft.
function drawDeck() {
    const W = 8 * PX, H = 4 * PX;
    const colour = document.createElement('canvas'), bump = document.createElement('canvas');
    colour.width = bump.width = W; colour.height = bump.height = H;
    const c = colour.getContext('2d'), b = bump.getContext('2d');
    const random = seededRandom(21);
    const plank = 0.14 * PX;
    b.fillStyle = '#909090'; b.fillRect(0, 0, W, H);
    for (let y = 0, k = 0; y < H; y += plank, k++) {
        let x = -random() * 5 * PX;
        while (x < W) {
            const len = (4 + random() * 3) * PX;
            const tone = 150 + random() * 40;
            c.fillStyle = `rgb(${tone + 12},${tone - 6},${tone - 38})`;
            c.fillRect(x, y, len, plank);
            // Grain.
            for (let g = 0; g < 14; g++) {
                c.strokeStyle = `rgba(${90 + random() * 40},${60 + random() * 30},${30},${0.12 + random() * 0.12})`;
                c.lineWidth = 1;
                c.beginPath();
                const gy = y + random() * plank;
                c.moveTo(x, gy);
                for (let gx = x; gx < x + len; gx += 40) c.lineTo(gx, gy + Math.sin(gx * 0.01 + g) * 1.5);
                c.stroke();
            }
            // Butt joint and caulking.
            c.fillStyle = '#2a2118'; c.fillRect(x, y, 3, plank);
            b.fillStyle = '#404040'; b.fillRect(x, y, 3, plank);
            x += len;
        }
        c.fillStyle = '#231b14'; c.fillRect(0, y, W, 3);
        b.fillStyle = '#404040'; b.fillRect(0, y, W, 3);
    }
    blotches(c, W, H, 60, ['rgba(255,250,235,0.08)', 'rgba(60,45,30,0.10)'], 22);
    noiseFill(c, W, H, 12, 23);
    noiseFill(b, W, H, 10, 24);
    return { colour, bump };
}

// White painted steel, 4 m square.
function drawPaint() {
    const W = 4 * PX;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = W;
    const c = canvas.getContext('2d');
    c.fillStyle = '#e6e2d6'; c.fillRect(0, 0, W, W);
    blotches(c, W, W, 40, ['rgba(120,110,90,0.06)', 'rgba(255,255,255,0.08)'], 31);
    for (let x = 0; x < W; x += 1.3 * PX) { c.fillStyle = 'rgba(0,0,0,0.07)'; c.fillRect(x, 0, 2, W); }
    noiseFill(c, W, W, 6, 32);
    return canvas;
}

// Varnished tongue and groove boards, 2 m square, boards running up.
function drawTimber() {
    const W = 2 * PX;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = W * 2;
    const c = canvas.getContext('2d');
    const S = canvas.width, board = 0.1 * PX * 2;
    const random = seededRandom(41);
    for (let x = 0; x < S; x += board) {
        const tone = 0.85 + random() * 0.3;
        c.fillStyle = `rgb(${Math.round(128 * tone)},${Math.round(76 * tone)},${Math.round(38 * tone)})`;
        c.fillRect(x, 0, board, S);
        for (let g = 0; g < 10; g++) {
            c.strokeStyle = `rgba(60,30,12,${0.15 + random() * 0.15})`;
            c.lineWidth = 1 + random();
            c.beginPath();
            const gx = x + random() * board;
            c.moveTo(gx, 0);
            for (let y = 0; y < S; y += 30) c.lineTo(gx + Math.sin(y * 0.02 + g * 1.7) * 2, y);
            c.stroke();
        }
        c.fillStyle = 'rgba(30,15,5,0.6)'; c.fillRect(x, 0, 2, S);
    }
    // Varnish sheen.
    const sheen = c.createLinearGradient(0, 0, 0, S);
    sheen.addColorStop(0, 'rgba(255,220,170,0.08)'); sheen.addColorStop(1, 'rgba(0,0,0,0.05)');
    c.fillStyle = sheen; c.fillRect(0, 0, S, S);
    noiseFill(c, S, S, 8, 42);
    return canvas;
}

// Funnel: buff, black top, a little soot.
function drawFunnel() {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 1024;
    const c = canvas.getContext('2d');
    c.fillStyle = '#c4a165'; c.fillRect(0, 0, 256, 1024);
    c.fillStyle = '#141414'; c.fillRect(0, 0, 256, 170);
    const soot = c.createLinearGradient(0, 170, 0, 330);
    soot.addColorStop(0, 'rgba(20,20,20,0.35)'); soot.addColorStop(1, 'rgba(20,20,20,0)');
    c.fillStyle = soot; c.fillRect(0, 170, 256, 160);
    for (let y = 300; y < 1024; y += 150) { c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(0, y, 256, 3); }
    noiseFill(c, 256, 1024, 8, 51);
    return canvas;
}

function drawName(text) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
    const c = canvas.getContext('2d');
    c.fillStyle = '#f2efe6';
    c.font = 'bold 112px Georgia, "Times New Roman", serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, 256, 68);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
}

function makeTextSprite(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    ctx.font = '600 64px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(0, 20, 34, 0.8)';
    ctx.strokeText(text, 512, 80);
    ctx.fillStyle = '#dff7ff';
    ctx.fillText(text, 512, 80);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, fog: false }));
    sprite.scale.set(6.4, 1, 1);
    sprite.renderOrder = 21;
    return sprite;
}

// ── VR card ──────────────────────────────────────────────────────────────

function makeVrCard() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, fog: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.renderOrder = 30;
    mesh.visible = false;
    mesh.raycast = () => {};
    let current = null;

    const render = (poi) => {
        current = poi;
        const height = drawCard(canvas, poi, () => { if (current === poi) render(poi); });
        // Show only the part of the canvas the card uses.
        texture.repeat.set(1, height / canvas.height);
        texture.offset.set(0, 1 - height / canvas.height);
        texture.needsUpdate = true;
        mesh.scale.set(PANEL_WIDTH, PANEL_WIDTH * height / canvas.width, 1);
        return canvas;
    };

    const right = new THREE.Vector3();
    return {
        mesh,
        render,
        show(poi, eye, forward) {
            render(poi);
            // Off to the right of where you are looking, so the marker stays
            // in view, at about the height you are looking (within reason).
            const flat = new THREE.Vector3(forward.x, 0, forward.z);
            if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
            flat.normalize();
            right.set(-flat.z, 0, flat.x);
            const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)), -0.6, 0.25);
            const direction = flat.clone().multiplyScalar(Math.cos(0.45)).addScaledVector(right, Math.sin(0.45))
                .multiplyScalar(Math.cos(pitch));
            direction.y = Math.sin(pitch);
            mesh.position.copy(eye).addScaledVector(direction, PANEL_DISTANCE);
            mesh.lookAt(eye);
            mesh.visible = true;
        },
        hide() { mesh.visible = false; current = null; }
    };
}

// Draws a card onto the canvas and returns the height used. Pictures load
// in the background and call redraw when ready.
const images = new Map();
function drawCard(canvas, poi, redraw) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const pad = 48;
    ctx.clearRect(0, 0, W, canvas.height);

    let image = null;
    if (poi.photo) {
        image = images.get(poi.photo);
        if (!image) {
            image = new Image();
            image.onload = redraw;
            image.src = poi.photo;
            images.set(poi.photo, image);
        }
        if (!image.complete || !image.naturalWidth) image = null;
    }

    const imageHeight = image ? Math.round((W - pad * 2) * 9 / 16) : 0;
    ctx.font = '400 34px -apple-system, "Segoe UI", Roboto, sans-serif';
    const bodyLines = wrap(ctx, poi.text || '', W - pad * 2);
    const sourceText = `${poi.approximate ? 'Position approximate. ' : ''}${image && poi.photoCredit ? poi.photoCredit + '. ' : ''}Source: ${poi.source || ''}`;
    ctx.font = '400 26px -apple-system, "Segoe UI", Roboto, sans-serif';
    const sourceLines = wrap(ctx, sourceText, W - pad * 2);
    const height = Math.min(canvas.height,
        pad + (image ? imageHeight + 32 : 0) + 64 + 44 + 24 + bodyLines.length * 46 + 24 + sourceLines.length * 34 + pad);

    roundRect(ctx, 0, 0, W, height, 36);
    ctx.fillStyle = 'rgba(2, 22, 36, 0.92)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255, 211, 107, 0.8)';
    ctx.stroke();

    let y = pad;
    if (image) {
        ctx.save();
        roundRect(ctx, pad, y, W - pad * 2, imageHeight, 18);
        ctx.clip();
        const scale = Math.max((W - pad * 2) / image.naturalWidth, imageHeight / image.naturalHeight);
        const w = image.naturalWidth * scale;
        const h = image.naturalHeight * scale;
        ctx.drawImage(image, pad + (W - pad * 2 - w) / 2, y + (imageHeight - h) / 2, w, h);
        ctx.restore();
        y += imageHeight + 32;
    }
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.font = '600 54px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(`${poi.number}. ${poi.title}`, pad, y);
    y += 64;
    ctx.fillStyle = '#ffd36b';
    ctx.font = '500 30px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(poi.built || '', pad, y);
    y += 44 + 24;
    ctx.fillStyle = '#d6e9f5';
    ctx.font = '400 34px -apple-system, "Segoe UI", Roboto, sans-serif';
    for (const line of bodyLines) { ctx.fillText(line, pad, y); y += 46; }
    y += 24;
    ctx.fillStyle = '#86a9bf';
    ctx.font = '400 26px -apple-system, "Segoe UI", Roboto, sans-serif';
    for (const line of sourceLines) { ctx.fillText(line, pad, y); y += 34; }
    return height;
}

function wrap(ctx, text, width) {
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > width && line) {
            lines.push(line);
            line = word;
        } else {
            line = test;
        }
    }
    if (line) lines.push(line);
    return lines;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// ── Depth gauge (VR, left wrist) ─────────────────────────────────────────

function makeGauge() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 384;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, fog: false, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.04, 48), material);
    mesh.renderOrder = 25;
    mesh.raycast = () => {};
    // On the back of the wrist, tilted towards you when you raise your arm.
    mesh.position.set(0, 0.035, 0.09);
    mesh.rotation.set(-Math.PI / 2 + 0.5, 0, 0);
    // Circle UVs map to the square canvas.

    return {
        mesh,
        draw({ depth, max, seconds, rate }) {
            const ctx = canvas.getContext('2d');
            const s = canvas.width;
            const cx = s / 2;
            ctx.clearRect(0, 0, s, s);
            ctx.beginPath();
            ctx.arc(cx, cx, s / 2 - 4, 0, Math.PI * 2);
            ctx.fillStyle = '#04121d';
            ctx.fill();
            ctx.lineWidth = 8;
            ctx.strokeStyle = '#ffd36b';
            ctx.stroke();

            const fast = rate > ASCENT_WARN;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#7fa3ba';
            ctx.font = '600 30px -apple-system, "Segoe UI", Roboto, sans-serif';
            ctx.fillText('DEPTH', cx, 84);
            ctx.fillStyle = '#ffffff';
            ctx.font = '700 104px -apple-system, "Segoe UI", Roboto, sans-serif';
            ctx.fillText(depth.toFixed(1), cx - 18, 160);
            ctx.font = '600 40px -apple-system, "Segoe UI", Roboto, sans-serif';
            ctx.fillText('m', cx + 118, 176);

            ctx.font = '500 32px -apple-system, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = '#d6e9f5';
            const minutes = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            ctx.fillText(`MAX ${max.toFixed(1)} m`, cx, 232);
            ctx.fillText(`TIME ${minutes}:${String(secs).padStart(2, '0')}`, cx, 274);

            ctx.font = fast ? '700 34px -apple-system, "Segoe UI", Roboto, sans-serif' : '500 28px -apple-system, "Segoe UI", Roboto, sans-serif';
            ctx.fillStyle = fast ? '#ff5a4f' : '#7fa3ba';
            const shown = Math.abs(rate) < 0.5 ? 0 : rate;
            ctx.fillText(fast ? 'SLOW DOWN' : `${shown > 0 ? 'UP' : shown < 0 ? 'DOWN' : 'RATE'} ${Math.abs(shown).toFixed(0)} m/min`, cx, 320);
            texture.needsUpdate = true;
            return canvas;
        }
    };
}

// ── Browser panel and card ───────────────────────────────────────────────

function makeDesktopUi(parent) {
    const panel = document.createElement('div');
    panel.className = 'wx-panel';
    panel.hidden = true;
    panel.innerHTML = `
        <button type="button" class="wx-panel__toggle" aria-expanded="true">Explore the wreck</button>
        <div class="wx-panel__body">
            <ol class="wx-panel__pois"></ol>
            <div class="wx-panel__then" hidden>
                <label class="wx-panel__label" for="wx-then">Then and now</label>
                <input id="wx-then" type="range" min="0" max="1" step="0.01" value="0">
                <div class="wx-panel__scale"><span>Today</span><span class="wx-panel__built"></span></div>
                <p class="wx-panel__note"></p>
            </div>
            <p class="wx-panel__depth" title=""></p>
        </div>`;
    parent.appendChild(panel);
    const toggle = panel.querySelector('.wx-panel__toggle');
    const list = panel.querySelector('.wx-panel__pois');
    const then = panel.querySelector('.wx-panel__then');
    const slider = panel.querySelector('#wx-then');
    const depthEl = panel.querySelector('.wx-panel__depth');
    toggle.addEventListener('click', () => {
        const open = panel.classList.toggle('is-collapsed') === false;
        toggle.setAttribute('aria-expanded', String(open));
    });
    // Start collapsed on small screens.
    if (window.matchMedia('(max-width: 640px)').matches) {
        panel.classList.add('is-collapsed');
        toggle.setAttribute('aria-expanded', 'false');
    }
    let onBlend = () => {};
    slider.addEventListener('input', () => onBlend(Number(slider.value)));
    let lastDepth = '';

    return {
        show(state, handlers) {
            onBlend = handlers.onBlend;
            list.innerHTML = '';
            for (const m of state.markers) {
                const poi = m.userData.poi;
                const li = document.createElement('li');
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.id = poi.id;
                button.innerHTML = `<span class="wx-num">${poi.number}</span>`;
                button.append(document.createTextNode(poi.title));
                button.addEventListener('click', () => handlers.onPoi(poi));
                li.appendChild(button);
                list.appendChild(li);
            }
            then.hidden = !handlers.hasGhost;
            if (state.data.ghost) {
                panel.querySelector('.wx-panel__built').textContent = (state.data.built?.match(/\d{4}/)?.[0] || 'As built') + ' (indicative)';
                panel.querySelector('.wx-panel__note').textContent = state.data.ghost.note || '';
            }
            depthEl.title = state.data.seabedDepthNote || '';
            slider.value = '0';
            panel.hidden = false;
        },
        hide() { panel.hidden = true; },
        collapse() {
            panel.classList.add('is-collapsed');
            toggle.setAttribute('aria-expanded', 'false');
        },
        select(id) {
            for (const b of list.querySelectorAll('button')) b.classList.toggle('is-active', b.dataset.id === id);
        },
        setBlend(value) { slider.value = String(value); },
        setDepth(depth, seabed) {
            const text = seabed ? `Depth ${depth.toFixed(1)} m (seabed ${seabed} m)` : '';
            if (text !== lastDepth) { depthEl.textContent = text; lastDepth = text; }
        }
    };
}

function makeCard(parent) {
    const card = document.createElement('aside');
    card.className = 'wx-card';
    card.hidden = true;
    card.innerHTML = `
        <button type="button" class="wx-card__close" aria-label="Close">&times;</button>
        <img class="wx-card__photo" alt="">
        <h2 class="wx-card__title"></h2>
        <p class="wx-card__built"></p>
        <p class="wx-card__text"></p>
        <p class="wx-card__source"></p>`;
    parent.appendChild(card);
    const photo = card.querySelector('.wx-card__photo');
    card.querySelector('.wx-card__close').addEventListener('click', () => { card.hidden = true; });
    return {
        show(poi) {
            photo.hidden = !poi.photo;
            if (poi.photo) {
                photo.src = poi.photo;
                photo.alt = poi.photoAlt || poi.title;
            }
            card.querySelector('.wx-card__title').textContent = `${poi.number}. ${poi.title}`;
            card.querySelector('.wx-card__built').textContent = poi.built || '';
            card.querySelector('.wx-card__text').textContent = poi.text || '';
            card.querySelector('.wx-card__source').textContent =
                `${poi.approximate ? 'Position approximate. ' : ''}${poi.photoCredit ? poi.photoCredit + '. ' : ''}Source: ${poi.source || ''}`;
            card.hidden = false;
        },
        hide() { card.hidden = true; }
    };
}
