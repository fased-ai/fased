#!/usr/bin/env bash
set -euo pipefail

agent_origin="${1:-${AGENT_ORIGIN:-http://localhost:18789}}"
summary_style="${SUMMARY_STYLE:-bullets}"
max_sentences="${MAX_SENTENCES:-2}"
task_id="${TASK_ID:-manual-summary-$(date +%s)}"
source_text="${SOURCE_TEXT:-Fased lets self-hosted agents join federation, exchange typed A2A tasks, and attach payment proof when needed. This smoke test asks the target agent to summarize that source text over the live content.summarize v0 service.}"

rpc_call() {
  local payload="$1"
  curl -fsS "${agent_origin%/}/a2a" \
    -H 'content-type: application/json' \
    -d "$payload"
}

echo "== List offers from ${agent_origin%/} =="
offers_json="$(rpc_call '{"jsonrpc":"2.0","id":"offers-1","method":"offers.list","params":{}}')"
printf '%s\n' "$offers_json"

offer_json="$(
  printf '%s' "$offers_json" | node -e '
let data = "";
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  const body = JSON.parse(data);
  const offers = Array.isArray(body?.result?.offers) ? body.result.offers : [];
  const offer = offers.find((entry) => entry?.serviceKind === "content.summarize");
  if (!offer) {
    console.error("No content.summarize offer found in offers.list");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(offer));
});
'
)"

offer_id="$(
  printf '%s' "$offer_json" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const offer=JSON.parse(data);process.stdout.write(String(offer.id ?? ""));});'
)"
target_handle="$(
  printf '%s' "$offer_json" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const offer=JSON.parse(data);process.stdout.write(String(offer.actor ?? ""));});'
)"

if [[ -z "$offer_id" || -z "$target_handle" ]]; then
  echo "Could not resolve offerId or target handle from offers.list" >&2
  exit 1
fi

echo
echo "== Create content.summarize task =="
create_payload="$(
  OFFER_ID="$offer_id" \
  TARGET_HANDLE="$target_handle" \
  TASK_ID="$task_id" \
  SOURCE_TEXT="$source_text" \
  SUMMARY_STYLE="$summary_style" \
  MAX_SENTENCES="$max_sentences" \
  node -e '
const payload = {
  jsonrpc: "2.0",
  id: "task-1",
  method: "tasks.create",
  params: {
    task: {
      schema: "https://domain.com/schemas/fased-agent-task-v0.json",
      taskId: process.env.TASK_ID,
      from: "@manual-smoke@example",
      to: process.env.TARGET_HANDLE,
      offerId: process.env.OFFER_ID,
      serviceKind: "content.summarize",
      prompt: process.env.SOURCE_TEXT,
      requestedOutput: "summary-v0",
      serviceParams: {
        summaryStyle: process.env.SUMMARY_STYLE,
        maxSentences: Number(process.env.MAX_SENTENCES),
      },
      issuedAt: new Date().toISOString(),
    },
  },
};
process.stdout.write(JSON.stringify(payload));
'
)"

create_json="$(rpc_call "$create_payload")"
printf '%s\n' "$create_json"

echo
echo "== Poll tasks.get until terminal =="
for _ in $(seq 1 20); do
  get_payload="$(
    TASK_ID="$task_id" node -e '
const payload = {
  jsonrpc: "2.0",
  id: "get-1",
  method: "tasks.get",
  params: { taskId: process.env.TASK_ID },
};
process.stdout.write(JSON.stringify(payload));
'
  )"

  get_json="$(rpc_call "$get_payload")"
  status="$(
    printf '%s' "$get_json" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const body=JSON.parse(data);process.stdout.write(String(body?.result?.status ?? body?.error?.message ?? ""));});'
  )"

  echo "$get_json"

  if [[ "$status" == "succeeded" || "$status" == "failed" || "$status" == "canceled" ]]; then
    break
  fi
  sleep 1
done

echo
echo "== Check result.kind = content.summarize.v0 =="
printf '%s' "$get_json" | node -e '
let data = "";
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  const body = JSON.parse(data);
  const kind = body?.result?.output?.result?.kind ?? "";
  if (kind !== "content.summarize.v0") {
    console.error("Unexpected result kind:", kind || "<missing>");
    process.exit(1);
  }
  console.log("OK result.kind =", kind);
  console.log("Summary:");
  console.log(body.result.output.result.summaryText ?? body.result.output.outputText ?? "<missing>");
});
'
