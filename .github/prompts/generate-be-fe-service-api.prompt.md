---
description: "Generate BE to FE service API wiring in this Tauri app. Use when: adding new Tauri commands, creating typed invoke wrappers, and adding React Query query options with exported query keys (prefer query keys + queryOptions over custom query hooks)."
name: "Generate BE-FE Service API"
argument-hint: "Describe the feature/API to add, including command names, request params, response types, and cache behavior"
agent: "agent"
---

# Generate BE to FE Service API (Tauri 2 + React Query)

Implement end-to-end API wiring from Rust backend to frontend service/query layer for this repository.

Reference and follow these rules in priority order:
- Priority 1: Keep repository-wide conventions from [copilot-instructions](../copilot-instructions.md).
- Priority 2: Apply domain-specific rules from exactly one matching domain file first.
  - Sync and devices work: [sync-service instructions](../instructions/sync-service.instructions.md)
  - OAuth and Drive auth work: [google-drive-sso instructions](../instructions/google-drive-sso.instructions.md)
- Priority 3: If multiple rules overlap, prefer the most specific rule for the file being changed.

Supporting references:
- [copilot-instructions](../copilot-instructions.md)
- [sync-service instructions](../instructions/sync-service.instructions.md)
- [google-drive-sso instructions](../instructions/google-drive-sso.instructions.md)

## Inputs

Use this request as the task definition:

$args

If details are missing, infer from the single most similar existing feature in the same layer (Rust command, tauri service wrapper, or query file), and prioritize consistency with that feature's naming, file placement, and typing style. Do not stop at analysis; complete implementation.

## Required Output Pattern

### 1) Rust command layer

- Add or update Rust command handler in src-tauri/src/lib.rs (or feature module when applicable).
- Keep command signatures and serde naming aligned with existing models in src-tauri/src/models.rs and src/types/dashboard.ts.
- Return Result<DashboardData, String> when the operation mutates dashboard state; otherwise return a typed result that matches existing patterns.
- Ensure apply_path_overrides is called before returning DashboardData.
- Register new command in tauri::generate_handler!.

### 2) Frontend invoke service layer

- Add typed invoke wrapper(s) in src/services/tauri.ts.
- Use invoke<T>() with explicit request and response typing.
- Keep all FE-to-Rust IPC in src/services/tauri.ts only.

### 3) React Query layer (key-first, options-first)

- Prefer exported query key factories and exported queryOptions objects/functions.
- Prefer consuming query keys/queryOptions directly at call sites.
- Do not default to creating custom query hooks for basic fetching.
- Only create custom hooks when there is meaningful orchestration logic (multiple queries, derived behavior, side effects) that cannot be expressed cleanly by key/options usage.

Required shape to prefer:

- Export key constants/factories from queries/keys.ts or feature query file.
- Export queryOptions factory from feature query file.
- Reuse the same key factory for invalidation and cache updates.

Example style to follow:

```ts
export const detailKeys = {
  all: ["detail"] as const,
  byId: (id: string) => [...detailKeys.all, id] as const,
};

export const gameDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: detailKeys.byId(id),
    queryFn: () => getGameDetail(id),
    enabled: Boolean(id),
  });
```

### 4) Type alignment

- Update src/types/dashboard.ts for FE types when backend models change.
- Keep camelCase consistency between Rust serde and TypeScript.
- Avoid any/unknown casts unless unavoidable; if unavoidable, isolate and justify.

### 5) Validation

- Run frontend type/build checks (at minimum npm run build).
- If Rust changed, run cargo check (or equivalent project check) and fix relevant errors.
- Summarize what was changed and list affected files.

## Implementation Rules

- Preserve existing architecture and naming conventions.
- Keep edits minimal and scoped to the requested feature.
- Do not refactor unrelated modules.
- Keep query cache behavior explicit with stable, reusable keys.
- Prefer key-based invalidation over ad-hoc string keys.

## Response Format

Return:
1. What was implemented.
2. File-by-file changes.
3. Query key + queryOptions exports added.
4. Validation commands run and results.
5. Any assumptions made.
