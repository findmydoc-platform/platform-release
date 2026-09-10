import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

type Workflow = {
  readonly jobs: {
    readonly deploy?: {
      readonly steps?: readonly {
        readonly name?: string;
        readonly run?: string;
      }[];
    };
  };
};

const temporaryDirectories = new Set<string>();

const readEmbeddedVercelScript = (): string => {
  const workflowPath = path.resolve(
    import.meta.dirname,
    "../../.github/workflows/reusable-deploy-dashboard.yml",
  );
  const workflow = parse(readFileSync(workflowPath, "utf8")) as Workflow;
  const helper = workflow.jobs.deploy?.steps?.find(
    (step) => step.name === "Prepare platform Vercel helper",
  );
  const match = helper?.run?.match(/<<'EOF'\n([\s\S]*?)\nEOF/);

  expect(
    match?.[1],
    "Expected the platform workflow to embed the Vercel helper.",
  ).toBeDefined();
  return match?.[1] as string;
};

const runVercelOperation = (
  operation: "build" | "deploy",
  target: "preview" | "production",
  environmentOverrides: Record<string, string | undefined> = {},
) => {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "platform-dashboard-vercel-"),
  );
  temporaryDirectories.add(temporaryDirectory);
  const binaryDirectory = path.join(temporaryDirectory, "bin");
  const commandLog = path.join(temporaryDirectory, "vercel-command.log");
  const deploymentScript = path.join(
    temporaryDirectory,
    "dashboard-vercel-deployment.sh",
  );
  const fakePnpm = path.join(binaryDirectory, "pnpm");
  mkdirSync(binaryDirectory);
  writeFileSync(deploymentScript, readEmbeddedVercelScript());
  chmodSync(deploymentScript, 0o700);

  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'DEPLOYMENT_ENVIRONMENT=%s\\n' "$DEPLOYMENT_ENVIRONMENT"
  printf 'DEPLOYMENT_COMMIT_SHA=%s\\n' "$DEPLOYMENT_COMMIT_SHA"
  printf 'RELEASE_VERSION=%s\\n' "\${RELEASE_VERSION-<unset>}"
  printf '%s\\n' "$@"
} > "$VERCEL_STUB_LOG"
`,
  );
  chmodSync(fakePnpm, 0o755);

  const environment = {
    ...process.env,
    DEPLOYMENT_COMMIT_SHA: "a".repeat(40),
    DEPLOYMENT_ENVIRONMENT: target,
    PATH: `${binaryDirectory}:${process.env.PATH}`,
    VERCEL_CLI_VERSION: "56.0.0",
    VERCEL_STUB_LOG: commandLog,
    ...(operation === "deploy" ? { VERCEL_TOKEN: "test-token" } : {}),
    ...(target === "production" ? { RELEASE_VERSION: "v1.2.3" } : {}),
  };
  delete environment.RELEASE_VERSION;
  if (target === "production") environment.RELEASE_VERSION = "v1.2.3";
  Object.assign(environment, environmentOverrides);

  const result = spawnSync("bash", [deploymentScript, operation, target], {
    cwd: temporaryDirectory,
    encoding: "utf8",
    env: environment,
  });

  return { commandLog, result };
};

const expectArgument = (
  argumentsPassedToVercel: readonly string[],
  flag: string,
  value: string,
) => {
  expect(
    argumentsPassedToVercel.some(
      (argument, index) =>
        argument === flag && argumentsPassedToVercel[index + 1] === value,
    ),
  ).toBe(true);
};

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

describe("platform-owned dashboard Vercel deployment", () => {
  it("passes frozen production metadata into the build process", () => {
    const { commandLog, result } = runVercelOperation("build", "production");

    expect(result.status).toBe(0);
    const command = readFileSync(commandLog, "utf8");
    expect(command).toContain("DEPLOYMENT_ENVIRONMENT=production");
    expect(command).toContain(`DEPLOYMENT_COMMIT_SHA=${"a".repeat(40)}`);
    expect(command).toContain("RELEASE_VERSION=v1.2.3");
    expect(command).toContain("build");
    expect(command).toContain("--prod");
  });

  it("passes frozen production metadata into Vercel runtime configuration", () => {
    const { commandLog, result } = runVercelOperation("deploy", "production");

    expect(result.status).toBe(0);
    const argumentsPassedToVercel = readFileSync(commandLog, "utf8")
      .trim()
      .split("\n")
      .slice(3);
    expectArgument(
      argumentsPassedToVercel,
      "--env",
      "DEPLOYMENT_ENVIRONMENT=production",
    );
    expectArgument(
      argumentsPassedToVercel,
      "--env",
      `DEPLOYMENT_COMMIT_SHA=${"a".repeat(40)}`,
    );
    expectArgument(argumentsPassedToVercel, "--env", "RELEASE_VERSION=v1.2.3");
    expect(argumentsPassedToVercel).toContain("--token=test-token");
  });

  it("rejects contradictory metadata before invoking Vercel", () => {
    const { commandLog, result } = runVercelOperation("build", "production", {
      DEPLOYMENT_ENVIRONMENT: "preview",
    });

    expect(result.status).toBe(1);
    expect(existsSync(commandLog)).toBe(false);
  });
});
