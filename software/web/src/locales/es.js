// locales/es.js - ESPAÑOL. Misma estructura que en.js; los números, nombres
// de piezas y unidades no cambian entre idiomas. Las reglas de honestidad se
// mantienen: ningún proceso sin respaldo, ningún certificado que no tengamos;
// el metal queda ABIERTO (AlSi10Mg o 316L, ninguno fabricado); EUR 1.599,84
// es el diseño de cuatro dedos COSTEADO, nunca dinero gastado.

export const L = {
  nav: {
    explore: "Explorar",
    build: "Construir",
    write: "Escríbeme",
  },

  hero: {
    kicker: "TAKTO ONE",
    title: 'La mano,<br><em>viva</em>.',
    sub: "Un exoesqueleto portátil que lee, asiste y registra la mano humana.",
    byline: "Diseñado, construido y programado por un solo ingeniero: Juan Sebastian Molano, M.Sc.",
    ctaExplore: "Explóralo en vivo",
    ctaBuild: "Constrúyelo",
    ctaWrite: "Escríbeme",
    live: "flujo simulado en vivo",
    liveOpen: "Abrir la consola del operador",
  },

  story: [
    { kicker: "Póntelo", head: "Ajústalo.",
      line: "Cuatro rieles para los dedos, una placa palmar, un anclaje en el antebrazo: un guante hecho de máquina." },
    { kicker: "Sentir", head: "Lee tu mano.",
      line: "Doce encoders articulares y tres marcos de movimiento siguen cada gesto, cincuenta veces por segundo." },
    { kicker: "Mecanismo", head: "Se estira cuando cierras la mano.",
      line: "Cada articulación es telescópica: la máquina se alarga con tu dedo en vez de luchar contra él." },
    { kicker: "Accionamiento", head: "Fuerza que puedes bajar hasta cero.",
      line: "Los carretes de tendón dan fuerza a cada dedo; gira la corona y se desvanece hasta la transparencia pura." },
    { kicker: "A bordo", head: "Un cerebro en la muñeca.",
      line: "Bajo la cubierta: diez bahías de carrete, el Teensy que lee cada sensor y horas de grabación directa a SD." },
    { kicker: "La visión", head: "Una interfaz entre tú y cualquier máquina.",
      line: "Movimiento, esfuerzo, fuerza, por escrito: datos para teleoperar robots, enseñarles el tacto y devolverle la fuerza a una mano." },
  ],

  specsKicker: "De un vistazo",
  specs: [
    { n: "12", u: "articulaciones medidas", d: "un encoder en cada articulación del dedo" },
    { n: "3", u: "marcos inerciales", d: "mano, antebrazo y punta del pulgar" },
    { n: "50", u: "Hz de telemetría", d: "flujo de estado completo desde el dispositivo" },
    { n: "SD", u: "captura a bordo", d: "graba sin un host conectado" },
  ],

  craft: ["Diseño de mecanismos", "Diseño para AM en metal", "PCB propias",
    "Firmware embebido", "Control en tiempo real", "Web · AR · Android"],

  film: { kicker: "En el banco", head: "La máquina real.",
    alt: "TAKTO ONE en el banco de trabajo" },

  creed: {
    kicker: "Por qué existe",
    head: "Por qué construyo.",
    p: "Un martillo que clava un clavo en la madera está, indirectamente, construyendo una casa. Una mano que mueve un dedo hace, indirectamente, una infinidad de cosas, y las harán personas mucho más creativas que yo. Cada persona a la que pregunto ve algo distinto. Ese es exactamente el punto. Esto no es una corporación, y no se hace por dinero. Construyo por amor a crear, y lo comparto con quienes lo honran con su tiempo y su atención.",
  },

  explore: {
    kicker: "Demo en vivo",
    head: "Tócalo.",
    sub: "Seis consolas, un contrato de 50 Hz, corriendo en tu navegador sobre un flujo simulado, exactamente igual que sobre el hardware.",
    items: {
      operator: { name: "Operador", line: "Telemetría en vivo, ajustes y el gemelo." },
      guided: { name: "Guiada", line: "Ejercicios de terapia, cada repetición medida." },
      mirror: { name: "Espejo", line: "Biofeedback con cámara: la mano sana guía." },
      capture: { name: "Captura", line: "Graba conjuntos de movimiento etiquetados." },
      sign: { name: "Captura de Señas", line: "Graba lengua de señas alemana, seña por seña." },
      translate: { name: "Traducción en Vivo", line: "Señas reconocidas mientras señas." },
    },
    resume: "Continuar",
  },

  build: {
    kicker: "Construir",
    head: "Tuyo para construirlo.",
    cards: [
      { k: "Código", h: "Del firmware al frontend",
        p: "Firmware, puente de host, tres consolas, esta página incluida.",
        label: "GitHub" },
      { k: "Preprint", h: "Artículo TAKTO ONE",
        p: "Artículo de investigación abierto. Esta URL se sustituirá por el DOI al publicarse.",
        label: "Leer preprint" },
      { k: "Guía", h: "Construye TAKTO ONE",
        p: "Guía paso a paso para montar el instrumento completo.",
        label: "Abrir guía" },
    ],
    sheetCue: "La hoja de instrumento completa, cada número",
    sheetTitle: "TAKTO ONE — hoja de instrumento",
    rows: [
      ["Sensórica articular", "12x encoders magnéticos AS5600 · 0.088 deg · 50 Hz"],
      ["Marcos de movimiento", "3x IMU BNO085: dorso de la mano, antebrazo, punta del pulgar"],
      ["Esfuerzo", "envolvente de EMG superficial, estimación de intención en el host"],
      ["Accionamiento", "2x Dynamixel XC330-M181-T por dedo · un dedo motorizado en el banco"],
      ["Transmisión", "par de cables antagonistas en un carrete de 5 mm por articulación · flexión y extensión del mismo motor, sin holgura al invertir"],
      ["Tendón", "UHMWPE trenzado de 0.30 mm (Dyneema) en conducto de PTFE"],
      ["Mecanismo", "articulación telescópica autoalineante · se alarga casi 1 cm en flexión completa, para que la órtesis nunca luche contra el dedo"],
      ["Rango de movimiento", "MCP 90 deg · PIP 110 deg · topes mecánicos en los límites de la anatomía · abducción con signo en cada MCP"],
      ["Asistencia", "continua, con la corona: de asistencia total a transparencia pura"],
      ["Seguridad", "techo duro de corriente de 150 mA, 80 mA en modo suave · la máquina no puede vencer a quien la lleva"],
      ["Controlador", "Teensy 4.1 @ 600 MHz · flujo de estado completo a 50 Hz · pantalla de estado redonda"],
      ["Captura", "horas de grabación en SD a bordo + tomas etiquetadas desde cualquier consola"],
      ["Consolas", "suite web de operador · experiencia AR · compañera Android"],
      ["Materiales", "estructura PETG impresa tal como está montada · 2 eslabones por dedo diseñados para AM en metal, aluminio (AlSi10Mg) o 316L · los pares deslizantes combinan una cara dura con un polímero autolubricante"],
      ["Masa llevada", "objetivo en la mano < 150 g · los actuadores viven en el antebrazo"],
      ["Lista de materiales", "EUR 1.599,84 · el diseño de cuatro dedos costeado, ocho motores"],
    ],
    github: "GitHub",
    write: "Escríbeme",
  },

  compliance: {
    kicker: "Hecho para Europa",
    head: "Conforme por diseño.",
    p: "Un instrumento de investigación construido bajo las reglas europeas: privacidad RGPD desde el diseño, techos duros de seguridad y una ruta trazada hacia la clínica. No es un producto sanitario certificado, y lo dice sin rodeos.",
    cue: "Leer el mapa de cumplimiento",
    cards: [
      { k: "Privacidad · RGPD", p: "Protección de datos desde el diseño (art. 25 RGPD): cada señal se queda contigo, en la tarjeta SD del dispositivo y en tu propio equipo host. Sin nube, sin terceros. Esta página hace lo mismo: sin cookies, sin rastreadores, sin analítica." },
      { k: "Seguridad por diseño", p: "Un techo duro de corriente de 150 mA (80 mA en modos suaves), topes mecánicos en los límites de la propia anatomía y una asistencia que baja, literalmente, hasta cero. La arquitectura supervisada por el host mantiene al clínico al mando." },
      { k: "El camino clínico", p: "TAKTO ONE es hoy un instrumento de investigación, no un producto sanitario certificado, y lo dice sin rodeos. La ruta trazada hacia la clínica: gestión de calidad según DIN EN ISO 13485, gestión de riesgos según DIN EN ISO 14971, ciclo de vida de software según IEC 62304, seguridad eléctrica según IEC 60601-1, conformidad como producto de clase IIa bajo el MDR 2017/745 de la UE y, después, el marcado CE." },
    ],
    finePre: "Aviso legal y política de privacidad del sitio: ",
    fineLink: "Impressum & Datenschutz",
  },

  write: {
    kicker: "Escríbeme",
    head: "Un solo par de manos construyó esto.",
    p1: "Soy Juan Sebastian Molano, ingeniero biomédico. Llevé TAKTO ONE del primer boceto al instrumento que funciona: mecanismo, placas, firmware y cada consola de esta página.",
    p2: "Ahora busco mi siguiente equipo: robótica de rehabilitación, IA encarnada, donde sea que el hardware se encuentre con el aprendizaje. Trabajo, ideas, colaboraciones. Si esto te suena a tu clase de ingeniería, escríbeme. Respondo.",
    contact: "Contacto",
    github: "GitHub",
    cv: "CV",
  },

  foot: {
    feed: "flujo simulado en vivo",
    legal: "Impressum & Datenschutz",
  },
};
