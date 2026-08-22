// Health Advisor intent classification + WHO semantic retrieval.
//
// Principles (master prompt §10–§18):
//  - Broad intents from natural phrasing, NOT keyword equality.
//  - Substantive health guidance ONLY from approved WHO sources (who.int,
//    iris.who.int, official WHO publications). No model-memory medicine.
//  - No WHO source -> no substantive advice: refuse honestly and route to
//    professional support.
//  - The advisor never uses workload/task/productivity signals.

export type IntentCode =
  | 'sleep'
  | 'energy'
  | 'physical_activity'
  | 'mental_health_at_work'
  | 'depression'
  | 'alcohol'
  | 'diet'
  | 'ncd'
  | 'unwell'
  | 'professional'
  | 'reset'
  | 'traditional'
  | 'routine'
  | 'homecare'
  | 'vedic'
  | 'medication'
  | 'pregnancy'
  | 'women'
  | 'none';

export interface Intent {
  code: IntentCode;
  label: string;
  topicCode: string | null; // WHO topic code this intent grounds to (null = no substantive advice)
  phrases: string[];
}

// Order matters: on equal hit counts the FIRST intent in this list wins.
// Traditional-knowledge intents come before WHO intents so that queries like
// "traditional Indian practices for sleep" stay in the traditional plane.
const PHRASES: Intent[] = [
  {
    code: 'vedic',
    label: 'Vedic / early textual context',
    topicCode: null,
    phrases: ['vedas', 'vedic', 'veda', 'what do the vedas say', 'ancient texts', 'vedic texts', 'vedic tradition', 'vedic knowledge'],
  },
  {
    code: 'traditional',
    label: 'Traditional Indian practices',
    topicCode: null,
    phrases: [
      'traditional', 'ayurveda', 'ayurvedic', 'yoga', 'yogic', 'meditation', 'meditate',
      'pranayama', 'pranayam', 'dinacharya', 'anulom vilom', 'nadi shodhana', 'abhyanga',
      'morning routine', 'evening routine', 'indian practice', 'indian practices',
      'traditional options', 'traditional practice', 'traditional practices',
    ],
  },
  {
    code: 'pregnancy',
    label: 'Pregnancy-related care',
    topicCode: null,
    phrases: ['pregnant', 'pregnancy', 'trying to conceive', 'breastfeeding', 'postpartum', 'expecting a baby', 'maternity', 'prenatal', 'antenatal'],
  },
  {
    code: 'women',
    label: "Women's care",
    topicCode: null,
    phrases: [
      "women's health", 'women health', 'menstrual', 'menstruation', 'periods', 'period pain',
      'menopause', 'ovarian', 'cervical', 'breast cancer', 'mammogram', 'pcod', 'pcos', 'cramps',
      'reproductive health', 'gynaecological', 'gynecological',
    ],
  },
  {
    code: 'homecare',
    label: 'Home self-care',
    topicCode: null,
    phrases: ['home remedy', 'home remedies', 'remedy', 'at home', 'household', 'natural remedy', 'herbal', 'herbs', 'herb', 'home care', 'self-care at home', 'self care at home'],
  },
  {
    code: 'medication',
    label: 'Medication safety',
    topicCode: null,
    phrases: ['prescription', 'medication', 'medicine safe', 'with my medicine', 'drug interaction', 'medication interaction', 'is this medicine', 'with my medication', 'safe with my', 'pharmacist'],
  },
  {
    code: 'routine',
    label: 'Personal routine builder',
    topicCode: null,
    phrases: ['routine', 'routines', 'build me a routine', 'my routine', 'routine for', 'daily rhythm', 'day plan', 'plan my day'],
  },
  {
    code: 'sleep',
    label: 'Sleep and rest',
    topicCode: 'sleep',
    phrases: [
      'can\'t sleep', 'cannot sleep', 'can not sleep', 'hard to sleep', 'fall asleep',
      'sleep', 'sleepy', 'insomnia', 'tired', 'exhausted', 'fatigue', 'wake up',
      'waking up', 'rest', 'rested', 'slept',
    ],
  },
  {
    code: 'energy',
    label: 'Low energy',
    topicCode: 'physical-activity',
    phrases: [
      'no energy', 'low energy', 'out of energy', 'drained', 'feel weak', 'weakness',
      'no motivation to move', 'lack energy', 'energy',
    ],
  },
  {
    code: 'physical_activity',
    label: 'Physical activity',
    topicCode: 'physical-activity',
    phrases: [
      'exercise', 'working out', 'work out', 'active', 'inactive', 'sedentary',
      'sitting all day', 'walk', 'walking', 'movement', 'moving',
    ],
  },
  {
    code: 'mental_health_at_work',
    label: 'Mental health at work',
    topicCode: 'mental-health-at-work',
    phrases: [
      'stress', 'stressed', 'burnout', 'burned out', 'burnt out', 'pressure',
      'overwhelmed', 'anxious', 'anxiety', 'panic', 'worried', 'tense', 'workload stress',
    ],
  },
  {
    code: 'depression',
    label: 'Depression',
    topicCode: 'depression',
    phrases: [
      'depress', 'depressed', 'sad', 'hopeless', 'hopelessness', 'suicide',
      'self-harm', 'self harm', 'empty', 'worthless', 'no one cares', 'cry', 'crying',
    ],
  },
  {
    code: 'alcohol',
    label: 'Alcohol',
    topicCode: 'alcohol',
    phrases: ['alcohol', 'drinking', 'drink', 'hangover', 'binge drinking', 'drunk'],
  },
  {
    code: 'diet',
    label: 'Diet and nutrition',
    topicCode: 'healthy-diet',
    phrases: ['diet', 'eat', 'eating', 'food', 'nutrition', 'sugar', 'salt intake', 'junk food', 'overeat', 'overeating'],
  },
  {
    code: 'ncd',
    label: 'Noncommunicable diseases',
    topicCode: 'ncds',
    phrases: ['heart', 'diabetes', 'cancer', 'blood pressure', 'cholesterol', 'stroke', 'hypertension'],
  },
  {
    code: 'unwell',
    label: 'Feeling unwell',
    topicCode: null,
    phrases: [
      'feel sick', 'feeling sick', 'not feeling well', 'not well', 'feel unwell',
      'unwell', 'feel ill', 'sick', 'fever', 'headache', 'migraine', 'nausea',
      'vomiting', 'throwing up', 'stomach ache', 'stomach pain', 'pain', 'hurts',
      'aching', 'sore', 'dizzy', 'chills',
    ],
  },
  {
    code: 'professional',
    label: 'Professional support',
    topicCode: null,
    phrases: [
      'talk to a professional', 'talk to someone', 'speak to a professional', 'speak to someone',
      'professional support', 'counsellor', 'counselor', 'therapist', 'psychologist', 'psychiatrist',
      'see a doctor', 'doctor', 'emergency', 'crisis line', 'help me now', 'urgent',
      'need help',
    ],
  },
  {
    code: 'reset',
    label: 'Reset and recovery',
    topicCode: null,
    phrases: [
      'need a break', 'take a break', 'a break', 'reset', 'recharge', 'refresh',
      'clear my head', 'time out', 'pause', 'slow down',
    ],
  },
];

export interface ScoredIntent {
  intent: Intent;
  hits: number;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
}

export function classifyIntents(question: string): ScoredIntent[] {
  const q = normalize(question);
  if (!q) return [];
  const scored: ScoredIntent[] = [];
  for (const intent of PHRASES) {
    let hits = 0;
    for (const phrase of intent.phrases) {
      const p = phrase.toLowerCase();
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}`, 'i').test(q)) hits++;
    }
    if (hits > 0) scored.push({ intent, hits });
  }
  return scored.sort((a, b) => b.hits - a.hits);
}

export function dominantIntent(question: string): Intent | null {
  const scored = classifyIntents(question);
  return scored.length > 0 && scored[0] ? scored[0].intent : null;
}

export interface Topic {
  topic_id: string;
  code: string;
  title: string;
  summary: string;
  keywords: string[];
  source_url: string;
  source_name: string;
  applicability?: string | null;
  escalation_notes?: string | null;
  citation?: string | null;
  publication_date?: string | null;
}

// Keyword overlap scoring against the registry (semantic retrieval step).
export function matchTopics(question: string, topics: Topic[]) {
  const q = normalize(question);
  const scored = topics
    .map((t) => {
      let hits = 0;
      for (const kw of t.keywords) {
        const k = kw.toLowerCase();
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}`, 'i').test(q)) hits++;
      }
      return { topic: t, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, 3);
}

export const NO_SOURCE_REFUSAL =
  "I don't have an approved WHO-supported answer for this question. " +
  'I can help you find appropriate professional support or a relevant WHO resource.';

export const SUPPORT_NOTE =
  'If you are having thoughts of self-harm or suicide, please contact local emergency services or a crisis line immediately — you matter, and help works.';

export const DISCLAIMER =
  'This is general health information from WHO public sources, not medical advice, and never a diagnosis. ' +
  'For personal health decisions, speak with a healthcare professional.';

export interface AdvisorResponse {
  reply: string;
  matched: { code: string; title: string; source_url: string; source_name: string }[];
  disclaimer: string;
  intent: string | null;
  structure: {
    answer: string;
    guidance: string;
    applicability: string;
    safety: string;
    source: { title: string; citation: string; url: string };
  } | null;
  suggestion: { kind: 'reset' } | { kind: 'choice' } | null;
  showProfessional: boolean;
}

export function buildAdvisorResponse(question: string, topics: Topic[]): AdvisorResponse {
  const intent = dominantIntent(question);
  const topicMatches = matchTopics(question, topics);

  // Professional support / crisis — route, never advise.
  if (intent?.code === 'professional') {
    const reply =
      'You asked about speaking to a professional. That is always a reasonable step. ' +
      'You can reach out to a healthcare professional of your choice — your regular doctor, a ' +
      'mental health professional, or your workplace\'s employee support channel. ' +
      SUPPORT_NOTE;
    return {
      reply,
      matched: [],
      disclaimer: DISCLAIMER,
      intent: intent.code,
      structure: null,
      suggestion: null,
      showProfessional: true,
    };
  }

  // Feeling unwell — no substantive advice without a WHO source. Honest refusal.
  if (intent?.code === 'unwell') {
    const reply =
      NO_SOURCE_REFUSAL +
      ' I understand you feel unwell. Please contact a healthcare professional for an assessment ' +
      'of your symptoms — and if it is urgent, do not wait.';
    return {
      reply,
      matched: [],
      disclaimer: DISCLAIMER,
      intent: intent.code,
      structure: null,
      suggestion: null,
      showProfessional: true,
    };
  }

  // Reset request — offer the reset experience.
  if (intent?.code === 'reset') {
    return {
      reply:
        'A short reset is a practical way to step back. Would you like a guided 30-second, 2-minute or 5-minute reset?',
      matched: [],
      disclaimer: DISCLAIMER,
      intent: intent.code,
      structure: null,
      suggestion: { kind: 'reset' },
      showProfessional: false,
    };
  }

  // Sleepy / low energy — offer choice per §15–§16.
  if (intent?.code === 'sleep' && /\bsleepy\b/.test(normalize(question))) {
    return {
      reply: 'Feeling sleepy is common. Would you like a quick reset?',
      matched: [],
      disclaimer: DISCLAIMER,
      intent: intent.code,
      structure: null,
      suggestion: { kind: 'reset' },
      showProfessional: false,
    };
  }
  if (intent?.code === 'energy') {
    return {
      reply: 'Low energy can have many causes. Would you like a short reset, general WHO-supported wellbeing information, or professional support?',
      matched: [],
      disclaimer: DISCLAIMER,
      intent: intent.code,
      structure: null,
      suggestion: { kind: 'choice' },
      showProfessional: false,
    };
  }

  // Grounded answer: intent maps to a WHO topic.
  if (intent?.topicCode) {
    const topic = topics.find((t) => t.code === intent.topicCode);
    if (topic) {
      const matched = [{
        code: topic.code,
        title: topic.title,
        source_url: topic.source_url,
        source_name: topic.source_name,
      }];
      const answer = topic.title;
      const guidance = topic.summary || 'See the WHO source below for the full fact sheet.';
      const applicability = topic.applicability ?? 'General guidance.';
      const safety = topic.escalation_notes ?? 'Seek professional help if symptoms persist or worsen.';
      const citation = topic.citation ?? `${topic.source_name} — ${topic.title}. ${topic.source_url}`;
      const crisisRelated = intent.code === 'depression' || intent.code === 'mental_health_at_work';
      const reply =
        `${answer}\n\n${guidance}\n\nWhen to seek professional support\n${safety}\n\nSource\n${citation}` +
        (crisisRelated ? `\n\n${SUPPORT_NOTE}` : '');
      return {
        reply,
        matched,
        disclaimer: DISCLAIMER,
        intent: intent.code,
        structure: { answer, guidance, applicability, safety, source: { title: topic.title, citation, url: topic.source_url } },
        suggestion: null,
        showProfessional: crisisRelated,
      };
    }
  }

  // Keyword overlap with no clear intent — use registry retrieval if strong.
  const strongest = topicMatches.length > 0 ? topicMatches[0] : null;
  if (strongest && strongest.hits >= 2) {
    const t = strongest.topic;
    const safety = t.escalation_notes ?? 'Seek professional help if symptoms persist or worsen.';
    const citation = t.citation ?? `${t.source_name} — ${t.title}. ${t.source_url}`;
    const reply =
      `${t.title}\n\n${t.summary}\n\nWhen to seek professional support\n${safety}\n\nSource\n${citation}`;
    return {
      reply,
      matched: topicMatches.map((m) => ({ code: m.topic.code, title: m.topic.title, source_url: m.topic.source_url, source_name: m.topic.source_name })),
      disclaimer: DISCLAIMER,
      intent: null,
      structure: {
        answer: t.title,
        guidance: t.summary,
        applicability: t.applicability ?? 'General guidance.',
        safety,
        source: { title: t.title, citation, url: t.source_url },
      },
      suggestion: null,
      showProfessional: false,
    };
  }

  // No intent, no registry match — honest refusal, never improvisation.
  return {
    reply: NO_SOURCE_REFUSAL + ' You can also search WHO directly at who.int.',
    matched: [],
    disclaimer: DISCLAIMER,
    intent: intent?.code ?? null,
    structure: null,
    suggestion: null,
    showProfessional: true,
  };
}