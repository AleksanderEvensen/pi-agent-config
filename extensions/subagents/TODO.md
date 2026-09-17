# Subagent follow-up

- [ ] Detect children that terminate before producing a result. Startup failures, crashes, or manually closed panes currently leave the parent watcher waiting until session shutdown. The archived metadata and transcript make these runs recoverable, but the parent should also monitor pane/process termination and emit a failure automatically.
- [ ] Add an explicit retention policy for `/tmp/pi-subagent-run-*` archives if normal operating-system temporary-file cleanup is insufficient.
