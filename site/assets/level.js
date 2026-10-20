// Photogrammetry scans come out at whatever tilt the software picked. The
// Euro scan, for one, is tilted about 11 degrees. Shared by /view/ (so the
// sand meets the seabed) and /ar/ (so the wreck sits flat on a table).

import * as THREE from 'three';

const MIN_TILT = THREE.MathUtils.degToRad(0.5);
const MAX_TILT = THREE.MathUtils.degToRad(30); // beyond this, something else is wrong

// Turn the model so the sand round the edge of the scan lies flat. Returns
// the turn applied, or null if the model was already level (or levelled
// before). BelowJS centres the model on the origin, so it turns about that.
export function levelModel(model) {
    if (model.userData.levelled) return null;
    model.userData.levelled = true;

    const { a, b } = fitSeabed(model);
    const tilt = Math.atan(Math.hypot(a, b));
    if (tilt < MIN_TILT || tilt > MAX_TILT) return null;

    const sandUp = new THREE.Vector3(-a, 1, -b).normalize();
    const level = new THREE.Quaternion().setFromUnitVectors(sandUp, new THREE.Vector3(0, 1, 0));

    model.quaternion.premultiply(level);
    model.position.applyQuaternion(level);
    model.updateMatrixWorld(true);
    return level;
}

// The plane y = a·x + b·z + c through the sand at the edge of the scan.
// Grid the model from above and take the lowest point in each square that
// lies on the outline of the scanned area, then fit a plane through those,
// twice, dropping stray points (a hanging plate, a scour hole) the second time.
export function fitSeabed(model) {
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const N = 48;
    const lowest = new Float32Array(N * N).fill(Infinity);
    const sx = (box.max.x - box.min.x) / N || 1;
    const sz = (box.max.z - box.min.z) / N || 1;
    const v = new THREE.Vector3();

    model.traverse((o) => {
        const position = o.isMesh && o.geometry?.attributes?.position;
        if (!position) return;
        const step = Math.max(1, Math.floor(position.count / 200000));
        for (let i = 0; i < position.count; i += step) {
            v.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
            const cx = Math.min(N - 1, Math.floor((v.x - box.min.x) / sx));
            const cz = Math.min(N - 1, Math.floor((v.z - box.min.z) / sz));
            const k = cz * N + cx;
            if (v.y < lowest[k]) lowest[k] = v.y;
        }
    });

    const edge = [];
    const filled = (x, z) => x >= 0 && z >= 0 && x < N && z < N && lowest[z * N + x] !== Infinity;
    for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
            if (!filled(x, z)) continue;
            if (!filled(x - 1, z) || !filled(x + 1, z) || !filled(x, z - 1) || !filled(x, z + 1)) {
                edge.push([box.min.x + (x + 0.5) * sx, box.min.z + (z + 0.5) * sz, lowest[z * N + x]]);
            }
        }
    }
    if (edge.length < 3) return { a: 0, b: 0, c: box.min.y };

    let fit = fitPlane(edge);
    const residuals = edge.map(([x, z, y]) => y - (fit.a * x + fit.b * z + fit.c));
    const spread = Math.sqrt(residuals.reduce((t, r) => t + r * r, 0) / residuals.length);
    const kept = edge.filter((_, i) => Math.abs(residuals[i]) <= 2 * spread);
    if (kept.length >= 3) fit = fitPlane(kept);
    return fit;
}

// Least-squares y = a·x + b·z + c.
function fitPlane(points) {
    let sxx = 0, sxz = 0, szz = 0, sx = 0, sz = 0, sxy = 0, szy = 0, sy = 0;
    const n = points.length;
    for (const [x, z, y] of points) {
        sxx += x * x; sxz += x * z; szz += z * z;
        sx += x; sz += z;
        sxy += x * y; szy += z * y; sy += y;
    }
    // Solve the 3×3 normal equations by Cramer's rule.
    const det3 = (m) =>
        m[0] * (m[4] * m[8] - m[5] * m[7]) -
        m[1] * (m[3] * m[8] - m[5] * m[6]) +
        m[2] * (m[3] * m[7] - m[4] * m[6]);
    const M = [sxx, sxz, sx, sxz, szz, sz, sx, sz, n];
    const d = det3(M);
    if (Math.abs(d) < 1e-9) return { a: 0, b: 0, c: sy / n };
    const r = [sxy, szy, sy];
    const col = (i) => M.map((m, k) => (k % 3 === i ? r[Math.floor(k / 3)] : m));
    return { a: det3(col(0)) / d, b: det3(col(1)) / d, c: det3(col(2)) / d };
}
