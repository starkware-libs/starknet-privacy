# Flow Ideas
## Open Channel
1. Open 2 channels in succession.
2. Open same channel twice, should fail in the second.
3. open channel end-to-end.
4. Open channel before recipient registered (should fail - VerifyValue checks recipient viewing key).
5. Open channel with wrong sender key (should fail - SENDER_NOT_AUTHENTICATED).

## Open Subchannel
1. open subchannel twice same index same token
2. open subchannel twice same index different token
3. open subchannel twice different index same token
4. open subchannel end-to-end.
5. Open subchannel sequential index requirement (subchannels must be opened sequentially: index 0, then 1, then 2, etc.).
6. Open subchannel with non-sequential index (should fail - INDEX_NOT_SEQUENTIAL).
7. Open subchannel before channel exists (should fail - INVALID_CHANNEL).

## Deposit
1. Deposit end-to-end.
2. User deposit different tokens.
3. User deposit the same token multiple times.
4. Call server deposit twice with the same input.
5. User deposit note, withdraw it.
6. User A deposit note, transfer to user B, user B withdraws it.
7. User deposit note, transfer to themselves, withdraw it.
8. User deposit note, transfer to themselves, withdraw it, deposit again. (check deposit indexing)
9. User deposit multiple notes, merge them into one note for themselves, withdraw it.
10. User A deposit multiple notes, merge them into one note for themselves, transfer it to users B and C, users B and C withdraw the notes.
11. User A deposit multiple notes, transfer them to one note for user B, user B withdraw it.
12. User A deposit one note, transfer to users B and C, users B and C withdraw the notes.
13. User A deposit one note, transfer to users B and C with leftover for themselves, all users withdraw.
14. User deposit same token and amount twice - assert enc_amount and id are different.

## Transfer
1. Transfer end-to-end.
2. Split Transfer: User A sends to User B and gets change back.
3. Merge Transfer: User A combines multiple notes into one.
4. Double Spend: User tries to spend the same note twice - should fail.
5. Call server transfer twice with the same input.
6. User A transfer to user B, user B to user C, user C back to A.
7. User A transfer to users B and C, users B and C back to A.
8. User A split one note into two notes for themselves.
9. Unauthorized Transfer: User tries to spend a note they don't own - should fail.
10. Test transfer use and create note same channel.
    10.1. Test transfer use and create note same channel same amount (actually same note).
    10.2. Test transfer use notes multi channels create note to one channel of the used notes.
    10.3. Test transfer use note one channel create notes multi channels that one of them is the channel of the used note.
    10.4. Test transfer use notes same channel create note same channel (merging notes).
11. Test transfer use and create note multi channels and multi amounts (also one with same channel and one with same amount).
12. Use many notes from the same channel.
13. Transfer many to many different partition of amounts.
14. Catch NOTE_NOT_FOUND: wrong user addr, wrong private key, wrong channel index, and wrong note index, wrong token.

## Withdraw
1. Withdraw end-to-end.
2. User withdraw different notes.
3. Call server withdraw twice with the same input.
4. User withdraw multiple notes at once.
5. User 1 attempt to withdraw User 2's note.
6. User withdraw a note that doesn't belong to him (someone else's nullifier).
7. User withdraw a note that doesn't exist (invalid nullifier).

## Create note
1. Try to create same note twice in one transfer.
2. Try to create same note twice in different transfers.
3. Create note with non-sequential index (should fail - INDEX_NOT_SEQUENTIAL).

## Use note
1. Use note, change viewing key, try to use note again.
2. Try to use same note twice in one transfer.
3. Try to use smae note twice in different transfers.
4. Use note with wrong amount in transfer.

## Set Viewing Key
1. Set viewing key end-to-end (register with viewing key for the first time).
2. Set viewing key multiple times (user can replace viewing key multiple times).
3. Set viewing key with same key (should succeed - overwrites encrypted private key with new random).
4. Set viewing key and channel interactions: User sets key, opens channel, changes key, verify channel still accessible.
5. Set viewing key and note interactions: User sets key, receives note, changes key, verify note still usable (uses private key for nullifier).
6. Use note, change viewing key, try to use old note.
7. Use note, change viewing key, try to use same note again.
8. Attempt to use multiple notes that were created for different viewing keys in the same transfer.
9. Deposit, change viewing key, deposit again.
10. Change viewing key, create note, use with new key.
11. Set viewing key and verify that compliance is still able to view all user data (encrypted private key updated).
12. Set viewing key multiple times across 10 blocks.
13. After set viewing key, open a new channel to the user using the new viewing key (reopen channel that already existed with previous viewing key).
14. Try to create a note to a channel associated with the old viewing key after SetViewingKey.
15. Try to open a new channel using the old viewing key (should fail, only new viewing key should be accepted).
16. Try to open a new subchannel using the old viewing key (should succeed, viewing key isn't checked on subchannels).
17. Migrate (transfer) all notes belonging to the user from their old viewing key to the new viewing key after SetViewingKey.

# General Notes
- After each `execute_actions` call, verify external (token) balances.
- After each `execute_actions` call, verify internal (privacy) balances.
- Try to modularize flows, so we can share modules across different flows (i.e. merging notes, depositing to a single note).
- Use test parameters to create multiple similar tests at once.

# Set compliance public key
- register+withdraw (enc with compliance pub key), set compliance pub key, register+withdraw, test its the right compliance key + right encryption (try to decrypt) for both before and after the set.