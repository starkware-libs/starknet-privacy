use privacy::actions::ClientAction;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockClient<T> {
    fn wrap_execute(self: @T, user_addr: ContractAddress, client_actions: Span<ClientAction>);
    fn execute(self: @T, calldata: Span<felt252>);
}

#[starknet::contract]
pub(crate) mod MockClient {
    use privacy::actions::ClientAction;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait, get_contract_address};
    use super::IMockClient;

    #[storage]
    struct Storage {
        client: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, client_contract: ContractAddress) {
        self.client.write(client_contract);
    }

    #[abi(embed_v0)]
    pub impl MockClientImpl of IMockClient<ContractState> {
        fn wrap_execute(
            self: @ContractState, user_addr: ContractAddress, client_actions: Span<ClientAction>,
        ) {
            // Prepare calldata for the client __execute__ function.
            let mut inner_calldata = array![];
            user_addr.serialize(ref inner_calldata);
            client_actions.serialize(ref inner_calldata);

            // Prepare calldata for the mock execute function.
            let mut calldata = Default::default();
            inner_calldata.serialize(ref calldata);

            let result = call_contract_syscall(
                address: get_contract_address(),
                entry_point_selector: selector!("execute"),
                calldata: calldata.span(),
            );

            // Ignore intended panic, propagate other panics.
            let err = result.unwrap_err();
            if err != array!['MockClient', 'SUCCESS', 'ENTRYPOINT_FAILED'] {
                panic(err);
            }
        }

        fn execute(self: @ContractState, calldata: Span<felt252>) {
            let result = call_contract_syscall(
                address: self.client.read(),
                entry_point_selector: selector!("__execute__"),
                :calldata,
            );
            // Propagate inner panic if occured.
            result.unwrap_syscall();

            // Panic to revert the transaction.
            panic(array!['MockClient', 'SUCCESS']);
        }
    }
}
