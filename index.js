import RunwayML from '@runwayml/sdk';
import cron from 'node-cron';
import fetch from 'node-fetch';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';

const runway = new RunwayML({ apiKey: process.env.RUNWAYML_API_SECRET });
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

// ── PROMPT ENGINE ─────────────────────────────────────────────
const PROMPT_TEMPLATES = {
  default: [
    {
      title: "Explosión Pigmento",
      visual_prompt: "Extreme slow motion macro: single drop of vivid magenta watercolor hitting white paper, pigment exploding outward in perfect fractal patterns, black background, 4K cinematic, no camera movement",
      caption: "El pigmento nunca miente. 🎨 #acuarela #boykot #arte"
    },
    {
      title: "El Pincel Ataca",
      visual_prompt: "Ultra slow motion: thick bristle brush loaded with cobalt blue paint striking white canvas, paint splattering in all directions, droplets suspended mid-air, dramatic side lighting, black background, macro lens",
      caption: "Cada trazo es una decisión. 🖌️ #pincel #boykot #arte"
    },
    {
      title: "Nacimiento del Color",
      visual_prompt: "Time lapse macro: multiple ink drops falling into clear water tank, crimson red meets electric yellow blooming underwater, colors colliding in slow motion, studio lighting, black background",
      caption: "El color nace solo. 🌈 #tinta #acuarela #boykot"
    }
  ],
  catalogo: [
    {
      title: "Holbein Macro",
      visual_prompt: "Extreme macro: Holbein watercolor tube being squeezed, vivid yellow paint emerging in slow motion, coiling and blooming on white surface, black studio background, cinematic 4K",
      caption: "Holbein — el estándar japonés. Disponible en boykot.cl 🇯🇵 #holbein #acuarela"
    },
    {
      title: "Princeton en Acción",
      visual_prompt: "Ultra slow motion macro: professional paint brush bristles splaying open underwater, loaded with crimson red paint, ink dispersing in perfect fan pattern, dark background, studio lighting",
      caption: "Princeton Velvetouch — precisión total. boykot.cl 🖌️ #princeton #pincel"
    },
    {
      title: "Fabriano Texture",
      visual_prompt: "Extreme close up: watercolor paint being absorbed into cotton paper fibers in real time, blue pigment bleeding through paper texture, macro lens pulling back slowly, warm studio lighting",
      caption: "Fabriano 300g — donde el arte respira. boykot.cl #fabriano #papel"
    }
  ],
};

function getScreenplay(theme) {
  if (!theme) return PROMPT_TEMPLATES.default;
  if (theme === 'catalogo' || theme === 'art supplies') return PROMPT_TEMPLATES.catalogo;

  // Dynamic theme — modify base prompts
  return [
    {
      title: `${theme} — Explosión`,
      visual_prompt: `Extreme slow motion macro: ${theme} concept visualized as vivid paint explosion on black background, single dominant color burst, fractal patterns, 4K cinematic`,
      caption: `${theme} en estado puro. 🎨 #boykot #arte`
    },
    {
      title: `${theme} — Flujo`,
      visual_prompt: `Ultra slow motion: liquid paint representing ${theme}, flowing and morphing in zero gravity, jewel-toned colors against black background, macro lens, dramatic studio lighting`,
      caption: `El flujo de ${theme}. 🖌️ #boykot #arte`
    },
    {
      title: `${theme} — Impacto`,
      visual_prompt: `Time lapse macro: ${theme} expressed through ink drops colliding in water tank, violent color explosion underwater, complementary colors mixing, studio lighting, cinematic`,
      caption: `${theme} — sin filtros. 🌈 #boykot #arte`
    }
  ];
}

async function generateScene(scene, model = 'gen4_turbo') {
  console.log(`🎬 ${scene.title} [${model}]`);
  
  const task = await runway.imageToVideo.create({
    model,
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

let lastUpdateId = 0;
async function pollTelegram() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
    const data = await res.json();
    for (const update of data.result || []) {
      lastUpdateId = update.update_id;
      const msg = update.message?.text;
      if (!msg) continue;
      console.log(`📱 ${msg}`);

      if (msg === '/start' || msg === '/help') {
        await sendTelegram(`🎥 <b>SISTEMA</b> — Director autónomo\n\nComandos:\n/produce — Film con señales del mundo\n/catalogo — Videos catálogo Boykot\n/tema [tema] — Video temático\n/films — Films producidos\n\nPowered by Runway Gen-4.5 + maarmapa.eth`);
      } else if (msg === '/produce') {
        await sendTelegram('🎬 Produciendo...');
        produce();
      } else if (msg === '/catalogo') {
        await sendTelegram('🛍️ Generando catálogo Boykot...');
        produce('catalogo');
      } else if (msg.startsWith('/tema ')) {
        const theme = msg.replace('/tema ', '').trim();
        await sendTelegram(`🎨 Tema: <b>${theme}</b>`);
        produce(theme);
      } else if (msg === '/films') {
        const dir = './films';
        const films = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        await sendTelegram(films.length ? `🎬 Films:\n${films.map(f=>`• ${f.replace('.json','')}`).join('\n')}` : 'No hay films. Usa /produce');
      }
    }
  } catch (err) {
    console.error('Telegram error:', err.message);
  }
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
        await sendTelegramVideo(videoUrl, `🎬 <b>${scene.title}</b>\n${scene.caption}\n\n<i>SISTEMA · maarmapa.eth · Powered by Runway</i>`);
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
  console.log('📱 Telegram: @Maarmapabot');
});
