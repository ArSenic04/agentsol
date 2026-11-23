// Scores `agentsol learn` on labeled synthetic histories: precision, recall, and whether the proposed file edit fixes the cause.
// Usage: npm run eval:learn [-- --verbose]
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { learnLessons, lessonsChange, type InstructionFile, type Lesson, type LessonKind } from "../src/core/learn.ts";

const S = `sk-${randomBytes(24).toString("hex")}`;
/**
 * A session is a list of events: "$ cmd" worked, "! cmd" failed ("! cmd => output" adds what it printed),
 * "e file" edits a project file, "> text" is the person typing, "~" is a compaction.
 */
type Session = { codex?: true; other?: true; sub?: string[]; ev: string[] };
type Expect = { k: LessonKind; m: RegExp; fix?: RegExp; gone?: string };
type Scenario = { id: string; set: "dev" | "held"; files?: Record<string, string>; s: Session[]; want: Expect[] };

const AGENTS = "# Project\n\n- Keep changes small.\n";
const loop = (file: string, check: string): string[] => [`e ${file}`, `! ${check}`, `e ${file}`, `! ${check}`, `e ${file}`, `$ ${check}`];

const SCENARIOS: Scenario[] = [
  // dev: positives
  { id: "pm-conflicts-instructions", set: "dev", files: { "AGENTS.md": "# Project\n\n- Use npm to run scripts.\n" },
    s: [{ ev: ["! npm test => ERR_PNPM_LOCKFILE use pnpm", "$ pnpm test"] }, { ev: ["! npm run build", "$ pnpm run build"] }],
    want: [{ k: "command", m: /`pnpm`/, fix: /pnpm/, gone: "- Use npm to run scripts." }] },
  { id: "runner-pytest", set: "dev", s: [{ ev: ["! pytest tests => pytest: command not found", "$ uv run pytest tests"] }, { ev: ["! pytest tests", "$ uv run pytest tests"] }],
    want: [{ k: "command", m: /uv run pytest/, fix: /uv run pytest/ }] },
  { id: "wrong-test-script", set: "dev", s: [{ ev: ["! npm test => Missing script: \"test\"", "$ npm run test:unit"] }, { codex: true, ev: ["! npm test", "$ npm run test:unit"] }],
    want: [{ k: "command", m: /test:unit/, fix: /npm run test:unit/ }] },
  { id: "wrong-test-path", set: "dev",
    s: [{ ev: ["! npx vitest run tests/date.test.ts => No test files found", "$ npx vitest run src/date.test.ts"] }, { ev: ["! npx vitest run tests/money.test.ts => No test files found", "$ npx vitest run src/money.test.ts"] }],
    want: [{ k: "command", m: /src\//, fix: /src\// }] },
  { id: "fragile-parser", set: "dev", s: [{ ev: loop("src/parser.ts", "npm test") }, { ev: loop("src/parser.ts", "npm test") }],
    want: [{ k: "fragile", m: /src\/parser\.ts/, fix: /src\/parser\.ts/ }] },
  { id: "fragile-across-compaction", set: "dev", s: [{ ev: [...loop("src/cache.ts", "npm test"), "~", ...loop("src/cache.ts", "npm test")] }],
    want: [{ k: "fragile", m: /src\/cache\.ts/, fix: /src\/cache\.ts/ }] },
  { id: "correction-dev-server", set: "dev",
    s: [{ ev: ["$ npm run build", "> don't start the dev server, run npm run build to check changes"] }, { ev: ["> please don't start the dev server; run npm run build to check"] }],
    want: [{ k: "correction", m: /dev server/, fix: /dev server/ }] },
  { id: "correction-across-compaction", set: "dev", s: [{ ev: ["> never commit directly to main, open a branch", "$ git status", "~", "$ git status", "> never commit to main directly, use a branch"] }],
    want: [{ k: "correction", m: /main/, fix: /commit.*main|main.*branch/i }] },
  { id: "subagent-test-script", set: "dev", s: [{ ev: ["$ git status"], sub: ["! npm test => Missing script: \"test\"", "$ npm run test:unit"] }, { ev: ["! npm test", "$ npm run test:unit"] }],
    want: [{ k: "command", m: /test:unit/, fix: /npm run test:unit/ }] },
  { id: "codex-yarn-to-pnpm", set: "dev", s: [{ codex: true, ev: ["! yarn install => yarn: command not found", "$ pnpm install"] }, { codex: true, ev: ["! yarn build", "$ pnpm build"] }],
    want: [{ k: "command", m: /`pnpm`/, fix: /pnpm/ }] },
  { id: "failing-never-fixed", set: "dev", s: [{ ev: ["! make test => make: *** No rule to make target 'test'", "$ git status", "! make test"] }, { ev: ["! make test"] }],
    want: [{ k: "failing", m: /make test/ }] },
  { id: "secret-in-commands", set: "dev",
    s: [{ ev: [`! API_TOKEN=${S} npm test`, `$ API_TOKEN=${S} pnpm test`, `> stop, use the token ${S} from now on`] }, { ev: [`! API_TOKEN=${S} npm test`, `$ API_TOKEN=${S} pnpm test`, `> stop, use the token ${S} from now on`] }],
    want: [{ k: "command", m: /`pnpm`/, fix: /pnpm/ }] },
  // dev: negatives
  { id: "one-off-failures", set: "dev", s: [{ ev: ["e src/a.ts", "! npm run lint", "e src/a.ts", "$ npm run lint"] }, { ev: ["! npm run build", "$ npm run build:prod"] }], want: [] },
  { id: "network-dns", set: "dev",
    s: [{ ev: ["! npm install => npm ERR! code ENOTFOUND\nnpm ERR! getaddrinfo ENOTFOUND registry.npmjs.org", "! npm install => npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org"] }, { ev: ["! npm install => npm ERR! network request failed, reason: getaddrinfo ENOTFOUND"] }], want: [] },
  { id: "sandbox-denied", set: "dev",
    s: [{ ev: ["! swift build => sandbox-exec: sandbox_apply: Operation not permitted", "$ git status", "! swift build => sandbox-exec: sandbox_apply: Operation not permitted"] }, { ev: ["! swift build => sandbox-exec: sandbox_apply: Operation not permitted"] }], want: [] },
  { id: "flaky-test", set: "dev", s: [1, 2, 3].map(() => ({ ev: ["! npm test => 1 failing: timeout", "$ npm test"] })), want: [] },
  { id: "tdd-red-green", set: "dev",
    s: [{ ev: ["e tests/sum.test.ts", "! npm test => expected 3, got undefined", "e src/sum.ts", "$ npm test"] }, { ev: ["e tests/mul.test.ts", "! npm test => expected 6", "e src/mul.ts", "! npm test", "e src/mul.ts", "$ npm test"] }], want: [] },
  { id: "exploring-alternatives", set: "dev", s: [{ ev: ["> could we use zod instead of yup here? just exploring", "$ npm test"] }, { ev: ["> what if we used zod instead of yup for validation?"] }], want: [] },
  { id: "other-project", set: "dev", s: [1, 2].map(() => ({ other: true as const, ev: ["! npm test", "$ pnpm test", "> no, use pnpm not npm in this repo", ...loop("src/x.ts", "pnpm test")] })), want: [] },

  // held-out: positives
  { id: "claude-md-yarn-conflict", set: "held", files: { "CLAUDE.md": "# Notes\n\n- Run tests with `yarn test`.\n" },
    s: [{ ev: ["! yarn test => yarn: command not found", "$ pnpm test"] }, { ev: ["! yarn test", "$ pnpm test"] }],
    want: [{ k: "command", m: /`pnpm`/, fix: /pnpm test/, gone: "- Run tests with `yarn test`." }] },
  { id: "codex-runner-ruff", set: "held", s: [1, 2].map(() => ({ codex: true as const, ev: ["! ruff check . => ruff: command not found", "$ uv run ruff check ."] })),
    want: [{ k: "command", m: /uv run ruff/, fix: /uv run ruff/ }] },
  { id: "pytest-wrong-path", set: "held",
    s: [{ ev: ["! uv run pytest test/test_api.py => ERROR: file or directory not found: test/test_api.py", "$ uv run pytest tests/test_api.py"] }, { ev: ["! uv run pytest test/test_db.py => ERROR: file or directory not found: test/test_db.py", "$ uv run pytest tests/test_db.py"] }],
    want: [{ k: "command", m: /tests\//, fix: /tests\// }] },
  { id: "codex-fragile", set: "held", s: [1, 2].map(() => ({ codex: true as const, ev: loop("lib/money.py", "uv run pytest") })),
    want: [{ k: "fragile", m: /lib\/money\.py/, fix: /lib\/money\.py/ }] },
  { id: "codex-correction", set: "held", s: [{ codex: true, ev: ["> stop adding comments to every function"] }, { codex: true, ev: ["$ git diff", "> don't add comments to every function please"] }],
    want: [{ k: "correction", m: /comments/, fix: /comments/ }] },
  { id: "codex-compaction-correction", set: "held", s: [{ codex: true, ev: ["> always run make lint before you commit", "$ git status", "~", "$ git status", "> remember to run make lint before committing"] }],
    want: [{ k: "correction", m: /make lint/, fix: /make lint/ }] },
  { id: "subagent-fragile", set: "held", s: [{ ev: ["$ git status"], sub: loop("src/db.ts", "npm test") }, { ev: loop("src/db.ts", "npm test") }],
    want: [{ k: "fragile", m: /src\/db\.ts/, fix: /src\/db\.ts/ }] },
  { id: "cargo-workspace-flag", set: "held", s: [{ ev: ["! cargo test => error: no library targets found in package", "$ cargo test --workspace"] }, { codex: true, ev: ["! cargo test", "$ cargo test --workspace"] }],
    want: [{ k: "command", m: /--workspace/, fix: /cargo test --workspace/ }] },
  { id: "secret-publish", set: "held",
    s: [1, 2].map(() => ({ ev: [`! NPM_TOKEN=${S} npm publish --dry-run`, `$ NPM_TOKEN=${S} pnpm publish --dry-run`, `> never paste ${S} into config, read it from env`] })),
    want: [{ k: "command", m: /`pnpm`/, fix: /pnpm/ }] },
  // held-out: negatives
  { id: "one-off-variant", set: "held", s: [{ ev: ["! npm test", "$ npm run test:ci"] }, { ev: ["$ npm run test:ci"] }], want: [] },
  { id: "dns-curl", set: "dev",
    s: [{ ev: ["! curl -sf https://api.example.com/health => curl: (6) Could not resolve host: api.example.com", "! curl -sf https://api.example.com/health => curl: (6) Could not resolve host: api.example.com"] }, { codex: true, ev: ["! curl -sf https://api.example.com/health => curl: (6) Could not resolve host: api.example.com"] }], want: [] },
  { id: "rate-limit", set: "dev",
    s: [{ codex: true, ev: ["! gh pr list => HTTP 429: API rate limit exceeded for user", "$ git status", "! gh pr list => HTTP 429: API rate limit exceeded for user"] }, { codex: true, ev: ["! gh pr list => HTTP 429: API rate limit exceeded"] }], want: [] },
  { id: "codex-flaky", set: "held", s: [1, 2, 3].map(() => ({ codex: true as const, ev: ["! uv run pytest => 1 failed (flaky network fixture)", "$ uv run pytest"] })), want: [] },
  { id: "codex-tdd", set: "held", s: [1, 2].map(() => ({ codex: true as const, ev: ["e tests/test_tax.py", "! uv run pytest => 1 failed", "e lib/tax.py", "$ uv run pytest"] })), want: [] },
  { id: "exploring-package-managers", set: "held",
    s: [{ ev: ["> what about trying pnpm instead of npm, just to compare install speed?"] }, { ev: ["> just curious, could pnpm instead of npm make install faster?"] }], want: [] },
  { id: "codex-other-project", set: "held", s: [1, 2].map(() => ({ codex: true as const, other: true as const, ev: [...loop("lib/x.py", "uv run pytest"), "! yarn build", "$ pnpm build"] })), want: [] },
  // held-out, written after the environment filter was last changed and never used to tune it
  { id: "npm-eai-again", set: "held",
    s: [1, 2].map(() => ({ ev: ["! npm install => npm error code EAI_AGAIN\nnpm error syscall getaddrinfo\nnpm error request to https://registry.npmjs.org/zod failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org"] })), want: [] },
  { id: "pip-name-resolution", set: "held",
    s: [1, 2].map(() => ({ codex: true as const, ev: ["! pip install requests => WARNING: Retrying (Retry(total=4)) after connection broken by 'NewConnectionError(\"<pip._vendor.urllib3.connection.HTTPSConnection>: Failed to establish a new connection: [Errno -3] Temporary failure in name resolution\")': /simple/requests/"] })), want: [] },
  { id: "git-push-429", set: "held",
    s: [{ ev: ["! git push origin feature => remote: 429 Too Many Requests\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429"] }, { ev: ["! git push origin feature => error: RPC failed; HTTP 429 curl 22 The requested URL returned error: 429"] }], want: [] },
  { id: "gh-api-rate-limit", set: "held",
    s: [1, 2].map(() => ({ ev: ["! gh issue list => API rate limit exceeded for 203.0.113.7. (But here's the good news: Authenticated requests get a higher rate limit.)"] })), want: [] },
  { id: "git-fetch-reset", set: "held",
    s: [1, 2].map(() => ({ codex: true as const, ev: ["! git fetch origin => fatal: unable to access 'https://github.com/o/r.git/': Recv failure: Connection reset by peer"] })), want: [] },
  { id: "cargo-spurious-network", set: "held",
    s: [1, 2].map(() => ({ ev: ["! cargo build => warning: spurious network error (2 tries remaining): [6] Couldn't resolve host name (Could not resolve host: index.crates.io)\nerror: failed to download from `https://index.crates.io/config.json`"] })), want: [] },
  { id: "docker-pull-timeout", set: "held",
    s: [1, 2].map(() => ({ ev: ["! docker pull node:24 => Error response from daemon: Get \"https://registry-1.docker.io/v2/\": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)"] })), want: [] },
  { id: "codex-uv-cache-eperm", set: "held",
    s: [1, 2].map(() => ({ codex: true as const, ev: ["! uv sync => error: failed to create directory `/Users/dev/.cache/uv`: Operation not permitted (os error 1)"] })), want: [] },
  { id: "network-noise-then-real-swap", set: "held",
    s: [{ ev: ["! yarn install => error An unexpected error occurred: \"https://registry.yarnpkg.com/zod: getaddrinfo ENOTFOUND registry.yarnpkg.com\".", "! yarn build => error Command \"build\" not found.", "$ pnpm build"] }, { ev: ["! yarn build", "$ pnpm build"] }],
    want: [{ k: "command", m: /`pnpm`/, fix: /pnpm/ }] },
  { id: "bun-run-build", set: "held",
    s: [{ ev: ["! npm run build => npm error Missing script: \"build\"", "$ bun run build"] }, { codex: true, ev: ["! npm run build", "$ bun run build"] }],
    want: [{ k: "command", m: /bun/, fix: /bun run build/ }] },
  { id: "go-test-wrong-dir", set: "held",
    s: [{ ev: ["! go test ./pkg/auth/... => pattern ./pkg/auth/...: lstat ./pkg/auth/: no such file or directory", "$ go test ./internal/auth/..."] }, { ev: ["! go test ./pkg/store/... => pattern ./pkg/store/...: lstat ./pkg/store/: no such file or directory", "$ go test ./internal/store/..."] }],
    want: [{ k: "command", m: /internal\//, fix: /internal\// }] },
  { id: "eperm-wrong-output-path", set: "held",
    s: [1, 2].map(() => ({ ev: ["! node scripts/seed.js --out /data/seed.sql => Error: EPERM: operation not permitted, open '/data/seed.sql'", "$ node scripts/seed.js --out tmp/seed.sql"] })),
    want: [{ k: "command", m: /tmp\/seed\.sql/, fix: /tmp\/seed\.sql/ }] },
  { id: "codex-correction-fmt", set: "held", s: [{ codex: true, ev: ["$ gofmt -w .", "> use make fmt, not gofmt directly"] }, { codex: true, ev: ["> please run make fmt instead of gofmt"] }],
    want: [{ k: "correction", m: /make fmt/, fix: /make fmt/ }] },
];

// ---- rendering into the real transcript formats ----

const T0 = Date.parse("2026-11-01T09:00:00Z");
type Out = { lines: unknown[]; at: () => string };

function parse(e: string): { op: string; arg: string; out: string } {
  const op = e[0] ?? "";
  const rest = e.slice(op === "~" ? 1 : 2);
  const i = rest.indexOf(" => ");
  return { op, arg: i >= 0 ? rest.slice(0, i) : rest, out: i >= 0 ? rest.slice(i + 4) : "" };
}

function claude(cwd: string, o: Out, ev: readonly string[], side = false): void {
  const push = (x: Record<string, unknown>): void => { o.lines.push({ ...x, cwd, timestamp: o.at(), ...(side ? { isSidechain: true } : {}) }); };
  push({ type: "user", message: { role: "user", content: side ? "Run the tests and fix what fails." : "Work on the task." } });
  ev.forEach((e, i) => {
    const { op, arg, out } = parse(e);
    if (op === "~") { push({ type: "system", subtype: "compact_boundary" }); return; }
    if (op === ">") { push({ type: "user", message: { role: "user", content: arg } }); return; }
    const id = `t${o.lines.length}_${i}`;
    const input = op === "e" ? { file_path: path.join(cwd, arg), old_string: "a", new_string: "b" } : { command: arg };
    push({ type: "assistant", message: { id: `m${id}`, model: "fake-model-1", usage: { input_tokens: 500, output_tokens: 50 }, content: [{ type: "tool_use", id, name: op === "e" ? "Edit" : "Bash", input }] } });
    const failed = op === "!";
    push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: failed, content: out || (failed ? "Exit code 1" : "ok") }] } });
  });
}

function codex(cwd: string, o: Out, ev: readonly string[]): void {
  const push = (type: string, payload: unknown): void => { o.lines.push({ timestamp: o.at(), type, payload }); };
  push("session_meta", { cwd, timestamp: new Date(T0).toISOString() });
  push("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Work on the task." }] });
  ev.forEach((e, i) => {
    const { op, arg, out } = parse(e);
    if (op === "~") { o.lines.push({ timestamp: o.at(), type: "compacted", payload: { message: "" } }); return; }
    if (op === ">") { push("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: arg }] }); return; }
    const id = `c${i}`;
    if (op === "e") {
      push("response_item", { type: "function_call", name: "apply_patch", call_id: id, arguments: JSON.stringify({ input: `*** Begin Patch\n*** Update File: ${arg}\n@@\n-a\n+b\n*** End Patch\n` }) });
      push("response_item", { type: "function_call_output", call_id: id, output: JSON.stringify({ output: "Success. Updated the following files:\nM " + arg, metadata: { exit_code: 0 } }) });
      return;
    }
    push("response_item", { type: "function_call", name: "shell", call_id: id, arguments: JSON.stringify({ command: ["bash", "-lc", arg] }) });
    push("response_item", { type: "function_call_output", call_id: id, output: JSON.stringify({ output: out, metadata: { exit_code: op === "!" ? 1 : 0 } }) });
  });
}

const jsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

function apply(lines: readonly string[], edits: { startLine: number; endLine: number; expectedText: string; replacementLines: string[] }[]): string[] | null {
  const out = [...lines];
  for (const e of [...edits].sort((a, b) => b.startLine - a.startLine)) {
    if (out.slice(e.startLine - 1, e.endLine).join("\n") !== e.expectedText) return null;
    out.splice(e.startLine - 1, e.endLine - e.startLine + 1, ...e.replacementLines);
  }
  return out;
}

type Score = { id: string; set: string; want: number; got: number; tp: number; fixN: number; fixOk: number; leak: boolean; miss: string[]; extra: string[] };

async function run(sc: Scenario, base: string): Promise<Score> {
  const dir = path.join(base, sc.id);
  const home = path.join(dir, "home");
  const root = path.join(dir, "project");
  const other = path.join(dir, "other");
  const files = sc.files ?? { "AGENTS.md": AGENTS };
  for (const [rel, text] of Object.entries(files)) await put(path.join(root, rel), text);
  await mkdir(other, { recursive: true });
  for (const [k, s] of sc.s.entries()) {
    let t = T0 + k * 86_400_000;
    const o: Out = { lines: [], at: () => new Date((t += 20_000)).toISOString() };
    const cwd = s.other ? other : root;
    if (s.codex) {
      codex(cwd, o, s.ev);
      await put(path.join(home, `.codex/sessions/2026/11/0${k + 1}/rollout-2026-11-0${k + 1}T09-00-00-s${k}.jsonl`), jsonl(o.lines));
    } else {
      claude(cwd, o, s.ev);
      await put(path.join(home, `.claude/projects/-p${k}/s${k}.jsonl`), jsonl(o.lines));
      if (s.sub) {
        const so: Out = { lines: [], at: o.at };
        claude(cwd, so, s.sub, true);
        await put(path.join(home, `.claude/projects/-p${k}/s${k}/subagents/agent-1.jsonl`), jsonl(so.lines));
      }
    }
  }
  const ifiles: InstructionFile[] = Object.entries(files).map(([relPath, text]) => ({ relPath, lines: text.split("\n") }));
  const target = ifiles.find((f) => f.relPath === "AGENTS.md") ?? ifiles[0]!;
  const report = await learnLessons({ home, env: {} }, { root: await realpath(root), since: new Date(0), files: ifiles, target: target.relPath });
  const change = lessonsChange(target, report.lessons);
  const after = apply(target.lines, change.edits);
  const text = after?.join("\n") ?? "";
  const left = [...sc.want];
  const extra: string[] = [];
  const matched: Expect[] = [];
  for (const l of report.lessons) {
    const i = left.findIndex((w) => w.k === l.kind && w.m.test(`${l.rule ?? ""} ${l.title}`));
    if (i >= 0) matched.push(...left.splice(i, 1));
    else extra.push(`${l.kind}: ${l.rule ?? l.title}`);
  }
  const withFix = sc.want.filter((w) => w.fix);
  const fixOk = withFix.filter((w) => matched.includes(w) && after !== null && w.fix!.test(text) && (!w.gone || !after.includes(w.gone))).length;
  const leak = JSON.stringify(report).includes(S) || JSON.stringify(change).includes(S) || JSON.stringify(report).includes(S.slice(3, 20));
  return { id: sc.id, set: sc.set, want: sc.want.length, got: report.lessons.length, tp: matched.length, fixN: withFix.length, fixOk, leak, miss: left.map((w) => `${w.k} ${w.m}`), extra };
}

const verbose = process.argv.includes("--verbose");
const THRESHOLD = { precision: 0.9, recall: 0.8, fix: 0.8 };
const base = await realpath(await mkdtemp(path.join(tmpdir(), "agentsol-eval-learn-")));
let failed = false;
try {
  const scores: Score[] = [];
  for (const sc of SCENARIOS) scores.push(await run(sc, base));
  const pct = (a: number, b: number): string => (b === 0 ? "  n/a" : `${((100 * a) / b).toFixed(0).padStart(4)}%`);
  console.log(`${"scenario".padEnd(30)} set   want got  tp  fix  leak`);
  for (const s of scores) {
    const bad = s.tp < s.want || s.got > s.tp || s.fixOk < s.fixN || s.leak;
    console.log(`${(bad ? "✗ " : "  ") + s.id.padEnd(28)} ${s.set.padEnd(5)} ${String(s.want).padStart(4)} ${String(s.got).padStart(3)} ${String(s.tp).padStart(3)}  ${s.fixN ? `${s.fixOk}/${s.fixN}` : " - "}  ${s.leak ? "LEAK" : ""}`);
    if (verbose || bad) for (const m of s.miss) console.log(`      missed  ${m}`);
    if (verbose || bad) for (const x of s.extra) console.log(`      extra   ${x}`);
  }
  console.log("");
  for (const set of ["dev", "held"] as const) {
    const xs = scores.filter((s) => s.set === set);
    const sum = (k: "want" | "got" | "tp" | "fixN" | "fixOk"): number => xs.reduce((a, s) => a + s[k], 0);
    const p = sum("got") === 0 ? 1 : sum("tp") / sum("got");
    const r = sum("want") === 0 ? 1 : sum("tp") / sum("want");
    const f = sum("fixN") === 0 ? 1 : sum("fixOk") / sum("fixN");
    const leaks = xs.filter((s) => s.leak).length;
    console.log(`${set.padEnd(5)} ${String(xs.length).padStart(2)} scenarios  precision ${pct(sum("tp"), sum("got"))}  recall ${pct(sum("tp"), sum("want"))}  fix-correct ${pct(sum("fixOk"), sum("fixN"))}  leaks ${leaks}`);
    if (p < THRESHOLD.precision || r < THRESHOLD.recall || f < THRESHOLD.fix || leaks > 0) failed = true;
  }
  console.log(`\nthresholds: precision ≥ ${THRESHOLD.precision * 100}%, recall ≥ ${THRESHOLD.recall * 100}%, fix-correct ≥ ${THRESHOLD.fix * 100}%, no leaks, on both sets`);
} finally {
  await rm(base, { recursive: true, force: true });
}
if (failed) { console.log("FAIL"); process.exit(1); }
console.log("PASS");
