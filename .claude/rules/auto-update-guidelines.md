## Auto-update Code Guidelines

**MUST trigger when:**
- Receiving feedback from the user or PR reviewers about code quality, style, or best practices
- After verification of any task where a reusable lesson was learned

**Actions:**
1. Implement the requested fix (if applicable)
2. **Generalize the lesson** and update `.claude/rules/code-style.md`:
   - Extract the underlying principle, not the specific fix
   - Frame past fixups as illustrative examples, not as the rule itself
   - Add under the appropriate section (Naming, Documentation, Edge Cases, Comments, Testing)
   - If no section fits, create a new one or add to the WIP section

Lessons from code reviews and task completion must accumulate as reusable principles - no exceptions.
