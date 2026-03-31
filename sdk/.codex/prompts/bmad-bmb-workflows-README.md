# BMB Workflows

## Available Workflows in bmb

**agent**

- Path: `_bmad/bmb/workflows/agent/workflow.md`
- Tri-modal workflow for creating, editing, and validating BMAD Core compliant agents

**module**

- Path: `_bmad/bmb/workflows/module/workflow.md`
- Quad-modal workflow for creating BMAD modules (Brief + Create + Edit + Validate)

**workflow**

- Path: `_bmad/bmb/workflows/workflow/workflow.md`
- Create structured standalone workflows using markdown-based step architecture (tri-modal: create, validate, edit)

## Execution

When running any workflow:

1. LOAD {project-root}/\_bmad/core/tasks/workflow.xml
2. Pass the workflow path as 'workflow-config' parameter
3. Follow workflow.xml instructions EXACTLY
4. Save outputs after EACH section

## Modes

- Normal: Full interaction
- #yolo: Skip optional steps
