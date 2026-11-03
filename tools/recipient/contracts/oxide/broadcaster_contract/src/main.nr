use aztec::macros::aztec;

pub mod condition;

#[aztec]
pub contract Broadcaster {
    use crate::condition::Condition;
    use aztec::{
        context::PrivateContext,
        macros::{events::event, functions::external},
        protocol::{abis::function_selector::FunctionSelector, address::EthAddress, traits::{Serialize, ToField}},
    };
    use oxide_lib::constants::{
        L1_OPERATION_CALLDATA_FIELDS_128K, L1_OPERATION_CALLDATA_FIELDS_16K, L1_OPERATION_CALLDATA_FIELDS_2K,
        L1_OPERATION_CALLDATA_FIELDS_32K, L1_OPERATION_CALLDATA_FIELDS_4K, L1_OPERATION_CALLDATA_FIELDS_64K,
        L1_OPERATION_METADATA_FIELDS,
    };

    #[event]
    struct L1Operation {}

    // L1 operation broadcasts come in size tiers so a broadcast only proves the capacity it needs;
    // tier sizes live in oxide_lib::constants and are mirrored to TS for the relayer decoder.

    #[external("private")]
    fn broadcast_l1_operation_2k(
        target: EthAddress,
        payout_token: EthAddress,
        l1_calldata_bytes_len: u32,
        l1_calldata: [Field; L1_OPERATION_CALLDATA_FIELDS_2K],
        condition: Condition,
    ) {
        enqueue_l1_operation(
            self.context,
            target,
            payout_token,
            l1_calldata_bytes_len,
            l1_calldata,
            condition,
        );
    }

    // TODO(OX-1977): Only escrow withdrawals use this function, to pair the withdrawal release with the escrow run.
    // With withdraw-and-execute the escrows become executors, and then this function is not necessary.
    #[external("private")]
    fn broadcast_l1_operation_pair_2k(
        targets: [EthAddress; 2],
        payout_tokens: [EthAddress; 2],
        l1_calldata_bytes_lens: [u32; 2],
        l1_calldatas: [[Field; L1_OPERATION_CALLDATA_FIELDS_2K]; 2],
        conditions: [Condition; 2],
    ) {
        for i in 0..2 {
            enqueue_l1_operation(
                self.context,
                targets[i],
                payout_tokens[i],
                l1_calldata_bytes_lens[i],
                l1_calldatas[i],
                conditions[i],
            );
        }
    }

    #[external("private")]
    fn broadcast_l1_operation_4k(
        target: EthAddress,
        payout_token: EthAddress,
        l1_calldata_bytes_len: u32,
        l1_calldata: [Field; L1_OPERATION_CALLDATA_FIELDS_4K],
        condition: Condition,
    ) {
        enqueue_l1_operation(
            self.context,
            target,
            payout_token,
            l1_calldata_bytes_len,
            l1_calldata,
            condition,
        );
    }

    #[external("private")]
    fn broadcast_l1_operation_16k(
        target: EthAddress,
        payout_token: EthAddress,
        l1_calldata_bytes_len: u32,
        l1_calldata: [Field; L1_OPERATION_CALLDATA_FIELDS_16K],
        condition: Condition,
    ) {
        enqueue_l1_operation(
            self.context,
            target,
            payout_token,
            l1_calldata_bytes_len,
            l1_calldata,
            condition,
        );
    }

    #[external("private")]
    fn broadcast_l1_operation_32k(
        target: EthAddress,
        payout_token: EthAddress,
        l1_calldata_bytes_len: u32,
        l1_calldata: [Field; L1_OPERATION_CALLDATA_FIELDS_32K],
        condition: Condition,
    ) {
        enqueue_l1_operation(
            self.context,
            target,
            payout_token,
            l1_calldata_bytes_len,
            l1_calldata,
            condition,
        );
    }

    #[external("private")]
    fn broadcast_l1_operation_64k(
        target: EthAddress,
        payout_token: EthAddress,
        l1_calldata_bytes_len: u32,
        l1_calldata: [Field; L1_OPERATION_CALLDATA_FIELDS_64K],
        condition: Condition,
    ) {
        enqueue_l1_operation(
            self.context,
            target,
            payout_token,
            l1_calldata_bytes_len,
            l1_calldata,
            condition,
        );
    }

    #[external("private")]
    fn broadcast_l1_operation_128k(
        target: EthAddress,
        payout_token: EthAddress,
        l1_calldata_bytes_len: u32,
        l1_calldata: [Field; L1_OPERATION_CALLDATA_FIELDS_128K],
        condition: Condition,
    ) {
        enqueue_l1_operation(
            self.context,
            target,
            payout_token,
            l1_calldata_bytes_len,
            l1_calldata,
            condition,
        );
    }

    #[contract_library_method]
    fn enqueue_l1_operation<let N: u32>(
        context: &mut PrivateContext,
        target: EthAddress,
        payout_token: EthAddress,
        l1_calldata_bytes_len: u32,
        l1_calldata: [Field; N],
        condition: Condition,
    ) {
        let metadata: [Field; L1_OPERATION_METADATA_FIELDS] = [
            target.to_field(),
            payout_token.to_field(),
            l1_calldata_bytes_len as Field,
            condition.kind as Field,
            condition.token.to_field(),
            condition.recipient.to_field(),
        ];
        context.call_public_function(
            context.this_address(),
            comptime { FunctionSelector::from_signature("l1_operation_event()") },
            metadata.concat(l1_calldata.serialize()),
            false,
        );
    }

    // We don't declare here target, payout_token and l1_calldata so we can save on gas
    // We won't emit it anyway, as we don't need long lived DA, just the window while
    // this tx is submitted -> finalized
    #[external("public")]
    fn l1_operation_event() {
        self.emit(L1Operation {});
    }
}
