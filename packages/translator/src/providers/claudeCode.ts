// Claude through the Claude Code CLI (`claude -p`), on the user's Claude Code
// login instead of an API key. For cheap evaluation runs only, not the app:
// the CLI sets its own request options, so results are not a substitute for
// API runs with our exact settings (docs/SPEC.md §7.2).
//
// Each request runs `claude -p` with our system prompt, no tools, and the
// response schema. Repairs resume the same CLI session, so the conversation
// stays append-only (§5.5). `--safe-mode` and an empty working directory keep
// the user's CLAUDE.md, memory, hooks, skills and MCP servers out of the
// request.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  kindOfStatus,
  ModelError,
  type ErrorKind,
  type ModelReply,
  type ModelRequest,
  type StopReason,
  type TranslatorModel,
} from "../model.ts";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs the CLI with `input` on stdin. Replaceable in tests. */
export type Runner = (args: string[], input: string, cwd: string) => Promise<RunResult>;

export interface ClaudeCodeOptions {
  /** The CLI to run; `claude` on the PATH by default. */
  command?: string;
  /** Kill a request after this long; 10 minutes by default. */
  timeoutMs?: number;
  run?: Runner;
}

/** The assistant turn's raw content: the CLI session to resume. */
interface Raw {
  sessionId: string;
}

/** The fields of `claude -p --output-format json` that are read. */
interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string | null;
  session_id?: string;
  api_error_status?: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

function defaultRunner(command: string, timeoutMs: number): Runner {
  return (args, input, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
      child.stdin.end(input);
    });
}

/** What an error result means: the login, the plan's usage limit, or a passing failure. */
export function claudeCodeErrorKind(r: CliResult): ErrorKind {
  const message = r.result ?? "";
  if (/authenticat|oauth|not logged in|log ?in|invalid api key/i.test(message)) return "key_rejected";
  if (/usage limit|limit reached|out of (extra )?usage|credit/i.test(message)) return "no_credit";
  if (typeof r.api_error_status === "number") return kindOfStatus(r.api_error_status);
  return "retryable";
}

/** The reply for a parsed CLI result; throws a ModelError for an error result. */
export function claudeCodeReply(r: CliResult, requested: string): ModelReply {
  if (r.is_error) {
    throw new ModelError("claude-code", claudeCodeErrorKind(r), r.result ?? `error result (${r.subtype ?? "unknown"})`, { cause: r });
  }
  if (!r.session_id) throw new ModelError("claude-code", "retryable", "no session id in the result");
  const text = r.structured_output !== undefined ? JSON.stringify(r.structured_output) : (r.result ?? "");
  let stopReason: StopReason = "end";
  if (r.stop_reason === "max_tokens") stopReason = "max_tokens";
  else if (r.stop_reason === "refusal") stopReason = "refusal";
  else if (r.subtype !== "success") stopReason = "other";
  const raw: Raw = { sessionId: r.session_id };
  return {
    text,
    raw,
    stopReason,
    usage: {
      inputTokens: r.usage?.input_tokens ?? 0,
      outputTokens: r.usage?.output_tokens ?? 0,
      cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: r.usage?.cache_creation_input_tokens ?? 0,
    },
    // No costUsd: the CLI's figure is what the API would have charged, not what a plan costs.
    model: Object.keys(r.modelUsage ?? {})[0] ?? requested,
    response: r,
  };
}

export class ClaudeCodeModel implements TranslatorModel {
  readonly provider = "claude-code" as const;
  private run: Runner;
  /** An empty working directory: no CLAUDE.md, no project memory. */
  private dir: string;
  private systemFiles = new Map<string, string>();

  constructor(options: ClaudeCodeOptions = {}) {
    this.run = options.run ?? defaultRunner(options.command ?? "claude", options.timeoutMs ?? 600_000);
    this.dir = mkdtempSync(join(tmpdir(), "crochet-claude-code-"));
  }

  /** The system prompt as a file, written once per distinct text. */
  private systemFile(text: string): string {
    let file = this.systemFiles.get(text);
    if (!file) {
      file = join(this.dir, `system-${this.systemFiles.size}.md`);
      writeFileSync(file, text);
      this.systemFiles.set(text, file);
    }
    return file;
  }

  /** The CLI arguments and stdin for a request. */
  args(request: ModelRequest): { args: string[]; input: string } {
    const last = request.messages.at(-1);
    if (last?.role !== "user") throw new ModelError("claude-code", "bad_request", "the last turn must be the user's");
    const previous = [...request.messages].reverse().find((t) => t.role === "assistant");
    const sessionId = previous?.role === "assistant" ? (previous.raw as Raw | undefined)?.sessionId : undefined;
    if (request.messages.length > 1 && !sessionId) {
      throw new ModelError("claude-code", "bad_request", "a follow-up turn needs the session of the reply before it");
    }
    const args = [
      "-p",
      "--output-format", "json",
      "--safe-mode",
      "--strict-mcp-config",
      "--tools", "",
      "--model", request.model,
      // Haiku 4.5 takes no effort setting.
      ...(/haiku/i.test(request.model) ? [] : ["--effort", request.effort]),
      "--system-prompt-file", this.systemFile(request.system.map((b) => b.text).join("\n\n")),
      "--json-schema", JSON.stringify(request.schema),
      ...(sessionId ? ["--resume", sessionId] : []),
    ];
    return { args, input: last.blocks.map((b) => b.text).join("\n\n") };
  }

  async send(request: ModelRequest): Promise<ModelReply> {
    const { args, input } = this.args(request);
    let out: RunResult;
    try {
      out = await this.run(args, input, this.dir);
    } catch (error) {
      throw new ModelError("claude-code", "bad_request", `could not run the Claude Code CLI: ${String(error)}`, { cause: error });
    }
    let parsed: CliResult;
    try {
      parsed = JSON.parse(out.stdout.trim()) as CliResult;
    } catch {
      const detail = (out.stderr || out.stdout).trim().slice(0, 300);
      throw new ModelError("claude-code", "retryable", `unreadable CLI output (exit ${out.code}): ${detail}`);
    }
    return claudeCodeReply(parsed, request.model);
  }
}

export interface ClaudeCodeStatus {
  loggedIn: boolean;
  authMethod?: string;
}

/** `claude auth status`: free, and says whether a run can start. */
export async function claudeCodeStatus(options: Pick<ClaudeCodeOptions, "command" | "run"> = {}): Promise<ClaudeCodeStatus> {
  const run = options.run ?? defaultRunner(options.command ?? "claude", 30_000);
  let out: RunResult;
  try {
    out = await run(["auth", "status", "--json"], "", tmpdir());
  } catch (error) {
    throw new ModelError("claude-code", "bad_request", `could not run the Claude Code CLI: ${String(error)}`, { cause: error });
  }
  try {
    return JSON.parse(out.stdout.trim()) as ClaudeCodeStatus;
  } catch {
    throw new ModelError("claude-code", "bad_request", `unreadable \`claude auth status\` output: ${out.stdout.slice(0, 200)}`);
  }
}
