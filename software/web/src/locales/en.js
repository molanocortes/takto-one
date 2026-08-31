// locales/en.js - ENGLISH (the default and the reference copy).
// Every locale exports the SAME shape; entry.js builds the page from it.
// Numbers, part names, and units stay identical across locales - only prose
// translates. Honesty rules ride along: no unclaimed processes, no
// certificates we do not hold, the metal is OPEN (AlSi10Mg or 316L, neither
// fabricated), EUR 1,599.84 is the COSTED four-finger design, never money
// spent, and nothing claims the worn finger has been motor-driven.
// EDITORIAL RULE (owner, 2026-08-03): headlines + captions + numbers carry
// the story; no section over ~60 visible words at the surface; the deep
// content lives behind the folds (sheet, compliance map), never deleted.

export const L = {
  // the three doors: reachable from anywhere, each lands somewhere real
  nav: {
    explore: "Explore",
    build: "Build",
    write: "Write me",
  },

  hero: {
    kicker: "TAKTO ONE",
    title: 'The hand,<br><em>alive</em>.',
    sub: "A wearable exoskeleton that reads, assists, and records the human hand.",
    byline: "Designed, built, and programmed by one engineer: Juan Sebastian Molano, M.Sc.",
    ctaExplore: "Explore it live",
    ctaBuild: "Build it",
    ctaWrite: "Write me",
    live: "live sim feed",
    liveOpen: "Open the operator console",
  },

  // steps 1..6 of the pinned story (step 0 is the hero). Caption length:
  // the machine on stage does the talking, the words only point.
  story: [
    { kicker: "Wear it", head: "Strap in.",
      line: "Four finger rails, a palm plate, a forearm dock: a glove made of machine." },
    { kicker: "Sense", head: "It reads your hand.",
      line: "Twelve joint encoders and three motion frames trace every gesture, fifty times a second." },
    { kicker: "Mechanism", head: "It stretches as you curl.",
      line: "Every joint telescopes, so the machine lengthens with your finger instead of fighting it." },
    { kicker: "Drive", head: "Force you can dial to zero.",
      line: "Tendon spools give each finger force; turn the crown and it fades to pure transparency." },
    { kicker: "Onboard", head: "A brain on the wrist.",
      line: "Under the cover: ten spool bays, the Teensy reading every sensor, and hours of recording straight to SD." },
    { kicker: "The vision", head: "An interface between you and every machine.",
      line: "Motion, effort, force, written down: data to teleoperate robots, teach them touch, and bring a hand back to strength." },
  ],

  specsKicker: "At a glance",
  specs: [
    { n: "12", u: "sensed joints", d: "an encoder on every finger articulation" },
    { n: "3", u: "inertial frames", d: "hand, forearm, and thumb tip" },
    { n: "50", u: "Hz telemetry", d: "full-state stream from the device" },
    { n: "SD", u: "onboard capture", d: "records without a tethered host" },
  ],

  craft: ["Mechanism design", "Design for metal AM", "Custom PCBs",
    "Embedded firmware", "Real-time control", "Web · AR · Android"],

  film: { kicker: "On the bench", head: "The real machine.",
    alt: "TAKTO ONE on the bench" },

  // the WHY: the owner's creed, in his own voice. The page must feel like
  // this paragraph; it is the inspiration beat of the sequence.
  creed: {
    kicker: "Why it exists",
    head: "Why I build.",
    p: "A hammer driving a nail into wood is, indirectly, building a house. A hand that moves a finger is indirectly doing an infinity of things, and people far more creative than me will do them. Everyone I ask sees something different in it. That is exactly the point. This is not a corporation, and it is not for money. I build for the love of creation, and I share it with everyone who honors it with their time and attention.",
  },

  // door one: EXPLORE - the living software, one click deep
  explore: {
    kicker: "Live demo",
    head: "Touch it.",
    sub: "Six consoles, one 50 Hz contract, running in your browser on a simulated feed, exactly as they run on the hardware.",
    items: {
      operator: { name: "Operator", line: "Live telemetry, tuning, and the twin." },
      guided: { name: "Guided", line: "Therapy poses, with every rep measured." },
      mirror: { name: "Mirror", line: "Camera biofeedback: the good hand leads." },
      capture: { name: "Capture", line: "Record labelled motion datasets." },
      sign: { name: "Sign Capture", line: "Record German Sign Language, prompt by prompt." },
      translate: { name: "Live Translation", line: "Signs recognized as you stream them." },
    },
    resume: "Continue",
  },

  // door two: BUILD - the open release, with the instrument sheet folded in
  build: {
    kicker: "Build it",
    head: "Yours to build.",
    cards: [
      { k: "Source", h: "Firmware to frontend",
        p: "Firmware, host bridge, three consoles, this page included.",
        label: "GitHub" },
      { k: "Build guide", h: "Build TAKTO ONE",
        p: "Step-by-step assembly guide for the complete instrument.",
        label: "Open guide" },
    ],
    sheetCue: "The full instrument sheet, every number",
    sheetTitle: "TAKTO ONE — instrument sheet",
    rows: [
      ["Joint sensing", "12x AS5600 magnetic encoders · 0.088 deg · 50 Hz"],
      ["Motion frames", "3x BNO085 IMU: dorsal hand, forearm, thumb tip"],
      ["Effort", "surface EMG envelope, host-side intent estimation"],
      ["Drive", "2x Dynamixel XC330-M181-T per finger · one finger motorised on the bench"],
      ["Transmission", "antagonist cable pair on one 5 mm spool per joint · flexion and extension from the same motor, no backlash at reversal"],
      ["Tendon", "0.30 mm braided UHMWPE (Dyneema) in PTFE conduit"],
      ["Mechanism", "self-aligning telescopic linkage · lengthens almost 1 cm at full flexion, so the brace never fights the finger"],
      ["Range of motion", "MCP 90 deg · PIP 110 deg · mechanical hard stops at the anatomy's limits · signed abduction sensing at every MCP"],
      ["Assistance", "crown-dialed, continuous: full assist down to pure transparency"],
      ["Safety", "150 mA hard current ceiling, 80 mA gentle · the machine cannot out-muscle its wearer"],
      ["Controller", "Teensy 4.1 @ 600 MHz · 50 Hz full-state stream · round status display"],
      ["Capture", "hours of onboard SD recording + labelled takes from any console"],
      ["Consoles", "web operator suite · AR experience · Android companion"],
      ["Materials", "printed PETG structure as built · 2 links per finger engineered for metal AM, aluminium (AlSi10Mg) or 316L · sliding pairs pair a hard face with a self-lubricating polymer"],
      ["Worn mass", "hand-borne target < 150 g · actuators live on the forearm"],
      ["Bill of materials", "EUR 1,599.84 · the costed four-finger design, eight motors"],
    ],
    github: "GitHub",
    write: "Write me",
  },

  // compliance: one honest sentence at the surface, the map behind the fold
  compliance: {
    kicker: "Built for Europe",
    head: "Compliant by design.",
    p: "A research instrument built under European rules: GDPR privacy by design, hard safety ceilings, and a mapped route to the clinic. Not a certified medical device, and it says so plainly.",
    cue: "Read the compliance map",
    cards: [
      { k: "Privacy · GDPR", p: "Data protection by design (Art. 25 GDPR): every signal stays with you, on the device's SD card and your own host machine. No cloud, no third-party processors. This site follows suit: no cookies, no trackers, no analytics." },
      { k: "Safety by design", p: "A hard 150 mA current ceiling (80 mA in gentle modes), mechanical stops at the anatomy's own limits, and assistance that dials to literally zero. The host-supervised architecture keeps a clinician in the loop." },
      { k: "The clinical path", p: "TAKTO ONE is a research instrument today, not a certified medical device, and says so plainly. The mapped route to the clinic: quality management per DIN EN ISO 13485, risk management per DIN EN ISO 14971, software lifecycle per IEC 62304, electrical safety per IEC 60601-1, conformity as a Class IIa device under EU MDR 2017/745, then the CE mark." },
    ],
    finePre: "Website legal notice and privacy policy: ",
    fineLink: "Impressum & Datenschutz",
  },

  // door three: WRITE - a warm, direct invitation
  write: {
    kicker: "Write me",
    head: "One pair of hands built this.",
    p1: "I am Juan Sebastian Molano, a biomedical engineer. I carried TAKTO ONE from first sketch to working instrument: mechanism, boards, firmware, and every console on this page.",
    p2: "Now I am looking for my next team: rehabilitation robotics, embodied AI, anywhere hardware meets learning. Jobs, ideas, collaborations. If this reads like your kind of engineering, write me. I answer.",
    contact: "Get in touch",
    github: "GitHub",
    cv: "CV",
  },

  foot: {
    feed: "live mock feed",
    legal: "Impressum & Datenschutz",
  },
};
