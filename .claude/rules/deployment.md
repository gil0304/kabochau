# Deploy Now deployment preparation

Target: LOLIPOP! Deploy Now. Use npm and supported Nuxt framework. Node.js >= 22.12.0 for lolipop CLI. Verify current instructions from https://deploy.lolipop.jp/docs/cli when preparing release.

Deployment is a SEPARATE user-authorized action. For implementation task: provide README deployment guide, ensure `npm run build` works, ensure static assets/model WASM accessible via production paths, ensure webcam works on HTTPS. Do not deploy spontaneously.

When user explicitly instructs to deploy:
- Confirm local build and user authentication using current CLI guidance.
- Official commands include `npx lolipop deploy` (may invoke login) and optionally new project `npx lolipop deploy --name pumpkin-me --framework nuxt` if supported by installed CLI/version; inspect `--help` if uncertain.
- First-time CLI login/user account authorization may require manual interaction; do not bypass.
- Verify deployed URL and camera/save behavior if browser tooling is available; otherwise state remote device verification needed.
- Never embed tokens/credentials in repository.
