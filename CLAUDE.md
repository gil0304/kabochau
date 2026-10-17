# PUMPKIN ME — Claude Code project instructions

Read `.claude/rules/product.md`, `.claude/rules/architecture.md`, `.claude/rules/quality.md`, and `.claude/rules/deployment.md` before implementing. These files are the source of truth for this project.

## Mission
Build a deployable Halloween web app with LIVE and CARVE modes. Implement real behavior, not attractive mockups. Prioritize the user's identifiable facial geometry, a visually compelling pumpkin, minimal UI, privacy, and mobile Safari support.

## Operating mode
- Execute end to end: inspect repo, scaffold if empty, implement, test, build, fix, and report. Do not stop after writing a plan.
- Do not ask preference/implementation questions when reasonable defaults exist. Make sensible decisions and document them.
- Ask only when blocked by necessary user credentials, irreversible external actions, or genuinely missing indispensable information.
- Deployment to a public URL is **not** authorized by initial implementation request alone. Prepare and validate; deploy only when explicitly instructed.
- Do not claim tests or camera performance passed if not run on actual browser/hardware.
- At completion, give a concise report with files changed, commands run, pass/fail, limitations, and deployment steps.

## Commands
Use npm (not pnpm/yarn). Typical commands after scaffolding: `npm run dev`, `npm run build`, `npm run typecheck`, `npm run test` (only if defined). Check package.json first.

## Critical constraints
- Nuxt + TypeScript, Three.js, MediaPipe Face Landmarker.
- Client-side camera processing; never upload face images or landmarks to backend.
- No accounts, database, analytics, paid image-generation APIs.
- Both modes must be functional; photo upload fallback for CARVE.
- Avoid hard-coded fake camera feed / preset pumpkin masquerading as personalization.
- No writing secrets to repo or exposing credentials.
- Prefer clearly working visual depth illusion over unstable mesh Boolean operations when necessary, but record the actual approach and limitations.

## Skills
- `.claude/skills/implement-pumpkin/SKILL.md`: full implementation flow.
- `.claude/skills/verify-pumpkin/SKILL.md`: quality checks.
- `.claude/skills/deploy-pumpkin/SKILL.md`: public deployment flow, explicit user approval required.
