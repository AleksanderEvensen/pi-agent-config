# Subagent POC follow-up

These cases are not covered by the current WIP proof of concept:

- [ ] Separate result reporting from automatic shutdown. Agents with `auto-exit: false` (the default) do not load the reporting extension, but the parent still watches for a result and promises automatic delivery. Load reporting for all children and make shutdown conditional on `auto-exit`.
- [ ] Detect children that terminate without a result. Startup failures, crashes, or closed panes can leave the parent polling indefinitely. Monitor child/process or pane termination, report a failure when no result was produced, and clean up the watcher and temporary files.
