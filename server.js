const express = require('express');
const multer = require('multer');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public', { etag: false, maxAge: 0 }));
app.use('/uploads', express.static('uploads'));

// Dossier uploads
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// STATE serveur
const sessions = {};

// ── ROUTES ──────────────────────────────

// Créer une session (prof)
app.post('/api/session/create', (req, res) => {
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  sessions[code] = {
    code,
    phase: 'config',
    equipes: [],
    fiches: {},
    pitchIndex: 0,
    timerLeft: 300,
    timerRunning: false,
    votes: {},
    connectes: 0,
    images: {}
  };
  res.json({ code });
});

// Rejoindre une session (élève)
app.post('/api/session/join', (req, res) => {
  const { code } = req.body;
  if (!sessions[code]) return res.status(404).json({ error: 'Code invalide' });
  sessions[code].connectes++;
  broadcast(code, { type: 'connectes', count: sessions[code].connectes });
  res.json({ session: sessions[code] });
});

// Lire l'état d'une session
app.get('/api/session/:code', (req, res) => {
  const s = sessions[req.params.code];
  if (!s) return res.status(404).json({ error: 'Session introuvable' });
  res.json(s);
});

// Mettre à jour l'état (prof)
app.post('/api/session/:code/update', (req, res) => {
  const s = sessions[req.params.code];
  if (!s) return res.status(404).json({ error: 'Session introuvable' });
  Object.assign(s, req.body);
  broadcast(req.params.code, { type: 'state', session: s });
  res.json(s);
});

// Soumettre une fiche élève
app.post('/api/session/:code/fiche', (req, res) => {
  const s = sessions[req.params.code];
  if (!s) return res.status(404).json({ error: 'Session introuvable' });
  const { equipe, fiche } = req.body;
  s.fiches[equipe] = fiche;
  broadcast(req.params.code, { type: 'fiche', equipe, fiche });
  res.json({ ok: true });
});

// Voter
app.post('/api/session/:code/vote', (req, res) => {
  const s = sessions[req.params.code];
  if (!s) return res.status(404).json({ error: 'Session introuvable' });
  const { equipe } = req.body;
  s.votes[equipe] = (s.votes[equipe] || 0) + 1;
  broadcast(req.params.code, { type: 'vote', votes: s.votes });
  res.json({ ok: true });
});

// Upload image produit
app.post('/api/session/:code/image', upload.single('image'), (req, res) => {
  const s = sessions[req.params.code];
  if (!s) return res.status(404).json({ error: 'Session introuvable' });
  const { equipe } = req.body;
  const url = `/uploads/${req.file.filename}`;
  s.images[equipe] = url;
  broadcast(req.params.code, { type: 'image', equipe, url });
  res.json({ url });
});

// Proxy API Claude (pour ne pas exposer la clé côté client)
app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Clé API manquante' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
     body: JSON.stringify({
     model: 'claude-haiku-4-5-20251001',
     max_tokens: 1500,
     system: "Tu réponds UNIQUEMENT avec du JSON valide. Aucun texte avant ou après. Aucun markdown. Aucune explication.",
     messages: req.body.messages
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WEBSOCKET ────────────────────────────
const clients = {}; // code => Set<ws>

wss.on('connection', (ws, req) => {
  let sessionCode = null;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'join') {
        sessionCode = data.code;
        if (!clients[sessionCode]) clients[sessionCode] = new Set();
        clients[sessionCode].add(ws);
        ws.send(JSON.stringify({ type: 'state', session: sessions[sessionCode] }));
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    if (sessionCode && clients[sessionCode]) {
      clients[sessionCode].delete(ws);
    }
  });
});

function broadcast(code, data) {
  if (!clients[code]) return;
  const msg = JSON.stringify(data);
  clients[code].forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PitchZone running on port ${PORT}`));
