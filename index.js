import RunwayML from '@runwayml/sdk';
import cron from 'node-cron';
import fetch from 'node-fetch';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';

const runway = new RunwayML({ apiKey: process.env.RUNWAYML_API_SECRET });
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
    model: 'gen4_turbo',
    promptImage: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=1280&q=80',
    promptText: scene.visual_prompt,
    duration: 5,
    ratio: '1280:720',
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

    // Gen-4 Image — render editorial
    const imageTask = await runway.textToImage.create({
      model: 'gen4_image',
      promptText: `Professional editorial product render, black background #000000, acid yellow #CCFF00 dramatic rim lighting, ultra minimal studio, high contrast, same product exact shape and colors, photorealistic, no people, no text`,
      referenceImages: [{ uri: imgUrl, weight: 0.85 }],
      ratio: '1920:1080',
    }).waitForTaskOutput();

    const renderUrl = imageTask.output[0];
    await sendTelegramPhoto(renderUrl, `🎨 Render: ${productName}`);
    await sendTelegram(`🎬 Animando con Gen-4.5...`);

    // Gen-4.5 — video
    const videoTask = await runway.imageToVideo.create({
      model: 'gen4_turbo',
      promptImage: renderUrl,
      promptText: `Slow cinematic product reveal, ${productName}, dramatic lighting sweeps across surface, elegant rotation, black background, yellow light accent`,
      duration: 5,
      ratio: '1280:720',
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
        await sendTelegram(`🎥 <b>SISTEMA</b> — Director autónomo + Fábrica Boykot\n\n<b>🎬 Mini Docu</b>\n/produce — Film con señales del mundo\n/tema [tema] — Video temático\n/films — Films producidos\n\n<b>🛍️ Boykot Factory</b>\n/url [url] — Video de producto boykot.cl
/docu-boykot [marca] — Mini film de marca
/marca [marca] [N] — Photoshoot masivo de marca (Gen-4 Image + Gen-4.5) (angelus/copic/molotow/holbein)\n/boykot-top — Top productos en stock\n/boykot-liquidacion — Últimas unidades\n/boykot-marcas — Por marcas top\n\nPowered by Runway + maarmapa.eth`);
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
    console.error('Telegram error:', err.message);
  }
}

// ── SCHEDULER ─────────────────────────────────────────────────
cron.schedule('0 3 * * *', () => produce());
cron.schedule('0 10 * * *', () => runBoykotFactory('top', 3));
cron.schedule('0 16 * * *', () => runBoykotFactory('liquidacion', 3));

setInterval(pollTelegram, 3000);

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
          model: 'gen4_turbo',
          promptImage: renderUrl,
          promptText: scene.motion + ', cinematic, slow motion, dramatic',
          duration: 5,
          ratio: '1280:720',
        }).waitForTaskOutput();

        videoUrl = videoTask.output[0];
      } else {
        // Fallback — text only
        const task = await runway.imageToVideo.create({
          model: 'gen4_turbo',
          promptImage: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=1280&q=80',
          promptText: scene.motion + ', cinematic, dramatic lighting, black background',
          duration: 5,
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
        model: 'gen4_turbo',
        promptImage: renderUrl,
        promptText: `Slow cinematic product presentation, ${variantDesc}, elegant 360 rotation, dramatic studio lighting sweeps across product surface, black background, acid yellow light accent, commercial quality`,
        duration: 5,
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
        model: 'gen4_turbo',
        promptImage: renderUrl,
        promptText: scene.motion,
        duration: 5,
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