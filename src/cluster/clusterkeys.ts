import crypto from "crypto";

// The cluster's own secret (CLUSTER_LINK_SECRET), held by the nodes and the coordinator only. The client tickets
// keep GATEWAY_GAME_SERVER_SECRET, which the webserver and the gateway hold too: a process that can sign a ticket
// must not be able to pose as a node. Three keys are derived from it with HKDF-SHA256, one per use, so a signature
// made for a link hello can never pass on the bus or as a store record, nor any other way round.

/** The shortest CLUSTER_LINK_SECRET a node or coordinator starts with. */
export const CLUSTER_SECRET_MIN_LENGTH = 32;
export const LINK_KEY_LABEL = "cells-link-v1";
export const BUS_KEY_LABEL = "cells-bus-v1";
export const STORE_KEY_LABEL = "cells-store-v1";

export interface ClusterKeys {
  /** Signs and checks LINK_HELLO (linkproto.ts). */
  link: string;
  /** Signs and checks every bus envelope (bus.ts). */
  bus: string;
  /** Seals and opens the store records that carry authority (storeseal.ts). */
  store: string;
}

/** The three keys, as hex: 32 bytes each from HKDF-SHA256 over the secret, no salt, the label as info. */
export function deriveClusterKeys(secret: string): ClusterKeys {
  const derive = (label: string) => Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), label, 32)).toString("hex");
  return { link: derive(LINK_KEY_LABEL), bus: derive(BUS_KEY_LABEL), store: derive(STORE_KEY_LABEL) };
}

/**
 * The keys of CLUSTER_LINK_SECRET. Throws when it is unset or shorter than CLUSTER_SECRET_MIN_LENGTH: a cluster
 * process does not start without it. Names the variable and never its value.
 */
export function requireClusterKeys(env: Record<string, string | undefined> = process.env): ClusterKeys {
  const secret = env.CLUSTER_LINK_SECRET ?? "";
  if (secret.length < CLUSTER_SECRET_MIN_LENGTH) {
    throw new Error(
      `Cluster mode needs CLUSTER_LINK_SECRET set to at least ${CLUSTER_SECRET_MIN_LENGTH} characters: it signs the node links, the cluster bus and the store records (${secret ? "it is too short" : "it is not set"})`,
    );
  }
  return deriveClusterKeys(secret);
}
