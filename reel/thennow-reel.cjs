// Then and now reel: drives the /then-now/ page frame by frame in headless
// Chromium (portrait 1080 x 1920 at DSF=2; 810 x 1440 at the default 1.5,
// scaled up when encoding) and saves PNG frames.
//
//   S=<dir holding extras/raw/Euro.glb> BASE=http://localhost:8765 \
//     node reel/thennow-reel.cjs stills OUTDIR 25 0.5 4 10 19   # check stills
//   START=0 END=250 ... node reel/thennow-reel.cjs frames OUTDIR 25   # two at once
//   ffmpeg -framerate 25 -i OUTDIR/f%04d.png -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
//     -vf "scale=1080:1920:flags=lanczos,format=yuv420p" -c:v libx264 -preset slow -crf 17 \
//     -c:a aac -b:a 128k -shortest -movflags +faststart reel.mp4
//   COVER=1 COVER_SPLIT=0.58 DSF=2 ... stills OUTDIR 25 4.6        # cover image
//
// Serve site/ locally (python3 -m http.server 8765 in site/). The page's
// animation clock is taken over once the model is in, so each frame is drawn
// exactly once with time advancing 1/FPS: fast and steady. Edit plan() for
// the divider and camera moves, and the overlay HTML for the titles.
const { chromium } = require('playwright');
const fs = require('fs');
const S = process.env.S, BASE = process.env.BASE || 'http://localhost:8765';
const [mode, out, fpsArg, ...timesArg] = process.argv.slice(2);
const FPS = Number(fpsArg || 25), DURATION = 20;
fs.mkdirSync(out, { recursive: true });
const ease = (t) => t * t * (3 - 2 * t);
const seg = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));
// The plan, as functions of time (s): divider position (fraction showing
// THEN), camera azimuth (deg from starboard beam, + towards the bow),
// elevation (deg) and distance (m).
function plan(t) {
    let split;
    if (t < 2.5) split = 0;
    else if (t < 5.2) split = ease(seg(t, 2.5, 5.2));
    else if (t < 7.0) split = 1 - 0.5 * ease(seg(t, 5.2, 7.0));
    else if (t < 15) split = 0.5 + 0.17 * Math.sin((t - 7) / 8 * Math.PI * 2);
    else if (t < 16.6) split = 0.5 + 0.5 * ease(seg(t, 15, 16.6));
    else if (t < 18.2) split = 1 - ease(seg(t, 16.6, 18.2));
    else split = 0.5 * ease(seg(t, 18.2, 19.3));
    const az = 52 - 100 * ease(seg(t, 0, 20));         // from the starboard bow round to the starboard quarter
    const el = 40 - 4 * Math.sin(seg(t, 0, 20) * Math.PI);
    const dist = 34 - 6 * Math.sin(seg(t, 0, 20) * Math.PI);
    if (process.env.COVER_SPLIT) split = Number(process.env.COVER_SPLIT);
    return { split, az, el, dist };
}
const titleOpacity = (t) => process.env.COVER ? 1 : (t < 0.4 ? t / 0.4 : t < 5.5 ? 1 : t < 6.3 ? 1 - (t - 5.5) / 0.8 : 0);
const endOpacity = (t) => (t < 16.8 ? 0 : t < 17.6 ? (t - 16.8) / 0.8 : 1);

(async () => {
  const browser = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost' } : undefined, args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: Number(process.env.DSF || 1.5) });
  page.setDefaultTimeout(900000);
  // Manual clock: once the model is in, the page only draws when the reel
  // asks for a frame, and time advances exactly one frame each time.
  await page.addInitScript(() => {
    const native = window.requestAnimationFrame.bind(window);
    window.__manual = false; window.__queue = []; window.__now = 0;
    window.requestAnimationFrame = (cb) => {
      if (!window.__manual) return native((t) => { window.__now = t; cb(t); });
      window.__queue.push(cb); return window.__queue.length;
    };
    window.__tick = (ms) => { window.__now += ms; const q = window.__queue; window.__queue = []; for (const cb of q) cb(window.__now); };
  });
  page.on('pageerror', e => console.log('pageerror', e.message));
  await page.route('**/f/v/**/Euro.glb', r => r.fulfill({ path: S + '/extras/raw/Euro.glb', contentType: 'model/gltf-binary' }));
  await page.goto(BASE + '/then-now/?model=euro');
  await page.waitForFunction(() => window.wreckExtras?.state?.ghost, null, { timeout: 300000 });
  await page.waitForTimeout(4000);
  // Reel overlay: hide the page's chrome, keep the THEN / NOW tags and the
  // slider; add a title and an end card.
  await page.addStyleTag({ content: `
    .tn-head, .tn-spin, .tn-note, .tn-hint, .soe-back, .loading-indicator { display: none !important; }
    .tn-label { bottom: 300px !important; font-size: 0.95rem !important; }
    .tn-label small { font-size: 0.72rem !important; }
    .reel-title, .reel-end { position: fixed; left: 0; right: 0; z-index: 20; text-align: center; color: #fff; pointer-events: none;
      font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; text-shadow: 0 2px 10px rgba(0,0,0,0.65); }
    .reel-title { top: 150px; }
    .reel-title img, .reel-end img { width: 64px; filter: invert(1); opacity: 0.95; }
    .reel-kicker { margin-top: 10px; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.32em; color: #ffd36b; }
    .reel-name { margin: 2px 0 0; font-size: 3.1rem; font-weight: 800; letter-spacing: 0.06em; line-height: 1.05; }
    .reel-sub { margin-top: 8px; font-size: 1rem; font-weight: 500; color: #e3eef4; }
    .reel-end { top: 150px; }
    .reel-end .reel-name { font-size: 1.7rem; letter-spacing: 0.02em; }
    .reel-url { display: inline-block; margin-top: 12px; padding: 7px 14px; border-radius: 999px; background: rgba(2,22,36,0.7);
      font-size: 0.82rem; font-weight: 600; letter-spacing: 0.02em; }
  ` });
  await page.evaluate(() => {
    const title = document.createElement('div');
    title.className = 'reel-title';
    title.innerHTML = '<img src="/assets/soe-logo.webp" alt=""><div class="reel-kicker">THEN &amp; NOW</div><div class="reel-name">EURO</div><div class="reel-sub">Steam tug · built 1897 · scuttled 1948</div>';
    const end = document.createElement('div');
    end.className = 'reel-end';
    end.style.opacity = 0;
    end.innerHTML = '<img src="/assets/soe-logo.webp" alt=""><div class="reel-name">Slide between then and now</div><div class="reel-url">3dwrecks.southernoceanexploration.com</div>';
    document.body.append(title, end);
    const ctl = window.wreckExtras.viewer.belowViewer.cameraManager.getControls();
    ctl.autoRotate = false;
    window.__manual = true;
  });
  await page.waitForTimeout(3000);   // let the last native frame hand over to the manual clock

  const setFrame = async (t) => {
    const p = plan(t);
    // Move the divider by dragging its grip, as a visitor would.
    const [gx, gy] = await page.evaluate(() => { const r = document.querySelector('.tn-grip').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await page.mouse.move(gx, gy); await page.mouse.down();
    await page.mouse.move(Math.max(0.5, Math.min(539.5, p.split * 540)), gy); await page.mouse.up();
    await page.evaluate(([p, to, eo]) => {
      document.querySelector('.reel-title').style.opacity = to;
      document.querySelector('.reel-end').style.opacity = eo;
      const w = window.wreckExtras, ship = w.state.ghost.group.children[0];
      ship.updateWorldMatrix(true, false);
      const m = ship.matrixWorld, V = ship.position.constructor;
      const f = new V().setFromMatrixColumn(m, 0); f.y = 0; f.normalize();
      const up = new V(0, 1, 0), s = new V().crossVectors(f, up).normalize();
      const T = new V(3, 2.5, 0).applyMatrix4(m);
      const az = p.az * Math.PI / 180, el = p.el * Math.PI / 180;
      const dir = s.clone().multiplyScalar(Math.cos(az)).addScaledVector(f, Math.sin(az));
      const cam = w.viewer.belowViewer.cameraManager.camera, ctl = w.viewer.belowViewer.cameraManager.getControls();
      ctl.target.copy(T);
      cam.position.copy(T).addScaledVector(dir, Math.cos(el) * p.dist).addScaledVector(up, Math.sin(el) * p.dist);
      ctl.update();
    }, [p, titleOpacity(t), endOpacity(t)]);
    // Let the viewer draw two frames with the new state.
    await page.evaluate((ms) => window.__tick(ms), 1000 / FPS);
  };

  if (mode === 'stills') {
    for (const t of timesArg.map(Number)) {
      await setFrame(t);
      await page.screenshot({ path: `${out}/still-${t.toFixed(1).padStart(5, '0')}.png`, timeout: 240000 });
      console.log('still', t);
    }
  } else {
    const total = Math.round(DURATION * FPS);
    const start = Number(process.env.START || 0), end = Math.min(total, Number(process.env.END || total));
    for (let i = start; i < end; i++) {
      const file = `${out}/f${String(i).padStart(4, '0')}.png`;
      if (fs.existsSync(file)) continue;
      await setFrame(i / FPS);
      await page.screenshot({ path: file, timeout: 240000 });
      if (i % 25 === 0) console.log('frame', i, 'of', total, new Date().toISOString());
    }
  }
  await browser.close();
})();
