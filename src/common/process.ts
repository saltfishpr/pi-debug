import treeKill from "tree-kill";

/** Send a signal to a process and its descendants. */
export function killProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  return new Promise((resolve, reject) => treeKill(pid, signal, (error) => (error ? reject(error) : resolve())));
}
