// AR: put the wreck on a table, using the controllers.
//
// Point either controller at a table and pull the trigger. The wreck sits
// on the tabletop, sized and turned to fit it. Pull the trigger at another
// table (or the same one) to move it. While it is on a table, the thumbstick
// turns it (left/right) and resizes it (up/down), keeping it on the table.
//
// Tables come from the headset's room setup (WebXR plane detection; on a
// Quest that is Space Setup). Without it, the trigger puts the wreck on
// whatever flat surface the controller points at (WebXR hit test).
//
// BelowJS 1.8.0 asks for neither feature and has no controller placement,
// so this adds both from outside. Its hand gestures are turned off on the
// AR page, so hands don't move the wreck by accident.

import * as THREE from 'three';
import { levelModel } from '/assets/level.js';

const FIT = 0.9;               // fill this much of the tabletop
const SURFACE_SIZE = 0.8;      // metres, longest side, for a surface that isn't a known table
const MIN_SCALE = 0.001;
const MAX_SCALE = 0.2;
const TURN_SPEED = 1.6;        // radians a second at full thumbstick
const RESIZE_SPEED = 0.9;      // e-fold a second at full thumbstick
const DEAD_ZONE = 0.2;
const RAY_LENGTH = 6;
const FLOOR_CLEARANCE = 0.25;  // a surface this far above the floor counts as a table

const HIGHLIGHT = 0x5fd4ff;

// BelowJS starts AR asking only for 'local' (and hands). Ask for surfaces
// and room planes too. Both are optional, so a device without them still
// starts AR, just without table placement.
if (navigator.xr?.requestSession && !navigator.xr.requestSession.__withTables) {
    const requestSession = navigator.xr.requestSession.bind(navigator.xr);
    navigator.xr.requestSession = (mode, init = {}) => {
        if (mode === 'immersive-ar') {
            const optional = new Set(init.optionalFeatures || []);
            optional.add('hit-test');
            optional.add('plane-detection');
            init = { ...init, optionalFeatures: [...optional] };
        }
        return requestSession(mode, init);
    };
    navigator.xr.requestSession.__withTables = true;
}

export function addArTablePlacement(viewer) {
    const below = viewer.belowViewer;
    const renderer = below.renderer;
    const scene = below.sceneManager.scene;
    const ar = () => below.arManager;

    const controllers = [0, 1].map((i) => makeController(renderer, scene, i));
    const tables = new Map();      // XRPlane -> { mesh, outline, info }
    const tableGroup = new THREE.Group();
    tableGroup.name = 'ar-tables';
    scene.add(tableGroup);

    const hint = makeHint();
    hint.visible = false;

    const raycaster = new THREE.Raycaster();
    const tempMatrix = new THREE.Matrix4();

    // Where the wreck is: the point on the table under its middle, how it is
    // turned and how big it is. null until it is first put on a surface.
    let placed = null;
    let footprint = null;          // the wreck's extent, unscaled, in its group
    let floorY = null;
    let hitTestSources = new Map(); // XRInputSource -> XRHitTestSource
    let session = null;

    viewer.on('modelLoaded', ({ model }) => {
        if (model) levelModel(model);
        footprint = null;
        // Switching wrecks mid-session: put the new one where the old one was.
        if (placed && ar()?.isARPresenting) {
            setTimeout(() => {
                if (placed.table) placeOnTable(placed.table, placed.yaw);
                else applyPlacement();
            }, 0);
        }
    });

    below.on('ar-session-start', () => {
        session = renderer.xr.getSession();
        placed = null;
        footprint = null;
        floorY = null;
        hint.visible = true;
        setHint(hint, 'Point at a table and pull the trigger');
        session.addEventListener('inputsourceschange', refreshHitTestSources);
        refreshHitTestSources();
    });

    below.on('ar-session-end', () => {
        for (const source of hitTestSources.values()) source.cancel?.();
        hitTestSources.clear();
        for (const plane of [...tables.keys()]) removeTable(plane);
        for (const c of controllers) c.reset();
        hint.visible = false;
        session = null;
    });

    for (const c of controllers) {
        c.target.addEventListener('select', () => {
            if (!ar()?.isARPresenting || !c.hover) return;
            if (c.hover.table) {
                placeOnTable(c.hover.table, null);
            } else {
                placeOnSurface(c.hover.point, c.rayDirection);
            }
            setHint(hint, 'Thumbstick: turn and resize\nTrigger: move to another table');
            clearTimeout(hint.timer);
            hint.timer = setTimeout(() => { hint.visible = false; }, 8000);
        });
    }

    below.on('before-render', (deltaTime) => {
        const frame = renderer.xr.getFrame?.();
        if (!session || !frame || !ar()?.isARPresenting) return;
        const space = renderer.xr.getReferenceSpace();

        updateTables(frame, space);

        let hintController = null;
        for (const c of controllers) {
            if (!c.source || c.source.hand) {
                c.hide();
                continue;
            }
            hintController ??= c.source.handedness === 'right' ? c : null;
            aim(c, frame, space);
            steer(c, deltaTime);
        }
        hintController ??= controllers.find((c) => c.source && !c.source.hand);
        if (hintController && hint.parent !== hintController.target) hintController.target.add(hint);

        for (const { mesh, outline } of tables.values()) {
            const hovered = controllers.some((c) => c.hover?.table?.mesh === mesh);
            mesh.material.opacity = hovered ? 0.22 : (placed ? 0 : 0.06);
            outline.material.opacity = hovered ? 0.95 : (placed ? 0 : 0.35);
        }
    });

    // ── Surfaces ────────────────────────────────────────────────────────

    function refreshHitTestSources() {
        if (!session?.requestHitTestSource) return;
        for (const [source, hitSource] of hitTestSources) {
            if (![...session.inputSources].includes(source)) {
                hitSource.cancel?.();
                hitTestSources.delete(source);
            }
        }
        for (const source of session.inputSources) {
            if (source.hand || hitTestSources.has(source) || !source.targetRaySpace) continue;
            hitTestSources.set(source, null);
            session.requestHitTestSource({ space: source.targetRaySpace })
                .then((hitSource) => {
                    if (hitTestSources.has(source)) hitTestSources.set(source, hitSource);
                    else hitSource.cancel?.();
                })
                .catch(() => hitTestSources.delete(source)); // no 'hit-test' on this device
        }
    }

    function updateTables(frame, space) {
        const planes = frame.detectedPlanes;
        if (!planes) return;

        for (const plane of [...tables.keys()]) {
            if (!planes.has(plane)) removeTable(plane);
        }

        // The floor: labelled as such, or else the lowest upward-facing plane.
        let lowest = Infinity;
        let count = 0;
        const up = new THREE.Vector3();
        const poses = new Map();
        for (const plane of planes) {
            if (plane.orientation !== 'horizontal') continue;
            const pose = frame.getPose(plane.planeSpace, space);
            if (!pose) continue;
            const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
            up.setFromMatrixColumn(matrix, 1);
            if (up.y < 0.9) continue; // a ceiling or the underside of something
            poses.set(plane, matrix);
            count++;
            const y = matrix.elements[13];
            if (plane.semanticLabel === 'floor') floorY = y;
            else if (floorY === null) lowest = Math.min(lowest, y);
        }
        // With no floor labelled, the lowest of several surfaces is the floor.
        const floor = floorY ?? (count >= 2 ? lowest : -Infinity);

        for (const [plane, matrix] of poses) {
            const label = plane.semanticLabel;
            const y = matrix.elements[13];
            const isTable = label === 'table' ||
                (label !== 'floor' && label !== 'ceiling' && y - floor >= FLOOR_CLEARANCE);
            if (!isTable) {
                if (tables.has(plane)) removeTable(plane);
                continue;
            }
            let entry = tables.get(plane);
            if (!entry || entry.changed !== plane.lastChangedTime) {
                if (entry) removeTable(plane);
                entry = makeTable(plane);
                if (!entry) continue;
                tables.set(plane, entry);
                tableGroup.add(entry.mesh, entry.outline);
            }
            entry.mesh.matrix.copy(matrix);
            entry.outline.matrix.copy(matrix);
            entry.matrix.copy(matrix);
        }
        tableGroup.updateMatrixWorld(true);
    }

    function makeTable(plane) {
        const points = (plane.polygon || []).map((p) => new THREE.Vector2(p.x, p.z));
        if (points.length < 3) return null;

        const triangles = THREE.ShapeUtils.triangulateShape(points, []);
        const positions = [];
        for (const tri of triangles) {
            for (const i of tri) positions.push(points[i].x, 0.002, points[i].y);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
            color: HIGHLIGHT, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false
        }));

        const outlineGeometry = new THREE.BufferGeometry().setFromPoints(
            points.map((p) => new THREE.Vector3(p.x, 0.003, p.y))
        );
        const outline = new THREE.LineLoop(outlineGeometry, new THREE.LineBasicMaterial({
            color: HIGHLIGHT, transparent: true, opacity: 0.35, depthWrite: false
        }));

        for (const o of [mesh, outline]) {
            o.matrixAutoUpdate = false;
            o.renderOrder = 5;
        }

        // The tabletop's extent along its own two axes, for fitting the wreck.
        const box = new THREE.Box2().setFromPoints(points);
        const entry = {
            mesh, outline, plane,
            matrix: new THREE.Matrix4(),
            changed: plane.lastChangedTime,
            centre: box.getCenter(new THREE.Vector2()),
            size: box.getSize(new THREE.Vector2())
        };
        mesh.userData.table = entry;
        return entry;
    }

    function removeTable(plane) {
        const entry = tables.get(plane);
        if (!entry) return;
        tableGroup.remove(entry.mesh, entry.outline);
        entry.mesh.geometry.dispose();
        entry.mesh.material.dispose();
        entry.outline.geometry.dispose();
        entry.outline.material.dispose();
        tables.delete(plane);
        if (placed?.table === entry) placed.table = null; // stays put, just no longer refits
    }

    // ── Pointing ────────────────────────────────────────────────────────

    function aim(c, frame, space) {
        c.target.updateMatrixWorld(true);
        tempMatrix.identity().extractRotation(c.target.matrixWorld);
        const origin = new THREE.Vector3().setFromMatrixPosition(c.target.matrixWorld);
        const direction = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();
        c.rayDirection.copy(direction);
        raycaster.set(origin, direction);
        raycaster.far = RAY_LENGTH;

        c.hover = null;
        const meshes = [...tables.values()].map((t) => t.mesh);
        const hit = meshes.length ? raycaster.intersectObjects(meshes, false)[0] : null;
        if (hit) {
            c.hover = { table: hit.object.userData.table, point: hit.point, distance: hit.distance };
        } else {
            const hitSource = hitTestSources.get(c.source);
            const results = hitSource ? frame.getHitTestResults(hitSource) : [];
            for (const result of results) {
                const pose = result.getPose(space);
                if (!pose) continue;
                const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
                const normal = new THREE.Vector3().setFromMatrixColumn(m, 1);
                if (normal.y < 0.85) continue; // walls and slopes: nowhere to stand a wreck
                const point = new THREE.Vector3().setFromMatrixPosition(m);
                // Results trail the controller by a frame or so. Skip one that
                // is off the ray as it is now, or a fast sweep lands it wrong.
                const distance = point.distanceTo(origin);
                if (raycaster.ray.distanceToPoint(point) > 0.03 + 0.03 * distance) continue;
                c.hover = { table: null, point, distance };
                break;
            }
        }

        c.show(c.hover ? c.hover.distance : RAY_LENGTH, c.hover?.point);
    }

    // ── Placing ─────────────────────────────────────────────────────────

    function placeOnTable(table, yaw) {
        const box = measure();
        if (!box) return;
        const axisX = new THREE.Vector3().setFromMatrixColumn(table.matrix, 0);
        const axisZ = new THREE.Vector3().setFromMatrixColumn(table.matrix, 2);
        const tableLong = Math.max(table.size.x, table.size.y);
        const tableShort = Math.min(table.size.x, table.size.y);
        const along = (table.size.x >= table.size.y ? axisX : axisZ).setY(0).normalize();

        const modelLong = Math.max(box.size.x, box.size.z);
        const modelShort = Math.max(Math.min(box.size.x, box.size.z), 1e-3);
        const scale = THREE.MathUtils.clamp(
            Math.min(tableLong * FIT / modelLong, tableShort * FIT / modelShort),
            MIN_SCALE, MAX_SCALE
        );

        if (yaw === null) {
            // Line the wreck's length up with the table's.
            yaw = box.size.x >= box.size.z
                ? Math.atan2(-along.z, along.x)
                : Math.atan2(along.x, along.z);
        }

        const anchor = new THREE.Vector3(table.centre.x, 0, table.centre.y).applyMatrix4(table.matrix);
        placed = { anchor, yaw, scale, table };
        applyPlacement();
    }

    function placeOnSurface(point, rayDirection) {
        const box = measure();
        if (!box) return;
        const scale = THREE.MathUtils.clamp(SURFACE_SIZE / Math.max(box.size.x, box.size.z), MIN_SCALE, MAX_SCALE);
        // Side on to you: the wreck's length across your line of sight.
        const across = new THREE.Vector3(-rayDirection.z, 0, rayDirection.x).normalize();
        const yaw = box.size.x >= box.size.z
            ? Math.atan2(-across.z, across.x)
            : Math.atan2(across.x, across.z);
        placed = { anchor: point.clone(), yaw, scale, table: null };
        applyPlacement();
    }

    // Stand the wreck on placed.anchor: its middle over the point, its lowest
    // part on the surface.
    function applyPlacement() {
        const group = ar()?.modelGroup;
        const box = measure();
        if (!group || !box || !placed) return;
        const { anchor, yaw, scale } = placed;
        const middle = new THREE.Vector3(box.centre.x, 0, box.centre.z)
            .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
            .multiplyScalar(scale);
        group.rotation.set(0, yaw, 0);
        group.scale.setScalar(scale);
        group.position.set(anchor.x - middle.x, anchor.y - box.min.y * scale, anchor.z - middle.z);
        group.updateMatrixWorld(true);
    }

    // The wreck's bounds inside the AR group, before the group is turned,
    // scaled or moved.
    function measure() {
        const group = ar()?.modelGroup;
        const model = ar()?.currentModel;
        if (!group || !model) return null;
        if (footprint?.model === model) return footprint;

        const position = group.position.clone();
        const quaternion = group.quaternion.clone();
        const scale = group.scale.clone();
        group.position.set(0, 0, 0);
        group.quaternion.identity();
        group.scale.setScalar(1);
        group.updateMatrixWorld(true);
        // Precise: the levelled model's bounding boxes, turned, overstate its
        // depth by metres.
        const box = new THREE.Box3().setFromObject(model, true);
        group.position.copy(position);
        group.quaternion.copy(quaternion);
        group.scale.copy(scale);
        group.updateMatrixWorld(true);
        if (box.isEmpty()) return null;

        footprint = {
            model,
            min: box.min.clone(),
            size: box.getSize(new THREE.Vector3()),
            centre: box.getCenter(new THREE.Vector3())
        };
        return footprint;
    }

    // ── Thumbstick ──────────────────────────────────────────────────────

    function steer(c, deltaTime) {
        if (!placed) return;
        const axes = c.source.gamepad?.axes;
        if (!axes || axes.length < 2) return;
        // xr-standard puts the thumbstick on axes 2 and 3; some devices use 0 and 1.
        const x = axes.length >= 4 ? axes[2] : axes[0];
        const y = axes.length >= 4 ? axes[3] : axes[1];
        const dt = Math.min(deltaTime || 0, 0.1);
        let changed = false;
        if (Math.abs(x) > DEAD_ZONE) {
            placed.yaw -= x * TURN_SPEED * dt;
            changed = true;
        }
        if (Math.abs(y) > DEAD_ZONE) {
            // Push forward (negative y) to grow.
            placed.scale = THREE.MathUtils.clamp(placed.scale * Math.exp(-y * RESIZE_SPEED * dt), MIN_SCALE, MAX_SCALE);
            changed = true;
        }
        if (changed) applyPlacement();
    }
}

// A controller's pointing ray and the ring where it meets a surface.
function makeController(renderer, scene, index) {
    const target = renderer.xr.getController(index);
    scene.add(target);

    const rayGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)
    ]);
    const ray = new THREE.Line(rayGeometry, new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.6, depthTest: false
    }));
    ray.renderOrder = 20;
    ray.visible = false;
    target.add(ray);

    const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.025, 0.035, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: HIGHLIGHT, transparent: true, opacity: 0.9, depthTest: false })
    );
    ring.renderOrder = 21;
    ring.visible = false;
    scene.add(ring);

    const c = {
        target,
        source: null,
        hover: null,
        rayDirection: new THREE.Vector3(0, 0, -1),
        show(length, point) {
            ray.visible = true;
            ray.scale.z = length;
            ray.material.color.set(point ? HIGHLIGHT : 0xffffff);
            ring.visible = !!point;
            if (point) ring.position.copy(point).y += 0.004;
        },
        hide() {
            ray.visible = ring.visible = false;
            c.hover = null;
        },
        reset() {
            c.hide();
            c.source = null;
        }
    };

    target.addEventListener('connected', (event) => { c.source = event.data; });
    target.addEventListener('disconnected', () => c.reset());
    return c;
}

// A small label that rides above the controller.
function makeHint() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 160;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    sprite.scale.set(0.32, 0.05, 1);
    sprite.position.set(0, 0.06, -0.06);
    sprite.renderOrder = 30;
    sprite.userData.canvas = canvas;
    return sprite;
}

function setHint(sprite, text) {
    const canvas = sprite.userData.canvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0, 17, 34, 0.78)';
    ctx.beginPath();
    ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 36);
    ctx.fill();
    ctx.fillStyle = '#e6f4fb';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = text.split('\n');
    ctx.font = `500 ${lines.length > 1 ? 44 : 50}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    lines.forEach((line, i) => {
        ctx.fillText(line, canvas.width / 2, canvas.height / 2 + (i - (lines.length - 1) / 2) * 56);
    });
    sprite.material.map.needsUpdate = true;
    sprite.visible = true;
}
