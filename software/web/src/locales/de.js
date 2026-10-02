// locales/de.js - DEUTSCH. Gleiche Struktur wie en.js; Zahlen, Bauteilnamen
// und Einheiten bleiben identisch. Ehrlichkeitsregeln gelten unveraendert:
// keine unbelegten Verfahren, keine Zertifikate, die wir nicht besitzen; das
// Metall bleibt OFFEN (AlSi10Mg oder 316L, keines gefertigt); EUR 1.222,25
// ist der KALKULIERTE Vier-Finger-Entwurf und deckt nur die bepreisten
// Positionen aus docs/BOM.md ab, nie ausgegebenes Geld.

export const L = {
  nav: {
    design: "Design",
    tech: "Technik",
    specs: "Daten",
    build: "Open Source",
    contact: "Kontakt",
    console: "Konsole",
    consoleTitle: "Die Live-Konsole öffnen",
  },

  hero: {
    tagline: "Die Hand, lebendig.",
    sub: "Ein tragbares Exoskelett, das die menschliche Hand liest, unterstützt und aufzeichnet.",
    finishLabel: "Ausführung",
    cta: "Konsole öffnen",
    next: "Weiter nach unten",
  },

  finishes: {
    snow: { name: "Snow", line: "Weiße Schale, graphitfarbene Schienen." },
    onyx: { name: "Onyx", line: "Graphit, vom Unterarm bis zur Fingerspitze." },
    signal: { name: "Signal", line: "Orange Spulen, blaue Finger." },
  },

  intro: {
    kicker: "TAKTO ONE",
    head: "Um die Hand herum gebaut.",
    sub: "Ein Forschungsinstrument für das fähigste Werkzeug, das wir haben.",
    left: "TAKTO ONE ist ein tragbares Hand-Exoskelett. Vier Fingerschienen, eine Handplatte und eine Unterarmeinheit lesen jedes Gelenk, geben über Sehnen Kraft dazu und zeichnen auf, was die Hand tut.",
    right: "Von einem einzigen Ingenieur, Sebastian Molano, durchgehend entworfen, gebaut und programmiert: ein offenes Instrument für Rehabilitationsforschung, Bewegungsdaten und Teleoperation.",
    tiles: ["Vier Fingerschienen", "Beugt sich mit dir", "Eine Unterarmeinheit"],
  },

  turn: {
    kicker: "Design",
    head: "Jeder Winkel durchdacht.",
    caps: [
      { h: "Teleskopierende Finger.",
        p: "Selbstausrichtende Glieder werden beim Beugen fast einen Zentimeter länger, damit die Orthese nie gegen den Finger arbeitet." },
      { h: "Das Gewicht sitzt am Unterarm.",
        p: "Motoren, Sehnenspulen und die Steuerung sitzen am Unterarm und halten die Hand leicht." },
      { h: "Ein Display am Handgelenk.",
        p: "Ein rundes Display zeigt auf einen Blick, was das Gerät gerade tut." },
    ],
  },

  specs: {
    kicker: "Daten",
    head: "Jedes Detail, gemessen.",
    sub: "Die Zahlen hinter der Hand, direkt aus der Firmware und der Stückliste.",
    tour0: { h: "Sechs Teile. Ein Instrument.", p: "Scrolle, um die Maschine Teil für Teil zu erkunden." },
    callouts: [
      { k: "Display", h: "Status auf einen Blick.", p: "Ein rundes Display am Handgelenk zeigt, was das Gerät gerade tut, ganz ohne Laptop.",
        s: "Rundes GC9A01A-Display" },
      { k: "Spulen", h: "Eine Spule, beide Richtungen.", p: "Beuger und Strecker jedes Gelenks teilen sich eine Spule, damit der Finger beim Richtungswechsel nie durchhängt.",
        s: "10 Plätze · 0,30-mm-Dyneema-Sehnen" },
      { k: "Motoren", h: "Das Gewicht bleibt am Unterarm.", p: "Die Motoren sitzen am Unterarm und ziehen über Sehnen, die Hand trägt nur leichte Glieder.",
        s: "8 × Dynamixel XC330 · < 150 g an der Hand (Ziel)" },
      { k: "Steuerung", h: "Ein Gehirn am Handgelenk.", p: "Eine Steuerung liest jeden Sensor, treibt jeden Motor und zeichnet jede Sitzung auf.",
        s: "Teensy 4.1 · 100 Hz Vollzustand" },
      { k: "Encoder", h: "Jedes Gelenk gespürt.", p: "Ein Magnetencoder an jedem Fingergelenk misst die Hand, während sie sich bewegt.",
        s: "12 × AS5600 · 0,088°" },
      { k: "Glieder", h: "Es wächst mit deinem Finger.", p: "Selbstausrichtende Teleskopglieder werden beim Beugen länger, damit die Orthese nie gegen das Gelenk arbeitet.",
        s: "≈ 1 cm Weg bei voller Beugung" },
    ],
    // the four headline figures under the tour (values live in entry.js)
    stats: ["Gelenke gemessen", "Auflösung an jedem Gelenk", "der volle Zustand im Stream", "die gesamte bepreiste Stückliste"],
    // docs/BOM.md cost summary, largest first (the stat's bar)
    costGroups: ["Motoren", "Druckmaterial", "Bewegungssensorik", "Steuerung", "Gelenksensorik", "Sehnen"],
  },
  // Tech Specs, set the way Apple sets them (owner, round 3: "do it like
  // Apple would"): a label column, short items, three drawings, and the
  // fine print as numbered notes. Every line of the old instrument sheet
  // lives here; numbers and units stay as in the firmware and the BOM.
  ts: {
    head: "Technische Daten",
    model: "TAKTO ONE",
    config: "Vier-Finger-Konfiguration",
    all: "Alle technischen Daten",
    finishK: "Ausführung",
    finishP: "Die Struktur ist gedruckt, also ist Farbe eine Entscheidung. Drei Studien.",
    sizeK: "Größe und Gewicht",
    unit: "Unterarmeinheit",
    dims: ["Länge", "Breite", "Höhe"],
    overall: "Gesamtlänge",
    overallP: "Vom Unterarm bis zur Fingerspitze, Finger gestreckt",
    hand: "An der Hand",
    handP: "Die Motoren sitzen am Unterarm",
    rows: [
      { k: "Sensorik", items: [
        ["12 magnetische Gelenkencoder", "AS5600, einer an jedem Fingergelenk."],
        ["0,088° Auflösung", "An jedem Gelenk, in 100-Hz-Frames."],
        ["3 Inertialsensoren", "BNO085 auf dem Handrücken, am Unterarm und an der Daumenspitze."],
        ["Oberflächen-EMG", "Die Anstrengungs-Hüllkurve vom Unterarm; die Absicht wird auf dem Host geschätzt."],
      ] },
      { k: "Bewegungsumfang", items: [
        ["MCP 90°", "Beugung im Grundgelenk."],
        ["PIP 110°", "Beugung im Mittelgelenk."],
        ["Abduktion mit Vorzeichen", "An jedem Grundgelenk gemessen."],
        ["≈ 1 cm Selbstausrichtung", "Die Teleskopglieder verlängern sich bei voller Beugung, damit die Orthese nie gegen den Finger arbeitet."],
      ] },
      { k: "Antrieb", items: [
        ["8 Dynamixel-XC330-Motoren", "Zwei pro Finger, am Unterarm getragen.³"],
        ["Eine Spule pro Gelenk", "Ein antagonistisches Seilpaar: Beugung und Streckung aus demselben Motor, ohne Spiel beim Richtungswechsel."],
        ["Dyneema-Sehnen", "0,30 mm geflochtenes UHMWPE in PTFE-Führung."],
        ["Unterstützung über die Krone", "Stufenlos, von voller Unterstützung bis zu reiner Transparenz."],
      ] },
      { k: "Sicherheit", items: [
        ["10 N Kraftlimit", "In der Firmware erzwungen: Die Maschine kann ihren Träger nie überwältigen."],
        ["22 N Rückfallgrenze", "Eine Stromgrenze in den Servos."],
        ["Mechanische Endanschläge", "An den Grenzen der Anatomie."],
      ] },
      { k: "Steuerung und Display", items: [
        ["Teensy 4.1", "600 MHz Arm Cortex-M7. Liest jeden Sensor, treibt jeden Motor, schreibt jeden Take."],
        ["Rundes Statusdisplay", "32 mm, am Handgelenk: der Gerätezustand auf einen Blick."],
        ["Krone und Taste", "Gerät bedienen und Unterstützung einstellen, ganz ohne Laptop."],
      ] },
      { k: "Aufzeichnung und Daten", items: [
        ["100-Hz-Vollzustands-Stream", "Gelenke, Bewegung, Motoren und Anstrengung, live an jede Konsole."],
        ["Aufzeichnung an Bord", "Stundenlange Takes auf der SD-Karte des Geräts."],
        ["Gelabelte Takes", "Von jeder Konsole aus aufgenommen, bereit zur Analyse."],
      ] },
      { k: "Software", items: [
        ["Web-Konsole", "Der Live-Zwilling, Telemetrie, Kalibrierung und jeder Sitzungsmodus, im Browser."],
        ["AR-Erlebnis", "Zwilling, Aufnahme und Wiedergabe in deinem eigenen Raum."],
        ["Android-Begleiter", "Koppelt per QR-Code."],
        ["Open Source", "Firmware, Host-Bridge, Konsolen, Platinen und CAD."],
      ] },
      { k: "Materialien", items: [
        ["Gedrucktes PETG", "Die Struktur, wie gebaut."],
        ["Bereit für Metall", "Zwei Glieder pro Finger für Metall-AM ausgelegt, in Aluminium (AlSi10Mg) oder 316L.⁴"],
        ["Selbstschmierende Paarungen", "Jedes Gleitpaar kombiniert eine harte Fläche mit einem selbstschmierenden Polymer."],
      ] },
      { k: "Kosten", items: [
        ["1.222,25 €", "Die bepreiste Stückliste: vier Finger, acht Motoren.⁵"],
        ["170,73 $", "Beide Eigenplatinen, als eine gelieferte Bestellung."],
      ] },
    ],
    notes: [
      "Maße der CAD-Baugruppe wie modelliert. Ein gedruckter Aufbau variiert mit der Fingergröße.",
      "Ein Entwurfsziel.",
      "Die ausgelieferte Firmware ist für ein antagonistisches Paar an einem Finger konfiguriert: der Werkbankaufbau.",
      "Für die additive Fertigung in Metall ausgelegt und in CAD und linear-statischer FEA untersucht. Es wurden keine Metallteile gefertigt.",
      "Richtpreise ohne MwSt. und Versand, aus den eigenen Einkäufen des Projekts 2026. Einige Positionen haben keinen veröffentlichten Preis; die vollständige Liste steht in docs/BOM.md.",
    ],
  },

  finishSec: {
    kicker: "Ausführungen",
    head: "Gedruckt, in jeder Farbe.",
    sub: "Die Struktur ist gedruckt, also ist die Farbe eine Wahl. Drei Studien.",
    select: "Oben zeigen",
    selected: "Oben gezeigt",
  },

  tech: {
    kicker: "Technik",
    head: "Jedes Gelenk spüren.",
    dial: {
      kicker: "Transparenz",
      head: "Kraft, die sich auf null drehen lässt.",
      p: "Dreh die Krone, und die Unterstützung blendet stufenlos aus, bis die Maschine dir nur noch folgt.",
      words: ["Transparent", "Gemischt", "Unterstützt"],
      aria: "Unterstützungsgrad",
    },
    face: {
      kicker: "Display",
      head: "Zeigt immer, wo es steht.",
      p: "Ein rundes 240-Pixel-Display zeigt den Zustand des Geräts.",
      modes: { home: "Bereit", transparent: "Transparent", capture: "Aufnahme", saved: "Gespeichert" },
    },
    enc: {
      kicker: "Sensorik",
      head: "Zwölf Gelenke, gemessen.",
      p: "Ein Magnetencoder an jedem Fingergelenk.",
    },
    tendon: {
      kicker: "Antrieb",
      head: "Von Sehnen gezogen.",
      p: "Eine Spule pro Gelenk beugt und streckt den Finger, ohne Spiel beim Richtungswechsel.",
    },
    safe: {
      kicker: "Sicherheit",
      n: "10 N",
      head: "Es kann dich nicht überwältigen.",
      p: "Ein Kraftlimit in der Firmware, eine 22-N-Grenze in den Servos und Endanschläge an den Grenzen der Anatomie.",
    },
    emg: {
      kicker: "Absicht",
      head: "Es spürt, wenn du ansetzt.",
      p: "Oberflächen-EMG am Unterarm lässt den Host Anstrengung und Absicht schätzen.",
    },
    sd: {
      kicker: "Aufnahme",
      head: "Zeichnet selbst auf.",
      p: "Jeder Take landet auf der SD-Karte des Geräts. Kein Laptop nötig.",
    },
  },

  twin: {
    kicker: "Digitaler Zwilling",
    head: "Dreh ihn.",
    p: "Der digitale Zwilling folgt dem Gerät Gelenk für Gelenk, in Echtzeit.",
    hint: "Zum Drehen ziehen",
    live: "Gerät live",
    open: "Konsole öffnen",
    demo: "Demo-Bewegung",
  },

  film: {
    kicker: "Film",
    head: "In Bewegung.",
    alt: "TAKTO ONE, der Film",
    play: "Film abspielen",
  },

  console: {
    kicker: "Konsole",
    head: "Eine Konsole für alles.",
    p: "Der Live-Zwilling, Telemetrie, Kalibrierung und jeder Sitzungsmodus, an einem Ort, in deinem Browser.",
    open: "Konsole öffnen",
    inside: "Darin",
    modes: {
      guided: "Geführte Therapie",
      mirror: "Spiegeltherapie",
      capture: "Aufnahme",
      replay: "Wiedergabe",
      sign: "Gebärden-Aufnahme",
      translate: "Live-Erkennung",
    },
  },

  build: {
    kicker: "Open Source",
    head: "Zum Selberbauen.",
    cards: [
      { k: "Quellcode", h: "Von der Firmware bis zum Frontend",
        p: "Firmware, Host-Bridge, Konsolen und diese Seite.",
        label: "GitHub" },
      { k: "Bauanleitung", h: "TAKTO ONE bauen",
        p: "Schritt-für-Schritt-Aufbau des vollständigen Instruments.",
        label: "Anleitung öffnen" },
      { k: "Stückliste", h: "EUR 1.222,25",
        p: "Der kalkulierte Vier-Finger-Entwurf: die bepreisten Positionen der Stückliste.",
        label: "Stückliste lesen" },
    ],
  },

  creed: {
    kicker: "Warum es das gibt",
    head: "Bei einem Hammer geht es nie nur um den Nagel.",
    p: "Jeder Nagel, den er einschlägt, ist Teil eines Hauses. TAKTO ONE bewegt einen Finger, und jede Bewegung kann Teil von etwas Größerem werden: ein wiedererlernter Griff, ein gebärdetes Wort, ein Roboter, der von einer menschlichen Hand lernt. Ich weiß nicht, was alles daraus wird. Menschen, die weit kreativer sind als ich, werden Anwendungen finden, an die ich nie gedacht habe, und jeder, dem ich es zeige, sieht etwas anderes darin. Genau darum geht es. Das ist kein Unternehmen, und es geht nicht um Geld. Ich baue aus Liebe zum Erschaffen und teile es mit allen, die ihm ihre Zeit und Aufmerksamkeit schenken.",
    by: "Sebastian Molano",
  },

  compliance: {
    kicker: "Für Europa gebaut",
    head: "Konform durch Konstruktion.",
    p: "Ein Forschungsinstrument, nach europäischen Regeln konstruiert: DSGVO-Datenschutz durch Technikgestaltung, harte Sicherheitsgrenzen und ein kartierter Weg in die Klinik. Kein zertifiziertes Medizinprodukt, und es sagt das offen.",
    cue: "Die Compliance-Karte lesen",
    cards: [
      { k: "Datenschutz · DSGVO", p: "Datenschutz durch Technikgestaltung (Art. 25 DSGVO): Jedes Signal bleibt bei dir, auf der SD-Karte des Geräts und deinem eigenen Host-Rechner. Keine Cloud, keine Drittverarbeiter. Diese Seite hält es genauso: keine Cookies, keine Tracker, keine Analytik." },
      { k: "Sicherheit durch Konstruktion", p: "Ein 10-N-Kraftlimit, das die Firmware durchsetzt, eine 22-N-Grenze in den Servos, mechanische Anschläge an den Grenzen der Anatomie und Unterstützung, die sich buchstäblich auf null drehen lässt. Die Host-überwachte Architektur hält die Klinik in der Verantwortung." },
      { k: "Der klinische Weg", p: "TAKTO ONE ist heute ein Forschungsinstrument, kein zertifiziertes Medizinprodukt, und sagt das offen. Der kartierte Weg in die Klinik: Qualitätsmanagement nach DIN EN ISO 13485, Risikomanagement nach DIN EN ISO 14971, Software-Lebenszyklus nach IEC 62304, elektrische Sicherheit nach IEC 60601-1, Konformität als Klasse-IIa-Produkt nach EU-MDR 2017/745, dann das CE-Zeichen." },
    ],
    finePre: "Impressum und Datenschutzerklärung der Website: ",
    fineLink: "Impressum & Datenschutz",
  },

  write: {
    kicker: "Kontakt",
    head: "Ein Paar Hände hat das gebaut.",
    p1: "Ich bin Sebastian Molano, Biomedizintechnik-Ingenieur. Ich habe TAKTO ONE von der ersten Skizze bis zum funktionierenden Instrument getragen: Mechanismus, Leiterplatten, Firmware und jede Konsole auf dieser Seite.",
    p2: "Jetzt suche ich mein nächstes Team: Rehabilitationsrobotik, verkörperte KI, überall dort, wo Hardware auf Lernen trifft. Jobs, Ideen, Kollaborationen. Wenn sich diese Seite nach deiner Art von Ingenieurskunst liest: Schreib mir. Ich antworte.",
    contact: "Schreib mir",
    github: "GitHub",
  },

  craft: ["Mechanismus-Design", "Auslegung für Metall-AM", "Eigene Leiterplatten",
    "Embedded-Firmware", "Echtzeitregelung", "Web · AR · Android"],

  foot: {
    line: "Offenes Hand-Exoskelett",
    legal: "Impressum & Datenschutz",
    top: "Nach oben",
  },
};
