-- Migration 020: WHO Knowledge Registry + Health Advisor (Phase M)
-- The advisor answers ONLY from this registry (public WHO fact sheets).
-- It never guesses: unmatched questions get an honest "I don't know" and a
-- pointer to real sources. Every question is logged privately to the asker.

CREATE TABLE health.who_topics (
    topic_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_url TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT 'World Health Organization',
    last_reviewed DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE health.advisor_queries (
    query_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id UUID NOT NULL REFERENCES health.persons(logical_id),
    question TEXT NOT NULL,
    matched_topic_ids UUID[] NOT NULL DEFAULT '{}',
    reply TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_advisor_queries_person ON health.advisor_queries (person_id, created_at DESC);

-- Registry content is taken verbatim in substance from the WHO public fact
-- sheets listed as sources. Dates checked at seed time.
INSERT INTO health.who_topics (code, title, summary, keywords, source_url, last_reviewed) VALUES
('sleep', 'Sleep',
 'For adults, WHO recommends 7 to 9 hours of sleep per night. Good sleep improves attention, memory and mood; chronic poor sleep is linked to obesity, diabetes, hypertension and depression. For shift workers, regular schedules, dark quiet rooms and consistent wind-down routines help protect sleep.',
 '["sleep","insomnia","tired","fatigue","rest","night","sleepless","bedtime","nap"]',
 'https://www.who.int/news-room/fact-sheets/detail/sleep', DATE '2026-08-01'),
('physical-activity', 'Physical activity',
 'WHO recommends that adults do at least 150–300 minutes of moderate-intensity aerobic activity, or 75–150 minutes of vigorous-intensity activity, per week — plus muscle-strengthening activity on two or more days. Any amount of movement counts, and sedentary time should be broken up regularly.',
 '["exercise","activity","active","sedentary","sitting","walk","run","gym","sport","movement","fitness"]',
 'https://www.who.int/news-room/fact-sheets/detail/physical-activity', DATE '2026-08-01'),
('mental-health-at-work', 'Mental health at work',
 'WHO estimates that 15% of working-age adults live with a mental disorder. Decent work protects mental health; unsafe or stressful work damages it. Employers can act with prevention, accommodations, and support that respects privacy and avoids coercion.',
 '["mental","stress","burnout","burn out","anxiety","depression","workload","pressure","wellbeing","work"]',
 'https://www.who.int/news-room/fact-sheets/detail/mental-health-at-work', DATE '2026-08-01'),
('depression', 'Depression',
 'Depression is common — WHO estimates 5% of adults live with it — and it is treatable. Effective options include psychological treatment and, where appropriate, medication. Reaching out to a health professional is the first step; symptoms lasting two weeks or more deserve attention.',
 '["depress","sad","hopeless","empty","suicide","self-harm","unhappy","low mood"]',
 'https://www.who.int/news-room/fact-sheets/detail/depression', DATE '2026-08-01'),
('alcohol', 'Alcohol',
 'Alcohol is a psychoactive substance and a cause of more than 200 diseases. The safest level of consumption is none; any benefit is outweighed by health risks. Reducing alcohol is one of the most effective lifestyle changes for heart and liver health.',
 '["alcohol","drink","drinking","beer","wine","liquor","hangover"]',
 'https://www.who.int/news-room/fact-sheets/detail/alcohol', DATE '2026-08-01'),
('healthy-diet', 'Healthy diet',
 'A healthy diet protects against malnutrition and noncommunicable diseases. WHO guidance: eat more fruits, vegetables, legumes, nuts and whole grains; limit free sugars, salt and industrially produced trans fats; drink water and avoid sugary drinks.',
 '["diet","food","nutrition","eat","eating","fat","sugar","salt","meal","cooking"]',
 'https://www.who.int/news-room/fact-sheets/detail/healthy-diet', DATE '2026-08-01'),
('ncds', 'Noncommunicable diseases',
 'Noncommunicable diseases — heart disease, cancer, diabetes, chronic lung disease — cause 74% of global deaths. Most share four behavioural risk factors: tobacco, alcohol, physical inactivity and unhealthy diet. Small consistent changes compound over time.',
 '["heart","diabetes","cancer","blood pressure","cholesterol","chronic","ncd","disease"]',
 'https://www.who.int/news-room/fact-sheets/detail/noncommunicable-diseases', DATE '2026-08-01');

GRANT SELECT, INSERT ON health.who_topics TO app_service;
GRANT SELECT, INSERT ON health.advisor_queries TO app_service;

-- END OF MIGRATION 020