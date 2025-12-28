# Flow Ideas
## Open Channel
### Client + Server
1. Open 2 channels in succession.

## Deposit
### Client + Server
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

## Transfer
### Client + Server
1. Transfer end-to-end.
2. Split Transfer: User A sends to User B and gets change back.
3. Merge Transfer: User A combines multiple notes into one.
4. Double Spend: User tries to spend the same note twice - should fail.
5. Call server transfer twice with the same input.
6. User A transfer to user B, user B to user C, user C back to A.
7. User A transfer to users B and C, users B and C back to A.
8. User A split one note into two notes for themselves - should fail.
9. Make transfers and verify external balances don't change.
10. Make transfers and test user balances in contract.

### Server
1. Unauthorized Transfer: User tries to spend a note they don't own - should fail.

### Client
1. Test transfer use and create note same channel.
    1.1. Test transfer use and create note same channel same amount (actually same note).
    1.2 Test transfer use notes multi channels create note to one channel of the used notes.
    1.3 Test transfer use note one channel create notes multi channels that one of them is the channel of the used note.
    1.4. Test transfer use notes same channel create note same channel (merging notes).
2. Test transfer use and create note multi channels and multi amounts (also one with same channel and one with same amount).
3. Use many notes form the same channel.
4. Transfer many to many different partion of amounts.
5. Catch NOTE_NOT_FOUND: wrong user addr, wrong private key, wrong channel index, and wrong note index.

## Withdraw
### Client + Server
1. Withdraw end-to-end.
2. User withdraw different notes.
3. Call server withdraw twice with the same input.
4. User withdraw a note that was already nullified.
5. User withdraw a note from a non-existent channel (channel index).
6. User withdraw a note from a non-existent note (note index).
7. User withdraw multiple notes in a row.

### Server
1. User withdraw a note that doesn't belong to him (someone else's nullifier).
2. User withdraw a note that doesn't exist (invalid nullifier).

## Create note
1. Try to create same note twice in one transfer.
2. Try to create same note twice in different transfers.

## Use note
1. use note, change public key, try to use note again.
2. Try to use same note twice in one transfer.
3. Try to use smae note twice in different transfers.
4. Use note with wrong amount in transfer.

## Replace Public Key
### Client + Server
1. Withdraw, change public key, try to withdraw same note again.
2. Use note (transfer), change public key, try to withdraw note.
3. Use note (transfer), change public key, try to use (transfer) same note again.
4. Use note (withdraw), change public key, try to use (transfer) same note again.
5. Attempt to use multiple notes that were created for different public keys in the same transfer.
6. Deposit, change public key, deposit again.
7. Change public key, create note, withdraw with new key.
8. Create note, change public key, attempt to withdraw with old key.

### Server
1. Replace public key and verify that compliance is still able to view all user data.
2. Replace the public key multiple times across 10 blocks.
3. After replacing public key, open a new channel to the user using the new public key (reopen channel that already existed with previous public key).
4. Try to create a note to a channel associated with the old public key after public key replacement.
5. Try to open a new channel using the old public key (should fail, only new public key should be accepted).
6. Migrate (transfer) all notes belonging to the user from their old public key to the new public key after replacement.
