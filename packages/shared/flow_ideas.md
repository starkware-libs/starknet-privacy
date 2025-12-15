# Flow Ideas
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

### Server
1. Unauthorized Transfer: User tries to spend a note they don't own - should fail.

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
