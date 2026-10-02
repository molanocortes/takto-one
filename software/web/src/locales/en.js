// locales/en.js - ENGLISH (the default and the reference copy).
// Every locale exports the SAME shape; entry.js builds the product page from
// it. Numbers, part names, and units stay identical across locales - only
// prose translates. Honesty rules ride along: no unclaimed processes, no
// certificates we do not hold, the metal is OPEN (AlSi10Mg or 316L, neither
// fabricated), EUR 1,222.25 is the COSTED four-finger design and covers the
// priced lines of docs/BOM.md only, never money spent, and nothing claims
// the worn finger has been motor-driven.
// Facts follow the firmware, not older copy: 100 Hz frames (SAMPLE_HZ, v16),
// and the safety ceiling is a FORCE (10 N felt, 22 N servo backstop), which
// stays true whichever XC330 variant is fitted.
// EDITORIAL RULE (owner, 2026-08-03): headlines + captions + numbers carry
// the story; no section over ~60 visible words at the surface; the deep
// content lives behind the folds (sheet, compliance map), never deleted.

export const L = {
  nav: {
    design: "Design",
    tech: "Technology",
    specs: "Specs",
    build: "Open source",
    contact: "Contact",
    console: "Console",
    consoleTitle: "Open the live console",
  },

  hero: {
    tagline: "The hand, alive.",
    sub: "A wearable exoskeleton that reads, assists and records the human hand.",
    finishLabel: "Finish",
    cta: "Open the console",
    next: "Scroll to explore",
  },

  // the three rendered finish studies (docs/media/personalize.png)
  finishes: {
    snow: { name: "Snow", line: "White shell, graphite rails." },
    onyx: { name: "Onyx", line: "Graphite, forearm to fingertip." },
    signal: { name: "Signal", line: "Orange spools, blue fingers." },
  },

  intro: {
    kicker: "TAKTO ONE",
    head: "Built around the hand.",
    sub: "A research instrument for the most capable tool we have.",
    left: "TAKTO ONE is a wearable hand exoskeleton. Four finger rails, a palm plate and a forearm unit read every joint, add force through tendons, and record what the hand does.",
    right: "Designed, built and programmed end to end by one engineer, Sebastian Molano, as an open instrument for rehabilitation research, motion data and teleoperation.",
    tiles: ["Four finger rails", "Curls with you", "One forearm unit"],
  },

  // the pinned 360: one caption per third of the turn
  turn: {
    kicker: "Design",
    head: "Every angle, considered.",
    caps: [
      { h: "Telescopic fingers.",
        p: "Self-aligning linkages lengthen almost a centimetre as you curl, so the brace never fights the finger." },
      { h: "The weight lives on the forearm.",
        p: "Motors, tendon spools and the controller ride on the forearm, keeping the hand light." },
      { h: "A face on the wrist.",
        p: "A round display shows what the device is doing, at a glance." },
    ],
  },

  // the specs showcase: an index plate on the render, the big numbers, then
  // the full sheet (rows), always visible. Numbers follow the firmware.
  specs: {
    kicker: "Specs",
    head: "Every detail, measured.",
    sub: "The numbers behind the hand, straight from the firmware and the bill of materials.",
    tour0: { h: "Six parts. One instrument.", p: "Scroll to walk through the machine, part by part." },
    // the tour: what each part does for the wearer (owner, round 3: "too heavy on numbers"), its figures demoted to one small spec line
    callouts: [
      { k: "Display", h: "Status, at a glance.", p: "A round display on the wrist shows what the device is doing, without a laptop in sight.",
        s: "Round GC9A01A display" },
      { k: "Spools", h: "One spool, both directions.", p: "Each joint's flexor and extensor share one spool, so the finger never goes slack when it reverses.",
        s: "10 bays · 0.30 mm Dyneema tendons" },
      { k: "Motors", h: "The weight stays on the forearm.", p: "The motors ride on the forearm and pull through tendons, so the hand carries only light links.",
        s: "8 × Dynamixel XC330 · < 150 g on the hand (target)" },
      { k: "Controller", h: "A brain on the wrist.", p: "One controller reads every sensor, drives every motor and records every session.",
        s: "Teensy 4.1 · 100 Hz full state" },
      { k: "Encoders", h: "Every joint, felt.", p: "A magnetic encoder at every finger articulation measures the hand as it moves.",
        s: "12 × AS5600 · 0.088°" },
      { k: "Links", h: "It grows with your finger.", p: "Self-aligning telescopic links lengthen as the finger curls, so the brace never fights the joint.",
        s: "≈ 1 cm of travel at full flexion" },
    ],
    // the four headline figures under the tour (values live in entry.js)
    stats: ["joints sensed", "resolution at every joint", "the full state, streamed", "the whole priced bill of materials"],
    // docs/BOM.md cost summary, largest first (the stat's bar)
    costGroups: ["Motors", "Print stock", "Motion sensing", "Control", "Joint sensing", "Tendons"],
  },
  // Tech Specs, set the way Apple sets them (owner, round 3: "do it like
  // Apple would"): a label column, short items, three drawings, and the
  // fine print as numbered notes. Every line of the old instrument sheet
  // lives here; numbers and units stay as in the firmware and the BOM.
  ts: {
    head: "Tech Specs",
    model: "TAKTO ONE",
    config: "Four-finger configuration",
    all: "All tech specs",
    finishK: "Finish",
    finishP: "The structure is printed, so colour is a choice. Three studies.",
    sizeK: "Size and weight",
    unit: "Forearm unit",
    dims: ["Length", "Width", "Height"],
    overall: "Overall length",
    overallP: "Forearm to fingertip, fingers extended",
    hand: "On the hand",
    handP: "The motors ride on the forearm",
    rows: [
      { k: "Sensing", items: [
        ["12 magnetic joint encoders", "AS5600, one at every finger articulation."],
        ["0.088° resolution", "At every joint, in 100 Hz frames."],
        ["3 inertial sensors", "BNO085 on the back of the hand, the forearm and the thumb tip."],
        ["Surface EMG", "The effort envelope from the forearm; intent is estimated on the host."],
      ] },
      { k: "Range of motion", items: [
        ["MCP 90°", "Flexion at the knuckle."],
        ["PIP 110°", "Flexion at the middle joint."],
        ["Signed abduction", "Sensed at every knuckle."],
        ["≈ 1 cm self-alignment", "The telescopic links lengthen at full flexion, so the brace never fights the finger."],
      ] },
      { k: "Actuation", items: [
        ["8 Dynamixel XC330 motors", "Two per finger, carried on the forearm.³"],
        ["One spool per joint", "An antagonist cable pair: flexion and extension from the same motor, with no backlash at reversal."],
        ["Dyneema tendons", "0.30 mm braided UHMWPE, in PTFE conduit."],
        ["Assistance on the crown", "Continuous, from full assist down to pure transparency."],
      ] },
      { k: "Safety", items: [
        ["10 N force ceiling", "Enforced in firmware: the machine cannot out-muscle its wearer."],
        ["22 N backstop", "A current limit inside the servos."],
        ["Mechanical hard stops", "At the anatomy's own limits."],
      ] },
      { k: "Controller and display", items: [
        ["Teensy 4.1", "600 MHz Arm Cortex-M7. Reads every sensor, drives every motor, writes every take."],
        ["Round status display", "32 mm, on the wrist: the device's state at a glance."],
        ["Crown and button", "Navigate the device and dial assistance without a laptop."],
      ] },
      { k: "Recording and data", items: [
        ["100 Hz full-state stream", "Joints, motion, motors and effort, live to any console."],
        ["Onboard recording", "Hours of takes on the device's own SD card."],
        ["Labelled takes", "Captured from any console, ready for analysis."],
      ] },
      { k: "Software", items: [
        ["Web console", "The live twin, telemetry, calibration and every session mode, in the browser."],
        ["AR experience", "The twin, capture and replay in your own space."],
        ["Android companion", "Pairs with a QR code."],
        ["Open source", "Firmware, host bridge, consoles, boards and CAD."],
      ] },
      { k: "Materials", items: [
        ["Printed PETG", "The structure, as built."],
        ["Ready for metal", "Two links per finger engineered for metal AM, in aluminium (AlSi10Mg) or 316L.⁴"],
        ["Self-lubricating pairs", "Every sliding pair runs a hard face against a self-lubricating polymer."],
      ] },
      { k: "Cost", items: [
        ["€1,222.25", "The priced bill of materials: four fingers, eight motors.⁵"],
        ["$170.73", "Both custom boards, as one delivered order."],
      ] },
    ],
    notes: [
      "Dimensions of the CAD assembly as modelled. A printed build varies with finger sizing.",
      "A design target.",
      "The shipped firmware is configured for one antagonist pair on one finger: the bench setup.",
      "Engineered for metal additive manufacturing and studied in CAD and linear-static FEA. No metal parts have been fabricated.",
      "Indicative prices, ex VAT and shipping, from the project's own 2026 purchasing. Some lines carry no published price; the full list is in docs/BOM.md.",
    ],
  },

  finishSec: {
    kicker: "Finishes",
    head: "Printed in any colour.",
    sub: "The structure is printed, so colour is a choice. Three studies.",
    select: "Show this finish",
    selected: "Shown above",
  },

  tech: {
    kicker: "Technology",
    head: "Feel every joint.",
    dial: {
      kicker: "Transparency",
      head: "Force you can dial to zero.",
      p: "Turn the crown and assistance fades continuously, down to a machine that only follows you.",
      words: ["Transparent", "Blended", "Assisted"],
      aria: "Assistance level",
    },
    face: {
      kicker: "Display",
      head: "Always tells you where it is.",
      p: "A 240-pixel round display shows the device state.",
      modes: { home: "Ready", transparent: "Transparent", capture: "Recording", saved: "Saved" },
    },
    enc: {
      kicker: "Sensing",
      head: "Twelve joints, measured.",
      p: "A magnetic encoder at every finger articulation.",
    },
    tendon: {
      kicker: "Drive",
      head: "Pulled by tendons.",
      p: "One spool per joint flexes and extends the finger, with no backlash at reversal.",
    },
    safe: {
      kicker: "Safety",
      n: "10 N",
      head: "It cannot out-muscle you.",
      p: "A force ceiling in firmware, a 22 N backstop in the servos, and hard stops at the anatomy's own limits.",
    },
    emg: {
      kicker: "Intent",
      head: "It feels you begin.",
      p: "Surface EMG on the forearm lets the host estimate effort and intent.",
    },
    sd: {
      kicker: "Capture",
      head: "Records on its own.",
      p: "Every take is written to the device's SD card. No laptop needed.",
    },
  },

  twin: {
    kicker: "Digital twin",
    head: "Spin it.",
    p: "The digital twin follows the device joint by joint, in real time.",
    hint: "Drag to turn",
    live: "Live device",
    open: "Open the console",
    demo: "Demo motion",
  },

  film: {
    kicker: "Film",
    head: "In motion.",
    alt: "TAKTO ONE, the film",
    play: "Play the film",
  },

  console: {
    kicker: "Console",
    head: "One console for everything.",
    p: "The live twin, telemetry, calibration and every session mode, in one place, in your browser.",
    open: "Open the console",
    inside: "Inside",
    modes: {
      guided: "Guided therapy",
      mirror: "Mirror therapy",
      capture: "Capture",
      replay: "Replay",
      sign: "Sign capture",
      translate: "Live recognition",
    },
  },

  build: {
    kicker: "Open source",
    head: "Yours to build.",
    cards: [
      { k: "Source", h: "Firmware to front end",
        p: "Firmware, host bridge, consoles and this page.",
        label: "GitHub" },
      { k: "Build guide", h: "Build TAKTO ONE",
        p: "Step-by-step assembly for the complete instrument.",
        label: "Open the guide" },
      { k: "Bill of materials", h: "EUR 1,222.25",
        p: "The costed four-finger design: the priced lines of the bill of materials.",
        label: "Read the BOM" },
    ],
  },

  // the WHY: the owner's creed, in the owner's own words
  creed: {
    kicker: "Why it exists",
    head: "A hammer is never only about the nail.",
    p: "Every nail it drives is part of a house. TAKTO ONE moves a finger, and every movement can become part of something larger: a grip relearned, a word signed, a robot that learns from a human hand. I don't know everything it will become. People far more creative than me will find uses I never imagined, and everyone I show it to sees something different. That is the point. It isn't a company and it isn't about money. I build for the love of creating, and I share it with everyone who gives it their time and attention.",
    by: "Sebastian Molano",
  },

  // compliance: one honest sentence at the surface, the map behind the fold
  compliance: {
    kicker: "Built for Europe",
    head: "Compliant by design.",
    p: "A research instrument built under European rules: GDPR privacy by design, hard safety ceilings, and a mapped route to the clinic. Not a certified medical device, and it says so plainly.",
    cue: "Read the compliance map",
    cards: [
      { k: "Privacy · GDPR", p: "Data protection by design (Art. 25 GDPR): every signal stays with you, on the device's SD card and your own host machine. No cloud, no third-party processors. This site follows suit: no cookies, no trackers, no analytics." },
      { k: "Safety by design", p: "A 10 N force ceiling enforced in firmware, a 22 N backstop in the servos, mechanical stops at the anatomy's own limits, and assistance that dials to literally zero. The host-supervised architecture keeps a clinician in the loop." },
      { k: "The clinical path", p: "TAKTO ONE is a research instrument today, not a certified medical device, and says so plainly. The mapped route to the clinic: quality management per DIN EN ISO 13485, risk management per DIN EN ISO 14971, software lifecycle per IEC 62304, electrical safety per IEC 60601-1, conformity as a Class IIa device under EU MDR 2017/745, then the CE mark." },
    ],
    finePre: "Website legal notice and privacy policy: ",
    fineLink: "Impressum & Datenschutz",
  },

  write: {
    kicker: "Contact",
    head: "One pair of hands built this.",
    p1: "I am Sebastian Molano, a biomedical engineer. I carried TAKTO ONE from first sketch to working instrument: mechanism, boards, firmware, and every console on this page.",
    p2: "Now I am looking for my next team: rehabilitation robotics, embodied AI, anywhere hardware meets learning. Jobs, ideas, collaborations. If this reads like your kind of engineering, write me. I answer.",
    contact: "Write me",
    github: "GitHub",
  },

  craft: ["Mechanism design", "Design for metal AM", "Custom PCBs",
    "Embedded firmware", "Real-time control", "Web · AR · Android"],

  foot: {
    line: "Open hardware hand exoskeleton",
    legal: "Impressum & Datenschutz",
    top: "Back to top",
  },
};
