import { describe, it, expect } from 'vitest';
import { buildAdvisorResponse, classifyIntents, dominantIntent } from './intents.js';

const TOPICS = [
  {
    topic_id: 't-sleep', code: 'sleep', title: 'Sleep', summary: 's', keywords: ['sleep', 'insomnia', 'tired', 'fatigue'],
    source_url: 'u', source_name: 'WHO', applicability: 'General.', escalation_notes: 'See a professional if it persists.', citation: 'WHO. Sleep. who.int.',
  },
  {
    topic_id: 't-depression', code: 'depression', title: 'Depression', summary: 's',
    keywords: ['depress', 'sad', 'hopeless', 'suicide'],
    source_url: 'u', source_name: 'WHO', applicability: 'General.', escalation_notes: 'Contact a crisis line now.', citation: 'WHO. Depression. who.int.',
  },
  {
    topic_id: 't-activity', code: 'physical-activity', title: 'Physical activity', summary: 's',
    keywords: ['exercise', 'activity', 'sedentary', 'sitting'],
    source_url: 'u', source_name: 'WHO', applicability: 'General.', escalation_notes: 'See a professional if unwell.', citation: 'WHO. Physical activity. who.int.',
  },
];

describe('classifyIntents', () => {
  it('classifies natural phrases into broad intents', () => {
    expect(dominantIntent('I have been struggling to fall asleep at night')?.code).toBe('sleep');
    expect(dominantIntent('I feel exhausted all the time')?.code).toBe('sleep');
    expect(dominantIntent('I have no energy today')?.code).toBe('energy');
    expect(dominantIntent('The workload is stressing me out')?.code).toBe('mental_health_at_work');
    expect(dominantIntent('I am feeling hopeless and empty')?.code).toBe('depression');
  });

  it('recognizes unwell, professional and reset intents', () => {
    expect(dominantIntent('I feel sick and my head hurts')?.code).toBe('unwell');
    expect(dominantIntent('I want to talk to a professional')?.code).toBe('professional');
    expect(dominantIntent('I need a break right now')?.code).toBe('reset');
  });

  it('returns null for unrelated input (never guesses)', () => {
    expect(dominantIntent('quantum teleportation')?.code ?? null).toBe(null);
    expect(classifyIntents('what is the weather today')).toHaveLength(0);
  });
});

describe('buildAdvisorResponse', () => {
  it('grounds sleep questions to the WHO sleep topic', () => {
    const r = buildAdvisorResponse('I cannot sleep at night', TOPICS);
    expect(r.structure?.source.title).toBe('Sleep');
    expect(r.structure?.source.url).toBe('u');
  });

  it('refuses with the exact message when there is no WHO source', () => {
    const r = buildAdvisorResponse('I feel sick', TOPICS);
    expect(r.structure).toBeNull();
    expect(r.reply).toContain("I don't have an approved WHO-supported answer");
    expect(r.showProfessional).toBe(true);
  });

  it('never improvises health advice for unwell', () => {
    const r = buildAdvisorResponse('I have a headache and fever', TOPICS);
    expect(r.structure).toBeNull();
    expect(r.reply).not.toContain('paracetamol');
  });

  it('offers a reset suggestion for sleepy', () => {
    const r = buildAdvisorResponse('I am sleepy', TOPICS);
    expect(r.suggestion?.kind).toBe('reset');
  });

  it('offers a choice suggestion for low energy', () => {
    const r = buildAdvisorResponse('I have no energy today', TOPICS);
    expect(r.suggestion?.kind).toBe('choice');
  });

  it('routes crisis questions to professional support', () => {
    const r = buildAdvisorResponse('I am having thoughts of self-harm, I need help now', TOPICS);
    expect(r.showProfessional).toBe(true);
  });

  it('provides escalation notes with grounded answers', () => {
    const r = buildAdvisorResponse('I feel depressed and hopeless', TOPICS);
    expect(r.structure?.safety).toBe('Contact a crisis line now.');
  });
});