#[starknet::contract]
pub mod SwapExecutor {
    use core::array::Span;
    use core::num::traits::Zero;
    use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::interface::{
        IServerDispatcher, IServerDispatcherTrait, IViewsDispatcher, IViewsDispatcherTrait,
    };
    use privacy::objects::EncNote;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use swap_executor::errors;
    use swap_executor::interface::ISwapExecutor;

    #[storage]
    struct Storage {
        // TODO: Consider store the dispatcher instead of the address.
        // TODO: Consider setter for the privacy pool. (or just deploy new one with new address)
        /// Address of the privacy pool contract.
        privacy_pool: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event { // TODO: Add events if needed.
    }
    // TODO: Consider if this contract should be upgradeable.
    // TODO: Consider adding pausability (pausable) to this contract.

    #[constructor]
    fn constructor(ref self: ContractState, privacy_pool: ContractAddress) {
        assert(privacy_pool.is_non_zero(), errors::ZERO_PRIVACY_POOL);
        self.privacy_pool.write(privacy_pool);
    }

    #[abi(embed_v0)]
    pub impl SwapExecutorImpl of ISwapExecutor<ContractState> {
        // TODO: Consider return value?
        fn swap_and_deposit(
            ref self: ContractState,
            swap_contract: ContractAddress,
            swap_selector: felt252,
            swap_calldata: Span<felt252>,
            owner_addr: ContractAddress,
            token: ContractAddress,
            amount: u128,
            note_id: felt252,
        ) {
            // TODO: Consider permissionless swap and deposit.
            // Assert that the caller is the privacy pool.
            let caller = get_caller_address();
            let privacy_pool_addr = self.privacy_pool.read();
            assert(caller == privacy_pool_addr, errors::INVALID_CALLER);

            // TODO: Do we need these assertions?
            // Assert inputs are valid.
            assert(swap_contract.is_non_zero(), errors::ZERO_SWAP_CONTRACT);
            assert(swap_selector.is_non_zero(), errors::ZERO_SWAP_SELECTOR);
            assert(!swap_calldata.is_empty(), errors::ZERO_SWAP_CALLDATA);
            assert(owner_addr.is_non_zero(), errors::ZERO_OWNER_ADDR);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(note_id.is_non_zero(), errors::ZERO_NOTE_ID);

            // Extract input_token from calldata (first element)
            // Calldata format: [input_token, output_token, min_output_amount, ...]
            // TODO: This assert can be removed if we assert the calldata is not empty.
            assert(swap_calldata.len() >= 1, errors::ZERO_SWAP_CALLDATA);
            let input_token_felt = *swap_calldata.at(0);
            let input_token: ContractAddress = input_token_felt.try_into().unwrap();
            // TODO: This assert can be removed if we assert the calldata is not empty?
            assert(input_token.is_non_zero(), errors::ZERO_SWAP_CALLDATA);

            // Approve the swap contract to spend the input tokens.
            let input_token_dispatcher = IERC20Dispatcher { contract_address: input_token };
            input_token_dispatcher.approve(spender: swap_contract, amount: amount.into());

            // Get the contract's balance before the swap (for output token).
            let self_address = get_contract_address();
            let output_token_dispatcher = IERC20Dispatcher { contract_address: token };
            let balance_before = output_token_dispatcher.balance_of(account: self_address);

            // Execute the swap function call.
            let _ = call_contract_syscall(
                address: swap_contract,
                entry_point_selector: swap_selector,
                calldata: swap_calldata,
            );

            // Get the contract's balance after the swap (for output token).
            let balance_after = output_token_dispatcher.balance_of(account: self_address);

            // Calculate the difference (amount received from swap).
            let received_amount = balance_after - balance_before;

            // Deposit the received amount to the privacy pool.
            // TODO: Consider remove this if. maybe assert/ just deposit 0?
            if received_amount > 0 {
                // Approve the privacy pool to spend the output tokens.
                output_token_dispatcher
                    .approve(spender: privacy_pool_addr, amount: received_amount);

                let views = IViewsDispatcher { contract_address: privacy_pool_addr };
                // Get the encrypted amount from the server using the note_id.
                // TODO: This shoud be change because the deposit should get only note_id (new
                // deposit logic).
                let enc_amount = views.get_note(:note_id);
                // TODO: Consider assert that the note exists with amount zero.
                // TODO: we dont need the enc amount here?
                let note = EncNote { id: note_id, enc_amount: enc_amount };
                let server = IServerDispatcher { contract_address: privacy_pool_addr };
                // TODO: Server or client deposit?
                server
                    .deposit(
                        user_addr: owner_addr,
                        token: token,
                        amount: received_amount.try_into().unwrap(),
                        :note,
                    );
            }
        }
    }
}

