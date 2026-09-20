# Security

Handoff can act in authenticated browser tabs, run model-authored code in its sandbox, and make network requests. Review tasks, monitor progress, and stop unexpected actions. Page content and model output are untrusted inputs. A sandbox does not make every browser action safe.

The local bridge binds to loopback. Its HTTP clients use a locally stored token; extension connections follow a separate origin check. Do not expose the bridge to a network or treat local processes as untrusted tenants. Disable it in Settings → Behavior if you do not use local agent delegation.

Keep credentials and signing keys out of Git. Broad browser permissions and locally stored credentials make browser-profile access sensitive. See [PRIVACY.md](PRIVACY.md) for the data sent to providers and retained locally.

## Reporting a concern

Do not post credentials, personal browser data, or a working exploit in a public issue. Use the hosting repository's private vulnerability-reporting channel when available. If none is configured, open a minimal issue asking the maintainer for a private contact method without disclosing the sensitive details.

Maintainers should configure a private reporting channel before inviting public security reports. This source distribution does not embed an individual's email address.
