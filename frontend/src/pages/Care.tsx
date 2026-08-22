import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  HeartPulse, MapPin, CheckCircle2, ExternalLink, Loader2, Wind, Droplets, Eye, Sun, Footprints,
  Timer, X, LifeBuoy, Send, Bot, RotateCcw, ScrollText, Info, ShieldCheck, ArrowRight, CalendarDays, User,
} from 'lucide-react';
import { useAuth } from '../store/auth';
import { api } from '../api/client';
import clsx from 'clsx';

// ---------------------------------------------------------------- state chips
// Conversation starters — plain statements, not feature requests (§44).
// The agent acknowledges pure statements and only offers options when the
// person actually asks for something.
const FEELINGS = [
  { key: 'doing-okay', label: 'Doing well', question: "I'm doing well." },
  { key: 'energized', label: 'Energized', question: "I'm energized." },
  { key: 'tired', label: 'Tired', question: "I'm tired" },
  { key: 'sleepy', label: 'Sleepy', question: "I'm sleepy" },
  { key: 'low-energy', label: 'Low energy', question: 'I have no energy today' },
  { key: 'stressed', label: 'Stressed', question: 'I have been feeling stressed lately' },
  { key: 'need-reset', label: 'Need a reset', question: 'I need a break to reset' },
] as const;

// ---------------------------------------------------------------- reset
const RESET_PRESETS = [
  { seconds: 30, label: '30 seconds', blurb: 'One quiet breath cycle' },
  { seconds: 120, label: '2 minutes', blurb: 'Steady breathing + screen rest' },
  { seconds: 300, label: '5 minutes', blurb: 'Full reset: breath, move, drink' },
] as const;

const RESET_ACTIONS = [
  { icon: Droplets, label: 'Drink some water' },
  { icon: Eye, label: 'Rest your eyes from screens' },
  { icon: Sun, label: 'Step into daylight' },
  { icon: Footprints, label: 'Short walk or gentle stretch' },
  { icon: Wind, label: 'Slow, deep breathing' },
  { icon: HeartPulse, label: 'Quiet pause — no input, no screens' },
];

const BREATH_PHASES = [
  { name: 'Inhale', seconds: 4, scale: 1.3 },
  { name: 'Hold', seconds: 2, scale: 1.3 },
  { name: 'Exhale', seconds: 6, scale: 1 },
];

const THINKING_STEPS = ['Understanding your message…', 'Checking governed knowledge sources…', 'Preparing a grounded answer…'];

const WOMEN_AREAS = [
  { title: 'General women\u2019s health', blurb: 'Wellbeing across the life course — check-ups, screening, healthy habits.', url: 'https://www.who.int/health-topics/maternal-health' },
  { title: 'Maternal health & safe pregnancy', blurb: 'WHO guidance on pregnancy, prenatal care and safe delivery.', url: 'https://www.who.int/health-topics/maternal-health' },
  { title: 'Fertility & preconception', blurb: 'WHO resources on reproductive planning and preconception care.', url: 'https://www.who.int/health-topics/maternal-health' },
  { title: 'Reproductive health', blurb: 'WHO fact sheets on reproductive health across the lifespan.', url: 'https://www.who.int/health-topics/reproductive-health' },
  { title: 'Contraception', blurb: 'WHO guidance on family planning and contraceptive methods.', url: 'https://www.who.int/health-topics/sexual-health' },
  { title: 'Menstrual health', blurb: 'WHO work on menstrual health and hygiene.', url: 'https://www.who.int/health-topics/reproductive-health' },
  { title: 'Menopause & perimenopause', blurb: 'Ageing and midlife health resources (closest WHO topic).', url: 'https://www.who.int/health-topics/ageing' },
  { title: 'Breast health', blurb: 'WHO guidance on breast cancer awareness and screening.', url: 'https://www.who.int/health-topics/breast-cancer' },
  { title: 'Cervical health', blurb: 'WHO fact sheet on cervical cancer and prevention.', url: 'https://www.who.int/health-topics/cervical-cancer' },
  { title: 'Nutrition & anaemia', blurb: 'WHO guidance on nutrition, iron deficiency and healthy eating.', url: 'https://www.who.int/health-topics/nutrition' },
  { title: 'Mental health in & after pregnancy', blurb: 'WHO guidance on mental health during pregnancy and after birth.', url: 'https://www.who.int/health-topics/maternal-health' },
  { title: 'Violence against women', blurb: 'WHO resources on preventing and responding to violence against women.', url: 'https://www.who.int/health-topics/violence-against-women' },
] as const;

// ---------------------------------------------------------------- types
type AgentMode = 'INFORMATION' | 'SELF_CARE' | 'WELLBEING' | 'CLARIFICATION' | 'PROFESSIONAL_SUPPORT' | 'URGENT_ROUTING';
type AgentPhase = 'INITIAL' | 'UNDERSTAND' | 'CLARIFY' | 'RETRIEVE' | 'VALIDATE' | 'RESPOND' | 'FOLLOW_UP' | 'ESCALATE' | 'CLOSE';

interface AgentTool {
  kind: 'openReset' | 'openWomenCare' | 'openProfessionalSupport' | 'openWHOArticle' | 'openCareResource';
  label: string;
  payload?: string;
}

interface KnowledgeCard {
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

interface RoutineStep {
  title: string;
  detail: string;
  provenance: string;
}

interface AgentTurn {
  role: 'user' | 'agent';
  text: string;
  chips?: { label: string; value: string }[];
  tools?: AgentTool[];
  structure?: {
    answer: string;
    guidance: string;
    applicability: string;
    safety: string;
    source: { title: string; citation: string; url: string };
  } | null;
  mode?: AgentMode;
  phase?: AgentPhase;
  state?: string;
  showProfessional?: boolean;
  supportReason?: string | null;
  knowledge?: KnowledgeCard[] | null;
  routine?: { name: string; steps: RoutineStep[] } | null;
  knowledgeDomains?: string[];
  decision?: {
    speechAct: string;
    state: string;
    intent: string | null;
    urgency: string;
    confidence: number;
    requestedHelp: boolean;
    responseMode: 'ACKNOWLEDGE' | 'ANSWER' | 'ASK' | 'RECOMMEND' | 'GUIDE' | 'NAVIGATE' | 'WARN' | 'ESCALATE' | 'DO_NOTHING';
    knowledgeSources: string[];
    recommendedActions: string[];
    escalation: 'NONE' | 'PROFESSIONAL' | 'CRISIS';
    conversationState: string;
  };
}

// ---------------------------------------------------------------- provenance maps
const SOURCE_SHORT: Record<string, { label: string; cls: string }> = {
  'WHO EVIDENCE': { label: 'WHO', cls: 'bg-brandsoft text-branddeep' },
  'MODERN AYUSH GUIDANCE': { label: 'AYUSH', cls: 'bg-orange-100 text-orange-800' },
  'AYURVEDIC CLASSICAL': { label: 'Traditional', cls: 'bg-teal-100 text-teal-800' },
  'YOGA TRADITION': { label: 'Traditional', cls: 'bg-emerald-100 text-emerald-800' },
  'CLASSICAL TEXT': { label: 'Traditional', cls: 'bg-violet-100 text-violet-800' },
  'TRADITIONAL PRACTICE': { label: 'Traditional', cls: 'bg-teal-100 text-teal-800' },
  'HOUSEHOLD PRACTICE': { label: 'Household', cls: 'bg-cyan-100 text-cyan-800' },
  'VEDIC / EARLY TEXTUAL': { label: 'Traditional', cls: 'bg-rose-100 text-rose-800' },
  'GENERAL WELLBEING': { label: 'Wellbeing', cls: 'bg-slate-200/70 text-slate-700' },
  'PROFESSIONAL CARE': { label: 'Professional care', cls: 'bg-red-100 text-red-800' },
};

const PROVENANCE_TAG: Record<string, { label: string; cls: string }> = {
  'WHO EVIDENCE': { label: 'WHO guidance', cls: 'bg-brandsoft text-branddeep' },
  'TRADITIONAL PRACTICE': { label: 'Traditional practice', cls: 'bg-teal-100 text-teal-800' },
  'HOUSEHOLD PRACTICE': { label: 'Household practice', cls: 'bg-cyan-100 text-cyan-800' },
  'GENERAL WELLBEING': { label: 'General wellbeing', cls: 'bg-slate-200/70 text-slate-700' },
  'PROFESSIONAL CARE': { label: 'Professional care', cls: 'bg-red-100 text-red-800' },
};

const EVIDENCE_STYLE: Record<string, { label: string; cls: string }> = {
  'Evidence-supported': { label: 'Evidence-supported', cls: 'bg-oksoft text-ok' },
  'Traditional practice': { label: 'Traditional practice', cls: 'bg-teal-100 text-teal-800' },
  'Historical reference': { label: 'Historical reference', cls: 'bg-violet-100 text-violet-800' },
  'Limited evidence': { label: 'Limited evidence', cls: 'bg-warnsoft text-warn' },
  'Source unclear': { label: 'Source unclear', cls: 'bg-dangersoft text-danger' },
  'General wellbeing': { label: 'General wellbeing', cls: 'bg-slate-200/70 text-slate-700' },
  'Modern AYUSH guidance': { label: 'Modern AYUSH guidance', cls: 'bg-orange-100 text-orange-800' },
};

// ---------------------------------------------------------------- state ambience (restrained visual context)
interface Ambience { hero: string; avatar: string; ring: string; today: string; }
const AMBIENCE: Record<string, Ambience> = {
  'doing-okay': { hero: 'from-brandsoft/70 via-soft/40 to-surface', avatar: 'bg-brandsoft text-brand', ring: 'ring-brand/30', today: 'text-branddeep' },
  'energized': { hero: 'from-brandsoft via-orange-100/60 to-surface', avatar: 'bg-brandsoft text-branddeep', ring: 'ring-brand/40', today: 'text-branddeep' },
  'tired': { hero: 'from-soft via-soft/30 to-surface', avatar: 'bg-soft text-inkfaint', ring: 'ring-line', today: 'text-inksoft' },
  'sleepy': { hero: 'from-indigo-50 via-soft/40 to-surface', avatar: 'bg-indigo-100 text-indigo-700', ring: 'ring-indigo-200', today: 'text-indigo-700' },
  'low-energy': { hero: 'from-soft via-soft/30 to-surface', avatar: 'bg-soft text-inkfaint', ring: 'ring-line', today: 'text-inksoft' },
  'stressed': { hero: 'from-amber-50 via-soft/40 to-surface', avatar: 'bg-amber-100 text-amber-800', ring: 'ring-amber-200', today: 'text-amber-800' },
  'overwhelmed': { hero: 'from-amber-50 via-soft/40 to-surface', avatar: 'bg-amber-100 text-amber-800', ring: 'ring-amber-200', today: 'text-amber-800' },
  'need-reset': { hero: 'from-brandsoft/60 via-soft/40 to-surface', avatar: 'bg-brandsoft text-branddeep', ring: 'ring-brand/30', today: 'text-branddeep' },
  default: { hero: 'from-brandsoft/50 via-soft/30 to-surface', avatar: 'bg-brandsoft text-brand', ring: 'ring-brand/20', today: 'text-branddeep' },
};

// ---------------------------------------------------------------- greeting
function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// Modal/drawer accessibility: moves focus in on open, traps Tab, closes on
// Escape, restores focus on close (§58 accessibility pass).
function useDialogFocus(active: boolean, onClose: () => void) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    const prev = document.activeElement as HTMLElement | null;
    const id = window.setTimeout(() => {
      const f = root?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      f?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !root) return;
      const els = [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.hasAttribute('disabled'));
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (activeEl === first || !root.contains(activeEl))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && activeEl === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { clearTimeout(id); document.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, [active, onClose]);
  return rootRef;
}

// ---------------------------------------------------------------- main
export function Care() {
  const { user } = useAuth();
  const name = user?.preferredName || 'there';

  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [thinkingStep, setThinkingStep] = useState(0);
  const [activeFeeling, setActiveFeeling] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);

  // AI deep-link: /care#agent focuses the advisor input (§16 phone nav).
  useEffect(() => {
    if (window.location.hash === '#agent') {
      const id = window.setTimeout(() => document.getElementById('care-message')?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, []);

  const [resetPicker, setResetPicker] = useState(false);
  const [resetActive, setResetActive] = useState<number | null>(null);
  const [resetElapsed, setResetElapsed] = useState(0);
  const resetTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [womenOpen, setWomenOpen] = useState(false);
  const [womenConsent, setWomenConsent] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportReason, setSupportReason] = useState<string | null>(null);

  const [provenance, setProvenance] = useState<{ title: string; turnIndex: number } | null>(null);
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [checkinMsg, setCheckinMsg] = useState<string | null>(null);
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [resetDone, setResetDone] = useState<number | null>(null);

  // Dialog focus management (§58): Escape closes, Tab traps, focus restores.
  const resetOpen = resetPicker || resetActive != null || resetDone != null;
  const closeResetOverlay = useCallback(() => {
    if (resetTimer.current) clearInterval(resetTimer.current);
    resetTimer.current = null;
    setResetPicker(false);
    setResetActive(null);
    setResetDone(null);
  }, []);
  const closeWomen = useCallback(() => setWomenOpen(false), []);
  const closeSupport = useCallback(() => setSupportOpen(false), []);
  const closeProvenance = useCallback(() => setProvenance(null), []);
  const resetFocusRef = useDialogFocus(resetOpen, closeResetOverlay);
  const womenFocusRef = useDialogFocus(womenOpen, closeWomen);
  const supportFocusRef = useDialogFocus(supportOpen, closeSupport);

  // Session memory (§24): current feeling + chosen topic survive refresh.
  const [memory, setMemory] = useState<{ feeling: string | null; topic: string | null }>(() => {
    try {
      const raw = sessionStorage.getItem('care-memory');
      return raw ? (JSON.parse(raw) as { feeling: string | null; topic: string | null }) : { feeling: null, topic: null };
    } catch {
      return { feeling: null, topic: null };
    }
  });

  useEffect(() => {
    try { sessionStorage.setItem('care-memory', JSON.stringify(memory)); } catch { /* best effort */ }
  }, [memory]);

  useEffect(() => () => { if (resetTimer.current) clearInterval(resetTimer.current); }, []);

  useEffect(() => {
    void api.get('/care/consent').then((r) => {
      const granted = (r.data.consent ?? []).find((c: any) => c.domain === 'women_care' && !c.revoked_at);
      setWomenConsent(Boolean(granted));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, asking]);

  const ask = async (message: string) => {
    const text = message.trim();
    if (!text || asking) return;
    setActiveFeeling(null);
    setInput('');
    setAsking(true);
    setThinkingStep(0);
    setTurns((prev) => [...prev, { role: 'user', text }]);
    const stepTimer = setInterval(() => setThinkingStep((s) => Math.min(s + 1, THINKING_STEPS.length - 1)), 900);
    try {
      const res = await api.post('/care/agent', { message: text });
      const d = res.data as AgentTurn & { reply: string };
      setTurns((prev) => [...prev, { ...d, role: 'agent', text: d.reply }]);
      if (d.state === 'POSITIVE_WELLBEING') setMemory((m) => ({ ...m, feeling: 'doing-okay' }));
      else if (d.state === 'LOW_ENERGY' || d.state === 'SLEEPINESS') setMemory((m) => ({ ...m, feeling: d.state === 'SLEEPINESS' ? 'sleepy' : 'tired' }));
      else if (d.state === 'STRESS') setMemory((m) => ({ ...m, feeling: 'stressed' }));
      else if (d.state === 'WORKDAY_RESET') setMemory((m) => ({ ...m, feeling: 'need-reset' }));
      if (d.mode === 'URGENT_ROUTING' || d.showProfessional) {
        setSupportOpen(true);
        setSupportReason(d.supportReason ?? null);
      }
    } catch {
      setTurns((prev) => [...prev, {
        role: 'agent',
        text: 'Something went wrong on our side. Please try again.',
        mode: 'CLARIFICATION',
      }]);
    } finally {
      clearInterval(stepTimer);
      setAsking(false);
    }
  };

  const clearConversation = async () => {
    setAsking(false);
    setTurns([]);
    setActiveFeeling(null);
    setMemory({ feeling: null, topic: null });
    setProvenance(null);
    try { await api.post('/care/agent', { message: 'clear', clear: true }); } catch { /* best effort */ }
  };

  const runTool = (tool: AgentTool) => {
    if (tool.kind === 'openReset') setResetPicker(true);
    if (tool.kind === 'openWomenCare') setWomenOpen(true);
    if (tool.kind === 'openProfessionalSupport') setSupportOpen(true);
    if (tool.kind === 'openWHOArticle' && tool.payload) window.open(tool.payload, '_blank', 'noreferrer');
    if (tool.kind === 'openCareResource') window.open('https://www.who.int/health-topics', '_blank', 'noreferrer');
  };

  const feel = (key: string, questionText: string) => {
    setActiveFeeling(key);
    setMemory((m) => ({ ...m, feeling: key }));
    if (key === 'need-reset') { setResetPicker(true); return; }
    setResetPicker(false);
    void ask(questionText);
  };

  const startReset = (seconds: number) => {
    setResetPicker(false);
    setResetActive(seconds);
    setResetElapsed(0);
    setResetDone(null);
    if (resetTimer.current) clearInterval(resetTimer.current);
    resetTimer.current = setInterval(() => {
      setResetElapsed((prev) => {
        if (prev + 1 >= seconds) {
          if (resetTimer.current) clearInterval(resetTimer.current);
          resetTimer.current = null;
          setResetActive(null);
          setResetDone(seconds);
          return 0;
        }
        return prev + 1;
      });
    }, 1000);
  };

  const stopReset = () => {
    if (resetTimer.current) clearInterval(resetTimer.current);
    resetTimer.current = null;
    setResetActive(null);
    setResetElapsed(0);
    setResetDone(null);
  };

  const toggleWomenConsent = async (grant: boolean) => {
    try {
      await api.post('/care/consent', { domain: 'women_care', grant });
      setWomenConsent(grant);
    } catch {
      setWomenConsent(false);
    }
  };

  const checkIn = async () => {
    setCheckinBusy(true);
    setCheckinMsg(null);
    try {
      let lat: number | undefined;
      let lng: number | undefined;
      if (location.trim()) {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 })
        );
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
      }
      await api.post('/safety/check-in', { latitude: lat, longitude: lng, location: location.trim() || undefined, note: note.trim() || undefined });
      setCheckinMsg(lat != null ? 'Check-in recorded with your location. Only you can see it.' : 'Check-in recorded. Only you can see it.');
      setNote('');
    } catch {
      setCheckinMsg('Could not record the check-in (location permission or network). Try again.');
    } finally {
      setCheckinBusy(false);
    }
  };

  // Today strip: context-driven, not a feature catalogue (§23, §24, §44).
  // It reflects the LAST agent decision: acknowledgement → quiet; otherwise
  // at most 3 recommended actions taken from that turn's tools + chips.
  const today = useMemo(() => {
    const lastAgent = [...turns].reverse().find((t) => t.role === 'agent');
    if (lastAgent) {
      const actions = [
        ...(lastAgent.tools ?? []).map((t) => ({ kind: 'tool' as const, tool: t, label: t.label })),
        ...(lastAgent.chips ?? []).map((c) => ({ kind: 'chip' as const, value: c.value, label: c.label })),
      ].slice(0, 3);
      const mode = lastAgent.decision?.responseMode;
      let message: string;
      let icon = CalendarDays;
      if (mode === 'ACKNOWLEDGE') {
        message = 'No need to plan anything right now — I\u2019m here when you need me.';
      } else if (mode === 'ESCALATE' || mode === 'WARN') {
        icon = LifeBuoy;
        message = 'Your wellbeing comes first. Professional support is open for you.';
      } else if (actions.length > 0) {
        message = 'You might want\u2026';
      } else {
        message = 'Tell me more — I answer first, and only ask when it truly matters.';
      }
      return { icon, message, actions };
    }
    return {
      icon: CalendarDays,
      message: turns.length === 0
        ? `Care is here when you need it, ${name}. Tell me how you're doing.`
        : 'Tell me more about how you feel — I answer first, and only ask when it truly matters.',
      actions: [],
    };
  }, [turns, name]);

  const ambience = AMBIENCE[activeFeeling ?? memory.feeling ?? 'default'] ?? AMBIENCE.default;

  const cycle = 12;
  const remaining = resetActive != null ? resetActive - resetElapsed : 0;
  const elapsedInCycle = resetActive != null ? resetElapsed % cycle : 0;
  const phaseIndex = resetActive != null
    ? elapsedInCycle < 4 ? 0 : elapsedInCycle < 6 ? 1 : 2
    : 0;
  const phase = BREATH_PHASES[phaseIndex];
  const ringRadius = 56;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const progress = resetActive != null ? resetElapsed / resetActive : 0;

  const provenanceTurn = provenance != null ? turns[provenance.turnIndex] : null;

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------------ CARE HERO */}
      <section className="relative overflow-hidden rounded-2xl border border-line bg-surface">
        <div className={clsx('bg-gradient-to-br to-surface transition-colors duration-500', ambience.hero)} aria-hidden="true" />
        <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-brand/5 blur-3xl" aria-hidden="true" />
        <div className="relative px-5 py-6 sm:px-7 sm:py-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="eyebrow">Care</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setWomenOpen(true)}
                className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line bg-surface/70 px-3.5 text-2xs font-medium text-inksoft transition-colors hover:border-inkfaint hover:text-ink"
                aria-label="Open women's care"
              >
                <User className="h-3 w-3" strokeWidth={1.75} /> Women\u2019s care
              </button>
              <span className="privacy-tag privacy-restricted">Private · Only you</span>
            </div>
          </div>
          <h1 className="h-page mt-2">
            {greeting()}, {name}.
          </h1>
          <p className="mt-1 text-sm text-inksoft sm:text-base">How are you doing today?</p>

          <div className="mt-5 flex flex-wrap gap-2">
            {FEELINGS.map((f) => (
              <button
                key={f.key}
                onClick={() => feel(f.key, f.question)}
                aria-pressed={activeFeeling === f.key}
                className={clsx(
                  'inline-flex min-h-11 items-center justify-center rounded-full border px-5 text-xs font-medium transition-all duration-200',
                  activeFeeling === f.key
                    ? 'border-ink bg-ink text-surface shadow-sm'
                    : 'border-line bg-surface/80 text-ink hover:border-inkfaint hover:bg-soft'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ TODAY */}
      <section className="animate-slide-up rounded-2xl border border-line bg-surface">
        <div className="bg-gradient-warm h-0.5 w-full opacity-50" aria-hidden="true" />
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <div className={clsx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1', ambience.avatar, ambience.ring)}>
              <today.icon className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <p className="eyebrow">Today</p>
              <p className={clsx('mt-1 text-sm leading-relaxed', ambience.today)}>{today.message}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {today.actions.map((a) => (
              <button
                key={a.label}
                onClick={() => (a.kind === 'tool' ? runTool(a.tool) : void ask(a.value))}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line bg-soft/40 px-3.5 text-2xs font-medium text-ink transition-all duration-200 hover:border-inkfaint hover:bg-soft"
              >
                {a.label}
                <ArrowRight className="h-3 w-3 text-inkfaint" strokeWidth={2} />
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ CARE CONVERSATION */}
      <section className="animate-slide-up overflow-hidden rounded-2xl border border-line bg-surface elev-1">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 bg-soft/30 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className={clsx('flex h-8 w-8 items-center justify-center rounded-full ring-1', ambience.avatar, ambience.ring)}>
              <Bot className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink">Health Advisor</p>
              <p className="flex items-center gap-1.5 text-2xs text-inkfaint">
                <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />
                Answers first — asks only when it truly needs to
              </p>
            </div>
          </div>
          <button
            onClick={() => void clearConversation()}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line px-3.5 text-2xs text-inksoft transition-colors hover:bg-soft hover:text-ink"
          >
            <RotateCcw className="h-3 w-3" strokeWidth={2} /> New conversation
          </button>
        </div>

        <div ref={chatRef} className="h-[30rem] space-y-4 overflow-y-auto px-4 py-5 sm:px-6" aria-live="polite" aria-busy={asking}>
          {turns.length === 0 && !asking && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className={clsx('flex h-14 w-14 items-center justify-center rounded-full shadow-sm ring-1', ambience.avatar, ambience.ring)}>
                <HeartPulse className="h-6 w-6" strokeWidth={1.75} />
              </div>
              <p className="text-sm font-medium text-ink">Tell me how you're doing today.</p>
              <p className="max-w-md text-2xs leading-relaxed text-inkfaint">
                Sleep, energy, stress, movement or wellbeing — one conversation. I answer first, and only ask when it truly matters.
              </p>
            </div>
          )}

          {turns.map((t, i) => (
            <TurnBlock
              key={`${t.role}-${i}`}
              turn={t}
              ambience={ambience}
              onChip={(v) => void ask(v)}
              onTool={runTool}
              onWhyThis={() => setProvenance({ title: 'Source', turnIndex: i })}
            />
          ))}

          {asking && (
            <div className="animate-slide-up flex items-start gap-2.5">
              <div className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1', ambience.avatar, ambience.ring)}>
                <Bot className="h-4 w-4" strokeWidth={1.75} />
              </div>
              <div className="flex max-w-[85%] items-center gap-2.5 rounded-2xl rounded-tl-none border border-line bg-soft/40 px-4 py-2.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" strokeWidth={2} />
                <span className="text-xs text-inksoft">{THINKING_STEPS[thinkingStep]}</span>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-line/70 bg-soft/20 px-4 py-3 sm:px-6">
          <label htmlFor="care-message" className="mb-1.5 block text-2xs font-medium text-inkfaint">
            Message the health advisor
          </label>
          <div className="flex items-center gap-2">
            <input
              id="care-message"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void ask(input)}
              placeholder="Type how you feel — e.g. “I keep waking up at 3am”"
              className="flex-1 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-ink outline-none transition-colors focus:border-inkfaint"
              aria-label="Message the health advisor"
            />
            <button
              onClick={() => void ask(input)}
              disabled={asking || !input.trim()}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ink text-surface transition-all duration-200 hover:opacity-90 disabled:opacity-40"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
          <p className="mt-2 text-2xs text-inkfaint">
            Care answers first — traditional and home knowledge only appear when they are actually relevant to what you asked, always labelled by source. Not a diagnosis or prescription.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------------------ FIELD SAFETY */}
      <section className="animate-slide-up rounded-xl border border-line bg-surface px-5 py-4">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-inkfaint" strokeWidth={1.75} />
          <p className="eyebrow">Field safety check-in</p>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-inksoft">
          When you work away from your usual place, send a check-in. Location is recorded only when you explicitly send it, and the record is visible only to you.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Where are you? (optional — uses browser location if blank)"
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-inkfaint"
            aria-label="Check-in location"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-inkfaint"
            aria-label="Check-in note"
          />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="flex items-center gap-1.5 text-2xs text-inkfaint">
            <ShieldCheck className="h-3 w-3" strokeWidth={1.75} /> Check-ins are owner-only, timestamped and audited.
          </p>
          <button
            onClick={checkIn}
            disabled={checkinBusy}
            className="rounded-md bg-ink px-4 py-2 text-xs font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {checkinBusy ? 'Recording…' : 'Send check-in'}
          </button>
        </div>
        {checkinMsg && (
          <p className="animate-slide-down mt-3 rounded-md border border-line bg-soft/40 px-3 py-2 text-xs text-inksoft" role="status">
            {checkinMsg}
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------------ RESET OVERLAY */}
      {(resetPicker || resetActive != null || resetDone != null) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Reset experience">
          <div ref={resetFocusRef} className="elev-modal w-full max-w-md animate-slide-up overflow-hidden rounded-2xl border border-line bg-surface">
            {resetPicker && (
              <div className="p-6">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-base font-semibold text-ink">Reset experience</p>
                  <button onClick={() => setResetPicker(false)} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-inkfaint transition-colors hover:bg-soft hover:text-ink" aria-label="Close reset picker">
                    <X className="h-4 w-4" strokeWidth={2} />
                  </button>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-inksoft">
                  Short, non-clinical reset breaks. There are no health claims here — just a pause that can help you step back.
                </p>
                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  {RESET_PRESETS.map((p) => (
                    <button
                      key={p.seconds}
                      onClick={() => startReset(p.seconds)}
                      className="card-hover rounded-xl border border-line bg-soft/40 px-4 py-3.5 text-left transition-all duration-200 hover:border-inkfaint hover:bg-soft"
                    >
                      <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                        <Timer className="h-3.5 w-3.5" strokeWidth={1.75} /> {p.label}
                      </p>
                      <p className="mt-0.5 text-2xs text-inkfaint">{p.blurb}</p>
                    </button>
                  ))}
                </div>
                <div className="mt-4 grid gap-1.5 sm:grid-cols-2">
                  {RESET_ACTIONS.map((a) => (
                    <div key={a.label} className="flex items-center gap-2 rounded-lg border border-line/60 bg-soft/30 px-3 py-2">
                      <a.icon className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.75} />
                      <p className="text-2xs leading-snug text-inksoft">{a.label}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {resetActive != null && (
              <div className="flex flex-col items-center p-8" role="timer" aria-label="Guided reset in progress">
                <div className="relative flex h-36 w-36 items-center justify-center">
                  <div className="bg-gradient-warm absolute inset-0 h-full w-full rounded-full opacity-10 blur-xl" aria-hidden="true" />
                  <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 128 128" aria-hidden="true">
                    <circle cx="64" cy="64" r={ringRadius} fill="none" stroke="currentColor" strokeWidth="4" className="text-line" />
                    <circle
                      cx="64" cy="64" r={ringRadius} fill="none" stroke="currentColor" strokeWidth="4"
                      strokeLinecap="round" strokeDasharray={ringCircumference}
                      strokeDashoffset={ringCircumference * (1 - progress)} className="text-accent"
                    />
                  </svg>
                  <div
                    className="flex h-20 w-20 items-center justify-center rounded-full bg-accent/15"
                    style={{
                      transform: `scale(${phase.scale})`,
                      transition: `transform ${phase.seconds * 1000}ms ease-in-out`,
                    }}
                  >
                    <Wind className="h-8 w-8 text-accent" strokeWidth={1.5} />
                  </div>
                </div>
                <p className="mt-4 text-sm font-medium text-ink">{phase.name}</p>
                <p className="mt-1 text-2xs tabular-nums text-inkfaint">{remaining}s remaining</p>
                <button onClick={stopReset} className="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface px-4 text-xs text-ink transition-colors hover:bg-soft">
                  End reset
                </button>
              </div>
            )}
            {resetDone != null && !resetActive && (
              <div className="p-6">
                <p className="flex items-center gap-2 text-sm font-medium text-ink">
                  <CheckCircle2 className="h-4 w-4 text-ok" strokeWidth={2} />
                  Done. You gave yourself {resetDone >= 60 ? `${Math.round(resetDone / 60)} minutes` : `${resetDone} seconds`} away from the screen.
                </p>
                <p className="mt-1 text-2xs text-inkfaint">No guilt — recovery is part of the work.</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button onClick={() => setResetDone(null)} className="inline-flex min-h-11 items-center justify-center rounded-md bg-ink px-4 text-xs font-medium text-surface transition-opacity hover:opacity-90">
                    Return to work
                  </button>
                  <button onClick={() => { setResetDone(null); setResetPicker(true); }} className="inline-flex min-h-11 items-center justify-center rounded-md border border-line px-4 text-xs text-ink transition-colors hover:bg-soft">
                    Another reset
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ WOMEN'S CARE DRAWER */}
      {womenOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-ink/30 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Women's care">
          <button className="absolute inset-0" onClick={() => setWomenOpen(false)} aria-label="Close" tabIndex={-1} />
          <div ref={womenFocusRef} className="animate-slide-left relative h-full w-full max-w-md overflow-y-auto border-l border-line bg-surface p-6">
            <div className="flex items-center justify-between gap-3">
              <p className="text-base font-semibold text-ink">Women's care</p>
              <button onClick={() => setWomenOpen(false)} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-inkfaint transition-colors hover:bg-soft hover:text-ink" aria-label="Close">
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-inksoft">
              A private workspace of women's health resources. It activates only with your consent — and stores no personal health data: consent only unlocks WHO public resources.
            </p>
            <button
              onClick={() => toggleWomenConsent(!womenConsent)}
              className={clsx(
                'mt-4 inline-flex min-h-11 items-center gap-2 rounded-md px-4 text-xs font-medium transition-colors',
                womenConsent ? 'bg-ink text-surface hover:opacity-90' : 'border border-line text-ink hover:bg-soft'
              )}
              aria-pressed={womenConsent}
            >
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
              {womenConsent ? 'Consent granted — revoke' : 'Grant consent'}
            </button>
            {womenConsent && (
              <div className="animate-slide-down mt-4 space-y-2">
                {WOMEN_AREAS.map((a) => (
                  <a
                    key={a.title}
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group block rounded-xl border border-line bg-soft/40 p-3.5 transition-all hover:border-inkfaint hover:bg-soft"
                  >
                    <p className="flex items-center justify-between gap-2 text-sm font-medium text-ink">
                      {a.title}
                      <ExternalLink className="h-3 w-3 shrink-0 text-inkfaint transition-colors group-hover:text-accent" strokeWidth={2} />
                    </p>
                    <p className="mt-0.5 text-2xs leading-relaxed text-inkfaint">{a.blurb}</p>
                  </a>
                ))}
                <p className="pt-2 text-2xs text-inkfaint">
                  Consent changes are recorded in your audit trail (GRANT / REVOKE) and are fully reversible.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ SUPPORT DRAWER */}
      {supportOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-ink/30 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Professional support">
          <button className="absolute inset-0" onClick={() => setSupportOpen(false)} aria-label="Close" tabIndex={-1} />
          <div ref={supportFocusRef} className="animate-slide-left relative h-full w-full max-w-md overflow-y-auto border-l border-line bg-surface p-6">
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-base font-semibold text-ink">
                <LifeBuoy className="h-4 w-4 text-amber-700" strokeWidth={1.75} /> Professional support
              </p>
              <button onClick={() => setSupportOpen(false)} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-inkfaint transition-colors hover:bg-soft hover:text-ink" aria-label="Close">
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>
            {supportReason && (
              <span className="mt-2 inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-2xs font-medium text-amber-800">
                {supportReason}
              </span>
            )}
            <p className="mt-3 text-sm leading-relaxed text-inksoft">
              Reach out to a healthcare professional of your choice — your regular doctor, a mental health professional, or your workplace's employee support channel. If it feels urgent or unsafe, do not wait: contact local emergency services.
            </p>
            <div className="mt-4 rounded-xl border border-amber-200/60 bg-amber-50/60 px-4 py-3">
              <p className="text-xs leading-relaxed text-amber-800">
                If you are having thoughts of self-harm or suicide, please contact local emergency services or a crisis line immediately — you matter, and help works.
              </p>
            </div>
            <button
              onClick={() => window.open('https://www.who.int/health-topics', '_blank', 'noreferrer')}
              className="mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line bg-surface px-3.5 text-2xs text-ink transition-colors hover:bg-soft"
            >
              <ExternalLink className="h-3 w-3" strokeWidth={2} /> Browse WHO health topics
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ PROVENANCE DRAWER */}
      {provenance && provenanceTurn && (
        <ProvenanceDrawer
          turn={provenanceTurn}
          onClose={closeProvenance}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- turn
function TurnBlock({ turn, ambience, onChip, onTool, onWhyThis }: {
  turn: AgentTurn;
  ambience: Ambience;
  onChip: (v: string) => void;
  onTool: (t: AgentTool) => void;
  onWhyThis: () => void;
}) {
  if (turn.role === 'user') {
    return (
      <div className="animate-slide-up flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-tr-none bg-ink px-4 py-2.5 text-sm leading-relaxed text-surface shadow-sm">
          {turn.text}
        </p>
      </div>
    );
  }

  const urgent = turn.mode === 'URGENT_ROUTING';
  const professional = turn.mode === 'PROFESSIONAL_SUPPORT' || turn.showProfessional;
  const sources: string[] = [];
  if (turn.structure) sources.push('WHO EVIDENCE');
  (turn.knowledge ?? []).forEach((k) => { if (!sources.includes(k.category)) sources.push(k.category); });
  (turn.knowledgeDomains ?? []).forEach((d) => { if (!sources.includes(d)) sources.push(d); });

  return (
    <div className="animate-slide-up flex items-start gap-2.5">
      <div className={clsx(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1',
        urgent ? 'bg-dangersoft text-danger ring-danger/30' : professional ? 'bg-amber-100 text-amber-800 ring-amber-200' : ambience.avatar,
        urgent || professional ? '' : ambience.ring
      )}>
        <Bot className="h-4 w-4" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 max-w-[85%] space-y-2.5">
        <div className={clsx(
          'rounded-2xl rounded-tl-none border px-4 py-3',
          urgent ? 'border-amber-200/70 bg-amber-50/60' : professional ? 'border-amber-200/50 bg-amber-50/30' : 'border-line bg-soft/40'
        )}>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{turn.text}</p>
        </div>

        {turn.structure && (
          <div className="animate-slide-down overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
            <div className="bg-gradient-warm h-0.5 w-full opacity-60" aria-hidden="true" />
            <div className="px-4 py-3.5">
              <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-branddeep">{turn.structure.answer}</p>
              <p className="mt-0.5 text-2xs text-inkfaint">{turn.structure.applicability}</p>
              <p className="mt-2 text-sm leading-relaxed text-inksoft">{turn.structure.guidance}</p>
              {turn.structure.safety && !professional && (
                <p className="mt-2.5 flex items-start gap-1.5 text-2xs leading-relaxed text-inksoft">
                  <Info className="mt-0.5 h-3 w-3 shrink-0 text-inkfaint" strokeWidth={1.75} />
                  {turn.structure.safety}
                </p>
              )}
            </div>
          </div>
        )}

        {turn.routine && turn.routine.steps.length > 0 && (
          <div className="animate-slide-down overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
            <div className="border-b border-line/70 bg-soft/30 px-4 py-2.5">
              <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-ink">
                <CalendarDays className="h-3.5 w-3.5 text-inkfaint" strokeWidth={1.75} /> {turn.routine.name}
              </p>
            </div>
            <ol className="divide-y divide-line/70">
              {turn.routine.steps.map((s, i) => (
                <li key={`${s.title}-${i}`} className="flex items-start gap-3 px-4 py-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brandsoft text-2xs font-semibold text-branddeep">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <p className="text-sm font-medium text-ink">{s.title}</p>
                      <span className={clsx('rounded-full px-2 py-0.5 text-2xs font-medium', (PROVENANCE_TAG[s.provenance] ?? PROVENANCE_TAG['GENERAL WELLBEING']).cls)}>
                        {(PROVENANCE_TAG[s.provenance] ?? PROVENANCE_TAG['GENERAL WELLBEING']).label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-2xs leading-relaxed text-inkfaint">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* compact source chips + Why this? */}
        {sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs text-inkfaint">Source:</span>
            {sources.map((d) => (
              <span key={d} className={clsx('rounded-full px-2 py-0.5 text-2xs font-medium', (SOURCE_SHORT[d] ?? { label: d, cls: 'bg-soft text-inkfaint' }).cls)}>
                {(SOURCE_SHORT[d] ?? { label: d }).label}
              </span>
            ))}
            <button
              onClick={onWhyThis}
              className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line bg-surface px-3.5 text-2xs font-medium text-ink transition-colors hover:border-inkfaint hover:bg-soft"
            >
              <Info className="h-3 w-3" strokeWidth={1.75} /> Why this?
            </button>
          </div>
        )}

        {turn.tools && turn.tools.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {turn.tools.map((t, i) => (
              <button
                key={`${t.kind}-${i}`}
                onClick={() => onTool(t)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-surface px-3.5 text-2xs font-medium text-ink transition-all duration-200 hover:border-inkfaint hover:bg-soft"
              >
                {t.label}
                <ArrowRight className="h-3 w-3 text-inkfaint" strokeWidth={2} />
              </button>
            ))}
          </div>
        )}

        {turn.chips && turn.chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {turn.chips.map((c) => (
              <button
                key={c.value}
                onClick={() => onChip(c.value)}
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-line bg-surface px-4 text-2xs text-inksoft transition-all duration-200 hover:border-brand hover:bg-brandsoft hover:text-ink"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- provenance inspector (§16)
function ProvenanceDrawer({ turn, onClose }: { turn: AgentTurn; onClose: () => void }) {
  const rootRef = useDialogFocus(true, onClose);
  const items: KnowledgeCard[] = turn.knowledge ?? [];
  const entries = useMemo(() => {
    const out: { key: string; value: string; url?: string }[] = [];
    if (turn.structure) {
      out.push({ key: 'Material', value: turn.structure.source.title });
      if (turn.structure.source.citation) out.push({ key: 'Publication', value: turn.structure.source.citation });
      out.push({ key: 'Purpose', value: turn.structure.answer });
      out.push({ key: 'Evidence', value: 'Evidence-supported — WHO guidance' });
      out.push({ key: 'Safety', value: turn.structure.safety });
      if (turn.structure.source.url) out.push({ key: 'Open source', value: turn.structure.source.url, url: turn.structure.source.url });
    }
    items.forEach((k) => {
      if (!out.some((o) => o.key === 'Source' && o.value === k.source)) out.push({ key: 'Source', value: k.source });
      out.push({ key: 'Material', value: k.title });
      if (k.tradition) out.push({ key: 'Tradition', value: k.tradition });
      out.push({ key: 'Classification', value: (SOURCE_SHORT[k.category] ?? { label: k.category }).label });
      out.push({ key: 'Evidence', value: (EVIDENCE_STYLE[k.evidence] ?? { label: k.evidence }).label });
      out.push({ key: 'Safety', value: k.safety });
      if (k.source_url) out.push({ key: 'Open source', value: k.source_url, url: k.source_url });
      out.push({ key: 'Reviewed', value: k.review_date });
      out.push({ key: 'Curator', value: k.reviewer });
    });
    return out;
  }, [turn, items]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Source details">
      <button className="absolute inset-0" onClick={onClose} aria-label="Close" tabIndex={-1} />
      <div ref={rootRef} className="animate-slide-left relative h-full w-full max-w-md overflow-y-auto border-l border-line bg-surface p-6">
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-base font-semibold text-ink">
            <ScrollText className="h-4 w-4 text-inkfaint" strokeWidth={1.75} /> Source
          </p>
          <button onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-inkfaint transition-colors hover:bg-soft hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        <p className="mt-1.5 text-2xs leading-relaxed text-inkfaint">
          Why this answer says what it says — every claim traces to a governed source with a review trail.
        </p>
        <div className="mt-4 space-y-2">
          {entries.map((e, i) => (
            <div key={`${e.key}-${i}`} className="rounded-xl border border-line bg-soft/30 px-3.5 py-2.5">
              <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-inkfaint">{e.key}</p>
              {e.url ? (
                <a
                  href={e.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium break-all text-accent hover:underline"
                >
                  {e.value} <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={2} />
                </a>
              ) : (
                <p className="mt-0.5 text-xs leading-relaxed break-words text-ink">{e.value}</p>
              )}
            </div>
          ))}
        </div>
        {(turn.showProfessional || turn.mode === 'PROFESSIONAL_SUPPORT') && (
          <div className="mt-4 rounded-xl border border-amber-200/60 bg-amber-50/60 px-4 py-3">
            <p className="text-2xs leading-relaxed text-amber-800">
              This answer routes toward professional care. Nothing here replaces a consultation with a healthcare professional.
            </p>
          </div>
        )}
        <div className="mt-4 rounded-xl border border-line bg-soft/40 px-4 py-3">
          <p className="flex items-center gap-1.5 text-2xs leading-relaxed text-inkfaint">
            <ShieldCheck className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            Provenance is shown after the answer, never before it — you get help first, evidence second.
          </p>
        </div>
      </div>
    </div>
  );
}