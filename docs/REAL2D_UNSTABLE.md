# Real2D Branch Status: Unstable

The `real2d` branch is an experimental branch and is not part of the npm publish path.

Current status:

- Local mock Real2D bridge works as a protocol proof of concept.
- fal.ai `ai-avatar` integration is technically connected, but generation latency is too high for the current LiveUI interaction model.
- The feature should remain out of `main` until the renderer path has a clear product experience, predictable latency, and better UI state handling.

Publishing guidance:

- Publish npm releases from `main`, not from `real2d`.
- Do not merge this branch into `main` before a separate stabilization pass.
- Keep this branch available for future renderer experiments.
