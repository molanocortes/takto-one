// locales/es.js - ESPAÑOL. Misma estructura que en.js; los números, nombres
// de piezas y unidades no cambian entre idiomas. Las reglas de honestidad se
// mantienen: ningún proceso sin respaldo, ningún certificado que no tengamos;
// el metal queda ABIERTO (AlSi10Mg o 316L, ninguno fabricado); EUR 1.222,25
// es el diseño de cuatro dedos COSTEADO y cubre solo las líneas con precio
// de docs/BOM.md, nunca dinero gastado.

export const L = {
  nav: {
    design: "Diseño",
    tech: "Tecnología",
    specs: "Especificaciones",
    build: "Código abierto",
    contact: "Contacto",
    console: "Consola",
    consoleTitle: "Abrir la consola en vivo",
  },

  hero: {
    tagline: "La mano, viva.",
    sub: "Un exoesqueleto portátil que lee, asiste y registra la mano humana.",
    finishLabel: "Acabado",
    cta: "Abrir la consola",
    next: "Desliza para explorar",
  },

  finishes: {
    snow: { name: "Snow", line: "Carcasa blanca, rieles grafito." },
    onyx: { name: "Onyx", line: "Grafito, del antebrazo a la punta del dedo." },
    signal: { name: "Signal", line: "Carretes naranjas, dedos azules." },
  },

  intro: {
    kicker: "TAKTO ONE",
    head: "Construido alrededor de la mano.",
    sub: "Un instrumento de investigación para la herramienta más capaz que tenemos.",
    left: "TAKTO ONE es un exoesqueleto de mano portátil. Cuatro rieles de dedo, una placa palmar y una unidad de antebrazo leen cada articulación, aportan fuerza mediante tendones y registran lo que hace la mano.",
    right: "Diseñado, construido y programado de principio a fin por un solo ingeniero, Sebastian Molano, como un instrumento abierto para la investigación en rehabilitación, los datos de movimiento y la teleoperación.",
    tiles: ["Cuatro rieles de dedo", "Se cierra contigo", "Una unidad de antebrazo"],
  },

  turn: {
    kicker: "Diseño",
    head: "Cada ángulo, pensado.",
    caps: [
      { h: "Dedos telescópicos.",
        p: "Eslabones autoalineantes se alargan casi un centímetro al flexionar, para que la órtesis nunca luche contra el dedo." },
      { h: "El peso vive en el antebrazo.",
        p: "Motores, carretes de tendón y el controlador van en el antebrazo, y la mano queda ligera." },
      { h: "Una pantalla en la muñeca.",
        p: "Una pantalla redonda muestra de un vistazo lo que hace el dispositivo." },
    ],
  },

  specs: {
    kicker: "Especificaciones",
    head: "Cada detalle, medido.",
    sub: "Los números detrás de la mano, directamente del firmware y de la lista de materiales.",
    tour0: { h: "Seis partes. Un instrumento.", p: "Desliza para recorrer la máquina, parte por parte." },
    callouts: [
      { k: "Pantalla", h: "El estado, de un vistazo.", p: "Una pantalla redonda en la muñeca muestra lo que hace el dispositivo, sin un portátil a la vista.",
        s: "Pantalla redonda GC9A01A" },
      { k: "Carretes", h: "Un carrete, dos sentidos.", p: "El flexor y el extensor de cada articulación comparten un solo carrete, así el dedo nunca queda flojo al invertir.",
        s: "10 bahías · tendones Dyneema de 0,30 mm" },
      { k: "Motores", h: "El peso se queda en el antebrazo.", p: "Los motores van en el antebrazo y tiran mediante tendones, así la mano solo lleva eslabones ligeros.",
        s: "8 × Dynamixel XC330 · < 150 g en la mano (objetivo)" },
      { k: "Controlador", h: "Un cerebro en la muñeca.", p: "Un solo controlador lee cada sensor, mueve cada motor y graba cada sesión.",
        s: "Teensy 4.1 · estado completo a 100 Hz" },
      { k: "Encoders", h: "Cada articulación, sentida.", p: "Un encoder magnético en cada articulación de los dedos mide la mano mientras se mueve.",
        s: "12 × AS5600 · 0,088°" },
      { k: "Eslabones", h: "Crece con tu dedo.", p: "Los eslabones telescópicos autoalineantes se alargan al flexionar el dedo, así la órtesis nunca lucha contra la articulación.",
        s: "≈ 1 cm de recorrido en flexión completa" },
    ],
    // the four headline figures under the tour (values live in entry.js)
    stats: ["articulaciones medidas", "resolución en cada articulación", "el estado completo, en directo", "toda la lista de materiales con precio"],
    // docs/BOM.md cost summary, largest first (the stat's bar)
    costGroups: ["Motores", "Material de impresión", "Sensórica de movimiento", "Control", "Sensórica articular", "Tendones"],
  },
  // Tech Specs, set the way Apple sets them (owner, round 3: "do it like
  // Apple would"): a label column, short items, three drawings, and the
  // fine print as numbered notes. Every line of the old instrument sheet
  // lives here; numbers and units stay as in the firmware and the BOM.
  ts: {
    head: "Especificaciones técnicas",
    model: "TAKTO ONE",
    config: "Configuración de cuatro dedos",
    all: "Todas las especificaciones",
    finishK: "Acabado",
    finishP: "La estructura es impresa, así que el color es una elección. Tres estudios.",
    sizeK: "Tamaño y peso",
    unit: "Unidad de antebrazo",
    dims: ["Largo", "Ancho", "Alto"],
    overall: "Largo total",
    overallP: "Del antebrazo a la punta del dedo, dedos extendidos",
    hand: "En la mano",
    handP: "Los motores van en el antebrazo",
    rows: [
      { k: "Sensórica", items: [
        ["12 encoders articulares magnéticos", "AS5600, uno en cada articulación de los dedos."],
        ["0,088° de resolución", "En cada articulación, en tramas de 100 Hz."],
        ["3 sensores inerciales", "BNO085 en el dorso de la mano, el antebrazo y la punta del pulgar."],
        ["EMG de superficie", "La envolvente de esfuerzo del antebrazo; la intención se estima en el host."],
      ] },
      { k: "Rango de movimiento", items: [
        ["MCP 90°", "Flexión en el nudillo."],
        ["PIP 110°", "Flexión en la articulación media."],
        ["Abducción con signo", "Medida en cada nudillo."],
        ["≈ 1 cm de autoalineación", "Los eslabones telescópicos se alargan en flexión completa, así la órtesis nunca lucha contra el dedo."],
      ] },
      { k: "Accionamiento", items: [
        ["8 motores Dynamixel XC330", "Dos por dedo, en el antebrazo.³"],
        ["Un carrete por articulación", "Un par de cables antagonistas: flexión y extensión del mismo motor, sin holgura al invertir."],
        ["Tendones de Dyneema", "UHMWPE trenzado de 0,30 mm, en conducto de PTFE."],
        ["Asistencia en la corona", "Continua, desde asistencia total hasta transparencia pura."],
      ] },
      { k: "Seguridad", items: [
        ["Techo de fuerza de 10 N", "Impuesto en el firmware: la máquina no puede vencer a quien la lleva."],
        ["Respaldo de 22 N", "Un límite de corriente dentro de los servos."],
        ["Topes mecánicos", "En los límites de la propia anatomía."],
      ] },
      { k: "Controlador y pantalla", items: [
        ["Teensy 4.1", "Arm Cortex-M7 a 600 MHz. Lee cada sensor, mueve cada motor, escribe cada toma."],
        ["Pantalla de estado redonda", "32 mm, en la muñeca: el estado del dispositivo de un vistazo."],
        ["Corona y botón", "Navega por el dispositivo y ajusta la asistencia sin un portátil."],
      ] },
      { k: "Grabación y datos", items: [
        ["Flujo de estado completo a 100 Hz", "Articulaciones, movimiento, motores y esfuerzo, en directo a cualquier consola."],
        ["Grabación a bordo", "Horas de tomas en la tarjeta SD del propio dispositivo."],
        ["Tomas etiquetadas", "Capturadas desde cualquier consola, listas para analizar."],
      ] },
      { k: "Software", items: [
        ["Consola web", "El gemelo en vivo, telemetría, calibración y cada modo de sesión, en el navegador."],
        ["Experiencia AR", "El gemelo, la captura y la reproducción en tu propio espacio."],
        ["Compañera Android", "Se empareja con un código QR."],
        ["Código abierto", "Firmware, puente host, consolas, placas y CAD."],
      ] },
      { k: "Materiales", items: [
        ["PETG impreso", "La estructura, tal como está montada."],
        ["Lista para metal", "Dos eslabones por dedo diseñados para AM en metal, en aluminio (AlSi10Mg) o 316L.⁴"],
        ["Pares autolubricantes", "Cada par deslizante combina una cara dura con un polímero autolubricante."],
      ] },
      { k: "Coste", items: [
        ["1222,25 €", "La lista de materiales con precio: cuatro dedos, ocho motores.⁵"],
        ["170,73 $", "Las dos placas propias, en un solo pedido entregado."],
      ] },
    ],
    notes: [
      "Dimensiones del ensamblaje CAD tal como está modelado. Un montaje impreso varía con el tamaño de los dedos.",
      "Un objetivo de diseño.",
      "El firmware entregado está configurado para un par antagonista en un dedo: el montaje de banco.",
      "Diseñado para fabricación aditiva en metal y estudiado en CAD y FEA estática lineal. No se ha fabricado ninguna pieza de metal.",
      "Precios orientativos, sin IVA ni envío, de las compras del propio proyecto en 2026. Algunas líneas no tienen precio publicado; la lista completa está en docs/BOM.md.",
    ],
  },

  finishSec: {
    kicker: "Acabados",
    head: "Impreso, en cualquier color.",
    sub: "La estructura es impresa, así que el color es una elección. Tres estudios.",
    select: "Ver arriba",
    selected: "Mostrado arriba",
  },

  tech: {
    kicker: "Tecnología",
    head: "Siente cada articulación.",
    dial: {
      kicker: "Transparencia",
      head: "Fuerza que puedes llevar a cero.",
      p: "Gira la corona y la asistencia se desvanece de forma continua, hasta una máquina que solo te sigue.",
      words: ["Transparente", "Mezcla", "Asistido"],
      aria: "Nivel de asistencia",
    },
    face: {
      kicker: "Pantalla",
      head: "Siempre dice dónde está.",
      p: "Una pantalla redonda de 240 píxeles muestra el estado del dispositivo.",
      modes: { home: "Listo", transparent: "Transparente", capture: "Grabando", saved: "Guardado" },
    },
    enc: {
      kicker: "Sensórica",
      head: "Doce articulaciones, medidas.",
      p: "Un encoder magnético en cada articulación de los dedos.",
    },
    tendon: {
      kicker: "Accionamiento",
      head: "Movido por tendones.",
      p: "Un carrete por articulación flexiona y extiende el dedo, sin holgura al invertir.",
    },
    safe: {
      kicker: "Seguridad",
      n: "10 N",
      head: "No puede vencerte.",
      p: "Un techo de fuerza en el firmware, un límite de 22 N en los servos y topes en los límites de la propia anatomía.",
    },
    emg: {
      kicker: "Intención",
      head: "Siente cuando empiezas.",
      p: "La EMG superficial en el antebrazo permite al host estimar esfuerzo e intención.",
    },
    sd: {
      kicker: "Captura",
      head: "Graba por su cuenta.",
      p: "Cada toma se escribe en la tarjeta SD del dispositivo. Sin portátil.",
    },
  },

  twin: {
    kicker: "Gemelo digital",
    head: "Gíralo.",
    p: "El gemelo digital sigue al dispositivo articulación por articulación, en tiempo real.",
    hint: "Arrastra para girar",
    live: "Dispositivo en vivo",
    open: "Abrir la consola",
    demo: "Movimiento de demostración",
  },

  film: {
    kicker: "Película",
    head: "En movimiento.",
    alt: "TAKTO ONE, la película",
    play: "Ver la película",
  },

  console: {
    kicker: "Consola",
    head: "Una consola para todo.",
    p: "El gemelo en vivo, la telemetría, la calibración y cada modo de sesión, en un solo lugar, en tu navegador.",
    open: "Abrir la consola",
    inside: "Dentro",
    modes: {
      guided: "Terapia guiada",
      mirror: "Terapia espejo",
      capture: "Captura",
      replay: "Repetición",
      sign: "Captura de señas",
      translate: "Reconocimiento en vivo",
    },
  },

  build: {
    kicker: "Código abierto",
    head: "Tuyo para construirlo.",
    cards: [
      { k: "Código", h: "Del firmware al frontend",
        p: "Firmware, puente de host, consolas y esta página.",
        label: "GitHub" },
      { k: "Guía", h: "Construye TAKTO ONE",
        p: "Montaje paso a paso del instrumento completo.",
        label: "Abrir la guía" },
      { k: "Lista de materiales", h: "EUR 1.222,25",
        p: "El diseño de cuatro dedos costeado: las líneas con precio de la lista de materiales.",
        label: "Leer la lista" },
    ],
  },

  creed: {
    kicker: "Por qué existe",
    head: "Un martillo nunca se trata solo del clavo.",
    p: "Cada clavo que clava es parte de una casa. TAKTO ONE mueve un dedo, y cada movimiento puede volverse parte de algo más grande: un agarre que se recupera, una palabra en lengua de señas, un robot que aprende de una mano humana. No sé todo lo que llegará a ser. Personas mucho más creativas que yo encontrarán usos que nunca imaginé, y cada persona a quien se lo muestro ve algo distinto. De eso se trata. No es una empresa y no es por dinero. Construyo por amor a crear, y lo comparto con todos los que le regalan su tiempo y su atención.",
    by: "Sebastian Molano",
  },

  compliance: {
    kicker: "Hecho para Europa",
    head: "Conforme por diseño.",
    p: "Un instrumento de investigación construido bajo las reglas europeas: privacidad RGPD desde el diseño, techos duros de seguridad y una ruta trazada hacia la clínica. No es un producto sanitario certificado, y lo dice sin rodeos.",
    cue: "Leer el mapa de cumplimiento",
    cards: [
      { k: "Privacidad · RGPD", p: "Protección de datos desde el diseño (art. 25 RGPD): cada señal se queda contigo, en la tarjeta SD del dispositivo y en tu propio equipo host. Sin nube, sin terceros. Esta página hace lo mismo: sin cookies, sin rastreadores, sin analítica." },
      { k: "Seguridad por diseño", p: "Un techo de fuerza de 10 N que impone el firmware, un límite de 22 N en los servos, topes mecánicos en los límites de la propia anatomía y una asistencia que baja, literalmente, hasta cero. La arquitectura supervisada por el host mantiene al clínico al mando." },
      { k: "El camino clínico", p: "TAKTO ONE es hoy un instrumento de investigación, no un producto sanitario certificado, y lo dice sin rodeos. La ruta trazada hacia la clínica: gestión de calidad según DIN EN ISO 13485, gestión de riesgos según DIN EN ISO 14971, ciclo de vida de software según IEC 62304, seguridad eléctrica según IEC 60601-1, conformidad como producto de clase IIa bajo el MDR 2017/745 de la UE y, después, el marcado CE." },
    ],
    finePre: "Aviso legal y política de privacidad del sitio: ",
    fineLink: "Impressum & Datenschutz",
  },

  write: {
    kicker: "Contacto",
    head: "Un solo par de manos construyó esto.",
    p1: "Soy Sebastian Molano, ingeniero biomédico. Llevé TAKTO ONE del primer boceto al instrumento que funciona: mecanismo, placas, firmware y cada consola de esta página.",
    p2: "Ahora busco mi siguiente equipo: robótica de rehabilitación, IA encarnada, donde sea que el hardware se encuentre con el aprendizaje. Trabajo, ideas, colaboraciones. Si esto te suena a tu clase de ingeniería, escríbeme. Respondo.",
    contact: "Escríbeme",
    github: "GitHub",
  },

  craft: ["Diseño de mecanismos", "Diseño para AM en metal", "PCB propias",
    "Firmware embebido", "Control en tiempo real", "Web · AR · Android"],

  foot: {
    line: "Exoesqueleto de mano abierto",
    legal: "Impressum & Datenschutz",
    top: "Volver arriba",
  },
};
