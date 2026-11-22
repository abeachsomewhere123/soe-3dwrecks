// Underwater look for the browser/VR viewer: blue water that fades with
// distance, a sandy seabed out to the horizon, and (in VR only) drifting
// marine snow.
//
// BelowJS has no setting for any of this, so it is added to the BelowJS
// scene from outside. The model is also levelled so the sand at the edge
// of the scan sits flat on the seabed. Survey mode gets the whole look. Dive mode keeps
// BelowJS's own dark fog, torch and particles, with the seabed added.
//
// Units are the model's, which for our scans are metres.

import * as THREE from 'three';
import { levelModel, fitSeabed } from '/assets/level.js?v=3ffc2e16';

// Colours are sampled from the reference renders.
const WATER = '#1d5b77';        // fog, and the water at the horizon
const WATER_ABOVE = '#0c3a55';  // looking straight up
const SAND = '#b3a57c';
const DIVE_WATER = '#041729';   // BelowJS's dive fog colour

// Exponential fog density. 0.017 leaves 11% haze at 20 m, 37% at 40 m and
// little but water past 80 m.
const FOG_DENSITY = 0.017;

// However far the camera is pulled back, keep the wreck at the orbit
// centre at most this hazy, so a phone's backed-off start view (fit-view.js)
// still shows it.
const MAX_HAZE_AT_TARGET = 0.6;

const SEABED_SIZE = 4000;  // metres across; the fog hides the edge
const SAND_TILE = 6;       // metres per repeat of the sand texture

const SNOW_COUNT = 1400;
const SNOW_BOX = 40;       // metres; the snow wraps around the camera in this box

export function addUnderwater(viewer) {
    const below = viewer.belowViewer;
    const scene = below.sceneManager.scene;
    const renderer = below.renderer;

    const water = new THREE.Color(WATER);
    const fog = new THREE.FogExp2(water.getHex(), FOG_DENSITY);
    const background = makeWaterBackground();
    const diveBackground = new THREE.Color(DIVE_WATER);

    // Two seabeds. The outer one meets the sand at the edge of the scan. Where
    // the sand inside the scan dips below that (scour round a wreck), the
    // outer one would bury it, so it leaves a hole the shape of the scan and
    // a lower one fills that hole just under the scanned sand.
    const sand = makeSandTexture();
    sand.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const seabed = makeSeabed(sand, 1);
    const innerSeabed = makeSeabed(sand, 2);
    seabed.visible = innerSeabed.visible = false;
    scene.add(seabed, innerSeabed);

    const snow = makeSnow();
    snow.visible = false;
    scene.add(snow);

    const vignette = document.createElement('div');
    vignette.className = 'underwater-vignette';
    viewer.container?.appendChild(vignette) ?? document.body.appendChild(vignette);

    let modelLoaded = false;
    let dished = false;

    viewer.on('modelLoaded', ({ model }) => {
        if (!model) return;
        levelView(model, below.cameraManager, viewer.config.models?.[viewer.currentModelKey]);
        const fit = fitSeabed(model);
        seabed.position.y = fit.c - 0.04;
        // Only where the scan's edge is all sand (flat to within a metre) and
        // the sand inside goes clearly lower. Where the wreck runs to the
        // edge of the scan (the Euro), one seabed at the edge's height.
        dished = fit.edgeSpread !== undefined && fit.edgeSpread < 1.0 && fit.lowSand < fit.c - 0.1;
        if (dished) {
            const mask = scanFootprint(model);
            for (const m of [seabed, innerSeabed]) {
                m.material.userData.mask.value = mask.texture;
                m.material.userData.maskBox.value.copy(mask.box);
            }
            innerSeabed.position.y = fit.lowSand - 0.04;
        }
        setMasked(seabed, dished);
        modelLoaded = true;
    });

    const cameraPosition = new THREE.Vector3();

    below.on('before-render', (deltaTime) => {
        // VR with seabed passthrough runs as an AR session but is VR until
        // you stand on the sand; BelowJS fades the water and fog out there.
        const passthroughVR = below.isVRPassthroughSession?.() === true;
        if (renderer.xr.isPresenting && isARSession(renderer) && !passthroughVR) {
            // AR shows the real room. Leave the scene alone.
            seabed.visible = innerSeabed.visible = snow.visible = false;
            return;
        }
        // Standing on the sand: the real floor takes over past the scan.
        const inRoom = passthroughVR && below.isVRPassthrough?.() === true;

        const diving = viewer.diveSystem?.isDiveMode?.() === true;
        seabed.visible = modelLoaded && !inRoom;
        innerSeabed.visible = seabed.visible && dished;
        snow.visible = modelLoaded && !diving && !inRoom && renderer.xr.isPresenting;
        vignette.classList.toggle('is-diving', diving);

        if (diving) {
            // BelowJS swaps its own fog in and out. Match the backdrop to it
            // so the seabed fades into the dark rather than a hard edge.
            if (scene.background !== diveBackground) scene.background = diveBackground;
            if (scene.fog) diveBackground.copy(scene.fog.color);
            return;
        }

        if (scene.background !== background) scene.background = background;
        if (scene.fog !== fog) scene.fog = fog;

        // In VR three copies the headset pose into this camera, inside the
        // BelowJS rig. renderer.xr.getCamera() is still the pose in the room
        // at this point, which would centre the snow on the wrong spot.
        const camera = below.cameraManager.camera;
        camera.getWorldPosition(cameraPosition);

        const controls = below.cameraManager.getControls?.();
        let density = FOG_DENSITY;
        if (controls?.target && !renderer.xr.isPresenting) {
            const distance = cameraPosition.distanceTo(controls.target);
            const clearest = Math.sqrt(-Math.log(1 - MAX_HAZE_AT_TARGET)) / Math.max(distance, 1);
            density = Math.min(FOG_DENSITY, clearest);
        }
        fog.density = density;

        const u = snow.material.uniforms;
        u.uCamera.value.copy(cameraPosition);
        u.uTime.value += deltaTime || 0;
        u.uFogDensity.value = density;
        u.uPixelScale.value = renderer.domElement.height / 2 / Math.tan(THREE.MathUtils.degToRad((camera.fov || 65) / 2));
    });

    return { seabed, snow, fog };
}

function isARSession(renderer) {
    const session = renderer.xr.getSession?.();
    return session?.mode === 'immersive-ar' ||
        session?.environmentBlendMode === 'alpha-blend' ||
        session?.environmentBlendMode === 'additive';
}

// A gradient wrapped round the whole view: horizon colour at and below the
// horizon (the fog colour, so distant sand melts into it), darker overhead.
function makeWaterBackground() {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, WATER_ABOVE);
    g.addColorStop(0.3, '#124a66');
    g.addColorStop(0.47, WATER);
    g.addColorStop(1, WATER);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// A seabed plane. mode 1 (outer): hidden inside the scan's outline when a
// mask is set. mode 2 (inner): shown only inside it.
function makeSeabed(map, mode) {
    const geometry = new THREE.PlaneGeometry(SEABED_SIZE, SEABED_SIZE);
    geometry.rotateX(-Math.PI / 2);
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * SEABED_SIZE / SAND_TILE, uv.getY(i) * SEABED_SIZE / SAND_TILE);
    }

    const material = new THREE.MeshStandardMaterial({
        map,
        color: '#ffffff',
        roughness: 1,
        metalness: 0,
        // The outer seabed is seen from below through the gap at the scan's
        // ragged edge when it has a hole cut in it.
        side: mode === 1 ? THREE.DoubleSide : THREE.FrontSide
    });
    const uniforms = {
        uMask: { value: null },
        uMaskBox: { value: new THREE.Vector4(0, 0, 1, 1) },   // min x, min z, size x, size z
        uMaskOn: { value: 0 }
    };
    material.userData.mask = uniforms.uMask;
    material.userData.maskBox = uniforms.uMaskBox;
    material.userData.maskOn = uniforms.uMaskOn;

    // Break up the tiling: shade each patch of sand a little lighter or
    // darker using the same texture sampled at a much larger scale. Then
    // cut the plane to (or round) the scan's outline.
    material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = 'varying vec2 vSeabedXZ;\n' + shader.vertexShader.replace(
            '#include <project_vertex>',
            `#include <project_vertex>
            vSeabedXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`
        );
        shader.fragmentShader = 'varying vec2 vSeabedXZ;\nuniform sampler2D uMask;\nuniform vec4 uMaskBox;\nuniform float uMaskOn;\n' + shader.fragmentShader.replace(
            '#include <map_fragment>',
            `if (uMaskOn > 0.5) {
                vec2 m = (vSeabedXZ - uMaskBox.xy) / uMaskBox.zw;
                float inside = (m.x < 0.0 || m.y < 0.0 || m.x > 1.0 || m.y > 1.0) ? 0.0 : texture2D(uMask, m).r;
                if (${mode === 1 ? 'inside > 0.5' : 'inside < 0.5'}) discard;
            }
            #include <map_fragment>
            float broad = texture2D(map, vMapUv * 0.071 + vec2(0.37, 0.11)).r;
            float broader = texture2D(map, vMapUv * 0.013 + vec2(0.71, 0.53)).g;
            diffuseColor.rgb *= 0.78 + 0.45 * broad * broader / 0.5;`
        );
    };
    material.customProgramCacheKey = () => 'underwater-seabed-' + mode;
    if (mode === 2) uniforms.uMaskOn.value = 1;

    const seabed = new THREE.Mesh(geometry, material);
    seabed.name = mode === 1 ? 'underwater-seabed' : 'underwater-seabed-inner';
    seabed.receiveShadow = true;
    // Keep double-click focus and measuring on the wreck itself.
    seabed.raycast = () => {};
    return seabed;
}

// Pale sand with darker grains and soft blotches, drawn once and tiled.
function makeSandTexture() {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = SAND;
    ctx.fillRect(0, 0, size, size);

    const random = seededRandom(7);

    // Soft light and dark blotches, drawn wrapped so the tile repeats cleanly.
    const blot = (x, y, r, colour) => {
        for (const dx of [-size, 0, size]) {
            for (const dy of [-size, 0, size]) {
                const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
                g.addColorStop(0, colour);
                g.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = g;
                ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
            }
        }
    };
    for (let i = 0; i < 40; i++) {
        const dark = random() < 0.5;
        blot(random() * size, random() * size, 30 + random() * 90,
            dark ? 'rgba(80,72,50,0.18)' : 'rgba(235,225,190,0.16)');
    }

    // Dark specks: shell grit and weed, as in the scanned sand.
    for (let i = 0; i < 420; i++) {
        const x = random() * size;
        const y = random() * size;
        const r = 0.6 + random() * 1.8;
        ctx.fillStyle = `rgba(${55 + random() * 30},${55 + random() * 25},${40 + random() * 20},${0.2 + random() * 0.35})`;
        ctx.beginPath();
        ctx.ellipse(x, y, r * (1 + random()), r, random() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
    }

    // Fine grain.
    const image = ctx.getImageData(0, 0, size, size);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
        const n = (random() - 0.5) * 22;
        d[i] += n;
        d[i + 1] += n;
        d[i + 2] += n * 0.8;
    }
    ctx.putImageData(image, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function seededRandom(seed) {
    return () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
    };
}

// levelModel() turns the scan so the sand round its edge lies flat. Turn the
// camera and the VR start with it so both still frame the wreck as they
// were set up.
function levelView(model, cameraManager, settings) {
    const level = levelModel(model);
    if (!level) return;

    const camera = cameraManager?.getCamera?.();
    const controls = cameraManager?.getControls?.();
    if (camera && controls?.target) {
        camera.position.applyQuaternion(level);
        controls.target.applyQuaternion(level);
        controls.update();
    }

    // The VR start (from metadata.json or xr-start.js) puts your eyes 1.6 m
    // above the dolly. Move the eyes with the model and keep facing the same
    // part of the wreck.
    const vr = settings?.initialPositions?.vr;
    if (vr?.dolly) {
        const eyeHeight = 1.6;
        const eye = new THREE.Vector3(vr.dolly.x, vr.dolly.y + eyeHeight, vr.dolly.z).applyQuaternion(level);
        Object.assign(vr.dolly, { x: eye.x, y: eye.y - eyeHeight, z: eye.z });
        if (vr.rotation) {
            const yaw = vr.rotation.y || 0;
            const facing = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).applyQuaternion(level);
            vr.rotation.y = Math.atan2(-facing.x, -facing.z);
        }
    }
}

// Marine snow: specks that drift slowly downward and wrap round the camera,
// so there is always some nearby without filling the whole ocean.
function makeSnow() {
    const positions = new Float32Array(SNOW_COUNT * 3);
    const sizes = new Float32Array(SNOW_COUNT);
    const random = seededRandom(11);
    for (let i = 0; i < SNOW_COUNT; i++) {
        positions[i * 3] = random() * SNOW_BOX;
        positions[i * 3 + 1] = random() * SNOW_BOX;
        positions[i * 3 + 2] = random() * SNOW_BOX;
        sizes[i] = 0.05 + Math.pow(random(), 3) * 0.16;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.ShaderMaterial({
        uniforms: {
            uCamera: { value: new THREE.Vector3() },
            uTime: { value: 0 },
            uBox: { value: SNOW_BOX },
            uFogDensity: { value: FOG_DENSITY },
            uPixelScale: { value: 600 },
            uColour: { value: new THREE.Color('#dcecf2') }
        },
        vertexShader: /* glsl */ `
            uniform vec3 uCamera;
            uniform float uTime;
            uniform float uBox;
            uniform float uPixelScale;
            attribute float size;
            varying float vFade;
            void main() {
                vec3 drift = vec3(sin(uTime * 0.13 + position.y) * 0.4, -uTime * 0.12, cos(uTime * 0.11 + position.x) * 0.4);
                vec3 p = mod(position + drift - uCamera + 0.5 * uBox, uBox) - 0.5 * uBox + uCamera;
                vec4 mv = modelViewMatrix * vec4(p, 1.0);
                float dist = length(mv.xyz);
                // Fade in from the edge of the box so specks never pop.
                vFade = 1.0 - smoothstep(0.32 * uBox, 0.5 * uBox, length(p - uCamera));
                vFade *= smoothstep(0.3, 1.2, dist);
                gl_PointSize = clamp(size * uPixelScale / max(dist, 0.1), 1.5, 14.0);
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: /* glsl */ `
            uniform vec3 uColour;
            uniform float uFogDensity;
            varying float vFade;
            void main() {
                float r = length(gl_PointCoord - 0.5);
                float a = smoothstep(0.5, 0.0, r);
                float depth = gl_FragCoord.z / gl_FragCoord.w;
                float haze = 1.0 - exp(-pow(uFogDensity * depth * 1.6, 2.0));
                gl_FragColor = vec4(uColour, a * 0.8 * vFade * (1.0 - haze));
                #include <colorspace_fragment>
            }
        `,
        transparent: true,
        depthWrite: false
    });

    const snow = new THREE.Points(geometry, material);
    snow.name = 'underwater-snow';
    snow.frustumCulled = false;
    snow.renderOrder = 10;
    return snow;
}

function setMasked(seabed, on) {
    seabed.material.userData.maskOn.value = on ? 1 : 0;
}

// The scan's outline seen from above, as a mask texture: squares the scan
// covers, small gaps closed, holes inside it filled, then pulled in by two
// squares so the outer seabed still tucks under the scan's edge.
function scanFootprint(model, N = 128) {
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const sx = (box.max.x - box.min.x) / N || 1, sz = (box.max.z - box.min.z) / N || 1;
    let grid = new Uint8Array(N * N);
    const v = new THREE.Vector3();
    model.traverse((o) => {
        const position = o.isMesh && o.geometry?.attributes?.position;
        if (!position) return;
        const step = Math.max(1, Math.floor(position.count / 400000));
        for (let i = 0; i < position.count; i += step) {
            v.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
            const cx = Math.min(N - 1, Math.floor((v.x - box.min.x) / sx));
            const cz = Math.min(N - 1, Math.floor((v.z - box.min.z) / sz));
            grid[cz * N + cx] = 1;
        }
    });
    const at = (g, x, z) => (x >= 0 && z >= 0 && x < N && z < N ? g[z * N + x] : 0);
    const morph = (g, grow) => {
        const out = new Uint8Array(N * N);
        for (let z = 0; z < N; z++) {
            for (let x = 0; x < N; x++) {
                const n = [at(g, x, z), at(g, x - 1, z), at(g, x + 1, z), at(g, x, z - 1), at(g, x, z + 1)];
                out[z * N + x] = grow ? (n.some(Boolean) ? 1 : 0) : (n.every(Boolean) ? 1 : 0);
            }
        }
        return out;
    };
    grid = morph(morph(grid, true), false);                 // close small gaps
    // Fill holes: anything not reachable from the border is inside.
    const outside = new Uint8Array(N * N), stack = [];
    for (let k = 0; k < N; k++) stack.push([k, 0], [k, N - 1], [0, k], [N - 1, k]);
    while (stack.length) {
        const [x, z] = stack.pop();
        if (x < 0 || z < 0 || x >= N || z >= N) continue;
        const i = z * N + x;
        if (outside[i] || grid[i]) continue;
        outside[i] = 1;
        stack.push([x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]);
    }
    for (let i = 0; i < N * N; i++) grid[i] = outside[i] ? 0 : 1;
    grid = morph(morph(grid, false), false);                 // pull in two squares
    const data = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) data[i] = grid[i] * 255;
    const texture = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return { texture, box: new THREE.Vector4(box.min.x, box.min.z, box.max.x - box.min.x, box.max.z - box.min.z) };
}
