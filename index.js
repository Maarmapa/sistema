import RunwayML from '@runwayml/sdk';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import fetch from 'node-fetch';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';
import * as bsale from './bsale.js';

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const runway = new RunwayML({ apiKey: process.env.RUNWAYML_API_SECRET });
// Runway model: env-overridable. Default gen4.5 (flagship, state-of-the-art motion + temporal coherence).
// Fallback gen4_turbo if gen4.5 fails or rate-limited. Set RUNWAY_MODEL env to override.
const RUNWAY_MODEL = process.env.RUNWAY_MODEL || 'gen4.5';
const RUNWAY_MODEL_FAST = 'gen4_turbo'; // explicit fallback for high-volume / fast-turnaround cases

// Per-model duration constraints. New models (gen4.5, veo3.1, veo3, etc.) only
// accept 4/6/8 seconds; older models like gen4_turbo accept 5/10. This helper
// snaps a requested duration to the nearest allowed value for the given model.
function durationForModel(model, requested) {
  const allowed = {
    'gen4.5': [4, 6, 8],
    'veo3.1': [4, 6, 8],
    'veo3.1_fast': [4, 6, 8],
    'veo3': [4, 6, 8],
    'gen4_turbo': [5, 10],
    'gen3a_turbo': [5, 10],
  };
  const arr = allowed[model];
  if (!arr) return requested;
  return arr.reduce((closest, val) =>
    Math.abs(val - requested) < Math.abs(closest - requested) ? val : closest
  );
}
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1244921942';
const RUNWAY_KEY = process.env.RUNWAYML_API_SECRET;
const ALLOWED_CHAT_IDS = new Set(
  (process.env.ALLOWED_CHAT_IDS || TELEGRAM_CHAT_ID)
    .split(',').map(s => Number(s.trim())).filter(Boolean)
);
const PRODUCE_AUTH_TOKEN = process.env.PRODUCE_AUTH_TOKEN;
function requireAuth(req, res) {
  if (!PRODUCE_AUTH_TOKEN || req.headers['x-auth-token'] !== PRODUCE_AUTH_TOKEN) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  return true;
}
function logAccess(message, authorized) {
  const f = message.from || {};
  console.log('[ACCESS] ' + JSON.stringify({
    ts: new Date().toISOString(),
    authorized,
    chat_id: message.chat?.id,
    user_id: f.id,
    username: f.username || null,
    first_name: f.first_name || null,
    last_name: f.last_name || null,
    text: (message.text || message.caption || '').slice(0, 200)
  }));
}

// ── TELEGRAM ──────────────────────────────────────────────────
async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
  });
}

async function sendTelegramVideo(videoUrl, caption) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendVideo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, video: videoUrl, caption, parse_mode: 'HTML' }),
  });
}

async function sendTelegramPhoto(url, caption) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, photo: url, caption, parse_mode: 'HTML' }),
  });
}

// ── BOYKOT CATALOG ────────────────────────────────────────────
function loadCatalog() {
  try {
    const raw = fs.readFileSync('./catalog.json', 'utf8');
    return JSON.parse(raw);
  } catch(e) {
    console.error('Catalog not found:', e.message);
    return [];
  }
}

function getProducts(catalog, mode = 'top', limit = 3) {
  let products = catalog.filter(p => p.name && p.name.trim() !== '');
  if (mode === 'liquidacion') {
    products = products.filter(p => p.variants?.some(v => v.stock > 0 && v.stock <= 5));
  } else if (mode === 'marcas') {
    const brands = {};
    products.forEach(p => {
      const brand = p.variants?.[0]?.description?.split(' ')[0] || 'Boykot';
      if (!brands[brand]) brands[brand] = [];
      brands[brand].push(p);
    });
    return Object.entries(brands)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3)
      .flatMap(([, prods]) => prods.slice(0, 1));
  }
  return products.sort(() => Math.random() - 0.5).slice(0, limit);
}

// ── VIDEO GENERATION ──────────────────────────────────────────
async function generateScene(scene) {
  console.log(`🎬 ${scene.title}`);
  const task = await runway.imageToVideo.create({
    model: RUNWAY_MODEL,
    promptImage: scene.promptImage || 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=1280&q=80',
    promptText: scene.visual_prompt,
    duration: durationForModel(RUNWAY_MODEL, 5),
    ratio: '720:1280', // reel 9:16
  });
  let result = task;
  while (result.status !== 'SUCCEEDED' && result.status !== 'FAILED') {
    await new Promise(r => setTimeout(r, 3000));
    result = await runway.tasks.retrieve(task.id);
    console.log(`  ${result.status}`);
  }
  if (result.status === 'FAILED') throw new Error(`Failed: ${scene.title}`);
  return result.output[0];
}

// ── BOYKOT URL — Gen-4 Image + Gen-4.5 Video ─────────────────
async function runBoykotUrl(productUrl) {
  try {
    await sendTelegram(`🛍️ Scrapeando producto...`);
    const res = await fetch(productUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();

    const imgMatch = html.match(/https:\/\/www\.boykot\.cl\/wp-content\/uploads\/[^\s"']+\.(jpg|jpeg|png|webp)/);
    if (!imgMatch) { await sendTelegram('❌ No se encontró imagen'); return; }
    const imgUrl = imgMatch[0].replace(/-\d+x\d+\./, '.');

    const nameMatch = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([^<]+)<\/h1>/);
    const productName = nameMatch?.[1]?.trim() || 'Producto Boykot';

    const priceMatch = html.match(/\$[\d\.,]+/);
    const price = priceMatch?.[0] || '';

    await sendTelegram(`📦 <b>${productName}</b>\n${price}\n🎨 Generando render editorial...`);
    await sendTelegramPhoto(imgUrl, `📸 Original: ${productName}`);

    // Gen-4 Image — render editorial (vertical 9:16 reel format)
    const imageTask = await runway.textToImage.create({
      model: 'gen4_image',
      promptText: `Professional editorial product render, black background #000000, acid yellow #CCFF00 dramatic rim lighting, ultra minimal studio, high contrast, same product exact shape and colors, photorealistic, no people, no text`,
      referenceImages: [{ uri: imgUrl, weight: 0.85 }],
      ratio: '1080:1920',
    }).waitForTaskOutput();

    const renderUrl = imageTask.output[0];
    await sendTelegramPhoto(renderUrl, `🎨 Render: ${productName}`);
    await sendTelegram(`🎬 Animando con Gen-4.5...`);

    // Gen-4.5 — video (vertical 9:16 reel format)
    const videoTask = await runway.imageToVideo.create({
      model: RUNWAY_MODEL,
      promptImage: renderUrl,
      promptText: `Slow cinematic product reveal, ${productName}, dramatic lighting sweeps across surface, elegant rotation, black background, yellow light accent`,
      duration: durationForModel(RUNWAY_MODEL, 5),
      ratio: '720:1280',
    }).waitForTaskOutput();

    const caption = `🎬 <b>${productName}</b>\n${price ? '💰 ' + price + '\n' : ''}\nboykot.cl 🎨\n#boykot #artesupplies #chile`;
    await sendTelegramVideo(videoTask.output[0], caption);

  } catch(e) {
    await sendTelegram(`❌ Error: ${e.message}`);
  }
}

// ── BOYKOT FACTORY ────────────────────────────────────────────
async function runBoykotFactory(mode = 'top', limit = 3) {
  console.log(`\n🛍️ BOYKOT FACTORY — mode: ${mode}`);
  await sendTelegram(`🛍️ <b>Boykot Factory</b>\nModo: ${mode} · ${limit} productos`);

  const catalog = loadCatalog();
  if (!catalog.length) { await sendTelegram('❌ Catálogo no disponible'); return; }

  const products = getProducts(catalog, mode, limit);
  if (!products.length) { await sendTelegram('❌ No hay productos para este modo'); return; }

  await sendTelegram(`📦 Productos:\n${products.map(p => `• ${p.name}`).join('\n')}`);

  for (const product of products) {
    await sendTelegram(`⏳ Generando: <b>${product.name}</b>...`);
    try {
      const vidPrompt = `Slow cinematic product reveal, ${product.name} art supply rotates gently, dramatic studio lighting, black background, yellow #CCFF00 light accent`;
      const videoUrl = await generateScene({ title: product.name, visual_prompt: vidPrompt });
      const caption = `🎬 <b>${product.name}</b>\n${product.category ? '📁 ' + product.category : ''}\n\nboykot.cl 🎨\n#boykot #artesupplies #chile${mode === 'liquidacion' ? '\n🔥 ÚLTIMAS UNIDADES' : ''}`;
      await sendTelegramVideo(videoUrl, caption);
      await new Promise(r => setTimeout(r, 5000));
    } catch(e) {
      await sendTelegram(`❌ Error en ${product.name}: ${e.message}`);
    }
  }
  await sendTelegram(`✅ <b>Boykot Factory listo</b> — ${products.length} productos`);
}

// ── MINI DOCU ─────────────────────────────────────────────────
function getScreenplay(theme) {
  return [
    {
      title: "El Color Emerge",
      visual_prompt: `Extreme slow motion macro: ${theme || 'vivid magenta'} watercolor drop exploding on black background, fractal pigment patterns, 4K cinematic`,
      caption: "El color tiene vida propia. 🎨 #acuarela #boykot #arte"
    },
    {
      title: "La Textura del Arte",
      visual_prompt: "Close up of watercolor paper texture, brush strokes in slow motion, golden light catching paper grain, cinematic macro",
      caption: "La textura importa. #fabriano #acuarela #boykot"
    },
    {
      title: "Pincel y Destino",
      visual_prompt: `Artist brush tip loading with ${theme || 'vibrant red'} paint, droplets in slow motion, dark moody background, cinematic`,
      caption: "Cada trazo es una decisión. 🖌️ #pincel #arte #boykot"
    }
  ];
}

async function produce(theme = null) {
  const date = new Date().toISOString().split('T')[0];
  console.log(`\n🎥 SISTEMA — ${date} | ${theme || 'default'}`);
  try {
    await sendTelegram(`🎬 <b>SISTEMA produciendo</b>\n📅 ${date}${theme ? `\n🎨 Tema: ${theme}` : ''}`);
    const screenplay = getScreenplay(theme);
    const scenes = [];
    for (const scene of screenplay) {
      await sendTelegram(`⏳ <b>${scene.title}</b>...`);
      try {
        const videoUrl = await generateScene(scene);
        scenes.push({ ...scene, videoUrl });
        await sendTelegramVideo(videoUrl, `🎬 <b>${scene.title}</b>\n${scene.caption}\n\n<i>SISTEMA · maarmapa.eth</i>`);
      } catch (err) {
        await sendTelegram(`❌ Error: ${err.message}`);
      }
    }
    const dir = './films';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const filename = `${date}${theme ? '-'+theme.slice(0,20).replace(/\s+/g,'-') : ''}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify({ date, theme, scenes }, null, 2));
    await sendTelegram(`✅ <b>${scenes.length} videos listos</b>`);
  } catch (err) {
    console.error('❌', err);
    await sendTelegram(`❌ Error: ${err.message}`);
  }
}

// ── TELEGRAM BOT ──────────────────────────────────────────────
let lastUpdateId = 0;
async function pollTelegram() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
    const data = await res.json();
    for (const update of data.result || []) {
      lastUpdateId = update.update_id;
      if (!update.message) continue;
      const authorized = ALLOWED_CHAT_IDS.has(update.message.chat?.id);
      logAccess(update.message, authorized);
      if (!authorized) continue; // silent drop — no confirmamos existencia del bot
      const msg = update.message.text;
      if (!msg) continue;
      console.log(`📱 ${msg}`);

      if (msg === '/start' || msg === '/help') {
        await sendTelegram(
`🎥 <b>SISTEMA</b> — Director autónomo + Fábrica Boykot

<b>🛍️ Bsale Factory</b> ⭐ NEW
/bsale — HOT 🔥 / COLD ❄️ / STAR ⭐ con datos reales de venta + imagen real de boykot.cl + reel 9:16

<b>🎬 Mini Docu</b>
/produce — Film del día (3 escenas)
/tema [tema] — Video temático custom
/films — Lista de films producidos

<b>🛍️ Boykot Factory</b>
/url [url] — Video de producto boykot.cl específico
/docu-boykot [marca] — Mini film de marca
/marca [marca] [N] — Photoshoot masivo (angelus/copic/molotow/holbein)
/boykot-top — Top productos en stock (catálogo)
/boykot-liquidacion — Últimas unidades (catálogo)
/boykot-marcas — Por marcas top (catálogo)
/copic-award — Copic Award 2026

<b>⏰ Crons automáticos (hora Chile)</b>
23:00 — /produce diario (mini docu)
06:00 — /bsale (HOT/COLD/STAR)
12:00 — /boykot-liquidacion
12:42 — /bsale test run extra

<i>Powered by Runway Gen-4.5 · Claude Haiku · Bsale · maarmapa.eth</i>`);
      } else if (msg === '/produce') {
        await sendTelegram('🎬 Produciendo...');
        produce();
      } else if (msg.startsWith('/tema ')) {
        const theme = msg.replace('/tema ', '').trim();
        await sendTelegram(`🎨 Tema: <b>${theme}</b>`);
        produce(theme);
      } else if (msg === '/films') {
        const dir = './films';
        const films = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        await sendTelegram(films.length ? `🎬 Films:\n${films.map(f=>`• ${f.replace('.json','')}`).join('\n')}` : 'No hay films. Usa /produce');
      } else if (msg.startsWith('/url ')) {
        const url = msg.replace('/url ', '').trim();
        await sendTelegram('🛍️ Procesando producto...');
        runBoykotUrl(url);
      } else if (msg.startsWith('/docu-boykot')) {
        const brand = msg.replace('/docu-boykot', '').trim() || 'default';
        await sendTelegram('🎬 Iniciando Docu Boykot: ' + brand + '...');
        runDocuBoykot(brand);
      } else if (msg.startsWith('/marca ')) {
        const parts = msg.replace('/marca ', '').trim().split(' ');
        const brand = parts[0] || 'angelus';
        const limit = parseInt(parts[1]) || 5;
        await sendTelegram('🏷️ Generando photoshoot de ' + brand + '...');
        runMarcaFactory(brand, limit);
      } else if (msg === '/copic-award') {
        await sendTelegram('🏆 Generando Copic Award 2026...');
        runCopicAward();
      } else if (msg === '/bsale') {
        await sendTelegram('🛍️ BSALE factory manual run...');
        runBsaleFactory();
      } else if (msg === '/boykot-top') {
        await sendTelegram('🛍️ Generando top productos Boykot...');
        runBoykotFactory('top', 3);
      } else if (msg === '/boykot-liquidacion') {
        await sendTelegram('🔥 Generando liquidación Boykot...');
        runBoykotFactory('liquidacion', 3);
      } else if (msg === '/boykot-marcas') {
        await sendTelegram('🎨 Generando por marcas Boykot...');
        runBoykotFactory('marcas', 3);
      }
    }
  } catch (err) {
    // Redact bot token from URL embedded in node-fetch error messages
    const raw = err.message || err.code || err.toString() || 'unknown';
    const safe = raw.replace(/bot\d+:[\w-]+/g, 'bot<REDACTED>');
    console.error('Telegram error:', safe);
  }
}

// ── IMAGE PADDING — letterbox to 9:16 so wide products aren't cropped ────
// Uses wsrv.nl (Cloudflare-backed free image transform service) to wrap any
// source image inside a 720x1280 black canvas with fit=contain (no crop).
// Read image dimensions by properly walking JPEG/PNG/WebP segments.
// Previous naive scan found false-positive SOF markers in compressed data
// (e.g., reported 17032x21007 for a normal product image). This version
// parses each segment using length fields — only the REAL SOF is found.
async function getImageDimensions(url) {
  try {
    const res = await fetch(url, {
      headers: { 'Range': 'bytes=0-262143', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok && res.status !== 206) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const MAX_REASONABLE = 20000;

    // PNG: signature 89 50 4E 47, dims at fixed offsets
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (width > 0 && height > 0 && width < MAX_REASONABLE && height < MAX_REASONABLE) {
        return { width, height, aspect: width / height };
      }
    }

    // WebP: 'RIFF....WEBP' then VP8/VP8L/VP8X chunks
    if (buf.length > 30 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
      const chunk = buf.slice(12, 16).toString();
      if (chunk === 'VP8 ') {
        const width = buf.readUInt16LE(26) & 0x3FFF;
        const height = buf.readUInt16LE(28) & 0x3FFF;
        if (width > 0 && height > 0) return { width, height, aspect: width / height };
      } else if (chunk === 'VP8X') {
        const width = 1 + buf.readUIntLE(24, 3);
        const height = 1 + buf.readUIntLE(27, 3);
        if (width > 0 && height > 0) return { width, height, aspect: width / height };
      }
    }

    // JPEG: SOI is FFD8. Walk segments properly (not naive byte scan).
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xFF) return null;
      const marker = buf[i + 1];
      if (marker === 0xFF) { i++; continue; }
      if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
        i += 2;
        continue;
      }
      const isSOF =
        (marker >= 0xC0 && marker <= 0xC3) ||
        (marker >= 0xC5 && marker <= 0xC7) ||
        (marker >= 0xC9 && marker <= 0xCB) ||
        (marker >= 0xCD && marker <= 0xCF);
      if (isSOF) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        if (width > 0 && height > 0 && width < MAX_REASONABLE && height < MAX_REASONABLE) {
          return { width, height, aspect: width / height };
        }
        return null;
      }
      const segLen = buf.readUInt16BE(i + 2);
      if (segLen < 2) return null;
      i += 2 + segLen;
    }
    return null;
  } catch (err) {
    console.error('[dims] err:', err.message);
    return null;
  }
}

// Prepare a source image for 9:16 reel generation.
// - Square / vertical product (aspect <= 1.3): pass raw — preserves motion best.
// - Wide product (aspect > 1.3): pillarbox via wsrv.nl to 9:16 so the product
//   isn't laterally cropped. We sacrifice some motion freedom for fidelity.
async function prepareSourceForReel(imageUrl, status = '') {
  const tag = status ? `[reel-prep ${status}]` : '[reel-prep]';
  const dims = await getImageDimensions(imageUrl);
  if (!dims) {
    console.log(`${tag} could not read dims for ${imageUrl.slice(0, 80)}, using raw`);
    return imageUrl;
  }
  console.log(`${tag} source ${dims.width}x${dims.height} aspect=${dims.aspect.toFixed(2)}`);
  if (dims.aspect > 1.3) {
    const padded = `https://wsrv.nl/?url=${encodeURIComponent(imageUrl)}&w=720&h=1280&fit=contain&cbg=000000&output=jpg`;
    console.log(`${tag} WIDE product (aspect ${dims.aspect.toFixed(2)}:1) — pillarbox to 9:16`);
    return padded;
  }
  return imageUrl;
}

// Upscale a source image via Runway Magnific before feeding it to video gen.
// Higher resolution input = better small-text preservation in gen4.5/veo3.1.
// Returns the upscaled URL or null on failure (caller should fall back to raw).
async function upscaleImage(imageUrl, status = '') {
  const tag = status ? `[upscale ${status}]` : '[upscale]';
  try {
    console.log(`${tag} starting magnific on ${imageUrl.slice(0, 80)}...`);
    // Try multiple body shapes — Runway docs don't expose image_upscale schema explicitly
    const bodyShapes = [
      { model: 'magnific_precision_upscaler_v2', imageUri: imageUrl },
      { model: 'magnific_precision_upscaler_v2', inputImage: imageUrl },
      { model: 'magnific_precision_upscaler_v2', image: imageUrl },
      { model: 'magnific_precision_upscaler_v2', promptImage: imageUrl },
    ];
    let startData = null;
    let startStatus = 0;
    for (const body of bodyShapes) {
      const fieldName = Object.keys(body).find(k => k !== 'model');
      const startRes = await fetch('https://api.dev.runwayml.com/v1/image_upscale', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + RUNWAY_KEY,
          'X-Runway-Version': '2024-11-06',
        },
        body: JSON.stringify(body),
      });
      startStatus = startRes.status;
      startData = await startRes.json();
      if (startData?.id) {
        console.log(`${tag} ✅ body shape "${fieldName}" accepted, task id=${startData.id}`);
        break;
      }
      console.log(`${tag} body shape "${fieldName}" rejected (${startStatus}): ${JSON.stringify(startData).slice(0, 250)}`);
    }
    if (!startData?.id) {
      console.error(`${tag} all body shapes failed — Magnific not usable for now`);
      return null;
    }
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const t = await (await fetch(`https://api.dev.runwayml.com/v1/tasks/${startData.id}`, {
        headers: { 'Authorization': 'Bearer ' + RUNWAY_KEY, 'X-Runway-Version': '2024-11-06' },
      })).json();
      if (t.status === 'SUCCEEDED') {
        console.log(`${tag} SUCCEEDED → ${(t.output?.[0] || '').slice(0, 80)}`);
        return t.output?.[0] || null;
      }
      if (t.status === 'FAILED') {
        console.error(`${tag} FAILED: ${JSON.stringify(t.failure || t).slice(0, 250)}`);
        return null;
      }
    }
    console.error(`${tag} timed out`);
    return null;
  } catch (err) {
    console.error(`${tag} exception:`, err.message);
    return null;
  }
}

function letterbox9x16(sourceUrl, bg = '000000') {
  if (!sourceUrl) return sourceUrl;
  return `https://wsrv.nl/?url=${encodeURIComponent(sourceUrl)}&w=720&h=1280&fit=contain&cbg=${bg}&we&output=jpg`;
}

// ── MOTION PROMPT POOL — varied per-status animations to avoid repetition ────
// Motion prompts — designed for text preservation. KEY PRINCIPLE: the product
// stays static and crisp; motion lives in the camera/lighting/atmosphere AROUND it.
// This avoids text drift, which is the main failure mode of AI video diffusion
// models (small letterforms like "B95", brand names get mangled when camera
// pushes into the product or zooms onto text-bearing surfaces).
// Motion prompts — BLAST = moving specular highlight on product surface.
// KEY PRINCIPLES (ranked by importance):
// 1. Product LOCKED STATIONARY (no rotation, no orbit).
// 2. Camera fixed at frontal angle.
// 3. THE BLAST: a bright moving specular HIGHLIGHT travels across the
//    product surface — like a reflection of neon light passing over
//    glossy packaging. This is the visible motion on the product.
// 4. Product TRUE COLORS preserved underneath the highlight — the
//    packaging white/brand colors stay (NOT a tint, NOT a color wash).
// 5. The yellow accent is in the LIGHT SOURCE in the background, which
//    creates the moving highlight on the product. Product is not colored
//    yellow — only the moving reflection is bright.
const MOTION_PROMPTS = {
  HOT: [
    'Product locked stationary at center with packaging colors preserved (white box stays white, branding readable), camera fixed frontal no rotation, a bright moving SPECULAR HIGHLIGHT travels rapidly across the product front surface from left to right (like a reflection of neon light passing over glossy packaging), acid yellow #CCFF00 neon light source visible in the background creating the highlight, atmospheric yellow particles drift, the highlight sweep IS the blast — product colors underneath remain true',
    'Static product with original colors intact, camera fixed frontal no rotation, bright moving highlight band sweeps diagonally across the product surface (specular reflection moving), acid yellow neon visible in background as light source, atmospheric haze glows yellow in distance, product underneath highlight stays in true white packaging color',
    'Product centered with package colors untouched, camera locked frontal no rotation, two bright specular highlights pulse and travel across the product front (rapid light reflections like passing under street neon), yellow neon environment in background, foreground product preserves all original colors beneath the moving highlights',
    'Product sharp in center frame, camera fixed frontal no rotation, dramatic bright HIGHLIGHT SWEEP travels from bottom-left to top-right across the product surface revealing texture details (like a reflection passing over the box), yellow neon source in background, packaging colors preserved underneath',
    'Stationary product in true original colors, camera locked frontal no rotation, bright moving highlight band races horizontally across the product front (specular reflection blast), yellow neon ATMOSPHERE pulses in background creating the highlight, product underneath stays in original packaging colors'
  ],
  COLD: [
    'Product still and crisp with original colors preserved, camera fixed frontal no rotation, a gentle warm highlight slowly travels across the product surface left-to-right (soft specular reflection passing over packaging), warm ambient light source visible in background, dust motes drift gently, product underneath remains in true original colors',
    'Static product with true colors untouched, camera locked frontal no rotation, soft golden highlight slowly sweeps across the product front surface (specular reflection like sunset light passing over packaging), warm glow in background, product underneath the moving highlight preserves package colors',
    'Product unmoving in center with original colors, camera fixed frontal no rotation, slow soft highlight band drifts across the product face (a reveal sweep, like passing under a soft lamp), atmospheric haze in background, product colors stay true beneath the moving highlight',
    'Product crisp centered with packaging colors preserved, camera locked frontal no rotation, gentle bright highlight gradually travels across the product surface revealing texture (soft specular sweep), atmospheric particles drift slowly in background, product underneath stays neutral white-balanced',
    'Static product with original colors intact, camera fixed frontal no rotation, soft warm highlight slowly washes across the product surface (specular reflection drift), warm ambient source in background, product underneath highlight stays in true packaging colors'
  ],
  STAR: [
    'Product stationary with original colors intact, camera locked frontal no rotation, triumphant bright specular HIGHLIGHT sweeps across the product surface like a beam of glory passing over the packaging, golden light source in background, atmospheric particles, product underneath the highlight preserves all original colors',
    'Static product centered with packaging colors preserved, camera fixed frontal no rotation, dramatic golden HIGHLIGHT band travels across product front from one side to other (specular reflection of overhead spotlight passing), lens flare in background, product underneath stays in true colors',
    'Product crisp and unmoving with original colors, camera locked fixed frontal no rotation, golden bright highlight sweeps slowly across product surface revealing details (like a museum spotlight passing over an artifact), atmospheric smoke billows in distance, product underneath in original packaging colors',
    'Stationary product with package colors intact, camera fixed frontal no rotation, strong golden moving highlight sweeps across product front and exits frame (specular reflection blast), back-rim light glows in background, atmospheric particles, product underneath remains true to its original colors',
    'Product locked still in original colors, camera completely fixed frontal no rotation, dramatic bright highlight sweep travels across the product surface from dark to fully illuminated and back (specular reveal blast), lens flare in background at peak, product underneath stays in true original packaging colors throughout'
  ]
};
function pickMotion(status) {
  const arr = MOTION_PROMPTS[status] || MOTION_PROMPTS.HOT;
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── BOYKOT WC STORE API — pulls REAL product image from boykot.cl ────
// Bsale SKUs don't match boykot.cl SKUs (different systems). Strategy:
// search by name+brand keywords, score WC results by keyword overlap, require
// minimum match strength to avoid posting wrong product. Returns null if no
// confident match (skip = no slop posted).
function decodeHtml(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#?\d+;/g, '');
}

async function findBoykotProductImage(product) {
  try {
    const name = (product.name || '').trim();
    const brand = product.brand || '';
    const firstVariantDesc = (product.variants?.[0]?.description || '').trim();

    if (!name && !brand) return null;

    // Build a set of expected keywords from our catalog product
    const keywordPool = (name + ' ' + brand + ' ' + firstVariantDesc).toLowerCase();
    const productKeywords = new Set(
      keywordPool.split(/[\s,()/.:\-]+/).filter(w => w.length >= 3)
    );

    // Build search queries — try in order from most specific to most general
    const queries = [];
    if (brand && name) queries.push(`${brand} ${name.split(/\s+/).slice(0, 3).join(' ')}`);
    if (name) queries.push(name);
    if (brand && firstVariantDesc) queries.push(`${brand} ${firstVariantDesc.split(/\s+/)[0]}`);
    if (brand) queries.push(brand);

    const seen = new Set();
    let bestMatch = null;
    let bestScore = 0;

    for (const q of queries) {
      const qn = q.toLowerCase().trim();
      if (!qn || seen.has(qn)) continue;
      seen.add(qn);

      try {
        const r = await fetch(
          `https://www.boykot.cl/wp-json/wc/store/products?search=${encodeURIComponent(q)}&per_page=20`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }
        );
        if (!r.ok) continue;
        const arr = await r.json();
        if (!Array.isArray(arr) || arr.length === 0) continue;

        // Score each WC result by # of overlapping keywords with our product
        for (const wc of arr) {
          if (!wc.images?.[0]?.src) continue;
          const wcText = decodeHtml(wc.name || '').toLowerCase();
          const wcWords = new Set(wcText.split(/[\s,()/.:\-]+/).filter(w => w.length >= 3));
          let score = 0;
          for (const w of wcWords) if (productKeywords.has(w)) score++;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = { wc, query: q };
          }
        }

        // If we found a strong match (≥3 keywords) on this query, stop early
        if (bestScore >= 3) break;
      } catch (err) {
        console.error('[boykot-api] query "' + q + '" err:', err.message);
      }
    }

    // Require at least 2 keyword matches to consider it the right product
    if (!bestMatch || bestScore < 2) {
      console.log(`[boykot-api] no confident match for "${name}" (brand=${brand}, bestScore=${bestScore})`);
      return null;
    }

    const wc = bestMatch.wc;
    return {
      url: wc.images[0].src,
      productPageUrl: wc.permalink,
      wcName: decodeHtml(wc.name),
      wcSku: wc.sku,
      matchedQuery: bestMatch.query,
      matchScore: bestScore,
      priceRaw: wc.prices?.price || null, // string in cents (e.g. "9800" for CLP — no minor unit)
      currency: wc.prices?.currency_code || 'CLP',
    };
  } catch (err) {
    console.error('[boykot-api] global err:', err.message);
    return null;
  }
}

// ── BSALE FACTORY — sales-driven content with HOT/COLD/STAR classification ────
// Templates by brand — speaks the artist's language, not the seller's.
// Sales data drives SELECTION (which product to feature) — never appears
// in the public-facing caption.
const BRAND_VOICE = {
  Copic: 'Marcadores base alcohol para ilustradores, manga, anime, fashion design. Tinta recargable, mezclable.',
  Angelus: 'Pintura acrílica especializada para cuero y zapatillas. La marca de los pintores de sneakers.',
  Holbein: 'Acuarela y gouache de tradición japonesa. Pigmentos densos, mezcla limpia.',
  Molotow: 'Marcadores y aerosoles para graffiti, street art, ilustración profesional.',
  Speedball: 'Caligrafía, ink, plumillas. Lo clásico que enseñan en escuelas de arte.',
  'Winsor & Newton': 'Acuarela y óleo profesional con 150+ años. Pigmentos premium.',
  Fabriano: 'Papel italiano, base para acuarela y dibujo seria.',
  Sakura: 'Crayolas, pastel, gel pens. Materiales de educación artística.',
  Derwent: 'Lápices de color y grafito britanico. Para realismo y bocetos.',
  Posca: 'Marcador acrílico de punta dura para cualquier superficie.',
  Acrilex: 'Acrílico nacional brasileño, asequible y versátil.',
  Kuretake: 'Tinta y caligrafía japonesa, sumi-e, manga.',
  'Daler-Rowney': 'Pinceles y acuarela inglesa, tradición académica.',
  Vallejo: 'Pintura acrílica para modelismo, miniatura, fine detail.',
  Arches: 'Papel acuarela 100% algodón francés, gold standard.',
  "Caran d'Ache": 'Suizos premium — lápices, acuarela, materiales luxe.',
  'Faber-Castell': 'Alemán clásico, lápices y materiales de dibujo confiables.',
  Staedtler: 'Marcadores y lápices técnicos alemanes.',
  Liquitex: 'Acrílico profesional, medios, fluidos modernos.',
  Prismacolor: 'Lápices de color soft, blending intenso.',
};

function templateCaption(product, status, opts) {
  const name = (opts.display_name || product.name || 'Producto').trim();
  const brand = opts.brand || 'Boykot';
  const tag = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
  const brandLine = BRAND_VOICE[brand] || '';
  const priceLine = opts.price ? `\n💰 $${opts.price.toLocaleString('es-CL')} CLP` : '';
  const urlLine = opts.product_url ? `\n🔗 ${opts.product_url}` : '\nboykot.cl';

  // Subtle scarcity / popularity hooks per status — NO numbers, no internal data
  let hook = '';
  if (status === 'HOT') {
    hook = brandLine ? `${brandLine}\n\nTendencia esta semana entre quienes los usan.` : 'Tendencia esta semana.';
  } else if (status === 'COLD') {
    hook = brandLine ? `${brandLine}\n\nUna herramienta que vale la pena redescubrir.` : 'Una herramienta que vale la pena redescubrir.';
  } else {
    // STAR
    hook = brandLine ? `${brandLine}\n\nDe los favoritos del mes en el catálogo.` : 'De los favoritos del mes.';
  }

  const emoji = status === 'HOT' ? '🔥' : status === 'COLD' ? '❄️' : '⭐';
  return `${emoji} <b>${name}</b>\n${hook}${priceLine}${urlLine}\n\n#boykot #${tag} #arte #chile`;
}

async function llmCaption(product, status, opts) {
  const fallback = templateCaption(product, status, opts);
  if (!anthropic) return fallback;
  try {
    // Status drives angle, NOT sales data shown to reader
    const angle = status === 'HOT'
      ? 'Producto que está captando interés esta temporada. Tono: entusiasmo natural, hablás del USO del producto, técnica, lo que se logra. No menciones que se vende mucho.'
      : status === 'COLD'
      ? 'Producto valioso que merece más atención. Tono: invitación a probar, redescubrimiento, lo que aporta a la práctica del artista. No menciones que no se vendió.'
      : 'Producto querido en la comunidad. Tono: validación curatorial, lo que lo hace especial, por qué muchos lo usan. Subtle social proof, no estadísticas.';

    const priceLine = opts.price ? `Precio: $${opts.price.toLocaleString('es-CL')} CLP` : '';
    const urlLine = opts.product_url ? `Link al producto: ${opts.product_url}` : '';

    const res = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 320,
      messages: [{
        role: 'user',
        content: `Escribí UN caption para Instagram Reel de Boykot.cl (tienda chilena de materiales de arte), 50-90 palabras, español rioplatense/chileno neutro.

Hablás como ARTISTA recomendando a otra artista — no como vendedor moviendo stock.

Producto: ${(opts.display_name || product.name || '').trim()}
Marca: ${opts.brand}
Ángulo: ${angle}
${priceLine}
${urlLine}

REGLAS DE COPY:
- Hablá del USO del producto, su TÉCNICA, lo que LOGRA, qué tipo de artista lo elige.
- NO mencionés números de ventas, stock disponible, ni "X unidades vendidas".
- NO uses frases tipo "no te lo pierdas", "vuelan", "compralo ya", "se acaba".
- Sí podés usar scarcity suave: "edición limitada", "recién llegado", "rare drop", "edición especial" — solo si es genuino.
- El precio podés mencionarlo UNA vez, casual.
- Cerrá con el link en línea separada.
- 3-5 hashtags al final: #boykot + marca + 1-2 hashtags de técnica/categoría (ej. #manga #sneakerpaint #acuarela #watercolor).

REGLAS DE FORMATO:
- HTML para Telegram: SOLO <b>negrita</b> y emojis. NO <em>, <i>, <p>, ni otros tags.
- Devolvé SOLO el caption, sin explicación previa.

Ejemplo del tono que quiero (sobre un Copic Ciao):
"🔥 <b>Copic Ciao Layer & Mix: MANGA Mellow</b>

Trinity de pastel para el género shojo: BG-72, RV-34, E-21. Tres marcadores curados para que un colorista de manga empiece o complete su paleta sin solapar tonos. Punta brush + medium broad — relleno y sombra del mismo marcador.

Recargables con Copic INK, hasta 9 veces.

💰 $9.800

🔗 https://www.boykot.cl/...

#boykot #copic #manga #ciao #ilustracion"

Notá: ZERO mención de "47 unidades", "stock 12", "vuelan". Solo arte.`,
      }],
    });
    const text = res.content?.[0]?.text?.trim();
    return text || fallback;
  } catch (err) {
    console.error('[llm] caption err:', err.message);
    return fallback;
  }
}

async function llmVisualPrompt(product, status) {
  const fallback = `Editorial product photography, ${(product.name || '').trim()}, vertical 9:16 composition, black background #000000, dramatic acid yellow #CCFF00 rim lighting, ultra minimal studio, hyper-detailed macro, cinematic dark aesthetic, photorealistic, no people, no text overlay`;
  if (!anthropic) return fallback;
  try {
    const energy = status === 'HOT' ? 'dramatic urgent energy, motion blur edges, intense rim light' :
                   status === 'COLD' ? 'meditative still, soft single light pool, dust particles in light beam' :
                   'triumphant golden hero shot, centered, halo light';
    const res = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `Generate ONLY a Runway gen4_image text-to-image prompt (no explanation, no quotes, no preamble) for a vertical 9:16 editorial product shot.

Product: ${(product.name || '').trim()}
Brand: ${product.brand}
Mood: ${energy}

Mandatory aesthetic constraints: black background, acid yellow #CCFF00 accent light, vertical reel composition, photorealistic, no people, no text overlays, dramatic cinematic. 1-2 sentences, dense, evocative.`,
      }],
    });
    const text = res.content?.[0]?.text?.trim();
    return text || fallback;
  } catch (err) {
    console.error('[llm] visual err:', err.message);
    return fallback;
  }
}

async function runBsaleFactory() {
  const startTs = Date.now();
  try {
    console.log('🛍️ BSALE FACTORY iniciando');
    await sendTelegram('🛍️ <b>BSALE Factory</b>\nLeyendo ventas + stock de Bsale...');

    const catalog = bsale.loadCatalog();
    if (!catalog.length) {
      await sendTelegram('❌ catalog.json vacío o no encontrado');
      return;
    }

    let salesMap;
    let mode = 'sales';
    try {
      salesMap = await bsale.getSalesByVariant(30);
      if (salesMap.size === 0) throw new Error('no sales returned');
    } catch (err) {
      console.error('[bsale] sales unavailable:', err.message, '— falling back to stock heuristic');
      mode = 'stock-heuristic';
      salesMap = new Map();
    }

    const classified = mode === 'sales'
      ? bsale.classifyProducts(catalog, salesMap)
      : bsale.classifyByStockHeuristic(catalog);

    const history = bsale.loadHistory();
    const picks = bsale.selectDailyPicks(classified, history);

    await sendTelegram(`📊 <b>Clasificación</b> (${mode})\n🔥 HOT: ${classified.hot.length}\n❄️ COLD: ${classified.cold.length}\n⭐ STAR: ${classified.star.length}`);

    const queue = [
      { status: 'HOT',  emoji: '🔥', product: picks.hot },
      { status: 'COLD', emoji: '❄️', product: picks.cold },
      { status: 'STAR', emoji: '⭐', product: picks.star },
    ];

    let posted = 0;
    for (const { status, emoji, product } of queue) {
      if (!product) {
        console.log(`[bsale-factory] no candidate for ${status} — skip`);
        continue;
      }
      try {
        const opts = {
          brand: product.brand,
          units_sold_30d: product.totalSold,
          total_stock: product.totalStock,
          // Filled in after WC lookup
          price: null,
          currency: 'CLP',
          product_url: null,
          display_name: (product.name || '').trim(),
        };
        await sendTelegram(`${emoji} <b>${(product.name || '').trim()}</b> [${product.brand}]\nstock ${opts.total_stock} · 30d ${opts.units_sold_30d}\nGenerando ${status}...`);

        // STEP 1: Find the REAL product image on boykot.cl via WC Store API.
        const realImage = await findBoykotProductImage(product);
        if (!realImage) {
          await sendTelegram(`⚠️ ${emoji} <b>${(product.name || '').trim()}</b>\nNo está en boykot.cl, skip — no posteamos slop`);
          console.log(`[bsale-factory] ${status} skip: ${product.name} not found on boykot.cl`);
          continue;
        }

        // Enrich opts with WC data (price, URL, clean display name)
        opts.display_name = realImage.wcName || opts.display_name;
        opts.product_url = realImage.productPageUrl;
        if (realImage.priceRaw) {
          const n = Number(realImage.priceRaw);
          if (!Number.isNaN(n) && n > 0) opts.price = n;
        }

        // Show the real photo (preview)
        const priceLabel = opts.price ? `\n💰 $${opts.price.toLocaleString('es-CL')} CLP` : '';
        await sendTelegramPhoto(realImage.url, `📸 ${emoji} <b>${opts.display_name}</b>${priceLabel}\n${realImage.productPageUrl}`);

        // STEP 2: Generate caption (LLM with template fallback), now with price + URL context
        const caption = await llmCaption(product, status, opts);

        // STEP 3: Animate the REAL product image via Runway image-to-video.
        // STEP A: Upscale source via Magnific (more pixel signal for small text)
        const upscaled = await upscaleImage(realImage.url, status);
        const highResUrl = upscaled || realImage.url;
        if (upscaled) {
          console.log(`[bsale-factory ${status}] using UPSCALED image`);
        } else {
          console.log(`[bsale-factory ${status}] upscale unavailable, using raw image`);
        }

        // STEP B: Smart aspect-aware prep — pillarbox wide products only
        const sourceImage = await prepareSourceForReel(highResUrl, status);

        const motionPrompt = pickMotion(status);
        const useDur = durationForModel(RUNWAY_MODEL, 5);
        console.log(`[bsale-factory ${status}] calling runway model=${RUNWAY_MODEL} duration=${useDur} ratio=720:1280 source=${sourceImage.slice(0, 80)}...`);

        let videoUrl;
        try {
          const vid = await runway.imageToVideo.create({
            model: RUNWAY_MODEL,
            promptImage: sourceImage,
            promptText: motionPrompt,
            duration: useDur,
            ratio: '720:1280',
          }).waitForTaskOutput();
          videoUrl = vid.output?.[0];
          console.log(`[bsale-factory ${status}] runway returned: ${videoUrl ? videoUrl.slice(0, 80) : 'EMPTY OUTPUT'}`);
        } catch (rErr) {
          console.error(`[bsale-factory ${status}] runway SDK threw: ${rErr.message}`);
          throw new Error(`runway: ${rErr.message}`);
        }
        if (!videoUrl) throw new Error('video gen returned empty output');
        await sendTelegramVideo(videoUrl, caption);
        console.log(`[bsale-factory ${status}] video pushed to Telegram OK`);

        bsale.recordPost(history, product, status);
        posted++;
      } catch (err) {
        console.error(`[bsale-factory] ${status} err:`, err.message);
        await sendTelegram(`❌ Error en ${status}: ${err.message}`);
      }
    }

    const elapsed = Math.round((Date.now() - startTs) / 1000);
    await sendTelegram(`✅ <b>BSALE Factory</b>\n${posted}/3 posts publicados · ${elapsed}s · modo: ${mode}`);
  } catch (err) {
    console.error('[bsale-factory] global err:', err.message);
    await sendTelegram(`❌ BSALE Factory error: ${err.message}`);
  }
}

// ── SCHEDULER ─────────────────────────────────────────────────
// Cron schedule (UTC; user is Chile UTC-4 in winter):
// ALL crons now call runBsaleFactory() — the legacy runBoykotFactory uses
// hardcoded Unsplash paintbrush placeholders that look generic and unrelated
// to the actual product (same problem as old produce()). All real product
// content comes from runBsaleFactory.
// - 03:00 UTC = 23:00 Chile (previous night) — late-night batch
// - 10:00 UTC = 06:00 Chile — morning batch
// - 16:00 UTC = 12:00 Chile — midday batch (was liquidacion paintbrush slop)
// - 22:00 UTC = 18:00 Chile — evening batch (moved from 16:42 UTC which was too close to 12:00)
cron.schedule('0 3 * * *',  () => runBsaleFactory());
cron.schedule('0 10 * * *', () => runBsaleFactory());
cron.schedule('0 16 * * *', () => runBsaleFactory());
cron.schedule('0 22 * * *', () => runBsaleFactory());

// Sequential polling — one getUpdates at a time. Previous setInterval(pollTelegram, 3000)
// caused self-conflict because Telegram allows only ONE active getUpdates per token at a time;
// every overlapping poll was being killed and producing errors that LEAKED THE TOKEN to logs.
(async function pollLoop() {
  while (true) {
    await pollTelegram();
    await new Promise(r => setTimeout(r, 500));
  }
})();

// ── HTTP SERVER ───────────────────────────────────────────────
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'SISTEMA online', time: new Date().toISOString() }));
  } else if (req.method === 'POST' && req.url === '/produce') {
    if (!requireAuth(req, res)) return;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const { theme } = body ? JSON.parse(body) : {};
      res.writeHead(202);
      res.end(JSON.stringify({ message: 'Production started', theme: theme || null }));
      produce(theme);
    });
  } else if (req.method === 'POST' && req.url === '/bsale') {
    if (!requireAuth(req, res)) return;
    res.writeHead(202);
    res.end(JSON.stringify({ message: 'BSALE factory started' }));
    runBsaleFactory();
  } else if (req.method === 'POST' && req.url === '/animate-and-push') {
    // Takes an image URL, animates it via Runway (model selectable: gen4.5,
    // gen4_turbo, veo3.1, veo3.1_fast, gen4_aleph, etc.), then sends BOTH
    // image + animated video to Telegram.
    if (!requireAuth(req, res)) return;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const {
          image_url,
          caption,
          motion_prompt,
          preview_caption,
          model,        // override default model (e.g. 'veo3.1', 'gen4.5', 'gen4_turbo')
          duration,     // seconds, default 5
          ratio,        // default '720:1280'
        } = JSON.parse(body || '{}');
        if (!image_url) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'image_url required' }));
          return;
        }
        res.writeHead(202);
        res.end(JSON.stringify({ message: 'Animate + push started', image_url, model: model || RUNWAY_MODEL }));

        // Pass raw image — letterbox padding was killing motion in v3 demos
        const sourceImage = image_url;
        const motion = motion_prompt || pickMotion('STAR');
        const useModel = model || RUNWAY_MODEL;
        const useRatio = ratio || '720:1280';
        const useDuration = duration || 5;

        await sendTelegramPhoto(image_url, preview_caption || `🎨 Source · model: ${useModel}`);

        // DIRECT HTTP CALL to Runway API — bypassing SDK because @runwayml/sdk 3.21
        // may not support newer model names like gen4.5 / veo3.1 properly
        try {
          console.log(`[runway-direct] starting ${useModel} ratio=${useRatio} duration=${useDuration}`);
          const startRes = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + RUNWAY_KEY,
              'X-Runway-Version': '2024-11-06',
            },
            body: JSON.stringify({
              model: useModel,
              promptImage: sourceImage,
              promptText: motion,
              ratio: useRatio,
              duration: durationForModel(useModel, useDuration),
            }),
          });
          const startData = await startRes.json();
          console.log(`[runway-direct] start response status=${startRes.status} body=${JSON.stringify(startData).slice(0,300)}`);

          if (!startData.id) {
            const errMsg = startData.error || JSON.stringify(startData).slice(0, 200);
            await sendTelegram(`❌ Runway ${useModel} rechazó request: ${errMsg}`);
            return;
          }

          // Poll task
          let videoUrl = null;
          let lastStatus = 'PENDING';
          for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const tRes = await fetch(`https://api.dev.runwayml.com/v1/tasks/${startData.id}`, {
              headers: { 'Authorization': 'Bearer ' + RUNWAY_KEY, 'X-Runway-Version': '2024-11-06' },
            });
            const t = await tRes.json();
            lastStatus = t.status;
            console.log(`[runway-direct] ${useModel} poll #${i} status=${lastStatus}`);
            if (lastStatus === 'SUCCEEDED') {
              videoUrl = t.output?.[0];
              break;
            }
            if (lastStatus === 'FAILED') {
              await sendTelegram(`❌ Runway ${useModel} FAILED: ${t.failure?.reason || t.error || 'unknown'}`);
              return;
            }
          }

          if (!videoUrl) {
            await sendTelegram(`❌ Runway ${useModel} timeout (último status: ${lastStatus})`);
            return;
          }
          const finalCaption = (caption || '') + (caption ? '\n' : '') + `<i>via Runway ${useModel}</i>`;
          await sendTelegramVideo(videoUrl, finalCaption);
          console.log(`[runway-direct] ${useModel} delivered: ${videoUrl.slice(0,80)}`);
        } catch (vErr) {
          console.error(`[runway-direct] ${useModel} exception:`, vErr.message, vErr.stack);
          await sendTelegram(`❌ Runway exception: ${vErr.message}`);
        }
      } catch (err) {
        console.error('[animate-and-push] err:', err.message);
        try { await sendTelegram(`❌ Animate-and-push error: ${err.message}`); } catch {}
      }
    });
  } else if (req.method === 'POST' && req.url === '/push-content') {
    if (!requireAuth(req, res)) return;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { image_url, video_url, caption, preview_caption } = JSON.parse(body || '{}');
        if (!image_url && !video_url && !caption) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Provide at least one of: image_url, video_url, caption' }));
          return;
        }
        const summary = { image: false, video: false, text: false };
        // If both image and video: image goes first with preview_caption (header), video with main caption (footer)
        if (image_url) {
          await sendTelegramPhoto(image_url, preview_caption || (video_url ? '' : caption));
          summary.image = true;
        }
        if (video_url) {
          await sendTelegramVideo(video_url, caption || '');
          summary.video = true;
        }
        if (!image_url && !video_url && caption) {
          await sendTelegram(caption);
          summary.text = true;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ message: 'Pushed to Telegram', summary }));
      } catch (err) {
        console.error('[push-content] err:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else if (req.method === 'POST' && req.url === '/boykot') {
    if (!requireAuth(req, res)) return;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const { mode, limit, url } = body ? JSON.parse(body) : {};
      res.writeHead(202);
      if (url) {
        res.end(JSON.stringify({ message: 'Boykot URL started' }));
        runBoykotUrl(url);
      } else {
        res.end(JSON.stringify({ message: 'Boykot factory started', mode: mode || 'top' }));
        runBoykotFactory(mode || 'top', limit || 3);
      }
    });
  } else if (req.method === 'GET' && req.url === '/films') {
    const dir = './films';
    const films = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    res.writeHead(200);
    res.end(JSON.stringify({ films }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🎥 SISTEMA on port ${PORT}`);
  console.log('📱 Telegram: @Maarmapabot');
  console.log('🛍️ /url [boykot url] — Gen-4 Image + Gen-4.5 Video');
});

// ── DOCU BOYKOT ───────────────────────────────────────────────
const BRAND_URLS = {
  angelus: [
    'https://www.boykot.cl/tienda/pintura/angelus/roll-call-edge-dressing-black/',
    'https://www.boykot.cl/tienda/limpiadores/angelus-suede-renew-4-oz-pump-spray/',
    'https://www.boykot.cl/tienda/limpiadores/deodorizer-4-oz-pump-spray/',
  ],
  copic: [
    'https://www.boykot.cl/tienda/marcadores/copic-markers/sets/copic-acrea-set-de-6-colores-vivid/',
    'https://www.boykot.cl/tienda/lapices/tiralineas/multiliner-copic-black-set/',
    'https://www.boykot.cl/tienda/copic/mesa-de-luz-copic-comic-master-led-a4/',
  ],
  holbein: [
    'https://www.boykot.cl/categoria-producto/pintura/holbein/acuarela-holbein/',
  ],
  molotow: [
    'https://www.boykot.cl/tienda/pintura/sprays/premium-molotow/molotow-premium-400-ml/',
    'https://www.boykot.cl/tienda/pintura/sprays/urban-fine-art/molotow-neon-ufa/',
    'https://www.boykot.cl/tienda/marcadores/molotow-markers/molotow-markers-sets/one4all-127hs-basic-set-3-200478/',
  ],
};

const DOCU_SCRIPTS = {
  angelus: [
    { title: "La Piel Recuerda", narration: "Cada superficie tiene memoria. Angelus la transforma.", motion: "Slow macro reveal of leather shoe being painted, brush stroke in slow motion, color bleeding into texture" },
    { title: "El Ritual del Color", narration: "No es pintura. Es un pacto con el material.", motion: "Product bottle opens, paint drips in slow motion onto dark surface, spreading like ink in water" },
    { title: "Resistencia", narration: "Lo que fue suyo, ahora es tuyo.", motion: "Cinematic close up of freshly painted sneaker, light catching the surface, dramatic studio lighting" },
  ],
  copic: [
    { title: "El Trazo Infinito", narration: "Un marcador que dura para siempre. Como ciertas ideas.", motion: "Copic marker tip moving across paper in extreme slow motion, ink flowing, colors blending seamlessly" },
    { title: "La Paleta del Universo", narration: "358 colores. Uno para cada estado del alma.", motion: "Array of Copic markers arranged, camera pans slowly, colors gradient from warm to cool" },
    { title: "Precisión Quirúrgica", narration: "El multiliner no perdona. Tampoco el artista.", motion: "Thin precise line being drawn, camera extremely close, paper texture visible, perfect black line" },
  ],
  molotow: [
    { title: "La Calle Habla", narration: "400ml de declaración. El spray que fundó una cultura.", motion: "Spray can in slow motion, paint dispersing in air, mist catching dramatic side light" },
    { title: "Neon en la Oscuridad", narration: "Algunos colores no pueden ser ignorados.", motion: "Neon paint glowing under UV light, slow reveal from darkness, electric color explosion" },
    { title: "El Mural Eterno", narration: "Lo efímero hecho permanente. Boykot.", motion: "Paint being applied to concrete wall texture, slow cinematic push in, urban atmosphere" },
  ],
  default: [
    { title: "El Arte Como Resistencia", narration: "En un mundo de algoritmos, el trazo manual es un acto político.", motion: "Extreme macro of art supplies, ink spreading on paper, slow motion paint explosion" },
    { title: "La Materia del Sueño", narration: "Cada producto es una posibilidad. Boykot las reúne todas.", motion: "Products arranged in dark studio, dramatic rim lighting, slow orbit camera movement" },
    { title: "Santiago Pinta", narration: "Desde 2010. La ciudad cambió. Boykot también.", motion: "Art supplies silhouetted against urban Santiago skyline, cinematic wide shot, golden hour" },
  ],
};

async function scrapeProductImage(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    // Get all product images (WooCommerce thumbnails have -NxN suffix)
    const matches = [...html.matchAll(/https:\/\/www\.boykot\.cl\/wp-content\/uploads\/[^\s"']+?-\d+x\d+\.(jpg|jpeg|png|webp)/g)];
    const productImgs = matches
      .map(m => m[0].replace(/-\d+x\d+(?=\.(jpg|jpeg|png|webp))/, ''))
      .filter(u => !u.includes('logo') && !u.includes('banner') && !u.includes('favicon') && !u.includes('header'));
    return productImgs[0] || null;
  } catch(e) {
    return null;
  }
}

async function runDocuBoykot(brand = 'default') {
  const brandKey = brand.toLowerCase();
  const script = DOCU_SCRIPTS[brandKey] || DOCU_SCRIPTS.default;
  const urls = BRAND_URLS[brandKey] || [];

  console.log(`\n🎬 DOCU BOYKOT — ${brand}`);
  await sendTelegram(`🎬 <b>Docu Boykot: ${brand.toUpperCase()}</b>\n${script.length} escenas · Generando mini film...`);

  // Scrape product images
  const productImages = [];
  for (const url of urls.slice(0, script.length)) {
    const img = await scrapeProductImage(url);
    if (img) productImages.push(img);
  }

  await sendTelegram(`📸 ${productImages.length} imágenes de productos scrapeadas\n🎥 Iniciando producción...`);

  const scenes = [];
  for (let i = 0; i < script.length; i++) {
    const scene = script[i];
    const productImg = productImages[i] || null;

    await sendTelegram(`⏳ Escena ${i+1}/${script.length}: <b>${scene.title}</b>\n<i>${scene.narration}</i>`);

    try {
      let videoUrl;

      if (productImg) {
        // Use real product image as reference
        const imageTask = await runway.textToImage.create({
          model: 'gen4_image',
          promptText: `Cinematic editorial product shot: ${scene.motion}. The product must remain clearly visible and recognizable. Black background, dramatic rim lighting, photorealistic, no text, no people`,
          ratio: '1920:1080',
          referenceImages: [{ uri: productImg, weight: 0.92 }],
        }).waitForTaskOutput();

        const renderUrl = imageTask.output[0];

        const videoTask = await runway.imageToVideo.create({
          model: RUNWAY_MODEL,
          promptImage: renderUrl,
          promptText: scene.motion + ', cinematic, slow motion, dramatic',
          duration: durationForModel(RUNWAY_MODEL, 5),
          ratio: '1280:720',
        }).waitForTaskOutput();

        videoUrl = videoTask.output[0];
      } else {
        // Fallback — text only
        const task = await runway.imageToVideo.create({
          model: RUNWAY_MODEL,
          promptImage: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=1280&q=80',
          promptText: scene.motion + ', cinematic, dramatic lighting, black background',
          duration: durationForModel(RUNWAY_MODEL, 5),
          ratio: '1280:720',
        }).waitForTaskOutput();
        videoUrl = task.output[0];
      }

      scenes.push({ ...scene, videoUrl });
      await sendTelegramVideo(videoUrl, `🎬 <b>${scene.title}</b>\n\n<i>"${scene.narration}"</i>\n\n<b>Boykot.cl</b> · ${brand.toUpperCase()}\n#boykot #${brandKey} #artesupplies #chile`);

    } catch(e) {
      await sendTelegram(`❌ Error escena ${i+1}: ${e.message}`);
    }

    // Buffer between scenes
    await new Promise(r => setTimeout(r, 5000));
  }

  await sendTelegram(`✅ <b>Docu Boykot: ${brand.toUpperCase()} completo</b>\n🎬 ${scenes.length} escenas generadas\n\nPowered by Runway Gen-4 + maarmapa.eth`);
}

// ── MARCA FACTORY — catálogo + scraping + Gen-4 Image + Gen-4.5 ──
async function runMarcaFactory(marca, limit = 5) {
  console.log(`\n🏷️ MARCA FACTORY — ${marca} x${limit}`);
  await sendTelegram(`🏷️ <b>Marca Factory: ${marca.toUpperCase()}</b>\nTop ${limit} productos · Generando photoshoot...`);

  // Filter catalog by brand name
  const catalog = loadCatalog();
  const marcaLower = marca.toLowerCase();
  const products = catalog
    .filter(p => {
      const name = (p.name + ' ' + (p.variants?.[0]?.description || '')).toLowerCase();
      return name.includes(marcaLower);
    })
    .filter(p => p.variants?.some(v => v.stock > 0))
    .sort((a, b) => {
      const stockA = a.variants?.reduce((s, v) => s + (v.stock || 0), 0) || 0;
      const stockB = b.variants?.reduce((s, v) => s + (v.stock || 0), 0) || 0;
      return stockB - stockA;
    })
    .slice(0, limit);

  if (!products.length) {
    await sendTelegram(`❌ No se encontraron productos de <b>${marca}</b> en stock`);
    return;
  }

  await sendTelegram(`📦 ${products.length} productos encontrados:\n${products.map(p => `• ${p.name.trim()}`).join('\n')}`);

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const productName = product.name.trim();
    const variant = product.variants?.find(v => v.stock > 0) || product.variants?.[0];
    const variantDesc = variant?.description || productName;

    await sendTelegram(`⏳ ${i+1}/${products.length}: <b>${productName}</b>`);

    try {
      // Search boykot.cl for product image - use brand category page first
      const BRAND_CATEGORY_URLS = {
        angelus: 'https://boykot.cl/pinturas-angelus/',
        copic: 'https://boykot.cl/copic-chile/',
        molotow: 'https://boykot.cl/molotow-chile/',
        holbein: 'https://www.boykot.cl/holbein-chile/',
      };
      const categoryUrl = BRAND_CATEGORY_URLS[marcaLower] || `https://www.boykot.cl/?s=${encodeURIComponent(productName)}`;
      const searchUrl = `https://www.boykot.cl/?s=${encodeURIComponent(variantDesc || productName)}`;
      let productImg = null;
      try {
        const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        const searchHtml = await searchRes.text();
        const matches = [...searchHtml.matchAll(/https:\/\/www\.boykot\.cl\/wp-content\/uploads\/[^\s"']+?-\d+x\d+\.(jpg|jpeg|png|webp)/g)];
        const imgs = matches
          .map(m => m[0].replace(/-\d+x\d+(?=\.(jpg|jpeg|png|webp))/, ''))
          .filter(u => !u.includes('logo') && !u.includes('banner') && !u.includes('favicon') && !u.includes('header'));
        productImg = imgs[0] || null;
      } catch(e) { productImg = null; }

      if (productImg) await sendTelegramPhoto(productImg, `📸 ${productName}`);

      // Gen-4 Image — editorial render
      const refImages = productImg ? [{ uri: productImg, weight: 0.92 }] : [];
      const imageTaskCreate = await runway.textToImage.create({
        model: 'gen4_image',
        promptText: `Professional editorial product photoshoot of ${variantDesc} by ${marca}, black background #000000, acid yellow #CCFF00 dramatic rim lighting, ultra minimal studio, product clearly visible, high contrast, photorealistic, no people, no text`,
        ratio: '1920:1080',
        ...(refImages.length ? { referenceImages: refImages } : {}),
      });
      let imageTask = imageTaskCreate;
      for (let p = 0; p < 30; p++) {
        if (imageTask.status === 'SUCCEEDED') break;
        if (imageTask.status === 'FAILED') throw new Error('Image generation failed');
        await new Promise(r => setTimeout(r, 5000));
        imageTask = await runway.tasks.retrieve(imageTaskCreate.id);
      }
      if (imageTask.status !== 'SUCCEEDED') throw new Error('Image timeout');
      const renderUrl = imageTask.output[0];
      await sendTelegramPhoto(renderUrl, `🎨 Render: ${productName}`);

      // Gen-4.5 — cinematic video
      const videoCreate = await runway.imageToVideo.create({
        model: RUNWAY_MODEL,
        promptImage: renderUrl,
        promptText: `Slow cinematic product presentation, ${variantDesc}, elegant 360 rotation, dramatic studio lighting sweeps across product surface, black background, acid yellow light accent, commercial quality`,
        duration: durationForModel(RUNWAY_MODEL, 5),
        ratio: '1280:720',
      });
      let videoTask = videoCreate;
      for (let p = 0; p < 30; p++) {
        if (videoTask.status === 'SUCCEEDED') break;
        if (videoTask.status === 'FAILED') throw new Error('Video generation failed');
        await new Promise(r => setTimeout(r, 5000));
        videoTask = await runway.tasks.retrieve(videoCreate.id);
      }
      if (videoTask.status !== 'SUCCEEDED') throw new Error('Video timeout');

      const caption = `🎬 <b>${productName}</b>\n📦 ${product.category || marca}\n\n🛒 boykot.cl\n#boykot #${marcaLower} #artesupplies #chile`;
      await sendTelegramVideo(videoTask.output[0], caption);

      await new Promise(r => setTimeout(r, 15000));

    } catch(e) {
      await sendTelegram(`❌ Error en ${productName}: ${e.message}`);
    }
  }

  await sendTelegram(`✅ <b>Marca Factory: ${marca.toUpperCase()} completo</b>\n🎬 ${products.length} productos generados\n\nboykot.cl · Powered by Runway + SISTEMA`);
}

// ── COPIC AWARD DOCU ──────────────────────────────────────────
async function runCopicAward() {
  console.log('\n🏆 COPIC AWARD DOCU');
  await sendTelegram(`🏆 <b>Copic Award Chile 2026</b>\nGenerando contenido del concurso...`);

  const scenes = [
    {
      title: "El Trazo Ganador",
      narration: "Chile demostró su talento. Sweet Coffee ganó el Copic Award 2025.",
      imgRef: "https://www.boykot.cl/wp-content/uploads/2025/12/Sweet-coffee-731x1024.jpg",
      prompt: "Cinematic macro of Copic marker drawing on paper, vibrant colors bleeding into white surface, artistic illustration style, warm cafe tones, soft dramatic lighting, no people, no text, photorealistic",
      motion: "Slow zoom into illustration details, colors shimmer, paper texture visible, warm golden light, cinematic",
    },
    {
      title: "La Comunidad Crea",
      narration: "Artistas de todo Chile. Un solo lenguaje: los marcadores Copic.",
      imgRef: "https://www.boykot.cl/wp-content/uploads/2025/12/Fondo-copic-1024x636.jpg",
      prompt: "Flat lay of multiple Copic markers arranged artistically on dark surface, scattered paper with colorful illustrations, artistic composition, dramatic rim lighting, acid yellow accent, minimal studio",
      motion: "Slow orbital camera around Copic markers, light catches barrel surfaces, elegant rotation, cinematic commercial quality",
    },
    {
      title: "Copic Award 2026",
      narration: "Mayo 1 – Junio 30, 2026. La convocatoria está abierta. ¿Participas?",
      imgRef: "https://www.boykot.cl/wp-content/uploads/2023/06/copic-chile-768x492.webp",
      prompt: "Professional studio shot of Copic Sketch marker set, black background #000000, acid yellow #CCFF00 dramatic rim lighting, product floating in space, ultra minimal, premium quality, no text, no people",
      motion: "Copic marker set slowly rotates in darkness, yellow rim light sweeps across, premium commercial presentation, slow reveal",
    },
  ];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    await sendTelegram(`⏳ Escena ${i+1}/3: <b>${scene.title}</b>\n<i>${scene.narration}</i>`);

    try {
      // Gen-4 Image con imagen real de referencia
      const imageTask = await runway.textToImage.create({
        model: 'gen4_image',
        promptText: scene.prompt,
        ratio: '1920:1080',
        referenceImages: [{ uri: scene.imgRef, weight: 0.8 }],
      }).waitForTaskOutput();

      const renderUrl = imageTask.output[0];
      await sendTelegramPhoto(renderUrl, `🎨 ${scene.title}`);

      // Gen-4.5 — video
      const videoTask = await runway.imageToVideo.create({
        model: RUNWAY_MODEL,
        promptImage: renderUrl,
        promptText: scene.motion,
        duration: durationForModel(RUNWAY_MODEL, 5),
        ratio: '1280:720',
      }).waitForTaskOutput();

      const caption = `🏆 <b>${scene.title}</b>\n\n<i>"${scene.narration}"</i>\n\n📅 Copic Award 2026: Mayo 1 – Junio 30\n🛒 Copic Markers en boykot.cl\n#copicaward2026 #copic #boykot #artechileno`;
      await sendTelegramVideo(videoTask.output[0], caption);

      await new Promise(r => setTimeout(r, 5000));

    } catch(e) {
      await sendTelegram(`❌ Error escena ${i+1}: ${e.message}`);
    }
  }

  await sendTelegram(`✅ <b>Copic Award 2026 content listo</b>\n🎬 3 videos generados\n\n📅 Inscripciones abiertas Mayo 1\n🔗 copicaward.com · boykot.cl`);
}