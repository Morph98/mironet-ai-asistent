// ============================================================
// MIRONET AI ASISTENT — Render.com verze s IT feedem
// ============================================================
const express = require('express');
const xml2js  = require('xml2js');
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
  FEED_URL:  process.env.FEED_URL  || '',
  FEED_FILE: path.join(__dirname, 'feed.xml'),
  PORT: process.env.PORT || 3001,
  MODEL: 'claude-sonnet-4-6',
  ACCESS_PASSWORD: process.env.ACCESS_PASSWORD || 'Mironet2026+',
  POBOCKY: [
    { nazev: 'Praha 4 — Na Strzi',     adresa: 'Na Strzi 1702/65, 140 00 Praha 4' },
    { nazev: 'Praha 8 — Karlin',        adresa: 'Thamova 289/13, 186 00 Praha 8'  },
    { nazev: 'Kladno',                  adresa: 'Cs. armady 1578, 272 01 Kladno'  },
    { nazev: 'Plzen',                   adresa: 'Borska 3, 301 00 Plzen'           },
    { nazev: 'Brno',                    adresa: 'Prazakova 1008/69, 639 00 Brno'   },
    { nazev: 'Jablonec nad Nisou',      adresa: 'Liberecka 102/11, 466 01 Jablonec'},
    { nazev: 'Nupaky (vydejni sklad)',  adresa: 'Nupaky 48, 251 01 Ricany'         },
  ]
};

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

let products = [];

function loadProductsFromXml(xml) {
  xml2js.parseString(xml, { explicitArray: false }, (err, result) => {
    if (err) { console.error('Chyba XML:', err.message); return; }
    const items = result?.SHOP?.SHOPITEM || [];
    const arr = Array.isArray(items) ? items : [items];
    products = arr.map(item => ({
      nazev:      item.PRODUCTNAME || '',
      cena:       parseFloat(item.PRICE_VAT || item.PRICE || 0),
      url:        item.URL || '',
      dostupnost: item.AVAIL || '0',
      kategorie:  item.CATEGORYTEXT || '',
      vyrobce:    item.MANUFACTURER || '',
      popis:      item.DESCRIPTION || '',
      imgurl:     item.IMAGE_LINK || '',
    })).filter(p => p.nazev);
    console.log('Nacteno ' + products.length + ' produktu');
  });
}

function loadProducts() {
  if (CONFIG.FEED_URL) {
    console.log('Nacitam feed z URL:', CONFIG.FEED_URL);
    const proto = CONFIG.FEED_URL.startsWith('https') ? https : http;
    proto.get(CONFIG.FEED_URL, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => loadProductsFromXml(data));
    }).on('error', err => { console.error('Chyba feedu:', err.message); loadFromFile(); });
  } else { loadFromFile(); }
}

function loadFromFile() {
  if (!fs.existsSync(CONFIG.FEED_FILE)) { console.warn('feed.xml nenalezen'); return; }
  try { loadProductsFromXml(fs.readFileSync(CONFIG.FEED_FILE, 'utf-8')); }
  catch(e) { console.error('Chyba cteni feed.xml:', e.message); }
}

const STOP = new Set(['pro','ke','na','do','ze','pri','jak','jaky','kde','co','ktery','ktera','ktere','nebo','jen','chci','mam','mit','hledam','vybrat','koupit','poradit','nejlepsi','doporuct']);

const CAT_RULES = [
  { words: ['notebook','laptop','ultrabook'], must: ['notebooky','notebook'] },
  { words: ['monitor','displej'], must: ['monitory','monitor'] },
  { words: ['graficka karta','grafiku','gpu','rtx','gtx','radeon','geforce'], must: ['graficke karty','graficka'] },
  { words: ['procesor','cpu','ryzen','intel core'], must: ['procesory','procesor'] },
  { words: ['ram','pamet','dimm','ddr'], must: ['pameti','ram','dimm'] },
  { words: ['ssd','nvme','pevny disk','hdd'], must: ['ssd','hdd','disky'] },
  { words: ['tiskarna','laserova','inkoustova'], must: ['tiskarny','tiskarna'] },
  { words: ['toner','cartridge','naplne','kazeta'], must: ['spotrebni material','toner','cartridge'] },
  { words: ['router','wifi','wi-fi','switch'], must: ['routery','switche','site','wifi'] },
  { words: ['klavesnice','keyboard'], must: ['klavesnice'] },
  { words: ['mys','mouse'], must: ['mysi','mys'] },
  { words: ['sluchatka','headset'], must: ['sluchatka'] },
  { words: ['tablet','ipad'], must: ['tablety','tablet'] },
  { words: ['telefon','smartphone','iphone','samsung','xiaomi'], must: ['telefony','smartphone','mobilni'] },
  { words: ['playstation','xbox','nintendo','ps5','konzole'], must: ['konzole','playstation','xbox'] },
  { words: ['projektor'], must: ['projektory','projektor'] },
  { words: ['televize','televizor','smart tv'], must: ['televize','televizory'] },
  { words: ['fotoaparat','zrcadlovka','dslr'], must: ['fotoaparaty','fotoaparat'] },
  { words: ['hdmi','usb kabel','displayport','kabel'], must: ['kabely','konektory'] },
  { words: ['gril','sekacka','zahradni'], must: ['zahrada','grily','zahradni'] },
];

function search(query, max) {
  max = max || 5;
  if (products.length === 0) return [];
  const q = query.toLowerCase();

  let catFilter = [];
  for (const rule of CAT_RULES) {
    if (rule.words.some(w => q.includes(w))) { catFilter = rule.must; break; }
  }

  const kws = q.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
  const bm = q.match(/(\d[\d\s]{0,6})\s*(kc|czk|tisic|tis|k\b)/);
  const budget = bm ? parseFloat(bm[1].replace(/\s/g,'')) * (/tis|k\b/.test(bm[2]) ? 1000 : 1) : null;

  let pool = products;
  if (catFilter.length > 0) {
    const cf = products.filter(p => catFilter.some(f => (p.kategorie + ' ' + p.nazev).toLowerCase().includes(f)));
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

function buildPrompt(found) {
  const pobocky = CONFIG.POBOCKY.map(p => '- ' + p.nazev + ': ' + p.adresa).join('\n');
  const katalog = found.length > 0
    ? '\n\nAKTUALNI PRODUKTY Z KATALOGU MIRONET:\n' + found.map(p => {
        const popis = p.popis ? ' | ' + p.popis.substring(0, 200).replace(/\s+/g, ' ') : '';
        return '- ' + p.nazev + ' | ' + p.cena + ' | ' + p.dostupnost + (p.url ? ' | ' + p.url : '') + popis;
      }).join('\n')
    : '\n\n(Katalog neobsahuje presnou shodu — nasmer na mironet.cz nebo linku 777 900 777)';

  return 'Jsi AI asistent e-shopu Mironet.cz — ceskeho specialisty na IT techniku, notebooky, komponenty, monitory, sitove prvky, tiskarny, telefony a spotrebni elektroniku.\n\nKomunikujes cesky, pratelsky a odborne. Pises v kratkych odstavcich bez odrazek a BEZ markdown formatovani. Pis gramaticky spravne cesky.\n\nPOBOCKY MIRONET:\n' + pobocky + '\n\nZAKAZNICKA LINKA: 777 900 777 (Po-Pa 8-17 h)\nOBJEDNAVKY: mironet.cz/muj-ucet\n\nPRAVIDLA:\n- Navazuj na celou historii konverzace\n- Pokud zakaznik upresni pozadavek nebo rozpocet, ihned reaguj\n- Doporucuj produkty z katalogu nize — mas jejich aktualni ceny a dostupnost\n- Technicke parametry vysvetluj jednodusse\n- Nikdy nevymyslej produkty ani ceny mimo katalog\n- Max 4-5 vet na odpoved' + katalog;
}

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
        try { const d = JSON.parse(data); if (d.error) return reject(new Error(d.error.message)); resolve(d?.content?.[0]?.text || 'Omlouvam se, nastala chyba.'); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

app.post('/chat', requireAuth, async (req, res) => {
  const { messages = [], userMessage } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'Chybi userMessage' });
  if (!CONFIG.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY neni nastaven' });

  const SERVISNI = /objednavk|dorucen|doprav|vracen|reklamac|stav obj|kdy prijde|zasil|vymena|storno|platba|faktura/i;
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
  res.json({ status: 'ok', model: CONFIG.MODEL, produktu: products.length, apiKlicNastaven: !!CONFIG.ANTHROPIC_API_KEY, pobocky: CONFIG.POBOCKY.map(p => p.nazev) });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

loadProducts();
app.listen(CONFIG.PORT, () => {
  console.log('Mironet AI Asistent bezi na portu ' + CONFIG.PORT);
  if (!CONFIG.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY neni nastaven!');
});
