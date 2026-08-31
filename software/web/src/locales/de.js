// locales/de.js - DEUTSCH. Gleiche Struktur wie en.js; Zahlen, Bauteilnamen
// und Einheiten bleiben identisch. Ehrlichkeitsregeln gelten unveraendert:
// keine unbelegten Verfahren, keine Zertifikate, die wir nicht besitzen; das
// Metall bleibt OFFEN (AlSi10Mg oder 316L, keines gefertigt); EUR 1.599,84
// ist der KALKULIERTE Vier-Finger-Entwurf, nie ausgegebenes Geld.

export const L = {
  nav: {
    explore: "Erkunden",
    build: "Bauen",
    write: "Schreib mir",
  },

  hero: {
    kicker: "TAKTO ONE",
    title: 'Die Hand,<br><em>lebendig</em>.',
    sub: "Ein tragbares Exoskelett, das die menschliche Hand liest, unterstützt und aufzeichnet.",
    byline: "Entworfen, gebaut und programmiert von einem Ingenieur: Juan Sebastian Molano, M.Sc.",
    ctaExplore: "Live erkunden",
    ctaBuild: "Selber bauen",
    ctaWrite: "Schreib mir",
    live: "simulierter Live-Feed",
    liveOpen: "Operator-Konsole öffnen",
  },

  story: [
    { kicker: "Anlegen", head: "Anschnallen.",
      line: "Vier Fingerschienen, eine Handplatte, ein Unterarmdock: ein Handschuh aus Maschine." },
    { kicker: "Messen", head: "Es liest deine Hand.",
      line: "Zwölf Gelenkencoder und drei Bewegungsrahmen verfolgen jede Geste, fünfzig Mal pro Sekunde." },
    { kicker: "Mechanismus", head: "Es dehnt sich mit, wenn du greifst.",
      line: "Jedes Gelenk teleskopiert: Die Maschine verlängert sich mit dem Finger, statt gegen ihn zu arbeiten." },
    { kicker: "Antrieb", head: "Kraft, die sich auf null drehen lässt.",
      line: "Sehnenspulen geben jedem Finger Kraft; dreh die Krone, und sie blendet bis zu reiner Transparenz." },
    { kicker: "An Bord", head: "Ein Gehirn am Handgelenk.",
      line: "Unter dem Deckel: zehn Spulenplätze, der Teensy, der jeden Sensor liest, und stundenlange Aufzeichnung direkt auf SD." },
    { kicker: "Die Vision", head: "Eine Schnittstelle zwischen dir und jeder Maschine.",
      line: "Bewegung, Anstrengung, Kraft, aufgeschrieben: Daten, um Roboter zu teleoperieren, ihnen das Greifen beizubringen und einer Hand ihre Stärke zurückzugeben." },
  ],

  specsKicker: "Auf einen Blick",
  specs: [
    { n: "12", u: "gemessene Gelenke", d: "ein Encoder an jedem Fingergelenk" },
    { n: "3", u: "Inertialrahmen", d: "Hand, Unterarm und Daumenspitze" },
    { n: "50", u: "Hz Telemetrie", d: "Vollzustands-Stream direkt vom Gerät" },
    { n: "SD", u: "Aufzeichnung an Bord", d: "zeichnet ohne angebundenen Host auf" },
  ],

  craft: ["Mechanismus-Design", "Auslegung für Metall-AM", "Eigene Leiterplatten",
    "Embedded-Firmware", "Echtzeitregelung", "Web · AR · Android"],

  film: { kicker: "Auf der Werkbank", head: "Die echte Maschine.",
    alt: "TAKTO ONE auf der Werkbank" },

  creed: {
    kicker: "Warum es das gibt",
    head: "Warum ich baue.",
    p: "Ein Hammer, der einen Nagel ins Holz treibt, baut indirekt ein Haus. Eine Hand, die einen Finger bewegt, tut indirekt unendlich viele Dinge, und Menschen mit weit mehr Fantasie als ich werden sie tun. Jeder, den ich frage, sieht etwas anderes darin. Genau das ist der Punkt. Das hier ist kein Konzern, und es geht nicht um Geld. Ich baue aus Liebe zum Erschaffen, und ich teile sie mit allen, die sie mit ihrer Zeit und Aufmerksamkeit ehren.",
  },

  explore: {
    kicker: "Live-Demo",
    head: "Fass es an.",
    sub: "Sechs Konsolen, ein 50-Hz-Protokoll, in deinem Browser auf einem simulierten Datenstrom, exakt wie auf der Hardware.",
    items: {
      operator: { name: "Operator", line: "Live-Telemetrie, Tuning und der Zwilling." },
      guided: { name: "Geführt", line: "Therapieübungen, jede Wiederholung gemessen." },
      mirror: { name: "Spiegel", line: "Kamera-Biofeedback: Die gesunde Hand führt." },
      capture: { name: "Aufnahme", line: "Gelabelte Bewegungsdatensätze aufzeichnen." },
      sign: { name: "Gebärden-Aufnahme", line: "Deutsche Gebärdensprache aufnehmen, Prompt für Prompt." },
      translate: { name: "Live-Übersetzung", line: "Gebärden erkannt, während du gebärdest." },
    },
    resume: "Weiter",
  },

  build: {
    kicker: "Bauen",
    head: "Zum Selberbauen.",
    cards: [
      { k: "Quellcode", h: "Von der Firmware bis zum Frontend",
        p: "Firmware, Host-Bridge, drei Konsolen, diese Seite inklusive.",
        label: "GitHub" },
      { k: "Preprint", h: "TAKTO ONE Paper",
        p: "Offenes Forschungspapier. Diese URL wird nach Vergabe durch die DOI ersetzt.",
        label: "Preprint lesen" },
      { k: "Bauanleitung", h: "TAKTO ONE bauen",
        p: "Schritt-für-Schritt-Anleitung für den Aufbau des vollständigen Instruments.",
        label: "Anleitung öffnen" },
    ],
    sheetCue: "Das vollständige Datenblatt, jede Zahl",
    sheetTitle: "TAKTO ONE — Datenblatt",
    rows: [
      ["Gelenksensorik", "12x AS5600-Magnetencoder · 0.088 deg · 50 Hz"],
      ["Bewegungsrahmen", "3x BNO085-IMU: Handrücken, Unterarm, Daumenspitze"],
      ["Anstrengung", "Oberflächen-EMG-Hüllkurve, Intentionsschätzung auf dem Host"],
      ["Antrieb", "2x Dynamixel XC330-M181-T pro Finger · ein Finger auf der Werkbank motorisiert"],
      ["Übertragung", "antagonistisches Seilpaar auf einer 5-mm-Spule pro Gelenk · Beugung und Streckung aus demselben Motor, kein Spiel beim Richtungswechsel"],
      ["Sehne", "0.30 mm geflochtenes UHMWPE (Dyneema) in PTFE-Führung"],
      ["Mechanismus", "selbstausrichtende Teleskopkinematik · verlängert sich bei voller Beugung um fast 1 cm, damit die Orthese nie gegen den Finger arbeitet"],
      ["Bewegungsumfang", "MCP 90 deg · PIP 110 deg · mechanische Endanschläge an den Grenzen der Anatomie · vorzeichenbehaftete Abduktionsmessung an jedem MCP"],
      ["Unterstützung", "über die Krone stufenlos: von voller Unterstützung bis zu reiner Transparenz"],
      ["Sicherheit", "hartes Stromlimit 150 mA, sanfte 80 mA · die Maschine kann ihren Träger nie überwältigen"],
      ["Steuerung", "Teensy 4.1 @ 600 MHz · 50-Hz-Vollzustands-Stream · rundes Statusdisplay"],
      ["Aufzeichnung", "stundenlange SD-Aufzeichnung an Bord + gelabelte Takes von jeder Konsole"],
      ["Konsolen", "Web-Operator-Suite · AR-Erlebnis · Android-Begleiter"],
      ["Materialien", "gedruckte PETG-Struktur im Aufbau · 2 Glieder pro Finger für Metall-AM ausgelegt, Aluminium (AlSi10Mg) oder 316L · Gleitpaare kombinieren eine harte Fläche mit selbstschmierendem Polymer"],
      ["Getragene Masse", "Ziel an der Hand < 150 g · die Aktuatoren sitzen am Unterarm"],
      ["Materialkosten", "EUR 1.599,84 · der kalkulierte Vier-Finger-Entwurf, acht Motoren"],
    ],
    github: "GitHub",
    write: "Schreib mir",
  },

  compliance: {
    kicker: "Für Europa gebaut",
    head: "Konform durch Konstruktion.",
    p: "Ein Forschungsinstrument, nach europäischen Regeln konstruiert: DSGVO-Datenschutz durch Technikgestaltung, harte Sicherheitsgrenzen und ein kartierter Weg in die Klinik. Kein zertifiziertes Medizinprodukt, und es sagt das offen.",
    cue: "Die Compliance-Karte lesen",
    cards: [
      { k: "Datenschutz · DSGVO", p: "Datenschutz durch Technikgestaltung (Art. 25 DSGVO): Jedes Signal bleibt bei dir, auf der SD-Karte des Geräts und deinem eigenen Host-Rechner. Keine Cloud, keine Drittverarbeiter. Diese Seite hält es genauso: keine Cookies, keine Tracker, keine Analytik." },
      { k: "Sicherheit durch Konstruktion", p: "Ein hartes Stromlimit von 150 mA (80 mA in sanften Modi), mechanische Anschläge an den Grenzen der Anatomie und Unterstützung, die sich buchstäblich auf null drehen lässt. Die Host-überwachte Architektur hält die Klinik in der Verantwortung." },
      { k: "Der klinische Weg", p: "TAKTO ONE ist heute ein Forschungsinstrument, kein zertifiziertes Medizinprodukt, und sagt das offen. Der kartierte Weg in die Klinik: Qualitätsmanagement nach DIN EN ISO 13485, Risikomanagement nach DIN EN ISO 14971, Software-Lebenszyklus nach IEC 62304, elektrische Sicherheit nach IEC 60601-1, Konformität als Klasse-IIa-Produkt nach EU-MDR 2017/745, dann das CE-Zeichen." },
    ],
    finePre: "Impressum und Datenschutzerklärung der Website: ",
    fineLink: "Impressum & Datenschutz",
  },

  write: {
    kicker: "Schreib mir",
    head: "Ein Paar Hände hat das gebaut.",
    p1: "Ich bin Juan Sebastian Molano, Biomedizintechnik-Ingenieur. Ich habe TAKTO ONE von der ersten Skizze bis zum funktionierenden Instrument getragen: Mechanismus, Leiterplatten, Firmware und jede Konsole auf dieser Seite.",
    p2: "Jetzt suche ich mein nächstes Team: Rehabilitationsrobotik, verkörperte KI, überall dort, wo Hardware auf Lernen trifft. Jobs, Ideen, Kollaborationen. Wenn sich diese Seite nach deiner Art von Ingenieurskunst liest: Schreib mir. Ich antworte.",
    contact: "Kontakt aufnehmen",
    github: "GitHub",
    cv: "Lebenslauf",
  },

  foot: {
    feed: "simulierter Live-Feed",
    legal: "Impressum & Datenschutz",
  },
};
