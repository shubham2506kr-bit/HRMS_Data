import { describe, it, expect } from 'vitest';
import { matchIntent, nameLookupTerm, NAME_LOOKUP_MIN_TOKEN } from './routes.js';

describe('matchIntent', () => {
  it('routes leave language to the leave page', () => {
    expect(matchIntent('I need to take vacation next month')?.intent).toBe('leave');
  });

  it('routes pay language to the pay page', () => {
    expect(matchIntent('what is my payslip situation')?.intent).toBe('pay');
  });

  it('routes wellbeing language to care', () => {
    expect(matchIntent('I slept badly and feel stressed')?.intent).toBe('care');
  });

  it('returns null for nonsense (honest unknown)', () => {
    expect(matchIntent('blah blah zebra')).toBeNull();
  });
});

describe('nameLookupTerm', () => {
  it('refuses fragments shorter than the minimum token length', () => {
    expect(NAME_LOOKUP_MIN_TOKEN).toBeGreaterThanOrEqual(3);
    // A single letter plus "shortest name first" ordering would make the
    // directory enumerable one character at a time.
    expect(nameLookupTerm('who is a')).toBeNull();
    expect(nameLookupTerm('find b')).toBeNull();
    expect(nameLookupTerm('who is')).toBeNull();
    expect(nameLookupTerm('a b c d e')).toBeNull();
  });

  it('drops search verbs and keeps at most two real name tokens', () => {
    expect(nameLookupTerm('find priya')).toBe('priya');
    expect(nameLookupTerm('who is ana lee')).toBe('ana%lee');
    expect(nameLookupTerm('tell me about rahul sharma verma')).toBe('rahul%sharma');
  });

  it('strips punctuation and digits rather than passing them to the query', () => {
    expect(nameLookupTerm("o'brien")).toBe('brien');
    expect(nameLookupTerm("'; DROP TABLE health.persons; --")).toBe('drop%table');
  });
});