// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "deploy/kubernetes.yaml");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const documents = parseAllDocuments(await readFile(manifestPath, "utf8"));
const parseErrors = documents.flatMap((document) => document.errors);
assert(
  parseErrors.length === 0,
  `invalid deployment YAML: ${parseErrors.map((error) => error.message).join("; ")}`,
);

const resources = documents.map((document) => document.toJS());
const one = (kind) => {
  const matches = resources.filter((resource) => resource.kind === kind);
  assert(matches.length === 1, `deployment must contain exactly one ${kind}`);
  return matches[0];
};

assert(
  resources.length === 4,
  "deployment must contain only PVC, Deployment, Service, and NetworkPolicy",
);
const claim = one("PersistentVolumeClaim");
const deployment = one("Deployment");
const service = one("Service");
const networkPolicy = one("NetworkPolicy");

assert(
  claim.spec.accessModes.length === 1 &&
    claim.spec.accessModes[0] === "ReadWriteOncePod",
  "session PVC must use ReadWriteOncePod",
);

assert(
  deployment.spec.replicas === 1,
  "hosted Nettle supports exactly one replica",
);
assert(
  deployment.spec.strategy?.type === "Recreate",
  "deployment strategy must be Recreate",
);
const appLabels = deployment.spec.template.metadata.labels;
assert(
  deployment.spec.selector.matchLabels?.["app.kubernetes.io/name"] ===
    "nettle" && appLabels?.["app.kubernetes.io/name"] === "nettle",
  "deployment selector and Pod labels must select only Nettle",
);

const pod = deployment.spec.template.spec;
assert(
  pod.automountServiceAccountToken === false,
  "service-account token automount must be disabled",
);
assert(!pod.serviceAccountName, "deployment must not select a service account");
assert(
  pod.hostNetwork !== true && pod.hostPID !== true && pod.hostIPC !== true,
  "host namespaces are forbidden",
);
assert(!pod.initContainers, "hosted Nettle must not use init containers");
assert(
  !pod.ephemeralContainers,
  "hosted Nettle must not use ephemeral containers",
);
assert(
  pod.containers.length === 1,
  "hosted Nettle must run in exactly one container",
);
assert(
  pod.securityContext?.seccompProfile?.type === "RuntimeDefault",
  "pod must use RuntimeDefault seccomp",
);

const container = pod.containers[0];
assert(
  container.name === "nettle",
  "the single container must be named nettle",
);
assert(
  /^ghcr\.io\/xlsynth\/nettle@sha256:(?:[a-f0-9]{64}|REPLACE_WITH_PUBLISHED_DIGEST)$/.test(
    container.image,
  ),
  "image must use the expected registry and an immutable digest",
);
assert(container.args?.[0] === "host", "container must run nettle host");
for (const argument of [
  "--bind-address=0.0.0.0",
  "--port=8080",
  "--web-root=/opt/nettle/web",
  "--storage-root=/data",
  "--scratch-root=/scratch",
]) {
  assert(
    container.args.includes(argument),
    `container is missing required argument ${argument}`,
  );
}

const security = container.securityContext;
assert(
  security?.runAsNonRoot === true,
  "container must require a non-root user",
);
assert(
  security?.runAsUser === 10001 && security?.runAsGroup === 10001,
  "container must run as 10001:10001",
);
assert(
  security?.allowPrivilegeEscalation === false,
  "privilege escalation must be disabled",
);
assert(
  security?.readOnlyRootFilesystem === true,
  "root filesystem must be read-only",
);
assert(security?.privileged !== true, "container must not be privileged");
assert(
  security?.capabilities?.drop?.includes("ALL"),
  "all Linux capabilities must be dropped",
);

assert(
  container.ports?.length === 1 && container.ports[0].containerPort === 8080,
  "container must declare only web port 8080",
);
const mounts = new Map(
  container.volumeMounts.map((mount) => [mount.name, mount.mountPath]),
);
assert(mounts.size === 2, "container must mount only sessions and scratch");
assert(
  mounts.get("sessions") === "/data",
  "session PVC must be mounted at /data",
);
assert(
  mounts.get("scratch") === "/scratch",
  "scratch volume must be mounted at /scratch",
);

assert(
  pod.volumes.length === 2,
  "Pod must declare only sessions and scratch volumes",
);
const volumes = new Map(pod.volumes.map((volume) => [volume.name, volume]));
assert(
  volumes.get("sessions")?.persistentVolumeClaim?.claimName ===
    "nettle-sessions",
  "sessions volume must use the nettle-sessions PVC",
);
assert(
  volumes.get("scratch")?.emptyDir?.sizeLimit === "4Gi",
  "scratch must be a bounded emptyDir",
);
assert(
  pod.volumes.every((volume) => !volume.hostPath),
  "hostPath volumes, including container-runtime sockets, are forbidden",
);

assert(
  service.spec.type === "ClusterIP",
  "web service must remain cluster-internal",
);
assert(
  service.spec.selector?.["app.kubernetes.io/name"] === "nettle",
  "web service must select the Nettle Pod",
);
assert(
  service.spec.ports.length === 1,
  "web service must expose exactly one port",
);
assert(
  service.spec.ports[0].port === 8080 &&
    service.spec.ports[0].targetPort === "http",
  "web service must expose only container port 8080",
);

assert(
  networkPolicy.spec.policyTypes.length === 1 &&
    networkPolicy.spec.policyTypes[0] === "Egress",
  "network policy must select outbound traffic only",
);
assert(
  networkPolicy.spec.podSelector?.matchLabels?.["app.kubernetes.io/name"] ===
    "nettle",
  "network policy must select the Nettle Pod",
);
assert(
  Array.isArray(networkPolicy.spec.egress) &&
    networkPolicy.spec.egress.length === 0,
  "network policy must deny all egress",
);

console.log("hosted deployment invariants are valid");
