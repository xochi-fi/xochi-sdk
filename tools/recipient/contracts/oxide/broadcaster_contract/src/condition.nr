use aztec::protocol::{address::EthAddress, traits::{Deserialize, Serialize}};

/// The condition that must hold before its L1 operation can execute.
///
/// `kind` selects which of the other fields apply, and the fields a kind does not use are zero:
/// - `IMMEDIATE` (0): immediately executable.
/// - `BALANCE` (1): executable once arbitrary `token` amount reaches `recipient` (recipient is typically a SIPA).
/// - `MESSAGE_IN_OUTBOX` (2): executable once the L2->L1 message emitted by the broadcast's own tx is in the Outbox.
#[derive(Deserialize, Eq, Serialize)]
pub struct Condition {
    pub kind: u8,
    pub token: EthAddress,
    pub recipient: EthAddress,
}
