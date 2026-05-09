import RunwayML from '@runwayml/sdk';
import cron from 'node-cron';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';

const runway = new RunwayML({ apiKey: process.env.RUNWAYML_API_SECRET });

// Hardcoded screenplay for testing pipeline
function getTestScreenplay(date) {
  return [
    {
      scene_number: 1,
      title: "La Ciudad Duerme",
      visual_prompt: "Aerial view of a Latin American city at night, neon lights reflecting on wet streets, cyberpunk aesthetic, graffiti on buildings, fog rolling through urban canyons, cinematic, slow drone movement",
      duration_seconds: 5,
      narration: "The city breathes between algorithms. La ciudad sueña en código."
    },
    {
      scene_number: 2,
      title: "El Pulso Digital",
      visual_prompt: "Close up of fiber optic cables glowing in dark server room, data streams visible as light particles, industrial decay around high tech equipment, neon green and purple light, cinematic macro shot",
      duration_seconds: 5,
      narration: "Every signal carries a dream. Cada señal lleva un sueño perdido."
    },
    {
      scene_number: 3,
      title: "Amanecer Binario",
      visual_prompt: "Dawn breaking over concrete brutalist architecture, golden light hitting graffiti murals, empty streets with scattered code symbols projected on walls, hopeful yet melancholic, cinematic wide shot",
      duration_seconds: 5,
      narration: "Tomorrow is already being generated. El mañana ya está siendo generado."
    }
  ];
}

async function generateScene(scene) {
  console.log(`🎬 Scene ${scene.scene_number}: ${scene.title}`);
  const task = await runway.imageToVideo.create({
    model: 'gen4_turbo',
    promptImage: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=1280&q=80',
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

async function produce() {
  const date = new Date().toISOString().split('T')[0];
  console.log(`\n🎥 SISTEMA — Producing film for ${date}`);

  try {
    const screenplay = getTestScreenplay(date);
    console.log('✍️  Using test screenplay (3 scenes)');

    const scenes = [];
    for (const scene of screenplay) {
      const videoUrl = await generateScene(scene);
      scenes.push({ ...scene, videoUrl });
    }

    const manifest = {
      title: `SISTEMA — ${date}`,
      date,
      scenes,
      produced_by: 'SISTEMA · autonomous film director',
      oracle: 'maarmapa.eth',
    };

    const dir = './films';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(manifest, null, 2));

    console.log(`✅ Film produced: ${date}`);
    console.log('🎬 Videos:', scenes.map(s => s.videoUrl));
    return manifest;
  } catch (err) {
    console.error('❌ Production failed:', err);
  }
}

cron.schedule('0 3 * * *', () => produce());

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'SISTEMA online', time: new Date().toISOString() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/produce') {
    res.writeHead(202);
    res.end(JSON.stringify({ message: 'Production started' }));
    produce();
    return;
  }

  if (req.method === 'GET' && req.url === '/films') {
    const dir = './films';
    const films = fs.existsSync(dir) ? fs.readdirSync(dir).map(f => ({
      date: f.replace('.json', ''),
      data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    })) : [];
    res.writeHead(200);
    res.end(JSON.stringify({ films }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🎥 SISTEMA running on port ${PORT}`);
  console.log('🔧 Manual trigger: POST /produce');
});
