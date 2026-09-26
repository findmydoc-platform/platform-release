import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly name?: string;
  readonly env?: Record<string, string>;
  readonly run?: string;
};
type Workflow = {
  readonly on: {
    readonly workflow_call: {
      readonly secrets: Record<string, { required: boolean }>;
    };
  };
  readonly env?: Record<string, string>;
  readonly jobs: {
    readonly deploy: {
      readonly env?: Record<string, string>;
      readonly steps: readonly Step[];
    };
  };
};
type Invocation = { args: string[]; packageTokenPresent: boolean };

const workflow = parse(
  readFileSync(
    new URL(
      "../../.github/workflows/reusable-deploy-website.yml",
      import.meta.url,
    ),
    "utf8",
  ),
) as Workflow;
const temporaryDirectories = new Set<string>();
const packageToken = "synthetic-package-read-token";
const context: Record<string, string> = {
  "inputs.target_sha": "a".repeat(40),
  "inputs.platform_version": "v1.2.3",
  "secrets.GH_PACKAGES_READ_TOKEN": packageToken,
  "secrets.PAYLOAD_SECRET": "synthetic-payload-secret",
  "secrets.VERCEL_ORG_ID": "team_test",
  "secrets.VERCEL_PROJECT_ID": "project_test",
  "secrets.VERCEL_TOKEN": "synthetic-vercel-token",
};

const namedStep = (name: string): Step => {
  const step = workflow.jobs.deploy.steps.find(
    (candidate) => candidate.name === name,
  );
  expect(step, `Expected the ${name} step.`).toBeDefined();
  return step as Step;
};

const runStep = (
  step: Step,
  options: { failures?: number; error?: string; packageAccess?: boolean } = {},
) => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "website-package-access-"),
  );
  temporaryDirectories.add(directory);
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const guardDirectory = path.join(directory, ".github/scripts/deploy");
  mkdirSync(guardDirectory, { recursive: true });
  writeFileSync(
    path.join(guardDirectory, "assert-vercel-project-binding.sh"),
    "exit 0\n",
  );
  const commandLog = path.join(directory, "commands.jsonl");
  const githubOutput = path.join(directory, "github-output");
  writeFileSync(commandLog, "");
  writeFileSync(githubOutput, "");
  writeFileSync(
    path.join(bin, "pnpm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.COMMAND_LOG;
fs.appendFileSync(log, JSON.stringify({ args, packageTokenPresent: Boolean(process.env.NODE_AUTH_TOKEN) }) + "\\n");
if (args.includes("deploy")) {
  const attempts = fs.readFileSync(log, "utf8").trim().split("\\n").length;
  if (attempts <= Number(process.env.STUB_FAILURES)) {
    console.error(process.env.STUB_ERROR);
    process.exit(1);
  }
  console.log("https://website-release-test.vercel.app");
}
`,
    { mode: 0o700 },
  );
  writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o700,
  });
  const declaredEnvironment = {
    ...workflow.env,
    ...workflow.jobs.deploy.env,
    ...step.env,
  };
  const resolvedEnvironment = Object.fromEntries(
    Object.entries(declaredEnvironment).map(([key, value]) => [
      key,
      String(value).replace(
        /\$\{\{ (.+?) \}\}/g,
        (_, expression: string) => context[expression] ?? "",
      ),
    ]),
  );
  const result = spawnSync(
    "bash",
    ["-e", "-o", "pipefail", "-c", step.run ?? ""],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: undefined,
        GH_PACKAGES_READ_TOKEN: undefined,
        ...resolvedEnvironment,
        ...(options.packageAccess === false ? { NODE_AUTH_TOKEN: "" } : {}),
        COMMAND_LOG: commandLog,
        GITHUB_OUTPUT: githubOutput,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        STUB_FAILURES: String(options.failures ?? 0),
        STUB_ERROR: options.error ?? "Internal error, please try again",
        TMPDIR: directory,
      },
    },
  );
  const invocations = readFileSync(commandLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
  return { result, invocations, output: readFileSync(githubOutput, "utf8") };
};

afterEach(() => {
  for (const directory of temporaryDirectories)
    rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe("Website package-read credential boundary", () => {
  it("never restores or saves the private package through Actions caches", () => {
    const pnpmSteps = workflow.jobs.deploy.steps.filter((step) =>
      step.uses?.startsWith("pnpm/action-setup@"),
    );
    expect(pnpmSteps).not.toHaveLength(0);
    for (const step of pnpmSteps) expect(step.with?.cache).toBe(false);
    const setupSteps = workflow.jobs.deploy.steps.filter((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    expect(setupSteps).not.toHaveLength(0);
    for (const step of setupSteps) {
      expect(step.with?.cache).toBeUndefined();
      expect(step.with?.["package-manager-cache"]).toBe(false);
    }
    expect(
      workflow.jobs.deploy.steps.filter((step) =>
        /^actions\/cache(?:\/(?:restore|save))?@/.test(step.uses ?? ""),
      ),
    ).toHaveLength(0);
  });

  it("requires the caller secret and makes it available only to the Website build", () => {
    expect(workflow.on.workflow_call.secrets.GH_PACKAGES_READ_TOKEN).toEqual({
      required: true,
    });
    const build = namedStep("Build Vercel production");
    expect(build.env?.NODE_AUTH_TOKEN).toBe(
      "${{ secrets.GH_PACKAGES_READ_TOKEN }}",
    );
    const nonBuildConfiguration = {
      env: workflow.env,
      jobEnv: workflow.jobs.deploy.env,
      steps: workflow.jobs.deploy.steps.filter((step) => step !== build),
    };
    expect(JSON.stringify(nonBuildConfiguration)).not.toMatch(
      /GH_PACKAGES_READ_TOKEN|NODE_AUTH_TOKEN/,
    );
    const buildResult = runStep(build);
    expect(buildResult.result.status).toBe(0);
    expect(buildResult.invocations).toEqual([
      {
        args: ["dlx", "vercel@canary", "build", "--prod", "--yes"],
        packageTokenPresent: true,
      },
    ]);
    expect(
      buildResult.result.stdout +
        buildResult.result.stderr +
        buildResult.output,
    ).not.toContain(packageToken);
  });

  it("fails before Vercel when the required package credential is empty", () => {
    const build = runStep(namedStep("Build Vercel production"), {
      packageAccess: false,
    });
    expect(build.result.status).toBe(1);
    expect(build.invocations).toEqual([]);
    expect(build.result.stderr).toContain(
      "GH_PACKAGES_READ_TOKEN is required for the Website build.",
    );
  });

  it("uploads prebuilt output with release metadata and without the package credential", () => {
    const upload = runStep(namedStep("Deploy Vercel production"));
    expect(upload.result.status).toBe(0);
    expect(upload.invocations).toHaveLength(1);
    const invocation = upload.invocations[0]!;
    expect(invocation.packageTokenPresent).toBe(false);
    expect(invocation.args.slice(0, 6)).toEqual([
      "dlx",
      "vercel@canary",
      "deploy",
      "--prebuilt",
      "--prod",
      "--yes",
    ]);
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "DEPLOYMENT_ENVIRONMENT=production",
        `DEPLOYMENT_COMMIT_SHA=${"a".repeat(40)}`,
        "RELEASE_VERSION=v1.2.3",
      ]),
    );
    expect(JSON.stringify(invocation.args)).not.toContain(packageToken);
    expect(upload.output).toBe(
      "deploymentUrl=https://website-release-test.vercel.app\n",
    );
  });

  it("preserves transient-upload retries without rebuilding", () => {
    const upload = runStep(namedStep("Deploy Vercel production"), {
      failures: 1,
    });
    expect(upload.result.status).toBe(0);
    expect(upload.invocations).toHaveLength(2);
    expect(
      upload.invocations.every(
        (call) => call.args.includes("--prebuilt") && !call.packageTokenPresent,
      ),
    ).toBe(true);
  });

  it("stops on a permanent upload failure without publishing deployment evidence", () => {
    const upload = runStep(namedStep("Deploy Vercel production"), {
      failures: 3,
      error: "Invalid project",
    });
    expect(upload.result.status).toBe(1);
    expect(upload.invocations).toHaveLength(1);
    expect(upload.output).toBe("");
  });
});
