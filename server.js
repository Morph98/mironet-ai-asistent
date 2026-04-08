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
    if (nazev) {  // Všechny produkty bez ohledu na dostupnost
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

// Parser parametrů z názvu produktu
function parseParams(nazev) {
  const n = nazev.toLowerCase();
  const params = {};

  // Velikost displeje: 6.7", 15.6", 27" atd.
  const disp = nazev.match(/(\d{1,2}\.?\d?)\s*"/);
  if (disp) params.displej = parseFloat(disp[1]);

  // RAM: 8GB, 16GB, 12+256GB (první číslo = RAM)
  const ram = nazev.match(/(\d+)\+\d+GB/);
  if (ram) params.ram = parseInt(ram[1]);

  // Úložiště: 256GB, 512GB, 1TB
  const stor = nazev.match(/\+(\d+)GB|\b(\d+)GB\b|\b(\d+)\s*TB\b/);
  if (stor) {
    const val = stor[1] || stor[2] || stor[3];
    params.uloziste = stor[3] ? parseInt(val) * 1024 : parseInt(val);
  }

  // OS
  if (n.includes('android')) {
    const ver = nazev.match(/Android\s*(\d+)/i);
    params.os = 'Android' + (ver ? ' ' + ver[1] : '');
  } else if (n.includes('ios') || n.includes('iphone') || n.includes('ipad') || n.includes('macbook')) {
    params.os = 'iOS/macOS';
  } else if (n.includes('windows')) {
    params.os = 'Windows';
  }

  // Barva
  const barvy = ['černá','bílá','modrá','červená','zelená','stříbrná','zlatá','fialová','růžová','šedá','titanová'];
  for (const b of barvy) {
    if (n.includes(b)) { params.barva = b; break; }
  }

  return params;
}

function paramsToStr(params) {
  const parts = [];
  if (params.displej) parts.push('displej: ' + params.displej + '"');
  if (params.ram) parts.push('RAM: ' + params.ram + 'GB');
  if (params.uloziste) parts.push(params.uloziste >= 1024 ? 'úložiště: ' + (params.uloziste/1024) + 'TB' : 'úložiště: ' + params.uloziste + 'GB');
  if (params.os) parts.push('OS: ' + params.os);
  if (params.barva) parts.push('barva: ' + params.barva);
  return parts.length > 0 ? ' [' + parts.join(', ') + ']' : '';
}

// Stopslova
const STOP = new Set(['pro','ke','na','do','ze','jak','kde','co','nebo','jen','chci','mam','hledam','vybrat','koupit','nejlepsi','dobry']);

// Kategoriova pravidla
const CAT_RULES = [
  // Kabely a redukce - MUSÍ být před notebooky/telefony, jinak "kabel pro notebook" matchne notebook
  { words: ['kabel','redukce','adaptér kabel','hdmi kabel','displayport kabel','usb kabel','usb-c kabel','usb c kabel','nabíjecí kabel','prodlužovací kabel','audio kabel','jack kabel','optický kabel'],
    must: ['Příslušenství | Kabely a redukce', 'Kabely a konektory', 'Kabely | '] },
  // Telefony - MUSÍ být před monitory, jinak "iphone s velkým displejem" matchne Monitory
  { words: ['smartphone','chytrý telefon','android telefon','iphone','samsung galaxy','xiaomi','motorola','google pixel','oneplus','honor','realme','vivo','poco'],
    must: ['Telefony | Mobilní telefony | Apple', 'Telefony | Mobilní telefony | Samsung', 'Telefony | Mobilní telefony | Xiaomi', 'Telefony | Mobilní telefony | Motorola', 'Telefony | Mobilní telefony | Google', 'Telefony | Mobilní telefony | OnePlus', 'Telefony | Mobilní telefony | HONOR', 'Telefony | Mobilní telefony | Realme', 'Telefony | Mobilní telefony | POCO', 'Telefony | Mobilní telefony | VIVO', 'Telefony | Mobilní telefony | ZTE'] },
  // Obecně mobilní telefon
  { words: ['telefon','mobil','mobilní telefon'],
    must: ['Telefony | Mobilní telefony'] },
  // Notebooky - kategorie "Notebooky | ..."
  { words: ['notebook','laptop','ultrabook','macbook','přenosný počítač'],
    must: ['Notebooky | '] },
  // Monitory - 'displej' a 'obrazovka' odebrány - konflikty s telefony/notebooky
  { words: ['monitor','lcd','oled monitor','herní monitor'],
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
  max = max || 30;
  if (products.length === 0) return [];
  const q = query.toLowerCase();

  let catFilter = [];
  for (const rule of CAT_RULES) {
    if (rule.words.some(w => q.includes(w))) { catFilter = rule.must; break; }
  }

  const kws = q.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));

  // Filtr displeje z dotazu ("velký displej" = 6.5"+, konkrétní rozměr)
  let minDisplej = null;
  let maxDisplej = null;
  if (/velk[ýá] displej|velk[áý] obrazovka/i.test(q)) minDisplej = 6.2;
  if (/mal[ýá] displej|kompaktn/i.test(q)) maxDisplej = 6.2;
  const dispMatch = q.match(/(\d{1,2}\.?\d?)\s*"/);
  if (dispMatch) { minDisplej = parseFloat(dispMatch[1]) - 0.2; maxDisplej = parseFloat(dispMatch[1]) + 0.2; }
  // Budget parsing - zachytit "10 000 Kč", "10000 Kč", "10 tisíc"
  const bmRaw = q.match(/(\d[\d\s]{0,8})\s*(k[cč]|czk|tis[íi][cč]?|tis\.?|k\b)/i);
  const budget = bmRaw
    ? parseFloat(bmRaw[1].replace(/\s/g,'')) * (/tis|k\b/i.test(bmRaw[2]) && !/kc|kč/i.test(bmRaw[2]) ? 1000 : 1)
    : null;

  // Must-contain filtr: pokud query obsahuje konkrétní produktové slovo,
  // vyfiltrovat jen produkty kde je toto slovo přímo v názvu
  const MUST_CONTAIN_WORDS = ['kabel','redukce','pouzdro','obal','stojánek','držák','nabíječka','baterie','myš','klávesnice','sluchátka','headset','tiskárna','monitor','projektor'];
  let mustContain = null;
  for (const w of MUST_CONTAIN_WORDS) {
    if (q.includes(w)) { mustContain = w; break; }
  }

  let pool = products;
  if (catFilter.length > 0) {
    let cf = products.filter(p => catFilter.some(f => (p.kategorie + ' ' + p.nazev).toLowerCase().includes(f.toLowerCase())));
    // Pokud hledáme telefon obecně, vyloučit tlačítkové a seniory pokud jsou i smartphony
    if (catFilter.some(f => f.includes('Telefony | Mobiln'))) {
      const smartphony = cf.filter(p => !p.kategorie.includes('Tlačítkové') && !p.kategorie.includes('Pro seniory') && !p.kategorie.includes('Ostatní telefony'));
      if (smartphony.length >= 3) cf = smartphony;
    }
    if (cf.length >= 3) pool = cf;
  }
  if (budget && budget > 500) {
    const bf = pool.filter(p => p.cena > 0 && p.cena <= budget * 1.1);
    if (bf.length >= 2) pool = bf;
  }

  // Aplikovat must-contain filtr na název produktu
  if (mustContain) {
    const mcf = pool.filter(p => p.nazev.toLowerCase().includes(mustContain));
    if (mcf.length >= 2) pool = mcf;
  }

  // Filtr podle velikosti displeje
  if (minDisplej || maxDisplej) {
    const df = pool.filter(p => {
      const par = parseParams(p.nazev);
      if (!par.displej) return true; // produkty bez displeje nevylučovat
      if (minDisplej && par.displej < minDisplej) return false;
      if (maxDisplej && par.displej > maxDisplej) return false;
      return true;
    });
    if (df.length >= 3) pool = df;
    // Pokud filtr vrátí méně než 3, seřadit pool podle velikosti displeje sestupně
    else if (minDisplej) {
      pool = pool.sort((a, b) => {
        const da = parseParams(a.nazev).displej || 0;
        const db = parseParams(b.nazev).displej || 0;
        return db - da;
      });
    }
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
    ? '\n\nPRODUKTY Z KATALOGU (pouze tyto existuji v nasi nabidce, zadne jine NEVYMYSLEJ):\n' +
      found.map((p, idx) =>
        '[' + idx + '] ' + p.nazev + paramsToStr(parseParams(p.nazev)) + ' | ' + p.cena + ' | ' + (p.dostupnost === '0' ? 'Skladem' : 'Dostupnost: ' + p.dostupnost + ' dni')
      ).join('\n')
    : '\n\n(Pro tento dotaz neni produkt v katalogu - uprimne rici a nasmerovat na mironet.cz)';

  return `Jsi AI asistent e-shopu Mironet.cz.

Komunikujes cesky, pratelsky a odborne. Pises bez markdown formatovani (zadne **tucne**, zadne # nadpisy). Pis gramaticky spravne cesky.

POBOCKY:
${pobocky}

LINKA: 777 900 777 (Po-Pa 8-17h)
OBJEDNAVKY: mironet.cz/muj-ucet

PRAVIDLA:
- Doporucuj POUZE produkty ze seznamu nize - pokud produkt v seznamu neni, NIKDY ho nevymyslej
- Pokud pozadovany produkt v katalogu neni, uprimne to rici a nasmerovat na mironet.cz
- NIKDY nepis URL adresy do textu odpovedi
- Produkty jsou zakaznikovi zobrazeny v kartach pod textem - nemusis je popisovat detailne
- Na KONEC odpovedi vzdy pridej tag s indexy produktu ktere doporucujes (na novy radek): INDEXY:[0,2,4]
- Pokud zadny produkt nedoporuces, napsat INDEXY:[]
- Max 4-5 vet${katalog}`;
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
    const rawReply = await callClaude(history, buildPrompt(found));
    // Parsovat indexy produktu z odpovedi (format: INDEXY:[0,2,4])
    const indexMatch = rawReply.match(/INDEXY:\s*\[([\d,\s]+)\]/);
    const reply = rawReply.replace(/\n?INDEXY:\s*\[[\d,\s]*\]\s*/g, '').trim();
    let toShow;
    if (indexMatch) {
      const idxs = indexMatch[1].split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n < found.length);
      toShow = idxs.map(i => found[i]).filter(Boolean).slice(0, 5);
    }
    // Fallback pouze pokud AI nevrátila explicitní INDEXY:[] (prázdný seznam)
    const explicitEmpty = rawReply.includes('INDEXY:[]') || rawReply.includes('INDEXY: []');
    if ((!toShow || toShow.length === 0) && !explicitEmpty) toShow = found.slice(0, 3);
    res.json({ reply, foundProducts: toShow });
  } catch(e) {
    console.error('Claude error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/debug-phones', (req, res) => {
  const q = req.query.q || 'Samsung';
  const phones = products.filter(p => p.kategorie && p.kategorie.includes('Telefony | Mobiln'));
  const samsung = products.filter(p => p.nazev && p.nazev.toLowerCase().includes(q.toLowerCase()));
  const samsungPhones = products.filter(p => p.kategorie && p.kategorie.includes('Samsung Galaxy'));
  const allKats = [...new Set(phones.map(p => p.kategorie.split(' | ').slice(0,3).join(' | ')))].sort();
  res.json({
    celkem_produktu: products.length,
    telefony_celkem: phones.length,
    samsung_telefony: samsungPhones.length,
    samsung_prvni_3: samsungPhones.slice(0, 3).map(p => ({ nazev: p.nazev, avail: p.dostupnost, cena: p.cena })),
    hledano_q: q,
    nalezeno_q: samsung.length,
    kategorie_telefony: allKats
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: CONFIG.MODEL, produktu: products.length, apiKlic: !!CONFIG.ANTHROPIC_API_KEY, pobocky: CONFIG.POBOCKY.map(p => p.nazev) });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

loadProducts();
app.listen(CONFIG.PORT, () => { console.log('Mironet AI Asistent bezi na portu ' + CONFIG.PORT); });
