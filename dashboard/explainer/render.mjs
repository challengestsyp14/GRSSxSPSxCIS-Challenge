// Renders the explainer to MP4. Frames come from scene.html in headless Chromium, are encoded by
// ffmpeg (libx264) and muxed with the voice track from narrate.py.
//
// Run from dashboard/ after narrate.py:
//   node explainer/render.mjs                 full render to public/media/
//   node explainer/render.mjs --stills 4,30   preview frames to explainer/build/
//   node explainer/render.mjs --slides        the slides of slides.json to public/media/slides/
// Env: FFMPEG (ffmpeg with libx264, default "ffmpeg"), CHROMIUM (browser executable, optional),
//      PLAYWRIGHT (module to import, default "playwright"), WORKERS (default 4), FPS (default 30).

import { spawn } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BUILD = join(HERE, 'build');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const FPS = Number(process.env.FPS ?? 30);
const WORKERS = Number(process.env.WORKERS ?? 4);
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const OUT = resolve(ROOT, opt('--out') ?? 'public/media');
const NAME = 'hiding-in-the-noise';
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function serve() {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const path = join(ROOT, decodeURIComponent(new URL(req.url, 'http://local').pathname));
      if (!path.startsWith(ROOT) || !existsSync(path) || statSync(path).isDirectory()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
      createReadStream(path).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

function ffmpeg(argv) {
  const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...argv], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const done = new Promise((ok, fail) =>
    child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`)))),
  );
  return { child, done };
}

const write = (stream, buf) =>
  new Promise((ok) => (stream.write(buf) ? ok() : stream.once('drain', ok)));

async function openPage(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${base}/explainer/scene.html?render`);
  return { page, info: await page.evaluate(() => window.explainer.ready) };
}

const frame = async (page, t, q = 0.95) =>
  Buffer.from(
    (await page.evaluate(([tt, qq]) => window.explainer.frameJpeg(tt, qq), [t, q])).split(',')[1],
    'base64',
  );

async function main() {
  const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  mkdirSync(BUILD, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  try {
    if (process.argv.includes('--slides')) {
      // The explainer as still slides (explainer/slides.json): no voice, no captions.
      const { page } = await openPage(browser, base);
      const slides = JSON.parse(readFileSync(join(HERE, 'slides.json'), 'utf8'));
      const dir = join(OUT, 'slides');
      mkdirSync(dir, { recursive: true });
      for (const [i, slide] of slides.entries()) {
        const label = `${i + 1} / ${slides.length}`;
        const data = await page.evaluate(
          ([t, l]) => window.explainer.slideJpeg(t, l, 0.9),
          [slide.t, label],
        );
        writeFileSync(
          join(dir, `slide-${String(i + 1).padStart(2, '0')}.jpg`),
          Buffer.from(data.split(',')[1], 'base64'),
        );
      }
      console.log(`${slides.length} slides written to ${dir}`);
      return;
    }

    const stills = opt('--stills');
    if (stills) {
      const { page } = await openPage(browser, base);
      for (const t of stills.split(',').map(Number)) {
        writeFileSync(join(BUILD, `still-${t}.jpg`), await frame(page, t, 0.9));
      }
      console.log(`stills written to ${BUILD}`);
      return;
    }

    const { page: first, info } = await openPage(browser, base);
    const total = Math.ceil(info.duration * FPS);
    writeFileSync(join(OUT, `${NAME}.jpg`), await frame(first, 4.2, 0.86));
    await first.close();

    const per = Math.ceil(total / WORKERS);
    const started = Date.now();
    let doneFrames = 0;
    const segments = [];
    await Promise.all(
      Array.from({ length: WORKERS }, async (_, w) => {
        const from = w * per;
        const to = Math.min(total, from + per);
        if (from >= to) return;
        const file = join(BUILD, `segment-${w}.mp4`);
        segments[w] = file;
        const { page } = await openPage(browser, base);
        const enc = ffmpeg([
          '-y',
          '-f',
          'image2pipe',
          '-framerate',
          String(FPS),
          '-c:v',
          'mjpeg',
          '-i',
          '-',
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'slow',
          '-tune',
          'animation',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-g',
          String(FPS * 2),
          file,
        ]);
        for (let f = from; f < to; f++) {
          await write(enc.child.stdin, await frame(page, f / FPS));
          if (++doneFrames % 300 === 0) {
            const s = (Date.now() - started) / 1000;
            console.log(`${doneFrames}/${total} frames · ${(doneFrames / s).toFixed(1)} fps`);
          }
        }
        enc.child.stdin.end();
        await enc.done;
        await page.close();
      }),
    );

    const list = join(BUILD, 'segments.txt');
    writeFileSync(
      list,
      segments
        .filter(Boolean)
        .map((f) => `file '${f}'`)
        .join('\n') + '\n',
    );
    const mux = ffmpeg([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-i',
      join(BUILD, 'narration.wav'),
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'copy',
      '-af',
      'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-t',
      info.duration.toFixed(3),
      '-movflags',
      '+faststart',
      '-metadata',
      'title=Hiding in the noise',
      join(OUT, `${NAME}.mp4`),
    ]);
    mux.child.stdin.end();
    await mux.done;
    // WebM (VP9 + Opus) for browsers built without H.264, such as some Chromium builds.
    const webm = ffmpeg([
      '-y',
      '-i',
      join(OUT, `${NAME}.mp4`),
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '0',
      '-crf',
      '36',
      '-row-mt',
      '1',
      '-deadline',
      'good',
      '-cpu-used',
      '4',
      '-c:a',
      'libopus',
      '-b:a',
      '64k',
      '-metadata',
      'title=Hiding in the noise',
      join(OUT, `${NAME}.webm`),
    ]);
    webm.child.stdin.end();
    await webm.done;
    for (const f of segments.filter(Boolean)) rmSync(f);
    console.log(`${NAME}.mp4: ${total} frames in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
