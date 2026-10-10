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
// Instead, show the browser start view in miniature: the wreck at the AR
// scale from the page's settings (defaultScale), with your eyes where the
// browser camera is, scaled down by the same amount and facing the same way.
// Units are metres, relative to your eyes at the moment AR starts.
const MIN_GAP = 1.5;      // nearest edge of the wreck is at least this far ahead
const FALLBACK_DROP = 0.75; // wrecks with no desktop start position

export function placeArModel(viewer) {
    const place = () => {
        const ar = viewer.belowViewer?.arManager;
        const group = ar?.modelGroup;
        if (!ar?.isARPresenting || !group || !ar.currentModel) return;

        // Set by BelowJS from the model's or the page's defaultScale.
        const scale = ar.currentModelScale;
        const desktop = viewer.config.models[viewer.currentModelKey]?.initialPositions?.desktop;

        group.rotation.set(0, 0, 0);
        group.scale.setScalar(scale);

        if (desktop) {
            const { camera: c, target: t } = desktop;
            const yaw = Math.atan2(c.x - t.x, c.z - t.z);
            group.rotation.y = -yaw;
            const eye = new THREE.Vector3(c.x, c.y, c.z)
                .multiplyScalar(scale)
                .applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
            group.position.copy(eye).negate();
        } else {
            group.position.set(0, 0, 0);
            group.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(ar.currentModel);
            if (box.isEmpty()) return;
            const centre = box.getCenter(new THREE.Vector3());
            group.position.set(-centre.x, -FALLBACK_DROP - box.min.y, -centre.z);
        }

        // Slide the wreck straight back if its near edge is within arm's reach.
        group.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(ar.currentModel);
        if (!box.isEmpty() && box.max.z > -MIN_GAP) {
            group.position.z -= box.max.z + MIN_GAP;
        }
    };

    viewer.on('ar-session-start', place);
    viewer.on('modelLoaded', place); // switching wrecks mid-session
}
