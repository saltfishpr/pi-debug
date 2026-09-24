import { createServer } from "node:net";

/** Reserve an ephemeral TCP port on the loopback interface. The port is released before returning. */
export async function pickFreePort(host = "127.0.0.1"): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!address || typeof address === "string") throw new Error("Failed to allocate an ephemeral TCP port.");
  return address.port;
}
