# Shared project instructions

This project is maintained with both Codex and Claude Code. Before making changes, read:

1. `CLAUDE.md` for architecture, commands, conventions and security rules. These apply to both agents.
2. `PROJECT_STATUS.md` for current ownership, blockers and the latest handoff.
3. `TODO.md` for the shared backlog, known issues and deferred work.

Keep task state in these shared files rather than in agent-specific copies. On completion, update the relevant
TODO/issue and `PROJECT_STATUS.md` with the date, authoring agent, implemented behavior, verification results,
remaining limitations and whether the running app was updated. Record an actual blocker with its cause and the
next action needed to unblock it; an unstarted backlog item is not a blocker.

Check `git status` and the current diff before editing. Preserve existing uncommitted work. Do not have two agents
edit the same working tree concurrently; use a separate worktree for independent simultaneous work. When taking
over, re-read the current files and shared status instead of relying on another session's conversation.

Do not mark a task complete until its implementation and appropriate checks are finished. Use the existing
typecheck, tests and build for application changes; record any verification that could not be performed.

Before every push, follow the privacy and secret checks in `CLAUDE.md` under "Publishing checks". This is a
standing user requirement for both agents, including documentation-only changes.
