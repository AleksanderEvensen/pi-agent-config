# Preferences

## TypeScript

- Never use `any` unless it is genuinely unavoidable or explicitly requested by the user.
- Prefer inferred types over anything else, otherwise precise types, generics, discriminated unions, that does not weaken the type safety.

## Commands

- Do not run development server commands such as `pnpm run dev`, `bun run dev`, or similar. Assume the dev server is already running. If it is not, ask the user to start it.
- Do not run build commands unless the user explicitly asks for them.
- Type checking without emitting is always acceptable, including `tsc --noEmit`, `tsgo --noEmit`, or project `typecheck` scripts.
- `tsgo` is installed globally and can be used for faster TypeScript checking when appropriate.
- Prefer verification commands that are fast and focused, such as type checks and lint checks:
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `bun run typecheck`
  - `bun run lint`
  - `tsgo --noEmit`

## Package Managers

- Use `pnpm` when the project uses it.
- Otherwise, use `bun`.
- Never use `npm` or `yarn` unless the user explicitly instructs otherwise.

## Code Style

- Always aim for concise, simple solutions.
- Prefer the least complex approach that solves the problem correctly.
- If a simpler solution is available, propose it before implementing a more complex one.
- Avoid unnecessary abstractions, broad rewrites, or speculative architecture.
