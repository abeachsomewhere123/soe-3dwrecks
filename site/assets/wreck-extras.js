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
            onInside: () => (state?.inside ? stepOutside() : stepInside()),
            hasGhost: !!state.ghost,
            hasInside: !!state.ghost?.inside
        });
    });

    function clear() {
        if (state) {
            state.root.removeFromParent();
            setWreckDim(state, 0);
            for (const m of state.wreckMeshes) m.visible = true;
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

        const ghost = data.ghost ? makeGhost(data.ghost) : null;
        if (ghost) root.add(ghost.group);

        // Markers are in the model's coordinates, or (ship) in the
        // reconstruction's frame, for features of the reconstruction.
        const markers = (data.pois || []).filter((poi) => poi.position || (poi.ship && ghost)).map((poi, i) => {
            const sprite = makeMarker(i + 1);
            if (poi.position) sprite.position.fromArray(poi.position);
            else sprite.position.copy(ghost.toModel(poi.ship));
            sprite.userData.poi = { ...poi, number: i + 1, built: poi.built || data.built };
            root.add(sprite);
            return sprite;
        });

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
        const wreckMeshes = [];
        model.traverse((o) => { if (o.isMesh && !isInside(o, root)) wreckMeshes.push(o); });

        return { model, root, markers, ghost, materials, wreckMeshes, seabed, data, dwell: null, dwellTime: 0, openPoi: null, openAt: new THREE.Vector3(), inside: false, savedView: null };
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
        if (poi.action === 'inside') {
            if (window.matchMedia('(max-width: 640px)').matches) ui.collapse();
            stepInside();
            return;
        }
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

    // ── Stepping into the wheelhouse ───────────────────────────────────
    //
    // Brings the reconstruction fully in and puts you on the bridge,
    // standing aft on the port side. While you are inside, the scanned
    // wreck (which passes through the reconstruction) and the markers are
    // hidden. Leave by the button, or just fly or zoom out.

    function insidePose() {
        const g = state?.ghost;
        if (!g?.inside) return null;
        state.model.updateMatrixWorld(true);
        const toWorld = (p) => g.toModel(p).applyMatrix4(state.model.matrixWorld);
        return {
            eye: toWorld(g.inside.eye), look: toWorld(g.inside.look),
            doorEye: toWorld(g.inside.door.eye), doorLook: toWorld(g.inside.door.look)
        };
    }

    function stepInside() {
        const pose = insidePose();
        if (!pose) return;
        blendTarget = blend = 1;
        ui.setBlend(1);
        if (renderer.xr.isPresenting) {
            const camera = below.cameraManager.camera, rig = camera.parent;
            if (!rig) return;
            const dir = pose.look.clone().sub(pose.eye);
            const yaw = Math.atan2(-dir.x, -dir.z);
            rig.rotation.set(0, yaw, 0);
            const head = camera.position.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
            rig.position.copy(pose.eye).sub(head);
            return;
        }
        const camera = below.cameraManager.camera;
        const controls = below.cameraManager.getControls?.();
        if (!controls?.target) return;
        if (!state.inside) state.savedView = { cam: camera.position.clone(), target: controls.target.clone() };
        tween = {
            t: 0, fromTarget: controls.target.clone(), toTarget: pose.look, fromCam: camera.position.clone(), toCam: pose.eye,
            viaCam: state.inside ? null : pose.doorEye, viaTarget: pose.doorLook
        };
    }

    function stepOutside() {
        const camera = below.cameraManager.camera;
        const controls = below.cameraManager.getControls?.();
        if (!controls?.target || renderer.xr.isPresenting) return;
        const back = state.savedView || { cam: camera.position.clone().add(new THREE.Vector3(12, 10, 12)), target: controls.target.clone() };
        tween = { t: 0, fromTarget: controls.target.clone(), toTarget: back.target, fromCam: camera.position.clone(), toCam: back.cam };
        state.savedView = null;
    }

    const shipEye = new THREE.Vector3();
    function updateInside() {
        const b = state.ghost?.inside?.bounds;
        let inside = false;
        if (b && blend > 0.5) {
            shipEye.copy(eye).applyMatrix4(state.model.matrixWorld.clone().invert());
            const p = state.ghost.fromModel(shipEye);
            inside = p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1 && Math.abs(p.z) < b.z;
        }
        if (inside === state.inside) return;
        state.inside = inside;
        for (const m of state.wreckMeshes) m.visible = !inside;
        for (const m of state.markers) m.visible = !inside;
        ui.setInside(inside);
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
        updateInside();

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
            tween.t = Math.min(1, tween.t + dt / (tween.viaCam ? 2.6 : 1.2));
            const ease = (t) => t * t * (3 - 2 * t);
            const cam = below.cameraManager.camera.position;
            if (tween.viaCam) {
                // Up to the doorway, then in.
                const first = tween.t < 0.5, k = ease(first ? tween.t * 2 : tween.t * 2 - 1);
                controls.target.lerpVectors(first ? tween.fromTarget : tween.viaTarget, first ? tween.viaTarget : tween.toTarget, k);
                cam.lerpVectors(first ? tween.fromCam : tween.viaCam, first ? tween.viaCam : tween.toCam, k);
            } else {
                const k = ease(tween.t);
                controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
                cam.lerpVectors(tween.fromCam, tween.toCam, k);
            }
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
                } else if (poi.action === 'inside') {
                    stepInside();
                    const pose = insidePose();
                    if (pose) {
                        vrCard.show(poi, pose.eye, pose.look.clone().sub(pose.eye).normalize());
                        state.openPoi = poi.id;
                        state.openAt.copy(pose.eye);
                    }
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
        stepInside: () => stepInside(),
        stepOutside: () => stepOutside(),
        insidePose: () => insidePose(),
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
    let inside = null;
    if (g.wheelhouse) {
        const w = g.wheelhouse, hw = w.width / 2, floor = casingTop, t = 0.06;
        const H = w.height;
        roof = floor + H;
        const sill = floor + 1.05, head = floor + 1.78;
        // A wall pierced by a row of windows. Runs along x (sides) or z (front).
        const windowWall = (fixed, from, to, panes, isFront) => {
            const len = to - from, mull = 0.09, pane = (len - mull * (panes + 1)) / panes;
            const piece = (a0, a1, y0, y1) => {
                const geo = isFront
                    ? new THREE.BoxGeometry(t, y1 - y0, a1 - a0).translate(fixed, (y0 + y1) / 2, (a0 + a1) / 2)
                    : new THREE.BoxGeometry(a1 - a0, y1 - y0, t).translate((a0 + a1) / 2, (y0 + y1) / 2, fixed);
                addMesh(geo, mats.timber);
            };
            piece(from, to, floor, sill);
            piece(from, to, head, roof);
            for (let k = 0; k <= panes; k++) {
                const a0 = from + k * (pane + mull);
                piece(a0, a0 + mull, sill, head);
                if (k < panes) {
                    const glass = new THREE.PlaneGeometry(pane, head - sill);
                    if (isFront) glass.rotateY(Math.PI / 2).translate(fixed, (sill + head) / 2, a0 + mull + pane / 2);
                    else glass.translate(a0 + mull + pane / 2, (sill + head) / 2, fixed);
                    addMesh(glass, mats.glass, 'given');
                }
            }
        };
        windowWall(w.to - t / 2, -hw, hw, Math.max(3, Math.round(w.width / 0.65)), true);
        for (const side of [-1, 1]) windowWall(side * (hw - t / 2), w.from, w.to, Math.max(2, Math.round((w.to - w.from) / 0.8)), false);
        // After wall with a doorway; the door stands open.
        const door = 0.38, doorTop = floor + 1.95, ax = w.from + t / 2;
        addMesh(new THREE.BoxGeometry(t, H, hw - door).translate(ax, floor + H / 2, -(hw + door) / 2), mats.timber);
        addMesh(new THREE.BoxGeometry(t, H, hw - door).translate(ax, floor + H / 2, (hw + door) / 2), mats.timber);
        addMesh(new THREE.BoxGeometry(t, roof - doorTop, door * 2).translate(ax, (doorTop + roof) / 2, 0), mats.timber);
        // Hinged on the starboard side of the doorway, swung open aft.
        addMesh(new THREE.BoxGeometry(0.04, 1.93, door * 2 - 0.04).translate(0, 0, -(door - 0.02))
            .rotateY(1.4).translate(w.from - 0.03, floor + 0.98, door), mats.timber);
        // Floor, roof and ceiling.
        addMesh(new THREE.BoxGeometry(w.to - w.from - 2 * t, 0.05, w.width - 2 * t).translate((w.from + w.to) / 2, floor + 0.025, 0), mats.deck);
        box(w.from - 0.12, w.to + 0.12, roof, 0.1, w.width + 0.24, mats.paint);
        // Open bridge rail on the roof.
        const r = roof + 0.1 + 0.95, corners = [[w.from, r, -hw], [w.to, r, -hw], [w.to, r, hw], [w.from, r, hw]];
        for (let k = 0; k < 4; k++) bar(corners[k], corners[(k + 1) % 4], 0.025, mats.paint, 6);
        for (const [x, , z] of corners) bar([x, roof + 0.1, z], [x, r, z], 0.025, mats.paint, 6);

        inside = buildBridge({ w, hw, floor, roof, addMesh, bar, mats });
        inside.bounds = { x0: w.from - 0.2, x1: w.to + 0.2, y0: floor - 0.3, y1: roof + 0.3, z: hw + 0.2 };
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

    // ── Towing gear ─────────────────────────────────────────────────
    // As on British-built steam tugs of the period: the towing hook sits
    // amidships, just abaft the funnel on the after end of the deckhouse, so
    // the tug pivots about her middle under tow and a sideways pull is less
    // likely to drag her over. Aft of it the deck is kept clear for the tow
    // rope to sweep from side to side: only the low engine room casing and
    // skylight, under arched towing bows that carry the rope clear of them
    // and of the steering gear.
    if (g.afterCasing) {
        const c = g.afterCasing;
        const base = deck((c.from + c.to) / 2);
        box(c.from, c.to, base - 0.3, c.height + 0.3, c.width, mats.paint);
        if (c.skylight) {
            const k = c.skylight, top = base + c.height;
            box(k.from, k.to, top, 0.42, k.width ?? 1.8, mats.timber);
            // Glazed lights pitched like a roof.
            for (const side of [-1, 1]) {
                const pane = new THREE.PlaneGeometry(k.to - k.from - 0.1, (k.width ?? 1.8) / 2 + 0.05);
                pane.rotateX(-Math.PI / 2 + side * 0.32).translate((k.from + k.to) / 2, top + 0.42 + 0.12, side * (k.width ?? 1.8) / 4);
                addMesh(pane, mats.glass, 'given');
            }
        }
    }
    const hook = g.towingHook;
    if (hook) {
        const y = deck(hook.at) + hook.height, x = hook.at;
        // Towing beam across the after end of the deckhouse, with a plate.
        addMesh(new THREE.BoxGeometry(0.3, 0.32, (g.casing?.width ?? 4) - 0.3).translate(x + 0.1, y, 0), mats.blackSteel);
        addMesh(new THREE.BoxGeometry(0.22, 0.5, 0.36).translate(x - 0.05, y, 0), mats.blackSteel);
        // Spring buffer and shank, then the slip hook, pointing aft.
        addMesh(new THREE.CylinderGeometry(0.11, 0.11, 0.45, 16).rotateZ(Math.PI / 2).translate(x - 0.38, y, 0), mats.blackSteel);
        for (let k = 0; k < 6; k++) {
            addMesh(new THREE.TorusGeometry(0.115, 0.018, 6, 16).rotateY(Math.PI / 2).translate(x - 0.2 - k * 0.07, y, 0), mats.iron);
        }
        bar([x - 0.6, y, 0], [x - 1.05, y, 0], 0.045, mats.blackSteel, 10);
        const curve = new THREE.TorusGeometry(0.16, 0.05, 10, 20, Math.PI * 1.35);
        curve.rotateZ(Math.PI * 0.85).translate(x - 1.2, y - 0.02, 0);
        addMesh(curve, mats.blackSteel);
        addMesh(new THREE.SphereGeometry(0.06, 10, 8).translate(x - 1.05, y, 0), mats.blackSteel);   // release toggle
    }
    // Towing bows: arched beams from bulwark to bulwark over the after deck.
    for (const x of g.towingArches || []) {
        const hw = breadth(x) - 0.1, rail = deck(x) + bulwark, top = deck(x) + (g.towingArchHeight ?? 1.9);
        const pts = [];
        for (let k = 0; k <= 20; k++) {
            const a = Math.PI * (k / 20);
            pts.push([x, rail + (top - rail) * Math.sin(a), -hw * Math.cos(a)]);
        }
        tube(pts, 0.085, mats.blackSteel, 40);
        for (const side of [-1, 1]) bar([x, deck(x), side * hw], [x, rail + 0.05, side * hw], 0.07, mats.blackSteel, 10);
    }
    // Bitts: pairs of bollards for mooring and making fast.
    const bollards = (x, z) => {
        for (const dx of [-0.32, 0.32]) {
            addMesh(new THREE.CylinderGeometry(0.15, 0.17, 0.75, 16).translate(x + dx, deck(x) + 0.375, z), mats.blackSteel);
            addMesh(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 16).translate(x + dx, deck(x) + 0.77, z), mats.blackSteel);
        }
        addMesh(new THREE.BoxGeometry(1.0, 0.08, 0.42).translate(x, deck(x) + 0.04, z), mats.blackSteel);
    };
    for (const b of g.bitts || []) bollards(b, 0);
    for (const q of g.quarterBitts || []) for (const side of [-1, 1]) bollards(q, side * (breadth(q) - 0.7));

    // Steering quadrant on the rudder head, on deck at the stern, worked by
    // rods and chains led forward along the sides from the wheelhouse.
    if (g.steering?.quadrant) {
        const qx = sternpost, qy = deck(qx) + 0.3, qr = g.steering.radius ?? 1.0, span = 0.75;
        addMesh(new THREE.CylinderGeometry(0.12, 0.12, 0.55, 14).translate(qx, deck(qx) + 0.25, 0), mats.iron);   // rudder head
        const sector = new THREE.CircleGeometry(qr, 20, Math.PI - span, span * 2);
        sector.rotateX(-Math.PI / 2).translate(qx, qy, 0);
        addMesh(sector, mats.iron);
        const rim = new THREE.TorusGeometry(qr, 0.045, 8, 20, span * 2);
        rim.rotateZ(Math.PI - span).rotateX(-Math.PI / 2).translate(qx, qy, 0);
        addMesh(rim, mats.iron);
        const toX = g.afterCasing?.to ?? g.casing?.from ?? qx + 10;
        for (const side of [-1, 1]) {
            const end = [qx - Math.cos(span) * qr, qy, side * Math.sin(span) * qr];
            const lead = [qx + 1.2, deck(qx + 1.2) + 0.2, side * (breadth(qx + 1.2) - 0.35)];
            bar(end, lead, 0.022, mats.wire, 6);
            bar(lead, [toX, deck(toX) + 0.2, side * (breadth(toX) - 0.35)], 0.022, mats.wire, 6);
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
    // Ship frame (metres, before the twist) to the model's coordinates.
    const toModel = (p) => new THREE.Vector3().fromArray(warp([...p])).applyMatrix4(ship.matrix);
    const fromModel = (v) => v.clone().applyMatrix4(ship.matrix.clone().invert());
    return {
        group,
        toModel,
        fromModel,
        inside,
        frame: { forward, up: shipUp, starboard },
        setOpacity(o) {
            // Blend while fading; fully opaque (and correctly depth sorted)
            // once it is all the way in.
            const opaque = o >= 0.999;
            for (const m of materials) {
                if (m === mats.glass) { m.opacity = 0.18 * o; continue; }   // glass stays see-through
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
        glass: standard({ color: '#a9c8d2', roughness: 0.04, metalness: 0.1, depthWrite: false }),
        boat: standard({ color: '#eeebe2', roughness: 0.5, metalness: 0 }),
        name: standard({ map: drawName('EURO'), alphaTest: 0.3, roughness: 0.6, metalness: 0 }),
        darkTimber: standard({ map: texture(timber, 1 / 2, 1 / 2), color: '#7a5a44', roughness: 0.4, metalness: 0 }),
        iron: standard({ color: '#2c3a30', roughness: 0.5, metalness: 0.35 }),
        red: standard({ color: '#8e1d18', roughness: 0.45, metalness: 0.2 }),
        green: standard({ color: '#1f5a2a', roughness: 0.45, metalness: 0.2 }),
        telegraph: standard({ map: dialTexture('telegraph'), roughness: 0.4, metalness: 0 }),
        compass: standard({ map: dialTexture('compass'), roughness: 0.4, metalness: 0 }),
        clock: standard({ map: dialTexture('clock'), roughness: 0.4, metalness: 0 }),
        chart: standard({ map: dialTexture('chart'), roughness: 0.8, metalness: 0 }),
        lampGlass: standard({ color: '#fff1c4', emissive: '#ffcf70', emissiveIntensity: 0.9, roughness: 0.2, metalness: 0 }),
        skin: standard({ color: '#c4927a', roughness: 0.65, metalness: 0 }),
        wool: standard({ color: '#1d2333', roughness: 0.92, metalness: 0 }),
        beard: standard({ color: '#9c958c', roughness: 0.95, metalness: 0 }),
        leather: standard({ color: '#121212', roughness: 0.35, metalness: 0.1 }),
        shirt: standard({ color: '#f1efe8', roughness: 0.7, metalness: 0 }),
        eye: standard({ color: '#1a1410', roughness: 0.2, metalness: 0 })
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

// ── The bridge: helm, compass, telegraph, voice pipe and the master ──────
//
// Fittings of a steam tug's wheelhouse of the 1890s, placed in the ship's
// frame (x forward, y up, z to starboard). Indicative, not from the Euro's
// plans. Returns where a visitor stands and looks.
function buildBridge({ w, hw, floor, roof, addMesh, bar, mats }) {
    const at = (geo, x, y, z) => geo.translate(x, y, z);
    const xw = w.to - 1.0;              // plane of the wheel
    const yw = floor + 1.05;            // wheel centre height
    const R = 0.55;                     // wheel radius to the rim

    // Steering column (cast iron) with its gear box, just ahead of the wheel.
    addMesh(at(new THREE.CylinderGeometry(0.09, 0.13, yw - floor - 0.1, 16), xw + 0.18, floor + (yw - floor - 0.1) / 2, 0), mats.iron);
    addMesh(at(new THREE.BoxGeometry(0.28, 0.3, 0.26), xw + 0.18, yw, 0), mats.iron);
    addMesh(at(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 10).rotateZ(Math.PI / 2), xw + 0.06, yw, 0), mats.brass);

    // Spoked wooden wheel with turned handles and a brass hub.
    addMesh(at(new THREE.TorusGeometry(R, 0.035, 10, 48).rotateY(Math.PI / 2), xw, yw, 0), mats.darkTimber);
    addMesh(at(new THREE.TorusGeometry(R * 0.55, 0.018, 8, 32).rotateY(Math.PI / 2), xw, yw, 0), mats.brass);
    addMesh(at(new THREE.CylinderGeometry(0.09, 0.09, 0.12, 16).rotateZ(Math.PI / 2), xw, yw, 0), mats.brass);
    for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const dy = Math.cos(a), dz = Math.sin(a);
        bar([xw, yw + dy * 0.08, dz * 0.08], [xw, yw + dy * (R + 0.04), dz * (R + 0.04)], 0.018, mats.darkTimber, 6);
        const handle = new THREE.CapsuleGeometry(0.026, 0.1, 4, 8);
        handle.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, dy, dz)));
        addMesh(at(handle, xw, yw + dy * (R + 0.12), dz * (R + 0.12)), mats.darkTimber);
    }

    // Binnacle: timber pedestal, brass bowl with the compass card under
    // glass, a hood over the forward half, quadrantal spheres either side
    // and a Flinders bar ahead.
    const xb = w.to - 0.42, yb = floor + 1.02;
    addMesh(at(new THREE.CylinderGeometry(0.15, 0.2, yb - floor, 20), xb, floor + (yb - floor) / 2, 0), mats.darkTimber);
    addMesh(at(new THREE.CylinderGeometry(0.2, 0.17, 0.12, 24), xb, yb + 0.06, 0), mats.brass);
    addMesh(at(new THREE.CircleGeometry(0.17, 32).rotateX(-Math.PI / 2).rotateY(-Math.PI / 2), xb, yb + 0.125, 0), mats.compass, 'given');
    addMesh(at(new THREE.SphereGeometry(0.2, 24, 12, Math.PI / 2, Math.PI, 0, Math.PI / 2), xb, yb + 0.12, 0), mats.brass);
    addMesh(at(new THREE.CylinderGeometry(0.035, 0.035, 0.14, 10), xb + 0.05, yb + 0.38, 0), mats.brass);   // lamp chimney
    for (const side of [-1, 1]) {
        bar([xb, yb + 0.02, side * 0.18], [xb, yb + 0.02, side * 0.32], 0.015, mats.brass, 6);
        addMesh(at(new THREE.SphereGeometry(0.075, 16, 12), xb, yb + 0.02, side * 0.36), side > 0 ? mats.green : mats.red);
    }
    addMesh(at(new THREE.CylinderGeometry(0.04, 0.04, 0.45, 12), xb + 0.22, yb - 0.3, 0), mats.iron);

    // Engine room telegraph on the starboard side.
    const xt = w.to - 0.55, zt = Math.min(0.95, hw - 0.35), yt = floor + 1.12;
    addMesh(at(new THREE.CylinderGeometry(0.05, 0.08, yt - floor, 14), xt, floor + (yt - floor) / 2, zt), mats.brass);
    addMesh(at(new THREE.CylinderGeometry(0.21, 0.21, 0.13, 32).rotateZ(Math.PI / 2), xt, yt + 0.12, zt), mats.brass);
    addMesh(at(new THREE.CircleGeometry(0.18, 32).rotateY(-Math.PI / 2), xt - 0.067, yt + 0.12, zt), mats.telegraph, 'given');
    bar([xt - 0.09, yt + 0.12, zt], [xt - 0.09, yt + 0.3, zt + 0.08], 0.014, mats.brass, 6);
    addMesh(at(new THREE.SphereGeometry(0.03, 10, 8), xt - 0.09, yt + 0.31, zt + 0.085), mats.brass);

    // Voice pipe to the engine room, port side, with a whistle mouthpiece.
    const xv = w.to - 0.5, zv = -Math.min(0.95, hw - 0.35);
    const pipe = new THREE.CatmullRomCurve3([
        new THREE.Vector3(xv, floor, zv), new THREE.Vector3(xv, floor + 1.22, zv),
        new THREE.Vector3(xv - 0.05, floor + 1.36, zv), new THREE.Vector3(xv - 0.18, floor + 1.41, zv)
    ]);
    addMesh(new THREE.TubeGeometry(pipe, 24, 0.035, 10, false), mats.brass);
    addMesh(at(new THREE.CylinderGeometry(0.045, 0.075, 0.12, 16, 1, true).rotateZ(Math.PI / 2), xv - 0.24, floor + 1.41, zv), mats.brass);

    // Chart table in the after port corner, with a chart on it.
    const cx0 = w.from + 0.1, cx1 = w.from + 1.0, cz0 = -hw + 0.08, cz1 = -hw + 0.68;
    addMesh(new THREE.BoxGeometry(cx1 - cx0, 0.9, cz1 - cz0).translate((cx0 + cx1) / 2, floor + 0.45, (cz0 + cz1) / 2), mats.darkTimber);
    addMesh(new THREE.BoxGeometry(cx1 - cx0 + 0.06, 0.04, cz1 - cz0 + 0.06).translate((cx0 + cx1) / 2, floor + 0.92, (cz0 + cz1) / 2), mats.darkTimber);
    addMesh(at(new THREE.PlaneGeometry(0.75, 0.5).rotateX(-Math.PI / 2).rotateY(0.08), (cx0 + cx1) / 2, floor + 0.945, (cz0 + cz1) / 2), mats.chart, 'given');

    // Clock and barometer on the after bulkhead.
    for (const [z, mat] of [[0.75, mats.clock], [1.15, mats.compass]]) {
        if (z > hw - 0.15) continue;
        const x = w.from + 0.065, y = floor + 1.72;
        addMesh(at(new THREE.TorusGeometry(0.12, 0.02, 8, 24).rotateY(Math.PI / 2), x, y, z), mats.brass);
        addMesh(at(new THREE.CircleGeometry(0.115, 24).rotateY(Math.PI / 2), x + 0.004, y, z), mat, 'given');
    }

    // Oil lamp hanging from the deckhead.
    const xl = (w.from + w.to) / 2 - 0.3;
    bar([xl, roof, 0], [xl, roof - 0.32, 0], 0.008, mats.brass, 4);
    addMesh(at(new THREE.CylinderGeometry(0.1, 0.07, 0.06, 16), xl, roof - 0.35, 0), mats.brass);
    addMesh(at(new THREE.CylinderGeometry(0.065, 0.065, 0.16, 16), xl, roof - 0.46, 0), mats.lampGlass);
    addMesh(at(new THREE.CylinderGeometry(0.075, 0.09, 0.05, 16), xl, roof - 0.565, 0), mats.brass);

    // Ship's bell outside, on the front of the wheelhouse.
    const bell = new THREE.LatheGeometry([
        new THREE.Vector2(0.0, 0.2), new THREE.Vector2(0.06, 0.2), new THREE.Vector2(0.08, 0.15),
        new THREE.Vector2(0.09, 0.06), new THREE.Vector2(0.12, 0.0), new THREE.Vector2(0.11, 0.0)
    ], 24);
    addMesh(at(bell, w.to + 0.16, floor + 1.88, hw - 0.45), mats.brass);
    bar([w.to + 0.03, floor + 2.1, hw - 0.45], [w.to + 0.16, floor + 2.1, hw - 0.45], 0.015, mats.brass, 6);

    // The master at the wheel.
    buildMaster({ x: xw - 0.47, floor, xw, yw, R, addMesh, mats });

    return {
        // Stand aft on the port side, looking past the master to the wheel
        // and through the windows. Come in through the doorway.
        eye: [w.from + 0.5, floor + 1.62, -Math.min(0.8, hw - 0.4)],
        look: [xw + 0.3, yw + 0.2, 0.15],
        door: { eye: [w.from - 1.8, floor + 1.62, 0], look: [w.from + 1.2, floor + 1.4, 0] }
    };
}

// A master in a double breasted reefer and peaked cap, both hands on the
// wheel. Built from simple shapes in the ship's frame, facing forward.
function buildMaster({ x, floor, xw, yw, R, addMesh, mats }) {
    const V = (a, b, c) => new THREE.Vector3(a, b, c);
    const limb = (a, b, r, mat) => {
        const d = b.clone().sub(a);
        const geo = new THREE.CapsuleGeometry(r, Math.max(0.01, d.length() - r), 6, 12);
        geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize()));
        const m = a.clone().add(b).multiplyScalar(0.5);
        addMesh(geo.translate(m.x, m.y, m.z), mat);
    };
    const f = floor;
    // Boots and legs.
    for (const s of [-1, 1]) {
        addMesh(new THREE.BoxGeometry(0.28, 0.09, 0.11).translate(x + 0.05, f + 0.045, s * 0.11), mats.leather);
        limb(V(x, f + 0.1, s * 0.11), V(x, f + 0.9, s * 0.1), 0.075, mats.wool);
    }
    // Reefer jacket: a lathed body, broad across the shoulders.
    const body = new THREE.LatheGeometry([
        V(0.0, 0.78), V(0.17, 0.78), V(0.175, 0.95), V(0.16, 1.08), V(0.18, 1.28), V(0.2, 1.42),
        V(0.12, 1.5), V(0.06, 1.53), V(0.0, 1.53)
    ].map((v) => new THREE.Vector2(v.x, v.y)), 28);
    body.scale(0.72, 1, 1.12);
    addMesh(body.translate(x, f, 0), mats.wool);
    // Two rows of brass buttons.
    for (const s of [-1, 1]) for (let k = 0; k < 4; k++) {
        const y = f + 1.02 + k * 0.09;
        addMesh(new THREE.SphereGeometry(0.012, 8, 6).translate(x + 0.135, y, s * 0.06), mats.brass);
    }
    // Shirt collar and tie.
    addMesh(new THREE.CylinderGeometry(0.06, 0.065, 0.05, 16).translate(x, f + 1.52, 0), mats.shirt);
    addMesh(new THREE.BoxGeometry(0.02, 0.1, 0.035).translate(x + 0.055, f + 1.47, 0), mats.leather);
    // Arms reaching to the rim at about ten to two, elbows down and out.
    const Lu = 0.3, Lf = 0.29;
    for (const s of [-1, 1]) {
        const th = THREE.MathUtils.degToRad(52);
        const hand = V(xw - 0.05, yw + Math.cos(th) * R, s * Math.sin(th) * R);
        const shoulder = V(x, f + 1.42, s * 0.22);
        const d = hand.clone().sub(shoulder), D = Math.min(d.length(), Lu + Lf - 0.01);
        const dn = d.clone().normalize();
        const a = (Lu * Lu - Lf * Lf + D * D) / (2 * D);
        const hgt = Math.sqrt(Math.max(0, Lu * Lu - a * a));
        const pole = V(-0.2, -1, s * 0.6);
        const perp = pole.sub(dn.clone().multiplyScalar(pole.dot(dn))).normalize();
        const elbow = shoulder.clone().addScaledVector(dn, a).addScaledVector(perp, hgt);
        const wrist = elbow.clone().addScaledVector(hand.clone().sub(elbow).normalize(), Lf - 0.03);
        limb(shoulder, elbow, 0.058, mats.wool);
        limb(elbow, wrist, 0.05, mats.wool);
        addMesh(new THREE.TorusGeometry(0.05, 0.008, 6, 16).lookAt(hand.clone().sub(elbow)).translate(wrist.x, wrist.y, wrist.z), mats.brass); // cuff braid
        addMesh(new THREE.SphereGeometry(0.045, 12, 10).scale(1.2, 0.8, 1).translate(hand.x - 0.01, hand.y, hand.z), mats.skin);
        addMesh(new THREE.SphereGeometry(0.075, 16, 12).scale(1, 0.75, 1).translate(shoulder.x, shoulder.y + 0.02, shoulder.z), mats.wool);
    }
    // Neck and head.
    addMesh(new THREE.CylinderGeometry(0.05, 0.055, 0.08, 14).translate(x, f + 1.57, 0), mats.skin);
    const hy = f + 1.67;
    addMesh(new THREE.SphereGeometry(0.1, 28, 20).scale(1.0, 1.18, 0.9).translate(x, hy, 0), mats.skin);
    for (const s of [-1, 1]) {
        addMesh(new THREE.SphereGeometry(0.025, 10, 8).scale(0.6, 1.2, 1).translate(x - 0.005, hy, s * 0.092), mats.skin);   // ears
        addMesh(new THREE.SphereGeometry(0.011, 8, 6).translate(x + 0.088, hy + 0.025, s * 0.035), mats.eye);            // eyes
        addMesh(new THREE.BoxGeometry(0.01, 0.008, 0.035).translate(x + 0.093, hy + 0.045, s * 0.036), mats.beard);       // brows
    }
    addMesh(new THREE.ConeGeometry(0.018, 0.045, 10).rotateZ(-Math.PI / 2).translate(x + 0.112, hy, 0), mats.skin);   // nose
    // Full grey beard and moustache.
    // Beard along the jaw and chin, leaving the mouth; a moustache above.
    addMesh(new THREE.SphereGeometry(0.1, 24, 16, Math.PI * 0.55, Math.PI * 0.9, Math.PI * 0.62, Math.PI * 0.38)
        .scale(1.0, 1.45, 0.98).translate(x + 0.004, hy + 0.01, 0), mats.beard);
    addMesh(new THREE.SphereGeometry(0.06, 16, 10).scale(0.75, 0.9, 1.1).translate(x + 0.05, hy - 0.115, 0), mats.beard);
    addMesh(new THREE.CapsuleGeometry(0.011, 0.055, 4, 8).rotateX(Math.PI / 2).translate(x + 0.1, hy - 0.03, 0), mats.beard);
    addMesh(new THREE.BoxGeometry(0.008, 0.008, 0.035).translate(x + 0.098, hy - 0.052, 0), mats.red);   // lips
    // Peaked cap: band, crown, peak and badge.
    addMesh(new THREE.CylinderGeometry(0.104, 0.102, 0.05, 28).translate(x, hy + 0.11, 0), mats.leather);
    addMesh(new THREE.CylinderGeometry(0.125, 0.106, 0.05, 28).scale(1.05, 1, 1).translate(x - 0.005, hy + 0.155, 0), mats.wool);
    addMesh(new THREE.CircleGeometry(0.1, 20, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2).rotateZ(-0.35)
        .scale(0.8, 1, 1).translate(x + 0.07, hy + 0.09, 0), mats.leather);
    addMesh(new THREE.BoxGeometry(0.01, 0.025, 0.04).translate(x + 0.104, hy + 0.115, 0), mats.brass);
}

// Faces for the telegraph, compass card, clock and a chart.
function dialTexture(kind) {
    const S = 512, canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const c = canvas.getContext('2d');
    const cx = S / 2;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    if (kind === 'chart') {
        c.fillStyle = '#e9e1c9'; c.fillRect(0, 0, S, S);
        c.strokeStyle = 'rgba(70,90,120,0.6)'; c.lineWidth = 2;
        const random = seededRandom(61);
        for (let k = 0; k < 7; k++) {
            c.beginPath();
            let y = 60 + k * 55;
            c.moveTo(0, y);
            for (let x = 0; x <= S; x += 32) c.lineTo(x, y + Math.sin(x * 0.02 + k) * 18 + (random() - 0.5) * 8);
            c.stroke();
        }
        c.fillStyle = '#c9b98d';
        c.beginPath(); c.moveTo(0, 0); c.lineTo(S * 0.45, 0); c.bezierCurveTo(S * 0.4, S * 0.2, S * 0.2, S * 0.25, 0, S * 0.3); c.fill();
        c.strokeStyle = 'rgba(40,40,40,0.7)'; c.lineWidth = 1;
        for (let k = 0; k < 40; k++) { c.fillStyle = 'rgba(40,40,40,0.55)'; c.font = '14px serif'; c.fillText(String(Math.floor(random() * 30) + 2), 80 + random() * 400, 140 + random() * 340); }
        c.font = 'italic 28px Georgia, serif'; c.fillStyle = 'rgba(40,40,40,0.75)'; c.fillText('Port Phillip Heads', S * 0.6, S * 0.85);
    } else {
        c.fillStyle = kind === 'telegraph' ? '#f3eedf' : '#f5f1e4';
        c.beginPath(); c.arc(cx, cx, cx, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#222'; c.lineWidth = 6; c.beginPath(); c.arc(cx, cx, cx - 8, 0, Math.PI * 2); c.stroke();
        if (kind === 'compass') {
            for (let k = 0; k < 32; k++) {
                const a = (k / 32) * Math.PI * 2;
                c.fillStyle = k % 8 === 0 ? '#111' : k % 4 === 0 ? '#333' : '#777';
                c.beginPath();
                const len = k % 8 === 0 ? 0.85 : k % 4 === 0 ? 0.62 : 0.4;
                c.moveTo(cx + Math.sin(a) * cx * len, cx - Math.cos(a) * cx * len);
                c.lineTo(cx + Math.sin(a + 0.08) * 30, cx - Math.cos(a + 0.08) * 30);
                c.lineTo(cx + Math.sin(a - 0.08) * 30, cx - Math.cos(a - 0.08) * 30);
                c.fill();
            }
            c.fillStyle = '#8e1d18'; c.font = 'bold 54px Georgia, serif';
            c.fillText('N', cx, 52);
            c.fillStyle = '#111'; c.font = 'bold 40px Georgia, serif';
            c.fillText('S', cx, S - 46); c.fillText('E', S - 44, cx); c.fillText('W', 46, cx);
        } else if (kind === 'clock') {
            c.fillStyle = '#111'; c.font = '44px Georgia, serif';
            const roman = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
            roman.forEach((t, k) => { const a = (k / 12) * Math.PI * 2; c.fillText(t, cx + Math.sin(a) * 190, cx - Math.cos(a) * 190); });
            c.lineWidth = 10; c.lineCap = 'round';
            c.beginPath(); c.moveTo(cx, cx); c.lineTo(cx + 90, cx - 60); c.stroke();
            c.lineWidth = 6; c.beginPath(); c.moveTo(cx, cx); c.lineTo(cx - 30, cx - 150); c.stroke();
        } else {
            // Engine room telegraph: ahead to one side, astern to the other.
            const labels = ['FULL', 'HALF', 'SLOW', 'STAND BY', 'STOP', 'FINISHED', 'SLOW', 'HALF', 'FULL'];
            labels.forEach((t, k) => {
                const a = -Math.PI * 0.8 + (k / (labels.length - 1)) * Math.PI * 1.6;
                c.save(); c.translate(cx, cx); c.rotate(a);
                c.fillStyle = k < 3 ? '#1f5a2a' : k > 5 ? '#8e1d18' : '#111';
                c.font = 'bold 30px Georgia, serif';
                c.fillText(t, 0, -cx * 0.72);
                c.restore();
                c.strokeStyle = '#333'; c.lineWidth = 3;
                const b = a + Math.PI * 0.1;
                c.beginPath(); c.moveTo(cx + Math.sin(b) * cx * 0.55, cx - Math.cos(b) * cx * 0.55); c.lineTo(cx + Math.sin(b) * cx * 0.9, cx - Math.cos(b) * cx * 0.9); c.stroke();
            });
            c.font = 'bold 34px Georgia, serif'; c.fillStyle = '#1f5a2a'; c.fillText('AHEAD', cx - 120, cx + 150);
            c.fillStyle = '#8e1d18'; c.fillText('ASTERN', cx + 120, cx + 150);
            c.fillStyle = '#111'; c.font = '28px Georgia, serif'; c.fillText('ENGINE ROOM', cx, cx + 40);
            c.strokeStyle = '#111'; c.lineWidth = 10; c.lineCap = 'round';
            c.beginPath(); c.moveTo(cx, cx); c.lineTo(cx, cx - 170); c.stroke();
        }
    }
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
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
                <button type="button" class="wx-panel__inside" hidden>Step into the wheelhouse</button>
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
    let onInside = () => {};
    const insideButton = panel.querySelector('.wx-panel__inside');
    insideButton.addEventListener('click', () => onInside());
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
            insideButton.hidden = !handlers.hasInside;
            onInside = handlers.onInside;
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
        setInside(inside) { insideButton.textContent = inside ? 'Step back out' : 'Step into the wheelhouse'; },
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
