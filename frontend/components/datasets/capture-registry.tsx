"use client"

import React, { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { SectionCard, StatusLabel } from "@/components/telemetry"
import { bytes, clock, del, post, uploadRosbag } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { AnalysisRun, Rosbag } from "@/lib/types"
import { toast } from "sonner"

interface CaptureRegistryProps {
  bags: Rosbag[]
  onRefresh: () => void
  navigate?: (href: string) => void
}

export function CaptureRegistry({ bags = [], onRefresh, navigate }: CaptureRegistryProps) {
  const [query, setQuery] = useState("")
  const [formatFilter, setFormatFilter] = useState<"all" | "mcap" | "db3">("all")
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fileInputKey, setFileInputKey] = useState(0)

  // Quick stats calculation
  const totalBags = bags.length
  const totalBytes = bags.reduce((sum, b) => sum + (b.sizeBytes || 0), 0)
  const totalDuration = bags.reduce((sum, b) => sum + (b.durationSec || 0), 0)
  const totalMessages = bags.reduce((sum, b) => sum + (b.messageCount || 0), 0)
  const mcapCount = bags.filter((b) => b.name.endsWith(".mcap")).length
  const db3Count = bags.filter((b) => b.name.endsWith(".db3")).length
  const mcapPct = totalBags > 0 ? Math.round((mcapCount / totalBags) * 100) : 0
  const db3Pct = totalBags > 0 ? 100 - mcapPct : 0

  // Diagnostic coverage stats
  const analyzedBags = bags.filter((b) => b.analysisStatus === "succeeded" || b.status === "analyzed")
  const analyzedPct = totalBags > 0 ? Math.round((analyzedBags.length / totalBags) * 100) : 0
  const withFaultsCount = bags.filter((b) => (b.analysisAnomalyCount ?? 0) > 0).length

  // Breakdown by Robot Platform
  const robotMap = new Map<string, { count: number; messages: number; sizeBytes: number }>()
  for (const b of bags) {
    const key = b.robotType || "amr-delivery"
    const current = robotMap.get(key) || { count: 0, messages: 0, sizeBytes: 0 }
    robotMap.set(key, {
      count: current.count + 1,
      messages: current.messages + (b.messageCount || 0),
      sizeBytes: current.sizeBytes + (b.sizeBytes || 0),
    })
  }
  const robotStats = Array.from(robotMap.entries()).sort((a, b) => b[1].count - a[1].count)

  // Filtering
  const filtered = bags.filter((bag) => {
    const matchesQuery = `${bag.name} ${bag.site} ${bag.robotType}`.toLowerCase().includes(query.toLowerCase())
    if (!matchesQuery) return false
    if (formatFilter === "mcap") return bag.name.endsWith(".mcap")
    if (formatFilter === "db3") return bag.name.endsWith(".db3")
    return true
  })

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAll = () =>
    setSelected((prev) =>
      filtered.length > 0 && filtered.every((bag) => prev.has(bag.id))
        ? new Set()
        : new Set(filtered.map((bag) => bag.id))
    )

  const allSelected = filtered.length > 0 && filtered.every((bag) => selected.has(bag.id))

  const upload = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    try {
      const saved = await uploadRosbag(file)
      if (saved.duplicateOf) {
        toast.info("ROSBag already exists — opening original artifact", { description: saved.name })
      } else {
        toast.success("ROSBag uploaded successfully", { description: file.name })
      }
      onRefresh()
    } catch (err) {
      const _err = err as Error
      toast.error("Upload failed: " + (_err?.message ?? "unsupported file format"))
    } finally {
      setUploading(false)
      setFileInputKey((k) => k + 1)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) upload(file)
  }

  const remove = async (bag: Rosbag) => {
    if (!window.confirm(`Are you sure you want to delete "${bag.name}"?`)) return
    setBusy(bag.id)
    try {
      await del(`/api/rosbags/${bag.id}`)
      toast.success("Dataset deleted")
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(bag.id)
        return next
      })
      onRefresh()
    } catch {
      toast.error("Unable to delete dataset")
    } finally {
      setBusy(null)
    }
  }

  const analyze = async (bag: Rosbag) => {
    setBusy(bag.id)
    try {
      const result = await post<{ run: AnalysisRun }>("/api/runs", { rosbag_id: bag.id })
      toast.success("Diagnostics completed", { description: result.run.id })
      if (navigate) navigate("/analysis")
      else window.location.assign("/analysis")
    } catch {
      toast.error("Unable to start diagnostics run")
    } finally {
      setBusy(null)
    }
  }

  const removeSelected = async () => {
    const targets = filtered.filter((bag) => selected.has(bag.id))
    if (targets.length === 0) return
    if (!window.confirm(`Delete ${targets.length} selected dataset artifacts?`)) return
    setBusy("batch")
    try {
      await Promise.all(targets.map((bag) => del(`/api/rosbags/${bag.id}`)))
      toast.success(`Deleted ${targets.length} datasets`)
      setSelected(new Set())
      onRefresh()
    } catch {
      toast.error("Failed to delete some selected datasets")
    } finally {
      setBusy(null)
    }
  }

  const analyzeSelected = async () => {
    const ids = filtered.filter((bag) => selected.has(bag.id)).map((bag) => bag.id)
    if (ids.length === 0) return
    setBusy("batch")
    try {
      const results = await Promise.all(ids.map((id) => post<{ run: AnalysisRun }>("/api/runs", { rosbag_id: id })))
      toast.success(`${results.length} diagnostic run${results.length > 1 ? "s" : ""} queued`)
      if (navigate) navigate("/analysis")
      else window.location.assign("/analysis")
    } catch {
      toast.error("Unable to queue diagnostics")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5">
      {/* 1. Quick Stats Metric Row — Clean, Typography-Driven (No Icon Clutter) */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {/* Metric 1: Total Bag Registry */}
        <Card className="py-3.5 gap-0 shadow-xs border-border/80 bg-card/60">
          <CardContent className="flex flex-col justify-between h-full gap-2 px-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono font-medium uppercase tracking-wider text-muted-foreground">
                Total Bag Registry
              </span>
              <span className="font-mono text-[10px] text-muted-foreground font-medium px-1.5 py-0.5 rounded bg-muted/60 border border-border/60">
                {totalBags} bags
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-2xl font-bold tabular-nums text-foreground leading-none">
                {totalBags}
              </span>
              <span className="font-mono text-xs text-muted-foreground">artifacts</span>
            </div>
            {/* Format split ratio bar */}
            <div className="space-y-1 pt-1">
              <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/70 gap-0.5">
                <div className="h-full bg-primary/70 rounded-l-full" style={{ width: `${mcapPct}%` }} title={`MCAP: ${mcapCount}`} />
                <div className="h-full bg-muted-foreground/30 rounded-r-full flex-1" title={`DB3: ${db3Count}`} />
              </div>
              <span className="text-[10.5px] text-muted-foreground font-sans block truncate">
                {mcapCount} MCAP ({mcapPct}%) · {db3Count} DB3 ({db3Pct}%)
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Metric 2: Storage Footprint */}
        <Card className="py-3.5 gap-0 shadow-xs border-border/80 bg-card/60">
          <CardContent className="flex flex-col justify-between h-full gap-2 px-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono font-medium uppercase tracking-wider text-muted-foreground">
                Storage Footprint
              </span>
              <span className="font-mono text-[10px] text-muted-foreground font-medium px-1.5 py-0.5 rounded bg-muted/60 border border-border/60">
                Indexed
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-2xl font-bold tabular-nums text-foreground leading-none">
                {bytes(totalBytes)}
              </span>
              <span className="font-mono text-xs text-muted-foreground">total binary</span>
            </div>
            {/* Storage density indicator */}
            <div className="space-y-1 pt-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
                <div className="h-full rounded-full bg-primary/60" style={{ width: "72%" }} />
              </div>
              <span className="text-[10.5px] text-muted-foreground font-sans block truncate">
                Avg ~{bytes(Math.round(totalBytes / (totalBags || 1)))} per capture
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Metric 3: Cumulative Duration */}
        <Card className="py-3.5 gap-0 shadow-xs border-border/80 bg-card/60">
          <CardContent className="flex flex-col justify-between h-full gap-2 px-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono font-medium uppercase tracking-wider text-muted-foreground">
                Cumulative Duration
              </span>
              <span className="font-mono text-[10px] text-muted-foreground font-medium px-1.5 py-0.5 rounded bg-muted/60 border border-border/60">
                Active Sensors
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-2xl font-bold tabular-nums text-foreground leading-none">
                {clock(totalDuration, false)}
              </span>
              <span className="font-mono text-xs text-muted-foreground">runtime</span>
            </div>
            {/* Average duration bar */}
            <div className="space-y-1 pt-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
                <div className="h-full rounded-full bg-primary/60" style={{ width: "85%" }} />
              </div>
              <span className="text-[10.5px] text-muted-foreground font-sans block truncate">
                Avg ~{clock(Math.round(totalDuration / (totalBags || 1)), false)} per robot run
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Metric 4: Total Telemetry Messages */}
        <Card className="py-3.5 gap-0 shadow-xs border-border/80 bg-card/60">
          <CardContent className="flex flex-col justify-between h-full gap-2 px-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono font-medium uppercase tracking-wider text-muted-foreground">
                Telemetry Messages
              </span>
              <span className="font-mono text-[10px] text-muted-foreground font-medium px-1.5 py-0.5 rounded bg-muted/60 border border-border/60">
                Decoded
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-2xl font-bold tabular-nums text-foreground leading-none">
                {totalMessages.toLocaleString()}
              </span>
              <span className="font-mono text-xs text-muted-foreground">msgs</span>
            </div>
            {/* Throughput density */}
            <div className="space-y-1 pt-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
                <div className="h-full rounded-full bg-primary/60" style={{ width: "90%" }} />
              </div>
              <span className="text-[10.5px] text-muted-foreground font-sans block truncate">
                ~{Math.round(totalMessages / (totalDuration || 1))} msgs/sec decoded rate
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2. Visual Analytics Section — Non-Redundant Distinct Metric Cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Metric Chart 1: Platform & Facility Distribution */}
        <SectionCard
          title="Fleet Platform & Message Distribution"
          description="Decoded telemetry volume grouped by autonomous robot model"
        >
          <div className="space-y-3 pt-1">
            {robotStats.map(([robot, stat]) => {
              const pct = Math.round((stat.messages / (totalMessages || 1)) * 100)
              return (
                <div key={robot} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="font-medium text-foreground">{robot}</span>
                    <span className="text-muted-foreground">
                      <strong className="text-foreground">{stat.count}</strong> bags · {stat.messages.toLocaleString()} msgs{" "}
                      <span className="text-[10px] opacity-75">({pct}%)</span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{ width: `${Math.max(6, pct)}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </SectionCard>

        {/* Metric Chart 2: Diagnostic Coverage & Severity Overview */}
        <SectionCard
          title="Diagnostic Coverage & Health State"
          description="Execution status across registered dataset artifacts"
        >
          <div className="space-y-4 pt-1">
            {/* Overall coverage progress */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="font-medium text-foreground">Analysis Coverage</span>
                <span className="text-primary font-semibold">{analyzedBags.length} / {totalBags} ({analyzedPct}%)</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted/60">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${Math.max(8, analyzedPct)}%` }}
                />
              </div>
            </div>

            {/* Diagnostic outcome breakdown matrix */}
            <div className="grid grid-cols-3 gap-2.5 pt-1 font-mono text-xs">
              <div className="rounded-lg border border-border/70 bg-card/60 p-2.5 flex flex-col gap-0.5">
                <span className="text-[10px] uppercase text-muted-foreground">Clean Runs</span>
                <span className="text-lg font-bold text-emerald-400">
                  {Math.max(0, analyzedBags.length - withFaultsCount)}
                </span>
                <span className="text-[10px] text-muted-foreground">0 faults detected</span>
              </div>
              <div className="rounded-lg border border-border/70 bg-card/60 p-2.5 flex flex-col gap-0.5">
                <span className="text-[10px] uppercase text-muted-foreground">Faults Detected</span>
                <span className="text-lg font-bold text-rose-400">
                  {withFaultsCount}
                </span>
                <span className="text-[10px] text-muted-foreground">actionable triage</span>
              </div>
              <div className="rounded-lg border border-border/70 bg-card/60 p-2.5 flex flex-col gap-0.5">
                <span className="text-[10px] uppercase text-muted-foreground">Pending</span>
                <span className="text-lg font-bold text-muted-foreground">
                  {totalBags - analyzedBags.length}
                </span>
                <span className="text-[10px] text-muted-foreground">ready to diagnose</span>
              </div>
            </div>
          </div>
        </SectionCard>
      </div>

      {/* 3. Drag & Drop Upload Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => document.getElementById("file-upload-input")?.click()}
        className={cn(
          "group relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-5 text-center cursor-pointer transition-all duration-200",
          isDragOver
            ? "border-primary bg-primary/10 shadow-md scale-[1.005]"
            : "border-border/80 bg-card/40 hover:border-primary/50 hover:bg-card/70"
        )}
      >
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">
            {uploading ? "Ingesting and indexing ROSBag stream..." : "Drag & drop ROSBag dataset here or click to browse"}
          </p>
          <p className="text-xs text-muted-foreground font-sans">
            Supports Foxglove <span className="font-mono font-medium text-foreground">.mcap</span>, ROS2 SQLite3{" "}
            <span className="font-mono font-medium text-foreground">.db3</span>, <span className="font-mono">.bag</span> and <span className="font-mono">.zip</span> bundles
          </p>
        </div>
        <input
          key={fileInputKey}
          id="file-upload-input"
          type="file"
          accept=".db3,.mcap,.bag,.zip"
          className="hidden"
          onChange={(e) => upload(e.target.files?.[0])}
        />
      </div>

      {/* 4. Main Dataset Registry Section & Table */}
      <SectionCard
        title="ROSBag Capture Registry"
        description="Ingest, manage, and trigger diagnostics across autonomous robot telemetry recordings"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={uploading || selected.size === 0}
              onClick={analyzeSelected}
              className="text-xs cursor-pointer"
            >
              Diagnose Selected{selected.size ? ` (${selected.size})` : ""}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={uploading || selected.size === 0}
              onClick={removeSelected}
              className="text-xs text-rose-500 hover:text-rose-500 hover:bg-rose-500/10 border-rose-500/30 cursor-pointer"
            >
              Delete Selected{selected.size ? ` (${selected.size})` : ""}
            </Button>
            <Button
              size="sm"
              disabled={uploading}
              onClick={() => document.getElementById("file-upload-input")?.click()}
              className="text-xs cursor-pointer"
            >
              {uploading ? "Ingesting..." : "Upload ROSBag"}
            </Button>
          </div>
        }
      >
        {/* Search & Quick Filter Tabs */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by bag name, site, or robot..."
              className="text-xs"
            />
          </div>

          {/* Quick Format Filter Tabs */}
          <div className="flex items-center gap-1 self-start rounded-lg border border-border/80 bg-muted/40 p-1 font-mono text-xs">
            <button
              onClick={() => setFormatFilter("all")}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                formatFilter === "all"
                  ? "bg-background text-foreground shadow-xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              All ({totalBags})
            </button>
            <button
              onClick={() => setFormatFilter("mcap")}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                formatFilter === "mcap"
                  ? "bg-background text-purple-400 shadow-xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              MCAP ({mcapCount})
            </button>
            <button
              onClick={() => setFormatFilter("db3")}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                formatFilter === "db3"
                  ? "bg-background text-cyan-400 shadow-xs font-bold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              DB3 ({db3Count})
            </button>
          </div>
        </div>

        {/* Fluid Modern Table Grid */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border/70 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                <th className="pb-2.5 pt-1 w-8">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all" />
                </th>
                <th className="pb-2.5 pt-1 font-medium">ROSBag Artifact</th>
                <th className="pb-2.5 pt-1 font-medium hidden sm:table-cell">Platform / Facility</th>
                <th className="pb-2.5 pt-1 font-medium">Payload / Duration</th>
                <th className="pb-2.5 pt-1 font-medium">Status</th>
                <th className="pb-2.5 pt-1 font-medium text-right pr-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 font-mono">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-xs text-muted-foreground font-sans">
                    No ROSBag datasets match the specified query filters.
                  </td>
                </tr>
              ) : (
                filtered.map((bag) => {
                  const isSelected = selected.has(bag.id)
                  const isMcap = bag.name.endsWith(".mcap")

                  return (
                    <tr
                      key={bag.id}
                      className={cn(
                        "group transition-colors hover:bg-accent/40",
                        isSelected && "bg-accent/30"
                      )}
                    >
                      {/* Checkbox */}
                      <td className="py-3">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggle(bag.id)}
                          aria-label={`Select ${bag.name}`}
                        />
                      </td>

                      {/* File Name & Messages Count */}
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "px-1.5 py-0.5 rounded text-[10px] font-bold uppercase shrink-0 border",
                              isMcap
                                ? "border-purple-500/30 bg-purple-500/10 text-purple-400"
                                : "border-cyan-500/30 bg-cyan-500/10 text-cyan-400"
                            )}
                          >
                            {isMcap ? "MCAP" : "DB3"}
                          </span>
                          <div className="flex flex-col min-w-0">
                            <span className="truncate font-sans font-semibold text-foreground group-hover:text-primary transition-colors">
                              {bag.name}
                            </span>
                            <span className="text-[11px] text-muted-foreground font-sans">
                              {bag.messageCount.toLocaleString()} messages
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Robot Type & Site */}
                      <td className="py-3 pr-3 hidden sm:table-cell font-sans">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-mono text-[11px] text-foreground">
                            {bag.robotType || "amr-delivery"}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {bag.site || "Unknown"}
                          </span>
                        </div>
                      </td>

                      {/* Size & Duration */}
                      <td className="py-3 pr-3">
                        <div className="flex flex-col gap-0.5 font-mono">
                          <span className="font-semibold text-foreground">{bytes(bag.sizeBytes)}</span>
                          <span className="text-[11px] text-muted-foreground font-sans">
                            {clock(bag.durationSec, false)}
                          </span>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="py-3 font-sans">
                        <StatusLabel status={bag.analysisStatus || bag.status} />
                      </td>

                      {/* Actions */}
                      <td className="py-3 text-right font-sans pr-2">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy === bag.id}
                            onClick={() => analyze(bag)}
                            className="h-7 px-2.5 text-xs text-primary font-medium cursor-pointer"
                          >
                            Diagnose
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === bag.id}
                            onClick={() => remove(bag)}
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer"
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  )
}

