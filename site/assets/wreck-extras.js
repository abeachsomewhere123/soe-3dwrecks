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

const GHOST_COLOUR = new THREE.Color('#9fe8ff');

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

    const positions = [];
    const index = [];
    const grid = (rows, point) => {
        const start = positions.length / 3;
        for (let i = 0; i <= STATIONS; i++) for (let j = 0; j < rows; j++) positions.push(...point(xAt(i), j));
        for (let i = 0; i < STATIONS; i++) {
            for (let j = 0; j < rows - 1; j++) {
                const p = start + i * rows + j;
                index.push(p, p + rows, p + 1, p + 1, p + rows, p + rows + 1);
            }
        }
    };
    // Shell: port deck edge, round the keel, starboard deck edge.
    const cols = ROWS * 2 + 1;
    grid(cols, (x, j) => {
        const side = j < ROWS ? -1 : 1;
        return hullPoint(x, side, j < ROWS ? 1 - j / ROWS : (j - ROWS) / ROWS);
    });
    // Bulwarks, each side.
    for (const side of [-1, 1]) grid(2, (x, j) => [x, deck(x) + j * bulwark, side * breadth(x)]);
    // Deck.
    grid(2, (x, j) => [x, deck(x), (j ? 1 : -1) * breadth(x)]);

    const shell = new THREE.BufferGeometry();
    shell.setAttribute('position', new THREE.Float32BufferAttribute(warp(positions), 3));
    shell.setIndex(index);
    shell.computeVertexNormals();

    const surfaceMaterial = makeGhostMaterial();
    const meshes = [new THREE.Mesh(shell, surfaceMaterial)];

    // Blueprint lines.
    const lines = [];
    const polyline = (pts, closed = false) => {
        for (let k = 0; k < pts.length - 1; k++) lines.push(...pts[k], ...pts[k + 1]);
        if (closed) lines.push(...pts[pts.length - 1], ...pts[0]);
    };
    const along = (fn) => { const pts = []; for (let i = 0; i <= STATIONS; i++) pts.push(fn(xAt(i))); return pts; };
    for (let x = Math.ceil(g.stern / 2) * 2; x <= g.bow; x += 2) {
        const pts = [];
        for (let j = 0; j < cols; j++) {
            const side = j < ROWS ? -1 : 1;
            pts.push(hullPoint(x, side, j < ROWS ? 1 - j / ROWS : (j - ROWS) / ROWS));
        }
        polyline(pts);
    }
    for (const side of [-1, 1]) {
        polyline(along((x) => [x, deck(x), side * breadth(x)]));                      // deck edge and rubbing strake
        polyline(along((x) => [x, deck(x) + bulwark, side * breadth(x)]));            // rail
    }
    polyline(along((x) => [x, bottom(x), 0]));                                          // keel, stem and counter

    // Fittings: boxes and cylinders share the ghost surface; their edges
    // are drawn as lines.
    const add = (geo, edges = true) => {
        if (edges) {
            const e = new THREE.EdgesGeometry(geo, 25).attributes.position.array;
            for (let k = 0; k < e.length; k++) lines.push(e[k]);
        }
        warp(geo.attributes.position.array);
        geo.computeVertexNormals();
        meshes.push(new THREE.Mesh(geo, surfaceMaterial));
    };
    const box = (x0, x1, y0, height, width) => {
        const geo = new THREE.BoxGeometry(x1 - x0, height, width);
        geo.translate((x0 + x1) / 2, y0 + height / 2, 0);
        add(geo);
    };
    const ring = (x, y, z, r, axis = 'y', n = 24) => {
        const pts = [];
        for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2;
            pts.push(axis === 'y' ? [x + r * Math.cos(a), y, z + r * Math.sin(a)]
                : axis === 'z' ? [x + r * Math.cos(a), y + r * Math.sin(a), z]
                : [x, y + r * Math.cos(a), z + r * Math.sin(a)]);
        }
        polyline(pts, true);
    };

    // Engine and boiler casing, with the wheelhouse on its forward end.
    let casingTop = deckSide;
    if (g.casing) {
        const c = g.casing;
        const base = deck((c.from + c.to) / 2);
        box(c.from, c.to, base, c.height, c.width);
        casingTop = base + c.height;
        // Portholes along both sides.
        for (let x = c.from + 1.2; x < c.to - 0.6; x += c.portholeSpacing ?? 1.8) {
            for (const side of [-1, 1]) ring(x, base + c.height * 0.6, side * c.width / 2, 0.2, 'z', 12);
        }
        // Engine room skylight.
        if (c.skylight) box(c.skylight.from, c.skylight.to, casingTop, 0.6, c.skylight.width ?? 1.8);
        // Ship's boat on the after end of the casing, keel up the centreline.
        if (c.boat) {
            const b = c.boat;
            const geo = new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
            geo.scale(b.length / 2, 0.75, (b.beam ?? 1.6) / 2);
            geo.translate(b.at, casingTop + 1.0, 0);
            add(geo, false);
            ring(b.at, casingTop + 1.0, 0, 1, 'y', 32);
            const gunwale = lines.length - 32 * 6;
            for (let k = gunwale; k < lines.length; k += 3) {
                lines[k] = b.at + (lines[k] - b.at) * b.length / 2;
                lines[k + 2] = lines[k + 2] * (b.beam ?? 1.6) / 2;
            }
        }
    }
    let roof = casingTop;
    if (g.wheelhouse) {
        const w = g.wheelhouse;
        box(w.from, w.to, casingTop, w.height, w.width);
        roof = casingTop + w.height;
        // Window band and flying bridge rail.
        const y0 = casingTop + w.height * 0.5, y1 = casingTop + w.height * 0.85, hw = w.width / 2;
        for (const y of [y0, y1]) polyline([[w.from, y, -hw], [w.to, y, -hw], [w.to, y, hw], [w.from, y, hw]]);
        for (let z = -hw + 0.55; z < hw - 0.2; z += 0.55) polyline([[w.to, y0, z], [w.to, y1, z]]);
        const r = roof + 0.95;
        polyline([[w.from, r, -hw], [w.to, r, -hw], [w.to, r, hw], [w.from, r, hw]], true);
        for (const [x, z] of [[w.from, -hw], [w.to, -hw], [w.to, hw], [w.from, hw]]) polyline([[x, roof, z], [x, r, z]]);
    }

    // Funnel over the boiler, raked aft, with a band near the top.
    let funnelTop = roof;
    if (g.funnel) {
        const f = g.funnel;
        const rake = THREE.MathUtils.degToRad(f.rake ?? 6);
        const base = casingTop - 0.2;
        const length = deckSide + f.height - base;
        const geo = new THREE.CylinderGeometry(f.radius, f.radius, length, 28, 1, true);
        geo.translate(0, length / 2, 0);
        geo.rotateZ(rake);
        geo.translate(f.at, base, 0);
        add(geo, false);
        const top = (t) => [f.at - Math.sin(rake) * length * t, base + Math.cos(rake) * length * t];
        for (const t of [0.04, 0.82, 0.9, 1]) { const [x, y] = top(t); ring(x, y, 0, f.radius); }
        funnelTop = top(1)[1];
        // Cowl ventilators either side, as on most steam tugs.
        for (const side of [-1, 1]) {
            const vx = f.at + (f.radius + 0.7), vz = side * (f.radius + 0.35);
            const pipe = new THREE.CylinderGeometry(0.2, 0.2, 2.0, 12, 1, true);
            pipe.translate(vx, casingTop + 1.0, vz);
            add(pipe, false);
            const cowl = new THREE.CylinderGeometry(0.42, 0.24, 0.6, 14, 1, true);
            cowl.rotateZ(Math.PI / 2);
            cowl.translate(vx + 0.2, casingTop + 2.15, vz);
            add(cowl, false);
            ring(vx + 0.5, casingTop + 2.15, vz, 0.42, 'x');
        }
    }

    // Masts with stays. Schooner rig: a foremast and a mainmast.
    const masts = g.masts || [];
    masts.forEach((m, k) => {
        const base = deck(m.at);
        const geo = new THREE.CylinderGeometry(0.09, 0.16, m.height, 10, 1, true);
        geo.translate(m.at, base + m.height / 2, 0);
        add(geo, false);
        const head = [m.at, base + m.height, 0];
        polyline([head, [m.at, base, 0]]);
        polyline([[m.at, base + m.height * 0.72, -1.0], [m.at, base + m.height * 0.72, 1.0]]);   // crosstrees
        for (const side of [-1, 1]) polyline([head, [m.at - 1.2, deck(m.at - 1.2) + bulwark, side * breadth(m.at - 1.2)]]);
        if (k === 0) polyline([head, [g.bow, deck(g.bow) + bulwark, 0]]);                  // forestay to the stem head
        if (k === masts.length - 1 && masts.length > 1) polyline([head, [masts[0].at, deck(masts[0].at) + masts[0].height * 0.85, 0]]);
    });

    // Towing arches over the after deck, and towing bitts.
    for (const x of g.towingArches || []) {
        const hw = breadth(x) - 0.15, top = deck(x) + bulwark + 0.9;
        const pts = [];
        for (let k = 0; k <= 16; k++) {
            const a = Math.PI * (k / 16);
            pts.push(new THREE.Vector3(x, deck(x) + bulwark + (top - deck(x) - bulwark) * Math.sin(a), -hw * Math.cos(a)));
        }
        add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.06, 6, false), false);
        polyline(pts.map((v) => v.toArray()));
    }
    for (const b of g.bitts || []) {
        for (const side of [-1, 1]) {
            const geo = new THREE.CylinderGeometry(0.17, 0.17, 0.9, 12);
            geo.translate(b, deck(b) + 0.45, side * 0.45);
            add(geo);
        }
    }

    // Rudder on the sternpost, propeller in the aperture, sole piece below.
    if (h.rudder !== false) {
        const rudderLength = h.rudderLength ?? 1.2;
        const geo = new THREE.BoxGeometry(rudderLength, counterBottom - 0.35, 0.14);
        geo.translate(sternpost - rudderLength / 2, 0.25 + (counterBottom - 0.35) / 2, 0);
        add(geo);
        polyline([[sternpost, 0, 0], [sternpost, counterBottom, 0]]);                  // sternpost
        polyline([[propPost, 0, 0], [propPost, counterBottom, 0]]);                    // propeller post
        polyline([[sternpost - 0.3, 0, 0], [propPost, 0, 0]]);                         // sole piece
        const sole = new THREE.BoxGeometry(propPost - sternpost + 0.3, 0.2, 0.2);
        sole.translate((propPost + sternpost - 0.3) / 2, 0.1, 0);
        add(sole, false);
        // Propeller: hub and four blades, filling most of the aperture height.
        const px = (propPost + sternpost) / 2;
        const py = counterBottom / 2 + 0.1;
        const radius = Math.min(1.25, counterBottom / 2 - 0.2);
        const hub = new THREE.CylinderGeometry(0.22, 0.22, 0.5, 14);
        hub.rotateZ(Math.PI / 2);
        hub.translate(px, py, 0);
        add(hub, false);
        for (let k = 0; k < 4; k++) {
            const a = Math.PI / 4 + (k * Math.PI) / 2;
            const blade = new THREE.CircleGeometry(1, 16);
            blade.scale(radius * 0.42, 0.28, 1);
            blade.translate(radius * 0.55, 0, 0);
            blade.rotateZ(a);
            blade.rotateY(Math.PI / 2);
            blade.translate(px, py, 0);
            add(blade, false);
            polyline([[px, py, 0], [px, py + Math.sin(a) * radius, Math.cos(a) * radius]]);
        }
        ring(px, py, 0, radius, 'x', 32);
    }

    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(warp(lines), 3));
    const lineMaterial = new THREE.LineBasicMaterial({ color: GHOST_COLOUR, transparent: true, depthWrite: false, fog: false });
    const outline = new THREE.LineSegments(lineGeometry, lineMaterial);
    for (const m of meshes) m.raycast = () => {};
    outline.raycast = () => {};

    const label = makeTextSprite(g.label || 'As built, indicative');
    label.position.fromArray(warp([g.funnel ? g.funnel.at : 0, Math.max(funnelTop, roof) + 1.4, 0]));
    label.scale.multiplyScalar(1.0);

    const ship = new THREE.Group();
    ship.add(...meshes, outline, label);

    // Ship frame to model coordinates.
    const forward = new THREE.Vector3().fromArray(g.forward).normalize();
    const up = new THREE.Vector3().fromArray(g.up).normalize();
    const starboard = new THREE.Vector3().fromArray(g.starboard).normalize();
    ship.matrixAutoUpdate = false;
    ship.matrix.makeBasis(forward, up, starboard).setPosition(new THREE.Vector3().fromArray(g.keel));
    group.add(ship);
    group.visible = false;

    return {
        group,
        setOpacity(o) {
            surfaceMaterial.uniforms.uOpacity.value = o;
            lineMaterial.opacity = 0.7 * o;
            label.material.opacity = o;
        }
    };
}

function makeGhostMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            uOpacity: { value: 0 },
            uColour: { value: GHOST_COLOUR.clone() }
        },
        vertexShader: /* glsl */ `
            varying vec3 vNormal;
            varying vec3 vView;
            void main() {
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vNormal = normalize(normalMatrix * normal);
                vView = -mv.xyz;
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: /* glsl */ `
            uniform float uOpacity;
            uniform vec3 uColour;
            varying vec3 vNormal;
            varying vec3 vView;
            void main() {
                float facing = abs(dot(normalize(vNormal), normalize(vView)));
                float rim = pow(1.0 - facing, 2.0);
                gl_FragColor = vec4(uColour, uOpacity * (0.12 + 0.7 * rim));
                #include <colorspace_fragment>
            }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide
    });
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
