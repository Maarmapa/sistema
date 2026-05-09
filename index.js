import RunwayML from '@runwayml/sdk';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import fetch from 'node-fetch';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';

const runway = new RunwayML({ apiKey: process.env.RUNWAYML_API_SECRET });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'REVOKED_TOKEN';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1244921942';

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

async function getBoykotCatalog() {
  return [
    { name: 'Acuarela Holbein 15ml', description: 'Pintura acuarela profesional japonesa, colores vibrantes', price: 4900 },
    { name: 'Pincel Princeton Redondo', description: 'Pincel sintético premium para acuarela y acrílico', price: 3500 },
    { name: 'Papel Fabriano 300g', description: 'Papel de acuarela 100% algodón, textura fina', price: 8900 },
    { name: 'Acrílico Liquitex 59ml', description: 'Pintura acrílica profesional, alta pigmentación', price: 5900 },
    { name: 'Paleta de porcelana', description: 'Paleta mezcla colores, fácil limpieza', price: 2900 },
  ];
}

function getTestScreenplay(theme) {
  return [
    {
      scene_number: 1,
      title: "El Color Emerge",
      visual_prompt: `Extreme macro of watercolor paint dissolving in water, vibrant pigments blooming in slow motion, ${theme || 'deep blues and greens'} expanding, black background, cinematic`,
      duration_seconds: 5,
      caption: "El color tiene vida propia. 🎨 #acuarela #boykot #arte"
    },
    {
      scene_number: 2,
      title: "La Textura del Arte",
      visual_prompt: "Close up of watercolor paper texture, brush strokes in slow motion, golden light catching paper grain, cinematic macro",
      duration_seconds: 5,
      caption: "La textura importa. #fabriano #acuarela #boykot"
    },
    {
      scene_number: 3,
      title: "Pincel y Destino",
      visual_prompt: `Artist brush tip loading with ${theme || 'vibrant red'} paint, droplets in slow motion, dark moody background, cinematic`,
      duration_seconds: 5,
      caption: "Cada trazo es una decisión. 🖌️ #pincel #arte #boykot"
    }
  ];
}

async function generateScene(scene) {
  console.log(`🎬 Scene ${scene.scene_number}: ${scene.title}`);
  const task = await runway.imageToVideo.create({
    model: 'gen4_turbo',
    promptImage: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=1280&q=80',
    promptText: scene.visual_prompt,
    duration: scene.duration_seconds,
    ratio: '1280:720',
  });

  let result = task;
  while (result.status !== 'SUCCEEDED' && result.status !== 'FAILED') {
    await new Promise(r => setTimeout(r, 3000));
    result = await runway.tasks.retrieve(task.id);
    console.log(`  Status: ${result.status}`);
  }

  if (result.status === 'FAILED') throw new Error(`Scene ${scene.scene_number} failed`);
  return result.output[0];
}

let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
    const data = await res.json();
    for (const update of data.result || []) {
      lastUpdateId = update.update_id;
      const msg = update.message?.text;
      if (!msg) continue;
      console.log(`📱 Telegram: ${msg}`);
      if (msg === '/start' || msg === '/help') {
        await sendTelegram(`🎥 <b>SISTEMA</b> — Director de cine autónomo\n\nComandos:\n/produce — Genera film\n/tema [tema] — Video con tema específico\n/catalogo — Videos del catálogo Boykot\n/films — Films producidos\n\nPowered by Runway + maarmapa.eth`);
      } else if (msg === '/produce') {
        await sendTelegram('🎬 Iniciando producción...');
        produce();
      } else if (msg === '/catalogo') {
        await sendTelegram('🛍️ Generando videos Boykot...');
        produce('art supplies, watercolor, paint brushes');
      } else if (msg.startsWith('/tema ')) {
        const theme = msg.replace('/tema ', '').trim();
        await sendTelegram(`🎨 Generando: <b>${theme}</b>...`);
        produce(theme);
      } else if (msg === '/films') {
        const dir = './films';
        const films = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        await sendTelegram(films.length ? `🎬 Films:\n${films.map(f => `• ${f.replace('.json','')}`).join('\n')}` : 'No hay films aún. Usa /produce');
      }
    }
  } catch (err) {
    console.error('Telegram error:', err.message);
  }
}

async function produce(theme = null) {
  const date = new Date().toISOString().split('T')[0];
  console.log(`\n🎥 SISTEMA — ${date}${theme ? ` | ${theme}` : ''}`);
  try {
    await sendTelegram(`🎬 <b>SISTEMA produciendo</b>\n📅 ${date}${theme ? `\n🎨 Tema: ${theme}` : ''}`);
    const screenplay = getTestScreenplay(theme);
    const scenes = [];
    for (const scene of screenplay) {
      await sendTelegram(`⏳ Generando: <b>${scene.title}</b>...`);
      try {
        const videoUrl = await generateScene(scene);
        scenes.push({ ...scene, videoUrl });
        await sendTelegramVideo(videoUrl, `🎬 <b>${scene.title}</b>\n${scene.caption}\n\n<i>SISTEMA · maarmapa.eth</i>`);
      } catch (err) {
        await sendTelegram(`❌ Error escena ${scene.scene_number}: ${err.message}`);
      }
    }
    const dir = './films';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const filename = `${date}${theme ? '-'+theme.slice(0,15).replace(/\s+/g,'-') : ''}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify({ title: `SISTEMA — ${date}`, date, theme, scenes }, null, 2));
    await sendTelegram(`✅ <b>Film completo</b> — ${scenes.length} videos listos`);
  } catch (err) {
    console.error('❌', err);
    await sendTelegram(`❌ Error: ${err.message}`);
  }
}

cron.schedule('0 3 * * *', () => produce());
setInterval(pollTelegram, 3000);

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'SISTEMA online', time: new Date().toISOString() }));
  } else if (req.method === 'POST' && req.url === '/produce') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const { theme } = body ? JSON.parse(body) : {};
      res.writeHead(202);
      res.end(JSON.stringify({ message: 'Production started', theme: theme || null }));
      produce(theme);
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
  console.log('📱 Telegram: @Maarmapa_bot');
});
