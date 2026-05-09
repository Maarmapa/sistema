import Anthropic from '@anthropic-ai/sdk';
import RunwayML from '@runwayml/sdk';
import cron from 'node-cron';
import fetch from 'node-fetch';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const runway = new RunwayML({ apiKey: process.env.RUNWAYML_API_SECRET });

async function getWorldSignals() {
  try {
    const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    const ids = await res.json();
    const top5 = ids.slice(0, 5);
    const stories = await Promise.all(
      top5.map(async (id) => {
        const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        return r.json();
      })
    );
    return stories.filter(s => s && s.title).map(s => s.title).join('\n');
  } catch (e) {
    return 'The world is dreaming. Technology evolves. Cities breathe.';
  }
}

async function writeScreenplay(signals) {
  const res = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are SISTEMA — autonomous cyberpunk Latin American film director.

Today's world signals:
${signals}

Write a 3-scene short film. Each scene needs:
- scene_number (1, 2, 3)
- title (short, evocative)
- visual_prompt (for Runway Gen-4.5: cinematic, 50-80 words, no faces)
- duration_seconds (5)
- narration (1-2 sentences, poetic, bilingual Spanish/English)

Aesthetic: cyberpunk latinoamericano, urban decay, neon and concrete, graffiti.

Respond ONLY with valid JSON array, no markdown:
[{"scene_number":1,"title":"...","visual_prompt":"...","duration_seconds":5,"narration":"..."}]`
    }]
  });

  const text = res.content[0].type === 'text' ? res.content[0].text : '[]';
  return JSON.parse(text.trim());
}

async function generateScene(scene) {
  console.log(`🎬 Scene ${scene.scene_number}: ${scene.title}`);
  const task = await runway.imageToVideo.create({
    model: 'gen4_turbo',
    promptImage: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=1280&q=80',
    promptText: scene.visual_prompt,
    duration: scene.duration_seconds,
    ratio: '1280:768',
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
    console.log('📡 Getting world signals...');
    const signals = await getWorldSignals();

    console.log('✍️  Writing screenplay...');
    const screenplay = await writeScreenplay(signals);

    const scenes = [];
    for (const scene of screenplay) {
      const videoUrl = await generateScene(scene);
      scenes.push({ ...scene, videoUrl });
    }

    const manifest = {
      title: `SISTEMA — ${date}`,
      date,
      signals: signals.split('\n').slice(0, 5),
      scenes,
      produced_by: 'SISTEMA · autonomous film director',
      oracle: 'maarmapa.eth',
    };

    const dir = './films';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(manifest, null, 2));

    console.log(`✅ Film produced: ${date}`);
    return manifest;
  } catch (err) {
    console.error('❌ Production failed:', err);
  }
}

// Daily at midnight Santiago time
cron.schedule('0 3 * * *', () => produce());

// HTTP server
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
    const films = fs.existsSync(dir) ? fs.readdirSync(dir).map(f => f.replace('.json', '')) : [];
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
  console.log('📅 Scheduled: daily midnight Santiago time');
  console.log('🔧 Manual trigger: POST /produce');
});
