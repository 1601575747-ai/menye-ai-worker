# menye-ai-worker

CloudBase auto deploy test marker: 2026-05-14.

## Scene effect switch

By default, scene-effect jobs use the image API to generate the final scene from the uploaded background and door references. The older backend direct-composite path is kept in code but disabled.

Set `ENABLE_DIRECT_BACKGROUND_COMPOSITE=true` to restore backend direct placement/compositing for background-reference jobs.
