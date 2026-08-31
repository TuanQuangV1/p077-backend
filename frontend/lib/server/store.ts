/**
 * In-memory stand-in for the FastAPI + PostgreSQL backend.
 *
 * Everything is generated deterministically from a seed so the UI is stable
 * across refreshes and server/client renders. Swap this module for real HTTP
 * calls to the Python service and nothing in the UI layer has to change.
 */

import type {
  AIResult,
  AnalysisRun,
  Anomaly,
  AnomalyKind,
  DemoAnomalyKind,
  Feedback,
  LogEvent,
  Report,
  Rosbag,
  RobotType,
  Severity,
  TopicStat,
  LlmPoint,
  LlmRequest,
} from "@/lib/types"

/* ------------------------------------------------------------------ */
/* deterministic rng                                                   */
/* ------------------------------------------------------------------ */

export function hashSeed(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function rng(seed: string | number) {
  let a = typeof seed === "string" ? hashSeed(seed) : seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T,>(r: () => number, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)]
const round = (n: number, d = 2) => Number(n.toFixed(d))

/** Fixed clock so server and client agree. */
export const NOW = new Date("2026-07-31T09:00:00.000Z").getTime()
const HOUR = 3600_000

/* ------------------------------------------------------------------ */
/* catalogs                                                            */
/* ------------------------------------------------------------------ */

const TOPIC_CATALOG: { name: string; messageType: string; hz: number }[] = [
  { name: "/scan", messageType: "sensor_msgs/msg/LaserScan", hz: 20 },
  { name: "/tf", messageType: "tf2_msgs/msg/TFMessage", hz: 100 },
  { name: "/odom", messageType: "nav_msgs/msg/Odometry", hz: 50 },
  { name: "/cmd_vel", messageType: "geometry_msgs/msg/Twist", hz: 20 },
  { name: "/amcl_pose", messageType: "geometry_msgs/msg/PoseWithCovarianceStamped", hz: 10 },
  { name: "/imu/data", messageType: "sensor_msgs/msg/Imu", hz: 100 },
  { name: "/local_costmap/costmap", messageType: "nav_msgs/msg/OccupancyGrid", hz: 5 },
  { name: "/plan", messageType: "nav_msgs/msg/Path", hz: 2 },
  { name: "/joint_states", messageType: "sensor_msgs/msg/JointState", hz: 50 },
  { name: "/diagnostics", messageType: "diagnostic_msgs/msg/DiagnosticArray", hz: 1 },
  { name: "/rosout", messageType: "rcl_interfaces/msg/Log", hz: 6 },
]

export const ROBOT_LABEL: Record<RobotType, string> = {
  "amr-delivery": "AMR Delivery",
  "agv-forklift": "AGV Forklift",
  quadruped: "Quadruped",
  "arm-cell": "Arm Cell",
}

const SITES = ["Fremont-A", "Fremont-B", "Rotterdam-1", "Nagoya-3", "Austin-Lab"]

const NODES = [
  "controller_server",
  "planner_server",
  "amcl",
  "robot_state_publisher",
  "lidar_driver",
  "bt_navigator",
  "costmap_2d",
  "ekf_filter_node",
]

interface AnomalyTemplate {
  kind: DemoAnomalyKind
  title: string
  severity: Severity
  topics: string[]
  metric: string
  issue: string
  rootCause: string
  explanation: string
  fixes: string[]
  node: string
  logs: string[]
}

const ANOMALY_TEMPLATES: AnomalyTemplate[] = [
  {
    kind: "tf_timeout",
    title: "Timeout tra cứu TF trên map -> base_link",
    severity: "high",
    topics: ["/tf", "/amcl_pose"],
    metric: "độ trễ TF p99 0.41s (ngưỡng 0.20s)",
    issue: "Nav2 không thể biến đổi pose mục tiêu vì map -> base_link vượt quá ngưỡng dung sai TF.",
    rootCause:
      "robot_state_publisher đang phát lại /tf ở ~12 Hz thay vì 100 Hz đã cấu hình. Nó chia sẻ core CPU 2 với pointcloud_to_laserscan, vốn bão hòa khi rẽ, khiến buffer TF không thể ngoại suy map -> base_link trong ngưỡng 0.20 s.",
    explanation:
      "Khoảng phát /tf giãn từ 10 ms lên 83 ms đúng lúc /diagnostics báo vòng lặp controller_server bị quá hạn. amcl vẫn phát /amcl_pose ở 10 Hz nên định vị vẫn ổn — chỉ cây transform bị trễ. Nav2 đóng an toàn khi transform cũ và hủy goal hiện tại, gây ra khoảng dừng thấy được trên quỹ đạo.",
    fixes: [
      "Chuyển robot_state_publisher sang core riêng (taskset / cgroup cpuset) để tiền xử lý sensor không làm đói tài nguyên.",
      "Nâng transform_tolerance cho controller từ 0.20 s lên 0.35 s như biện pháp tạm thời.",
      "Phát /tf với QoS SensorDataQoS depth 100 để burst subscriber trễ không làm tắc publisher.",
    ],
    node: "bt_navigator",
    logs: [
      "Could not transform goal pose to map frame: Lookup would require extrapolation into the future",
      "Timed out waiting for transform from base_link to map",
      "Behavior tree returned FAILURE for node ComputePathToPose",
    ],
  },
  {
    kind: "lidar_dropout",
    title: "Mất tín hiệu LaserScan trên /scan",
    severity: "critical",
    topics: ["/scan", "/local_costmap/costmap"],
    metric: "0 tin nhắn trong 2.20 s (kỳ vọng 20 Hz)",
    issue: "Lidar 2D chính ngừng phát hơn hai giây khi robot đang di chuyển 0.6 m/s.",
    rootCause:
      "Socket UDP của driver lidar rớt 3 cửa sổ gói liên tiếp sau bão ARP trên VLAN cảm biến. Driver không đồng bộ lại giữa chừng scan nên loại bỏ scan dở thay vì phát dữ liệu suy giảm.",
    explanation:
      "Bộ đếm kernel cho thấy rx_missed_errors tăng trên NIC cảm biến cùng cửa sổ. /scan im lặng trong khi /imu/data và /odom vẫn chảy, loại trừ tắc executor toàn cục và chỉ ra đường mạng của driver. Local costmap giữ quan sát cuối và đánh dấu tươi nên robot tạm thời lập kế hoạch qua vùng không nhìn thấy.",
    fixes: [
      "Tách VLAN cảm biến khỏi VLAN quản lý đội và bật IGMP snooping trên switch.",
      "Phát scan rỗng với header hợp lệ khi mất cửa sổ scan để costmap hết hạn quan sát đúng cách.",
      "Đặt observation_persistence về 0.0 trên lớp chướng ngại vật để không coi dữ liệu cũ là hiện tại.",
    ],
    node: "lidar_driver",
    logs: [
      "socket recv timeout after 250 ms, discarding partial scan",
      "scan sequence gap detected: expected 41822, received 41866",
      "Observation buffer for /scan has not been updated for 1.85 s",
    ],
  },
  {
    kind: "localization_jump",
    title: "Gián đoạn pose AMCL",
    severity: "critical",
    topics: ["/amcl_pose", "/odom", "/tf"],
    metric: "độ lệch pose 0.84 m trong một lần cập nhật (giới hạn 0.15 m)",
    issue: "Ước lượng định vị nhảy gần một mét theo chiều ngang, làm vô hiệu kế hoạch đang hoạt động.",
    rootCause:
      "Bộ lọc particle hội tụ lại vào lối đi kệ đối xứng. Chỉ 26 trong 2000 particle còn trọng số đáng kể sau khi lidar mất tín hiệu, nên lần resample tiếp theo làm sụp phân bố vào giả thuyết lối đi bên cạnh.",
    explanation:
      "Cú nhảy xảy ra 1.4 s sau khi khoảng trống /scan kết thúc. Vết hiệp phương sai tăng từ 0.02 lên 0.61 trước cú nhảy rồi sụp, là dấu hiệu điển hình của cạn kiệt particle rồi resample sai chứ không phải lỗi hiệu chuẩn cảm biến. Odometry bánh xe vẫn liên tục trong cùng khoảng.",
    fixes: [
      "Tăng recovery_alpha_slow/fast để AMCL bơm particle ngẫu nhiên khi trọng số trung bình giảm.",
      "Đưa detector fiducial trần vào EKF để phá đối xứng lối đi.",
      "Loại bỏ phép khớp scan khi tuổi buffer quan sát vượt 0.3 s thay vì khớp với dữ liệu cũ.",
    ],
    node: "amcl",
    logs: [
      "Resample triggered, effective sample size 26 / 2000",
      "Pose jump of 0.84 m exceeds monitor threshold",
      "Global localization confidence degraded to 0.31",
    ],
  },
  {
    kind: "costmap_stale",
    title: "Tần suất cập nhật local costmap sụp giảm",
    severity: "medium",
    topics: ["/local_costmap/costmap", "/scan"],
    metric: "cập nhật costmap 1.2 Hz (cấu hình 5 Hz)",
    issue: "Local costmap tụt lại sau vòng lặp controller khi inflate vùng chướng ngại vật dày đặc.",
    rootCause:
      "Lớp inflation được cấu hình bán kính 1.2 m trên cửa sổ lăn 0.025 m/cell, gấp 4 lần số cell ngân sách CPU cho phép. Mỗi lần cập nhật tính lại toàn bộ inflation thay vì chỉ vùng bẩn.",
    explanation:
      "Thời gian cập nhật costmap bám gần tuyến tính theo số chướng ngại vật trong cửa sổ này, và controller server ghi 'control loop missed its desired rate' cùng mốc thời gian. Đây là vấn đề chi phí cấu hình, không phải cảm biến.",
    fixes: [
      "Thô hóa độ phân giải local costmap lên 0.05 m/cell, giảm 4 lần chi phí inflation mà hầu như không mất khoảng trống an toàn.",
      "Giảm inflation_radius xuống 0.55 m và dựa vào padding footprint cho phần còn lại.",
      "Bật đường cập nhật vùng bẩn của cửa sổ lăn thay vì tính lại toàn bản đồ.",
    ],
    node: "costmap_2d",
    logs: [
      "Costmap2DROS transform timeout, skipping update",
      "Map update loop missed its desired rate of 5.0000 Hz, current rate 1.2000 Hz",
      "Inflation layer took 612 ms for 41200 cells",
    ],
  },
  {
    kind: "cpu_spike",
    title: "Vòng lặp controller quá hạn do bão hòa CPU",
    severity: "high",
    topics: ["/diagnostics", "/cmd_vel"],
    metric: "CPU 98% trong 3.4 s, vòng lặp điều khiển 6.1 Hz (mục tiêu 20 Hz)",
    issue: "Controller phát lệnh vận tốc chỉ bằng một phần ba tần suất cấu hình, gây giật cục rõ rệt.",
    rootCause:
      "Nén log (rosbag2 zstd) chạy cùng cgroup với ngăn xếp điều hướng mà không có hạn mức CPU, nên việc ghi cạnh tranh với vòng lặp điều khiển thời gian thực trong đoạn tốc độ bản tin cao.",
    explanation:
      "Khoảng trống giữa các bản tin cmd_vel giãn tới 160 ms trong khi /odom vẫn ổn định 50 Hz, nghĩa là pipeline cảm biến ổn và riêng luồng controller bị ngắt lập lịch. Đỉnh CPU khớp chính xác với khoảng xả bộ ghi.",
    fixes: [
      "Tách bộ ghi ra cgroup riêng với cpu.max đặt 30% một core.",
      "Ghi ra namespace NVMe riêng và chuyển nén sang cấp file, tránh đường nóng.",
      "Chạy controller_server với độ ưu tiên SCHED_FIFO 60 và khóa bộ nhớ.",
    ],
    node: "controller_server",
    logs: [
      "Control loop missed its desired rate of 20.0000 Hz, current rate 6.1000 Hz",
      "cpu usage 98.2%, load average 7.41",
      "rosbag2 writer flush took 940 ms",
    ],
  },
  {
    kind: "nav_recovery",
    title: "Nav2 rơi vào hành vi phục hồi",
    severity: "medium",
    topics: ["/plan", "/cmd_vel"],
    metric: "2 chu kỳ phục hồi (BackUp, Spin) trong 11 s",
    issue: "Cây hành vi rơi xuống phục hồi hai lần dù mục tiêu vẫn tới được.",
    rootCause:
      "Bộ chấm điểm DWB đánh mọi quỹ đạo là không hợp lệ vì costmap bị inflate không còn hành lang khả dụng sau cửa sổ quan sát cũ. Mục tiêu vẫn tới được; bề mặt chi phí mới sai.",
    explanation:
      "Phục hồi là triệu chứng hạ nguồn ở đây. Cả hai chu kỳ phục hồi bắt đầu trong 900 ms sau cảnh báo costmap cũ, và plan được phát lại không đổi sau đó, xác nhận planner luôn có đường toàn cục hợp lệ.",
    fixes: [
      "Sửa vấn đề tươi mới của costmap ở thượng nguồn trước khi tinh chỉnh hành vi phục hồi.",
      "Thêm ngưỡng trọng số PathAlign để hành lang bị chắn một phần vẫn được chấm điểm trên 0.",
      "Ghi bảng điểm critic DWB đầy đủ ở mức DEBUG khi thất bại để chẩn đoán nhanh hơn.",
    ],
    node: "bt_navigator",
    logs: [
      "No valid trajectories out of 720, clearing costmap and retrying",
      "Running recovery behavior: BackUp",
      "Running recovery behavior: Spin",
    ],
  },
  {
    kind: "topic_hz_drop",
    title: "Suy giảm tần suất phát odometry",
    severity: "medium",
    topics: ["/odom", "/joint_states"],
    metric: "/odom 31 Hz (kỳ vọng 50 Hz)",
    issue: "Tần suất phát odometry bánh xe giảm 38% trong nửa sau của lượt chạy.",
    rootCause:
      "Node EKF được cấu hình tần suất 50 Hz nhưng timeout cảm biến là 0.02 s, nên mỗi bản tin /joint_states trễ buộc chu kỳ chỉ dự đoán và phát ở tick tiếp theo thay vì ngay lập tức.",
    explanation:
      "Mất tần suất diễn ra mượt chứ không giật cục và tương quan với jitter của /joint_states, đặc trưng cho cấu hình sai timeout bộ lọc hơn là mất mát truyền dẫn.",
    fixes: [
      "Đặt sensor_timeout của EKF thành 0.1 s để một bản tin joint state trễ đơn lẻ không bỏ lỡ lần phát.",
      "Phát /joint_states với QoS best-effort và depth 1 để loại bỏ thay vì xếp hàng.",
      "Thêm monitor tần suất vào /diagnostics để lần sau suy giảm sẽ ồn ào hơn.",
    ],
    node: "ekf_filter_node",
    logs: [
      "Sensor timeout exceeded for /joint_states, running predict-only cycle",
      "Filter frequency 31.2 Hz below configured 50.0 Hz",
      "joint_states timestamp is 24 ms older than the filter clock",
    ],
  },
  {
    kind: "message_drop",
    title: "Không tương thích QoS làm rớt tin nhắn",
    severity: "low",
    topics: ["/joint_states"],
    metric: "412 tin nhắn bị rớt (2.1% của topic)",
    issue: "Một subscriber với chính sách durability không tương thích đã lặng lẽ mất tin nhắn.",
    rootCause:
      "Bộ tổng hợp diagnostics đăng ký với durability TRANSIENT_LOCAL trong khi publisher cung cấp VOLATILE. rmw báo không tương thích một lần khi khởi động rồi rớt mọi tin nhắn sau đó.",
    explanation:
      "Trường hợp này lành tính cho điều hướng nhưng che giấu tín hiệu lỗi khỏi bộ tổng hợp, đó là lý do đỉnh CPU trước đó không bao giờ nâng lỗi diagnostic.",
    fixes: [
      "Khớp durability của subscriber về VOLATILE.",
      "Nâng cảnh báo không tương thích QoS của rmw thành lỗi ở bước kiểm tra launch.",
    ],
    node: "controller_server",
    logs: [
      "New publisher discovered on /joint_states, offered QoS incompatible with requested",
      "requested: TRANSIENT_LOCAL, offered: VOLATILE",
    ],
  },
]

const templateByKind = new Map<AnomalyKind, AnomalyTemplate>(ANOMALY_TEMPLATES.map((t) => [t.kind, t]))
export const anomalyTemplate = (kind: AnomalyKind) => templateByKind.get(kind) ?? ANOMALY_TEMPLATES[0]

export const KIND_LABEL: Record<DemoAnomalyKind, string> = {
  tf_timeout: "Timeout TF",
  lidar_dropout: "Mất lidar",
  costmap_stale: "Costmap cũ",
  localization_jump: "Nhảy định vị",
  cpu_spike: "Đỉnh CPU",
  nav_recovery: "Phục hồi Nav",
  topic_hz_drop: "Sụt tần suất",
  message_drop: "Rớt tin nhắn",
}

/* ------------------------------------------------------------------ */
/* rosbags                                                             */
/* ------------------------------------------------------------------ */

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"]

function makeTopics(r: () => number, durationSec: number, degraded: string[]): TopicStat[] {
  return TOPIC_CATALOG.map((t) => {
    const isDegraded = degraded.includes(t.name)
    const factor = isDegraded ? 0.55 + r() * 0.25 : 0.96 + r() * 0.05
    const hz = round(t.hz * factor, 1)
    return {
      name: t.name,
      messageType: t.messageType,
      hz,
      expectedHz: t.hz,
      messageCount: Math.round(hz * durationSec),
      dropRate: round(isDegraded ? r() * 3.5 : r() * 0.25, 2),
    }
  })
}

function buildRosbags(): Rosbag[] {
  const specs: {
    id: string
    robotType: RobotType
    status: Rosbag["status"]
    durationSec: number
    hoursAgo: number
  }[] = [
    { id: "bag_9f21", robotType: "amr-delivery", status: "analyzed", durationSec: 118, hoursAgo: 2 },
    { id: "bag_8c04", robotType: "agv-forklift", status: "analyzed", durationSec: 96, hoursAgo: 5 },
    { id: "bag_7b55", robotType: "amr-delivery", status: "analyzed", durationSec: 142, hoursAgo: 9 },
    { id: "bag_6a13", robotType: "quadruped", status: "analyzed", durationSec: 74, hoursAgo: 14 },
    { id: "bag_5d78", robotType: "arm-cell", status: "analyzed", durationSec: 61, hoursAgo: 20 },
    { id: "bag_4e90", robotType: "amr-delivery", status: "analyzing", durationSec: 133, hoursAgo: 1 },
    { id: "bag_3f2a", robotType: "agv-forklift", status: "parsed", durationSec: 88, hoursAgo: 26 },
    { id: "bag_2b6c", robotType: "amr-delivery", status: "parsing", durationSec: 105, hoursAgo: 30 },
    { id: "bag_1a4d", robotType: "quadruped", status: "uploaded", durationSec: 67, hoursAgo: 34 },
    { id: "bag_0e8f", robotType: "amr-delivery", status: "analyzed", durationSec: 151, hoursAgo: 44 },
    { id: "bag_c317", robotType: "arm-cell", status: "failed", durationSec: 52, hoursAgo: 52 },
    { id: "bag_d922", robotType: "agv-forklift", status: "analyzed", durationSec: 127, hoursAgo: 61 },
  ]

  return specs.map((s, i) => {
    const r = rng(s.id)
    const site = SITES[i % SITES.length]
    const recordedAt = new Date(NOW - s.hoursAgo * HOUR).toISOString()
    const degraded = pick(r, [["/scan"], ["/tf"], ["/odom"], ["/scan", "/tf"], []])
    const topics = makeTopics(r, s.durationSec, degraded)
    const messageCount = topics.reduce((a, t) => a + t.messageCount, 0)
    const unit = String(101 + i).padStart(3, "0")
    return {
      id: s.id,
      name: `${site.toLowerCase().replace("-", "_")}_unit${unit}_${recordedAt.slice(0, 10)}_${recordedAt.slice(11, 13)}${recordedAt.slice(14, 16)}.mcap`,
      robotType: s.robotType,
      sizeBytes: Math.round((0.9 + r() * 3.4) * 1024 * 1024 * 1024),
      durationSec: s.durationSec,
      recordedAt,
      uploadedAt: new Date(NOW - s.hoursAgo * HOUR + 12 * 60_000).toISOString(),
      status: s.status,
      messageCount,
      topics,
      site,
      rosVersion: "ROS 2 Jazzy",
    }
  })
}

/* ------------------------------------------------------------------ */
/* runs, anomalies, ai results, logs                                   */
/* ------------------------------------------------------------------ */

const MODELS = ["openai/gpt-4.1", "openai/gpt-4o-mini", "anthropic/claude-sonnet-4-5"]

function anomaliesForRun(runId: string, durationSec: number, count: number): Anomaly[] {
  const r = rng(runId + ":anom")
  const kinds: AnomalyKind[] = []
  const pool = ANOMALY_TEMPLATES.map((t) => t.kind)
  while (kinds.length < count && kinds.length < pool.length) {
    const k = pick(r, pool)
    if (!kinds.includes(k)) kinds.push(k)
  }
  // spread anomalies across the run, keeping them ordered in time
  const slot = (durationSec - 12) / Math.max(count, 1)
  return kinds.map((kind, i) => {
    const tpl = anomalyTemplate(kind)
    const tSec = round(6 + i * slot + r() * slot * 0.45, 1)
    const span = round(0.9 + r() * 3.1, 1)
    return {
      id: `${runId}_an${i + 1}`,
      runId,
      kind,
      title: tpl.title,
      severity: tpl.severity,
      tSec,
      endSec: round(Math.min(tSec + span, durationSec - 0.5), 1),
      topics: tpl.topics,
      confidence: round(0.62 + r() * 0.35, 2),
      metric: tpl.metric,
    }
  })
}

function aiResultsForRun(runId: string, anomalies: Anomaly[], model: string): AIResult[] {
  const r = rng(runId + ":ai")
  return anomalies.map((a, i) => {
    const tpl = anomalyTemplate(a.kind)
    const promptTokens = 2400 + Math.floor(r() * 5200)
    const completionTokens = 320 + Math.floor(r() * 640)
    const status: AIResult["reviewStatus"] = i === 0 ? "pending" : pick(r, ["pending", "approved", "approved", "edited", "rejected"] as const)
    return {
      id: `${a.id}_ai`,
      runId,
      anomalyId: a.id,
      issue: tpl.issue,
      rootCause: tpl.rootCause,
      confidence: a.confidence,
      explanation: tpl.explanation,
      suggestedFix: tpl.fixes,
      evidence: [
        { topic: a.topics[0], tSec: a.tSec, detail: a.metric },
        { topic: "/rosout", tSec: round(a.tSec + 0.3, 1), detail: `${tpl.node}: ${tpl.logs[0]}` },
        { topic: "/diagnostics", tSec: round(a.tSec + 1.1, 1), detail: `status=WARN hardware_id=${tpl.node}` },
      ],
      reviewStatus: status,
      model,
      latencyMs: 1600 + Math.floor(r() * 6800),
      promptTokens,
      completionTokens,
      llmRequestId: `req_${hashSeed(a.id).toString(16).slice(0, 8)}`,
    }
  })
}

function logsForRun(runId: string, durationSec: number, anomalies: Anomaly[]): LogEvent[] {
  const r = rng(runId + ":log")
  const events: LogEvent[] = []
  const baseline = [
    { level: "info" as const, topic: "/rosout", msg: "Received goal, computing path" },
    { level: "info" as const, topic: "/plan", msg: "Global plan computed: 42 poses, 18.6 m" },
    { level: "debug" as const, topic: "/cmd_vel", msg: "cmd_vel linear=0.60 angular=0.00" },
    { level: "info" as const, topic: "/amcl_pose", msg: "Localization confidence 0.94" },
    { level: "debug" as const, topic: "/scan", msg: "Scan processed: 1081 ranges, 0 invalid" },
    { level: "info" as const, topic: "/diagnostics", msg: "All 14 diagnostic tasks OK" },
    { level: "debug" as const, topic: "/odom", msg: "Odom pose updated, covariance trace 0.021" },
  ]

  const n = Math.round(durationSec * 2.6)
  for (let i = 0; i < n; i++) {
    const b = pick(r, baseline)
    events.push({
      id: `${runId}_lg${i}`,
      runId,
      tSec: round(r() * durationSec, 2),
      topic: b.topic,
      node: pick(r, NODES),
      level: b.level,
      message: b.msg,
    })
  }

  for (const a of anomalies) {
    const tpl = anomalyTemplate(a.kind)
    tpl.logs.forEach((msg, j) => {
      const level: LogEvent["level"] = a.severity === "critical" ? (j === 0 ? "error" : "warn") : j === 0 ? "warn" : "info"
      events.push({
        id: `${a.id}_lg${j}`,
        runId,
        tSec: round(a.tSec + j * 0.35 + r() * 0.2, 2),
        topic: a.topics[0],
        node: tpl.node,
        level,
        message: msg,
        anomalyId: a.id,
      })
    })
    if (a.severity === "critical") {
      events.push({
        id: `${a.id}_lgf`,
        runId,
        tSec: round(a.endSec, 2),
        topic: a.topics[0],
        node: tpl.node,
        level: "fatal",
        message: `Aborting current goal: ${tpl.title.toLowerCase()}`,
        anomalyId: a.id,
      })
    }
  }

  return events.sort((x, y) => x.tSec - y.tSec)
}

function buildRuns(bags: Rosbag[]): AnalysisRun[] {
  const runs: AnalysisRun[] = []
  bags.forEach((bag, i) => {
    if (bag.status === "uploaded" || bag.status === "parsed" || bag.status === "parsing") return
    const runId = `run_${bag.id.slice(4)}`
    const r = rng(runId)
    const failed = bag.status === "failed"
    const running = bag.status === "analyzing"
    const model = MODELS[i % MODELS.length]
    const count = failed ? 0 : 3 + Math.floor(r() * 4)
    const anoms = anomaliesForRun(runId, bag.durationSec, count)
    const worst =
      anoms.length === 0
        ? null
        : SEVERITY_ORDER.find((s) => anoms.some((a) => a.severity === s)) ?? null
    const startedAt = new Date(new Date(bag.uploadedAt).getTime() + 4 * 60_000)
    const durMs = 60_000 + Math.floor(r() * 240_000)
    const promptTokens = anoms.reduce((a) => a + 3800, 6200)
    const completionTokens = anoms.length * 520 + 900
    runs.push({
      id: runId,
      rosbagId: bag.id,
      rosbagName: bag.name,
      robotType: bag.robotType,
      status: failed ? "failed" : running ? "running" : "succeeded",
      progress: running ? 62 : failed ? 34 : 100,
      stage: running ? "diagnose" : failed ? "parse" : "done",
      startedAt: startedAt.toISOString(),
      finishedAt: running ? null : new Date(startedAt.getTime() + durMs).toISOString(),
      anomalyCount: anoms.length,
      worstSeverity: worst,
      model,
      totalLatencyMs: durMs,
      promptTokens,
      completionTokens,
      costUsd: round((promptTokens * 0.0000006 + completionTokens * 0.0000024) * 1000, 3),
    })
  })
  return runs
}

/* ------------------------------------------------------------------ */
/* llm telemetry                                                       */
/* ------------------------------------------------------------------ */

function buildLlmSeries(points = 180, stepSec = 20): LlmPoint[] {
  const r = rng("llm-series")
  const out: LlmPoint[] = []
  const start = NOW - points * stepSec * 1000
  let queue = 3
  for (let i = 0; i < points; i++) {
    const phase = i / points
    const burst = Math.sin(phase * Math.PI * 6) * 0.5 + 0.5
    const incident = i > points * 0.72 && i < points * 0.79 ? 1 : 0
    queue = Math.max(0, Math.round(queue * 0.7 + burst * 9 + incident * 22 + r() * 3))
    const tps = Math.round(420 + burst * 1450 - incident * 900 + r() * 160)
    const p50 = Math.round(180 + burst * 240 + incident * 1900 + r() * 40)
    out.push({
      t: new Date(start + i * stepSec * 1000).toISOString(),
      tokensPerSec: tps,
      queueLen: queue,
      p50,
      p95: Math.round(p50 * (1.9 + r() * 0.4)),
      p99: Math.round(p50 * (3.1 + r() * 0.9)),
      rps: round(1.4 + burst * 6.2 - incident * 1.1 + r() * 0.6, 2),
      tokensIn: Math.round(1800 + burst * 5200 + r() * 600),
      tokensOut: Math.round(320 + burst * 980 + r() * 140),
    })
  }
  return out
}

const PROMPT_PREVIEWS = [
  "You are a ROS2 diagnostics agent. Given the following /tf timing table and rosout excerpt, identify",
  "Summarise the anomaly window 41.0s-44.4s. Topics: /diagnostics, /cmd_vel. Include a root-cause hypothesis",
  "Classify this LaserScan gap. Provide severity, confidence and the three most likely causes ranked by",
  "Given the AMCL covariance trace and particle weights, decide whether this pose jump is a sensor fault or",
  "Render the costmap update timings as a causal chain and explain which configuration parameter dominates",
  "Compare run_9f21 with run_7b55 on the same route. Report which anomalies are new and which regressed",
]

function buildLlmRequests(runs: AnalysisRun[], count = 96): LlmRequest[] {
  const r = rng("llm-req")
  const out: LlmRequest[] = []
  for (let i = 0; i < count; i++) {
    const run = runs.length ? runs[Math.floor(r() * runs.length)] : null
    const roll = r()
    const status: LlmRequest["status"] = roll > 0.92 ? "timeout" : roll > 0.88 ? "error" : "ok"
    const promptTokens = 1200 + Math.floor(r() * 7200)
    const completionTokens = status === "ok" ? 180 + Math.floor(r() * 900) : Math.floor(r() * 60)
    const queueMs = Math.round(status === "timeout" ? 8200 + r() * 4000 : 20 + r() * 900)
    const tokenizeMs = Math.round(6 + promptTokens / 900 + r() * 8)
    const prefillMs = Math.round(promptTokens / 26 + r() * 60)
    const decodeMs = Math.round(completionTokens * (7 + r() * 6))
    const detokenizeMs = Math.round(2 + r() * 7)
    const latencyMs = queueMs + tokenizeMs + prefillMs + decodeMs + detokenizeMs
    out.push({
      id: `req_${(0x1000000 + i * 7919).toString(16)}`,
      ts: new Date(NOW - i * 47_000 - Math.floor(r() * 20_000)).toISOString(),
      runId: run?.id ?? null,
      route: pick(r, ["/v1/chat/completions", "/v1/completions", "/v1/embeddings"]),
      promptPreview: pick(r, PROMPT_PREVIEWS),
      promptTokens,
      completionTokens,
      latencyMs,
      queueMs,
      tokenizeMs,
      prefillMs,
      decodeMs,
      detokenizeMs,
      status,
      model: pick(r, MODELS),
      costUsd: round(promptTokens * 0.0000006 + completionTokens * 0.0000024, 4),
      error:
        status === "timeout"
          ? "Request timed out after 60s while waiting in the queue"
          : status === "error"
            ? "ValueError: prompt length 8420 exceeds max_tokens 8192"
            : undefined,
    })
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts))
}

/* ------------------------------------------------------------------ */
/* reports                                                             */
/* ------------------------------------------------------------------ */

function buildReports(runs: AnalysisRun[], results: AIResult[], anomalies: Anomaly[]): Report[] {
  const done = runs.filter((r) => r.status === "succeeded").slice(0, 5)
  return done.map((run, i) => {
    const rs = results.filter((x) => x.runId === run.id)
    const r = rng(run.id + ":rep")
    return {
      id: `rep_${run.id.slice(4)}`,
      runId: run.id,
      rosbagName: run.rosbagName,
      title: `${ROBOT_LABEL[run.robotType]} incident review - ${run.rosbagName.slice(0, 24)}`,
      createdAt: new Date(new Date(run.finishedAt ?? run.startedAt).getTime() + 20 * 60_000).toISOString(),
      author: pick(r, ["m.oyelaran", "s.kobayashi", "d.novak", "a.fernandes"]),
      status: i < 3 ? "published" : "draft",
      summary: `Run ${run.id} surfaced ${run.anomalyCount} anomalies across ${new Set(rs.flatMap((x) => x.evidence.map((e) => e.topic))).size} topics. The dominant failure chain starts with sensor/transport degradation and propagates into localization and control. ${rs.filter((x) => x.reviewStatus === "approved").length} conclusions were approved by a human reviewer.`,
      keyIssues: rs.slice(0, 3).map((x) => {
        const anomaly = anomalies.find((a) => a.id === x.anomalyId)
        return {
          title: anomalyTemplate(anomaly?.kind ?? "tf_timeout").title,
          severity: anomaly?.severity ?? "medium",
          rootCause: x.rootCause,
        }
      }),
      recommendations: Array.from(new Set(rs.flatMap((x) => x.suggestedFix))).slice(0, 5),
      approvedCount: rs.filter((x) => x.reviewStatus === "approved").length,
      rejectedCount: rs.filter((x) => x.reviewStatus === "rejected").length,
    }
  })
}

/* ------------------------------------------------------------------ */
/* singleton dataset                                                   */
/* ------------------------------------------------------------------ */

interface Dataset {
  rosbags: Rosbag[]
  runs: AnalysisRun[]
  anomalies: Anomaly[]
  aiResults: AIResult[]
  logs: LogEvent[]
  llmSeries: LlmPoint[]
  llmRequests: LlmRequest[]
  feedback: Feedback[]
  reports: Report[]
}

function buildDataset(): Dataset {
  const rosbags = buildRosbags()
  const runs = buildRuns(rosbags)
  const anomalies: Anomaly[] = []
  const aiResults: AIResult[] = []
  const logs: LogEvent[] = []
  for (const run of runs) {
    const bag = rosbags.find((b) => b.id === run.rosbagId)!
    const anoms = anomaliesForRun(run.id, bag.durationSec, run.anomalyCount)
    anomalies.push(...anoms)
    aiResults.push(...aiResultsForRun(run.id, anoms, run.model))
    logs.push(...logsForRun(run.id, bag.durationSec, anoms))
  }
  const dataset: Dataset = {
    rosbags,
    runs,
    anomalies,
    aiResults,
    logs,
    llmSeries: buildLlmSeries(),
    llmRequests: buildLlmRequests(runs),
    feedback: [],
    reports: [],
  }
  dataset.reports = buildReports(runs, aiResults, anomalies)
  return dataset
}

// Eager initialization at module load - eliminates cold start on first request
const datasetCache = buildDataset()

export function data(): Dataset {
  return datasetCache
}

/* ------------------------------------------------------------------ */
/* mutations (stand-in for POST/PATCH handlers)                        */
/* ------------------------------------------------------------------ */

export function submitFeedback(input: {
  aiResultId: string
  verdict: Feedback["verdict"]
  editedRootCause?: string | null
  notes?: string
  reviewer?: string
}): Feedback {
  const d = data()
  const result = d.aiResults.find((r) => r.id === input.aiResultId)
  if (!result) throw new Error(`ai result ${input.aiResultId} not found`)
  result.reviewStatus = input.verdict
  if (input.editedRootCause) result.rootCause = input.editedRootCause
  const fb: Feedback = {
    id: `fb_${Math.random().toString(16).slice(2, 8)}`,
    aiResultId: input.aiResultId,
    runId: result.runId,
    verdict: input.verdict,
    editedRootCause: input.editedRootCause ?? null,
    notes: input.notes ?? "",
    reviewer: input.reviewer ?? "you",
    createdAt: new Date().toISOString(),
  }
  d.feedback.unshift(fb)
  return fb
}

export function advanceRosbag(id: string, to: Rosbag["status"]): Rosbag {
  const bag = data().rosbags.find((b) => b.id === id)
  if (!bag) throw new Error(`rosbag ${id} not found`)
  bag.status = to
  return bag
}

export function createReport(runId: string): Report {
  const d = data()
  const run = d.runs.find((r) => r.id === runId)
  if (!run) throw new Error(`run ${runId} not found`)
  const existing = d.reports.find((r) => r.runId === runId)
  if (existing) return existing
  const [report] = buildReports([run], d.aiResults, d.anomalies)
  d.reports.unshift(report)
  return report
}
