
### Features
- 373107af core links check on the staged build (#849) (#851)
- 99ae9e02 drop the gateway's former cms_admin login — contract (#635, 4/4, release after #767) (#775) ⚠ BREAKING
- 3b1785fb core structure check + write-time hints for repeated free markup (#820) (#833)
- 60410665 release docs-sync prepare step + developer reference generator (#832)

### Fixes
- 31d3c091 favicon 64px rendition (LCP) + no auto fix round after an operator decision (#685) (#853)
- 4404da9f staged GCS reads fall back to live only for files the build contains (#842) (#848)
- 32272c75 enforce auth_config, server-side captcha/honeypots, HTML escaping, and ai_moderate archival (#847)
- 09a1ef25 prevent X-Forwarded-For spoofing, bind PoW challenges, rate-limit challenge minting, and guard cross-site POSTs (#845)
- 4387310d scan content values for internal links by declared field kind (#846) (#850)
- e199ee99 harden AST validator, sandbox bootstrap, and schema UUID checks (#839)
- 92c1f67c GCS publish deletes live files the build no longer contains (#842) (#843)
- 2398af1c name a Caelo upgrade in the parity refusal and always offer Stage again (#834, #835) (#836)

### Docs
- 2ce399a7 Claude Code Power-MCP example, good-first-issue and Discussions links (#840)
- 3fd78e88 fix the local dev loop (root .env, Bun 1.4.2, staging URL, importer allowlist) (#838)
- 8ca727d9 split developer docs (repo) from end-user docs (CMS seed), PR template + user-facing label (#826, #829) (#830)
