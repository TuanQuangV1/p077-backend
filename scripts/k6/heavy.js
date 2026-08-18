// k6 heavy test: the analysis pipeline on a real dataset.
//
// Drives POST /analysis (bag parse + detect + LLM + persist) and the detail
// endpoints, one iteration at a time, to measure true end-to-end latency.
// Do NOT run with many VUs — the pipeline is intentionally serial.
//
// Run:
//   k6 run -e DATASET_ID=test_minimal scripts/k6/heavy.js
//   k6 run -e DATASET_ID=C_02_0 -e ROOT_URL=http://localhost:8000 scripts/k6/heavy.js

import http from "k6/http";
import { check } from "k6";

const ROOT = __ENV.ROOT_URL || "http://localhost:8000";
const BASE_URL = `${ROOT}/api/v1`;
const DATASET_ID = __ENV.DATASET_ID || "test_minimal";
const RUN_ID = `run_${DATASET_ID}`;
const TOKEN = __ENV.API_AUTH_TOKEN || "";

const headers = { "Content-Type": "application/json" };
if (TOKEN) {
  headers["Authorization"] = `Bearer ${TOKEN}`;
}

export const options = {
  stages: [
    { duration: "10s", target: 1 },
    { duration: "30s", target: 1 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const create = http.post(
    `${BASE_URL}/analysis`,
    JSON.stringify({ rosbag_id: DATASET_ID }),
    { headers, tags: { endpoint: "POST /analysis" } },
  );
  check(create, {
    "analysis created (202)": (r) => r.status === 202,
  });
  if (create.status === 202) {
    const detail = http.get(`${BASE_URL}/analysis/${RUN_ID}`, {
      tags: { endpoint: "GET /analysis/{id}" },
    });
    check(detail, {
      "detail ok (200)": (r) => r.status === 200,
    });
    const health = http.get(`${BASE_URL}/analysis/${RUN_ID}/health`, {
      tags: { endpoint: "GET /analysis/{id}/health" },
    });
    check(health, {
      "health ok (200)": (r) => r.status === 200,
    });
  }
}
