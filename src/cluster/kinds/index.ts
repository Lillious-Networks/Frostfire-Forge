// The ghost kinds that have no engine module of their own to register them
// (players register from receiver.ts, creatures from systems/creatures). Loaded
// by startCluster only, so cluster-off never imports these.
export async function loadGhostKinds(): Promise<void> {
  const { registerObjectGhosts } = await import("./objects");
  registerObjectGhosts();
}
