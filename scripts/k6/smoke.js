// k6 smoke test: light API endpoints (per-request latency + N+1 query counts).
//
// Run:
//   k6 run --vus 10 --duration 30s scripts/k6/smoke.js
//   k6 run --vus 10 --duration 30s -e ROOT_URL=http://localhost:8000 -e API_AUTH_TOKEN=... scripts/k6/smoke.js
//
// Watch the backend log for perf.request entries (durationMs / queries / dbMs)
// while this runs.

import http from "k6/http";
import { check } from "k6";

const ROOT = __ENV.ROOT_URL || "http://localhost:8000";
const BASE_URL = `${ROOT}/api/v1`;
const TOKEN = __ENV.API_AUTH_TOKEN || "";

const params = TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : {};

export const options = {
  vus: 10,
  duration: "30s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
  },
};

const endpoints = [
  { name: "GET /health", url: `${ROOT}/health` },
  { name: "GET /status", url: `${BASE_URL}/status` },
  { name: "GET /datasets", url: `${BASE_URL}/datasets` },
  { name: "GET /dashboard/overview", url: `${BASE_URL}/dashboard/overview` },
  { name: "GET /review", url: `${BASE_URL}/review` },
  { name: "GET /review/stats", url: `${BASE_URL}/review/stats` },
];

let cursor = 0;

export default function () {
  const { name, url } = endpoints[cursor % endpoints.length];
  cursor += 1;
  const res = http.get(url, { ...params, tags: { endpoint: name } });
  check(res, { "status 2xx": (r) => r.status >= 200 && r.status < 300 });
}
