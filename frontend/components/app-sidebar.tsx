"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
    ActivityIcon,
    BotIcon,
    DatabaseIcon,
    FileTextIcon,
    GaugeIcon,
    LayersIcon,
    LogOutIcon,
    RadarIcon,
    ScanSearchIcon,
    UserCheckIcon,
} from "lucide-react"

import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
} from "@/components/ui/sidebar"

const NAV = [
    { label: "Operations", items: [
        { href: "/", label: "Fleet Overview", icon: GaugeIcon },
        { href: "/datasets", label: "ROSBag Registry", icon: DatabaseIcon },
    ]},
    { label: "Diagnostics", items: [
        { href: "/analysis", label: "Diagnostics Workspace", icon: ScanSearchIcon },
        { href: "/review", label: "Human Review", icon: UserCheckIcon, badge: "pending" as const },
    ]},
    { label: "Platform", items: [
        { href: "/llm", label: "LLM Observability", icon: BotIcon },
        { href: "/reports", label: "Diagnostic Reports", icon: FileTextIcon },
        { href: "/architecture", label: "System Architecture", icon: LayersIcon },
    ]},
]

export function AppSidebar({ pendingReviews }: { pendingReviews?: number }) {
    const pathname = usePathname()
    const handleLogout = async () => {
        const { logout } = await import("@/lib/api")
        await logout()
    }

    return (
        <Sidebar collapsible="icon">
            <SidebarHeader>
                <div className="flex items-center gap-2.5 px-1 py-1.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
                        <RadarIcon className="size-4.5" />
                    </div>
                    <div className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
                        <span className="truncate font-mono text-sm font-semibold tracking-tight">RAV&#8209;13</span>
                        <span className="truncate text-[11px] text-muted-foreground">ROS2 Autonomous Diagnostics</span>
                    </div>
                </div>
            </SidebarHeader>

            <SidebarContent>
                {NAV.map((group) => (
                    <SidebarGroup key={group.label}>
                        <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                        <SidebarGroupContent>
                            <SidebarMenu>
                                {group.items.map((item) => {
                                    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
                                    return (
                                        <SidebarMenuItem key={item.href}>
                                            <SidebarMenuButton
                                                render={<Link href={item.href} />}
                                                isActive={active}
                                                tooltip={item.label}
                                            >
                                                <item.icon />
                                                <span>{item.label}</span>
                                            </SidebarMenuButton>
                                            {item.badge === "pending" && pendingReviews ? (
                                                <SidebarMenuBadge className="tnum">{pendingReviews}</SidebarMenuBadge>
                                            ) : null}
                                        </SidebarMenuItem>
                                    )
                                })}
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                ))}
            </SidebarContent>

            <SidebarFooter>
                <div className="flex flex-col gap-2 group-data-[collapsible=icon]:hidden">
                    <button
                        onClick={handleLogout}
                        className="flex items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent cursor-pointer"
                    >
                        <LogOutIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="font-mono text-[11px] text-sidebar-foreground">Sign Out</span>
                    </button>
                    <div className="flex items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-2">
                        <ActivityIcon className="size-3.5 shrink-0 text-primary" />
                        <div className="min-w-0 flex-1 font-mono text-[11px] leading-4">
                            <div className="truncate text-sidebar-foreground font-semibold">gpt-4.1</div>
                            <div className="truncate text-muted-foreground text-[10px]">OpenAI Diagnostics LLM</div>
                        </div>
                    </div>
                </div>
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    )
}
