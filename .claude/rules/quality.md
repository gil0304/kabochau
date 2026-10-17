# Quality gates

1. Compile/typecheck/build passes via existing scripts. Add a meaningful `typecheck` script if practical and a lightweight unit test suite for landmark normalization, face-to-carve parameter mapping, capture composition calculations and resilience to missing data.
2. Functional evidence: LIVE uses live camera and tracked features, CARVE uses those features or photo import; output is not a placeholder. Both save outputs.
3. Manual browser checklist in README: iPhone Safari, Android Chrome, desktop; camera prompt/deny/retry, rotate portrait/landscape, face enter/leave, mouth/blink/smile, two faces, retake, PNG open, no clipping, image upload, low-light, reduced performance, WebGL fallback.
4. Prevent memory leaks and hidden video tracks after teardown.
5. Explain known limitations rather than misrepresenting untested features.
6. Do not weaken TypeScript config, suppress errors globally, or leave commented placeholder functionality to pass builds.
7. Do not push to remote or publish without separate explicit instruction.
