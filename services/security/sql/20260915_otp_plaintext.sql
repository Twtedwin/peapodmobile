-- OTP plaintext (dev/debug). otp_codes.code_hash is already TEXT NOT NULL.
-- Six-digit codes fit without ALTER TABLE. This is NOT on auth_credentials.
--
-- Optional cleanup: consume leftover Argon2 rows so only new plaintext codes
-- remain live. Safe to run more than once.
--
-- Revert hashing: OTP_STORE_PLAINTEXT=false. No schema rollback needed.

UPDATE otp_codes
SET consumed_at = COALESCE(consumed_at, NOW())
WHERE consumed_at IS NULL
  AND char_length(code_hash) > 6;
