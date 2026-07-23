<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hosted Nettle deployment

[`kubernetes.yaml`](kubernetes.yaml) is a minimal single-replica deployment for
the internal hosted service. It creates exactly one Nettle Pod containing one
container. The container serves the web application, owns the persistent
filesystem queue, and runs Slang and Yosys as ordinary child processes.
Nettle does not create Pods or containers and has no Kubernetes API or
container-runtime credentials.

## Prerequisites

- A Linux/amd64 Kubernetes node. The pinned Slang and OSS CAD Suite artifacts
  in the combined image are currently amd64-only.
- A default StorageClass that supports `ReadWriteOncePod`, or an explicit
  `storageClassName` added to the PVC.
- A CNI that enforces `NetworkPolicy`.
- An existing ingress controller or private-cloud gateway that terminates TLS
  and restricts reachability to the equally trusted user group. Per-user
  authentication is optional and site-dependent.
- A site-specific ingress `NetworkPolicy` or equivalent service-mesh rule when
  that gateway is the private-cluster access boundary.

## Configure and apply

Build the `nettle` target, publish it to an internal registry, and replace
`REPLACE_WITH_PUBLISHED_DIGEST` with the resulting `sha256` digest. A mutable
tag is deliberately not accepted as the deployment pin.

Review these site-specific values before applying the manifest:

- PVC size and StorageClass;
- CPU, memory, and ephemeral-storage requests and limits;
- the 32-build queue bound;
- the 600-second build deadline; and
- `--evict-after=30d`. Remove that argument to retain completed artifacts until
  an admin deletes them.

Apply the resources in the namespace selected by the admin:

```sh
kubectl apply -f deploy/kubernetes.yaml
kubectl rollout status deployment/nettle
```

The `Recreate` strategy and `ReadWriteOncePod` claim enforce the v1
single-writer design. `/data` contains the durable queue and completed
sessions. `/scratch` is a bounded `emptyDir` used
for archive extraction, compiler work, and explicitly enabled Azure imports.
Neither path uses the container's read-only root
filesystem.

The included egress-deny policy prevents the Pod from making outbound network
connections when the cluster CNI enforces NetworkPolicy. If an internal
authentication sidecar or other site policy needs egress, add only the
specific destinations it requires.

## Optional Azure blob imports

Azure imports are disabled by default. Set `NETTLE_AZURE_ENABLE=1` in the
container environment to advertise **Open from Azure** in the hosted landing
page. The combined image includes a hash-locked `bbb` executable; Nettle runs
`bbb cp` to import a single supported blob into `/scratch` before processing it
with the existing hosted upload pipeline. Nettle does not acquire Azure
credentials, embed an Azure SDK, or authenticate `bbb`.

The checked-in `nettle-deny-egress` policy intentionally remains unchanged and
blocks Azure imports. An operator enabling this feature must separately add
the minimum site-approved egress required for DNS, Azure Blob Storage, and the
chosen identity provider. Setting the feature flag does not modify network
policy or grant network access.

Authenticate `bbb` inside the running container as user `10001`, or supply the
credentials accepted by your site's `bbb` configuration. Because the default
container root is read-only, any file-backed authentication cache needs an
explicit, appropriately protected writable mount or a supported writable path.
Do not relax the read-only root, mount credentials into the public web root,
or place credentials in session URLs or manifests.

The checked-in policy is intentionally egress-only because ingress-controller
namespace and Pod labels are cluster-specific. A `ClusterIP` is not an access
control boundary: add a site policy that allows traffic to the Nettle Pod only
from the selected ingress or gateway. Otherwise other in-cluster workloads may
bypass the HTTPS edge and the intended user-group boundary.

## HTTPS ingress

The manifest intentionally creates no Ingress because issuer names, hostnames,
optional authentication, and ingress annotations are installation-specific.
Configure the site's existing TLS ingress or gateway to route one HTTPS
hostname to Service `nettle`, port `8080`. Do not expose the Pod directly or
publish a second port.

At minimum, the edge must:

- redirect HTTP to HTTPS;
- use a valid certificate;
- suppress or redact both `/s/<capability-token>` and
  `/api/v1/sessions/<capability-token>/...` paths in access logs;
- set request-body limits and upload/read timeouts consistently with
  `--max-upload-bytes` rather than relying on a smaller ingress default;
- preserve `Content-Length` for bundle download progress; and
- restrict requests to the intended private-cloud user group, with group
  authentication if required by site policy.

Capability URLs are bearer secrets. Anyone who can reach the service and has a
session URL can view and download that session's `.nettle` bundle. Nettle v1
does not provide identity-based authorization or link revocation. It is
intended for a group of equally trusted users; uploaded content remains
untrusted even when its submitter is trusted.

## Operations

The liveness endpoint is `/healthz`; readiness is `/readyz`. Queue and session
state survive Pod replacement because they live on the PVC. If a running build
is interrupted, the server restores it to the queue and retries it once.

Only one replica is supported. Do not change `replicas`, `Recreate`, or the PVC
access mode without first adding cross-process queue coordination.

Storage exhaustion returns HTTP 507 without deleting unexpired sessions. An
admin can increase the PVC or remove old session directories while the service
is stopped. When automatic retention is configured, Nettle also sweeps expired
terminal sessions on startup and hourly.
