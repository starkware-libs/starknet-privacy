use server_side::tests::test_utils::{NoteTrait, Test, TestTrait, map_store};

#[test]
fn test_is_active() {
    let mut test: Test = Default::default();
    let note = test.new_note();

    assert!(!note.is_active());

    map_store(
        contract_address: test.cfg.address,
        selector: selector!("notes"),
        key: note.hash,
        value: true,
    );
    assert!(note.is_active());
}
