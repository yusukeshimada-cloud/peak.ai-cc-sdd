# Spec Governance Standards

[Purpose: capture shared rules for feature IDs, processing types, difficulty labels, and common-spec separation]

## Scope
- Feature decomposition rules
- Feature ID composition
- Processing type definitions
- Difficulty labels and evaluation policy

## Feature Decomposition
- One feature should represent one business function
- Do not split the same business function by frontend / backend layer only
- Shared concerns should be separated into common specifications instead of duplicated

## Feature ID Rules
- Declare the shared feature ID composition rule explicitly
- Declare which parts come from domain/group/function identifiers
- If the project derives a feature-type code, document the mapping clearly

## Processing Types
- Define allowed processing types consistently across feature lists and specs
- Explain the meaning of each processing type in one line

## Difficulty Rules
- Declare the allowed difficulty labels explicitly
- Explain the rough evaluation criteria (difficulty, effort, importance, integration)

---
_Focus on shared spec-governance rules, not per-feature catalogs._
