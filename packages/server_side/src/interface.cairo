#[starknet::interface]
pub trait IServerSide<T> { //interface
    fn is_active(self: @T, note: felt252) -> bool;
}
