<!--
Thanks for the PR! A few reminders before submitting:

- One logical change per PR. Unrelated changes belong in their own PR.
- Keep the title under ~70 characters. Use the body for the "why".
- Don't bump the app version in feature PRs — versioning is handled via
  `npm run bump-version` by maintainers.
- If you change wire types, structured-block tags, or the agent prompt
  contract, call it out under "ACP contract impact" below — those touch
  both the Rust host and the TS UI.
-->

## Summary

<!-- 1–3 bullets describing what changes and, more importantly, why. -->

-

## Area

<!-- Tick what applies. Helps reviewers route. -->

- [ ] React UI (`src/`)
- [ ] Rust host (`src-tauri/`)
- [ ] Agent contract / `agent-skill.md`
- [ ] Scripts (`scripts/`) or release pipeline
- [ ] Docs only
- [ ] Other:

## ACP contract impact

<!--
Fill in if you touched any of:
- Fenced block tags (acp-section-map, acp-section, acp-comment-draft, acp-comment-result)
- Wire types shared between Rust serde and TS interfaces
- Streaming pipeline (acp_client.rs, fenced.rs, store.ts append/strip logic)
- The kickoff prompt or agent-skill.md

Otherwise write "none".
-->

## Test plan

<!-- What did you run, and what did you click through? -->

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `cd src-tauri && cargo test`
- [ ] Exercised in `npm run tauri -- dev` against a real PR
- [ ] Tested with agent(s):

## Screenshots / recordings

<!-- For UI changes. Delete the section if not applicable. -->

## Related issues

<!-- e.g. Closes #123, Refs #456 -->

## Notes for the reviewer

<!-- Anything non-obvious: tricky edge cases, follow-ups deferred, areas you'd
like a closer look at. Delete if there's nothing to add. -->
