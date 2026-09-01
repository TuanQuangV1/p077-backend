import type { Anomaly, ReviewStats, RunRootCause } from "@/lib/types"

export interface RunAnomalyDetail {
    run: {
        runId: string
        rosbagName: string
    }
    anomalies: Anomaly[]
    runRootCause?: RunRootCause | null
}

function escapeCsv(val: unknown): string {
    if (val === null || val === undefined) return '""'
    const str = typeof val === "object" ? JSON.stringify(val) : String(val)
    return `"${str.replace(/"/g, '""')}"`
}

function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
}

function formatEvidence(evidence?: Record<string, unknown>): string {
    if (!evidence || Object.keys(evidence).length === 0) return "--"
    const parts: string[] = []
    if (evidence.node) parts.push(`Node: ${evidence.node}`)
    if (evidence.silent_duration_sec !== undefined) parts.push(`Silent: ${Number(evidence.silent_duration_sec).toFixed(1)}s`)
    if (evidence.expected_hz !== undefined && evidence.actual_hz !== undefined) {
        parts.push(`Hz: ${evidence.actual_hz}/${evidence.expected_hz}`)
    }
    if (evidence.threshold_sec !== undefined) parts.push(`Threshold: ${Number(evidence.threshold_sec).toFixed(2)}s`)
    if (evidence.occurrence_count !== undefined) parts.push(`Count: ${evidence.occurrence_count}`)
    if (evidence.frame_id) parts.push(`Frame: ${evidence.frame_id}`)
    if (evidence.rules) parts.push(`Rules: ${evidence.rules}`)
    if (parts.length === 0) {
        return Object.entries(evidence)
            .slice(0, 3)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")
    }
    return parts.join(" | ")
}

function getSeverityColor(sev: string): { bg: string; text: string; border: string } {
    switch (sev?.toLowerCase()) {
        case "critical":
            return { bg: "#fef2f2", text: "#991b1b", border: "#f87171" }
        case "high":
            return { bg: "#fff7ed", text: "#9a3412", border: "#fb923c" }
        case "medium":
            return { bg: "#fefce8", text: "#854d0e", border: "#facc15" }
        case "low":
        default:
            return { bg: "#eff6ff", text: "#1e40af", border: "#60a5fa" }
    }
}

/* =======================================================================
 * 1. SINGLE BAG ANOMALIES EXPORT
 * ======================================================================= */

/** Export all anomalies of a single bag as a formatted printable A4 PDF */
export function exportSingleBagAnomaliesPdf(data: RunAnomalyDetail): void {
    const printWindow = window.open("", "_blank")
    if (!printWindow) {
        window.print()
        return
    }

    const today = new Date().toISOString().slice(0, 10)
    const dateStr = new Date().toLocaleString()
    const anomalies = data.anomalies || []

    const criticalCount = anomalies.filter((a) => a.severity === "critical").length
    const highCount = anomalies.filter((a) => a.severity === "high").length
    const mediumCount = anomalies.filter((a) => a.severity === "medium").length
    const lowCount = anomalies.filter((a) => a.severity === "low").length

    const rowsHtml = anomalies.length === 0
        ? `<tr><td colspan="8" style="padding: 24px; text-align: center; color: #64748b;">No anomalies detected in this bag.</td></tr>`
        : anomalies.map((a, idx) => {
            const startSec = a.tRelSec !== undefined ? `${a.tRelSec.toFixed(1)}s` : `${a.tSec.toFixed(1)}s`
            const endSec = a.endRelSec !== undefined ? `${a.endRelSec.toFixed(1)}s` : `${a.endSec.toFixed(1)}s`
            const dur = (a.endSec && a.tSec) ? `${(a.endSec - a.tSec).toFixed(1)}s` : "--"
            const colors = getSeverityColor(a.severity)
            const evidenceStr = formatEvidence(a.evidence)

            return `
                <tr>
                    <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 11px; text-align: center; color: #64748b;">${idx + 1}</td>
                    <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0;">
                        <span style="display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; background: ${colors.bg}; color: ${colors.text}; border: 1px solid ${colors.border};">
                            ${a.severity}
                        </span>
                    </td>
                    <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0;">
                        <div style="font-weight: 600; font-size: 12px; color: #0f172a;">${a.title || a.kind}</div>
                        <div style="font-size: 10px; color: #64748b; font-family: monospace;">${a.id} &bull; ${a.kind}</div>
                    </td>
                    <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 11px; color: #0369a1;">
                        ${(a.topics || []).join(", ") || "--"}
                    </td>
                    <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 11px; text-align: right; white-space: nowrap;">
                        ${startSec} &rarr; ${endSec}
                    </td>
                    <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 11px; text-align: right;">
                        ${dur}
                    </td>
                    <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 11px; text-align: right;">
                        ${a.confidence ? `${Math.round(a.confidence * 100)}%` : "--"}
                    </td>
                    <td style="padding: 8px 6px; border-bottom: 1px solid #e2e8f0; font-size: 10px; color: #475569; max-width: 220px;">
                        ${evidenceStr}
                    </td>
                </tr>
            `
        }).join("")

    const rootCauseHtml = data.runRootCause ? `
        <div class="rca-box">
            <div class="rca-title">AI Root Cause Diagnosis (${data.runRootCause.severity.toUpperCase()})</div>
            <div class="rca-statement">${data.runRootCause.rootCause}</div>
            <div class="rca-explanation">${data.runRootCause.explanation}</div>
            ${data.runRootCause.suggestedFix && data.runRootCause.suggestedFix.length > 0 ? `
                <div class="rca-fixes-label">Recommended Remediation:</div>
                <ul class="rca-fixes-list">
                    ${data.runRootCause.suggestedFix.map((fix) => `<li>${fix}</li>`).join("")}
                </ul>
            ` : ""}
        </div>
    ` : ""

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <title>Incident Report - ${data.run.rosbagName} - ${today}</title>
    <style>
        @page { size: A4 landscape; margin: 12mm; }
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            color: #0f172a;
            background: #ffffff;
            margin: 0;
            padding: 16px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            border-bottom: 2px solid #0f172a;
            padding-bottom: 12px;
            margin-bottom: 16px;
        }
        .brand {
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            color: #0284c7;
            margin-bottom: 4px;
        }
        .title {
            font-size: 20px;
            font-weight: 800;
            letter-spacing: -0.5px;
            color: #0f172a;
        }
        .subtitle {
            font-size: 12px;
            color: #475569;
            margin-top: 3px;
        }
        .meta {
            font-size: 11px;
            text-align: right;
            color: #475569;
            font-family: monospace;
            line-height: 1.5;
        }
        .kpi-row {
            display: flex;
            gap: 12px;
            margin-bottom: 16px;
        }
        .kpi-chip {
            border: 1px solid #cbd5e1;
            padding: 6px 14px;
            border-radius: 6px;
            background: #f8fafc;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
        }
        .kpi-chip.critical { border-left: 4px solid #ef4444; }
        .kpi-chip.high { border-left: 4px solid #f97316; }
        .kpi-chip.medium { border-left: 4px solid #eab308; }
        .kpi-chip.low { border-left: 4px solid #3b82f6; }
        .kpi-count { font-weight: 800; font-family: monospace; font-size: 15px; }

        .rca-box {
            background: #f1f5f9;
            border-left: 4px solid #0284c7;
            padding: 12px 14px;
            border-radius: 4px;
            margin-bottom: 16px;
        }
        .rca-title {
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: #0369a1;
            margin-bottom: 4px;
        }
        .rca-statement {
            font-size: 13px;
            font-weight: 700;
            color: #0f172a;
            margin-bottom: 4px;
        }
        .rca-explanation {
            font-size: 11px;
            color: #334155;
            line-height: 1.4;
        }
        .rca-fixes-label {
            font-size: 10px;
            font-weight: 700;
            color: #475569;
            margin-top: 8px;
            text-transform: uppercase;
        }
        .rca-fixes-list {
            margin: 4px 0 0 16px;
            padding: 0;
            font-size: 11px;
            color: #334155;
        }
        .rca-fixes-list li { margin-bottom: 2px; }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 16px;
        }
        th {
            text-align: left;
            padding: 8px 6px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: #475569;
            border-bottom: 2px solid #cbd5e1;
            background: #f8fafc;
        }
        .footer {
            margin-top: 20px;
            padding-top: 10px;
            border-top: 1px solid #e2e8f0;
            font-size: 10px;
            color: #64748b;
            display: flex;
            justify-content: space-between;
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <div class="brand">RAV-13 Autonomous Diagnostics</div>
            <div class="title">Anomaly Incident Report: ${data.run.rosbagName}</div>
            <div class="subtitle">Detailed breakdown of detected anomalies, timing telemetry, and AI root cause diagnosis</div>
        </div>
        <div class="meta">
            <div><strong>Run ID:</strong> ${data.run.runId}</div>
            <div><strong>Generated:</strong> ${dateStr}</div>
            <div><strong>Total Detections:</strong> ${anomalies.length}</div>
        </div>
    </div>

    <div class="kpi-row">
        <div class="kpi-chip">
            <span>Total Errors:</span>
            <span class="kpi-count">${anomalies.length}</span>
        </div>
        <div class="kpi-chip critical">
            <span>Critical:</span>
            <span class="kpi-count" style="color: #b91c1c;">${criticalCount}</span>
        </div>
        <div class="kpi-chip high">
            <span>High:</span>
            <span class="kpi-count" style="color: #c2410c;">${highCount}</span>
        </div>
        <div class="kpi-chip medium">
            <span>Medium:</span>
            <span class="kpi-count" style="color: #a16207;">${mediumCount}</span>
        </div>
        <div class="kpi-chip low">
            <span>Low:</span>
            <span class="kpi-count" style="color: #1d4ed8;">${lowCount}</span>
        </div>
    </div>

    ${rootCauseHtml}

    <table>
        <thead>
            <tr>
                <th style="width: 28px; text-align: center;">#</th>
                <th style="width: 75px;">Severity</th>
                <th>Anomaly / Rule</th>
                <th>Topic(s)</th>
                <th style="text-align: right; width: 110px;">Window (s)</th>
                <th style="text-align: right; width: 60px;">Dur</th>
                <th style="text-align: right; width: 55px;">Conf</th>
                <th>Evidence / Context</th>
            </tr>
        </thead>
        <tbody>
            ${rowsHtml}
        </tbody>
    </table>

    <div class="footer">
        <div>RAV-13 ROS2 Telemetry & Diagnostic Platform &bull; Confidential Incident Data</div>
        <div>Page 1 of 1</div>
    </div>

    <script>
        window.onload = function() {
            setTimeout(function() {
                window.print();
            }, 250);
        };
    </script>
</body>
</html>`

    printWindow.document.write(html)
    printWindow.document.close()
}

/** Export all anomalies of a single bag as CSV */
export function exportSingleBagAnomaliesCsv(data: RunAnomalyDetail): boolean {
    const anomalies = data.anomalies || []
    if (anomalies.length === 0) return false

    const headers = [
        "ROSBag",
        "Run ID",
        "Anomaly ID",
        "Severity",
        "Kind",
        "Title",
        "Topics",
        "Start Rel Sec",
        "End Rel Sec",
        "Duration Sec",
        "Confidence",
        "Metric",
        "Evidence Details",
    ]

    const rows = anomalies.map((a) => {
        const startSec = a.tRelSec !== undefined ? a.tRelSec : a.tSec
        const endSec = a.endRelSec !== undefined ? a.endRelSec : a.endSec
        const dur = (a.endSec && a.tSec) ? (a.endSec - a.tSec).toFixed(3) : ""

        return [
            escapeCsv(data.run.rosbagName),
            escapeCsv(data.run.runId),
            escapeCsv(a.id),
            escapeCsv(a.severity),
            escapeCsv(a.kind),
            escapeCsv(a.title || a.kind),
            escapeCsv((a.topics || []).join("; ")),
            startSec !== undefined ? Number(startSec).toFixed(3) : "",
            endSec !== undefined ? Number(endSec).toFixed(3) : "",
            dur,
            a.confidence !== undefined ? Number(a.confidence).toFixed(2) : "",
            escapeCsv(a.metric || ""),
            escapeCsv(formatEvidence(a.evidence)),
        ].join(",")
    })

    const csv = ["\uFEFF" + headers.join(","), ...rows].join("\r\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const baseName = data.run.rosbagName.replace(/\.[^/.]+$/, "")
    const today = new Date().toISOString().slice(0, 10)
    downloadBlob(blob, `anomalies-${baseName}-${today}.csv`)
    return true
}

/** Download all anomalies of a single bag as JSON */
export function downloadSingleBagAnomaliesJson(data: RunAnomalyDetail): void {
    const payload = {
        rosbagName: data.run.rosbagName,
        runId: data.run.runId,
        exportedAt: new Date().toISOString(),
        totalAnomalies: data.anomalies?.length || 0,
        runRootCause: data.runRootCause || null,
        anomalies: data.anomalies || [],
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" })
    const baseName = data.run.rosbagName.replace(/\.[^/.]+$/, "")
    const today = new Date().toISOString().slice(0, 10)
    downloadBlob(blob, `anomalies-${baseName}-${today}.json`)
}

/* =======================================================================
 * 2. ALL BAGS ANOMALIES EXPORT (FLEET-WIDE)
 * ======================================================================= */

/** Export all anomalies from all analyzed bags as a single unified A4 PDF */
export function exportAllBagsAnomaliesPdf(allRuns: RunAnomalyDetail[]): void {
    const printWindow = window.open("", "_blank")
    if (!printWindow) {
        window.print()
        return
    }

    const today = new Date().toISOString().slice(0, 10)
    const dateStr = new Date().toLocaleString()

    let totalAnomalies = 0
    let criticalCount = 0
    let highCount = 0
    let mediumCount = 0
    let lowCount = 0

    allRuns.forEach((r) => {
        (r.anomalies || []).forEach((a) => {
            totalAnomalies++
            if (a.severity === "critical") criticalCount++
            else if (a.severity === "high") highCount++
            else if (a.severity === "medium") mediumCount++
            else if (a.severity === "low") lowCount++
        })
    })

    const bagSectionsHtml = allRuns.map((r, bIdx) => {
        const bagAnomalies = r.anomalies || []
        const bagRowsHtml = bagAnomalies.length === 0
            ? `<tr><td colspan="7" style="padding: 12px; text-align: center; color: #64748b; font-size: 11px;">No anomalies detected in this run.</td></tr>`
            : bagAnomalies.map((a, aIdx) => {
                const startSec = a.tRelSec !== undefined ? `${a.tRelSec.toFixed(1)}s` : `${a.tSec.toFixed(1)}s`
                const endSec = a.endRelSec !== undefined ? `${a.endRelSec.toFixed(1)}s` : `${a.endSec.toFixed(1)}s`
                const colors = getSeverityColor(a.severity)
                const evidenceStr = formatEvidence(a.evidence)

                return `
                    <tr>
                        <td style="padding: 6px 4px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 10px; text-align: center; color: #64748b;">${aIdx + 1}</td>
                        <td style="padding: 6px 4px; border-bottom: 1px solid #e2e8f0;">
                            <span style="display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 700; text-transform: uppercase; background: ${colors.bg}; color: ${colors.text}; border: 1px solid ${colors.border};">
                                ${a.severity}
                            </span>
                        </td>
                        <td style="padding: 6px 4px; border-bottom: 1px solid #e2e8f0;">
                            <div style="font-weight: 600; font-size: 11px; color: #0f172a;">${a.title || a.kind}</div>
                            <div style="font-size: 9px; color: #64748b; font-family: monospace;">${a.id} &bull; ${a.kind}</div>
                        </td>
                        <td style="padding: 6px 4px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 10px; color: #0369a1;">
                            ${(a.topics || []).join(", ") || "--"}
                        </td>
                        <td style="padding: 6px 4px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 10px; text-align: right; white-space: nowrap;">
                            ${startSec} &rarr; ${endSec}
                        </td>
                        <td style="padding: 6px 4px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 10px; text-align: right;">
                            ${a.confidence ? `${Math.round(a.confidence * 100)}%` : "--"}
                        </td>
                        <td style="padding: 6px 4px; border-bottom: 1px solid #e2e8f0; font-size: 10px; color: #475569;">
                            ${evidenceStr}
                        </td>
                    </tr>
                `
            }).join("")

        const rcaSnippet = r.runRootCause
            ? `<div style="margin: 6px 0 10px 0; padding: 8px 10px; background: #f8fafc; border-left: 3px solid #0284c7; font-size: 11px;">
                    <strong style="color: #0369a1;">Root Cause:</strong> ${r.runRootCause.rootCause}
                    <div style="color: #475569; font-size: 10px; margin-top: 2px;">${r.runRootCause.explanation}</div>
               </div>`
            : ""

        return `
            <div style="margin-bottom: 24px; page-break-inside: avoid;">
                <div style="display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin-bottom: 6px;">
                    <div style="font-weight: 700; font-size: 13px; color: #0f172a;">
                        ${bIdx + 1}. ${r.run.rosbagName}
                        <span style="font-family: monospace; font-weight: 400; font-size: 10px; color: #64748b; margin-left: 6px;">(${r.run.runId})</span>
                    </div>
                    <div style="font-size: 11px; font-weight: 600; color: #0284c7;">
                        ${bagAnomalies.length} anomaly${bagAnomalies.length === 1 ? "" : "ies"}
                    </div>
                </div>
                ${rcaSnippet}
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 12px;">
                    <thead>
                        <tr>
                            <th style="width: 24px; text-align: center;">#</th>
                            <th style="width: 65px;">Severity</th>
                            <th>Anomaly</th>
                            <th>Topic(s)</th>
                            <th style="text-align: right; width: 100px;">Window (s)</th>
                            <th style="text-align: right; width: 50px;">Conf</th>
                            <th>Evidence Details</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${bagRowsHtml}
                    </tbody>
                </table>
            </div>
        `
    }).join("")

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <title>Fleet-Wide All Anomalies Report - ${today}</title>
    <style>
        @page { size: A4 landscape; margin: 12mm; }
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            color: #0f172a;
            background: #ffffff;
            margin: 0;
            padding: 16px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            border-bottom: 2px solid #0f172a;
            padding-bottom: 12px;
            margin-bottom: 16px;
        }
        .brand {
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            color: #0284c7;
            margin-bottom: 4px;
        }
        .title {
            font-size: 20px;
            font-weight: 800;
            letter-spacing: -0.5px;
            color: #0f172a;
        }
        .subtitle {
            font-size: 12px;
            color: #475569;
            margin-top: 3px;
        }
        .meta {
            font-size: 11px;
            text-align: right;
            color: #475569;
            font-family: monospace;
            line-height: 1.5;
        }
        .kpi-row {
            display: flex;
            gap: 12px;
            margin-bottom: 20px;
        }
        .kpi-chip {
            border: 1px solid #cbd5e1;
            padding: 6px 14px;
            border-radius: 6px;
            background: #f8fafc;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
        }
        .kpi-chip.critical { border-left: 4px solid #ef4444; }
        .kpi-chip.high { border-left: 4px solid #f97316; }
        .kpi-chip.medium { border-left: 4px solid #eab308; }
        .kpi-chip.low { border-left: 4px solid #3b82f6; }
        .kpi-count { font-weight: 800; font-family: monospace; font-size: 15px; }

        th {
            text-align: left;
            padding: 6px 4px;
            font-size: 9px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: #475569;
            border-bottom: 2px solid #cbd5e1;
            background: #f8fafc;
        }
        .footer {
            margin-top: 24px;
            padding-top: 10px;
            border-top: 1px solid #e2e8f0;
            font-size: 10px;
            color: #64748b;
            display: flex;
            justify-content: space-between;
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <div class="brand">RAV-13 Autonomous Platform</div>
            <div class="title">All Detected Anomalies (Fleet-Wide Report)</div>
            <div class="subtitle">Complete consolidated audit of all failures and telemetry anomalies across ${allRuns.length} bags/runs</div>
        </div>
        <div class="meta">
            <div><strong>Generated:</strong> ${dateStr}</div>
            <div><strong>Bags Analyzed:</strong> ${allRuns.length}</div>
            <div><strong>Total Anomalies:</strong> ${totalAnomalies}</div>
        </div>
    </div>

    <div class="kpi-row">
        <div class="kpi-chip">
            <span>Total Errors:</span>
            <span class="kpi-count">${totalAnomalies}</span>
        </div>
        <div class="kpi-chip critical">
            <span>Critical:</span>
            <span class="kpi-count" style="color: #b91c1c;">${criticalCount}</span>
        </div>
        <div class="kpi-chip high">
            <span>High:</span>
            <span class="kpi-count" style="color: #c2410c;">${highCount}</span>
        </div>
        <div class="kpi-chip medium">
            <span>Medium:</span>
            <span class="kpi-count" style="color: #a16207;">${mediumCount}</span>
        </div>
        <div class="kpi-chip low">
            <span>Low:</span>
            <span class="kpi-count" style="color: #1d4ed8;">${lowCount}</span>
        </div>
    </div>

    ${bagSectionsHtml}

    <div class="footer">
        <div>RAV-13 ROS2 Telemetry & Diagnostic Platform &bull; Fleet Wide Incident Audit</div>
        <div>Generated automatically by RAV-13 Diagnostics</div>
    </div>

    <script>
        window.onload = function() {
            setTimeout(function() {
                window.print();
            }, 250);
        };
    </script>
</body>
</html>`

    printWindow.document.write(html)
    printWindow.document.close()
}

/** Export all anomalies across all bags into a single consolidated CSV file */
export function exportAllBagsAnomaliesCsv(allRuns: RunAnomalyDetail[]): boolean {
    const headers = [
        "ROSBag",
        "Run ID",
        "Anomaly ID",
        "Severity",
        "Kind",
        "Title",
        "Topics",
        "Start Rel Sec",
        "End Rel Sec",
        "Duration Sec",
        "Confidence",
        "Metric",
        "Evidence Details",
    ]

    const rows: string[] = []

    allRuns.forEach((r) => {
        (r.anomalies || []).forEach((a) => {
            const startSec = a.tRelSec !== undefined ? a.tRelSec : a.tSec
            const endSec = a.endRelSec !== undefined ? a.endRelSec : a.endSec
            const dur = (a.endSec && a.tSec) ? (a.endSec - a.tSec).toFixed(3) : ""

            rows.push([
                escapeCsv(r.run.rosbagName),
                escapeCsv(r.run.runId),
                escapeCsv(a.id),
                escapeCsv(a.severity),
                escapeCsv(a.kind),
                escapeCsv(a.title || a.kind),
                escapeCsv((a.topics || []).join("; ")),
                startSec !== undefined ? Number(startSec).toFixed(3) : "",
                endSec !== undefined ? Number(endSec).toFixed(3) : "",
                dur,
                a.confidence !== undefined ? Number(a.confidence).toFixed(2) : "",
                escapeCsv(a.metric || ""),
                escapeCsv(formatEvidence(a.evidence)),
            ].join(","))
        })
    })

    if (rows.length === 0) return false

    const csv = ["\uFEFF" + headers.join(","), ...rows].join("\r\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const today = new Date().toISOString().slice(0, 10)
    downloadBlob(blob, `all-anomalies-fleet-${today}.csv`)
    return true
}

/** Download all anomalies across all bags as a single unified JSON file */
export function downloadAllBagsAnomaliesJson(allRuns: RunAnomalyDetail[]): void {
    let totalAnomalies = 0
    allRuns.forEach((r) => {
        totalAnomalies += r.anomalies?.length || 0
    })

    const payload = {
        exportedAt: new Date().toISOString(),
        totalBags: allRuns.length,
        totalAnomalies,
        runs: allRuns.map((r) => ({
            rosbagName: r.run.rosbagName,
            runId: r.run.runId,
            anomalyCount: r.anomalies?.length || 0,
            runRootCause: r.runRootCause || null,
            anomalies: r.anomalies || [],
        })),
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" })
    const today = new Date().toISOString().slice(0, 10)
    downloadBlob(blob, `all-anomalies-fleet-${today}.json`)
}

/* =======================================================================
 * 3. PRECISION AUDIT SUMMARY TABLE EXPORTS (ORIGINAL FUNCTIONALITY)
 * ======================================================================= */

export function copyReportJson(stats: ReviewStats): boolean {
    try {
        navigator.clipboard?.writeText(JSON.stringify(stats, null, 2))
        return true
    } catch {
        return false
    }
}

export function downloadReportJson(stats: ReviewStats): void {
    const blob = new Blob([JSON.stringify(stats, null, 2)], { type: "application/json;charset=utf-8" })
    const today = new Date().toISOString().slice(0, 10)
    downloadBlob(blob, `rav13-precision-report-${today}.json`)
}

export function exportReportCsv(stats: ReviewStats): boolean {
    if (!stats.runs || stats.runs.length === 0) {
        return false
    }
    const pct = (val: number | null) => (val === null ? "--" : `${Math.round(val * 100)}%`)
    const headers = ["Diagnostic Run", "Run ID", "Detections", "Audited", "Approved", "Rejected", "Edited", "Precision"]
    const rows = stats.runs.map((r) => [
        `"${r.rosbagName.replace(/"/g, '""')}"`,
        `"${r.runId}"`,
        r.total,
        r.reviewed,
        r.approved,
        r.rejected,
        r.edited,
        `"${pct(r.accuracy)}"`,
    ])
    const csvContent = [headers.join(","), ...rows.map((row) => row.join(","))].join("\r\n")
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" })
    const today = new Date().toISOString().slice(0, 10)
    downloadBlob(blob, `rav13-precision-report-${today}.csv`)
    return true
}

export function exportReportPdf(stats: ReviewStats): void {
    const printWindow = window.open("", "_blank")
    if (!printWindow) {
        window.print()
        return
    }

    const pct = (val: number | null) => (val === null ? "--" : `${Math.round(val * 100)}%`)
    const dateStr = new Date().toLocaleString()
    const today = new Date().toISOString().slice(0, 10)

    const rowsHtml = stats.runs.map((r) => `
        <tr>
            <td style="padding: 10px 8px; border-bottom: 1px solid #e2e8f0;">
                <div style="font-weight: 600; font-size: 13px; color: #0f172a;">${r.rosbagName}</div>
                <div style="font-size: 11px; color: #64748b; font-family: monospace;">${r.runId}</div>
            </td>
            <td style="padding: 10px 8px; text-align: right; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 12px;">${r.total}</td>
            <td style="padding: 10px 8px; text-align: right; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 12px;">${r.reviewed}</td>
            <td style="padding: 10px 8px; text-align: right; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 12px; color: #15803d;">${r.approved}</td>
            <td style="padding: 10px 8px; text-align: right; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 12px; color: ${r.rejected > 0 ? '#b91c1c' : '#64748b'};">${r.rejected}</td>
            <td style="padding: 10px 8px; text-align: right; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 12px;">${r.edited}</td>
            <td style="padding: 10px 8px; text-align: right; border-bottom: 1px solid #e2e8f0; font-weight: 700; font-family: monospace; font-size: 12px;">${pct(r.accuracy)}</td>
        </tr>
    `).join("")

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <title>RAV-13 Precision Audit Report - ${today}</title>
    <style>
        @page { size: A4 portrait; margin: 15mm; }
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            color: #0f172a;
            background: #ffffff;
            margin: 0;
            padding: 24px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            border-bottom: 2px solid #0f172a;
            padding-bottom: 16px;
            margin-bottom: 24px;
        }
        .brand {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            color: #0284c7;
            margin-bottom: 4px;
        }
        .title {
            font-size: 22px;
            font-weight: 800;
            letter-spacing: -0.5px;
            color: #0f172a;
        }
        .subtitle {
            font-size: 12px;
            color: #64748b;
            margin-top: 4px;
        }
        .meta {
            font-size: 11px;
            text-align: right;
            color: #475569;
            font-family: monospace;
            line-height: 1.6;
        }
        .kpi-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 12px;
            margin-bottom: 28px;
        }
        .kpi-card {
            border: 1px solid #cbd5e1;
            border-left: 4px solid #0284c7;
            padding: 14px 12px;
            border-radius: 6px;
            background: #f8fafc;
        }
        .kpi-card.critical {
            border-left-color: #ef4444;
        }
        .kpi-label {
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: #64748b;
            margin-bottom: 6px;
        }
        .kpi-value {
            font-size: 22px;
            font-weight: 800;
            font-family: monospace;
            color: #0f172a;
        }
        .kpi-hint {
            font-size: 10px;
            color: #64748b;
            margin-top: 4px;
        }
        .section-title {
            font-size: 13px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #334155;
            margin-bottom: 12px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
        }
        th {
            text-align: left;
            padding: 10px 8px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: #475569;
            border-bottom: 2px solid #cbd5e1;
        }
        .text-right { text-align: right; }
        .footer {
            margin-top: 32px;
            padding-top: 14px;
            border-top: 1px solid #e2e8f0;
            font-size: 10px;
            color: #64748b;
            display: flex;
            justify-content: space-between;
            line-height: 1.5;
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <div class="brand">RAV-13 Autonomous Platform</div>
            <div class="title">Per-Run Diagnostic Precision Report</div>
            <div class="subtitle">Human expert verdicts recorded for each diagnostic run (HITL Review Audit)</div>
        </div>
        <div class="meta">
            <div><strong>Generated:</strong> ${dateStr}</div>
            <div><strong>Environment:</strong> Production / Local</div>
            <div><strong>Total Runs:</strong> ${stats.runs.length}</div>
        </div>
    </div>

    <div class="kpi-grid">
        <div class="kpi-card">
            <div class="kpi-label">Agent Precision</div>
            <div class="kpi-value">${pct(stats.accuracy)}</div>
            <div class="kpi-hint">${stats.approved} approved out of ${stats.reviewed} audited</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">Audited Verdicts</div>
            <div class="kpi-value">${stats.reviewed}</div>
            <div class="kpi-hint">${stats.pending} pending in queue</div>
        </div>
        <div class="kpi-card ${stats.rejected > 0 ? 'critical' : ''}">
            <div class="kpi-label">Rejected Diagnoses</div>
            <div class="kpi-value">${stats.rejected}</div>
            <div class="kpi-hint">False positive / inaccurate RCA</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">Edited by Engineers</div>
            <div class="kpi-value">${stats.edited}</div>
            <div class="kpi-hint">Root causes corrected by reviewers</div>
        </div>
    </div>

    <div class="section-title">Diagnostic Run Breakdown</div>
    <table>
        <thead>
            <tr>
                <th>Diagnostic Run</th>
                <th class="text-right">Detections</th>
                <th class="text-right">Audited</th>
                <th class="text-right">Approved</th>
                <th class="text-right">Rejected</th>
                <th class="text-right">Edited</th>
                <th class="text-right">Precision</th>
            </tr>
        </thead>
        <tbody>
            ${rowsHtml}
        </tbody>
    </table>

    <div class="footer">
        <div>Precision = approved / audited. Recall is not reported: requires ground-truth labels for anomalies the agent never raised.</div>
        <div>RAV-13 Telemetry & Diagnostics Platform</div>
    </div>
    <script>
        window.onload = function() {
            setTimeout(function() {
                window.print();
            }, 250);
        };
    </script>
</body>
</html>`

    printWindow.document.write(htmlContent)
    printWindow.document.close()
}
