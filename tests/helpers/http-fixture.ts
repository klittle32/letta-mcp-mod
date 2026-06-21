import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export interface StartedHttpFixture {
  url: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

export async function startHttpFixture(
  fixturePath: string,
  options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<StartedHttpFixture> {
  const child = spawn(process.execPath, [fixturePath], {
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  const timeoutMs = options.timeoutMs ?? 2_000;
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for fixture URL. stderr: ${stderr.join("")}`));
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited before startup: code=${code} signal=${signal} stderr=${stderr.join("")}`));
    });

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.url !== "string") throw new Error("missing url");
        clearTimeout(timer);
        resolve(parsed.url);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });

  return {
    url,
    child,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}
