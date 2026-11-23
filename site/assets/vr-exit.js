// An "Exit VR" button on the right wrist, for every model, in VR and AR.
// Look at it for a moment, or touch it with the left controller, and the
// session ends. (The headset's own menu button still works too.)

import * as THREE from 'three';

const GAZE_ANGLE = THREE.MathUtils.degToRad(7);
const GAZE_RANGE = 0.8;      // metres: only when the wrist is raised to look at
const GAZE_SECONDS = 1.5;
const TOUCH_DISTANCE = 0.1;  // metres from the left controller's grip
const TOUCH_SECONDS = 0.8;

export function addVrExit(viewer) {
    const below = viewer.belowViewer;
    const renderer = below.renderer;
    const button = makeButton();
    const handedness = new Map();
    for (let i = 0; i < 2; i++) {
        const controller = renderer.xr.getController(i);
        controller.addEventListener('connected', (e) => handedness.set(i, e.data?.handedness));
        controller.addEventListener('disconnected', () => handedness.delete(i));
    }

    let held = 0;
    let ended = false;
    renderer.xr.addEventListener('sessionstart', () => { held = 0; ended = false; button.draw(0); });
    renderer.xr.addEventListener('sessionend', () => button.mesh.removeFromParent());

    const gripFor = (hand) => {
        for (let i = 0; i < 2; i++) {
            const h = renderer.xr.getController(i).userData?.handedness || handedness.get(i);
            if (h === hand) return renderer.xr.getControllerGrip(i);
        }
        return null;
    };

    const eye = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const target = new THREE.Vector3();
    const other = new THREE.Vector3();
    const rigQuaternion = new THREE.Quaternion();

    below.on('before-render', (deltaTime) => {
        if (!renderer.xr.isPresenting || ended) return;
        const right = gripFor('right');
        if (!right) return;
        // BelowJS only puts controller grips in the scene in VR; in AR, add it.
        if (!right.parent) below.sceneManager.scene.add(right);
        if (button.mesh.parent !== right) right.add(button.mesh);

        // Head pose in the scene: the headset pose in the room, placed by the
        // BelowJS rig (three only combines them later in the frame).
        const rig = below.cameraManager.camera.parent;
        const head = renderer.xr.getCamera();
        if (rig) {
            rig.updateWorldMatrix(true, false);
            eye.copy(head.position).applyMatrix4(rig.matrixWorld);
            forward.set(0, 0, -1).applyQuaternion(head.quaternion).applyQuaternion(rig.getWorldQuaternion(rigQuaternion));
        } else {
            head.getWorldPosition(eye);
            head.getWorldDirection(forward);
        }
        button.mesh.getWorldPosition(target);
        const toButton = target.clone().sub(eye);
        const looking = toButton.length() < GAZE_RANGE && forward.angleTo(toButton) < GAZE_ANGLE;

        const left = gripFor('left');
        if (left && !left.parent) below.sceneManager.scene.add(left);
        const touching = left ? left.getWorldPosition(other).distanceTo(target) < TOUCH_DISTANCE : false;

        const dt = Math.min(deltaTime || 0.016, 0.1);
        const need = touching ? TOUCH_SECONDS : GAZE_SECONDS;
        held = looking || touching ? held + dt / need : Math.max(0, held - dt * 2);
        button.draw(Math.min(1, held), below.arManager?.isARPresenting ? 'EXIT AR' : 'EXIT VR');
        if (held >= 1) {
            ended = true;
            renderer.xr.getSession()?.end();
        }
    });
}

function makeButton() {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 160;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, fog: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.084, 0.035), material);
    mesh.name = 'vr-exit-button';
    mesh.renderOrder = 26;
    mesh.raycast = () => {};
    // On the back of the right wrist, tilted towards you.
    mesh.position.set(0, 0.035, 0.09);
    mesh.rotation.set(-Math.PI / 2 + 0.5, 0, 0);

    let last = '';
    const draw = (progress, label = 'EXIT VR') => {
        const key = `${Math.round(progress * 40)}|${label}`;
        if (key === last) return;
        last = key;
        const c = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height, r = 36;
        c.clearRect(0, 0, W, H);
        c.beginPath();
        c.moveTo(r, 4); c.arcTo(W - 4, 4, W - 4, H - 4, r); c.arcTo(W - 4, H - 4, 4, H - 4, r);
        c.arcTo(4, H - 4, 4, 4, r); c.arcTo(4, 4, W - 4, 4, r); c.closePath();
        c.fillStyle = '#2a0b0b';
        c.fill();
        // Progress fills from the left while you look or touch.
        if (progress > 0) {
            c.save(); c.clip();
            c.fillStyle = '#b3261e';
            c.fillRect(0, 0, W * progress, H);
            c.restore();
        }
        c.lineWidth = 8;
        c.strokeStyle = '#ff6b5e';
        c.stroke();
        c.fillStyle = '#ffffff';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = '700 64px -apple-system, "Segoe UI", Roboto, sans-serif';
        c.fillText(label, W / 2, H / 2 - 10);
        c.font = '500 26px -apple-system, "Segoe UI", Roboto, sans-serif';
        c.fillStyle = '#ffd0cb';
        c.fillText('look here or touch', W / 2, H - 30);
        texture.needsUpdate = true;
    };
    draw(0);
    return { mesh, draw };
}
