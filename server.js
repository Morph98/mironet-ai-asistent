const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const crypto  = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());

const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  FEED_URL: process.env.FEED_URL || '',
  PORT: process.env.PORT || 3001,
  MODEL: 'claude-sonnet-4-6',
  ACCESS_PASSWORD: process.env.ACCESS_PASSWORD || 'Mironet2026+',
  POBOCKY: [
    { nazev: 'Praha 4', adresa: 'Na Strzi 1702/65, 140 00 Praha 4' },
    { nazev: 'Praha 8 - Karlin', adresa: 'Thamova 289/13, 186 00 Praha 8' },
    { nazev: 'Kladno', adresa: 'Cs. armady 1578, 272 01 Kladno' },
    { nazev: 'Plzen', adresa: 'Borska 3, 301 00 Plzen' },
    { nazev: 'Brno', adresa: 'Prazakova 1008/69, 639 00 Brno' },
    { nazev: 'Jablonec nad Nisou', adresa: 'Liberecka 102/11, 466 01 Jablonec' },
    { nazev: 'Nupaky (vydejni sklad)', adresa: 'Nupaky 48, 251 01 Ricany' },
  ]
};

// Session tokeny
const sessions = new Set();
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Neprihlaseni' });
  next();
}

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === CONFIG.ACCESS_PASSWORD) {
    const token = generateToken();
    sessions.add(token);
    setTimeout(() => sessions.delete(token), 24 * 60 * 60 * 1000);
    res.json({ token });
  } else {
    res.status(403).json({ error: 'Spatne heslo' });
  }
});

// Produkty
let products = [];

function getVal(str, tag) {
  const s = str.indexOf('<' + tag + '>');
  const e = str.indexOf('</' + tag + '>');
  if (s < 0 || e < 0) return '';
  let val = str.substring(s + tag.length + 2, e).trim();
  if (val.startsWith('<![CDATA[') && val.endsWith(']]>')) {
    val = val.substring(9, val.length - 3);
  }
  return val;
}

function parseXml(xml) {
  const result = [];
  let pos = 0;
  while (true) {
    const start = xml.indexOf('<SHOPITEM>', pos);
    if (start < 0) break;
    const end = xml.indexOf('</SHOPITEM>', start);
    if (end < 0) break;
    const item = xml.substring(start + 10, end);
    const nazev = getVal(item, 'PRODUCTNAME');
    const avail = getVal(item, 'AVAIL') || '99';
    if (nazev && parseInt(avail) <= 3) {
      result.push({
        nazev,
        cena: parseFloat(getVal(item, 'PRICE_VAT') || getVal(item, 'PRICE') || '0'),
        url: getVal(item, 'URL'),
        dostupnost: avail,
        kategorie: getVal(item, 'CATEGORYTEXT'),
        vyrobce: getVal(item, 'MANUFACTURER'),
        popis: getVal(item, 'DESCRIPTION').substring(0, 150),
        imgurl: getVal(item, 'IMAGE_LINK'),
      });
    }
    pos = end + 11;
  }
  return result;
}

function loadProducts() {
  if (CONFIG.FEED_URL) {
    const proto = CONFIG.FEED_URL.startsWith('https') ? https : http;
    proto.get(CONFIG.FEED_URL, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { products = parseXml(data); console.log('Feed URL: ' + products.length + ' produktu'); });
    }).on('error', err => { console.error('Feed URL chyba:', err.message); loadFromParts(); });
  } else {
    loadFromParts();
  }
}

function loadFromParts() {
  const parts = [];
  for (let i = 1; i <= 7; i++) {
    const f = path.join(__dirname, 'feed_part' + i + '.xml');
    if (fs.existsSync(f)) parts.push(f);
  }
  console.log('Nalezeno ' + parts.length + ' casti feedu');
  if (parts.length > 0) {
    products = [];
    for (let i = 0; i < parts.length; i++) {
      try {
        const xml = fs.readFileSync(parts[i], 'utf-8');
        const items = parseXml(xml);
        products = products.concat(items);
        console.log('Cast ' + (i+1) + ': +' + items.length + ' = ' + products.length);
      } catch(e) { console.error('Chyba casti ' + (i+1) + ':', e.message); }
    }
    console.log('Hotovo: ' + products.length + ' produktu');
  } else {
    const f = path.join(__dirname, 'feed.xml');
    if (fs.existsSync(f)) {
      products = parseXml(fs.readFileSync(f, 'utf-8'));
      console.log('feed.xml: ' + products.length + ' produktu');
    } else {
      console.warn('Zadny feed nenalezen');
    }
  }
}

// Stopslova
const STOP = new Set(['pro','ke','na','do','ze','jak','kde','co','nebo','jen','chci','mam','hledam','vybrat','koupit','nejlepsi','dobry']);

// Kategoriova pravidla
const CAT_RULES = [
  { words: ['notebook','laptop','ultrabook','macbook'], must: ['Notebooky | '] },
  { words: ['monitor','displej'], must: ['Monitory | '] },
  { words: ['graficka karta','gpu','rtx','gtx','radeon','geforce'], must: ['Grafick'] },
  { words: ['procesor','cpu','ryzen','intel core'], must: ['Procesory | '] },
  { words: ['ram','pamet','dimm','ddr'], must: ['Pam'] },
  { words: ['ssd','nvme','pevny disk','hdd'], must: ['Disky | ','SSD'] },
  { words: ['tiskarna','laserova','inkoustova'], must: ['Tisk'] },
  { words: ['toner','cartridge','naplne','kazeta'], must: ['Spot'] },
  { words: ['router','wifi','wi-fi'], must: ['Site | Routery','Site | MikroTik'] },
  { words: ['switch','prepinac sitovy'], must: ['Site | Switche','Site | Cisco'] },
  { words: ['klavesnice','keyboard'], must: ['Klavesnice | '] },
  { words: ['mys ','mouse','herni mys'], must: ['Mysi | '] },
  { words: ['sluchatka','headset'], must: ['Sluch'] },
  { words: ['tablet','ipad'], must: ['Tablety | '] },
  { words: ['telefon','smartphone','iphone','samsung','xiaomi','mobil'], must: ['Telefony | '] },
  { words: ['playstation','xbox','nintendo','ps5','konzole'], must: ['Herni konzole','Konzole'] },
  { words: ['projektor'], must: ['Projektory | '] },
  { words: ['televize','televizor','smart tv'], must: ['Televize | '] },
  { words: ['fotoaparat','zrcadlovka','dslr'], must: ['Fotoapar'] },
  { words: ['hdmi','usb kabel','displayport'], must: ['Kabely | '] },
  { words: ['gril','sekacka','zahradni'], must: ['Zahrada | '] },
  { words: ['reproduktor','soundbar'], must: ['Reproduktory | ','Soundbary | '] },
];

// Vyhledavani
function search(query, max) {
  max = max || 5;
  if (products.length === 0) return [];
  const q = query.toLowerCase();

  let catFilter = [];
  for (const rule of CAT_RULES) {
    if (rule.words.some(w => q.includes(w))) { catFilter = rule.must; break; }
  }

  const kws = q.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
  const bm = q.match(/(\d+)\s*(kc|czk|tisic|tis\b|k\b)/);
  const budget = bm ? parseFloat(bm[1]) * (/tis|k\b/.test(bm[2]) ? 1000 : 1) : null;

  let pool = products;
  if (catFilter.length > 0) {
    const cf = products.filter(p => catFilter.some(f => (p.kategorie + ' ' + p.nazev).toLowerCase().includes(f.toLowerCase())));
    if (cf.length >= 3) pool = cf;
  }
  if (budget && budget > 500) {
    const bf = pool.filter(p => p.cena > 0 && p.cena <= budget * 1.1);
    if (bf.length >= 2) pool = bf;
  }

  return pool.map(p => {
    const nl = p.nazev.toLowerCase();
    const hl = (p.kategorie + ' ' + p.vyrobce).toLowerCase();
    const ns = kws.reduce((s, kw) => s + (nl.includes(kw) ? 3 : 0), 0);
    const cs = kws.reduce((s, kw) => s + (hl.includes(kw) ? 1 : 0), 0);
    return { ...p, score: ns + cs + (p.dostupnost === '0' ? 1 : 0) };
  }).filter(p => p.score > 0)
    .sort((a, b) => b.score !== a.score ? b.score - a.score : a.cena - b.cena)
    .slice(0, max)
    .map(p => ({
      nazev: p.nazev,
      cena: p.cena > 0 ? Math.round(p.cena).toLocaleString('cs-CZ') + ' Kc' : 'cena na dotaz',
      url: p.url,
      dostupnost: p.dostupnost === '0' ? 'Skladem' : 'Dostupne za ' + p.dostupnost + ' dni',
      kategorie: p.kategorie,
      imgurl: p.imgurl,
    }));
}

// System prompt
function buildPrompt(found) {
  const pobocky = CONFIG.POBOCKY.map(p => '- ' + p.nazev + ': ' + p.adresa).join('\n');
  const katalog = found.length > 0
    ? '\n\nPRODUKTY Z KATALOGU:\n' + found.map(p =>
        '- ' + p.nazev + ' | ' + p.cena + ' | ' + p.dostupnost + (p.url ? ' | ' + p.url : '') +
        (p.popis ? ' | ' + p.popis.substring(0, 150) : '')
      ).join('\n')
    : '\n\n(Produkt nenalezen v katalogu - nasmer na mironet.cz nebo 777 900 777)';

  return 'Jsi AI asistent e-shopu Mironet.cz - ceskeho specialisty na IT techniku, notebooky, komponenty, monitory, tiskarny, telefony a elektroniku.\n\nKomunikujes cesky, pratelsky a odborne. Pises bez markdown formatovani. Pis gramaticky spravne cesky.\n\nPOBOCKY:\n' + pobocky + '\n\nLINKA: 777 900 777 (Po-Pa 8-17h)\nOBJEDNAVKY: mironet.cz/muj-ucet\n\nPravidla:\n- Navazuj na historii konverzace\n- Doporucuj produkty z katalogu nize\n- Nikdy nevymyslej produkty ani ceny\n- Max 4-5 vet' + katalog;
}

// Claude API
function callClaude(messages, systemText) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: CONFIG.MODEL, max_tokens: 800, system: systemText, messages });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': CONFIG.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const d = JSON.parse(data); if (d.error) return reject(new Error(d.error.message)); resolve(d?.content?.[0]?.text || 'Nastala chyba.'); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// Endpoints
app.post('/chat', requireAuth, async (req, res) => {
  const { messages = [], userMessage } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'Chybi userMessage' });
  if (!CONFIG.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API klic neni nastaven' });

  const SERVISNI = /objednavk|dorucen|doprav|vracen|reklamac|kdy prijde|zasil|storno|platba|faktura/i;
  const recent = messages.slice(-5).map(m => m.content).join(' ');
  const jeServisni = SERVISNI.test(userMessage) || SERVISNI.test(recent);

  const ctx = messages.slice(-3).map(m => m.content).join(' ') + ' ' + userMessage;
  const found = jeServisni ? [] : search(ctx);
  const history = [...messages, { role: 'user', content: userMessage }];

  try {
    const reply = await callClaude(history, buildPrompt(found));
    res.json({ reply, foundProducts: found });
  } catch(e) {
    console.error('Claude error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: CONFIG.MODEL, produktu: products.length, apiKlic: !!CONFIG.ANTHROPIC_API_KEY, pobocky: CONFIG.POBOCKY.map(p => p.nazev) });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

loadProducts();
app.listen(CONFIG.PORT, () => { console.log('Mironet AI Asistent bezi na portu ' + CONFIG.PORT); });
