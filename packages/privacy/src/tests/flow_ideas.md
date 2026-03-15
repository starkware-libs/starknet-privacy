# Flow Ideas

## Deposit
4. Call server deposit twice with the same input.
6. User A deposit note, transfer to user B, user B withdraws it.
7. User deposit note, transfer to themselves, withdraw it.
8. User deposit note, transfer to themselves, withdraw it, deposit again. (check deposit indexing)
9. User deposit multiple notes, merge them into one note for themselves, withdraw it.
10. User A deposit multiple notes, merge them into one note for themselves, transfer it to users B and C, users B and C withdraw the notes.
11. User A deposit multiple notes, transfer them to one note for user B, user B withdraw it.
12. User A deposit one note, transfer to users B and C, users B and C withdraw the notes.
13. User A deposit one note, transfer to users B and C with leftover for themselves, all users withdraw.

## Transfer
5. Call server transfer twice with the same input.
6. User A transfer to user B, user B to user C, user C back to A.
7. User A transfer to users B and C, users B and C back to A.
8. User A split one note into two notes for themselves.
10. Test transfer use and create note same channel.
    10.1. Test transfer use and create note same channel same amount (actually same note).
    10.2. Test transfer use notes multi channels create note to one channel of the used notes.
    10.3. Test transfer use note one channel create notes multi channels that one of them is the channel of the used note.
    10.4. Test transfer use notes same channel create note same channel (merging notes).

## Withdraw
3. Call server withdraw twice with the same input.

## Create note
1. Try to create same note twice in one transfer.
3. Create note with non-sequential index (should fail - INDEX_NOT_SEQUENTIAL).
4. Create open and enc note for the same note id in same tx (enc first, should fail - NON_ZERO_VALUE).
5. Create open and enc note for the same note id in same tx (open first, should fail - NON_ZERO_VALUE).
6. Create enc note, then open note for the same note id in different tx (should fail - NON_ZERO_VALUE).
7. Create open note, then enc note for the same note id in different tx (should fail - NON_ZERO_VALUE).

## Open note
2. Split from open note: create open note -> deposit large amount -> use to create multiple output notes for different recipients.
3. Open note chain: User A creates open note for User B -> Depositor deposits -> User B transfers to User C -> User C withdraws.
4. Multiple depositors scenario: User A creates open notes with depositor X for User B, and with depositor Y for User C -> both depositors fund their notes -> both recipients transfer to User D.
5. Same depositor multiple open notes: Depositor funds multiple open notes for different recipients in same transaction.
6. Open note round trip: Depositor creates open note for User A -> deposits -> User A transfers to User B -> User B creates open note back to User A with same depositor -> depositor funds again -> User A withdraws.
7. Create an open note and deposit to it in the same TX.
8. Create an open note and deposit to a different one in the same TX.
9. Fill multiple open notes in the same invoke action.



# General Notes
- After each `apply_actions` call, verify external (token) balances.
- After each `apply_actions` call, verify internal (privacy) balances.
- Try to modularize flows, so we can share modules across different flows (i.e. merging notes, depositing to a single note).
- Use test parameters to create multiple similar tests at once.

# Set auditor public key
- register+withdraw (enc with auditor pub key), set auditor pub key, register+withdraw, test its the right auditor key + right encryption (try to decrypt) for both before and after the set.

# General
- Test actions phases (all actions together in the correct order)

## Set proof validity blocks
- set and validate proof.