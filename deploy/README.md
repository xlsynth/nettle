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
sessions. `/scratch` is a bounded `emptyDir` used for archive extraction,
compiler work, and explicitly enabled Azure imports. Neither path uses the
container's read-only root filesystem.

The included egress-deny policy prevents the Pod from making outbound network
connections when the cluster CNI enforces NetworkPolicy. If an internal
authentication sidecar or other site policy needs egress, add only the
specific destinations it requires.

## Optional Azure blob imports

Azure imports are disabled by default. Set `NETTLE_AZURE_ENABLE=1` in the
container environment to show an Azure path field on the landing page. Paste
an `az://` bundle or source archive path and press Enter. The image includes
`bbb`; Nettle verifies the blob size with `bbb ll --machine` before running
`bbb cp` to download the file into `/scratch`, then opens it through the normal
hosted upload pipeline. The downloader inherits a hard file-size limit, so an
oversized or changing blob cannot exhaust scratch used by other builds.

You must sign in to Azure with `bbb` yourself. For example, open a shell in the
running container and use the authentication method required by your Azure
account. If `bbb` stores login information in a file and the container has a
read-only root filesystem, give it a writable mounted credentials directory.
Nettle never stores Azure credentials or contacts Azure directly.

The included Kubernetes configuration blocks all outbound network connections.
Azure imports therefore will not work until your administrator explicitly
allows access to DNS, Azure Blob Storage, and the Azure sign-in service.
Setting `NETTLE_AZURE_ENABLE=1` does not change that network policy.

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
