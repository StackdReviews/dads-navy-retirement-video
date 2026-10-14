#!/usr/bin/env node
/*
 * Builds the retirement tribute video from manifest.json.
 *
 *   node build.js            full build (skips clips already rendered from unchanged sources)
 *   node build.js --force    re-render everything
 *
 * Outputs
 *   build/master.mp4         full 1080p video
 *   ../Dad Retirement Video - FULL.mp4   copy of the master next to the source media
 *   docs/hls/*               720p streaming version used by the web page
 *   docs/chapters.json       chapter timestamps for the web page
 *   docs/poster.jpg          poster frame
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const FF = require('ffmpeg-static');
const FP = require('@ffprobe-installer/ffprobe').path;

const ROOT = __dirname;
const M = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const MEDIA = path.resolve(ROOT, M.mediaDir);
const PHOTOS = path.join(MEDIA, M.photosDir);
const BUILD = path.join(ROOT, 'build');
const TMP = path.join(BUILD, 'tmp');
const CLIPS = path.join(BUILD, 'clips');
const DOCS = path.join(ROOT, 'docs');
const HLS = path.join(DOCS, 'hls');
for (const d of [TMP, CLIPS, HLS]) fs.mkdirSync(d, { recursive: true });

const FORCE = process.argv.includes('--force');
const W = 1920, H = 1080, FPS = 30;
const XF = 1.0;                 // crossfade between photos (s)
const CARD_SEC = 4.5;           // chapter card length (s)
const NAVY = '0x0a1a33';
const GOLD = '0xc9a227';
const FONTS = 'C:/Windows/Fonts';
const CPU = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));

process.env.FONTCONFIG_FILE = process.env.FONTCONFIG_FILE || 'NUL';

// ---------- helpers ----------
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function run(bin, args, quiet = true) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('close', code => {
      if (code === 0) return resolve(out);
      const tail = err.split('\n').filter(l => !/Fontconfig/.test(l)).slice(-25).join('\n');
      reject(new Error(`${path.basename(bin)} exited ${code}\nargs: ${args.join(' ')}\n${tail}`));
    });
  });
}
const ffmpeg = args => run(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

async function probeDuration(file) {
  const out = await run(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(out.trim());
}

// Escape a path for use inside a filtergraph option value.
// Quoted at the graph level; ':' and the apostrophe escaped for the option level (shell-style '\'' trick).
const fpath = p => "'" + p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'\\''") + "'";

function textFile(name, text) {
  const f = path.join(TMP, `${name}.txt`);
  fs.writeFileSync(f, text, 'utf8');
  return f;
}

let tcount = 0;
function drawLine(line, idx) {
  const color = line.color === 'gold' ? GOLD : line.color === 'white' ? 'white' : line.color;
  const tf = textFile(`t${tcount++}_${idx}`, line.text);
  return `drawtext=fontfile=${fpath(FONTS + '/' + line.font)}:textfile=${fpath(tf)}:fontsize=${line.size}:fontcolor=${color}:x=(w-tw)/2:y=${line.y}`;
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const k = i++;
      results[k] = await fn(items[k], k);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

function upToDate(out, ...srcs) {
  if (FORCE || !fs.existsSync(out)) return false;
  const o = fs.statSync(out).mtimeMs;
  return srcs.every(s => fs.statSync(s).mtimeMs < o) && fs.statSync(path.join(ROOT, 'manifest.json')).mtimeMs < o;
}

const VENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-level', '4.1',
  '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', '60', '-x264-params', 'keyint=60:min-keyint=60:scenecut=0'];
const AENC = ['-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k'];

// ---------- cards ----------
// Renders a still card PNG: navy background, thin gold frame, centered lines, optional seal image.
async function renderCard(name, lines, seal) {
  const out = path.join(TMP, `card_${name}.png`);
  const inputs = ['-f', 'lavfi', '-i', `color=c=${NAVY}:s=${W}x${H}:d=1`];
  let chain = `[0:v]drawbox=x=100:y=80:w=${W - 200}:h=${H - 160}:color=${GOLD}@0.9:t=3`;
  for (const [i, l] of lines.entries()) chain += ',' + drawLine(l, i);
  let filter;
  if (seal) {
    inputs.push('-i', seal);
    // round seal: scale to 240px and keep only the inscribed circle so the JPEG's white corners vanish
    filter = `${chain}[bg];[1:v]scale=240:240,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*lt((X-119.5)*(X-119.5)+(Y-119.5)*(Y-119.5),117*117)'[s];[bg][s]overlay=(W-w)/2:${lines[0].y - 290}`;
  } else {
    filter = chain;
  }
  await ffmpeg([...inputs, '-filter_complex', filter, '-frames:v', '1', out]);
  return out;
}

// Card -> silent video clip (used inside the slideshow, no audio needed) or with silent audio track.
async function cardClip(name, png, seconds, withAudio) {
  const out = path.join(CLIPS, `card_${name}.mp4`);
  const args = ['-loop', '1', '-framerate', String(FPS), '-t', String(seconds), '-i', png];
  if (withAudio) args.push('-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=48000:cl=stereo');
  const vf = withAudio
    ? `fade=t=in:st=0:d=0.6,fade=t=out:st=${seconds - 0.6}:d=0.6,format=yuv420p`
    : 'format=yuv420p';
  args.push('-vf', vf, ...VENC);
  if (withAudio) args.push(...AENC, '-shortest');
  await ffmpeg([...args, out]);
  return { file: out, seconds };
}

// ---------- photos ----------
const KB_STYLES = ['in', 'out', 'panR', 'in', 'panL', 'out'];
async function photoClip(entry, idx, seconds) {
  const file = typeof entry === 'string' ? entry : entry.file;
  const rotate = typeof entry === 'string' ? null : entry.rotate;
  const src = path.join(PHOTOS, file);
  const out = path.join(CLIPS, `photo_${String(idx).padStart(3, '0')}.mp4`);
  if (upToDate(out, src)) return { file: out, seconds };
  const comp = path.join(TMP, `comp_${idx}.png`);
  const rot = rotate === 'cw' ? 'transpose=1,' : rotate === 'ccw' ? 'transpose=2,' : rotate === '180' ? 'transpose=1,transpose=1,' : '';
  const CW = 2304, CH = 1296; // 1.2x canvas so the zoom never goes below native 1080p
  const compose =
    `[0:v]${rot}split=2[a][b];` +
    `[a]scale=${CW}:${CH}:force_original_aspect_ratio=increase,crop=${CW}:${CH},scale=230:130,gblur=sigma=6,scale=${CW}:${CH},eq=brightness=-0.18[bg];` +
    `[b]scale=${CW}:${CH}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  await ffmpeg(['-i', src, '-filter_complex', compose, '-frames:v', '1', comp]);

  const D = Math.round(seconds * FPS);
  const style = KB_STYLES[idx % KB_STYLES.length];
  const z = { in: `1+0.10*on/${D}`, out: `1.10-0.10*on/${D}`, panR: '1.08', panL: '1.08' }[style];
  const x = style === 'panR' ? `(iw-iw/zoom)*on/${D}` : style === 'panL' ? `(iw-iw/zoom)*(1-on/${D})` : 'iw/2-(iw/zoom/2)';
  const y = 'ih/2-(ih/zoom/2)';
  const vf = `zoompan=z='${z}':x='${x}':y='${y}':d=${D}:s=${W}x${H}:fps=${FPS},format=yuv420p`;
  await ffmpeg(['-i', comp, '-filter_complex', vf, '-frames:v', String(D), ...VENC, out]);
  return { file: out, seconds };
}

// ---------- slideshow (photos + cards, crossfaded, with music bed) ----------
async function buildSlideshow(items, musicFiles, musicTrims) {
  const out = path.join(CLIPS, 'slideshow.mp4');
  const n = items.length;
  const args = [];
  for (const it of items) args.push('-i', it.file);
  for (const m of musicFiles) args.push('-i', m);

  // video crossfade chain
  let f = '';
  let acc = items[0].seconds;
  let prev = '[0:v]';
  for (let k = 1; k < n; k++) {
    const offset = (acc - XF).toFixed(3);
    const lbl = k === n - 1 ? '[vx]' : `[v${k}]`;
    f += `${prev}[${k}:v]xfade=transition=fade:duration=${XF}:offset=${offset}${lbl};`;
    prev = lbl;
    acc = acc + items[k].seconds - XF;
  }
  const LEN = acc;
  f += `${prev}fade=t=in:st=0:d=1,fade=t=out:st=${(LEN - 1.2).toFixed(3)}:d=1.2,format=yuv420p[vout];`;

  // music bed: normalise each track, crossfade them, trim to slideshow length, fade out
  const mi = musicFiles.map((_, i) => n + i);
  for (const [i, idx] of mi.entries()) {
    const t = musicTrims[i] || {};
    const trim = (t.start != null || t.end != null)
      ? `atrim=${t.start != null ? 'start=' + t.start : ''}${t.start != null && t.end != null ? ':' : ''}${t.end != null ? 'end=' + t.end : ''},asetpts=PTS-STARTPTS,`
      : '';
    f += `[${idx}:a]${trim}loudnorm=I=-18:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[m${i}];`;
  }
  let a = '[m0]';
  for (let i = 1; i < mi.length; i++) {
    const lbl = `[mx${i}]`;
    f += `${a}[m${i}]acrossfade=d=3:c1=tri:c2=tri${lbl};`;
    a = lbl;
  }
  f += `${a}atrim=0:${LEN.toFixed(3)},afade=t=in:st=0:d=1.5,afade=t=out:st=${(LEN - 4).toFixed(3)}:d=4[aout]`;

  await ffmpeg([...args, '-filter_complex', f, '-map', '[vout]', '-map', '[aout]', '-t', LEN.toFixed(3), ...VENC, ...AENC, out]);
  return { file: out, seconds: LEN };
}

// ---------- message videos ----------
async function videoClip(dir, v, idx) {
  const src = path.join(MEDIA, dir, v.file);
  const out = path.join(CLIPS, `video_${String(idx).padStart(2, '0')}_${v.file.replace(/[^A-Za-z0-9]+/g, '_')}.mp4`);
  if (upToDate(out, src)) return { file: out, seconds: await probeDuration(out), caption: v.caption };
  const dur = await probeDuration(src);
  const tf = textFile(`cap_${idx}`, v.caption);
  const capEnd = Math.min(7, dur - 0.5);
  const alpha = `if(lt(t,1.6),max(0,(t-0.8))/0.8,if(lt(t,${capEnd - 0.8}),1,max(0,(${capEnd}-t)/0.8)))`;
  const filter =
    `[0:v]split=2[a][b];` +
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=192:108,gblur=sigma=6,scale=${W}:${H},eq=brightness=-0.2[bg];` +
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${FPS},format=yuv420p,` +
    `drawtext=fontfile=${fpath(FONTS + '/georgia.ttf')}:textfile=${fpath(tf)}:fontsize=46:fontcolor=white:box=1:boxcolor=${NAVY}@0.72:boxborderw=16:x=72:y=h-th-82:alpha='${alpha}',` +
    `fade=t=in:st=0:d=0.5,fade=t=out:st=${(dur - 0.5).toFixed(3)}:d=0.5[v];` +
    `[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
    `afade=t=in:st=0:d=0.3,afade=t=out:st=${(dur - 0.5).toFixed(3)}:d=0.5[a]`;
  await ffmpeg(['-i', src, '-filter_complex', filter, '-map', '[v]', '-map', '[a]', ...VENC, ...AENC, '-shortest', out]);
  return { file: out, seconds: await probeDuration(out), caption: v.caption };
}

// ---------- closing ----------
async function buildClosing() {
  const parts = [];
  for (const [i, c] of M.closing.entries()) {
    const png = await renderCard(`closing${i}`, c.lines);
    parts.push({ png, seconds: c.seconds });
  }
  const out = path.join(CLIPS, 'closing.mp4');
  const args = [];
  for (const p of parts) args.push('-loop', '1', '-framerate', String(FPS), '-t', String(p.seconds), '-i', p.png);
  args.push('-i', path.join(ROOT, M.closingMusic));
  let f = '';
  let acc = parts[0].seconds;
  let prev = '[0:v]';
  for (let k = 1; k < parts.length; k++) {
    const lbl = `[c${k}]`;
    f += `${prev}[${k}:v]xfade=transition=fade:duration=1.5:offset=${(acc - 1.5).toFixed(3)}${lbl};`;
    prev = lbl;
    acc += parts[k].seconds - 1.5;
  }
  const LEN = acc;
  f += `${prev}fade=t=in:st=0:d=1,fade=t=out:st=${(LEN - 2.5).toFixed(3)}:d=2.5,format=yuv420p[vout];`;
  f += `[${parts.length}:a]loudnorm=I=-18:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${LEN.toFixed(3)},afade=t=in:st=0:d=1,afade=t=out:st=${(LEN - 4).toFixed(3)}:d=4[aout]`;
  await ffmpeg([...args, '-filter_complex', f, '-map', '[vout]', '-map', '[aout]', '-t', LEN.toFixed(3), ...VENC, ...AENC, out]);
  return { file: out, seconds: LEN };
}

// ---------- main ----------
(async () => {
  const t0 = Date.now();

  // 1. music length decides how long each photo is on screen
  // slideshowMusic entries are either "path" or { file, start, end } (start/end in seconds, trims the track)
  const music = M.slideshowMusic.map(m => (typeof m === 'string' ? { file: m } : m));
  let musicLen = 0;
  for (const m of music) {
    const full = await probeDuration(path.join(ROOT, m.file));
    musicLen += Math.min(m.end != null ? m.end : full, full) - (m.start || 0);
  }
  musicLen -= 3 * (music.length - 1);
  const nPhotos = M.photoSections.reduce((s, sec) => s + sec.photos.length, 0);
  const nCards = 1 + M.photoSections.length;
  const fixed = M.title.seconds + M.photoSections.length * CARD_SEC;
  const xfTotal = (nPhotos + nCards - 1) * XF;
  let photoSec = (musicLen + xfTotal - fixed) / nPhotos;
  photoSec = Math.max(4.5, Math.min(6.5, photoSec));
  log(`music bed ${musicLen.toFixed(1)}s, ${nPhotos} photos -> ${photoSec.toFixed(2)}s each`);

  // 2. title + chapter cards
  const titleLines = [
    { text: M.title.kicker, font: 'georgiai.ttf', size: 46, color: 'gold', y: 300 },
    { text: M.title.name, font: 'georgiab.ttf', size: 120, color: 'white', y: 380 },
    { text: M.title.line1, font: 'georgia.ttf', size: 48, color: 'white', y: 560 },
    { text: M.title.line2, font: 'georgia.ttf', size: 54, color: 'gold', y: 660 },
  ];
  const titlePng = await renderCard('title', titleLines);
  await ffmpeg(['-i', titlePng, '-vf', 'scale=1280:720', '-q:v', '3', path.join(DOCS, 'poster.jpg')]);
  const slideItems = [await cardClip('title', titlePng, M.title.seconds, false)];

  const photoJobs = [];
  let pIdx = 0;
  const sectionCards = [];
  for (const [si, sec] of M.photoSections.entries()) {
    const lines = [
      { text: sec.title, font: 'georgiab.ttf', size: 84, color: 'white', y: sec.seal ? 560 : 440 },
      { text: sec.subtitle, font: 'georgiai.ttf', size: 42, color: 'gold', y: sec.seal ? 680 : 560 },
    ];
    const png = await renderCard(`sec${si}`, lines, sec.seal ? path.join(PHOTOS, sec.seal) : null);
    sectionCards.push(await cardClip(`sec${si}`, png, CARD_SEC, false));
    for (const p of sec.photos) photoJobs.push({ entry: p, idx: pIdx++ });
  }
  log(`rendering ${photoJobs.length} photo clips on ${CPU} workers`);
  const photoClips = await pool(photoJobs, CPU, j => photoClip(j.entry, j.idx, photoSec));

  // assemble slideshow order: title, [card, photos...] per section
  let cursor = 0;
  for (const [si, sec] of M.photoSections.entries()) {
    slideItems.push(sectionCards[si]);
    for (let i = 0; i < sec.photos.length; i++) slideItems.push(photoClips[cursor++]);
  }
  log('building slideshow with music');
  const slideshow = await buildSlideshow(slideItems, music.map(m => path.join(ROOT, m.file)), music);
  log(`slideshow ${slideshow.seconds.toFixed(1)}s`);

  // 3. message videos
  const segments = [slideshow];
  const chapters = [{ title: 'Photos: A Lifetime of Service', start: 0 }];
  let vIdx = 0;
  for (const [si, sec] of M.videoSections.entries()) {
    const lines = [{ text: sec.title, font: 'georgiab.ttf', size: 80, color: 'white', y: 470 }];
    if (sec.subtitle) lines.push({ text: sec.subtitle, font: 'georgiai.ttf', size: 42, color: 'gold', y: 590 });
    const png = await renderCard(`vsec${si}`, lines);
    const card = await cardClip(`vsec${si}`, png, CARD_SEC, true);
    log(`rendering ${sec.videos.length} videos: ${sec.title}`);
    const jobs = sec.videos.map(v => ({ v, idx: vIdx++ }));
    const clips = await pool(jobs, Math.max(2, Math.floor(CPU / 2)), j => videoClip(sec.dir, j.v, j.idx));
    segments.push(card, ...clips);
    sec._card = card; sec._clips = clips;
  }
  log('building closing');
  const closing = await buildClosing();
  segments.push(closing);

  // 4. concat everything
  const listFile = path.join(TMP, 'concat.txt');
  fs.writeFileSync(listFile, segments.map(s => `file '${s.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const master = path.join(BUILD, 'master.mp4');
  log('concatenating master');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', master]);
  const masterLen = await probeDuration(master);

  // chapter timestamps
  let t = slideshow.seconds;
  for (const sec of M.videoSections) {
    chapters.push({ title: sec.title, start: t, people: [] });
    t += sec._card.seconds;
    for (const c of sec._clips) { chapters[chapters.length - 1].people.push({ name: c.caption, start: t }); t += c.seconds; }
  }
  chapters.push({ title: 'Thank You for Your Service', start: t });
  fs.writeFileSync(path.join(DOCS, 'chapters.json'), JSON.stringify({ duration: masterLen, honoree: M.honoree, chapters }, null, 2));

  // 5. copy master next to the source media
  const copyTo = path.join(MEDIA, 'Dad Retirement Video - FULL.mp4');
  fs.copyFileSync(master, copyTo);
  log(`master ${(masterLen / 60).toFixed(1)} min -> ${copyTo}`);

  // 6. streaming version for the web page (720p HLS, every segment well under GitHub's file limit)
  log('encoding streaming version');
  for (const f of fs.readdirSync(HLS)) fs.unlinkSync(path.join(HLS, f));
  await ffmpeg(['-i', master, '-vf', 'scale=1280:720', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-maxrate', '2000k', '-bufsize', '4000k', '-profile:v', 'main', '-level', '3.1', '-pix_fmt', 'yuv420p',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(HLS, 'seg_%04d.ts'), path.join(HLS, 'index.m3u8')]);
  let hlsBytes = 0;
  for (const f of fs.readdirSync(HLS)) hlsBytes += fs.statSync(path.join(HLS, f)).size;
  log(`streaming version ${(hlsBytes / 1e6).toFixed(0)} MB in ${fs.readdirSync(HLS).length} files`);
  log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
