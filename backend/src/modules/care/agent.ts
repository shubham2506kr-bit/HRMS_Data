// Care Agent — a sessionful conversational health information assistant.
//
// The agent is an explicit state machine with visible states:
//   GREETING -> UNDERSTAND -> CLARIFY -> RETRIEVE -> VALIDATE -> RESPOND
//              -> FOLLOW_UP -> ESCALATE -> CLOSE
// plus conversational STATES: GREETING, POSITIVE_WELLBEING, LOW_ENERGY,
// SLEEPINESS, STRESS, GENERAL_HEALTH, HEALTH_QUESTION, WOMENS_HEALTH,
// WORKDAY_RESET, PROFESSIONAL_SUPPORT, SAFETY, HIGH_RISK, UNKNOWN.
//
// Rules:
//  - Answer immediately when intent is clear (never clarify for clarity's sake).
//  - Ask at most ONE clarifying question, then continue.
//  - Recognize positive wellbeing states and reinforce them warmly.
//  - Substantive health guidance comes ONLY from approved WHO topics.
//  - Crisis/risk content is CONTEXT-TRIGGERED by the input, never default.
//  - Never uses work/performance signals for health advice.

import { dominantIntent, matchTopics, NO_SOURCE_REFUSAL, SUPPORT_NOTE, IntentCode, Topic } from './intents.js';
import {
  TRADITIONAL_LIBRARY,
  TraditionalKnowledgeItem,
  KnowledgeCategory,
  searchTraditionalLibrary,
  buildRoutineFor,
  assessHomeRemedy,
} from './traditional.js';

export type AgentPhase =
  | 'INITIAL'
  | 'UNDERSTAND'
  | 'CLARIFY'
  | 'RETRIEVE'
  | 'VALIDATE'
  | 'RESPOND'
  | 'FOLLOW_UP'
  | 'ESCALATE'
  | 'CLOSE';

export type AgentMode =
  | 'INFORMATION'
  | 'SELF_CARE'
  | 'WELLBEING'
  | 'CLARIFICATION'
  | 'PROFESSIONAL_SUPPORT'
  | 'URGENT_ROUTING';

export type AgentState =
  | 'GREETING'
  | 'POSITIVE_WELLBEING'
  | 'LOW_ENERGY'
  | 'SLEEPINESS'
  | 'STRESS'
  | 'GENERAL_HEALTH'
  | 'HEALTH_QUESTION'
  | 'WOMENS_HEALTH'
  | 'WORKDAY_RESET'
  | 'PROFESSIONAL_SUPPORT'
  | 'SAFETY'
  | 'HIGH_RISK'
  | 'UNKNOWN';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AgentChip {
  label: string;
  value: string;
}

export interface AgentTool {
  kind: 'openReset' | 'openWomenCare' | 'openProfessionalSupport' | 'openWHOArticle' | 'openCareResource';
  label: string;
  payload?: string;
}

export interface KnowledgeCard {
  title: string;
  category: string;
  tradition: string;
  source: string;
  source_type: string;
  source_url: string | null;
  evidence: string;
  safety: string;
  review_date: string;
  reviewer: string;
  interpretation: string;
}

export interface RoutineResult {
  name: string;
  steps: { title: string; detail: string; provenance: string }[];
}

// Care Intelligence — behavioral architecture (§2, §6, §13, §14, §47, §48).
// Every turn carries an explicit decision so the UI can respond to WHAT the
// person actually asked, not to a fixed feature taxonomy.
export type SpeechAct =
  | 'STATEMENT'
  | 'QUESTION'
  | 'REQUEST'
  | 'COMMAND'
  | 'EMOTIONAL_EXPRESSION'
  | 'INFORMATION_SHARING'
  | 'PROBLEM_REPORT'
  | 'GOAL'
  | 'SAFETY_SIGNAL'
  | 'GREETING';

export type ResponseMode =
  | 'ACKNOWLEDGE'
  | 'ANSWER'
  | 'ASK'
  | 'RECOMMEND'
  | 'GUIDE'
  | 'NAVIGATE'
  | 'WARN'
  | 'ESCALATE'
  | 'DO_NOTHING';

export interface AgentDecision {
  speechAct: SpeechAct;
  state: AgentState;
  intent: string | null;
  urgency: RiskLevel;
  confidence: number;
  requestedHelp: boolean;
  responseMode: ResponseMode;
  knowledgeSources: string[];
  recommendedActions: string[];
  escalation: 'NONE' | 'PROFESSIONAL' | 'CRISIS';
  conversationState: AgentPhase;
}

export interface AgentTurnResult {
  phase: AgentPhase;
  mode: AgentMode;
  state: AgentState;
  risk: RiskLevel;
  reply: string;
  chips: AgentChip[];
  tools: AgentTool[];
  structure: {
    answer: string;
    guidance: string;
    applicability: string;
    safety: string;
    source: { title: string; citation: string; url: string };
  } | null;
  intent: string | null;
  showProfessional: boolean;
  supportReason: string | null;
  turn: number;
  // Traditional-knowledge plane: provenance cards, routine steps and the
  // knowledge categories shown to the employee (never silently blended).
  knowledge?: KnowledgeCard[] | null;
  routine?: RoutineResult | null;
  knowledgeDomains?: KnowledgeCategory[] | string[];
  // The explicit behavioral decision for this turn (added in finish()).
  decision?: AgentDecision;
}

const CRISIS_PATTERNS: RegExp[] = [
  /\b(suicide|suicidal|kill myself|end my life|want to die|self[- ]harm|hurt myself|no reason to live)\b/i,
];

const URGENT_PATTERNS: RegExp[] = [/\b(severe pain|can.?t breathe|chest pain|bleeding heavily|passed out|fainted|faint|fainting|lightheaded)\b/i];

const POSITIVE_PATTERNS: RegExp[] = [
  /\b(i.?m|i am) (doing|feeling)? ?(okay|ok|good|great|well|fine|energetic|energized|energised|full of energy)\b/i,
  /\bhad a good day\b/i,
  /\b(keep|stay|maintain|improve|protect) (my )?(wellbeing|health|well.?being)\b/i,
  /\bwant to stay healthy\b/i,
  /\bfeel(ing)? (great|energized|energised|energetic|full of energy)\b/i,
];

const GREETING_PATTERNS: RegExp[] = [/\b^(hi|hello|hey|good (morning|afternoon|evening))\b/i];

const CLARIFICATION_QUESTIONS: Record<string, { question: string; options: AgentChip[]; resolve: Record<string, IntentCode> }> = {
  unwell: {
    question:
      "I'm sorry you're not feeling well. I can only help with general WHO-supported information — not diagnosis. " +
      'What are you experiencing most right now?',
    options: [
      { label: 'Fever', value: 'fever' },
      { label: 'Cough', value: 'cough' },
      { label: 'Stomach problem', value: 'stomach' },
      { label: 'Headache', value: 'headache' },
      { label: 'Very tired', value: 'very tired' },
      { label: 'Something else', value: 'something else' },
    ],
    resolve: {
      'very tired': 'sleep',
      tired: 'sleep',
      sleepy: 'sleep',
      headache: 'unwell',
      fever: 'unwell',
      cough: 'unwell',
      stomach: 'unwell',
      'something else': 'unwell',
    },
  },
  sleep: {
    question: 'Is that mostly physical tiredness, sleepiness, or difficulty concentrating?',
    options: [
      { label: 'Physical tiredness', value: 'physical tiredness' },
      { label: 'Sleepiness', value: 'sleepiness' },
      { label: 'Difficulty concentrating', value: 'concentrating' },
    ],
    resolve: {
      sleepiness: 'sleep',
      'physical tiredness': 'energy',
      tired: 'energy',
      concentrating: 'energy',
    },
  },
  homecare: {
    question: 'What kind of everyday discomfort are you thinking of? I can only offer general comfort measures — not treatments.',
    options: [
      { label: 'Mild tiredness', value: 'mild tiredness' },
      { label: 'Mild headache', value: 'mild headache' },
      { label: 'Stuffy nose / mild cold', value: 'mild cold' },
      { label: 'Something else', value: 'something else' },
    ],
    resolve: {
      'mild tiredness': 'homecare',
      'mild headache': 'homecare',
      'mild cold': 'homecare',
      'something else': 'homecare',
    },
  },
};

const stateOfIntent = (intent: IntentCode | string | null, message: string, risk: RiskLevel): AgentState => {
  if (risk === 'CRITICAL' || risk === 'HIGH') return 'HIGH_RISK';
  if (POSITIVE_PATTERNS.some((re) => re.test(message))) return 'POSITIVE_WELLBEING';
  if (GREETING_PATTERNS.some((re) => re.test(message))) return 'GREETING';
  switch (intent) {
    case 'sleep': return /\b(sleepy|drowsy|sleep|insomnia|rest|fall\s*asleep|can.?t\s*stay\s*awake|exhaust(ed|ion|ing)|drained|all\s*night|night\s*shift)\b/i.test(message) ? 'SLEEPINESS' : 'LOW_ENERGY';
    case 'energy': return 'LOW_ENERGY';
    case 'stress':
    case 'mental_health_at_work': return 'STRESS';
    case 'unwell': return 'GENERAL_HEALTH';
    case 'professional': return 'PROFESSIONAL_SUPPORT';
    case 'reset': return 'WORKDAY_RESET';
    case 'women': return 'WOMENS_HEALTH';
    case 'safety': return 'SAFETY';
    default: return 'UNKNOWN';
  }
};

export class CareSession {
  personId: string;
  lastUsed = Date.now();
  personName: string | null = null;
  intent: IntentCode | null = null;
  pendingClarify: string | null = null;
  pendingResolve: Record<string, IntentCode> = {};
  lastChoice: IntentCode | string | null = null;
  currentTopic: Topic | null = null;
  offeredReset = false;
  turn = 0;
  history: { speaker: 'user' | 'agent'; text: string }[] = [];

  constructor(personId: string) {
    this.personId = personId;
  }

  reset(): void {
    this.intent = null;
    this.pendingClarify = null;
    this.pendingResolve = {};
    this.lastChoice = null;
    this.currentTopic = null;
    this.offeredReset = false;
    this.turn = 0;
    this.history = [];
  }
}

function chipsFor(options: AgentChip[]): AgentChip[] {
  return options;
}

// ---------------------------------------------------------------------------
// Speech-act + intent classification for the decision object.
// The engine reasons about WHAT the person is doing with language BEFORE it
// decides how to respond (§2, §6, §13, §14, §47).

function classifySpeechAct(message: string): SpeechAct {
  const m = message.toLowerCase();
  if (CRISIS_PATTERNS.some((re) => re.test(m)) || URGENT_PATTERNS.some((re) => re.test(m))) return 'SAFETY_SIGNAL';
  if (GREETING_PATTERNS.some((re) => re.test(m))) return 'GREETING';
  if (/\b(i feel sick|i have a (cold|cough|fever|headache)|not feeling well|not well|unwell|feel ill|symptoms?|hurt(ing|s)?|pain)\b/.test(m)) return 'PROBLEM_REPORT';
  if (/\?\s*$/.test(message) || /^(how|what|why|when|where|which|who|can|could|should|would|is there|are there|do you|does|is it)\b/.test(m)) return 'QUESTION';
  if (/\b(give me|show me|tell me|help me|i want|i need|i would like|let me|build me|start|create|make|offer|send)\b/.test(m)) return 'REQUEST';
  if (/\b(i.?m|i am|i have been|feel(ing)?|got|had|felt)\b/.test(m)) return 'EMOTIONAL_EXPRESSION';
  if (/\b(today|yesterday|this week|this morning|tonight|right now|now|at work)\b/.test(m)) return 'INFORMATION_SHARING';
  return 'STATEMENT';
}

function detectRequest(message: string): boolean {
  const m = message.toLowerCase();
  if (/\?\s*$/.test(message)) return true;
  if (/\b(help me|give me|show me|tell me|can you|could you|would you|do you|i want|i need|i would like|any tips|a few|some tips|is there|are there)\b/.test(m)) return true;
  if (/\b(what should|how can|how do|how should|what can|should i|can i|what should i)\b/.test(m)) return true;
  if (/\b(keep|maintain|stay|protect|improve|build|strengthen|focus|prioritize|do for)\b/.test(m)) return true;
  return false;
}

function decide(message: string, r: AgentTurnResult): AgentDecision {
  const speechAct = classifySpeechAct(message);
  const requested = detectRequest(message);
  let responseMode: ResponseMode;
  if (r.mode === 'URGENT_ROUTING') {
    responseMode = r.risk === 'CRITICAL' ? 'ESCALATE' : 'WARN';
  } else if (r.mode === 'PROFESSIONAL_SUPPORT') {
    responseMode = 'NAVIGATE';
  } else if (r.mode === 'CLARIFICATION') {
    responseMode = 'ASK';
  } else if (r.state === 'POSITIVE_WELLBEING' && !requested && !(r.chips?.length || r.tools?.length)) {
    responseMode = 'ACKNOWLEDGE';
  } else {
    const asks = /\?\s*$/.test(r.reply.trim());
    if (asks && (r.chips?.length || r.tools?.length)) responseMode = 'ASK';
    else if (r.chips?.length || r.tools?.length) responseMode = 'RECOMMEND';
    else responseMode = 'ANSWER';
  }
  const recommendedActions = [...(r.tools ?? []).map((t) => t.label), ...(r.chips ?? []).map((c) => c.label)].slice(0, 3);
  const escalation = r.risk === 'CRITICAL' ? 'CRISIS' : r.showProfessional ? 'PROFESSIONAL' : 'NONE';
  const hasEvidence = Boolean(r.structure) || (r.knowledge && r.knowledge.length > 0);
  return {
    speechAct,
    state: r.state,
    intent: r.intent,
    urgency: r.risk,
    confidence: hasEvidence ? 0.9 : r.mode === 'CLARIFICATION' ? 0.55 : 0.75,
    requestedHelp: requested,
    responseMode,
    knowledgeSources: [...(r.knowledgeDomains ?? [])],
    recommendedActions,
    escalation,
    conversationState: r.phase,
  };
}

export function buildTurn(
  message: string,
  session: CareSession,
  topics: Topic[],
  traditional: TraditionalKnowledgeItem[] = TRADITIONAL_LIBRARY
): AgentTurnResult {
  session.turn += 1;
  session.history.push({ speaker: 'user', text: message });

  // 1) Risk classifier — crisis content is only triggered by real high-risk input.
  const crisis = CRISIS_PATTERNS.some((re) => re.test(message));
  const urgent = URGENT_PATTERNS.some((re) => re.test(message));

  if (crisis) {
    session.reset();
    session.history.push({ speaker: 'user', text: message });
    session.turn = 1;
    return finish(session, message, {
      phase: 'ESCALATE',
      mode: 'URGENT_ROUTING',
      state: 'HIGH_RISK',
      risk: 'CRITICAL',
      reply: SUPPORT_NOTE + ' You deserve immediate, real human support. Please contact local emergency services or a crisis line now.',
      chips: [],
      tools: [{ kind: 'openProfessionalSupport', label: 'Show professional support' }],
      structure: null,
      intent: 'depression',
      showProfessional: true,
      supportReason: 'A genuine high-risk message was detected — safety routing is active.',
      turn: session.turn,
    });
  }

  if (urgent) {
    return finish(session, message, {
      phase: 'ESCALATE',
      mode: 'URGENT_ROUTING',
      state: 'HIGH_RISK',
      risk: 'HIGH',
      reply: 'If you are experiencing a medical emergency, please call your local emergency number or go to the nearest emergency department now. Do not wait.',
      chips: [],
      tools: [{ kind: 'openProfessionalSupport', label: 'Show professional support' }],
      structure: null,
      intent: 'unwell',
      showProfessional: true,
      supportReason: 'Urgent medical language was detected in your message.',
      turn: session.turn,
    });
  }

  // 2) Greeting (only on the first turn).
  if (GREETING_PATTERNS.some((re) => re.test(message)) && session.turn === 1) {
    const name = session.personName ? `, ${session.personName}` : '';
    return finish(session, message, {
      phase: 'RESPOND',
      mode: 'WELLBEING',
      state: 'GREETING',
      risk: 'LOW',
      reply: `Hello${name}. How are you doing today?`,
      chips: [
        { label: "I'm doing well", value: "I'm doing well." },
        { label: "I'm energized", value: "I'm energized." },
        { label: "I'm tired", value: "I'm tired" },
        { label: "I'm sleepy", value: "I'm sleepy" },
        { label: "I'm stressed", value: "I have been feeling stressed lately" },
        { label: "I'm low on energy", value: "I'm low on energy" },
        { label: 'I need a reset', value: 'I need a reset' },
      ],
      tools: [],
      structure: null,
      intent: 'none',
      showProfessional: false,
      supportReason: null,
      turn: session.turn,
    });
  }

  // 3) Continue a pending clarification (one question max).
  if (session.pendingClarify) {
    session.history.push({ speaker: 'agent', text: session.pendingClarify });
    const resolved = session.pendingResolve[message.trim().toLowerCase()];
    const key = session.pendingClarify;
    session.pendingClarify = null;
    session.pendingResolve = {};
    if (resolved) {
      session.intent = resolved;
      session.lastChoice = message.trim().toLowerCase();
      if (resolved === 'unwell') {
        return finish(session, message, refuseUnwell(session));
      }
      if (key === 'unwell' && resolved === 'sleep') {
        const q = CLARIFICATION_QUESTIONS['sleep']!;
        session.pendingClarify = q.question;
        session.pendingResolve = q.resolve;
        return finish(session, message, {
          phase: 'CLARIFY',
          mode: 'CLARIFICATION',
          state: 'LOW_ENERGY',
          risk: 'LOW',
          reply: q.question,
          chips: chipsFor(q.options),
          tools: [],
          structure: null,
          intent: 'sleep',
          showProfessional: false,
          supportReason: null,
          turn: session.turn,
        });
      }
      return finish(session, message, proceed(message, session, topics, traditional));
    }
    const fallback = key === 'unwell' ? 'unwell' : (CLARIFICATION_QUESTIONS as Record<string, { resolve: Record<string, IntentCode> }>)[key]?.resolve['something else'] ?? null;
    session.intent = fallback;
    if (key === 'unwell' || session.intent === 'unwell') {
      return finish(session, message, refuseUnwell(session));
    }
    return finish(session, message, proceed(message, session, topics, traditional));
  }

  // 4) Positive wellbeing state — recognized at ANY turn (not just turn 1),
  // so "I'm doing well" in the middle of a conversation still gets a direct,
  // warm answer instead of a refusal.
  if (POSITIVE_PATTERNS.some((re) => re.test(message))) {
    session.intent = 'physical_activity';
    return finish(session, message, respondPositive(message, session, topics));
  }

  // 5) Intent understanding.
  session.intent = dominantIntent(message)?.code ?? null;
  return finish(session, message, proceed(message, session, topics, traditional));
}

function finish(session: CareSession, message: string, result: AgentTurnResult): AgentTurnResult {
  session.history.push({ speaker: 'agent', text: result.reply });
  result.knowledge = result.knowledge ?? null;
  result.routine = result.routine ?? null;
  result.knowledgeDomains = result.knowledgeDomains ?? [];
  result.decision = decide(message, result);
  return result;
}

function proceed(message: string, session: CareSession, topics: Topic[], traditional: TraditionalKnowledgeItem[] = TRADITIONAL_LIBRARY): AgentTurnResult {
  const intent = session.intent;

  // "What should I do now?" — three options, never twenty.
  if (/\bwhat should i do now\b/i.test(message)) {
    return whatNow(session);
  }

  // Traditional-knowledge plane (answered before WHO intents).
  if (intent === 'vedic') return vedicFlow(message, session, traditional);
  if (intent === 'traditional') return traditionalFlow(message, session, traditional);
  if (intent === 'routine') return routineFlow(message, session, traditional);
  if (intent === 'homecare') return homecareFlow(message, session, traditional);
  if (intent === 'medication') return medicationFlow(session);
  if (intent === 'pregnancy') return pregnancyFlow(session);
  if (intent === 'women') return womenFlow(session);

  // Stress is a normal state, not a default professional-support event (§40).
  // Only explicit requests for information or genuinely severe language route
  // to the WHO mental-health guidance; everything else gets validation + a reset.
  if (intent === 'mental_health_at_work') {
    return stressFlow(message, session, topics);
  }

  if (intent === 'professional') {
    return {
      phase: 'RESPOND',
      mode: 'PROFESSIONAL_SUPPORT',
      state: 'PROFESSIONAL_SUPPORT',
      risk: 'LOW',
      reply:
        'Speaking with a professional is always a reasonable step. Your regular doctor, a mental health professional, ' +
        "or your workplace's support channel are good places to start.",
      chips: [{ label: 'Show professional support', value: 'professional' }],
      tools: [{ kind: 'openProfessionalSupport', label: 'Open support resources' }],
      structure: null,
      intent: 'professional',
      showProfessional: true,
      supportReason: 'You asked about professional support.',
      turn: session.turn,
    };
  }

  if (intent === 'reset') {
    session.offeredReset = true;
    return {
      phase: 'FOLLOW_UP',
      mode: 'SELF_CARE',
      state: 'WORKDAY_RESET',
      risk: 'LOW',
      reply: 'A short reset is a practical way to step back. Which one would you like right now?',
      chips: [
        { label: '30 seconds', value: 'reset 30' },
        { label: '2 minutes', value: 'reset 120' },
        { label: '5 minutes', value: 'reset 300' },
      ],
      tools: [{ kind: 'openReset', label: 'Start a guided reset' }],
      structure: null,
      intent: 'reset',
      showProfessional: false,
      supportReason: null,
      turn: session.turn,
    };
  }

  if (intent === 'unwell') {
    const q = CLARIFICATION_QUESTIONS['unwell']!;
    session.pendingClarify = q.question;
    session.pendingResolve = q.resolve;
    return {
      phase: 'CLARIFY',
      mode: 'CLARIFICATION',
      state: 'GENERAL_HEALTH',
      risk: 'LOW',
      reply: q.question,
      chips: chipsFor(q.options),
      tools: [],
      structure: null,
      intent: 'unwell',
      showProfessional: false,
      supportReason: null,
      turn: session.turn,
    };
  }

  if (intent === 'sleep') {
    // A clear question about sleep answers immediately — no clarification loop.
    const isQuestion = /\b(how|what|why|can|should|help)\b/i.test(message) && /\b(sleep|insomnia|rest)\b/i.test(message);
    const sleepyStatement =
      /\b(i.?m|i am|feel|feeling|getting)\b.*\b(sleepy|drowsy)\b/i.test(message) ||
      /\b(can.?t\s*stay\s*awake|fall(ing)?\s*asleep|nodding\s*off)\b/i.test(message);
    if (isQuestion) {
      return respondGrounded('sleep', message, session, topics);
    }
    // Explicit exhaustion answers directly — never performance-based advice.
    if (/\bexhaust(ed|ion|ing)\b|\bdrained\b|\ball night\b|\bnight shift\b|\bcan.?t keep (my )?eyes open\b/i.test(message)) {
      return respondGrounded('sleep', message, session, topics);
    }
    const choice = session.lastChoice;
    session.lastChoice = null;
    if (choice === 'physical tiredness') {
      return respondGrounded('energy', message, session, topics);
    }
    if (sleepyStatement || choice === 'sleepiness') {
      if (!session.offeredReset) {
        session.offeredReset = true;
        return {
          phase: 'FOLLOW_UP',
          mode: 'SELF_CARE',
          state: 'SLEEPINESS',
          risk: 'LOW',
          reply: 'Feeling sleepy is common — especially in the afternoon. Would you like a short reset you can do right now, or general WHO-supported sleep guidance?',
          chips: [
            { label: 'Short reset now', value: 'reset' },
            { label: 'Sleep guidance', value: 'how can I sleep better?' },
          ],
          tools: [{ kind: 'openReset', label: 'Start a quick reset' }],
          structure: null,
          intent: 'sleep',
          showProfessional: false,
          supportReason: null,
          turn: session.turn,
        };
      }
      return respondGrounded('sleep', message, session, topics);
    }
    // After a sleepy reset offer, accepting sleep guidance answers immediately.
    if (session.offeredReset && /\b(sleep|insomnia|rest|guidance|yes|sure|ok(ay)?|yep|tell me)\b/i.test(message)) {
      return respondGrounded('sleep', message, session, topics);
    }
    // Vague tiredness: exactly one clarifying question, then continue.
    const q = CLARIFICATION_QUESTIONS['sleep']!;
    session.pendingClarify = q.question;
    session.pendingResolve = q.resolve;
    return {
      phase: 'CLARIFY',
      mode: 'CLARIFICATION',
      state: 'LOW_ENERGY',
      risk: 'LOW',
      reply: q.question,
      chips: chipsFor(q.options),
      tools: [],
      structure: null,
      intent: 'sleep',
      showProfessional: false,
      supportReason: null,
      turn: session.turn,
    };
  }

  if (intent === 'energy') {
    // Explicit low-energy statements answer directly; only vague "tired" gets one question.
    const explicit = /\blow on energy\b|\bno energy\b|\bdrained\b|\bexhausted\b|\btired\b.*\b(days|week|weeks)\b|\bcannot focus\b|\bcan.?t focus\b|\bdifficulty concentrating\b|\bconcentration\b/i.test(message);
    if (explicit || session.lastChoice === 'concentrating' || session.turn > 1) {
      return respondGrounded('energy', message, session, topics);
    }
    const q = CLARIFICATION_QUESTIONS['sleep']!;
    session.pendingClarify = q.question;
    session.pendingResolve = q.resolve;
    return {
      phase: 'CLARIFY',
      mode: 'CLARIFICATION',
      state: 'LOW_ENERGY',
      risk: 'LOW',
      reply: q.question,
      chips: chipsFor(q.options),
      tools: [],
      structure: null,
      intent: 'energy',
      showProfessional: false,
      supportReason: null,
      turn: session.turn,
    };
  }

  if (intent && intent !== 'none') {
    return respondGrounded(intent, message, session, topics);
  }

  // No intent matched — try semantic topic retrieval.
  const topicMatches = matchTopics(message, topics);
  const strongest = topicMatches[0];
  if (strongest && strongest.hits >= 2) {
    session.currentTopic = strongest.topic;
    return respondGrounded('ncd', message, session, topics);
  }

  return refuseGeneric(session);
}

// Positive wellbeing maintenance — grounded in approved WHO topics.
// Behavioral architecture (§7–§10, §36, §38, §39):
//  - A pure positive STATEMENT gets acknowledged and nothing else. No advice,
//    no chips, no tools, no structure. The UI stays quiet.
//  - A positive statement WITH an explicit question gets answered.
function respondPositive(message: string, session: CareSession, topics: Topic[]): AgentTurnResult {
  const byCode = new Map(topics.map((t) => [t.code, t]));
  const sleep = byCode.get('sleep') ?? null;
  const activity = byCode.get('physical-activity') ?? null;
  const diet = byCode.get('healthy-diet') ?? null;
  const mental = byCode.get('mental-health-at-work') ?? null;
  const name = session.personName ? `, ${session.personName}` : '';
  const sources: string[] = [sleep, activity, diet, mental].filter(Boolean).map((t) => `${t!.source_name} — ${t!.title}.`);

  const enthusiastic = /\bfeel(ing)? (great|energized|energised|energetic|full of energy)\b|\b(energized|energised|energetic|full of energy)\b/i.test(message);
  const goodDay = /\b(good day|great day|had a good day)\b/i.test(message);
  const ack = goodDay ? 'A day worth keeping' : enthusiastic ? 'That is great to hear' : 'That is good to hear';

  // 1) Pure statement of a positive state — ACKNOWLEDGE only. No advice.
  if (!detectRequest(message)) {
    return {
      phase: 'RESPOND',
      mode: 'WELLBEING',
      state: 'POSITIVE_WELLBEING',
      risk: 'LOW',
      reply: `${ack}${name}.`,
      chips: [],
      tools: [],
      structure: null,
      intent: 'physical_activity',
      showProfessional: false,
      supportReason: null,
      turn: session.turn,
      knowledge: null,
      knowledgeDomains: [],
    };
  }

  // 2) Wellbeing-maintenance question ("How can I keep my wellbeing strong?")
  const maintenance = /\b(keep|maintain|stay|protect|improve|strong|wellbeing|healthy)\b/i.test(message);
  if (maintenance) {
    const bullets = [
      sleep ? `protect regular sleep — ${sleep.summary.split('.')[0]}` : 'protect regular sleep',
      activity ? `include some movement — ${activity.summary.split('.')[0]}` : 'include some movement',
      'take short recovery pauses during the day',
      diet ? `stay hydrated and eat well — ${diet.summary.split('.')[0]}` : 'stay hydrated and eat well',
    ];
    return {
      phase: 'RESPOND',
      mode: 'WELLBEING',
      state: 'POSITIVE_WELLBEING',
      risk: 'LOW',
      reply:
        `${ack}${name}. You can keep it going with a few simple habits:\n\n` +
        bullets.map((b) => `• ${b}`).join('\n') +
        '\n\nI can turn this into a simple wellbeing routine for your workday — or leave it light and just enjoy the good stretch.',
      chips: [
        { label: 'Build my routine', value: 'help me build a wellbeing routine' },
        { label: '2-minute reset', value: 'I need a reset' },
        { label: 'Tell me more', value: 'What does a good wellbeing routine look like?' },
        { label: 'Not now', value: "I'm okay" },
      ],
      tools: [{ kind: 'openReset', label: 'Start a 2-minute reset' }],
      structure: (sleep || activity || diet || mental)
        ? {
            answer: 'WHO-supported habits for maintaining wellbeing',
            guidance: bullets.join('\n'),
            applicability: 'Everyday wellbeing maintenance for adults.',
            safety: 'If you notice persistent low mood, poor sleep or loss of enjoyment, speak with a healthcare professional.',
            source: {
              title: (mental ?? sleep ?? activity ?? diet)!.title,
              citation: sources.join(' '),
              url: (mental ?? sleep ?? activity ?? diet)!.source_url,
            },
          }
        : null,
      intent: 'physical_activity',
      showProfessional: false,
      supportReason: null,
      turn: session.turn,
      knowledge: null,
      knowledgeDomains: ['WHO EVIDENCE'],
    };
  }

  // 3) Focus question ("What should I focus on?") — answer the actual question,
  //    not health advice (§10). A quiet answer, no catalogue.
  return {
    phase: 'RESPOND',
    mode: 'WELLBEING',
    state: 'POSITIVE_WELLBEING',
    risk: 'LOW',
    reply:
      `${ack}${name}. With energy to spare, the most useful move is usually to point it at your highest-value work — the task that moves things forward most. ` +
      'You could also use it for learning something new, or finally clearing something you have been putting off. ' +
      'Whatever you choose, protect a little recovery later.',
    chips: [],
    tools: [],
    structure: null,
    intent: 'physical_activity',
    showProfessional: false,
    supportReason: null,
    turn: session.turn,
    knowledge: null,
    knowledgeDomains: [],
  };
}

function stressFlow(message: string, session: CareSession, topics: Topic[]): AgentTurnResult {
  const severe =
    /\b(panic|can.?t cope|can.?t take (it|this|anymore|this anymore)|breaking down|falling apart|unbearable|desperate|worthless|hopeless|empty|can.?t go on)\b/i.test(message) ||
    /\b(depress(ed|ion)?|suicid|self.?harm)\b/i.test(message);
  const seekingInfo = /\b(what helps|how (do|can|should)|tell me more|more about|guidance|info(rmation)?|help with)\b/i.test(message);
  if (severe || seekingInfo) {
    return respondGrounded('mental_health_at_work', message, session, topics);
  }
  return {
    phase: 'RESPOND',
    mode: 'WELLBEING',
    state: 'STRESS',
    risk: 'LOW',
    reply:
      'Stress is a normal response to pressure — it does not mean something is wrong with you. ' +
      'When it builds up, a short pause and one honest step usually help it sit lighter.\n\n' +
      'Would you like to try a quick 2-minute reset to step back?',
    chips: [
      { label: '2-minute reset', value: 'I need a reset' },
      { label: 'Tell me more', value: 'What helps when stress builds up?' },
      { label: 'Not now', value: "I'm okay" },
    ],
    tools: [{ kind: 'openReset', label: 'Start a 2-minute reset' }],
    structure: null,
    intent: 'mental_health_at_work',
    showProfessional: false,
    supportReason: null,
    turn: session.turn,
    knowledge: null,
    knowledgeDomains: ['GENERAL WELLBEING'],
  };
}

function womenFlow(session: CareSession): AgentTurnResult {
  return {
    phase: 'RESPOND',
    mode: 'SELF_CARE',
    state: 'WOMENS_HEALTH',
    risk: 'LOW',
    reply:
      'I can open the private Women\u2019s care space for you. It collects WHO public resources — nothing about you is stored. ' +
      'Consent is optional and fully reversible.',
    chips: [{ label: 'Open Women\u2019s care', value: 'women' }],
    tools: [{ kind: 'openWomenCare', label: 'Open Women\u2019s care' }],
    structure: null,
    intent: 'women',
    showProfessional: false,
    supportReason: null,
    turn: session.turn,
    knowledge: null,
    knowledgeDomains: [],
  };
}

function respondGrounded(intent: IntentCode, message: string, session: CareSession, topics: Topic[]): AgentTurnResult {
  const topicCode: Record<string, string> = {
    sleep: 'sleep',
    energy: 'physical-activity',
    physical_activity: 'physical-activity',
    mental_health_at_work: 'mental-health-at-work',
    depression: 'depression',
    alcohol: 'alcohol',
    diet: 'healthy-diet',
    ncd: 'ncds',
  };
  const code = topicCode[intent];
  const topic = topics.find((t) => t.code === code) ?? null;
  if (!topic) {
    return refuseGeneric(session);
  }
  session.currentTopic = topic;
  const crisisRelated = intent === 'depression' || intent === 'mental_health_at_work';
  const safety = topic.escalation_notes ?? 'Seek professional help if symptoms persist or worsen.';
  const citation = topic.citation ?? `${topic.source_name} — ${topic.title}. ${topic.source_url}`;
  const applicability = topic.applicability ?? 'General guidance.';
  const risk: RiskLevel = crisisRelated ? 'MEDIUM' : 'LOW';

  const chips: AgentChip[] = [];
  const tools: AgentTool[] = [];
  if (!session.offeredReset && (intent === 'sleep' || intent === 'energy')) {
    chips.push({ label: 'Short reset', value: 'reset' });
    tools.push({ kind: 'openReset', label: 'Start a guided reset' });
    session.offeredReset = true;
  }
  chips.push({ label: 'More WHO guidance', value: 'more about ' + topic.title });
  tools.push({
    kind: 'openWHOArticle',
    label: 'Open WHO source',
    payload: topic.source_url,
  });

  const offer = (intent === 'sleep' || intent === 'energy')
    ? '\n\nI can also build this into a simple routine for your day — just ask.'
    : '';

  return {
    phase: 'RESPOND',
    mode: crisisRelated ? 'WELLBEING' : 'INFORMATION',
    state: stateOfIntent(intent, message, risk),
    risk,
    reply: `${topic.title}\n\n${topic.summary}\n\nWhen to seek professional support\n${safety}\n\nSource\n${citation}${offer}`,
    chips,
    tools,
    structure: {
      answer: topic.title,
      guidance: topic.summary,
      applicability,
      safety,
      source: { title: topic.title, citation, url: topic.source_url },
    },
    intent,
    showProfessional: crisisRelated,
    supportReason: crisisRelated ? 'WHO guidance marks this topic as one where professional support may be relevant.' : null,
    turn: session.turn,
  };
}

function refuseUnwell(session: CareSession): AgentTurnResult {
  return {
    phase: 'ESCALATE',
    mode: 'PROFESSIONAL_SUPPORT',
    state: 'GENERAL_HEALTH',
    risk: 'MEDIUM',
    reply:
      NO_SOURCE_REFUSAL +
      ' I understand you feel unwell. Please contact a healthcare professional for an assessment of your symptoms — and if it is urgent, do not wait.',
    chips: [{ label: 'Show professional support', value: 'professional' }],
    tools: [{ kind: 'openProfessionalSupport', label: 'Open support resources' }],
    structure: null,
    intent: 'unwell',
    showProfessional: true,
    supportReason: 'There is no approved WHO-backed answer for these symptoms — professional care navigation is appropriate.',
    turn: session.turn,
  };
}

function refuseGeneric(session: CareSession): AgentTurnResult {
  return {
    phase: 'VALIDATE',
    mode: 'CLARIFICATION',
    state: 'UNKNOWN',
    risk: 'LOW',
    reply:
      NO_SOURCE_REFUSAL +
      ' You can also browse health topics directly on who.int — or ask me about sleep, energy, stress, or physical activity.',
    chips: [
      { label: 'Sleep', value: 'I need help with sleep' },
      { label: 'Energy', value: 'I feel low on energy' },
      { label: 'Stress', value: 'I feel stressed' },
      { label: 'Physical activity', value: 'I want to be more active' },
    ],
    tools: [{ kind: 'openProfessionalSupport', label: 'Professional support' }],
    structure: null,
    intent: session.intent,
    showProfessional: true,
    supportReason: 'No approved WHO-backed answer exists for this topic — professional care navigation may help.',
    turn: session.turn,
  };
}

// Convenience: single-turn wrapper (used by tests and the simple endpoint).
export function agentTurn(message: string, personId: string, topics: Topic[]): AgentTurnResult {
  const session = new CareSession(personId);
  return buildTurn(message, session, topics);
}

// --- Traditional knowledge plane -------------------------------------------
// Every employee-facing answer is labelled with its knowledge category.
// Traditional knowledge is NEVER silently blended with WHO guidance.

function toKnowledgeCards(items: TraditionalKnowledgeItem[]): KnowledgeCard[] {
  return items.map((i) => ({
    title: i.title,
    category: i.category,
    tradition: i.tradition,
    source: i.source,
    source_type: i.source_type,
    source_url: i.source_url,
    evidence: i.evidence_level,
    safety: i.safety_level,
    review_date: i.review_date,
    reviewer: i.reviewer,
    interpretation: i.interpretation,
  }));
}

function traditionalFlow(message: string, session: CareSession, traditional: TraditionalKnowledgeItem[]): AgentTurnResult {
  const byId = new Map(traditional.map((i) => [i.knowledge_id, i]));

  // Routine requests inside the traditional plane answer with steps + provenance.
  if (/\bmorning routine\b|\bmorning rhythm\b|\bmorning practice\b/i.test(message)) {
    const routine = buildRoutineFor('morning');
    const cards = [byId.get('trad-morning-routine')].filter(Boolean) as TraditionalKnowledgeItem[];
    return {
      phase: 'RESPOND',
      mode: 'WELLBEING',
      state: 'GENERAL_HEALTH',
      risk: 'LOW',
      reply:
        'Here is a simple traditional-inspired morning routine. I am keeping historical and traditional practices separate from modern health guidance:\n\n' +
        routine.steps.map((s) => `• ${s.title} — ${s.provenance === 'WHO EVIDENCE' ? 'WHO guidance' : s.provenance === 'TRADITIONAL PRACTICE' ? 'traditional practice' : 'general wellbeing'}`).join('\n') +
        '\n\nThese are traditional and wellbeing practices — not a treatment for any condition.' +
        '\n\nWHO health guidance also emphasizes regular sleep, movement and a balanced breakfast — the two knowledge planes are complementary, not the same.',
      chips: [
        { label: 'Build it into my routine', value: 'help me build a wellbeing routine' },
        { label: 'Explore traditional options', value: 'Show me traditional options' },
        { label: '2-minute reset', value: 'I need a reset' },
      ],
      tools: [{ kind: 'openReset', label: 'Start a 5-minute reset' }],
      structure: null,
      intent: 'traditional',
      showProfessional: false,
      supportReason: null,
      turn: session.turn,
      knowledge: toKnowledgeCards(cards),
      routine: { name: routine.name, steps: routine.steps },
      knowledgeDomains: ['TRADITIONAL PRACTICE', 'WHO EVIDENCE'],
    };
  }

  if (/\bevening routine\b|\bwind.?down\b|\bevening practice\b|\bafter work\b/i.test(message)) {
    const routine = buildRoutineFor('evening');
    const cards = [byId.get('trad-evening-winddown')].filter(Boolean) as TraditionalKnowledgeItem[];
    return {
      phase: 'RESPOND',
      mode: 'WELLBEING',
      state: 'GENERAL_HEALTH',
      risk: 'LOW',
      reply:
        'A traditional-style evening wind-down could look like this — with each step labelled by its knowledge source:\n\n' +
        routine.steps.map((s) => `• ${s.title} — ${s.provenance === 'WHO EVIDENCE' ? 'WHO guidance' : s.provenance === 'TRADITIONAL PRACTICE' ? 'traditional practice' : 'general wellbeing'}`).join('\n') +
        '\n\nThese are traditional and wellbeing practices, not a treatment for a diagnosed condition.' +
        '\n\nWHO health guidance also supports consistent wind-down routines for good sleep.',
      chips: [
        { label: 'Build it into my routine', value: 'help me build a wellbeing routine' },
        { label: 'Explore traditional options', value: 'Show me traditional options' },
      ],
      tools: [{ kind: 'openReset', label: 'Start a 5-minute reset' }],
      structure: null,
      intent: 'traditional',
      showProfessional: false,
      supportReason: null,
      turn: session.turn,
      knowledge: toKnowledgeCards(cards),
      routine: { name: routine.name, steps: routine.steps },
      knowledgeDomains: ['TRADITIONAL PRACTICE', 'WHO EVIDENCE'],
    };
  }

  const matched = searchTraditionalLibrary(message, traditional);
  // Title-only strays are not real matches: a vague traditional request gets
  // the curated categories answer, never arbitrary records.
  const keywordCards = matched.filter((m) => m.keywordHits > 0);
  const cards = keywordCards.length > 0 ? keywordCards.map((m) => m.item) : [];
  const domains = Array.from(new Set(cards.map((c) => c.category)));

  if (cards.length === 0) {
    // Governed fallback: categories, never fabricated specifics.
    return {
      phase: 'RESPOND',
      mode: 'WELLBEING',
      state: 'GENERAL_HEALTH',
      risk: 'LOW',
      reply:
        'You can explore a few traditional practices commonly used for wellbeing:\n\n' +
        '• Gentle yoga — yoga tradition (traditional practice)\n' +
        '• Breathing practice — yoga tradition (traditional practice)\n' +
        '• Meditation — yoga tradition (traditional practice)\n' +
        '• A quiet evening routine — household tradition (traditional practice)\n\n' +
        'These are traditional and wellbeing practices — not a treatment for any condition. Every traditional claim HumanOS makes carries a source and a tradition label.\n\n' +
        'WHO health guidance also emphasizes healthy routines, sleep and supportive self-care — the two are complementary, not the same.\n\n' +
        'Which of these would you like to explore?',
      chips: [
        { label: 'Start 5-minute reset', value: 'I need a reset' },
        { label: 'Explore yoga', value: 'Tell me about traditional yoga' },
        { label: 'Explore meditation', value: 'Tell me about traditional meditation' },
        { label: 'Build a routine', value: 'help me build a wellbeing routine' },
      ],
      tools: [{ kind: 'openReset', label: 'Start a 5-minute reset' }],
      structure: null,
      intent: 'traditional',
      showProfessional: false,
      supportReason: null,
      turn: session.turn,
      knowledge: toKnowledgeCards([byId.get('official-ayush'), byId.get('who-tm-strategy')].filter(Boolean) as TraditionalKnowledgeItem[]),
      knowledgeDomains: ['MODERN AYUSH GUIDANCE', 'WHO EVIDENCE'],
    };
  }

  const topic = /\b(relax|calm|unwind|stress|sleep|energy)\b/i.test(message)
    ? 'relaxation and wellbeing'
    : 'everyday wellbeing';
  return {
    phase: 'RESPOND',
    mode: 'WELLBEING',
    state: 'GENERAL_HEALTH',
    risk: 'LOW',
    reply:
      `You can explore a few traditional practices commonly used for ${topic}:\n\n` +
      cards.map((c) => `• ${c.title.replace(/^(Gentle |Sitting |Alternate-nostril |Quiet |Daily rhythm \(Dinacharya\) — )/, '')} — ${c.tradition} (${c.category})`).join('\n') +
      '\n\nThese are traditional and wellbeing practices, not a treatment for a diagnosed condition. ' +
      'Traditional knowledge is presented with its own provenance and never blended with modern health guidance.\n\n' +
      'WHO health guidance also emphasizes healthy routines, sleep and supportive self-care — the two are complementary, not the same.',
    chips: [
      { label: 'Start 5-minute reset', value: 'I need a reset' },
      { label: 'Explore yoga', value: 'Tell me about traditional yoga' },
      { label: 'Explore meditation', value: 'Tell me about traditional meditation' },
      { label: 'Why am I seeing this?', value: 'Show me traditional options' },
    ],
    tools: [{ kind: 'openReset', label: 'Start a 5-minute reset' }],
    structure: null,
    intent: 'traditional',
    showProfessional: false,
    supportReason: null,
    turn: session.turn,
    knowledge: toKnowledgeCards(cards),
    knowledgeDomains: domains,
  };
}

function vedicFlow(message: string, session: CareSession, traditional: TraditionalKnowledgeItem[]): AgentTurnResult {
  const byId = new Map(traditional.map((i) => [i.knowledge_id, i]));
  const context = byId.get('trad-vedic-context') ?? null;
  const relaxation = /\b(relax|calm|unwind|sleep|stress|wellbeing)\b/i.test(message)
    ? ' Traditional practices such as gentle yoga, breathing and meditation exist within these traditions — I can show you those with their sources, but they stay historical and cultural practices, never medical claims.'
    : '';
  return {
    phase: 'RESPOND',
    mode: 'WELLBEING',
    state: 'GENERAL_HEALTH',
    risk: 'LOW',
    reply:
      'Early Indian texts contain reflections on daily discipline, moderation and harmony between body and mind.' +
      relaxation +
      '\n\nThis is historical context — not medical guidance. HumanOS never converts traditional belief into proven medical fact, and no specific verse is asserted without a source.' +
      '\n\nWHO guidance, as the modern evidence anchor, remains the reference for health decisions.',
    chips: [
      { label: 'Show me traditional practices', value: 'Show me traditional options' },
      { label: 'Explore the tradition', value: 'Tell me about the history of yoga' },
      { label: 'WHO wellbeing guidance', value: 'How can I keep my wellbeing strong?' },
    ],
    tools: [],
    structure: null,
    intent: 'vedic',
    showProfessional: false,
    supportReason: null,
    turn: session.turn,
    knowledge: toKnowledgeCards([context, byId.get('who-tm-strategy')].filter(Boolean) as TraditionalKnowledgeItem[]),
    knowledgeDomains: ['CLASSICAL TEXT', 'WHO EVIDENCE'],
  };
}

function routineFlow(message: string, session: CareSession, traditional: TraditionalKnowledgeItem[]): AgentTurnResult {
  const routine = buildRoutineFor(message);
  const byId = new Map(traditional.map((i) => [i.knowledge_id, i]));
  const cards: TraditionalKnowledgeItem[] = [];
  if (routine.kind === 'morning' && byId.has('trad-morning-routine')) cards.push(byId.get('trad-morning-routine')!);
  if (routine.kind === 'evening' && byId.has('trad-evening-winddown')) cards.push(byId.get('trad-evening-winddown')!);
  if (routine.kind === 'sleep' && byId.has('home-rest-sleep-support')) cards.push(byId.get('home-rest-sleep-support')!);
  return {
    phase: 'RESPOND',
    mode: 'WELLBEING',
    state: 'GENERAL_HEALTH',
    risk: 'LOW',
    reply:
      `Here is a ${routine.name.toLowerCase()} — each step is labelled with its knowledge source:\n\n` +
      routine.steps.map((s) => `• ${s.title} — ${s.provenance === 'WHO EVIDENCE' ? 'WHO guidance' : s.provenance === 'TRADITIONAL PRACTICE' ? 'traditional practice' : s.provenance === 'PROFESSIONAL CARE' ? 'professional care' : 'general wellbeing'}`).join('\n') +
      '\n\nThese are wellbeing practices — not a treatment for any condition. WHO guidance and traditional practices are kept visibly separate.',
    chips: [
      { label: 'Start a 2-minute reset', value: 'I need a reset' },
      { label: 'Explore traditional options', value: 'Show me traditional options' },
      { label: 'Sleep guidance', value: 'how can I sleep better?' },
    ],
    tools: [{ kind: 'openReset', label: 'Start a 2-minute reset' }],
    structure: null,
    intent: 'routine',
    showProfessional: false,
    supportReason: null,
    turn: session.turn,
    knowledge: toKnowledgeCards(cards),
    routine: { name: routine.name, steps: routine.steps },
    knowledgeDomains: Array.from(new Set(routine.steps.map((s) => s.provenance))),
  };
}

function homecareFlow(message: string, session: CareSession, traditional: TraditionalKnowledgeItem[]): AgentTurnResult {
  const choice = session.lastChoice;
  session.lastChoice = null;

  // Pregnancy always routes to the high-caution path.
  if (/\b(pregnant|pregnancy|breastfeeding|postpartum|trying to conceive)\b/i.test(message)) {
    return pregnancyFlow(session);
  }

  // Ingestible preparations: no recommendation without established safety.
  if (/\b(herbal|herb|tea|supplement|extract|powder|decoction|tincture|oil|turmeric|haldi|ginger|adrak|honey|garlic|clove|cinnamon|jeera|ajwain|ashwagandha|churna|kadha|kashayam)\b/i.test(message)) {
    return {
      phase: 'RESPOND',
      mode: 'SELF_CARE',
      state: 'GENERAL_HEALTH',
      risk: 'LOW',
      reply:
        'I will not recommend any herbal or ingestible preparation — traditional origin does not automatically mean safe. ' +
        'For anything you plan to take, please have a doctor or pharmacist review it first. ' +
        'WHO guidance supports this caution: traditional medicine is integrated only where safety, effectiveness and quality are established.',
      chips: [
        { label: 'Show professional support', value: 'professional' },
        { label: 'General comfort practices', value: 'what can I do at home for a mild everyday discomfort?' },
      ],
      tools: [{ kind: 'openProfessionalSupport', label: 'Open support resources' }],
      structure: null,
      intent: 'homecare',
      showProfessional: true,
      supportReason: 'Herbal / ingestible safety: no ingestion recommendation without established safety.',
      turn: session.turn,
      knowledge: toKnowledgeCards([traditional.find((i) => i.knowledge_id === 'who-tm-strategy')].filter(Boolean) as TraditionalKnowledgeItem[]),
      knowledgeDomains: ['WHO EVIDENCE'],
    };
  }

  // Severity gate: serious symptoms always route to professional care.
  const verdict = assessHomeRemedy({ symptom: message });
  if (verdict.decision === 'DO_NOT_RECOMMEND') {
    return {
      phase: 'ESCALATE',
      mode: 'PROFESSIONAL_SUPPORT',
      state: 'GENERAL_HEALTH',
      risk: 'MEDIUM',
      reply: verdict.reason + ' Please contact a healthcare professional — do not wait if it is urgent.',
      chips: [{ label: 'Show professional support', value: 'professional' }],
      tools: [{ kind: 'openProfessionalSupport', label: 'Open support resources' }],
      structure: null,
      intent: 'homecare',
      showProfessional: true,
      supportReason: verdict.reason,
      turn: session.turn,
      knowledgeDomains: ['PROFESSIONAL CARE'],
    };
  }

  // A clarified symptom gets a governed, provenance-labelled answer.
  const byId = new Map(traditional.map((i) => [i.knowledge_id, i]));
  const msg = message.toLowerCase();
  const pickFromMessage =
    /\bheadache\b|\bhead ?ache\b|\bhead pain\b/i.test(msg) ? 'mild headache'
      : /\b(stuffy|runny) nose\b|\bcold\b|\bsneez(e|ing)?\b|\bcongest(ed|ion)?\b/i.test(msg) ? 'mild cold'
        : /\btired\b|\btiredness\b|\bfatigue\b|\bdrained\b/i.test(msg) ? 'mild tiredness' : null;
  const pick: Record<string, string> = {
    'mild tiredness': 'home-mild-tiredness',
    'mild headache': 'home-mild-headache-comfort',
    'mild cold': 'home-basic-comfort',
    'stuffy nose': 'home-basic-comfort',
  };
  const choiceKey = pickFromMessage ?? (choice ?? null);
  const pickedId = choiceKey ? (pick[choiceKey.toLowerCase()] ?? null) : null;
  if (pickedId) {
    const item = byId.get(pickedId) ?? null;
    const label = (choiceKey ?? 'everyday discomfort').replace(/\s+/g, ' ');
    return {
      phase: 'RESPOND',
      mode: 'SELF_CARE',
      state: 'GENERAL_HEALTH',
      risk: 'LOW',
      reply:
        `Here is what tends to help for mild ${label}: rest, plenty of fluids, warmth and simple comfort measures.\n\n` +
        `${item?.interpretation ?? 'Comfort measures only: rest, hydration, gentle movement and environmental comfort.'}\n\n` +
        'These are comfort and general wellbeing practices — not a treatment. If symptoms become severe, persistent or worsening, contact a healthcare professional.',
      chips: [
        { label: 'Show options', value: 'Show me traditional options' },
        { label: 'WHO guidance', value: 'how can I sleep better?' },
        { label: 'Not now', value: "I'm okay" },
      ],
      tools: [{ kind: 'openReset', label: 'Start a short reset' }],
      structure: null,
      intent: 'homecare',
      showProfessional: false,
      supportReason: null,
      turn: session.turn,
      knowledge: toKnowledgeCards(item ? [item] : []),
      knowledgeDomains: ['HOUSEHOLD PRACTICE', 'GENERAL WELLBEING'],
    };
  }

  if (choice === 'something else') {
    return {
      phase: 'ESCALATE',
      mode: 'PROFESSIONAL_SUPPORT',
      state: 'GENERAL_HEALTH',
      risk: 'MEDIUM',
      reply: 'Without knowing what you are experiencing, I can only point you to professional care. Please contact a healthcare professional for an assessment.',
      chips: [{ label: 'Show professional support', value: 'professional' }],
      tools: [{ kind: 'openProfessionalSupport', label: 'Open support resources' }],
      structure: null,
      intent: 'homecare',
      showProfessional: true,
      supportReason: 'Symptom is outside the governed home self-care categories.',
      turn: session.turn,
      knowledgeDomains: ['PROFESSIONAL CARE'],
    };
  }

  // Vague request: exactly ONE clarification, then a governed answer.
  const q = CLARIFICATION_QUESTIONS['homecare']!;
  session.pendingClarify = q.question;
  session.pendingResolve = q.resolve;
  return {
    phase: 'CLARIFY',
    mode: 'CLARIFICATION',
    state: 'GENERAL_HEALTH',
    risk: 'LOW',
    reply: q.question,
    chips: chipsFor(q.options),
    tools: [],
    structure: null,
    intent: 'homecare',
    showProfessional: false,
    supportReason: null,
    turn: session.turn,
    knowledgeDomains: ['HOUSEHOLD PRACTICE'],
  };
}

function medicationFlow(session: CareSession): AgentTurnResult {
  return {
    phase: 'RESPOND',
    mode: 'PROFESSIONAL_SUPPORT',
    state: 'PROFESSIONAL_SUPPORT',
    risk: 'LOW',
    reply:
      'I cannot assess whether a medicine is safe for you — that needs a doctor or pharmacist who knows your full health history, allergies and other medicines. ' +
      'Please ask them before taking anything new. Never combine medicines or traditional preparations without a professional review.',
    chips: [{ label: 'Show professional support', value: 'professional' }],
    tools: [{ kind: 'openProfessionalSupport', label: 'Open support resources' }],
    structure: null,
    intent: 'medication',
    showProfessional: true,
    supportReason: 'Medication-safety questions always route to a doctor or pharmacist — this system never improvises.',
    turn: session.turn,
    knowledgeDomains: ['PROFESSIONAL CARE'],
  };
}

function pregnancyFlow(session: CareSession): AgentTurnResult {
  return {
    phase: 'RESPOND',
    mode: 'PROFESSIONAL_SUPPORT',
    state: 'WOMENS_HEALTH',
    risk: 'LOW',
    reply:
      'During pregnancy I do not provide traditional or herbal ingestion recommendations — they are only considered when a source explicitly supports them with established safety. ' +
      'For any symptom, please speak with your doctor or midwife and use only the care they approve. WHO guidance also emphasizes that traditional medicine must be integrated safely, with quality and effectiveness established.',
    chips: [{ label: 'Show professional support', value: 'professional' }],
    tools: [{ kind: 'openProfessionalSupport', label: 'Open support resources' }],
    structure: null,
    intent: 'pregnancy',
    showProfessional: true,
    supportReason: 'Pregnancy safety: no traditional/herbal ingestion recommendations without established safety.',
    turn: session.turn,
    knowledgeDomains: ['PROFESSIONAL CARE', 'WHO EVIDENCE'],
  };
}

function whatNow(session: CareSession): AgentTurnResult {
  return {
    phase: 'RESPOND',
    mode: 'SELF_CARE',
    state: 'UNKNOWN',
    risk: 'LOW',
    reply:
      'Here are three options — pick one that fits right now:\n\n' +
      '1. Take a 2-minute reset — a quiet guided pause.\n' +
      '2. Explore general WHO sleep and wellbeing guidance.\n' +
      '3. Explore traditional relaxation practices, kept separate from modern guidance.',
    chips: [
      { label: '2-minute reset', value: 'I need a reset' },
      { label: 'Sleep guidance', value: 'how can I sleep better?' },
      { label: 'Traditional relaxation', value: 'Show me traditional relaxation practices' },
    ],
    tools: [{ kind: 'openReset', label: 'Start a 2-minute reset' }],
    structure: null,
    intent: 'none',
    showProfessional: false,
    supportReason: null,
    turn: session.turn,
    knowledgeDomains: ['GENERAL WELLBEING'],
  };
}