import { describe, it, expect } from 'vitest';
import { matchTopics } from './routes.js';

const TOPICS = [
  {
    topic_id: 't-sleep', code: 'sleep', title: 'Sleep', summary: 's', keywords: ['sleep', 'insomnia', 'tired', 'fatigue'],
    source_url: 'u', source_name: 'WHO',
  },
  {
    topic_id: 't-depression', code: 'depression', title: 'Depression', summary: 's',
    keywords: ['depress', 'sad', 'hopeless', 'suicide'],
    source_url: 'u', source_name: 'WHO',
  },
  {
    topic_id: 't-activity', code: 'physical-activity', title: 'Physical activity', summary: 's',
    keywords: ['exercise', 'activity', 'sedentary', 'sitting'],
    source_url: 'u', source_name: 'WHO',
  },
];

describe('matchTopics', () => {
  it('matches a clear sleep question', () => {
    const m = matchTopics('I cannot sleep at night', TOPICS);
    expect(m[0].topic.code).toBe('sleep');
  });

  it('prioritizes the topic with more keyword hits', () => {
    const m = matchTopics('sad and hopeless, feel depressed', TOPICS);
    expect(m[0].topic.code).toBe('depression');
  });

  it('returns empty for unrelated questions (never guesses)', () => {
    const m = matchTopics('quantum teleportation', TOPICS);
    expect(m).toHaveLength(0);
  });

  it('is case- and punctuation-insensitive', () => {
    const m = matchTopics('SLEEP!!! Insomnia??', TOPICS);
    expect(m[0].topic.code).toBe('sleep');
  });
});