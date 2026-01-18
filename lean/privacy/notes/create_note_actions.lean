import privacy.actions
import privacy.notes.discoverable
import privacy.notes.note_implies
import privacy.utils

def create_note_actions (crypto: Crypto) (rm: ReachableMemory crypto) : List CreateNoteInput :=
  rm.actions.filterMap filter_CreateNote

theorem create_note_actions_add
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (success: (run_action crypto (.CreateNote inp) rm.m).success) :
    (create_note_actions crypto (rm.add (.CreateNote inp) success)) =
    inp :: create_note_actions crypto rm := by
  simp [create_note_actions]

theorem create_note_actions_add'
    {crypto: Crypto} {rm: ReachableMemory crypto} {action: Action}
    (success: (run_action crypto action rm.m).success)
    (h: filter_CreateNote action = none) :
    (create_note_actions crypto (rm.add action success)) =
    create_note_actions crypto rm := by
  simp only [create_note_actions, ReachableMemory.add, List.filterMap_cons, h]

theorem NoteImplies.in_create_note_actions
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    inp ∈ create_note_actions crypto rm := by
  simp [create_note_actions]
  use .CreateNote inp
  simp [note_imp.h_action]

theorem NoteImplies.from_create_note_actions
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (h: inp ∈ create_note_actions crypto rm) :
    Nonempty (NoteImplies rm inp) := by
  simp only [create_note_actions, List.mem_filterMap, filter_CreateNote_some, exists_eq_right] at h
  exact NoteImplies.from_action h
