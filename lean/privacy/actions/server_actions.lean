import privacy.utils

inductive ServerAction where
  -- Writes `val` at `(t, key)`.
  | Write (t: MemoryType) (key: List ℕ) (val: ℕ)
  -- Verifies that the memory value at `(t, key)` is currently zero, and writes `val` instead.
  | WriteOnce (t: MemoryType) (key: List ℕ) (val: ℕ)
  -- Appends `val` to a list at `(t, key ++ [idx])`.
  -- `(t_idx, key)` is used to store the length of the list.
  | Append (t_idx t: MemoryType) (key: List ℕ) (val: ℕ) (h: t_idx = .ChannelsJ ∧ t = .Channels)
  -- Reads the value and asserts that it is equal to `val`.
  | Check (t: MemoryType) (key: List ℕ) (val: ℕ)
  -- Deposits `amount` of `token` into the open note `note_id`.
  | OpenDeposit (note_id amount token: ℕ)

def ServerAction.run (crypto: Crypto) (action: ServerAction) (m: Memory) : Memory × Bool :=
  match action with
  | .Write t key val => (write t key val m, true)
  | .WriteOnce t key val => (write t key val m, m t key = 0)
  | .Append t_idx t key val _ =>
    let idx := m t_idx key
    let m := write t_idx key (idx + 1) m
    let m := write t (key ++ [idx]) val m
    (m, true)
  | .Check t key val => (m, m t key = val)
  | .OpenDeposit note_id amount token =>
    let old_value := m .Notes [note_id, 0]
    let m := write .Notes [note_id, 0] (crypto.pack 1 amount) m
    (m, old_value = crypto.pack 1 0 ∧ m .OpenNoteToken [note_id] = token)

def ServerAction.run_all (crypto: Crypto) (actions: List ServerAction) (m: Memory) : Memory × Bool :=
  actions.foldl (λ (m, success) action ↦
    let (m, success') := ServerAction.run crypto action m
    (m, success && success')
  ) (m, true)

@[simp]
theorem ServerAction.run_all_nil (crypto: Crypto) (m: Memory) :
    ServerAction.run_all crypto [] m = (m, true) := rfl

@[simp]
theorem ServerAction.run_all_append_singleton
    {crypto: Crypto} (action: ServerAction) (actions: List ServerAction) (m: Memory) :
    (ServerAction.run_all crypto (actions ++ [action]) m).1 =
    (action.run crypto (ServerAction.run_all crypto actions m).1).1 := by
 conv => lhs; simp only [ServerAction.run_all]
 rw [List.foldl_append, List.foldl_cons, List.foldl_nil, ←ServerAction.run_all]

theorem ServerAction.run_all_append
    (actions₀ actions₁: List ServerAction) (m: Memory) :
    (ServerAction.run_all crypto (actions₀ ++ actions₁) m).1 =
    (ServerAction.run_all crypto actions₁ (ServerAction.run_all crypto actions₀ m).1).1 := by
  induction actions₁ using List.reverseRecOn
  case nil => simp
  case append_singleton action actions₁ ih =>
    rw [←List.append_assoc, ServerAction.run_all_append_singleton,
      ServerAction.run_all_append_singleton, ih]

abbrev process_action (crypto: Crypto) (m: Memory) (r_client: List ServerAction × Bool) : Memory × Bool :=
  let r_server := ServerAction.run_all crypto r_client.1 m
  (r_server.1, r_client.2 && r_server.2)
