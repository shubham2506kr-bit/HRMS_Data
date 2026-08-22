-- Migration 023: WHO knowledge registry — structured fields for semantic
-- retrieval and grounded answers. Approved sources remain who.int / iris.who.int
-- ONLY. No row here may ever link to a non-WHO source.

ALTER TABLE health.who_topics
  ADD COLUMN publication_date DATE,
  ADD COLUMN approved BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN applicability TEXT,
  ADD COLUMN escalation_notes TEXT,
  ADD COLUMN citation TEXT;

UPDATE health.who_topics SET
  publication_date = '2024-01-01',
  applicability = 'General guidance for adults at work.',
  citation = 'World Health Organization. ' || title || ' — fact sheet. who.int.'
WHERE code = 'sleep';

UPDATE health.who_topics SET
  publication_date = '2024-06-26',
  applicability = 'General guidance for adults.',
  citation = 'World Health Organization. Physical activity — fact sheet. who.int.',
  escalation_notes = 'If you feel unwell during or after exercise, or have a heart condition, consult a healthcare professional before changing your activity level.'
WHERE code = 'physical-activity';

UPDATE health.who_topics SET
  publication_date = '2022-09-28',
  applicability = 'Guidance for employers and workers on psychosocial risks at work.',
  citation = 'World Health Organization and International Labour Organization. Mental health at work — policy brief, 2022. who.int.',
  escalation_notes = 'Persistent distress, anxiety or thoughts of self-harm warrant professional support: contact your doctor, a mental health professional, or a crisis line now.'
WHERE code = 'mental-health-at-work';

UPDATE health.who_topics SET
  publication_date = '2023-03-31',
  applicability = 'General guidance; not a diagnosis. Persistent low mood deserves professional assessment.',
  citation = 'World Health Organization. Depressive disorder (depression) — fact sheet. who.int.',
  escalation_notes = 'If you have thoughts of self-harm or suicide, contact emergency services or a crisis line immediately.'
WHERE code = 'depression';

UPDATE health.who_topics SET
  publication_date = '2024-06-28',
  applicability = 'Guidance on alcohol use and its risks for adults.',
  citation = 'World Health Organization. Alcohol — fact sheet. who.int.',
  escalation_notes = 'If you are dependent on alcohol or experience withdrawal, seek professional care — stopping suddenly can be dangerous.'
WHERE code = 'alcohol';

UPDATE health.who_topics SET
  publication_date = '2020-04-29',
  applicability = 'General dietary guidance for adults.',
  citation = 'World Health Organization. Healthy diet — fact sheet. who.int.',
  escalation_notes = 'Dietary changes for medical conditions should be guided by a healthcare professional.'
WHERE code = 'healthy-diet';

UPDATE health.who_topics SET
  publication_date = '2022-09-16',
  applicability = 'General guidance on noncommunicable disease risk factors.',
  citation = 'World Health Organization. Noncommunicable diseases — fact sheet. who.int.',
  escalation_notes = 'Persistent symptoms such as chest pain or unexplained weight loss warrant prompt professional assessment.'
WHERE code = 'ncds';

-- END OF MIGRATION 023