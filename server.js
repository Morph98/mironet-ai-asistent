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
    if (nazev && parseInt(avail) <= 14) {
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
  // Notebooky - kategorie "Notebooky | ..."
  { words: ['notebook','laptop','ultrabook','macbook','přenosný počítač'],
    must: ['Notebooky | '] },
  // Monitory - kategorie "Monitory | ..."
  { words: ['monitor','displej','lcd','obrazovka'],
    must: ['Monitory | '] },
  // Grafické karty
  { words: ['grafická karta','grafiku','gpu','rtx','gtx','radeon','geforce','grafická'],
    must: ['Komponenty | Grafické karty'] },
  // Procesory
  { words: ['procesor','cpu','ryzen','core i5','core i7','core i9','intel core'],
    must: ['Komponenty | Procesory'] },
  // RAM paměti
  { words: ['ram','paměť ram','dimm','ddr4','ddr5','sodimm'],
    must: ['Komponenty | Paměti RAM'] },
  // SSD a disky
  { words: ['ssd','nvme','m.2','pevný disk','hdd','harddisk'],
    must: ['Komponenty | SSD', 'Komponenty | HDD'] },
  // Flash disky
  { words: ['flash disk','usb disk','pendrive'],
    must: ['Komponenty | Flash disky'] },
  // NAS
  { words: ['nas','síťové úložiště','network storage'],
    must: ['Komponenty | Datová úložiště NAS'] },
  // Tiskárny - kategorie "Tiskárny a multifunkce | ..."
  { words: ['tiskárna','laserová tiskárna','inkoustová tiskárna','multifunkční tiskárna','3d tiskárna'],
    must: ['Tiskárny a multifunkce | '] },
  // Spotřební materiál (tonery, cartridge)
  { words: ['toner','cartridge','náplň do tiskárny','inkoustová náplň','kazeta do tiskárny'],
    must: ['Spotřební materiál | Spotřební materiál pro tiskárny'] },
  // Routery a WiFi
  { words: ['router','wifi router','wi-fi router','mesh','access point'],
    must: ['Sítě | Routery', 'Sítě | Access Pointy', 'Sítě | MikroTik'] },
  // Switche
  { words: ['switch','síťový přepínač'],
    must: ['Sítě | Switche', 'Sítě | Cisco Small Business'] },
  // Klávesnice
  { words: ['klávesnice','keyboard','mechanická klávesnice'],
    must: ['Klávesnice | '] },
  // Myši
  { words: ['myš','myši','herní myš','bezdrátová myš'],
    must: ['Myši | '] },
  // Sluchátka
  { words: ['sluchátka','headset','bezdrátová sluchátka','airpods'],
    must: ['Sluchátka | '] },
  // Tablety
  { words: ['tablet','ipad','android tablet'],
    must: ['Tablety | '] },
  // Telefony - CHYTRÉ telefony (ne tlačítkové)
  { words: ['smartphone','chytrý telefon','android telefon','iphone','samsung galaxy','xiaomi','motorola','google pixel','oneplus','honor','realme','vivo','poco'],
    must: ['Telefony | Mobilní telefony | Apple', 'Telefony | Mobilní telefony | Samsung', 'Telefony | Mobilní telefony | Xiaomi', 'Telefony | Mobilní telefony | Motorola', 'Telefony | Mobilní telefony | Google', 'Telefony | Mobilní telefony | OnePlus', 'Telefony | Mobilní telefony | HONOR', 'Telefony | Mobilní telefony | Realme', 'Telefony | Mobilní telefony | POCO', 'Telefony | Mobilní telefony | VIVO', 'Telefony | Mobilní telefony | ZTE'] },
  // Obecně mobilní telefon
  { words: ['telefon','mobil','mobilní telefon'],
    must: ['Telefony | Mobilní telefony'] },
  // Herní konzole
  { words: ['playstation','xbox','nintendo','ps5','ps4','konzole'],
    must: ['Herní konzole', 'Konzole | '] },
  // Projektory
  { words: ['projektor'],
    must: ['Projektory | '] },
  // Televize
  { words: ['televize','televizor','smart tv','oled tv'],
    must: ['Televize | '] },
  // Fotoaparáty
  { words: ['fotoaparát','zrcadlovka','dslr','bezzrcadlovka'],
    must: ['Fotoaparáty | '] },
  // Kabely HDMI, USB
  { words: ['hdmi kabel','displayport kabel','usb kabel'],
    must: ['Příslušenství | Kabely a redukce'] },
  // Reproduktory, soundbary
  { words: ['reproduktor','soundbar','bluetooth reproduktor'],
    must: ['Reproduktory | ', 'Soundbary | ', 'Audio-Video | Reproduktory'] },
  // Zahrada
  { words: ['gril','sekačka','zahradní'],
    must: ['Zahrada | '] },
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
  // Budget parsing - zachytit "10 000 Kč", "10000 Kč", "10 tisíc"
  const bmRaw = q.match(/(\d[\d\s]{0,8})\s*(k[cč]|czk|tis[íi][cč]?|tis\.?|k\b)/i);
  const budget = bmRaw
    ? parseFloat(bmRaw[1].replace(/\s/g,'')) * (/tis|k\b/i.test(bmRaw[2]) && !/kc|kč/i.test(bmRaw[2]) ? 1000 : 1)
    : null;

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
      dostupnost: p.dostupnost === '0' ? 'Skladem' : (parseInt(p.dostupnost) <= 3 ? 'Do 3 dni' : 'Do ' + p.dostupnost + ' dni'),
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

app.get('/debug-phones', (req, res) => {
  const phones = products.filter(p => p.kategorie && p.kategorie.includes('Telefony | Mobiln'));
  res.json({
    celkem_produktu: products.length,
    telefony_celkem: phones.length,
    prvnich_10: phones.slice(0, 10).map(p => ({ nazev: p.nazev, avail: p.dostupnost, cena: p.cena, kat: p.kategorie }))
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: CONFIG.MODEL, produktu: products.length, apiKlic: !!CONFIG.ANTHROPIC_API_KEY, pobocky: CONFIG.POBOCKY.map(p => p.nazev) });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

loadProducts();
app.listen(CONFIG.PORT, () => { console.log('Mironet AI Asistent bezi na portu ' + CONFIG.PORT); });
