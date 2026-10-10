// Where you start when entering VR or AR. Shared by /view/ and /ar/.
import * as THREE from 'three';

// BelowJS VR uses the 'local-floor' space: the rig sits on the floor and
// your eyes are about this far above it.
const EYE_HEIGHT = 1.6;

// VR: models with a desktop start position but no `vr` block in metadata.json
// would otherwise start at the model's centre, inside the hull. Derive a VR
// start from the desktop camera instead: same spot, facing the same way.
// An explicit `vr` block in metadata.json still wins.
export function addVrStarts(models) {
    for (const model of Object.values(models)) {
        const desktop = model.initialPositions?.desktop;
        if (!desktop || model.initialPositions.vr) continue;
        const { camera: c, target: t } = desktop;
        model.initialPositions.vr = {
            dolly: { x: c.x, y: c.y - EYE_HEIGHT, z: c.z },
            // Yaw only: tilting the rig to look down would tilt the horizon.
            rotation: { x: 0, y: Math.atan2(c.x - t.x, c.z - t.z), z: 0 }
        };
    }
}

// AR: BelowJS puts the model's centre where your head was when AR started.
// Instead, shrink it to tabletop size and set it down in front of you.
// Units are metres, relative to your eyes at the moment AR starts.
const AR_LENGTH = 1.2;   // longest side of the wreck
const AR_DISTANCE = 1.4; // from you to the wreck's centre
const AR_DROP = 0.75;    // from your eyes down to the wreck's base

export function placeArModel(viewer) {
    const place = () => {
        const ar = viewer.belowViewer?.arManager;
        const group = ar?.modelGroup;
        if (!ar?.isARPresenting || !group || !ar.currentModel) return;

        group.position.set(0, 0, 0);
        group.rotation.set(0, 0, 0);
        group.scale.setScalar(1);
        group.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(ar.currentModel);
        if (box.isEmpty()) return;
        const size = box.getSize(new THREE.Vector3());
        const centre = box.getCenter(new THREE.Vector3());

        // Same limits as BelowJS's pinch-to-scale, so the first pinch doesn't jump.
        const scale = Math.min(1, Math.max(0.01, AR_LENGTH / Math.max(size.x, size.z, 0.001)));
        group.scale.setScalar(scale);
        group.position.set(
            -centre.x * scale,
            -AR_DROP - box.min.y * scale,
            -AR_DISTANCE - centre.z * scale
        );
        ar.currentModelScale = scale;
    };

    viewer.on('ar-session-start', place);
    viewer.on('modelLoaded', place); // switching wrecks mid-session
}
