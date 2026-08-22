-- Migration 017: Real authentication — local-password fallback + account seeds
-- Description: Adds sandbox-local credentials to user_accounts (IdP remains the
-- primary model; local passwords are the sandbox fallback), seeds one account per
-- demo person. Roles are derived from data at token issue time (capability spine).

ALTER TABLE health.user_accounts
    ADD COLUMN IF NOT EXISTS username TEXT,
    ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_accounts_username ON health.user_accounts (username)
    WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_accounts_person ON health.user_accounts (person_id);

INSERT INTO health.user_accounts (person_id, idp_subject_id, idp_issuer, is_active, username, password_hash)
VALUES
    ('00000000-0000-0000-0000-000000000001', 'local:john',    'local', TRUE, 'john',    '$2b$10$2320OgAn.7UoMM3BChTEselMxYqMoQ1nElP7k.ywC1wXDgbTKVJda'),
    ('00000000-0000-0000-0000-000000000002', 'local:jane',    'local', TRUE, 'jane',    '$2b$10$9MuWx4wcv.27BkCUG6mc1.6alYTSF0FVEKPwl/Z6f4ySnnuuw3SMa'),
    ('00000000-0000-0000-0000-000000000003', 'local:robert',  'local', TRUE, 'robert',  '$2b$10$tsQMsDhkslUHlsrtImu/MOn1iMqOjaSB1ren1bKmo633r9WIBm4FO'),
    ('00000000-0000-0000-0000-000000000004', 'local:emily',   'local', TRUE, 'emily',   '$2b$10$fPDw37ZijVUu1IMTGhaTYuwzGdrUv6Q3JS1dLER5cg2r76YpFVLoS'),
    ('00000000-0000-0000-0000-000000000005', 'local:michael', 'local', TRUE, 'michael', '$2b$10$bUZ7wi1jg/DJW7PK0romteBRXaaE6E5a0gsoh4Yjp4tka7KrF/Tsi'),
    ('00000000-0000-0000-0000-000000000006', 'local:sarah',   'local', TRUE, 'sarah',   '$2b$10$xhm0TKpApmwcOc6ljNI7ku18VeTPYVozU5PIkW5ZhJ/uYHxOQ1qCq'),
    ('00000000-0000-0000-0000-000000000007', 'local:david',   'local', TRUE, 'david',   '$2b$10$jOaLnRQbMmVJnPkw1QoKquzMDe0cE2qb3PVSsBfXf3RBhGFXHNmIm'),
    ('00000000-0000-0000-0000-000000000008', 'local:lisa',    'local', TRUE, 'lisa',    '$2b$10$bcc7wh0j4SXeZ0R7M45bOeJFrwXqICccqzPHhYSzczlqiHXb4mY7a')
ON CONFLICT (person_id) DO UPDATE SET
    username = EXCLUDED.username,
    password_hash = EXCLUDED.password_hash,
    idp_subject_id = EXCLUDED.idp_subject_id,
    is_active = TRUE;

-- END OF MIGRATION 017