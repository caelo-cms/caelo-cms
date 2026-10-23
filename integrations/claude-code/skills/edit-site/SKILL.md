---
name: edit-site
description: Edit a Caelo CMS site through the caelo MCP tools without putting the live site at risk - work in the draft, check the result, stage it, and leave Publish live to a person. Use for any change to pages, modules, templates, the theme, media or SEO of a Caelo site, and before telling the user a change is "done" or "live".
---

# Edit a Caelo site safely

Caelo's rule: the agent builds, a person decides what goes live. Every write lands in the site's shared draft with snapshots; nothing reaches visitors until a person clicks **Publish live** in the Caelo admin. Work inside that rule, never around it.

## The loop

1. **Open a session.** Call `caelo_open_session` once (it resumes the user's latest open session; pass `newSession: true` only if the user asks for a fresh one). For an experiment or redesign the user wants to keep apart from other work, call `start_isolated_branch` right after, before the first change.
2. **Read the site's rules.** Call `caelo_get_context` once and follow it. It carries the site model, the tool playbook, brand voice and the skills index. Load every skill it marks ALWAYS APPLIES with `load_skill` before the work it covers; load others when a task matches them. The install's own skills are more specific than this one; where they differ, follow them.
3. **Make the change.** Prefer the bulk tools the context recommends (for example `build_page` for a page with several modules). Changes that are hard to undo (themes, layouts, templates, users, domains, deploys, bulk deletes) are approval-gated: call the tool, tell the user what you requested, and that they approve the card in the Caelo admin. The call waits for the decision; if it times out, call `caelo_await_approval` with the proposal id. Never re-propose a pending proposal and never claim a gated change happened before it was approved.
4. **Look at it.** Use `screenshot_page` for the visual impression and `list_unpublished_changes` to confirm what you changed.
5. **Stage.** Call `stage_changes` when the work is finished. It builds the protected staging site and runs the quality check. Then call `get_quality_audit` and fix every finding it names (target: 100 in every Lighthouse category, zero findings), stage again and re-read until it passes. Report only what you proved cannot be fixed in the site.
6. **Hand over.** Call `get_publish_gate` to see whether Publish live is open. Tell the user what changed, where to review it (`get_staging_access` gives the staging URL), and that publishing is their click in the Caelo admin.

## Going live

Never tell the user a change is live after `stage_changes`; it is on staging only. Publishing the draft is always the user's click on **Publish live**. If the user explicitly asks you to ship staging to production, you can request it with `propose_deploy_promote`: it is approval-gated, so the user still approves the card in the Caelo admin, and nothing is live until they do.

## Undo

- Unstaged work of this session: `undo_this_chat` (it asks before touching another session's changes).
- Staged or published changes: `propose_revert_page`, `propose_revert_module`, or `revert_chat_changes` for a whole session; each needs the user's approval.

## Do not

- Ask the user to paste a prompt into the Caelo admin chat, or to do a step there that a tool here can do.
- Paste the MCP token or staging credentials into files, commits or chat.
- Edit the generated static output; change the source pages, modules and theme in Caelo instead.
