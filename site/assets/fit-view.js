// Start positions in metadata.json are set on a wide desktop screen. The
// camera's vertical field of view is fixed, so a narrower screen (a phone in
// portrait) sees less from side to side and crops a long wreck. Back the
// camera away from its target until the same width fits.
//
// Only the live camera moves. The settings stay as they are, because the VR
// and AR start positions are worked out from them.

const DESIGN_ASPECT = 16 / 9; // the screen shape start positions are set on

export function fitStartViewToScreen(viewer) {
    viewer.on('modelLoaded', () => {
        const cameraManager = viewer.belowViewer?.cameraManager;
        const camera = cameraManager?.getCamera?.();
        const controls = cameraManager?.getControls?.();
        if (!camera || !controls || !camera.aspect) return;
        if (!viewer.config.models[viewer.currentModelKey]?.initialPositions?.desktop) return;

        const stretch = DESIGN_ASPECT / camera.aspect;
        if (stretch <= 1) return;

        const offset = camera.position.clone().sub(controls.target).multiplyScalar(stretch);
        controls.maxDistance = Math.max(controls.maxDistance, offset.length() * 1.5);
        camera.position.copy(controls.target).add(offset);
        controls.update();
    });
}
