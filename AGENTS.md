# Agent guidance

## Project goal

World Studio is an AI-assisted world and scene builder for game developers. It turns a description of a location, its props and an art style into the following outputs:
- a concept image;
- isolated transparent cutouts for each prop and for an environment base with the props removed;
- one static GLB per part;
- an assembled scene that can be exported.

It follows rwrife/CharacterStudio's UX and design rules, with an orange accent (`--accent: #ff9a3c`).

The product is a local Windows desktop application. It drives a loopback-only ComfyUI for the following stages:
- SD 1.5/SDXL concepts;
- FLUX.2 klein 4B extraction;
- BiRefNet cutouts;
- Hunyuan3D 2 or TRELLIS.2 meshes.

It can optionally use a loopback Ollama vision model for prop detection.

All models are static. Do not add rigging, skinning or animation without an explicit product requirement. Generated meshes are approximations, not finished game assets. Treat broader world-building capabilities, such as navigable levels, collision and LODs, as goals rather than shipped features.

## Repository layout

- `src/main`: Electron lifecycle, IPC handlers, the world manager (jobs, persistence, export), the local ComfyUI and Ollama clients, workflow builders, pinned model downloads, and image and GLB validation.
- `src/preload`: the isolated bridge between the renderer and desktop services.
- `src/renderer`: React UI (`WorldPanel.tsx`), the Three.js scene viewport (`SceneViewport.tsx`) and the styles (`style.css`, `world.css`).
- `src/shared`: shared types, world schema and prompts, model packages, and scene placement helpers.
- `scripts`: the Playwright Electron smoke (`world-smoke.mjs`, with a procedural fixture ComfyUI) and the icon generator.
- `tests`: `node --test` TypeScript tests and their fixtures.
- `docs/screenshots`: repository-owned app captures used by the README.

## Development

Run commands from the repository root in PowerShell:

```powershell
npm install
npm run dev
```

- `npm run build` type-checks and builds into `out/`.
- `npm start` opens the build.
- `npm run smoke` launches the built app against a fixture ComfyUI, walks the full flow, and refreshes `docs/screenshots`. `npm run smoke -- --live` targets the configured real backend instead.

ComfyUI is a separately configured local dependency. It normally lives under `%LOCALAPPDATA%\ComfyUI`, with a loopback API at `http://127.0.0.1:8189`. Workspace data defaults to `%APPDATA%\WorldStudio`, and `STUDIO_DATA_DIR` overrides it. Do not install or replace backend packages indiscriminately.

## Implementation principles

- Keep world processing and inference local. Do not add uploads, remote inference or credential collection without an explicit product requirement. ComfyUI and Ollama URLs must stay loopback-only.
- Preserve Electron context isolation, sandboxing, the narrow preload bridge, and zod validation at IPC and filesystem boundaries.
- Reuse the shared types, prompts, limits and placement helpers. Keep persisted world manifests compatible, or provide explicit migrations.
- Use a single job slot, and cancel only the job's own ComfyUI prompt.
- Feed 3D generation only validated transparent cutouts, never the full concept.
- Report failures per item. Never represent failed, cancelled, skipped or partially exported work as complete.
- Model downloads must stay pinned to a revision and SHA-256, require user approval, and never overwrite non-matching existing files.
- Check GPU memory budgets and required native ComfyUI nodes before submitting work. Do not silently fall back to a different model.
- Never claim successful generation based on the fixture backend. Report actual observed results.
- Keep downloaded models, build output, user assets, logs, workspace data and credentials out of Git.

## Validation

For TypeScript or application behavior changes:

```powershell
npm test
npm run typecheck
```

For UI changes, run `npm run build` then `npm run smoke`, and inspect the screenshots it writes. Extra captures go to `artifacts\world-smoke`, which is ignored.

## README maintenance

- Update `README.md` in the same change whenever you add or materially change a user-facing feature, setup step, model requirement, export format or limitation. Use actual UI labels and working commands.
- Refresh the screenshots under `docs/screenshots` from real app captures, and inspect them before committing. Label fixture-backed captures as such. Screenshots are not proof of generation quality.
- Distinguish implemented functionality from prerequisites, unverified stages and future goals. If an integration result is unavailable, say so rather than inventing evidence.
