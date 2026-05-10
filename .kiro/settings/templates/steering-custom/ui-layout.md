# UI Layout Standards

[Purpose: capture common UI parts, page shell, and shared layout rules]

## Scope
- Common header and page shell
- Shared buttons, cards, forms, and error display
- Auth-dependent navigation and route protection

## Page Shell
- Define the global page structure (`Header` + centered main container)
- Define common width, spacing, and card usage
- Describe when pages use single-column vs multi-column layout

## Common UI Parts
- Buttons: default, primary, danger
- Cards: shared border, radius, spacing
- Forms: labels, inputs, textarea, validation message placement
- Errors: inline field error vs section-level error

## Navigation
- Header links for authenticated and unauthenticated states
- Common transition rules for login-required pages
- Protected route behavior and fallback destination

## Layout Rules
- Prefer reusable layout patterns over page-specific ad hoc styles
- Keep shared layout in common components or shared CSS
- Document auth-dependent visibility rules for common UI

---
_Focus on shared UI and page-shell rules, not per-screen inventories._
