//! 4-character session identifiers using Crockford base32.
//!
//! Format: 4 lowercase characters from `0123456789abcdefghjkmnpqrstvwxyz`.
//! Crockford base32 (32 chars, no `I`/`L`/`O`/`U` to avoid visual ambiguity
//! with `1`/`1`/`0`/`V`). 32^4 = 1,048,576 unique IDs.
//!
//! With `max_sessions = 50`, collision probability is ~50 / 1M ≈ 0.005%
//! per call. Birthday-paradox 50% threshold is ~1024 items, so 50 sessions
//! is well within the safe zone. `SessionStore::create` retries on
//! collision; the loop is effectively bounded.
//!
//! The IDs are short so agents can pass them through every tool call
//! without token overhead. We source entropy from `Uuid::new_v4()` (which
//! uses the OS RNG) and take the leading 20 bits (5 per base32 char).
//!
//! Validation is case-insensitive: agents may pass `"A3F2"` or `"a3f2"`,
//! both normalize to `"a3f2"`.

use crate::error::BrowserError;
use uuid::Uuid;

const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// Generate a new 4-character session ID. Uses `Uuid::new_v4()` for entropy
/// (cryptographically strong, OS-backed) and packs 20 bits into 4 base32
/// chars.
pub fn generate() -> String {
    let uuid = Uuid::new_v4();
    let bytes = uuid.as_bytes();
    // 20 bits from bytes 0-2: 8 + 8 + 4 = 20 bits. 5 bits per base32 char.
    let n = ((bytes[0] as u32) << 12) | ((bytes[1] as u32) << 4) | ((bytes[2] as u32) >> 4);
    let mut out = String::with_capacity(4);
    for i in 0..4 {
        let shift = (3 - i) * 5;
        let idx = ((n >> shift) & 0x1F) as usize;
        out.push(ALPHABET[idx] as char);
    }
    out
}

/// Validate that `s` is a well-formed 4-char session ID. Returns the
/// normalized (lowercase) form on success. Case-insensitive on input.
pub fn validate(s: &str) -> Result<String, BrowserError> {
    if s.len() != 4 {
        return Err(BrowserError::Parse(format!(
            "invalid session_id '{s}': expected 4 characters, got {}",
            s.len()
        )));
    }
    let lower = s.to_ascii_lowercase();
    for c in lower.chars() {
        if !ALPHABET.contains(&(c as u8)) {
            return Err(BrowserError::Parse(format!(
                "invalid session_id '{s}': contains invalid character '{c}' \
                 (allowed: 0-9, a-z except i/l/o/u)"
            )));
        }
    }
    Ok(lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_produces_4_chars() {
        let id = generate();
        assert_eq!(id.len(), 4);
        validate(&id).expect("generated id must be valid");
    }

    #[test]
    fn generate_produces_unique_ids() {
        let a = generate();
        let b = generate();
        assert_ne!(a, b);
    }

    #[test]
    fn validate_accepts_lowercase() {
        assert_eq!(validate("a3f2").unwrap(), "a3f2");
    }

    #[test]
    fn validate_accepts_uppercase() {
        assert_eq!(validate("A3F2").unwrap(), "a3f2");
    }

    #[test]
    fn validate_rejects_wrong_length() {
        assert!(validate("abc").is_err());
        assert!(validate("abcde").is_err());
        assert!(validate("").is_err());
    }

    #[test]
    fn validate_rejects_invalid_chars() {
        // I, L, O, U are excluded from Crockford base32
        assert!(validate("a1i2").is_err());
        assert!(validate("alou").is_err());
        // Punctuation and other letters
        assert!(validate("a3f!").is_err());
        assert!(validate("a3f ").is_err());
    }

    #[test]
    fn alphabet_contains_no_ambiguous_chars() {
        for c in [b'I', b'L', b'O', b'U'] {
            assert!(
                !ALPHABET.contains(&c),
                "Crockford base32 must not contain {:?}",
                c as char
            );
        }
    }
}
