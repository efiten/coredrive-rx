# Security policy

## Supported versions

Only the latest release gets security fixes. Older versions are not patched; upgrade to the
newest tag on the [releases page](https://github.com/efiten/coredrive-rx/releases).

## Reporting a vulnerability

Please report privately through GitHub:
[Report a vulnerability](https://github.com/efiten/coredrive-rx/security/advisories/new).
Do not open a public issue for it.

Include what you found, how to reproduce it, and which version or deployment you tested. The
follow-up happens in that private advisory, and a fix is published as a new release with the
advisory linked.

## Scope

In scope: the code in this repository, the published release zips, and the service worker.

Not a vulnerability by design:

- **The MQTT credentials in `config.json` are readable by anyone who opens the app.** They are
  a shared, publish-only account. What a client may publish is enforced by the broker's ACL,
  which binds each client to its own topic (see the README, "EMQX: a publish-only account").
  A broker that grants more than that is a deployment problem; report it to whoever runs that
  deployment.
- Problems in a specific deployment (its broker, CoreScope server or web server) belong to the
  operator of that deployment. Problems in CoreScope itself belong in the
  [CoreScope repository](https://github.com/Kpa-clawbot/CoreScope).
- Problems in MeshCore firmware belong in the
  [MeshCore repository](https://github.com/meshcore-dev/MeshCore).
