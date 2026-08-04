<!-- SPDX-License-Identifier: MPL-2.0 -->

# @caelo-cms/edge-router

Locale-aware edge request router for [Caelo CMS](https://github.com/caelo-cms/caelo-cms)
deployments. Maps incoming visitor URLs onto the static site's locale/URL
strategy (prefix, domain, or hybrid) from the deploy manifest — the same
routing logic everywhere a request first lands:

- the provisioning stacks' edge handlers bundle it at provision time
  (Lambda@Edge on AWS; the equivalent edge hooks on the GCP and Azure
  stacks),
- the static generator uses it to precompute per-locale routes.

It is published as part of Caelo's lockstep release because the shipped
`@caelo-cms/provisioning` package depends on it at provision time. It has no
runtime dependencies.

You normally don't install this directly — it comes in through
`bunx @caelo-cms/provisioning`. See the
[main repository](https://github.com/caelo-cms/caelo-cms) for documentation.

## License

MPL-2.0
