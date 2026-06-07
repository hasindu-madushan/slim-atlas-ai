//! Phase 2 stub. The actual classifier heuristics + escalator live here in
//! Phase 2. For Phase 1 we always use Tier 1 (the agent can pass `force_tier`
//! to opt out, but no escalation is performed).

use crate::error::{BrowserError, Result};
use crate::tiers::FrameworkHint;

#[allow(dead_code)]
pub fn should_escalate_to_tier2(_hint: Option<FrameworkHint>) -> bool {
    false
}

#[allow(dead_code)]
pub fn assert_tier_enabled(tier: u8) -> Result<()> {
    match tier {
        1 => Ok(()),
        0 | 2.. => Err(BrowserError::TierDisabled { tier }),
    }
}
