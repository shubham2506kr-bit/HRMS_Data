-- Migration 028: Traditional Knowledge Registry + Home Self-Care layer.
--
-- The Health Advisor gains a SECOND, strictly separated knowledge plane:
-- traditional Indian knowledge (Ayurvedic classical, yoga tradition, Vedic /
-- early textual, household practice, modern AYUSH guidance). WHO remains the
-- modern evidence anchor. The two planes are NEVER silently blended: every
-- record carries full provenance and every employee-facing answer is labelled
-- with its knowledge category.
--
-- Content rules (master directive):
--  - No invented sources, Sanskrit, herbs, dosages or "Vedic" attributions.
--  - Historical claims stay historical; medical claims require evidence.
--  - Home-remedy safety engine: uncertain safety -> DO NOT RECOMMEND.
--  - Pregnancy / children / medication -> professional care unless a source
--    explicitly supports the practice with established safety.
--  - Tier 6 (uncategorized folklore) never generates health recommendations.
--
-- The registry is seeded from backend/src/modules/care/traditional.ts at
-- server boot (single governed source of content, idempotent upsert).

CREATE TABLE health.traditional_knowledge (
    knowledge_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    tradition TEXT NOT NULL,
    source TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_url TEXT,
    original_text_reference TEXT,
    translation TEXT,
    interpretation TEXT NOT NULL,
    intended_use TEXT,
    evidence_level TEXT NOT NULL,
    safety_level TEXT NOT NULL,
    contraindications TEXT,
    interaction_warnings TEXT,
    population_restrictions TEXT,
    pregnancy_restrictions TEXT,
    review_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reviewer TEXT NOT NULL DEFAULT 'EduRankAI HumanOS content review',
    status TEXT NOT NULL DEFAULT 'APPROVED',
    keywords JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX idx_trad_knowledge_category ON health.traditional_knowledge (category);
CREATE INDEX idx_trad_knowledge_status ON health.traditional_knowledge (status);

GRANT SELECT, INSERT, UPDATE ON health.traditional_knowledge TO app_service;

-- END OF MIGRATION 028