// Drives render.html in headless Chromium. Called by make_reel.py.
//   node render.js <job dir> frames 0:1349:2
//   node render.js <job dir> survey
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const fs = require('fs'), path = require('path');
const [job, mode, list] = process.argv.slice(2);
const here = __dirname, site = path.join(here, '..', 'site', 'assets');
const C = JSON.parse(fs.readFileSync(path.join(job, 'reel.json')));
const files = { '/render.html': [path.join(here, 'render.html'), 'text/html'], '/reel.json': [path.join(job, 'reel.json'), 'application/json'],
  '/model.glb': [path.join(job, 'model.glb'), 'model/gltf-binary'], '/sand.jpg': [path.join(here, 'assets', 'sand.jpg'), 'image/jpeg'],
  '/level.js': [path.join(site, 'level.js'), 'text/javascript'] };
(async () => {
  const b = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: C.width, height: C.height } });
  await ctx.route('https://reel.test/**', (rt) => { const f = files[new URL(rt.request().url()).pathname];
    if (!f) return rt.fulfill({ status: 404, body: '' }); rt.fulfill({ status: 200, contentType: f[1], body: fs.readFileSync(f[0]) }); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => console.log('page error:', e.message));
  await p.goto('https://reel.test/render.html'); await p.waitForFunction('window.ready===true', { timeout: 900000 });
  const save = (fn, d) => fs.writeFileSync(fn, Buffer.from(d.split(',')[1], 'base64'));
  if (mode === 'survey') {
    const dir = path.join(job, 'survey'); fs.mkdirSync(dir, { recursive: true });
    const info = await p.evaluate(() => ({ ...window.info, seabed: window.seabedInfo }));
    const top = await p.evaluate(() => window.surveyTop(1800)); save(path.join(dir, 'top.jpg'), top.u);
    fs.writeFileSync(path.join(dir, 'survey.json'), JSON.stringify({ ...info, top: { x0: top.x0, x1: top.x1, z0: top.z0, z1: top.z1 } }, null, 1));
    const [x0, y0, z0] = info.min, [x1, y1, z1] = info.max, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, cy = (y0 + y1) / 2, R = Math.max(x1 - x0, z1 - z0) * 0.75;
    const views = { from_plus_z: [cx, y1 + 6, cz + R], from_minus_z: [cx, y1 + 6, cz - R], from_plus_x: [cx + R, y1 + 6, cz], from_minus_x: [cx - R, y1 + 6, cz] };
    for (const [n, pos] of Object.entries(views)) save(path.join(dir, n + '.jpg'), await p.evaluate(([a, c]) => window.survey(a, c, 50), [pos, [cx, cy, cz]]));
    console.log(JSON.stringify(info));
  } else {
    const want = list.split(',').flatMap((s) => { const [a, e, st] = s.split(':').map(Number); if (e === undefined) return [a]; const o = []; for (let i = a; i <= e; i += st || 1) o.push(i); return o; });
    const dir = path.join(job, 'frames'); fs.mkdirSync(dir, { recursive: true }); const t0 = Date.now();
    for (const i of want) { const fn = path.join(dir, 'f' + String(i).padStart(5, '0') + '.jpg'); if (fs.existsSync(fn)) continue; save(fn, await p.evaluate((i) => window.frame(i), i)); }
    console.log(`rendered ${want.length} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  await b.close();
})();
