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

// ============================================================
// PSEUDO-VEKTOROVÝ SEARCH ENGINE
// ============================================================

// Stopslova
const STOP = new Set(['pro','ke','na','do','ze','jak','kde','co','nebo','jen','chci','mam','hledam','vybrat','koupit','nejlepsi','dobry','nejaky','nejakou','jaky','jakou','chtel','chtela','bych','bys','asi','taky','take','velmi','hodne','trochu','pls','prosim','prosimte','dekuji']);

// Normalizace textu - odstranění diakritiky + lowercase + sjednocení oddělovačů
function norm(s) {
  return s.toLowerCase()
    .replace(/[áàâä]/g,'a').replace(/[čç]/g,'c').replace(/[ďđ]/g,'d')
    .replace(/[éèêë]/g,'e').replace(/[íìîï]/g,'i').replace(/[ň]/g,'n')
    .replace(/[óòôö]/g,'o').replace(/[řŕ]/g,'r').replace(/[šś]/g,'s')
    .replace(/[ťţ]/g,'t').replace(/[úùûü]/g,'u').replace(/[ýÿ]/g,'y')
    .replace(/[žź]/g,'z')
    .replace(/[-_\/\\]/g,' ')
    .replace(/\s+/g,' ').trim();
}

// Tokenizace - vrátí pole tokenů bez stopwords
function tokenize(s) {
  return norm(s).replace(/[^\w\s]/g,' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
}

// Synonymní slovník - rozšíření dotazu o příbuzné pojmy
const SYNONYMS = {
  // === TELEFONY ===
  'telefon':       ['telefon','mobil','smartphone','iphone','samsung','xiaomi','android'],
  'mobil':         ['mobil','telefon','smartphone','iphone','samsung','xiaomi','android'],
  'smartphone':    ['smartphone','telefon','mobil','iphone','android'],
  'iphone':        ['iphone','apple'],
  'samsung':       ['samsung','galaxy'],
  'galaxy':        ['galaxy','samsung'],
  'xiaomi':        ['xiaomi','redmi','poco'],
  'redmi':         ['redmi','xiaomi'],
  'poco':          ['poco','xiaomi'],
  'android':       ['android','samsung','xiaomi','motorola','honor','realme','google'],
  'motorola':      ['motorola','moto'],
  'honor':         ['honor'],
  'realme':        ['realme'],
  'oneplus':       ['oneplus'],
  'pixel':         ['pixel','google'],
  // === NOTEBOOKY ===
  'notebook':      ['notebook','laptop','ultrabook','macbook'],
  'laptop':        ['laptop','notebook','ultrabook'],
  'macbook':       ['macbook','apple'],
  'ultrabook':     ['ultrabook','notebook','laptop'],
  'chromebook':    ['chromebook','chrome'],
  'lenovo':        ['lenovo','thinkpad','ideapad','legion'],
  'thinkpad':      ['thinkpad','lenovo'],
  'hp':            ['hp','hewlett'],
  'dell':          ['dell','xps','inspiron','latitude'],
  'asus':          ['asus','zenbook','vivobook','rog','tuf'],
  'acer':          ['acer','aspire','nitro','swift'],
  'msi':           ['msi'],
  // === POČÍTAČE ===
  'pocitac':       ['pocitac','pc','desktop','tower','mini pc'],
  'desktop':       ['desktop','pocitac','pc','tower'],
  'minipc':        ['mini pc','minipc','nuc'],
  'allinone':      ['all-in-one','allinone','aio'],
  // === MONITORY ===
  'monitor':       ['monitor','display','obrazovka'],
  'obrazovka':     ['monitor','display','obrazovka'],
  // === KOMPONENTY ===
  'grafika':       ['graficka','gpu','geforce','radeon','rtx','gtx','arc'],
  'graficka':      ['graficka','gpu','geforce','radeon','rtx','gtx'],
  'gpu':           ['gpu','graficka','geforce','radeon','rtx','gtx'],
  'rtx':           ['rtx','geforce','nvidia'],
  'gtx':           ['gtx','geforce','nvidia'],
  'radeon':        ['radeon','amd','rx'],
  'procesor':      ['procesor','cpu','ryzen','core','intel','amd'],
  'cpu':           ['cpu','procesor','ryzen','intel','core'],
  'ryzen':         ['ryzen','amd'],
  'intel':         ['intel','core','celeron','pentium'],
  'ram':           ['ram','ddr','dimm','sodimm','pameti'],
  'pameti':        ['ram','ddr','pameti','dimm'],
  'ddr':           ['ddr','ram','dimm'],
  'ssd':           ['ssd','nvme','m.2'],
  'nvme':          ['nvme','ssd','m.2'],
  'hdd':           ['hdd','pevny disk','harddisk'],
  'disk':          ['disk','ssd','hdd','nvme','uloziste'],
  'zakladni':      ['zakladni deska','motherboard','socket'],
  'motherboard':   ['motherboard','zakladni deska','socket'],
  'socket':        ['socket','zakladni deska','am4','am5','lga'],
  'am4':           ['am4','zakladni deska','ryzen'],
  'am5':           ['am5','zakladni deska','ryzen'],
  'lga1700':       ['lga1700','zakladni deska','intel'],
  'lga1200':       ['lga1200','zakladni deska','intel'],
  'kompatibilni':  ['zakladni deska','kompatibilni','motherboard'],
  'pro procesor':  ['zakladni deska','motherboard'],
  'skrin':         ['skrin','case','tower','midi'],
  'zdroj':         ['zdroj','psu','napajeni'],
  'chlazeni':      ['chlazeni','chladic','ventilátor','fan','aio'],
  // === PERIFERIE ===
  'mys':           ['mys','mouse'],
  'klavesnice':    ['klavesnice','keyboard'],
  'sluchatka':     ['sluchatka','headset','headphones','airpods','pecky','sluchatko'],
  'headset':       ['headset','sluchatka','headphones'],
  'airpods':       ['airpods','sluchatka','apple','pecky'],
  'mikrofon':      ['mikrofon','mic','microphone'],
  'webkamera':     ['webkamera','webcam','kamera pc'],
  'gamepad':       ['gamepad','ovladac','controller','joystick'],
  'joystick':      ['joystick','gamepad','ovladac'],
  'volant':        ['volant','steering wheel','simulator'],
  // === KABELY A REDUKCE ===
  'kabel':         ['kabel','cable'],
  'hdmi':          ['hdmi'],
  'displayport':   ['displayport','dp'],
  'usb':           ['usb'],
  'usbc':          ['usb-c','usb c','type-c','typec'],
  'thunderbolt':   ['thunderbolt','tb4'],
  'jack':          ['jack','3.5mm','audio kabel'],
  'ethernet':      ['ethernet','lan','rj45','patch kabel'],
  'opticky':       ['opticky','toslink','spdif'],
  'redukce':       ['redukce','adapter','adaptér'],
  'adapter':       ['adapter','adaptér','redukce'],
  // === NABÍJECÍ ===
  'nabijeni':      ['nabij','charger','nabijec','nabijecka'],
  'nabijecka':     ['nabijecka','charger','nabij','adaptér'],
  'powerbank':     ['powerbank','baterie prenosna','power bank'],
  'bezdratove':    ['bezdratove nabijeni','qi','wireless charging'],
  // === TABLETY ===
  'tablet':        ['tablet','ipad','android tablet'],
  'ipad':          ['ipad','apple','tablet'],
  // === TISKÁRNY ===
  'tiskarna':      ['tiskarna','printer','multifunkc','laserova','inkoustova'],
  'toner':         ['toner','cartridge','napl','kazeta'],
  'cartridge':     ['cartridge','toner','napl','inkoust'],
  'papir':         ['papir','paper','a4'],
  // === SÍŤ ===
  'router':        ['router','wifi','wi-fi','smerovac'],
  'wifi':          ['wifi','wi-fi','router','wireless','bezdrát'],
  'switch':        ['switch','prepinac','hub'],
  'access':        ['access point','ap','wifi'],
  'mesh':          ['mesh','wifi system'],
  'sfp':           ['sfp','optika','fiber'],
  'patchpanel':    ['patch panel','patchpanel','datovy rozvaděč'],
  // === ÚLOŽIŠTĚ ===
  'flash':         ['flash','pendrive','usb disk','flashka'],
  'pendrive':      ['pendrive','flash','usb disk'],
  'nas':           ['nas','uloziste','network storage','synology','qnap'],
  'synology':      ['synology','nas'],
  'qnap':          ['qnap','nas'],
  'sdkarta':       ['sd karta','sdcard','pamet karta','microsd'],
  'cfkarta':       ['cf karta','cfexpress','compactflash'],
  // === AUDIO-VIDEO ===
  'reproduktor':   ['reproduktor','speaker','soundbar','repro'],
  'soundbar':      ['soundbar','reproduktor','speaker','dolby'],
  'subwoofer':     ['subwoofer','bas','reproduktor'],
  'receiver':      ['receiver','av receiver','stereo receiver','zesilovac'],
  'zesilovac':     ['zesilovac','amplifier','receiver','integrovaný'],
  'gramofon':      ['gramofon','vinyl','turntable','lp'],
  'televizor':     ['televizor','televize','tv','oled','qled','smart tv'],
  'televize':      ['televize','televizor','tv','oled','qled'],
  'projektor':     ['projektor','projector','beamer'],
  'platno':        ['platno','projekcni platno','screen'],
  'bluray':        ['blu-ray','bluray','prehravac'],
  'dvd':           ['dvd','prehravac','disc'],
  'mp3':           ['mp3','prehrávač','hudba','walkman'],
  'diktafon':      ['diktafon','zaznamnik','voice recorder'],
  'prekladac':     ['prekladac','prekladatel','hlasovy prekladac'],
  'antena':        ['antena','dvb-t','dvbt','tv prijem','satelit'],
  'satelit':       ['satelit','dvb-s','dvbs','dish'],
  'settopbox':     ['set-top box','settopbox','dvb','t2'],
  'dj':            ['dj','mixer','kontroler','mixazni'],
  'mikrofon':      ['mikrofon','mic','microphone','studio'],
  // === FOTOAPARÁTY A KAMERY ===
  'fotoaparat':    ['fotoaparat','kamera','dslr','bezzrcadlovy','mirrorless','foto'],
  'kamera':        ['kamera','fotoaparat','camera','videokamera','akční kamera'],
  'akcnikamera':   ['akční kamera','gopro','action cam','sportovni kamera'],
  'gopro':         ['gopro','akční kamera','action cam'],
  'dron':          ['dron','drone','dji','quadcopter'],
  'dji':           ['dji','dron','drone'],
  'objektiv':      ['objektiv','lens','fotoobjektiv'],
  'stativ':        ['stativ','tripod','monopod'],
  'dalekohled':    ['dalekohled','binoculars','lupa','optika'],
  // === GPS ===
  'gps':           ['gps','navigace','garmin','tomtom'],
  'navigace':      ['navigace','gps','garmin','tomtom','auto navigace'],
  'garmin':        ['garmin','gps','sporttester'],
  // === CHYTRÉ HODINKY ===
  'hodinky':       ['hodinky','smartwatch','chytre hodinky','watch','garmin','fitbit'],
  'smartwatch':    ['smartwatch','hodinky','chytre hodinky','apple watch'],
  'fitness':       ['fitness naramek','fitness band','sport naramek','tracker'],
  'applewatch':    ['apple watch','apple','hodinky'],
  // === HRY A KONZOLE ===
  'konzole':       ['konzole','playstation','xbox','nintendo','ps5','ps4','gaming'],
  'playstation':   ['playstation','ps5','ps4','ps3','sony'],
  'xbox':          ['xbox','microsoft','series x','series s'],
  'nintendo':      ['nintendo','switch','zelda','mario'],
  'ps5':           ['ps5','playstation 5','playstation'],
  'hry':           ['hra','game','hry','gaming'],
  'vr':            ['vr','virtual reality','oculus','quest','meta'],
  // === SPOTŘEBIČE ===
  'kafeovar':      ['kafeovar','kavovar','espresso','kafe','kava'],
  'kavovar':       ['kavovar','kafeovar','espresso','kava','kafe'],
  'mikrovlnka':    ['mikrovlnna','microwave','trouba'],
  'trouba':        ['trouba','pec','mikrovlnna','vzduchova friteza'],
  'friteza':       ['friteza','airfryer','vzduchova friteza','smažení'],
  'robot':         ['kuchynsky robot','food processor','mixér','robot'],
  'mixér':         ['mixer','blender','smoothie','robot'],
  'vysavac':       ['vysavac','vacuum','roboticky vysavac','roomba'],
  'roomba':        ['roomba','vysavac','robot','irobot'],
  'zehllicka':     ['zehlicka','iron','parni stanice'],
  'varna':         ['varna konvice','kettle','rychlovarna'],
  'chladnička':    ['chladnicka','lednice','refrigerator'],
  'mrazak':        ['mrazak','freezer','mrazicka'],
  'pračka':        ['pracka','washing machine','automaticka pracka'],
  'susicka':       ['susicka','dryer','kondenzacni'],
  'mycka':         ['mycka','dishwasher','myčka nádobí'],
  'klimatizace':   ['klimatizace','ac','air condition','chlazeni'],
  'ventilátor':    ['ventilator','fan','ochlazovac','tower fan'],
  'čistička':      ['cisticka vzduchu','air purifier','ionizátor'],
  'zvlhcovac':     ['zvlhcovac','humidifier','aromaterapie'],
  'odvlhcovac':    ['odvlhcovac','dehumidifier'],
  'vafle':         ['vaflovic','sandwich','kontaktni gril','toaster'],
  'toaster':       ['toaster','topinkovac','toustovac'],
  'multivar':      ['multivar','hrnec','slow cooker','instantpot'],
  // === DŮM A DÍLNA ===
  'vrtacka':       ['vrtacka','drill','aku vrtacka','šroubovák'],
  'sroubovak':     ['sroubovak','drill driver','aku sroubovák'],
  'bruska':        ['bruska','sander','uhlovka','pilicka'],
  'pila':          ['pila','saw','cirkularka','přímočará pila'],
  'meric':         ['meric','multimetr','tester','merici pristroj'],
  'multimetr':     ['multimetr','meric','tester','voltmetr'],
  'zabezpeceni':   ['zabezpeceni','kamera','alarm','detektor'],
  'ip kamera':     ['ip kamera','bezpecnostni kamera','cctv','nvr','dvr'],
  'alarm':         ['alarm','zabezpeceni','pohybovy detektor'],
  'zamek':         ['chytre zamky','smart lock','zámek'],
  'svetlo':        ['led svetlo','zarovka','lampa','osvetleni'],
  'led':           ['led','zarovka','svetlo','osvětlení','pásek'],
  'baterka':       ['baterka','svitilna','flashlight','headlamp'],
  'prodluzovak':   ['prodluzovak','listkova','zasuvka','extension'],
  'ups':           ['ups','zaloha','bateriovka','nepretrzite napajeni'],
  // === AUTO-MOTO ===
  'auto':          ['auto','car','autokosmetika','automoto','vozidlo'],
  'autokosmetika': ['autokosmetika','auto chemie','voskování','šampon auto'],
  'carcharger':    ['nabijeni auto','car charger','do auta','autonabijec'],
  'drzak':         ['drzak','holder','mount','stojan'],
  'steras':        ['steras','wipers','stěrač'],
  'dashcam':       ['dashcam','autokamera','kamera do auta'],
  'obd':           ['obd','diagnostika','scanner'],
  // === SPORT A KEMPING ===
  'kolo':          ['kolo','bike','bicycle','elektrokolo','ebike'],
  'kolobezka':     ['kolobezka','scooter','elektrokolobezka','e-scooter'],
  'sporttester':   ['sporttester','hodinky sport','garmin','polar','suunto'],
  'stan':          ['stan','tent','kempink','camping'],
  'spaci':         ['spaci pytel','sleeping bag','deka'],
  // === KANCELAR ===
  'kalkulacka':    ['kalkulacka','calculator'],
  'laminovacka':   ['laminovacka','laminator'],
  'skartovac':     ['skartovac','shredder'],
  'projektor':     ['projektor','beamer','plátno'],
  // === SANITA ===
  'elektrickyzubak': ['elektricky kartacek','sonic','oral-b','zuby'],
  'holinky':       ['holinky','depilator','epilator','britva'],
  'vaha':          ['vaha','osobni vaha','scale','BMI'],
  'teplomer':      ['teplomer','thermometer','teplota','iri'],
  'masaz':         ['masaz','massage','masazni pistole','percussor'],
  // === CHOVATELSKE ===
  'pes':           ['pes','dog','krmivo','vodítko','obojek'],
  'kocka':         ['kocka','cat','krmivo kocka','pelech'],
  'akvaristika':   ['akvaristika','ryby','akvarium','filtr'],
  // === HRAČKY ===
  'hracka':        ['hracka','toy','lego','stavebnice'],
  'lego':          ['lego','stavebnice','duplo'],
  'rc':            ['rc auto','rc model','radio ovladane'],
  // === DOMÁCÍ POTŘEBY ===
  'hrnec':         ['hrnec','pot','nadoba','tlakovy hrnec'],
  'panev':         ['panev','pan','neprilnava','grilovaci panev'],
  'nuz':           ['nuz','knife','kuchynsky nuz','sada nozu'],
  'kuchynske':     ['kuchynske nacini','nastroje','varecka','strednik'],
  // === ZAHRADA ===
  'sekacka':       ['sekacka','lawn mower','robotická sekačka','husqvarna'],
  'gril':          ['gril','bbq','grilovani','zahradni gril','weber'],
  'zahradni':      ['zahradni','garden','plot','trávník'],
  // === PŘÍSLUŠENSTVÍ — vztahové dotazy pro všechny kategorie ===
  'pouzdro':       ['pouzdro','obal','kryt','case','prislusenstvi pro mobilni telefony','prislusenstvi pro tablety'],
  'obal':          ['obal','pouzdro','kryt','case','prislusenstvi pro mobilni telefony'],
  'kryt':          ['kryt','pouzdro','obal','case'],
  'sklo':          ['ochranne sklo','tempered glass','folie','prislusenstvi pro mobilni'],
  'folie':         ['folie','ochranne sklo','screen protector'],
  'reminek':       ['reminek','band','prislusenstvi pro nositelnou elektroniku'],
  'dokovaci':      ['dokovaci stanice','dock','hub','prislusenstvi pro notebooky'],
  'hub':           ['hub','dokovaci stanice','usb hub','prislusenstvi'],
  'brasna':        ['brasna','batoh','taska','pouzdro','prislusenstvi pro notebooky'],
  'batoh':         ['batoh','brasna','taska','sport a kemping'],
  'dalkovy':       ['dalkovy ovladac','remote','prislusenstvi pro tv'],
  'ovladac':       ['ovladac','dalkovy ovladac','remote','gamepad'],
  'lampa':         ['lampa','zarovka','prislusenstvi pro projektory'],
  'nastenny':      ['nastenny drzak','wall mount','prislusenstvi pro tv','prislusenstvi pro monitory'],
  'cisticka':      ['cistici prostredky','cistici sada','cleaning kit','spotrebni material'],
  'filament':      ['filament','tiskova struna','3d tisk','tiskove struny'],
  // === SPOTŘEBNÍ MATERIÁL — tiskárny ===
  'toner':         ['toner','laserovy toner','spotrebni material pro tiskarny'],
  'cartridge':     ['cartridge','inkoustova napl','spotrebni material pro tiskarny'],
  'naplna':        ['napl','toner','cartridge','spotrebni material pro tiskarny'],
  'kazeta':        ['kazeta','cartridge','toner'],
  'inkoust':       ['inkoust','cartridge','inkoustova napl'],
  'papir':         ['papir','a4','papir a role pro tiskarny','spotrebni material'],
  // === NÁHRADNÍ DÍLY ===
  'nahradni':      ['nahradni dily','nahradni dil','spare parts','nahradni dily'],
  'displej':       ['displej','display pro mobily','lcd display','nahradni dily'],
  // === KOMPONENTY — vztahové dotazy ===
  'zakladni':      ['zakladni deska','motherboard','socket'],
  'motherboard':   ['motherboard','zakladni deska','socket'],
  'socket':        ['socket','zakladni deska','am4','am5','lga'],
  'am4':           ['am4','zakladni deska','ryzen'],
  'am5':           ['am5','zakladni deska','ryzen'],
  'lga1700':       ['lga1700','zakladni deska','intel'],
  'lga1200':       ['lga1200','zakladni deska','intel'],
  'kompatibilni':  ['zakladni deska','kompatibilni','motherboard'],
  // === AUTO-MOTO — vztahové dotazy ===
  'drzak':         ['drzak','holder','mount','stojan','prislusenstvi pro mobilni telefony','auto-moto'],
  'autonabijec':   ['nabijec do auta','car charger','auto-moto elektricke doplnky'],
  'olej':          ['olej','motorovy olej','oleje a maziva'],
  'steras':        ['steras','wiper','auto-moto'],
  'autobaterie':   ['autobaterie','startovaci box','auto-moto autobaterie'],
  'zimni':         ['zimni pneu','zimni vybava','auto-moto zimni'],
  // === SPORT — vztahové dotazy ===
  'helma':         ['helma','prilba','cyklistika','sport'],
  'cyklistika':    ['cyklistika','kolo','prilba','sport a kemping'],
  'rybareni':      ['rybarstvi','rybareni','rybarske potreby'],
  'trampolina':    ['trampolina','trampoliny a prislusenstvi'],
  // === ZAHRADA — vztahové dotazy ===
  'retezec':       ['retez','retezova pila','zahradni technika'],
  'strunova':      ['strunova sekacka','krovinorez','zahradni technika'],
  'hadice':        ['zahradni hadice','zavlazovani','zahrada'],
  'hnojivo':       ['hnojivo','zahradnicke potreby'],
  // === DOMÁCÍ POTŘEBY — vztahové dotazy ===
  'poklice':       ['poklice','viko','hrnce','domaci potreby'],
  'grilovaci':     ['grilovaci','panev','prislusenstvi','zahrada'],
  // === KANCELÁŘ — vztahové dotazy ===
  'etiketa':       ['etiketa','stitek','tiskarna stitku','spotrebni material'],
  'trezor':        ['trezor','bezpecnostni schranka','kancelar'],
  // === ZDRAVÍ — vztahové dotazy ===
  'kartacek':      ['elektricky kartacek','sonic','oral-b','krasaa zdravi'],
  'epilator':      ['epilator','depilator','krasa a zdravi'],
  // === CHOVATELSKÉ — vztahové dotazy ===
  'krmivo':        ['krmivo','chovatelske potreby','pes','kocka'],
  'akvarium':      ['akvarium','akvaristika','chovatelske potreby'],
  // === HRAČKY — vztahové dotazy ===
  'stavebnice':    ['stavebnice','lego','hracky'],
  'puzzle':        ['puzzle','hracky'],
  // === POKLADNY — vztahové dotazy ===
  'cteckabarkodu': ['ctecka carovych kodu','pokladni system','pokladni a evidencni'],
  'pokladnizasuvka': ['pokladni zasuvky','pokladni a evidencni'],
  'kindle':        ['kindle','ctecka','amazon','ebook'],
  // === ČTEČKY KARET / POKLADNY ===
  'pokladna':      ['pokladna','pos','pokladni system','registracni'],
  'ctecka':        ['ctecka karet','reader','pos terminal'],
  // === SOFTWARE / CLOUD ===
  'antivirus':     ['antivirus','security','internet security','eset','avast'],
  'office':        ['office','microsoft','kancelarsky software','word','excel'],
  'windows':       ['windows','microsoft','os','operacni system'],
  // === OBECNÉ VLASTNOSTI ===
  'bezdratovy':    ['bezdratov','wireless','wifi','bluetooth','bt'],
  'bezdratova':    ['bezdratov','wireless','wifi','bluetooth','bt'],
  'bluetooth':     ['bluetooth','bt','bezdratov'],
  'mechanicka':    ['mechanicka','mechanical'],
  'herni':         ['herni','gaming','game','pro gamery'],
  'gaming':        ['gaming','herni','game'],
  'prenosny':      ['prenosny','portable','notebo'],
  'kompaktni':     ['kompaktni','mini','small'],
  'profesionalni': ['profesionalni','pro','professional'],
  // === BARVY ===
  'cerna':         ['cerna','black'],
  'bila':          ['bila','white'],
  'modra':         ['modra','blue'],
  'cervena':       ['cervena','red'],
  'zelena':        ['zelena','green'],
  'stribrna':      ['stribrna','silver'],
  'zlata':         ['zlata','gold'],
  'fialova':       ['fialova','purple','violet'],
  'ruzova':        ['ruzova','pink'],
  'seda':          ['seda','grey','gray'],
  'titanová':      ['titanova','titanium'],
};

// Rozšíření tokenů o synonyma
function expandTokens(tokens) {
  const expanded = new Map(); // token -> váha
  for (const t of tokens) {
    expanded.set(t, (expanded.get(t) || 0) + 3); // originál = váha 3
    const syns = SYNONYMS[t] || [];
    for (const s of syns) {
      expanded.set(s, (expanded.get(s) || 0) + 1); // synonymum = váha 1
    }
  }
  return expanded;
}

// Editační vzdálenost (Levenshtein) - jen pro krátká slova
function editDist(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) => Array.from({length: n+1}, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// Mapování tokenů na top-level kategorie pro bonus skórování
// MUSÍ být před scoreProduct()
const TOKEN_CATEGORY_MAP = {
  'notebook':     'Notebooky',
  'laptop':       'Notebooky',
  'macbook':      'Notebooky',
  'ultrabook':    'Notebooky',
  'telefon':      'Telefony',
  'mobil':        'Telefony',
  'smartphone':   'Telefony',
  'iphone':       'Telefony',
  'samsung':      'Telefony',
  'xiaomi':       'Telefony',
  'monitor':      'Monitory',
  'tablet':       'Tablety',
  'ipad':         'Tablety',
  'tiskarna':     'Tiskárny a multifunkce',
  'televize':     'Televize',
  'televizor':    'Televize',
  'projektor':    'Projektory',
  'fotoaparat':   'Fotoaparáty a optika',
  'kamera':       'Kamery',
  'router':       'Sítě',
  'switch':       'Sítě',
  'server':       'Servery, Racky a platformy',
  'skener':       'Skenery',
  'software':     'Software',
  'konzole':      'Hry a herní zařízení',
  'playstation':  'Hry a herní zařízení',
  'xbox':         'Hry a herní zařízení',
  'nintendo':     'Hry a herní zařízení',
  'hodinky':      'Chytré hodinky a SMART',
  'smartwatch':   'Chytré hodinky a SMART',
  'gps':          'GPS navigace',
  'navigace':     'GPS navigace',
  'ctecka':       'Čtečky e-knih',
  'kindle':       'Čtečky e-knih',
  'vysavac':      'Spotřebiče do domácnosti',
  'kavovar':      'Spotřebiče do domácnosti',
  'kafeovar':     'Spotřebiče do domácnosti',
  'klimatizace':  'Spotřebiče do domácnosti',
  'vrtacka':      'Dům a dílna',
  'sekacka':      'Zahrada',
  'gril':         'Zahrada',
  'reproduktor':  'Audio-Video',
  'soundbar':     'Audio-Video',
  'gramofon':     'Audio-Video',
  'sluchatka':    'Audio-Video',
  'mikrofon':     'Audio-Video',
  'pokladna':     'Pokladní a evidenční systémy',
};

// Skórování jednoho produktu proti rozšířeným tokenům
function scoreProduct(p, expandedTokens, originalTokens, phraseNorm) {
  const nl = norm(p.nazev);
  const kl = norm(p.kategorie + ' ' + p.vyrobce);
  const topKat = (p.kategorie || '').split(' | ')[0].trim();
  let score = 0;

  // 1. Přesná fráze v názvu = velký bonus
  if (phraseNorm && nl.includes(phraseNorm)) score += 20;

  // 2. Klíčový bonus: token přímo mapuje na top-level kategorii produktu
  //    Zajistí že "notebook" najde Notebooky, ne jen příslušenství pro notebooky
  for (const t of originalTokens) {
    const mappedKat = TOKEN_CATEGORY_MAP[t];
    if (mappedKat && topKat === mappedKat) score += 15;
  }

  // 3. Skórování podle rozšířených tokenů
  for (const [token, weight] of expandedTokens) {
    const nt = norm(token);
    if (nl.includes(nt)) score += weight * 3;       // match v názvu
    else if (kl.includes(nt)) score += weight * 1;  // match v kategorii/výrobci
  }

  // 4. Fuzzy matching pro originální tokeny (pouze slova 4+ znaků, max edit dist 1)
  for (const t of originalTokens) {
    if (t.length < 4) continue;
    const words = nl.split(' ');
    for (const w of words) {
      if (w.length < 3) continue;
      if (editDist(t, w) === 1) { score += 2; break; }
    }
  }

  // 5. Bonus za dostupnost skladem
  if (p.dostupnost === '0') score += 1;

  // 6. Malus za produkty kde žádný originální token není v názvu ani kategorii
  const anyOriginalMatch = originalTokens.some(t => nl.includes(t) || kl.includes(t));
  if (!anyOriginalMatch) score = Math.min(score, 2);

  return score;
}

// Parser parametrů z názvu produktu
function parseParams(nazev) {
  const n = nazev.toLowerCase();
  const params = {};
  const disp = nazev.match(/(\d{1,2}\.?\d?)\s*"/);
  if (disp) params.displej = parseFloat(disp[1]);
  const ram = nazev.match(/(\d+)\+\d+GB/);
  if (ram) params.ram = parseInt(ram[1]);
  const stor = nazev.match(/\+(\d+)GB|\b(\d+)GB\b|\b(\d+)\s*TB\b/);
  if (stor) {
    const val = stor[1] || stor[2] || stor[3];
    params.uloziste = stor[3] ? parseInt(val) * 1024 : parseInt(val);
  }
  if (n.includes('android')) { const ver = nazev.match(/Android\s*(\d+)/i); params.os = 'Android' + (ver ? ' ' + ver[1] : ''); }
  else if (n.includes('ios') || n.includes('iphone') || n.includes('ipad') || n.includes('macbook')) params.os = 'iOS/macOS';
  else if (n.includes('windows')) params.os = 'Windows';
  const barvy = ['černá','bílá','modrá','červená','zelená','stříbrná','zlatá','fialová','růžová','šedá','titanová'];
  for (const b of barvy) { if (n.includes(b)) { params.barva = b; break; } }
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

// Kategoriová pravidla - pre-filtr poolu pro jednoznačné dotazy
// Pořadí je důležité - specifičtější pravidla MUSÍ být před obecnými
const CAT_RULES = [
  // === KABELY - před notebooky/telefony ===
  { words: ['kabel','hdmi kabel','displayport kabel','usb kabel','usb-c kabel','nabíjecí kabel','prodlužovací kabel','audio kabel','ethernet kabel','optický kabel','patch kabel'],
    must: ['Příslušenství | Kabely'] },
  { words: ['redukce','adaptér kabel'],
    must: ['Příslušenství | Redukce','Příslušenství | Kabely'] },

  // === TELEFONY - před monitory (kvůli "displej") ===
  { words: ['iphone','samsung galaxy','xiaomi','motorola','google pixel','oneplus','honor','realme','vivo','poco','zte'],
    must: ['Telefony | Mobilní telefony'] },
  { words: ['smartphone','chytrý telefon','android telefon'],
    must: ['Telefony | Mobilní telefony'] },
  { words: ['telefon','mobil','mobilní telefon'],
    must: ['Telefony | Mobilní telefony'] },
  { words: ['tlačítkový telefon','seniorský telefon'],
    must: ['Telefony | Tlačítkové telefony','Telefony | Pro seniory'] },

  // === NOTEBOOKY ===
  { words: ['notebook','laptop','ultrabook','macbook','chromebook','přenosný počítač'],
    must: ['Notebooky | '] },

  // === POČÍTAČE ===
  { words: ['desktop','stolní počítač','mini pc','all-in-one','nuc','počítač'],
    must: ['Počítače | '] },

  // === MONITORY ===
  { words: ['monitor','herní monitor','oled monitor','4k monitor'],
    must: ['Monitory | '] },

  // === KOMPONENTY ===
  // Pořadí je kritické — specifické kategorie PŘED obecnými procesory/GPU
  // Jinak "chlazení pro Ryzen", "ram pro notebook", "ssd pro PS5" matchnou špatnou kategorii

  // Chlazení — před procesory ("chlazení pro Ryzen" nesmí matchnout Procesory)
  { words: ['chlazení','cpu chladič','chladič procesoru','vodní chlazení','aio chladič','case fan','ventilátor do pc','paste'],
    must: ['Komponenty | Chlazení'] },
  // Základní desky — před procesory ("deska pro Ryzen" nesmí matchnout Procesory)
  { words: ['základní deska','motherboard','socket am4','socket am5','lga1700','lga1200','deska pro','základní desku','itx deska','atx deska','matx'],
    must: ['Komponenty | Základní desky'] },
  // Skříně — před GPU/CPU ("skříň pro RTX" nesmí matchnout GPU)
  { words: ['pc skříň','počítačová skříň','midi tower','full tower','mini itx','mini tower','case pro pc','skříň na pc'],
    must: ['Komponenty | Skříně'] },
  // Zdroje — před GPU ("zdroj pro RTX 4090" nesmí matchnout GPU)
  { words: ['pc zdroj','počítačový zdroj','psu','napájení pc','atx zdroj','modular zdroj'],
    must: ['Komponenty | Zdroje'] },
  // Paměti RAM — před notebooky ("ram pro notebook" nesmí matchnout Notebooky)
  { words: ['ram','paměť ram','dimm','ddr4','ddr5','sodimm','so-dimm','operační paměť'],
    must: ['Komponenty | Paměti RAM'] },
  // SSD — před konzolemi, PS5 atd. ("ssd pro ps5" nesmí matchnout Konzole)
  { words: ['ssd','nvme','m.2 disk','m.2 ssd','nvme disk','pevný ssd'],
    must: ['Komponenty | Pevné disky a SSD'] },
  // HDD
  { words: ['hdd','pevný disk','harddisk','3.5 disk','2.5 disk'],
    must: ['Komponenty | Pevné disky a SSD'] },
  // Grafické karty
  { words: ['grafická karta','grafickou kartu','gpu','rtx','gtx','radeon rx','geforce','rx 7900','rx 6800'],
    must: ['Komponenty | Grafické karty'] },
  // Procesory — až po specifičtějších kategoriích
  { words: ['procesor','cpu','ryzen','core i5','core i7','core i9','intel core','xeon'],
    must: ['Komponenty | Procesory'] },
  // RGB / LED osvětlení PC
  { words: ['rgb páska','led páska do pc','rgb fan','argb','case osvětlení'],
    must: ['Komponenty | Osvětlení - LED, RGB, D-RGB'] },
  { words: ['počítačová skříň','pc skříň','midi tower'],
    must: ['Komponenty | Skříně'] },
  { words: ['počítačový zdroj','pc zdroj','psu napájení'],
    must: ['Komponenty | Zdroje'] },
  { words: ['chlazení procesoru','cpu chladic','vodní chlazení'],
    must: ['Komponenty | Chlazení'] },
  { words: ['flash disk','usb disk','pendrive'],
    must: ['Komponenty | Flash disky'] },
  { words: ['nas','síťové úložiště','network storage'],
    must: ['Komponenty | Datová úložiště NAS'] },
  { words: ['sd karta','microsd','paměťová karta'],
    must: ['Komponenty | Paměťové karty'] },

  // === PERIFERIE ===
  { words: ['myš','herní myš','bezdrátová myš','optická myš'],
    must: ['Myši | '] },
  { words: ['klávesnice','herní klávesnice','mechanická klávesnice'],
    must: ['Klávesnice | '] },
  { words: ['sluchátka','bezdrátová sluchátka','herní headset','airpods'],
    must: ['Sluchátka | ','Audio-Video | Sluchátka'] },
  { words: ['webkamera','webcam'],
    must: ['Příslušenství | Webkamery','Kamery | Webkamery'] },
  { words: ['gamepad','herní ovladač','joystick','volant'],
    must: ['Hry a herní zařízení | Příslušenství'] },
  { words: ['mikrofon','studiový mikrofon'],
    must: ['Audio-Video | Mikrofony'] },

  // === TABLETY ===
  { words: ['tablet','ipad','android tablet'],
    must: ['Tablety | '] },

  // === TISKÁRNY ===
  { words: ['tiskárna','laserová tiskárna','inkoustová tiskárna','multifunkční tiskárna','3d tiskárna'],
    must: ['Tiskárny a multifunkce | '] },
  { words: ['toner','cartridge','náplň do tiskárny','inkoustová náplň'],
    must: ['Spotřební materiál | Spotřební materiál pro tiskárny'] },
  { words: ['kancelářský papír','papír a4'],
    must: ['Spotřební materiál | Papír'] },

  // === SKENERY ===
  { words: ['skener','scanner','dokumentový skener'],
    must: ['Skenery | '] },

  // === SÍŤ ===
  { words: ['router','wifi router','wi-fi router'],
    must: ['Sítě | Routery'] },
  { words: ['mesh wifi','wifi systém'],
    must: ['Sítě | Mesh WiFi','Sítě | Routery'] },
  { words: ['switch','síťový přepínač','network switch'],
    must: ['Sítě | Switche','Sítě | Cisco Small Business'] },
  { words: ['access point','přístupový bod'],
    must: ['Sítě | Access Pointy'] },
  { words: ['powerline','dlan'],
    must: ['Sítě | Powerline'] },

  // === SERVERY ===
  { words: ['server','rack','blade server','nas server'],
    must: ['Servery, Racky a platformy | '] },
  { words: ['ups','záložní zdroj'],
    must: ['Dům a dílna | UPS záložní zdroje','Komponenty | Záložní zdroje'] },

  // === AUDIO-VIDEO ===
  { words: ['reproduktor','bluetooth reproduktor','přenosný reproduktor'],
    must: ['Audio-Video | Reproduktory'] },
  { words: ['soundbar','dolby atmos'],
    must: ['Audio-Video | Reproduktory | Soundbary'] },
  { words: ['receiver','av receiver','stereo receiver','zesilovač'],
    must: ['Audio-Video | Receivery','Audio-Video | Převodníky / Zesilovače'] },
  { words: ['gramofon','vinyl','turntable'],
    must: ['Audio-Video | Gramofony'] },
  { words: ['televize','televizor','smart tv','oled tv','qled'],
    must: ['Televize | '] },
  { words: ['blu-ray','bluray přehrávač'],
    must: ['Audio-Video | Blu-ray přehrávače'] },
  { words: ['dvd přehrávač'],
    must: ['Audio-Video | DVD přehrávače'] },
  { words: ['mp3 přehrávač'],
    must: ['Audio-Video | MP3 přehrávače'] },
  { words: ['diktafon','záznamník','hlasový záznamník'],
    must: ['Audio-Video | Záznamníky'] },
  { words: ['dvb-t','dvbt','set-top box','anténa'],
    must: ['Audio-Video | TV příjem'] },
  { words: ['satelit','dvb-s','satelitní'],
    must: ['Satelitní technika | ','Audio-Video | TV příjem'] },

  // === PROJEKTORY ===
  { words: ['projektor','beamer','laserový projektor'],
    must: ['Projektory | '] },

  // === FOTOAPARÁTY A KAMERY ===
  { words: ['fotoaparát','zrcadlovka','dslr','bezzrcadlový'],
    must: ['Fotoaparáty a optika | Fotoaparáty'] },
  { words: ['objektiv','fotoobjektiv'],
    must: ['Fotoaparáty a optika | Objektivy'] },
  { words: ['akční kamera','gopro','sportovní kamera'],
    must: ['Kamery | Akční kamery'] },
  { words: ['dron','drone','dji'],
    must: ['Kamery | Drony','Fotoaparáty a optika | Drony'] },
  { words: ['videokamera','camcorder'],
    must: ['Kamery | Videokamery'] },
  { words: ['ip kamera','bezpečnostní kamera','cctv'],
    must: ['Kamery | IP kamery'] },
  { words: ['dalekohled','binokulár','lupa'],
    must: ['Fotoaparáty a optika | Dalekohledy a optika'] },

  // === GPS ===
  { words: ['gps navigace','garmin','navigace do auta'],
    must: ['GPS navigace | '] },
  { words: ['sporttester','sportovní hodinky','garmin sporttester'],
    must: ['GPS navigace | Sportovní GPS','Chytré hodinky a SMART | '] },

  // === CHYTRÉ HODINKY ===
  { words: ['chytré hodinky','smartwatch','apple watch'],
    must: ['Chytré hodinky a SMART | Chytré hodinky'] },
  { words: ['fitness náramek','fitness band'],
    must: ['Chytré hodinky a SMART | Fitness náramky'] },

  // === HERNÍ KONZOLE ===
  { words: ['playstation','ps5','ps4','xbox','nintendo','herní konzole'],
    must: ['Hry a herní zařízení | Konzole','Hry a herní zařízení | '] },
  { words: ['vr headset','virtual reality','oculus','meta quest'],
    must: ['Hry a herní zařízení | VR'] },

  // === SPOTŘEBIČE ===
  { words: ['kávovar','kaféovar','espresso','nespresso'],
    must: ['Spotřebiče do domácnosti | Kávovary'] },
  { words: ['mikrovlnná','mikrovlnka'],
    must: ['Spotřebiče do domácnosti | Mikrovlnné trouby'] },
  { words: ['airfryer','vzduchová fritéza','horkovzdušná trouba'],
    must: ['Spotřebiče do domácnosti | Fritézy','Spotřebiče do domácnosti | Trouby'] },
  { words: ['robot kuchyňský','food processor'],
    must: ['Spotřebiče do domácnosti | Kuchyňské roboty'] },
  { words: ['mixér','blender','tyčový mixér'],
    must: ['Spotřebiče do domácnosti | Mixéry'] },
  { words: ['vysavač','robotický vysavač','roomba'],
    must: ['Spotřebiče do domácnosti | Vysavače'] },
  { words: ['žehlička','parní stanice','žehlení'],
    must: ['Spotřebiče do domácnosti | Žehličky'] },
  { words: ['varna konvice','rychlovarná konvice'],
    must: ['Spotřebiče do domácnosti | Vařiče a konvice'] },
  { words: ['klimatizace','split klimatizace'],
    must: ['Spotřebiče do domácnosti | Klimatizace'] },
  { words: ['ventilátor','ochlazovač vzduchu','stojanový ventilátor'],
    must: ['Spotřebiče do domácnosti | Ventilátory'] },
  { words: ['čistička vzduchu','air purifier'],
    must: ['Spotřebiče do domácnosti | Čističky vzduchu'] },
  { words: ['zvlhčovač','humidifier'],
    must: ['Spotřebiče do domácnosti | Zvlhčovače'] },

  // === DŮM A DÍLNA ===
  { words: ['vrtačka','aku vrtačka','šroubovák'],
    must: ['Dům a dílna | Vrtačky','Dům a dílna | Šroubováky'] },
  { words: ['úhlová bruska','přímočará pila','okružní pila'],
    must: ['Dům a dílna | Brusky a pily'] },
  { words: ['multimetr','měřicí přístroj','tester'],
    must: ['Dům a dílna | Měřicí přístroje'] },
  { words: ['chytrý zámek','smart lock'],
    must: ['Dům a dílna | Bezpečnost'] },
  { words: ['led žárovka','chytrá žárovka','led pásek','smart osvětlení'],
    must: ['Dům a dílna | Osvětlení'] },
  { words: ['prodlužovací kabel','přepěťová ochrana','lišta zásuvek'],
    must: ['Dům a dílna | Prodlužovací kabely','Příslušenství | Napájení'] },

  // === AUTO-MOTO ===
  { words: ['autokosmetika','autošampon','vosk na auto'],
    must: ['Auto-moto | Autokosmetika'] },
  { words: ['držák telefonu do auta','nabíječka do auta'],
    must: ['Auto-moto | Elektrické doplňky','Auto-moto | Interiér vozidla'] },
  { words: ['dashcam','kamera do auta','autokamera'],
    must: ['Auto-moto | Elektrické doplňky','Kamery | '] },
  { words: ['střešní box','nosič kol','příčníky'],
    must: ['Auto-moto | Střešní boxy a nosiče'] },

  // === SPORT A KEMPING ===
  { words: ['elektrokolo','e-bike','kolo'],
    must: ['Sport a kemping | Elektrokola','Sport a kemping | Kola'] },
  { words: ['elektrokoloběžka','e-scooter'],
    must: ['Sport a kemping | Elektrokoloběžky'] },
  { words: ['stan','spacák','karimatka'],
    must: ['Sport a kemping | Kempink'] },

  // === KANCELÁŘ ===
  { words: ['kalkulačka','stolní kalkulačka'],
    must: ['Kancelář a papírnictví | Kalkulačky'] },
  { words: ['laminovačka','laminovač'],
    must: ['Kancelář a papírnictví | Laminovačky'] },
  { words: ['skartovačka','skartovač'],
    must: ['Kancelář a papírnictví | Skartovačky'] },

  // === ZAHRADA ===
  { words: ['sekačka na trávu','robotická sekačka','travní sekačka'],
    must: ['Zahrada | Zahradní technika | Sekačky'] },
  { words: ['gril','bbq','zahradní gril','smoker','udírna'],
    must: ['Zahrada | Krby, grily a udírny'] },
  { words: ['zahradní nářadí','lopata','hrábě','rýč'],
    must: ['Zahrada | Zahradní nářadí'] },
  { words: ['závlaha','zahradní hadice','postřikovač'],
    must: ['Zahrada | Zavlažování'] },

  // === E-ČTEČKY ===
  { words: ['čtečka knih','ebook čtečka','kindle','e-ink'],
    must: ['Čtečky e-knih | '] },

  // === SOFTWARE ===
  { words: ['antivirus','internet security','eset','avast','kaspersky'],
    must: ['Software | Bezpečnostní software'] },
  { words: ['microsoft office','office 365','kancelářský software'],
    must: ['Software | Kancelářský software'] },
  { words: ['windows 11','operační systém'],
    must: ['Software | Operační systémy'] },

  // === PŘÍSLUŠENSTVÍ PRO KONKRÉTNÍ ZAŘÍZENÍ ===
  { words: ['pouzdro','obal','kryt','sklo','fólie','příslušenství pro telefon','příslušenství pro mobil'],
    must: ['Příslušenství | Příslušenství pro mobilní telefony'] },
  { words: ['pouzdro na tablet','obal na tablet','klávesnice pro tablet','pero pro tablet'],
    must: ['Příslušenství | Příslušenství pro tablety'] },
  { words: ['brašna na notebook','batoh na notebook','chladič notebooku','dokovací stanice','příslušenství pro notebook'],
    must: ['Příslušenství | Příslušenství pro notebooky'] },
  { words: ['příslušenství pro monitor','stojan na monitor','arm na monitor','nástěnný držák monitoru'],
    must: ['Příslušenství | Příslušenství pro monitory'] },
  { words: ['příslušenství pro tv','držák na televizor','nástěnný držák televize'],
    must: ['Příslušenství | Příslušenství pro TV'] },
  { words: ['příslušenství pro projektor','plátno','projekční plátno','lampa do projektoru'],
    must: ['Příslušenství | Příslušenství pro projektory'] },
  { words: ['příslušenství pro sluchátka','náhradní polštářky','kabel ke sluchátkům'],
    must: ['Příslušenství | Příslušenství pro sluchátka a Bluetooth'] },
  { words: ['příslušenství pro hodinky','řemínek','band pro smartwatch'],
    must: ['Příslušenství | Příslušenství pro nositelnou elektroniku'] },
  { words: ['příslušenství pro gps','držák navigace','mapa garmin'],
    must: ['Příslušenství | Příslušenství pro GPS'] },
  { words: ['příslušenství pro čtečku','obal na čtečku','příslušenství pro kindle'],
    must: ['Příslušenství | Příslušenství pro čtečky knih'] },
  // === SPOTŘEBNÍ MATERIÁL — výrobci tiskáren ===
  { words: ['toner hp','cartridge hp','náplň hp','ink hp'],
    must: ['Spotřební materiál | Spotřební materiál pro tiskárny'] },
  { words: ['toner canon','cartridge canon','náplň canon'],
    must: ['Spotřební materiál | Spotřební materiál pro tiskárny'] },
  { words: ['toner epson','cartridge epson','náplň epson'],
    must: ['Spotřební materiál | Spotřební materiál pro tiskárny'] },
  { words: ['toner brother','cartridge brother'],
    must: ['Spotřební materiál | Spotřební materiál pro tiskárny'] },
  { words: ['toner samsung','toner xerox','toner lexmark','toner kyocera','toner oki'],
    must: ['Spotřební materiál | Spotřební materiál pro tiskárny'] },
  { words: ['papír a4','kancelářský papír','papír do tiskárny','role pro pokladnu'],
    must: ['Spotřební materiál | Papír a role pro tiskárny'] },
  { words: ['filament','tisková struna','pla filament','abs filament','petg'],
    must: ['Spotřební materiál | Tiskové struny (Filament)'] },
  // === NÁHRADNÍ DÍLY ===
  { words: ['náhradní díl','displej pro telefon','display pro mobil','sklo pro iphone','sklo pro samsung'],
    must: ['Náhradní díly | Náhradní díly pro telefony'] },
  { words: ['náhradní díl pro notebook','lcd display notebook','displej pro notebook'],
    must: ['Náhradní díly | LCD Display pro notebook'] },
  { words: ['náhradní díl pro tablet'],
    must: ['Náhradní díly | Náhradní díly pro tablety'] },
  // === KOMPONENTY — vztahové dotazy ===
  { words: ['základní deska pro ryzen','základní deska am4','základní deska am5','základní deska socket'],
    must: ['Komponenty | Základní desky'] },
  { words: ['základní deska pro intel','základní deska lga','základní deska lga1700'],
    must: ['Komponenty | Základní desky'] },
  { words: ['chlazení procesoru','cpu chladič','vodní chlazení','aio chlazení','ventilátor do pc'],
    must: ['Komponenty | Chlazení'] },
  { words: ['osvětlení pc','rgb páska','led páska do pc','rgb fan'],
    must: ['Komponenty | Osvětlení - LED, RGB, D-RGB'] },
  // === AUTO-MOTO — vztahové dotazy ===
  { words: ['autobaterie','startovací box','jump starter'],
    must: ['Auto-moto | Autobaterie'] },
  { words: ['olej do motoru','motorový olej','olej 5w40','olej 5w30'],
    must: ['Auto-moto | Oleje a maziva'] },
  { words: ['stěrač','stěrače','autostěrač'],
    must: ['Auto-moto | Stěrače'] },
  { words: ['zimní vybavení do auta','škrabka','lopata do auta','sněhové řetězy'],
    must: ['Auto-moto | Zimní výbava'] },
  { words: ['vůně do auta','osvěžovač vzduchu do auta','parfémy do auta'],
    must: ['Auto-moto | Vůně a parfémy do auta'] },
  { words: ['střešní box','nosič kol','nosič lyží','příčníky'],
    must: ['Auto-moto | Střešní boxy a nosiče'] },
  { words: ['kamera do auta','dashcam','autokamera'],
    must: ['Kamery | Kamery do auta'] },
  // === SPORT — vztahové dotazy ===
  { words: ['rybářský prut','rybářský vlasec','rybářské potřeby','rybářský háček'],
    must: ['Sport a kemping | Rybářské potřeby'] },
  { words: ['cyklistická helma','cyklistické oblečení','cyklistický batoh'],
    must: ['Sport a kemping | Cyklistika'] },
  { words: ['trampolína','trampolíny','trampolin'],
    must: ['Sport a kemping | Trampolíny a příslušenství'] },
  { words: ['plavání','vodní sport','šnorchl','ploutve'],
    must: ['Sport a kemping | Vodní sporty'] },
  // === ZDRAVÍ — vztahové dotazy ===
  { words: ['elektrický kartáček','elektrický zubní kartáček','oral-b','sonic zubní'],
    must: ['Krása a zdraví | Zdraví a zdravotnické přístroje'] },
  { words: ['depilator','epilátor','holicí strojek'],
    must: ['Krása a zdraví | Zdraví'] },
  { words: ['doplněk stravy','vitamíny','protein','sportovní výživa'],
    must: ['Krása a zdraví | Doplňky stravy','Krása a zdraví | Sportovní výživa'] },
  // === POKLADNÍ SYSTÉMY — vztahové dotazy ===
  { words: ['čtečka čárových kódů','scanner kódů','barcode reader'],
    must: ['Pokladní a evidenční systémy | Čtečky čárových kódů'] },
  { words: ['pokladní zásuvka','finanční zásuvka'],
    must: ['Pokladní a evidenční systémy | Pokladní zásuvky'] },
  { words: ['zákaznický displej','display pro pokladnu'],
    must: ['Pokladní a evidenční systémy | Zákaznické displeje'] },
  { words: ['rfid čtečka','rfid čip'],
    must: ['Pokladní a evidenční systémy | Čtečky karet RFID'] },
  // === ZAHRADA — vztahové dotazy ===
  { words: ['zahradní hadice','zavlažování','postřikovač','zahradní nádrž'],
    must: ['Zahrada | Zavlažování'] },
  { words: ['zahradní nábytek','zahradní stůl','zahradní židle','zahradní lavice'],
    must: ['Zahrada | Zahradní nábytek'] },
  { words: ['bazén','vířivka','sauna','zahradní bazén'],
    must: ['Zahrada | Bazény, vířivky a sauny'] },
  // === DOMÁCÍ POTŘEBY — vztahové dotazy ===
  { words: ['tlakový hrnec','parní hrnec'],
    must: ['Domácí potřeby | Tlakové hrnce'] },
  { words: ['zapékací forma','pečící forma','plech na pečení'],
    must: ['Domácí potřeby | Zapékací formy'] },
  { words: ['kuchyňské nože','sada nožů','japonský nůž','šéfkuchařský nůž'],
    must: ['Domácí potřeby | Kuchyňské nože'] },
  // === POKLADNÍ SYSTÉMY ===
  { words: ['pokladna','pos systém','registrační pokladna','eet'],
    must: ['Pokladní a evidenční systémy | '] },
];

// ============================================================
// VZTAHOVÝ PREPROCESOR DOTAZU
// Rozpozná vzory "X pro Y", "X k Y", "X kompatibilní s Y"
// a doplní správné klíčové slovo pro vyhledávání
// ============================================================

// Mapování produktů/zařízení → kategorie příslušenství
const DEVICE_TO_ACCESSORY = {
  // Telefony → příslušenství pro telefony
  'iphone':       ['pouzdro','obal','kryt','nabíječka','kabel','sklo','folie','držák','powerbank','příslušenství pro mobilní telefony'],
  'samsung':      ['pouzdro','obal','kryt','nabíječka','kabel','sklo','příslušenství pro mobilní telefony'],
  'xiaomi':       ['pouzdro','obal','kryt','nabíječka','příslušenství pro mobilní telefony'],
  'huawei':       ['pouzdro','obal','kryt','příslušenství pro mobilní telefony'],
  'mobil':        ['pouzdro','obal','nabíječka','kabel','příslušenství pro mobilní telefony'],
  'telefon':      ['pouzdro','obal','nabíječka','kabel','příslušenství pro mobilní telefony'],
  // Notebooky → příslušenství pro notebooky
  'notebook':     ['brašna','baterie','adaptér','nabíječka','chladič','dokovací stanice','příslušenství pro notebooky'],
  'laptop':       ['brašna','baterie','adaptér','nabíječka','příslušenství pro notebooky'],
  'macbook':      ['brašna','pouzdro','adaptér','příslušenství pro notebooky'],
  // Tablety → příslušenství pro tablety
  'tablet':       ['pouzdro','klávesnice','pero','příslušenství pro tablety'],
  'ipad':         ['pouzdro','klávesnice','apple pencil','příslušenství pro tablety'],
  // Tiskárny → spotřební materiál
  'tiskárna':     ['toner','cartridge','náplň','papír','spotřební materiál pro tiskárny'],
  'tiskarna':     ['toner','cartridge','náplň','spotřební materiál pro tiskárny'],
  'hp':           ['toner','cartridge','náplň','spotřební materiál pro tiskárny'],
  'canon':        ['cartridge','náplň','spotřební materiál pro tiskárny'],
  'epson':        ['cartridge','náplň','spotřební materiál pro tiskárny'],
  'brother':      ['toner','cartridge','spotřební materiál pro tiskárny'],
  'lexmark':      ['toner','spotřební materiál pro tiskárny'],
  'laserjet':     ['toner','spotřební materiál pro tiskárny'],
  'officejet':    ['cartridge','spotřební materiál pro tiskárny'],
  // Procesory → základní desky
  'ryzen':        ['základní deska','motherboard','socket am4','socket am5'],
  'intel':        ['základní deska','motherboard','lga1700','lga1200'],
  'core i':       ['základní deska','motherboard'],
  'amd':          ['základní deska','grafická karta'],
  // Monitory → příslušenství pro monitory
  'monitor':      ['stojan','arm','kabel hdmi','displayport','příslušenství pro monitory'],
  // Sluchátka → příslušenství pro sluchátka
  'sluchátka':    ['náhradní polštářky','kabel','příslušenství pro sluchátka'],
  'headset':      ['náhradní díly','příslušenství pro sluchátka'],
  // Fotoaparát → příslušenství foto
  'fotoaparát':   ['objektiv','baterie','paměťová karta','brašna','příslušenství foto'],
  'fotak':        ['objektiv','baterie','paměťová karta','příslušenství foto'],
  // Auto → auto-moto příslušenství
  'auto':         ['držák','nabíječka','dashcam','autokosmetika','auto-moto'],
  'auta':         ['příslušenství','auto-moto'],
  // TV → příslušenství pro TV
  'televize':     ['dálkový ovladač','nástěnný držák','příslušenství pro tv'],
  'televizor':    ['dálkový ovladač','držák','příslušenství pro tv'],
  // Projektor → příslušenství pro projektory
  'projektor':    ['plátno','lampa','příslušenství pro projektory'],
  // GPS → příslušenství pro GPS
  'garmin':       ['mapa','držák','příslušenství pro gps'],
  'navigace':     ['držák','nabíječka','příslušenství pro gps'],
  // Chytré hodinky → příslušenství
  'hodinky':      ['řemínek','nabíječka','příslušenství pro nositelnou elektroniku'],
  'smartwatch':   ['řemínek','nabíječka','příslušenství pro nositelnou elektroniku'],
  // Kamera → příslušenství
  'kamera':       ['baterie','paměťová karta','stativ','příslušenství foto video'],
  'gopro':        ['mount','baterie','příslušenství'],
  // PC → příslušenství pro počítače
  'pc':           ['příslušenství pro počítače','klávesnice','myš'],
  'počítač':      ['příslušenství pro počítače','klávesnice','myš'],
};

// Vzory vztahových dotazů
const RELATION_PATTERNS = [
  // === KOMPONENTY — specifické vzory PŘED obecnými ===
  // "základní deska pro Ryzen/AMD" → základní deska AM4
  { re: /základní\s+desk[au]\s+(?:pro|s|socket)?\s*(?:ryzen|amd)/i, fn: () => 'základní deska AM4 socket' },
  { re: /základní\s+desk[au]\s+(?:pro|s|socket)?\s*(?:intel|core|i[3579])/i, fn: () => 'základní deska LGA intel' },
  { re: /deska\s+(?:pro|s|socket)\s+(?:ryzen|amd)/i, fn: () => 'základní deska AM4 socket' },
  // "chlazení pro Ryzen/Intel/CPU" → chlazení procesoru
  { re: /chlazení\s+(?:pro|na|k)\s+(?:ryzen|amd|intel|cpu|procesor)/i, fn: () => 'chlazení procesoru chladič' },
  { re: /chladič\s+(?:pro|na|k)\s+(?:ryzen|amd|intel|cpu)/i, fn: () => 'chlazení procesoru chladič' },
  // "ram pro notebook/laptop" → sodimm notebook
  { re: /ram\s+(?:pro|do|k)\s+(?:notebooku?|laptopu?)/i, fn: () => 'sodimm ram paměť notebook' },
  { re: /paměť\s+(?:pro|do)\s+(?:notebooku?|laptopu?)/i, fn: () => 'sodimm ram paměť notebook' },
  // "ssd pro PS5/konzoli" → ssd nvme m.2
  { re: /ssd\s+(?:pro|do)\s+(?:ps5|playstation|xbox|konzoli?)/i, fn: () => 'ssd nvme m.2' },
  // "zdroj pro RTX/grafiku" → pc zdroj
  { re: /zdroj\s+(?:pro|k)\s+(?:rtx|gtx|grafik|rx\s*\d)/i, fn: () => 'pc zdroj psu napájení' },
  // "skříň pro mini ITX/ATX" → pc skříň
  { re: /skříň\s+(?:pro|na)?\s*(?:mini\s*itx|micro\s*atx|matx|atx)/i, fn: () => 'pc skříň midi tower' },
  // === PŘÍSLUŠENSTVÍ & NÁHRADNÍ DÍLY ===
  // "náhradní díl pro Lenovo IdeaPad" → náhradní díl + Lenovo
  { re: /^náhradní\s+díl\s+(?:pro|k)\s+(.+)$/i, fn: (m) => 'náhradní díly ' + m[1] },
  // "baterie do notebooku Lenovo" → baterie notebook Lenovo
  { re: /bater(?:ie|ii)\s+(?:do|pro|k)\s+(?:notebooku?|laptopu?)\s*(.*)$/i, fn: (m) => 'baterie notebook ' + (m[1]||'') },
  // "adaptér pro notebook Dell" → adaptér notebook Dell
  { re: /adapt[eé]r\s+(?:pro|k|do)\s+(.+)$/i, fn: (m) => 'adaptér ' + m[1] },
  // === OBECNÉ — až na konci ===
  { re: /^(.+?)\s+(?:pro|k|ke|do|na|kompatibiln[íi]\s+s?)\s+(.+)$/i, fn: (m) => m[1] + ' ' + m[2] },
];

// Preprocesor: transformuje dotaz pro lepší výsledky search
function preprocessQuery(query) {
  const q = query.trim();

  // Zkus vztahové vzory
  for (const pat of RELATION_PATTERNS) {
    const m = q.match(pat.re);
    if (m) {
      const transformed = pat.fn(m);
      if (transformed && transformed !== q) return transformed;
    }
  }

  // Zkus device→accessory mapování
  // Vzor: "[příslušenství] pro/na/k [zařízení]" nebo "[zařízení] [příslušenství]"
  const qn = norm(q);
  for (const [device, accessories] of Object.entries(DEVICE_TO_ACCESSORY)) {
    if (qn.includes(norm(device))) {
      // Pokud dotaz obsahuje zařízení, přidej kontext kategorií příslušenství
      // ale jen pokud dotaz vypadá jako příslušenství (obsahuje "pro", "k", "na", "obal", "kabel"...)
      const ACCESSORY_HINTS = ['pro','pouzdro','obal','kabel','nabíječka','baterie','toner','cartridge','náplň','příslušenství','náhradní','kompatibilní','držák','adaptér','stojan','kryt','sklo','folie'];
      const isAccessoryQuery = ACCESSORY_HINTS.some(h => qn.includes(h));
      if (isAccessoryQuery) {
        // Přidej první accessory klíčové slovo jako hint
        return q + ' ' + accessories[0];
      }
    }
  }

  return q; // Beze změny
}

function search(query, max) {
  max = max || 30;
  if (products.length === 0) return [];
  const processedQuery = preprocessQuery(query);
  const q = norm(processedQuery);

  // Tokenizace a rozšíření synonymy
  const originalTokens = tokenize(q);
  if (originalTokens.length === 0) return [];

  // Budget parsing - zachytit "10 000 Kč", "10000 Kč", "10 tisíc", ale i pouhé "do 20000" nebo "20000"
  const bmRaw = query.match(/(\d[\d\s]{0,8})\s*(k[cč]|czk|tis[íi][cč]?|tis\.?|k\b)/i);
  const bmPlain = query.match(/\bdo\s+(\d{4,6})\b/i); // "do 20000" bez jednotky
  const budget = bmRaw
    ? parseFloat(bmRaw[1].replace(/\s/g,'')) * (/tis|k\b/i.test(bmRaw[2]) && !/kc|kč/i.test(bmRaw[2]) ? 1000 : 1)
    : bmPlain ? parseFloat(bmPlain[1]) : null;

  // Odfiltrovat čistá čísla z tokenů - "20000" není klíčové slovo produktu
  const filteredTokens = originalTokens.filter(t => !/^\d+$/.test(t));
  const expandedTokens = expandTokens(filteredTokens.length > 0 ? filteredTokens : originalTokens);

  // Přesná fráze pro bonus (první 3 tokeny spojené)
  const phraseNorm = filteredTokens.slice(0, 3).join(' ');

  // Filtr displeje
  let minDisplej = null, maxDisplej = null;
  if (/velk[ýá] displej|velk[áý] obrazovka/i.test(query)) minDisplej = 6.2;
  if (/mal[ýá] displej|kompaktn/i.test(query)) maxDisplej = 6.2;
  const dispMatch = query.match(/(\d{1,2}\.?\d?)\s*"/);
  if (dispMatch) { minDisplej = parseFloat(dispMatch[1]) - 0.2; maxDisplej = parseFloat(dispMatch[1]) + 0.2; }

  // CAT_RULES jako volitelné pre-filtrovani poolu (zrychlení u jednoznačných dotazů)
  let pool = products;
  let catFilter = [];
  for (const rule of CAT_RULES) {
    if (rule.words.some(w => norm(w).split(' ').every(wt => q.includes(wt)))) {
      catFilter = rule.must; break;
    }
  }
  if (catFilter.length > 0) {
    const cf = products.filter(p => catFilter.some(f => {
      const nk = norm(p.kategorie);
      const nf = norm(f).trim();
      return nk.startsWith(nf) || nk === nf.trim();
    }));
    if (cf.length >= 5) pool = cf;
  }

  // Budget filtr
  if (budget && budget > 500) {
    const bf = pool.filter(p => p.cena > 0 && p.cena <= budget * 1.1);
    if (bf.length >= 2) pool = bf;
  }

  // Filtr displeje
  if (minDisplej || maxDisplej) {
    const df = pool.filter(p => {
      const par = parseParams(p.nazev);
      if (!par.displej) return true;
      if (minDisplej && par.displej < minDisplej) return false;
      if (maxDisplej && par.displej > maxDisplej) return false;
      return true;
    });
    if (df.length >= 3) pool = df;
    else if (minDisplej) pool = pool.sort((a,b) => (parseParams(b.nazev).displej||0) - (parseParams(a.nazev).displej||0));
  }

  // Skórování všech produktů v poolu
  const scored = pool
    .map(p => ({ p, score: scoreProduct(p, expandedTokens, filteredTokens, phraseNorm) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score !== a.score ? b.score - a.score : a.p.cena - b.p.cena);

  // Cenová diverzifikace — pokud jsou všechny výsledky se stejným score,
  // rozlož je do cenových pásem aby Claude měl výběr z celého spektra
  const topScore = scored.length > 0 ? scored[0].score : 0;
  const sameScore = scored.filter(x => x.score === topScore);
  let finalPool;
  if (sameScore.length > 8) {
    // Rozděl na 3 cenová pásma a vezmi z každého proporcionálně
    const prices = sameScore.map(x => x.p.cena).filter(c => c > 0).sort((a,b) => a-b);
    const p33 = prices[Math.floor(prices.length * 0.33)];
    const p66 = prices[Math.floor(prices.length * 0.66)];
    const low    = sameScore.filter(x => x.p.cena <= p33);
    const mid    = sameScore.filter(x => x.p.cena > p33 && x.p.cena <= p66);
    const high   = sameScore.filter(x => x.p.cena > p66);
    // Vezmi ~10 z každého pásma, pak doplň ostatními
    const pick = (arr, n) => arr.filter(x => x.p.dostupnost === '0').slice(0, n)
      .concat(arr.filter(x => x.p.dostupnost !== '0').slice(0, Math.max(0, n - arr.filter(x => x.p.dostupnost === '0').length)));
    finalPool = [...pick(low, 10), ...pick(mid, 10), ...pick(high, 10)];
    // Doplň zbývající pokud je méně než max
    const usedIds = new Set(finalPool.map(x => x.p.url));
    const rest = scored.filter(x => !usedIds.has(x.p.url));
    finalPool = [...finalPool, ...rest].slice(0, max);
  } else {
    finalPool = scored.slice(0, max);
  }

  return finalPool.map(({ p }) => ({
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

SORTIMENT Mironet.cz: elektronika, IT technika, notebooky, telefony, tablety, komponenty, site, monitory, tiskárny, audio-video, televize, fotoaparaty, kamery, chytre hodinky, GPS, herni zarizeni, spotrebice do domacnosti, zahradní technika, sport a kemping, chovatelske potreby, hracky, kancelarske potreby, auto-moto prislusenstvi, domaci potreby a dalsi.

POBOCKY:
${pobocky}

LINKA: 777 900 777 (Po-Pa 8-17h)
OBJEDNAVKY: mironet.cz/muj-ucet

PRAVIDLA:
- Doporucuj POUZE produkty ze seznamu nize - pokud produkt v seznamu neni, NIKDY ho nevymyslej
- Pokud pozadovany produkt v katalogu neni, nasmeruj na mironet.cz kde je kompletni sortiment
- NIKDY nerikej ze Mironet neco neprodava - mozna to jen neni v tomto vyhledavani, vzdy nasmeruj na mironet.cz
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

  // Detekce kontextových slov - dotazy jako "levnější", "jiný", "ukáž víc"
  const KONTEXTOVY = /^(lev[nň]|dra[žh]|jin[ýá]|víc|víc|dal[šs]í|ukáž|jinak|alternativ|podobn|co takhle|a co|ještě|stejn)/i;
  const jeKontextovy = KONTEXTOVY.test(userMessage.trim()) || userMessage.trim().length < 15;

  // Smart search: primárně hledej podle samotného userMessage
  // Pokud nenajde nic NEBO je dotaz kontextový, zkus s kontextem posledního user dotazu
  let found = [];
  if (!jeServisni) {
    found = search(userMessage);
    // Fallback 1: pokud nic nenašlo nebo kontextový dotaz → přidej kontext posledního user dotazu
    if (found.length === 0 || jeKontextovy) {
      const lastUserMsg = messages.filter(m => m.role === 'user').slice(-1).map(m => m.content).join(' ');
      const ctxQuery = lastUserMsg ? lastUserMsg + ' ' + userMessage : userMessage;
      const ctxFound = search(ctxQuery);
      if (ctxFound.length > found.length) found = ctxFound;
    }
  }
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

app.get('/debug-stats', (req, res) => {
  const stats = {};
  for (const p of products) {
    const top = (p.kategorie || 'nezname').split(' | ')[0].trim();
    stats[top] = (stats[top] || 0) + 1;
  }
  const sorted = Object.entries(stats).sort((a,b) => b[1]-a[1]);
  res.json({ celkem: products.length, kategorie_pocty: Object.fromEntries(sorted) });
});

app.get('/debug-feed', (req, res) => {
  const topKats = [...new Set(products.map(p => (p.kategorie||'').split(' | ')[0].trim()))].sort();
  const sample = products.slice(0, 5).map(p => ({ nazev: p.nazev, kategorie: p.kategorie, cena: p.cena }));
  const q = req.query.q;
  let searchResult = [];
  if (q) {
    searchResult = products
      .filter(p => p.nazev.toLowerCase().includes(q.toLowerCase()) || (p.kategorie||'').toLowerCase().includes(q.toLowerCase()))
      .slice(0, 5)
      .map(p => ({ nazev: p.nazev, kategorie: p.kategorie, cena: p.cena }));
  }
  res.json({ celkem_produktu: products.length, top_kategorie: topKats, prvnich_5: sample, hledano: q||null, nalezeno: searchResult });
});

app.get('/debug-search', (req, res) => {
  const q = req.query.q || 'notebook';
  const results = search(q, 5);
  const qn = norm(q);
  const filtTokens = tokenize(qn).filter(t => !/^\d+$/.test(t));
  const expanded = expandTokens(filtTokens);
  const phrase = filtTokens.slice(0,3).join(' ');

  // Simuluj CAT_RULES matching
  let catFilter = [];
  for (const rule of CAT_RULES) {
    if (rule.words.some(w => norm(w).split(' ').every(wt => qn.includes(wt)))) {
      catFilter = rule.must; break;
    }
  }
  const poolAfterCat = catFilter.length > 0
    ? products.filter(p => catFilter.some(f => { const nk = norm(p.kategorie); const nf = norm(f).trim(); return nk.startsWith(nf) || nk === nf.trim(); }))
    : products;
  const bmPlain = q.match(/\bdo\s+(\d{4,6})\b/i);
  const budget = bmPlain ? parseFloat(bmPlain[1]) : null;
  const poolAfterBudget = budget ? poolAfterCat.filter(p => p.cena > 0 && p.cena <= budget * 1.1) : poolAfterCat;

  const notebooky = products.filter(p => (p.kategorie||'').startsWith('Notebooky')).slice(0,3);
  const scoredNb = notebooky.map(p => ({
    nazev: p.nazev.substring(0,50),
    kategorie: p.kategorie,
    cena: p.cena,
    score: scoreProduct(p, expanded, filtTokens, phrase)
  }));
  const allResults = search(q, 30);
  const prices = allResults.map(r => parseInt(r.cena.replace(/\s/g,'').replace('Kc',''))).filter(p => p > 0).sort((a,b) => a-b);
  res.json({
    query: q, tokens: filtTokens,
    catFilter, pool_po_cat: poolAfterCat.length, pool_po_budget: poolAfterBudget.length,
    budget,
    search_count: allResults.length,
    cena_min: prices[0] || 0,
    cena_max: prices[prices.length-1] || 0,
    search_results: allResults.slice(0,3),
    notebooky_score: scoredNb
  });
});

app.get('/debug-kat', (req, res) => {
  const kat = req.query.kat || 'Notebooky';
  const matched = products.filter(p => (p.kategorie||'').startsWith(kat));
  res.json({ kat, pocet: matched.length, prvnich_10: matched.slice(0,10).map(p => ({ nazev: p.nazev, kategorie: p.kategorie, cena: p.cena })) });
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
  res.json({ status: 'ok', version: '2.1', model: CONFIG.MODEL, produktu: products.length, apiKlic: !!CONFIG.ANTHROPIC_API_KEY, pobocky: CONFIG.POBOCKY.map(p => p.nazev) });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

loadProducts();
app.listen(CONFIG.PORT, () => { console.log('Mironet AI Asistent bezi na portu ' + CONFIG.PORT); });
