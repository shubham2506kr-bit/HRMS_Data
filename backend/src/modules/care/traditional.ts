// Traditional Knowledge + Home Self-Care registry for the Care Agent.
//
// This is a GOVERNED, curated content plane — it is NOT an open web search.
// It exists as a second knowledge plane beside the WHO registry and is never
// silently blended with it: every record carries full provenance, and the UI
// labels every employee-facing answer with its knowledge category.
//
// Content rules enforced here:
//  - No invented sources, Sanskrit, herbs, dosages or "Vedic" attributions.
//  - Historical claims stay historical; medical claims require evidence.
//  - Uncertain safety -> the recommendation is not made.
//  - Ingestion recommendations require established safety; otherwise we
//    route to professional care.
//  - Pregnancy / children / medication questions route to professional care.
//
// Source tiers:
//  TIER 1  WHO official guidance
//  TIER 2  Government of India / AYUSH official materials
//  TIER 3  Primary/classical traditional texts (bibliographic reference only)
//  TIER 5  Household/traditional practice records (explicit classification)
//  TIER 6  Uncategorized folklore — NOT allowed to generate recommendations

export type KnowledgeCategory =
  | 'WHO EVIDENCE'
  | 'AYURVEDIC CLASSICAL'
  | 'YOGA TRADITION'
  | 'CLASSICAL TEXT'
  | 'TRADITIONAL PRACTICE'
  | 'HOUSEHOLD PRACTICE'
  | 'MODERN AYUSH GUIDANCE'
  | 'GENERAL WELLBEING'
  | 'VEDIC / EARLY TEXTUAL'
  | 'PROFESSIONAL CARE';

export type EvidenceLevel =
  | 'Evidence-supported'
  | 'Traditional practice'
  | 'Historical reference'
  | 'Limited evidence'
  | 'Source unclear'
  | 'General wellbeing'
  | 'Modern AYUSH guidance';

export interface TraditionalKnowledgeItem {
  knowledge_id: string;
  title: string;
  category: KnowledgeCategory;
  tradition: string;
  source: string;
  source_type: string;
  source_url: string | null;
  original_text_reference: string | null;
  translation: string | null;
  interpretation: string;
  intended_use: string;
  evidence_level: EvidenceLevel;
  safety_level: string;
  contraindications: string | null;
  interaction_warnings: string | null;
  population_restrictions: string | null;
  pregnancy_restrictions: string | null;
  review_date: string;
  reviewer: string;
  status: 'APPROVED' | 'DRAFT' | 'REVIEW' | 'SUSPENDED' | 'RETIRED';
  keywords: string[];
}

export const AYUSH_PORTAL = 'https://main.ayush.gov.in/';
export const WHO_TM_STRATEGY_URL = 'https://www.who.int/publications/i/item/9789241506096';
export const REVIEWER = 'EduRankAI HumanOS content review';
export const REVIEW_DATE = '2026-08-19';

const K = (id: string, title: string, category: KnowledgeCategory, tradition: string, source: string, source_type: string, source_url: string | null, interpretation: string, intended_use: string, evidence_level: EvidenceLevel, safety_level: string, keywords: string[], extra?: Partial<TraditionalKnowledgeItem>): TraditionalKnowledgeItem => ({
  knowledge_id: id,
  title,
  category,
  tradition,
  source,
  source_type,
  source_url,
  original_text_reference: null,
  translation: null,
  interpretation,
  intended_use,
  evidence_level,
  safety_level,
  contraindications: null,
  interaction_warnings: null,
  population_restrictions: null,
  pregnancy_restrictions: null,
  review_date: REVIEW_DATE,
  reviewer: REVIEWER,
  status: 'APPROVED',
  keywords,
  ...extra,
});

// The curated, versioned library. Additions require provenance + review.
export const TRADITIONAL_LIBRARY: TraditionalKnowledgeItem[] = [
  K(
    'trad-daily-routine',
    'Daily rhythm (Dinacharya) — a traditional daily routine',
    'AYURVEDIC CLASSICAL',
    'Ayurvedic classical tradition',
    'Charaka Samhita — classical Ayurvedic text (bibliographic reference; interpretation only)',
    'CLASSICAL TEXT',
    AYUSH_PORTAL,
    'Classical Ayurvedic texts describe a daily rhythm of waking early, hygiene, movement, eating at regular times and sleep at consistent hours. This is presented as a traditional wellness practice — a way of structuring the day — not as a medical treatment.',
    'General wellbeing — structure for the day.',
    'Traditional practice',
    'LOW — non-ingestible daily routine guidance',
    ['dinacharya', 'daily routine', 'routine', 'morning', 'traditional daily', 'ayurveda', 'ayurvedic', 'rhythm'],
    { original_text_reference: 'Charaka Samhita (English-title reference; no verbatim Sanskrit quote asserted)', translation: 'Traditional interpretation of the classical daily-rhythm description. No original text is quoted.', population_restrictions: 'Adults. Adapt to your actual work schedule — a routine is guidance, not a rule.' },
  ),
  K(
    'trad-gentle-yoga',
    'Gentle yoga practice',
    'YOGA TRADITION',
    'Yoga tradition',
    'Hatha Yoga Pradipika and Yoga Sutras of Patanjali — traditional yoga texts (historical reference; interpretation only)',
    'CLASSICAL TEXT',
    AYUSH_PORTAL,
    'Yoga tradition describes postures and movement as part of a discipline of body and mind. A gentle, seated or slow practice can fit into a wellbeing routine. Start gently and stop if anything hurts — yoga is not a treatment for any condition.',
    'Gentle movement within a wellbeing routine.',
    'Traditional practice',
    'LOW — gentle non-exertional movement; stop if pain occurs',
    ['yoga', 'yogic', 'posture', 'asana', 'stretch', 'stretching', 'gentle movement', 'movement', 'relax', 'calm'],
    { contraindications: 'Do not practice through pain. If you have a musculoskeletal condition, ask a professional what is appropriate.', population_restrictions: 'Adults; adapt intensity to fitness level.' },
  ),
  K(
    'trad-breathing',
    'Alternate-nostril breathing (Nadi Shodhana) — traditional breathing practice',
    'YOGA TRADITION',
    'Yoga tradition',
    'Traditional yoga texts (historical reference; interpretation only)',
    'CLASSICAL TEXT',
    AYUSH_PORTAL,
    'Traditional yoga texts describe slow, seated breathing practices, of which alternate-nostril breathing is one. Practised gently and for short periods, slow breathing is a relaxation practice. It is not a treatment for any condition and must be stopped if you feel dizzy or unwell.',
    'Relaxation / wind-down practice.',
    'Traditional practice',
    'LOW — seated, short duration; stop if dizzy or breathless',
    ['breathing', 'pranayama', 'pranayam', 'nadi shodhana', 'breath', 'breathe', 'anulom vilom', 'relax', 'relaxation', 'calm', 'calming', 'relax breathing'],
    { contraindications: 'Do not practise while driving or operating machinery. Stop immediately if you feel dizzy, breathless or have chest discomfort.', interaction_warnings: 'Not a substitute for medical care for shortness of breath — that requires professional assessment.', population_restrictions: 'Adults.' },
  ),
  K(
    'trad-meditation',
    'Sitting meditation (Dhyana) — traditional reflective practice',
    'YOGA TRADITION',
    'Yoga tradition',
    'Yoga Sutras of Patanjali — traditional text (historical reference; interpretation only)',
    'CLASSICAL TEXT',
    AYUSH_PORTAL,
    'Meditation is traditionally described as a practice of quiet, seated reflection. As a wellbeing practice it can be a few minutes of stillness in the day. It is a cultural and wellbeing practice — not psychotherapy and not a treatment for any condition.',
    'Quiet reflection within a daily routine.',
    'Traditional practice',
    'LOW — seated stillness',
    ['meditation', 'meditate', 'mindfulness', 'dhyana', 'stillness', 'quiet reflection', 'reflection', 'relax', 'calm', 'calming'],
    { population_restrictions: 'Adults.' },
  ),
  K(
    'trad-abhyanga',
    'Abhyanga — traditional oil application as described in classical Ayurvedic texts',
    'AYURVEDIC CLASSICAL',
    'Ayurvedic classical tradition',
    'Classical Ayurvedic texts describe oil application as part of a traditional daily practice (bibliographic reference; interpretation only)',
    'CLASSICAL TEXT',
    AYUSH_PORTAL,
    'Abhyanga is traditionally described as a practice of applying warm oil to the skin as part of a daily wellness routine. It is presented here as a traditional practice for skin application only. It is not a treatment and oils are never to be ingested.',
    'Traditional topical wellness practice.',
    'Traditional practice',
    'MODERATE — TOPICAL USE ONLY. Never ingest oils described in traditional texts',
    ['abhyanga', 'oil', 'massage', 'warm oil', 'ayurvedic oil'],
    { contraindications: 'Do not use on irritated, broken or infected skin. Discontinue if the skin reacts.', interaction_warnings: 'Topical use only — ingestion of traditional oils is not recommended and can be harmful. Keep out of reach of children.', pregnancy_restrictions: 'Consult a healthcare professional before use during pregnancy.' },
  ),
  K(
    'trad-evening-winddown',
    'Quiet evening wind-down — a traditional-style evening routine',
    'TRADITIONAL PRACTICE',
    'Indian household tradition',
    'Combined household tradition + WHO sleep guidance (cross-reference)',
    'TRADITIONAL PRACTICE',
    null,
    'A traditional-style evening rhythm: gentle movement or a short walk, slow breathing, quiet reflection, dim lights and a consistent bedtime. WHO guidance independently supports consistent wind-down routines for good sleep. This is a wellbeing routine, not a treatment for sleep disorders.',
    'Wind-down routine before sleep.',
    'Traditional practice',
    'LOW',
    ['evening routine', 'wind down', 'wind-down', 'bedtime', 'night routine', 'relax after work', 'after work', 'evening', 'relax', 'relaxation', 'calm', 'unwind', 'sleep'],
  ),
  K(
    'trad-morning-routine',
    'Simple traditional morning rhythm',
    'TRADITIONAL PRACTICE',
    'Indian household tradition',
    'Combined classical-tradition interpretation + WHO guidance (cross-reference)',
    'TRADITIONAL PRACTICE',
    null,
    'A simple traditional-inspired morning rhythm: 1) gentle movement or yoga, 2) a short breathing practice, 3) quiet reflection, 4) hydration, 5) a balanced breakfast. Each step carries its own provenance: movement, breathing and reflection are traditional practices; hydration and a balanced breakfast align with WHO guidance. Historical and traditional practices are kept separate from modern health guidance.',
    'Structuring the start of the day.',
    'Traditional practice',
    'LOW',
    ['morning routine', 'morning rhythm', 'start the day', 'wake up routine', 'morning practice'],
  ),
  K(
    'trad-vedic-context',
    'Wellbeing in early Indian texts — historical context',
    'VEDIC / EARLY TEXTUAL',
    'Vedic / early textual tradition',
    'General scholarly understanding of early Indian texts (historical interpretation only)',
    'HISTORICAL REFERENCE',
    null,
    'Early Indian texts contain reflections on daily discipline, moderation, and harmony between body and mind. This record provides historical context only. HumanOS does not convert traditional belief into proven medical fact: no treatment claims are made from these texts, and no specific verse is quoted.',
    'Historical context and cultural understanding.',
    'Historical reference',
    'LOW — informational only',
    ['vedas', 'vedic', 'veda', 'ancient', 'early texts', 'what do the vedas say', 'vedic texts', 'ancient texts', 'scripture'],
    { original_text_reference: 'No verbatim verse is asserted. Interpretation reflects general scholarly framing of early Indian literature on daily discipline.' },
  ),
  K(
    'home-hydration-warmfluids',
    'Warm fluids and hydration — everyday home comfort',
    'HOUSEHOLD PRACTICE',
    'Indian household practice',
    'Household comfort practice + WHO healthy-diet guidance (cross-reference)',
    'HOUSEHOLD PRACTICE',
    null,
    'Drinking water regularly is supported by WHO guidance on a healthy diet. Warm fluids are a common household comfort practice. Both are comfort and hydration — they are not a treatment for any illness.',
    'Everyday comfort and hydration.',
    'General wellbeing',
    'LOW',
    ['hydration', 'water', 'warm fluids', 'warm water', 'tea', 'fluids', 'drink water'],
    { interaction_warnings: 'This is not advice to consume any medicinal preparation — only plain fluids and food.', pregnancy_restrictions: 'Plain fluids are generally fine; any medicinal preparation during pregnancy requires professional advice.' },
  ),
  K(
    'home-rest-sleep-support',
    'Basic home sleep-support routine',
    'HOUSEHOLD PRACTICE',
    'Household practice + WHO sleep guidance',
    'WHO sleep fact sheet (Tier 1) + household practice',
    'HOUSEHOLD PRACTICE',
    null,
    'A basic sleep-support routine: a consistent bedtime, a dark quiet room, no screens in the last hour, and a short wind-down. WHO guidance supports consistent sleep routines for adults. This is everyday sleep hygiene — not a treatment for insomnia; persistent sleep problems deserve professional care.',
    'Everyday sleep hygiene.',
    'General wellbeing',
    'LOW',
    ['sleep routine', 'sleep better', 'sleep hygiene', 'can\'t sleep', 'insomnia', 'bedtime routine', 'sleep support', 'sleep', 'tired'],
  ),
  K(
    'home-basic-comfort',
    'Basic comfort measures for mild everyday discomfort',
    'HOUSEHOLD PRACTICE',
    'Household practice',
    'Household practice record (explicit traditional-practice classification)',
    'HOUSEHOLD PRACTICE',
    null,
    'For mild everyday discomfort: rest, regular fluids, gentle movement and environmental comfort (temperature, light, noise). These are comfort measures for general wellbeing — never a treatment. If discomfort is severe, persistent or worsening, contact a healthcare professional.',
    'Everyday comfort for mild discomfort.',
    'General wellbeing',
    'LOW',
    ['home remedy', 'home remedies', 'remedy', 'at home', 'household', 'self care', 'self-care', 'natural', 'comfort'],
    { contraindications: 'Do not use in place of professional care for severe, persistent or worsening symptoms.' },
  ),
  K(
    'home-mild-headache-comfort',
    'Mild headache — basic comfort measures',
    'HOUSEHOLD PRACTICE',
    'Household practice',
    'Household practice record (explicit traditional-practice classification)',
    'HOUSEHOLD PRACTICE',
    null,
    'For a mild headache: rest in a quiet, dim room, drink fluids and take a screen break. No medicine is recommended by this system. If the headache is severe, sudden, recurrent or accompanied by other symptoms, contact a healthcare professional — a sudden severe headache warrants urgent assessment.',
    'Comfort measures for a mild headache only.',
    'General wellbeing',
    'LOW',
    ['headache', 'mild headache', 'head pain', 'sore head', 'tension head'],
    { contraindications: 'Not for sudden, severe or recurrent headaches — those need professional assessment.' },
  ),
  K(
    'home-mild-tiredness',
    'Mild tiredness — everyday rest practices',
    'HOUSEHOLD PRACTICE',
    'Household practice',
    'Household practice record + WHO sleep/activity guidance (cross-reference)',
    'HOUSEHOLD PRACTICE',
    null,
    'For mild tiredness: a short rest or pause, hydration, and a brief movement break. WHO guidance supports regular short movement breaks and good sleep. Persistent or unexplained tiredness deserves professional care rather than self-care.',
    'Everyday rest practices for mild tiredness.',
    'General wellbeing',
    'LOW',
    ['tiredness', 'mild tired', 'tired', 'fatigue', 'rest', 'rest break'],
    { contraindications: 'Persistent unexplained tiredness -> professional assessment.' },
  ),
  K(
    'official-ayush',
    'Ministry of Ayush — official Indian traditional-medicine authority',
    'MODERN AYUSH GUIDANCE',
    'Government of India / AYUSH',
    'Ministry of Ayush, Government of India (official portal)',
    'OFFICIAL GOVERNMENT SOURCE',
    AYUSH_PORTAL,
    'The Ministry of Ayush is the Government of India authority for Ayurveda, Yoga and related systems. HumanOS uses only official AYUSH materials for traditional knowledge; commercial supplement marketing is never used as a source. Always verify traditional-medicine claims against official AYUSH materials.',
    'Authoritative pointer for traditional-medicine information in India.',
    'Modern AYUSH guidance',
    'LOW — informational',
    ['ayush', 'ministry of ayush', 'official ayurveda', 'government ayurveda', 'ayush portal'],
  ),
  K(
    'who-tm-strategy',
    'WHO Traditional Medicine Strategy — how WHO views traditional medicine',
    'WHO EVIDENCE',
    'World Health Organization',
    'WHO Traditional Medicine Strategy 2014–2023 (official WHO publication)',
    'WHO OFFICIAL PUBLICATION',
    WHO_TM_STRATEGY_URL,
    'WHO recognizes traditional medicine while calling for safety, effectiveness, quality and science-based integration into health systems. This is the governing frame for HumanOS: traditional knowledge is respected as culture and practice, but it is never silently treated as modern clinical evidence.',
    'Governing frame for the traditional-knowledge plane.',
    'Evidence-supported',
    'LOW — informational',
    ['who traditional medicine', 'who traditional', 'traditional medicine who', 'who ayurveda', 'who strategy'],
  ),
  K(
    'trad-seasonal-routine',
    'Seasonal rhythm (Ritucharya) — traditional seasonal routine',
    'AYURVEDIC CLASSICAL',
    'Ayurvedic classical tradition',
    'Classical Ayurvedic texts on seasonal routine (bibliographic reference; interpretation only)',
    'CLASSICAL TEXT',
    AYUSH_PORTAL,
    'Classical Ayurvedic texts describe adjusting daily rhythm to the seasons — lighter activity and routines in hot weather, more warmth and rest in cold weather. This is presented as a traditional practice and general wellbeing guidance, not a medical treatment.',
    'General wellbeing — adapting routines to seasons.',
    'Traditional practice',
    'LOW',
    ['seasonal', 'season', 'ritucharya', 'weather', 'ritucharya routine', 'monsoon', 'summer routine', 'winter routine'],
  ),
  K(
    'trad-digestive-routine',
    'Traditional digestive wellbeing practices (general)',
    'AYURVEDIC CLASSICAL',
    'Ayurvedic classical tradition',
    'Classical Ayurvedic texts on eating habits (bibliographic reference; interpretation only)',
    'CLASSICAL TEXT',
    AYUSH_PORTAL,
    'Classical texts emphasize regular eating times, eating without rushing and not overeating. Only general eating-rhythm practices are listed here. No herbs and no ingestible preparations are recommended by this system. Persistent digestive symptoms require professional care.',
    'General eating-rhythm practices.',
    'Traditional practice',
    'LOW — no ingestible recommendations',
    ['digestion', 'digestive', 'stomach', 'eating habits', 'overeating', 'indigestion', 'bloating', 'meal times'],
    { interaction_warnings: 'This system does not recommend any herb, powder or preparation for digestion. If you are considering one, discuss it with a doctor or pharmacist first.', contraindications: 'Persistent or severe digestive symptoms -> professional care.' },
  ),
  K(
    'routine-travel-fieldwork',
    'Simple routine for travel and field work',
    'GENERAL WELLBEING',
    'General wellbeing',
    'WHO guidance on sleep, activity and healthy diet (Tier 1)',
    'WHO EVIDENCE',
    null,
    'When travelling or on field work: protect sleep where you can, keep water nearby, take short movement breaks, and eat at regular times. WHO guidance supports regular sleep, movement and healthy food. This is general wellbeing guidance, not medical advice.',
    'Everyday routine for travel and field work.',
    'General wellbeing',
    'LOW',
    ['travel', 'travelling', 'field work', 'fieldwork', 'field', 'on the road', 'tour', 'outstation'],
  ),
  K(
    'routine-exam-learning',
    'Routine for exam and learning periods',
    'GENERAL WELLBEING',
    'General wellbeing',
    'WHO guidance on sleep, activity and healthy diet (Tier 1)',
    'WHO EVIDENCE',
    null,
    'During exam or learning periods: protect sleep (it consolidates learning), take movement breaks between study blocks, stay hydrated and eat at regular times. WHO guidance supports regular sleep and activity. This is general wellbeing guidance, not medical advice.',
    'Everyday routine for exam and learning periods.',
    'General wellbeing',
    'LOW',
    ['exam', 'exams', 'learning', 'study', 'studying', 'studies', 'test preparation', 'revision', 'preparation'],
  ),
];

// --- Retrieval -------------------------------------------------------------

export interface TraditionalHit {
  item: TraditionalKnowledgeItem;
  hits: number;
  keywordHits: number;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
}

export function searchTraditionalLibrary(query: string, library: TraditionalKnowledgeItem[] = TRADITIONAL_LIBRARY): TraditionalHit[] {
  const q = normalize(query);
  if (!q) return [];
  // Documented relevance boosts (deterministic, provenance-safe — they never
  // fabricate content, they only rank existing governed records higher).
  const relaxationBoost = /\b(relax|relaxation|calm|unwind|de-?stress|breathe|meditat|yoga)\b/.test(q);
  const traditionBoost = /\b(traditional|indian|ayurved|vedic)\b/.test(q);
  const RELAX_IDS = ['trad-breathing', 'trad-meditation', 'trad-evening-winddown', 'trad-gentle-yoga'];
  const TRADITION_CATEGORIES = ['TRADITIONAL PRACTICE', 'AYURVEDIC CLASSICAL', 'YOGA TRADITION', 'HOUSEHOLD PRACTICE'];
  const scored = library
    .map((item) => {
      let hits = 0;
      let keywordHits = 0;
      for (const kw of item.keywords) {
        const k = kw.toLowerCase();
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}`, 'i').test(q)) {
          hits++;
          keywordHits++;
        }
      }
      const titleTerms = normalize(item.title).split(' ').filter((w) => w.length > 3);
      for (const t of titleTerms) {
        if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(q)) hits++;
      }
      if (hits > 0) {
        if (relaxationBoost && RELAX_IDS.includes(item.knowledge_id)) hits += 1;
        if (traditionBoost && TRADITION_CATEGORIES.includes(item.category)) hits += 1;
      }
      return { item, hits, keywordHits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, 4);
}

// --- Routine builder -------------------------------------------------------

export interface RoutineStep {
  title: string;
  detail: string;
  provenance: string; // 'WHO EVIDENCE' | 'TRADITIONAL PRACTICE' | 'GENERAL WELLBEING'
}

export interface Routine {
  kind: string;
  name: string;
  steps: RoutineStep[];
}

export const ROUTINES: Routine[] = [
  {
    kind: 'morning',
    name: 'Simple morning routine',
    steps: [
      { title: 'Gentle movement or yoga', detail: 'A few minutes of slow stretching or gentle yoga.', provenance: 'TRADITIONAL PRACTICE' },
      { title: 'Breathing practice', detail: 'One minute of slow, seated breathing.', provenance: 'TRADITIONAL PRACTICE' },
      { title: 'Quiet reflection', detail: 'A short moment of stillness before the day.', provenance: 'TRADITIONAL PRACTICE' },
      { title: 'Hydration', detail: 'Drink a glass of water.', provenance: 'WHO EVIDENCE' },
      { title: 'Balanced breakfast', detail: 'Fruit, vegetables, whole grains — keep it simple.', provenance: 'WHO EVIDENCE' },
    ],
  },
  {
    kind: 'workday',
    name: 'Workday rhythm',
    steps: [
      { title: 'Plan your day', detail: 'Set a few realistic priorities, not a wall of tasks.', provenance: 'GENERAL WELLBEING' },
      { title: 'Movement breaks', detail: 'Stand up and move every hour — WHO supports breaking up sedentary time.', provenance: 'WHO EVIDENCE' },
      { title: 'Recovery pause', detail: 'A 2-minute reset between tasks.', provenance: 'GENERAL WELLBEING' },
      { title: 'Hydration', detail: 'Keep water nearby.', provenance: 'WHO EVIDENCE' },
      { title: 'Protect a stopping time', detail: 'Decide when the workday ends.', provenance: 'GENERAL WELLBEING' },
    ],
  },
  {
    kind: 'lunch',
    name: 'Lunch reset',
    steps: [
      { title: 'Step away from the screen', detail: 'Even a short change of scene helps.', provenance: 'GENERAL WELLBEING' },
      { title: 'Eat without rushing', detail: 'A regular, unhurried meal.', provenance: 'TRADITIONAL PRACTICE' },
      { title: 'Short walk', detail: 'A few minutes of movement after eating.', provenance: 'WHO EVIDENCE' },
    ],
  },
  {
    kind: 'evening',
    name: 'Quiet evening wind-down',
    steps: [
      { title: 'Gentle movement or a short walk', detail: 'Light activity, not more work.', provenance: 'TRADITIONAL PRACTICE' },
      { title: 'Slow breathing', detail: 'A minute of slow, seated breathing.', provenance: 'TRADITIONAL PRACTICE' },
      { title: 'Quiet reflection', detail: 'Settle the day down.', provenance: 'TRADITIONAL PRACTICE' },
      { title: 'Dim lights, no screens before bed', detail: 'WHO supports consistent wind-down routines.', provenance: 'WHO EVIDENCE' },
      { title: 'Consistent bedtime', detail: 'WHO recommends 7–9 hours for adults.', provenance: 'WHO EVIDENCE' },
    ],
  },
  {
    kind: 'sleep',
    name: 'Sleep-support routine',
    steps: [
      { title: 'Consistent bedtime and wake time', detail: 'WHO recommends 7–9 hours for adults.', provenance: 'WHO EVIDENCE' },
      { title: 'Dark, quiet, cool room', detail: 'Protect your sleep environment.', provenance: 'WHO EVIDENCE' },
      { title: 'No screens in the last hour', detail: 'Wind down without bright light.', provenance: 'WHO EVIDENCE' },
      { title: 'Quiet wind-down', detail: 'Breathing or reflection before bed.', provenance: 'TRADITIONAL PRACTICE' },
    ],
  },
  {
    kind: 'travel',
    name: 'Travel / field-work routine',
    steps: [
      { title: 'Protect sleep where you can', detail: 'Consistent sleep times matter on the road too.', provenance: 'WHO EVIDENCE' },
      { title: 'Keep water nearby', detail: 'Stay hydrated during travel.', provenance: 'WHO EVIDENCE' },
      { title: 'Movement breaks', detail: 'Short walks between legs of travel.', provenance: 'WHO EVIDENCE' },
      { title: 'Regular meals', detail: 'Eat at regular times when possible.', provenance: 'WHO EVIDENCE' },
    ],
  },
  {
    kind: 'exam',
    name: 'Exam / learning-period routine',
    steps: [
      { title: 'Protect sleep', detail: 'Sleep consolidates learning — WHO recommends 7–9 hours.', provenance: 'WHO EVIDENCE' },
      { title: 'Movement breaks', detail: 'Step away between study blocks.', provenance: 'WHO EVIDENCE' },
      { title: 'Hydration', detail: 'Keep water at your desk.', provenance: 'WHO EVIDENCE' },
      { title: 'Regular meals', detail: 'Don\'t skip meals while preparing.', provenance: 'WHO EVIDENCE' },
    ],
  },
  {
    kind: 'recovery',
    name: 'Recovery routine',
    steps: [
      { title: 'Rest without guilt', detail: 'Recovery is part of the work, not the enemy of it.', provenance: 'GENERAL WELLBEING' },
      { title: 'Hydration and regular meals', detail: 'Basic fuel matters most when drained.', provenance: 'WHO EVIDENCE' },
      { title: 'Gentle movement', detail: 'A short walk or gentle yoga.', provenance: 'TRADITIONAL PRACTICE' },
      { title: 'Sleep protection', detail: 'Prioritize 7–9 hours for a few nights.', provenance: 'WHO EVIDENCE' },
      { title: 'Reach out if it persists', detail: 'Persistent exhaustion deserves professional attention.', provenance: 'PROFESSIONAL CARE' },
    ],
  },
];

export function buildRoutineFor(query: string): Routine {
  const q = normalize(query);
  const kinds: [string, RegExp][] = [
    ['morning', /\bmorning\b|\bstart (my )?day\b|\bwake up\b/],
    ['evening', /\bevening\b|\bwind.?down\b|\bafter work\b|\bnight\b/],
    ['sleep', /\bsleep\b|\bbedtime\b|\binsomnia\b/],
    ['lunch', /\blunch\b|\bmidday\b|\bbreak\b/],
    ['travel', /\btravel|\btravel(l)?ing\b|\bfield work\b|\bfieldwork\b|\bon the road\b/],
    ['exam', /\bexam(s)?\b|\bstudy(ing)?\b|\blearning\b|\brevision\b/],
    ['recovery', /\brecover(y|ing)\b|\bexhaust(ed|ing)\b|\brecuperate\b/],
    ['workday', /\bwork\b|\bworkday\b|\boffice\b|\bday\b/],
  ];
  for (const [kind, re] of kinds) {
    if (re.test(q)) {
      const routine = ROUTINES.find((r) => r.kind === kind);
      if (routine) return routine;
    }
  }
  const fallback = ROUTINES.find((r) => r.kind === 'morning');
  return fallback ?? ROUTINES[0]!; // morning — default answer-first fallback
}

// --- Home self-care safety engine ------------------------------------------

export interface HomeSafetyContext {
  pregnant?: boolean;
  child?: boolean;
  takingMedication?: boolean;
  symptom: string;
}

export type HomeSafetyVerdict =
  | { decision: 'RECOMMEND'; note: string }
  | { decision: 'DO_NOT_RECOMMEND'; reason: string };

// Governed decision: if safety cannot be established, we do NOT recommend.
export function assessHomeRemedy(ctx: HomeSafetyContext): HomeSafetyVerdict {
  const symptom = normalize(ctx.symptom);
  if (ctx.pregnant) {
    return { decision: 'DO_NOT_RECOMMEND', reason: 'Pregnancy safety: no traditional or herbal ingestion recommendations are provided during pregnancy unless a source explicitly supports them with established safety. Please consult a doctor or midwife.' };
  }
  if (ctx.child) {
    return { decision: 'DO_NOT_RECOMMEND', reason: 'Adult practices are not generalized to children. Please ask a paediatric healthcare professional.' };
  }
  if (ctx.takingMedication) {
    return { decision: 'DO_NOT_RECOMMEND', reason: 'A practice could interact with your medication. Please have a doctor or pharmacist review it first.' };
  }
  if (/\b(severe|chest|bleeding|difficulty breathing|can.?t breathe|fever|vomit|dizzy|faint|paralys|numbness|sudden)\b/i.test(symptom)) {
    return { decision: 'DO_NOT_RECOMMEND', reason: 'Severity gate: these symptoms need professional assessment, not self-care. Please contact a healthcare professional — do not wait if it is urgent.' };
  }
  return { decision: 'RECOMMEND', note: 'Comfort measures only: rest, hydration, gentle movement and environmental comfort. These are general wellbeing practices, not a treatment.' };
}

// --- DB sync ----------------------------------------------------------------

export async function syncTraditionalLibrary(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) {
  for (const item of TRADITIONAL_LIBRARY) {
    await pool.query(
      `INSERT INTO health.traditional_knowledge (
         knowledge_id, title, category, tradition, source, source_type, source_url,
         original_text_reference, translation, interpretation, intended_use,
         evidence_level, safety_level, contraindications, interaction_warnings,
         population_restrictions, pregnancy_restrictions, review_date, reviewer, status, keywords
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (knowledge_id) DO UPDATE SET
         title = EXCLUDED.title, interpretation = EXCLUDED.interpretation,
         status = EXCLUDED.status, review_date = EXCLUDED.review_date`,
      [
        item.knowledge_id, item.title, item.category, item.tradition, item.source, item.source_type, item.source_url,
        item.original_text_reference, item.translation, item.interpretation, item.intended_use,
        item.evidence_level, item.safety_level, item.contraindications, item.interaction_warnings,
        item.population_restrictions, item.pregnancy_restrictions, item.review_date, item.reviewer, item.status,
        JSON.stringify(item.keywords),
      ]
    );
  }
}