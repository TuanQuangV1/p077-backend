"use client"

import React, { useState } from "react"
import {
  ActivityIcon,
  CheckIcon,
  ClockIcon,
  DatabaseIcon,
  FileCodeIcon,
  FileTextIcon,
  HardDriveIcon,
  LayersIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  UploadCloudIcon,
  UploadIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { SectionCard, StatTile, StatusLabel } from "@/components/telemetry"
import { bytes, clock, del, post, uploadRosbag } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { AnalysisRun, Rosbag } from "@/lib/types"
import { toast } from "sonner"

interface CaptureRegistryProps {
  bags: Rosbag[]
  onRefresh: () => void
}

export function CaptureRegistry({ bags = [], onRefresh }: CaptureRegistryProps) {
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
      await uploadRosbag(file)
      toast.success("Rosbag uploaded", { description: file.name })
      onRefresh()
    } catch (err) {
      const _err = err as Error
      toast.error("Upload failed: " + (_err?.message ?? "unsupported file type"))
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
    if (!window.confirm(`Bạn có chắc chắn muốn xóa tệp "${bag.name}"?`)) return
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
      toast.success("Analysis completed", { description: result.run.id })
      window.location.assign("/analysis")
    } catch {
      toast.error("Unable to run analysis")
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
      toast.success(`${results.length} analysis run${results.length > 1 ? "s" : ""} queued`)
      window.location.assign("/analysis")
    } catch {
      toast.error("Unable to queue analysis")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5">
      {/* 1. Quick Stats Metric Row */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Tổng tập dữ liệu"
          value={totalBags}
          hint={`${mcapCount} Foxglove MCAP · ${db3Count} SQLite DB3`}
          icon={<DatabaseIcon className="size-4" />}
        />
        <StatTile
          label="Dung lượng lưu trữ"
          value={bytes(totalBytes)}
          hint="Tổng tệp nhị phân đã nạp"
          icon={<HardDriveIcon className="size-4" />}
        />
        <StatTile
          label="Thời lượng dữ liệu ghi"
          value={clock(totalDuration, false)}
          hint="Thời gian cảm biến robot hoạt động"
          icon={<ClockIcon className="size-4" />}
        />
        <StatTile
          label="Tổng số gói tin"
          value={totalMessages.toLocaleString()}
          hint="Gói tin ROS 2 đã nạp & giải mã"
          icon={<LayersIcon className="size-4" />}
        />
      </div>

      {/* 2. Interactive Drag & Drop Upload Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => document.getElementById("file-upload-input")?.click()}
        className={cn(
          "group relative flex flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-all duration-200",
          isDragOver
            ? "border-primary bg-primary/10 shadow-md scale-[1.005]"
            : "border-border/80 bg-card/40 hover:border-primary/50 hover:bg-card/70"
        )}
      >
        <div className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary group-hover:scale-110 transition-transform">
          <UploadCloudIcon className="size-6" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">
            {uploading ? "Đang tải lên và phân tích tệp..." : "Kéo thả tệp Rosbag vào đây hoặc bấm để chọn tệp"}
          </p>
          <p className="text-xs text-muted-foreground">
            Hỗ trợ định dạng Foxglove <span className="font-mono font-medium text-foreground">.mcap</span>, ROS2 SQLite{" "}
            <span className="font-mono font-medium text-foreground">.db3</span>, <span className="font-mono">.bag</span> và <span className="font-mono">.zip</span>
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

      {/* 3. Main Dataset Registry Card */}
      <SectionCard
        title="Danh mục tệp dữ liệu"
        description="Quản lý, nạp và khởi chạy chẩn đoán lỗi từ các tệp ghi dữ liệu cảm biến robot"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={uploading || selected.size === 0}
              onClick={analyzeSelected}
              className="text-xs"
            >
              <PlayIcon data-icon="inline-start" className="size-3.5" />
              Chẩn đoán đã chọn{selected.size ? ` (${selected.size})` : ""}
            </Button>
            <Button
              size="sm"
              disabled={uploading}
              onClick={() => document.getElementById("file-upload-input")?.click()}
              className="text-xs"
            >
              <UploadIcon data-icon="inline-start" className="size-3.5" />
              {uploading ? "Đang nạp..." : "Nạp Rosbag"}
            </Button>
          </div>
        }
      >
        {/* Search & Quick Filter Tabs */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm kiếm tệp, địa điểm, robot..."
              className="pl-9 text-xs"
            />
          </div>

          {/* Quick Format Filter Tabs */}
          <div className="flex items-center gap-1.5 self-start rounded-lg border border-border/80 bg-muted/40 p-1">
            <button
              onClick={() => setFormatFilter("all")}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                formatFilter === "all"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Tất cả ({totalBags})
            </button>
            <button
              onClick={() => setFormatFilter("mcap")}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                formatFilter === "mcap"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              .mcap ({mcapCount})
            </button>
            <button
              onClick={() => setFormatFilter("db3")}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                formatFilter === "db3"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              .db3 ({db3Count})
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
                <th className="pb-2.5 pt-1 font-medium">Tập tin Rosbag</th>
                <th className="pb-2.5 pt-1 font-medium hidden sm:table-cell">Loại robot / Địa điểm</th>
                <th className="pb-2.5 pt-1 font-medium">Dung lượng / Thời lượng</th>
                <th className="pb-2.5 pt-1 font-medium">Trạng thái</th>
                <th className="pb-2.5 pt-1 font-medium text-right pr-2">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 font-mono">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-xs text-muted-foreground font-sans">
                    Không tìm thấy tập dữ liệu phù hợp với điều kiện lọc.
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
                          <div
                            className={cn(
                              "flex size-7 shrink-0 items-center justify-center rounded-md border text-[10px] font-bold uppercase",
                              isMcap
                                ? "border-purple-500/30 bg-purple-500/10 text-purple-400"
                                : "border-cyan-500/30 bg-cyan-500/10 text-cyan-400"
                            )}
                          >
                            {isMcap ? "MCAP" : "DB3"}
                          </div>
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
                        <div className="flex flex-col gap-0.5">
                          <span className="font-semibold text-foreground">{bytes(bag.sizeBytes)}</span>
                          <span className="text-[11px] text-muted-foreground font-sans flex items-center gap-1">
                            <ClockIcon className="size-3" />
                            {clock(bag.durationSec, false)}
                          </span>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="py-3 font-sans">
                        <StatusLabel status={bag.status} />
                      </td>

                      {/* Actions */}
                      <td className="py-3 text-right font-sans pr-2">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy === bag.id}
                            onClick={() => analyze(bag)}
                            className="h-7 px-2.5 text-xs text-primary font-medium"
                          >
                            <PlayIcon className="size-3 mr-1" />
                            Analyze
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === bag.id}
                            onClick={() => remove(bag)}
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10"
                          >
                            <Trash2Icon data-icon="inline-start" className="size-3.5" />
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
